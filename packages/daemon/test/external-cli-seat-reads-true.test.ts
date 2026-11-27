// A person joins an outside Claude Code or Codex conversation to a team with `rig attach` (an external CLI seat). OpenRig
// can't type into it or see its process (seat-kinds: no inbound transport, an external process owner); the program reads
// its own queue. Before, every wake to it read "unroutable ... Fix the address, or register the human", the stuck sweep
// filed a finding per wake, a reconcile's tmux probe marked it detached, and `rig ps` and `seat status` showed it detached
// for weeks while it worked. Now it reads what OpenRig knows: attached, liveness unknown, its own last queue action.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { deriveRigLifecycleFromInventory, isEffectivelyRunning } from "../src/domain/ps-projection.js";
import { holdsRecordedConversation } from "../src/domain/shared-conversation.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG, unclaimedBacklogTag } from "../src/domain/queue-stuck-sweep.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const DESK = "story-desk@studio";
const DIRECTOR = "story-director@studio";

describe("a seat joined with rig attach (an external CLI) reads true", () => {
  let db: ReturnType<typeof createDb>, rigs: RigRepository, sessions: SessionRegistry, bus: EventBus, repo: QueueRepository;
  let rigId: string, deskNode: string, directorNode: string, typed: string[];

  beforeEach(async () => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); sessions = new SessionRegistry(db); bus = new EventBus(db);
    const tmux = { hasSession: async () => false, probeSession: async () => ({ state: "absent" }), listSessions: async () => [] } as unknown as TmuxAdapter;
    const attach = new SelfAttachService({ db, rigRepo: rigs, podRepo: new PodRepository(db), sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    const rig = rigs.createRig("studio"); rigId = rig.id;
    deskNode = rigs.addNode(rig.id, "story.desk", { runtime: "claude-code", cwd: "/work/desk" }).id;
    directorNode = rigs.addNode(rig.id, "story.director", { runtime: "claude-code", cwd: "/work/director" }).id;
    // The director is an ordinary tmux seat.
    sessions.updateStatus(sessions.registerSession(directorNode, DIRECTOR).id, "running");
    sessions.updateBinding(directorNode, { tmuxSession: DIRECTOR, tmuxPane: "%1" });
    // The desk joins as `rig attach` does, through the daemon's own route, with no tmux session: an external CLI.
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("selfAttachService" as never, attach); await next(); });
    app.route("/api/rigs", rigsRoutes);
    const attached = await app.request(`/api/rigs/${rig.id}/attach-self`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ logicalId: "story.desk" }) });
    expect(await attached.json()).toMatchObject({ ok: true, sessionName: DESK, attachmentType: "external_cli" });
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    typed = [];
    repo.attachTransport({ send: async (destination: string) => { typed.push(destination); return { ok: true, verified: true, sent: true, inputPhase: "written" }; } } as never);
  });
  afterEach(() => db.close());

  const ask = async (ageMinutes = 0): Promise<QueueItem> => {
    const row = await repo.create({ sourceSession: DIRECTOR, destinationSession: DESK, body: "Draft the next scene", summary: "the next scene" });
    if (ageMinutes) {
      const at = new Date(Date.now() - ageMinutes * 60_000).toISOString();
      db.prepare("UPDATE queue_items SET ts_created = ?, ts_updated = ? WHERE qitem_id = ?").run(at, at, row.qitemId);
      db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(at, row.qitemId);
    }
    return repo.getById(row.qitemId)!;
  };
  const sweep = () => runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60, log: () => {},
    isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });
  const findings = (): QueueItem[] => repo.list({ limit: 500 }).filter((r) => (r.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
  const deskEntry = () => getNodeInventory(db, rigId).find((e) => e.nodeId === deskNode)!;
  const directorEntry = () => getNodeInventory(db, rigId).find((e) => e.nodeId === directorNode)!;

  it("is recognized by its session, its external name and its canonical name, only while its rig is active", () => {
    expect(repo.isExternalCliSeat(DESK)).toBe(true);
    db.prepare("UPDATE bindings SET external_session_name = 'desk-elsewhere' WHERE node_id = ?").run(deskNode);
    expect(repo.isExternalCliSeat("desk-elsewhere")).toBe(true);
    expect(repo.isExternalCliSeat(DESK)).toBe(true); // by its session, and as story.desk's canonical name
    expect(repo.isExternalCliSeat(DIRECTOR)).toBe(false);
    expect(repo.isExternalCliSeat("story-nobody@studio")).toBe(false);
    db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(rigId);
    expect(repo.isExternalCliSeat(DESK)).toBe(false);
  });

  it("work sent to it records that it waits for that program's own read: never 'fix the address', and nothing is typed", async () => {
    const task = await ask();
    expect(task.lastNudgeResult).toBe(`awaiting-pickup: '${DESK}' is a seat attached from an outside program (rig attach, an external CLI), `
      + "so OpenRig can't type into it and no wake is sent. The work waits in its queue until that program reads it; its claim is the only sign it was picked up.");
    expect(typed).toEqual([]);
    expect(repo.classifyDestinationOf(DIRECTOR)).toEqual({ class: "pane-bound" });
  });

  it("the stuck sweep files no finding per wake; work it leaves unclaimed gets one standing notice that its claim closes", async () => {
    await ask();
    await sweep();
    expect(findings()).toEqual([]);
    const old = [await ask(61), await ask(90)];
    await sweep();
    const [notice, ...more] = findings();
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ destinationSession: DIRECTOR, sourceSession: DESK });
    expect(notice!.tags).toContain(unclaimedBacklogTag(DESK));
    expect(notice!.body).toContain(`seat: ${DESK} (a seat attached from an outside program with rig attach: no wake is sent to it`);
    expect(notice!.body).toContain("why: nobody has claimed these rows, and OpenRig can't tell whether that program has read them");
    expect(notice!.body).toContain("Ask whoever runs that program to check it");
    expect(notice!.body).not.toMatch(/Fix the address|register the human|hosted member|conversation:/);
    for (const row of old) repo.claim({ qitemId: row.qitemId, destinationSession: DESK });
    await sweep();
    expect(repo.getById(notice!.qitemId)!.state).toBe("done");
  });

  it("a claimed task it hasn't moved is reported to its sender without telling it to fix the address", async () => {
    const task = await ask();
    repo.claim({ qitemId: task.qitemId, destinationSession: DESK });
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_updated = ?, claimed_at = ? WHERE qitem_id = ?").run(at, at, task.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(at, task.qitemId);
    await sweep();
    const [finding, ...more] = findings();
    expect(more).toEqual([]);
    expect(finding!.body).toContain(`; ${DESK} is a seat attached from an outside program (rig attach): no wake is sent to it, and OpenRig can't see its activity, so ask whoever runs it`);
    expect(finding!.body).not.toMatch(/fix the address|hosted member/i);
  });

  it("a reconcile leaves its session alone, while a tmux seat whose session is gone is detached", async () => {
    const reconciler = new Reconciler({ db, sessionRegistry: sessions, eventBus: bus,
      tmuxAdapter: { hasSession: async () => false, probeSession: async () => ({ state: "absent" }) } as unknown as TmuxAdapter,
      readProcesses: async () => [] });
    await reconciler.reconcile(rigId);
    const status = (node: string) => (db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(node) as { status: string }).status;
    expect(status(deskNode)).toBe("running");
    expect(status(directorNode)).toBe("detached");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'session.detached' AND node_id = ?").get(deskNode)).toEqual({ n: 0 });
  });

  it.each(["running", "detached"])("rig ps and seat status read it as attached with liveness unknown and its last own queue action, its stored status %s", async (stored) => {
    // A daemon before this fix detached it once, from a tmux probe, and it has kept working since.
    db.prepare("UPDATE sessions SET status = ? WHERE node_id = ?").run(stored, deskNode);
    expect(deskEntry()).toMatchObject({ sessionStatus: "attached", storedSessionStatus: stored, lifecycleState: "unknown",
      externalAttachment: { liveness: "unknown", lastOwnQueueAction: null } });
    const task = await ask();
    repo.claim({ qitemId: task.qitemId, destinationSession: DESK });
    const claimed = repo.listTransitions(task.qitemId).at(-1)!;
    const entry = deskEntry();
    expect(entry.externalAttachment).toEqual({ liveness: "unknown", lastOwnQueueAction: { at: claimed.ts, qitemId: task.qitemId, state: "in-progress" } });
    const seat = new SeatStatusService({ rigRepo: rigs }).getStatus(DESK);
    expect(seat).toMatchObject({ ok: true, status: { session_status: "attached", lifecycle_state: "unknown",
      external_attachment: { liveness: "unknown", lastOwnQueueAction: { qitemId: task.qitemId } } } });
    // The tmux seat reads as before.
    expect(directorEntry()).toMatchObject({ sessionStatus: "running", lifecycleState: "running" });
    expect(directorEntry()).not.toHaveProperty("externalAttachment");
  });

  it("its rig still rolls up from the seats OpenRig runs: attaching it, or its stale detached record, never reads the team degraded", () => {
    const rollup = () => deriveRigLifecycleFromInventory(getNodeInventory(db, rigId), () => 0);
    expect(rollup()).toBe("running");
    db.prepare("UPDATE sessions SET status = 'detached' WHERE node_id = ?").run(deskNode);
    expect(rollup()).toBe("running");
    // A tmux seat that's gone still shows.
    db.prepare("UPDATE sessions SET status = 'detached' WHERE node_id = ?").run(directorNode);
    expect(rollup()).toBe("degraded");
  });

  it("rig ps counts it running, it holds its own conversation, and an earlier hold doesn't read it held, as while its record read running", () => {
    for (const [node, logicalId] of [[deskNode, "story.desk"], [directorNode, "story.director"]] as const) {
      bus.emit({ type: "node.held", rigId, nodeId: node, logicalId, reason: "not selected by a subset launch" });
    }
    for (const stored of ["running", "detached"]) {
      db.prepare("UPDATE sessions SET status = ? WHERE node_id = ?").run(stored, deskNode);
      const entry = deskEntry();
      expect(isEffectivelyRunning(entry)).toBe(true);
      expect(holdsRecordedConversation({ ...entry, restorePolicy: "relaunch_fresh" })).toBe(true);
      expect(entry.heldReason).toBeNull();
    }
    // The tmux seat, once its session is gone, reads as before: not running, its conversation only if it resumes, held.
    db.prepare("UPDATE sessions SET status = 'detached' WHERE node_id = ?").run(directorNode);
    expect(isEffectivelyRunning(directorEntry())).toBe(false);
    expect(holdsRecordedConversation({ ...directorEntry(), restorePolicy: "relaunch_fresh" })).toBe(false);
    expect(directorEntry().heldReason).toBe("not selected by a subset launch");
  });

  it("a released seat (rig release clears its binding), or a session that ended, reads as before", () => {
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(deskNode);
    expect(deskEntry()).toMatchObject({ sessionStatus: "exited" });
    expect(deskEntry()).not.toHaveProperty("externalAttachment");
    db.prepare("UPDATE sessions SET status = 'detached' WHERE node_id = ?").run(deskNode);
    sessions.clearBinding(deskNode);
    expect(deskEntry()).toMatchObject({ sessionStatus: "detached" });
    expect(deskEntry().lifecycleState).not.toBe("unknown");
  });
});

// The classifier on its own: the external-CLI case comes after hosted members and issued conversations, and only for it.
describe("classifyDestination's external-CLI case", () => {
  it("is used only when the address is such a seat, after the cases before it", async () => {
    const { classifyDestination } = await import("../src/domain/gateway/destination-resolver.js");
    const base = { entities: [], hasTerminalTransport: () => false };
    expect(classifyDestination("desk@r", { ...base, isExternalCliSeat: () => true })).toMatchObject({ class: "unroutable", teaching: expect.stringMatching(/^awaiting-pickup: 'desk@r' is a seat attached from an outside program/) });
    expect(classifyDestination("desk@r", { ...base, isExternalCliSeat: () => false }).class === "unroutable"
      && (classifyDestination("desk@r", { ...base, isExternalCliSeat: () => false }) as { teaching: string }).teaching).toMatch(/^unroutable: 'desk@r' has no terminal transport/);
    expect((classifyDestination("desk@r", { ...base, isIssuedConversation: () => true, isExternalCliSeat: () => true }) as { teaching: string }).teaching)
      .toMatch(/an address OpenRig issued to a person's own conversation/);
    expect(classifyDestination("desk@r", { ...base, hasTerminalTransport: () => true, isExternalCliSeat: () => true })).toEqual({ class: "pane-bound" });
    vi.restoreAllMocks();
  });
});
