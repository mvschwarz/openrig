// #2789: a queue wake committed while its seat had no pane froze a guard binding that could never match once the seat
// was bound, so every re-send was refused as "Committed wake recipient identity changed". These run through the real
// SessionTransport and SeatDeliveryGuard, with only tmux itself stubbed: its commands are recorded, never run.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { holdForQuiet } from "../src/domain/policies/quiet-release.js";
import { quietHoldCustody } from "../src/domain/quiet-hold-custody.js";

/** A seat whose node and first occupant exist but whose pane isn't bound yet, as just after a restart. */
function unboundSeat(hasPendingPostCompactStage?: (session: string) => boolean) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g1','a',1,'occupant-1','fresh');`);
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
  const writes: string[] = [];
  // The pane shows what was pasted into it, so the transport can confirm a wake rendered.
  let pane = "";
  const tmux = new TmuxAdapter(async (command) => {
    const line = String(command); writes.push(line);
    const loaded = /load-buffer .* '([^']+)'$/.exec(line);
    if (loaded) pane += readFileSync(loaded[1]!, "utf8");
    return line.includes("capture-pane") ? pane : "";
  });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "listPanes").mockImplementation(async (name) => [{ id: guard.target(name).pane! } as never]);
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), sleep: async () => {} });
  const outbox = new OutboxHandler(db);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport, hasPendingPostCompactStage, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  /** The seat comes back: a new occupant, and its pane bound. */
  const relaunch = (occupant = "occupant-2", ordinal = 2, pane = "%1") => db.exec(`
    INSERT OR IGNORE INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('${occupant}','a',${ordinal},'${occupant}','fresh');
    INSERT OR REPLACE INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','${pane}');
    INSERT OR IGNORE INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');`);
  const intentOf = (qitemId: string) => outbox.getById(`wake-intent-${qitemId}`)!;
  /** Each test has one item, so a paste into the pane is its wake being sent. */
  const sendsFor = (_qitemId: string) => writes.filter((w) => w.includes("paste-buffer")).length;
  /** An item created while the seat has no pane: its wake fails unroutable, with a pane-less binding frozen on its intent. */
  const createUnbound = async () => {
    const item = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work" });
    await vi.waitFor(() => expect(intentOf(item.qitemId).deliveryState).toBe("failed"));
    expect(repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^unroutable:/);
    expect(intentOf(item.qitemId).guardBinding).toEqual({ nodeId: "a", session: "worker@test", occupant: "occupant-1", pane: null });
    expect(writes).toEqual([]);
    return item;
  };
  return { db, guard, tmux, transport, outbox, repo, writes, relaunch, intentOf, sendsFor, createUnbound };
}

describe("a wake committed before its seat had a pane (#2789)", () => {
  it("reaches the relaunched seat exactly once: its first binding is the live one, and later passes send nothing", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.relaunch();

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.sendsFor(item.qitemId)).toBe(1);
    expect(f.intentOf(item.qitemId).deliveryState).toBe("delivered");
    expect(f.intentOf(item.qitemId).guardBinding).toEqual({ nodeId: "a", session: "worker@test", occupant: "occupant-2", pane: "%1" });
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).not.toMatch(/identity changed|^unroutable:/);

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    await f.repo.drainPendingWakeIntents();
    expect(f.sendsFor(item.qitemId)).toBe(1);
    expect(f.intentOf(item.qitemId).deliveryState).toBe("delivered");
  });

  it("control: a wake bound to an earlier occupant's pane is still refused when the seat is relaunched", async () => {
    const f = unboundSeat();
    f.relaunch("occupant-1", 1, "%1"); // bound from the start
    const item = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "work", nudge: false });
    f.repo.stageWakeIntent(item.qitemId, "sender@test", "worker@test", null, true);
    const bound = f.intentOf(item.qitemId).guardBinding;
    expect(bound).toMatchObject({ occupant: "occupant-1", pane: "%1" });
    f.relaunch("occupant-2", 2, "%2");

    await f.repo.drainPendingWakeIntents();
    expect(f.intentOf(item.qitemId).deliveryState).toBe("failed");
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toContain("identity changed");
    expect(f.intentOf(item.qitemId).guardBinding).toEqual(bound);
    expect(f.sendsFor(item.qitemId)).toBe(0);
  });

  it("control: a wake with an explicit expected identity keeps its pane-less binding and isn't sent", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.db.prepare("UPDATE outbox_entries SET guard_delivery = ? WHERE outbox_id = ?").run(
      JSON.stringify({ expectedIdentity: { nodeId: "a", sessionName: "worker@test", runtime: "claude-code", nativeId: "conversation-1" } }),
      `wake-intent-${item.qitemId}`);
    f.relaunch();

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.intentOf(item.qitemId).guardBinding).toMatchObject({ occupant: "occupant-1", pane: null });
    expect(f.sendsFor(item.qitemId)).toBe(0);
  });

  it("control: a wake that may already have been written isn't re-bound or replayed", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.db.prepare("UPDATE outbox_entries SET delivery_state = 'indeterminate' WHERE outbox_id = ?").run(`wake-intent-${item.qitemId}`);
    f.relaunch();

    await f.repo.drainPendingWakeIntents();
    expect(f.intentOf(item.qitemId).guardBinding).toMatchObject({ occupant: "occupant-1", pane: null });
    expect(f.intentOf(item.qitemId).deliveryState).toBe("indeterminate");
    expect(f.sendsFor(item.qitemId)).toBe(0);
  });

  it("control: when the seat changes again during delivery, the wake isn't sent elsewhere, and its binding isn't moved again", async () => {
    const f = unboundSeat();
    const item = await f.createUnbound();
    f.relaunch();
    // The occupant is replaced once the wake has taken its first binding, before its input is written.
    vi.mocked(f.tmux.probeSession).mockImplementationOnce(async () => { f.relaunch("occupant-3", 3, "%1"); return { state: "present" }; });

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.sendsFor(item.qitemId)).toBe(0);
    expect(f.intentOf(item.qitemId).guardBinding).toMatchObject({ occupant: "occupant-2", pane: "%1" });

    await f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");
    expect(f.sendsFor(item.qitemId)).toBe(0);
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^failed:.*changed/);
  });
});


describe("a failed queue wake when its seat returns", () => {
  const proof = "queue:wake-pre-input-failure";
  const open: Database.Database[] = [];
  afterEach(() => { for (const db of open.splice(0)) db.close(); });
  type Result = Awaited<ReturnType<SessionTransport["send"]>>;
  async function failed(result?: Result | "throw", compacting?: () => boolean) {
    const f = unboundSeat(compacting); open.push(f.db);
    f.relaunch("occupant-1", 1, "%1");
    vi.mocked(f.tmux.probeSession).mockResolvedValue({ state: "absent" });
    const send = vi.spyOn(f.transport, "send");
    if (result === "throw") send.mockRejectedValue(new Error("before input (unproved throw)"));
    else if (result) send.mockResolvedValue(result);
    const row = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "finish work once" });
    await vi.waitFor(() => expect(f.intentOf(row.qitemId).deliveryState).not.toMatch(/^(pending|sending)$/));
    return { ...f, row, send };
  }
  const reachable = (f: Awaited<ReturnType<typeof failed>>) => f.repo.retryUnroutableWakesOnReachable("worker@test", "idle");

  it("uses the real transport's no-input evidence and the same durable intent once the pane returns", async () => {
    const f = await failed();
    expect(await f.send.mock.results[0]!.value).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached", reason: "session_missing" });
    expect(f.repo.getById(f.row.qitemId)!.lastNudgeResult).toMatch(/^failed:/);
    const before = f.intentOf(f.row.qitemId);
    vi.mocked(f.tmux.probeSession).mockResolvedValue({ state: "present" });
    await reachable(f);
    expect(f.sendsFor(f.row.qitemId)).toBe(1);
    expect(before.tags).toContain(proof);
    expect(f.intentOf(f.row.qitemId)).toMatchObject({ outboxId: before.outboxId, body: before.body, deliveryState: "delivered" });
    expect(f.intentOf(f.row.qitemId).tags).not.toContain(proof);
    await reachable(f);
    await f.repo.drainPendingWakeIntents();
    expect(f.send).toHaveBeenCalledTimes(2); // failed probe, then one input
    expect(f.sendsFor(f.row.qitemId)).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM outbox_entries WHERE audit_pointer=?").get(f.row.qitemId)).toEqual({ n: 1 });
  });

  it.each([
    { name: "untyped failure", result: { ok: false, error: "failed before input inputPhase=not_reached" } },
    { name: "sent false without a phase", result: { ok: false, sent: false, reason: "session_missing" } },
    { name: "attempted input", result: { ok: false, sent: false, inputPhase: "attempted" } },
    { name: "written input", result: { ok: false, inputPhase: "written" } },
    { name: "contradictory sent evidence", result: { ok: false, sent: true, inputPhase: "not_reached" } },
    { name: "ack unknown", result: { ok: true, verified: false } },
    { name: "timeout", result: { ok: false, sent: false, inputPhase: "not_reached", reason: "timeout" } },
    { name: "deliberately retained", result: { ok: false, sent: false, inputPhase: "not_reached", outcome: "retained", reason: "typing_guard_enabled" } },
    { name: "untyped throw", result: "throw" },
  ] as const)("does not infer retry proof from $name", async ({ result }) => {
    const f = await failed(result === "throw" ? result : { ...result, sessionName: "worker@test" });
    expect(f.intentOf(f.row.qitemId).tags ?? []).not.toContain(proof);
    const before = f.intentOf(f.row.qitemId);
    f.send.mockResolvedValue({ ok: true, verified: true, sessionName: "worker@test" });
    await reachable(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.intentOf(f.row.qitemId)).toEqual(before);
  });

  it.each(["sending", "indeterminate", "delivered", "retained", "retired"])("ignores a stale proof tag on a %s intent", async state => {
    const f = await failed();
    f.db.prepare("UPDATE outbox_entries SET delivery_state=? WHERE outbox_id=?").run(state, f.intentOf(f.row.qitemId).outboxId);
    await reachable(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe(state);
  });

  it.each(["claimed", "transferred", "done", "blocked", "handed-off"])("leaves %s work out of the return retry", async state => {
    const f = await failed();
    if (state === "claimed") f.repo.claim({ qitemId: f.row.qitemId, destinationSession: "worker@test" });
    else if (state === "transferred") f.db.prepare("UPDATE queue_items SET handed_off_from=? WHERE qitem_id=?").run(f.row.qitemId, f.row.qitemId);
    else f.db.prepare("UPDATE queue_items SET state=? WHERE qitem_id=?").run(state, f.row.qitemId);
    await reachable(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe("failed");
  });

  it("leaves compaction custody in charge, then retries on return after it clears", async () => {
    let owed = false;
    const f = await failed(undefined, () => owed);
    owed = true;
    vi.mocked(f.tmux.probeSession).mockResolvedValue({ state: "present" });
    await reachable(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    owed = false;
    await reachable(f);
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe("delivered");
    expect(f.sendsFor(f.row.qitemId)).toBe(1);
  });

  it.each(["held", "released"])("leaves deliberate quiet custody %s", async state => {
    const f = await failed();
    holdForQuiet({ queueRepo: f.repo, jobsRepo: new WatchdogJobsRepository(f.db), qitemId: f.row.qitemId,
      entityId: "owner", hold: { windowId: "fixture-quiet", occurrence: "until", revision: 1, notificationKey: f.row.qitemId } });
    if (state === "released") f.repo.update({ qitemId: f.row.qitemId, actorSession: "quiet@system",
      transitionNote: `quiet-release-dispatched notification_key=${f.row.qitemId}` });
    expect(quietHoldCustody(f.db, f.row.qitemId)?.state).toBe(state);
    await reachable(f);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe("failed");
  });

  it("preserves no-input proof for a grouped member removed before the send", async () => {
    const f = await failed();
    const peer = await f.repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "urgent peer", priority: "urgent" });
    await vi.waitFor(() => expect(f.intentOf(peer.qitemId).deliveryState).toBe("failed"));
    for (const row of [f.row, peer]) {
      const entry = f.intentOf(row.qitemId);
      f.db.prepare("UPDATE outbox_entries SET tags=? WHERE outbox_id=?").run(JSON.stringify([...(entry.tags ?? []), "queue:return:paired"]), entry.outboxId);
    }
    f.send.mockImplementationOnce(async (_session, _text, opts) => {
      // Under the lease the ordinary member is now held; the urgent peer is removed, not attempted.
      const selected = opts!.recheckMembers!((input) => !input.urgent, true);
      expect(selected.outboxIds).toEqual([f.intentOf(f.row.qitemId).outboxId]);
      return { ok: false, outcome: "retained", reason: "typing_guard_enabled", sent: false, inputPhase: "not_reached", sessionName: "worker@test" };
    });
    await reachable(f);
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe("retained");
    expect(f.intentOf(peer.qitemId).deliveryState).toBe("failed");
    expect(f.intentOf(peer.qitemId).tags).toContain(proof);
    vi.mocked(f.tmux.probeSession).mockResolvedValue({ state: "present" });
    await reachable(f);
    expect(f.intentOf(peer.qitemId).deliveryState).toBe("delivered");
    expect(f.sendsFor(peer.qitemId)).toBe(1);
  });

  it("clears proof on claim before an uncertain retry and never treats that retry as unsent", async () => {
    const f = await failed();
    let finish!: (result: Result) => void;
    f.send.mockImplementationOnce(() => new Promise<Result>(resolve => { finish = resolve; }));
    const inFlight = reachable(f);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe("sending");
    expect(f.intentOf(f.row.qitemId).tags).not.toContain(proof);
    finish({ ok: false, inputPhase: "attempted", reason: "delivery_indeterminate", sessionName: "worker@test" });
    await inFlight;
    expect(f.intentOf(f.row.qitemId).deliveryState).toBe("indeterminate");
    expect(f.intentOf(f.row.qitemId).tags).not.toContain(proof);
    await reachable(f);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
});
