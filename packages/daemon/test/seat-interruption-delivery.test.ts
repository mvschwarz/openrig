// Seat interruption levels through the real delivery path: the transport, the typing guard, the outbox and the queue's
// wakes, with only the terminal faked (it records what was typed). What the person sees: typed into the seat, or held
// (readable with `rig seat held-messages`, and the sender told), and a queue row's held wake reading as held.
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { attentionProbeSend } from "../src/domain/seat-attention-reconciler.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n").flatMap(line => {
    const chunks: string[] = []; let row = "";
    for (const char of line) {
      if (stringWidth(row + char) > 238) { chunks.push(row); row = ""; }
      row += char;
    }
    return [...chunks, row];
  });
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

const seat = "worker@test";

function fixture(opts: { unconfirmed?: boolean } = {}) {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','${seat}','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','${seat}','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body = "";
  let staged = "";
  const typed: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) body = staged;
    if (command.includes("send-keys") && command.includes("Enter")) { typed.push(body); body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => frame(body));
  // Unconfirmed: the pane never shows what was typed, so a typed send can't be verified and reads as unconfirmed.
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => `${opts.unconfirmed ? "" : typed.join("\n")}\n${frame(body).screen}`);
  const at = Date.now();
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    now: () => new Date(at), sleep: async () => {},
    agentActivityStore: { getLatestForNode: () => ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  transport.guardedDelivery!.recover();
  const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: transport as never });
  queue.attachOutbox(new OutboxHandler(db));
  cleanup.push(async () => { await transport.guardedDelivery!.stop(); db.close(); });
  const watchdog = makeWatchdogDeliver({ sessionTransport: transport });
  const held = () => new OutboxHandler(db).heldForNode("a", 50).items;
  return { db, guard, transport, queue, typed, held, watchdog, level: (mode: string) => guard.set("a", { mode }, "person@test", "focus") };
}

// The four kinds of input the level table names, sent the way OpenRig sends them.
const parkTimer = { jobId: "park-timer", policy: "periodic-reminder", occurrenceId: "occ-1" };

describe("the level table through the real delivery path", () => {
  it.each([
    ["off", { parkWake: "typed", agent: "typed", urgent: "typed" }],
    ["openrig-urgent", { parkWake: "typed", agent: "held", urgent: "typed" }],
    ["urgent-only", { parkWake: "held", agent: "held", urgent: "typed" }],
    ["hold", { parkWake: "held", agent: "held", urgent: "held" }],
  ] as const)("at %s: a park-timer wake, an agent's message and an urgent one", async (mode, expected) => {
    const f = fixture();
    await f.level(mode);
    const outcome = (r: { outcome?: string; status?: string }) => (r.outcome === "retained" || r.status === "retained" ? "held" : "typed");
    const parkWake = outcome(await f.watchdog({ targetSession: seat, message: "Wake timer fired for parked qitem q-1" }, parkTimer as never));
    const agent = outcome(await f.transport.send(seat, "From: peer@test — please review", { actorSession: "peer@test" }));
    const urgentResult = await f.transport.send(seat, "From: peer@test — the build is red", { actorSession: "peer@test", urgent: { by: "peer@test" } });
    expect({ parkWake, agent, urgent: outcome(urgentResult) }).toEqual(expected);
    expect(urgentResult.urgent).toEqual({ by: "peer@test" });
    // What typed shows who marked it urgent; what's held is readable, urgent ones marked as such.
    if (expected.urgent === "typed") expect(f.typed.at(-1)).toContain("Urgent (marked by peer@test):");
    if (expected.urgent === "held") expect(f.held().find((h) => h.urgency === "urgent")?.body).toContain("Urgent (marked by peer@test):");
    expect(f.held()).toHaveLength(Object.values(expected).filter((v) => v === "held").length);
  });

  it("switching back to always interrupt types new input and never replays what was held", async () => {
    const f = fixture();
    await f.level("hold");
    await f.transport.send(seat, "held while quiet", { actorSession: "peer@test" });
    await f.level("off");
    await f.transport.send(seat, "after", { actorSession: "peer@test" });
    expect(f.typed).toEqual([expect.stringContaining("after")]);
    expect(f.held().map((h) => h.body)).toEqual(["held while quiet"]);
  });
});

describe("queue wakes: who triggered the wake decides its source", () => {
  it("at openrig-urgent, a peer's create nudge is held unless the row is urgent; the row lands and reads as held", async () => {
    const f = fixture();
    await f.level("openrig-urgent");
    const routine = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Review the PR" });
    const urgent = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Prod is down", priority: "urgent" });
    await vi.waitFor(() => expect(f.queue.getById(urgent.qitemId)!.lastNudgeResult).not.toBeNull());
    await vi.waitFor(() => expect(f.queue.getById(routine.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    expect(f.typed.join("\n")).toContain(urgent.qitemId);
    expect(f.typed.join("\n")).toContain("Urgent (marked by peer@test):");
    expect(f.typed.join("\n")).not.toContain(routine.qitemId);
    expect(f.queue.getById(routine.qitemId)!.state).toBe("pending"); // the row lands whatever the level
    expect(f.queue.getById(routine.qitemId)!.waiting!.nextBackstop).toMatchObject({ held: true, mechanism: "held by the seat's typing guard" });
  });

  it("at openrig-urgent, a parked row's auto-unpark wake is OpenRig's own and types; a peer's create nudge doesn't", async () => {
    const f = fixture();
    const blocker = await f.queue.create({ sourceSession: "peer@test", destinationSession: "peer@test", body: "Vendor reply", nudge: false });
    const parked = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Ship after the vendor replies", nudge: false });
    await f.queue.update({ qitemId: parked.qitemId, actorSession: seat, state: "blocked", blockedOn: blocker.qitemId } as never);
    await f.level("openrig-urgent");
    await f.queue.update({ qitemId: blocker.qitemId, actorSession: "peer@test", state: "done", closureReason: "no-follow-on" } as never);
    await vi.waitFor(() => expect(f.typed.join("\n")).toContain(`Blocker ${blocker.qitemId} resolved; parked qitem ${parked.qitemId} is pending`));
    const peer = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Another ask" });
    await vi.waitFor(() => expect(f.queue.getById(peer.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
  });

  it("a row OpenRig creates itself (a stuck-sweep finding) wakes as OpenRig's: typed at openrig-urgent, held at sends-only", async () => {
    const f = fixture();
    await f.level("openrig-urgent");
    const finding = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Stuck sweep: unclaimed", wakeTrigger: "openrig" });
    await vi.waitFor(() => expect(f.typed.join("\n")).toContain(finding.qitemId));
    await f.level("sends-only");
    const later = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Stuck sweep: again", wakeTrigger: "openrig" });
    const peerAsk = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "A deliberate ask" });
    await vi.waitFor(() => expect(f.queue.getById(later.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    await vi.waitFor(() => expect(f.typed.join("\n")).toContain(peerAsk.qitemId));
  });

  it("a row OpenRig creates itself is typed as from OpenRig, not from the seat it names as source; the row keeps its source", async () => {
    const f = fixture();
    await f.level("openrig-urgent");
    const finding = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Stuck sweep: unclaimed", wakeTrigger: "openrig" });
    const health = await f.queue.create({ sourceSession: "system:health", destinationSession: seat, body: "Health finding", wakeTrigger: "openrig" });
    const peerAsk = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "A deliberate ask" });
    const wakeFor = async (id: string) => { await vi.waitFor(() => expect(f.typed.join("\n")).toContain(id)); return f.typed.find((t) => t.includes(id))!; };
    const findingWake = await wakeFor(finding.qitemId);
    expect(findingWake).toContain("From: daemon@kernel");
    expect(findingWake).not.toContain("peer@test");
    expect(findingWake).toContain("↩ Sent by OpenRig itself, not by a seat. Act on the row it names.");
    expect(f.queue.getById(finding.qitemId)!.sourceSession).toBe("peer@test");
    // A source that's already OpenRig's keeps its more specific name.
    expect(await wakeFor(health.qitemId)).toContain("From: system:health");
    // A seat's own row still wakes from that seat, with a reply (held at this level).
    await vi.waitFor(() => expect(f.queue.getById(peerAsk.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    const askWake = f.held().find((h) => h.body.includes(peerAsk.qitemId))!;
    expect(askWake).toMatchObject({ senderSession: "peer@test" });
    expect(askWake.body).toContain("From: peer@test");
    expect(askWake.body).toContain('↩ Reply: rig send peer@test "..."');
  });

  it("OpenRig's own urgent row is marked urgent by OpenRig, not by the person it's about", async () => {
    const f = fixture();
    await f.level("urgent-only");
    const escalation = await f.queue.create({ sourceSession: "workflow-owner@test", destinationSession: seat, body: "Workflow exception", priority: "urgent", wakeTrigger: "openrig" });
    await vi.waitFor(() => expect(f.typed.join("\n")).toContain(escalation.qitemId));
    expect(f.typed.join("\n")).toContain("Urgent (marked by OpenRig):");
  });
});

describe("an urgent queue wake shows who marked it, typed or held, exactly once", () => {
  const lines = (text: string) => text.split("\n").filter((l) => l.startsWith("Urgent (marked by")).length;

  it("held at hold: an agent's urgent row names the agent; OpenRig's own urgent row names OpenRig", async () => {
    const f = fixture();
    await f.level("hold");
    const agentRow = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Prod is down", priority: "urgent" });
    const openrigRow = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Workflow exception", priority: "urgent", wakeTrigger: "openrig" });
    await vi.waitFor(() => expect(f.queue.getById(openrigRow.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    const heldFor = (id: string) => f.held().find((h) => h.body.includes(id))!;
    expect(heldFor(agentRow.qitemId)).toMatchObject({ urgency: "urgent", senderSession: "peer@test" });
    expect(heldFor(agentRow.qitemId).body).toContain("Urgent (marked by peer@test):");
    expect(heldFor(openrigRow.qitemId).body).toContain("Urgent (marked by OpenRig):");
    expect(heldFor(openrigRow.qitemId)).toMatchObject({ senderSession: "daemon@kernel" });
    expect(lines(heldFor(openrigRow.qitemId).body)).toBe(1);
  });

  it("staged earlier and delivered later (the startup drain): the frozen body's line isn't added twice", async () => {
    const f = fixture();
    // Staged with no transport attached, as before a restart: the intent waits with its frozen body.
    const offline = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
    offline.attachOutbox(new OutboxHandler(f.db));
    const row = await offline.create({ sourceSession: "peer@test", destinationSession: seat, body: "Prod is down", priority: "urgent" });
    await f.queue.drainPendingWakeIntents();
    await vi.waitFor(() => expect(f.typed.join("\n")).toContain(row.qitemId));
    expect(lines(f.typed.find((t) => t.includes(row.qitemId))!)).toBe(1);
  });

  it("typed: an urgent wake carries exactly one line", async () => {
    const f = fixture();
    await f.level("urgent-only");
    const row = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Prod is down", priority: "urgent" });
    await vi.waitFor(() => expect(f.typed.join("\n")).toContain(row.qitemId));
    expect(lines(f.typed.find((t) => t.includes(row.qitemId))!)).toBe(1);
  });
});

describe("wakes delivered together each keep their own admission", () => {
  it.each([["routine first", ["routine", "urgent"]], ["urgent first", ["urgent", "routine"]]] as const)(
    "two rows parked on one blocker, one urgent (%s), delivered together later: at urgent-only only the urgent one types", async (_order, priorities) => {
      const f = fixture();
      // Staged with no transport attached (as before a restart), so both wakes are still pending when they're delivered.
      const offline = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
      offline.attachOutbox(new OutboxHandler(f.db));
      const blocker = await offline.create({ sourceSession: "peer@test", destinationSession: "peer@test", body: "Vendor reply", nudge: false });
      const parked: Record<string, string> = {};
      for (const priority of priorities) {
        const row = await offline.create({ sourceSession: "peer@test", destinationSession: seat, body: `${priority} follow-up`, priority, nudge: false });
        await offline.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: blocker.qitemId } as never);
        parked[priority] = row.qitemId;
      }
      await offline.update({ qitemId: blocker.qitemId, actorSession: "peer@test", state: "done", closureReason: "no-follow-on" } as never);
      await f.level("urgent-only");
      await f.queue.drainPendingWakeIntents();
      await vi.waitFor(() => expect(f.typed.join("\n")).toContain(`parked qitem ${parked.urgent} is pending`));
      expect(f.typed.join("\n")).not.toContain(`parked qitem ${parked.routine} is pending`);
      expect(f.queue.getById(parked.routine!)!.lastNudgeResult).toBe("retained:typing_guard");
      expect(f.queue.getById(parked.urgent!)!.lastNudgeResult).not.toMatch(/^retained/);
    });
});

describe("a level chosen while the seat is busy decides each combined wake's delivery", () => {
  it.each([["routine first", ["routine", "urgent"]], ["urgent first", ["urgent", "routine"]]] as const)(
    "a group formed at off, then urgent-only before the lease frees (%s): only the urgent one types; the routine one is held on its own", async (_order, priorities) => {
      const f = fixture();
      const offline = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
      offline.attachOutbox(new OutboxHandler(f.db));
      const blocker = await offline.create({ sourceSession: "peer@test", destinationSession: "peer@test", body: "Vendor reply", nudge: false });
      const parked: Record<string, string> = {};
      for (const priority of priorities) {
        const row = await offline.create({ sourceSession: "peer@test", destinationSession: seat, body: `${priority} follow-up`, priority, nudge: false });
        await offline.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: blocker.qitemId } as never);
        parked[priority] = row.qitemId;
      }
      await offline.update({ qitemId: blocker.qitemId, actorSession: "peer@test", state: "done", closureReason: "no-follow-on" } as never);
      // An earlier operation holds the seat's lease while the group forms at off.
      let release!: () => void;
      const busy = f.guard.operation(seat, () => new Promise<void>((r) => { release = r; }));
      const drain = f.queue.drainPendingWakeIntents();
      await new Promise((r) => setTimeout(r, 50));
      await f.guard.set("a", { mode: "urgent-only" }, "person@test", "focus", 1); // chosen while the seat is busy
      release();
      await busy;
      await drain;
      await vi.waitFor(() => expect(f.queue.getById(parked.routine!)!.lastNudgeResult).toBe("retained:typing_guard"));
      const urgentTyped = f.typed.filter((t) => t.includes(`parked qitem ${parked.urgent} is pending`));
      expect(urgentTyped).toHaveLength(1);
      expect(urgentTyped[0]!.split("\n").filter((l) => l.startsWith("Urgent (marked by")).length).toBe(1);
      expect(f.typed.join("\n")).not.toContain(`parked qitem ${parked.routine} is pending`);
      expect(f.held().map((h) => h.body).join("\n")).toContain(`parked qitem ${parked.routine} is pending`);
    });
});

describe("a combined wake's released members are each typed at most once in a drain", () => {
  it("routine, urgent and urgent grouped at off, urgent-only before the lease frees, typed outcomes unconfirmed", async () => {
    const f = fixture({ unconfirmed: true });
    const offline = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
    offline.attachOutbox(new OutboxHandler(f.db));
    const blocker = await offline.create({ sourceSession: "peer@test", destinationSession: "peer@test", body: "Vendor reply", nudge: false });
    const parked: string[] = [];
    for (const priority of ["routine", "urgent", "urgent"]) {
      const row = await offline.create({ sourceSession: "peer@test", destinationSession: seat, body: `${priority} follow-up`, priority, nudge: false });
      await offline.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: blocker.qitemId } as never);
      parked.push(row.qitemId);
    }
    await offline.update({ qitemId: blocker.qitemId, actorSession: "peer@test", state: "done", closureReason: "no-follow-on" } as never);
    let release!: () => void;
    const busy = f.guard.operation(seat, () => new Promise<void>((r) => { release = r; }));
    const drain = f.queue.drainPendingWakeIntents();
    await new Promise((r) => setTimeout(r, 50));
    await f.guard.set("a", { mode: "urgent-only" }, "person@test", "focus", 1);
    release();
    await busy;
    await drain;
    const [routine, ...urgent] = parked;
    for (const id of urgent) expect(f.typed.filter((t) => t.includes(`parked qitem ${id} is pending`))).toHaveLength(1);
    expect(f.typed.join("\n")).not.toContain(`parked qitem ${routine} is pending`);
    expect(f.queue.getById(routine!)!.lastNudgeResult).toBe("retained:typing_guard");
  });

  it("an urgent member sent unconfirmed isn't typed again when the level relaxes before its released members go", async () => {
    const f = fixture({ unconfirmed: true });
    const offline = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true });
    offline.attachOutbox(new OutboxHandler(f.db));
    const blocker = await offline.create({ sourceSession: "peer@test", destinationSession: "peer@test", body: "Vendor reply", nudge: false });
    const parked: string[] = [];
    for (const priority of ["urgent", "routine", "routine"]) {
      const row = await offline.create({ sourceSession: "peer@test", destinationSession: seat, body: `${priority} follow-up`, priority, nudge: false });
      await offline.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: blocker.qitemId } as never);
      parked.push(row.qitemId);
    }
    await offline.update({ qitemId: blocker.qitemId, actorSession: "peer@test", state: "done", closureReason: "no-follow-on" } as never);
    // Once the urgent member's send returns (unconfirmed), the person goes back to off before the released members go.
    const send = f.transport.send.bind(f.transport);
    let relaxed = false;
    vi.spyOn(f.transport, "send").mockImplementation(async (...args) => {
      const result = await send(...args);
      if (!relaxed) { relaxed = true; await f.level("off"); }
      return result;
    });
    let release!: () => void;
    const busy = f.guard.operation(seat, () => new Promise<void>((r) => { release = r; }));
    const drain = f.queue.drainPendingWakeIntents();
    await new Promise((r) => setTimeout(r, 50));
    await f.guard.set("a", { mode: "urgent-only" }, "person@test", "focus", 1);
    release();
    await busy;
    await drain;
    expect(relaxed).toBe(true);
    for (const id of parked) expect(f.typed.filter((t) => t.includes(`parked qitem ${id} is pending`))).toHaveLength(1);
  });
});

describe("a returned result and its resume", () => {
  it("at urgent-only, both routine: the arrival and the waiter's resume are both held, each its own readable record", async () => {
    const f = fixture();
    const waiter = await f.queue.create({ sourceSession: "peer@test", destinationSession: seat, body: "Ship after the review", nudge: false });
    const blocker = await f.queue.create({ sourceSession: seat, destinationSession: "peer@test", body: "Review it", nudge: false });
    await f.queue.update({ qitemId: waiter.qitemId, actorSession: seat, state: "blocked", blockedOn: blocker.qitemId } as never);
    await f.level("urgent-only");
    const returned = await f.queue.handoff({ qitemId: blocker.qitemId, fromSession: "peer@test", toSession: seat, body: "The review", nudge: true });
    await vi.waitFor(() => expect(f.queue.getById(waiter.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    await vi.waitFor(() => expect(f.queue.getById(returned.created.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    expect(f.typed).toEqual([]);
    const held = f.held().map((h) => h.body).join("\n");
    expect(held).toContain(returned.created.qitemId);
    expect(held).toContain(`parked qitem ${waiter.qitemId} is pending`);
  });
});

describe("the attention-clear liveness probe", () => {
  it("is OpenRig's: typed at openrig-urgent; where the level would hold it, it's neither sent nor kept as a held message", async () => {
    const f = fixture();
    const probe = attentionProbeSend(() => f.transport);
    await f.level("openrig-urgent");
    expect(await probe(seat, "# OpenRig attention-clear liveness probe 1", { verify: false })).toMatchObject({ ok: true });
    expect(f.typed.at(-1)).toContain("liveness probe 1");
    await f.level("sends-only");
    expect(await probe(seat, "# OpenRig attention-clear liveness probe 2", { verify: false })).toEqual({ ok: false, outcome: "failed" });
    expect(f.typed.join("\n")).not.toContain("liveness probe 2");
    expect(f.held()).toEqual([]);
  });
});
