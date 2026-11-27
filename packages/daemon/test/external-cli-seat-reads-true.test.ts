// A person joins an outside Claude Code or Codex conversation to a team with `rig attach` (an external CLI seat). OpenRig
// can't type into it or see its process (seat-kinds: no inbound transport, an external process owner); the program reads
// its own queue. Before, every wake to it read "unroutable ... Fix the address, or register the human", the stuck sweep
// filed a finding per wake, a reconcile's tmux probe marked it detached, and `rig ps` and `seat status` showed it detached
// for weeks while it worked. Now it reads what OpenRig knows: attached, liveness unknown, its own last queue action.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { composeRigStatus } from "../src/domain/rig-status-compose.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { selectRoleSeat } from "../src/domain/workflow-role-resolver.js";
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
    expect(entry.externalAttachment).toEqual({ liveness: "unknown", lastOwnQueueAction: { at: claimed.ts, qitemId: task.qitemId, state: "in-progress" },
      lastOwnQueueActionRead: "read" });
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

  it("its own last queue action still reads after retention archives it; a history that can't be read never reads as none", async () => {
    const task = await ask();
    repo.claim({ qitemId: task.qitemId, destinationSession: DESK });
    repo.update({ qitemId: task.qitemId, actorSession: DESK, state: "done", closureReason: "no-follow-on" });
    const old = "2026-01-01T00:00:00.000Z";
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(old, task.qitemId);
    const done = { at: old, qitemId: task.qitemId, state: "done" };
    expect(deskEntry().externalAttachment).toEqual({ liveness: "unknown", lastOwnQueueAction: done, lastOwnQueueActionRead: "read" });
    expect(archiveAgedTerminalTransitions(db, { nowIso: "2026-11-27T09:00:00.000Z", transitionsRetentionDays: 1 }).archivedRows).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id = ?").get(task.qitemId)).toEqual({ n: 0 });
    expect(deskEntry().externalAttachment).toEqual({ liveness: "unknown", lastOwnQueueAction: done, lastOwnQueueActionRead: "read" });
    // A newer live action wins over the archived one.
    const next = await ask();
    repo.claim({ qitemId: next.qitemId, destinationSession: DESK });
    expect(deskEntry().externalAttachment?.lastOwnQueueAction).toMatchObject({ qitemId: next.qitemId, state: "in-progress" });
    // Its archive read uses an index, as the live one does.
    for (const table of ["queue_transitions", "queue_transitions_archive"]) {
      expect(JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT transition_id, ts, qitem_id, state FROM ${table} WHERE actor_session = ? ORDER BY transition_id DESC LIMIT 1`).all(DESK)))
        .toMatch(/USING (COVERING )?INDEX idx_queue_transitions_(archive_)?actor/);
    }
    db.exec("DROP TABLE queue_transitions_archive");
    expect(deskEntry().externalAttachment).toEqual({ liveness: "unknown", lastOwnQueueAction: null, lastOwnQueueActionRead: "unavailable" });
  });

  it("rig bind of a tmux session onto it makes it a tmux seat: typed tmux, read and reconciled as one", async () => {
    const tmux = { setSessionOption: async () => ({ ok: true }), setSessionEnv: async () => undefined, getSessionOption: async () => null,
      sendText: async () => ({ ok: true }), sendKeys: async () => ({ ok: true }), startPipePane: async () => ({ ok: true }),
      probeSession: async () => ({ state: "present" }), hasSession: async () => true, capturePaneContent: async () => "" } as unknown as TmuxAdapter;
    const discoveryRepo = new DiscoveryRepository(db);
    const discovered = discoveryRepo.upsertDiscoveredSession({ tmuxSession: "desk-pane", tmuxPane: "%7", runtimeHint: "claude-code" as never,
      confidence: "high", cwd: "/work/desk" });
    const claim = new ClaimService({ db, rigRepo: rigs, sessionRegistry: sessions, discoveryRepo, eventBus: bus, tmuxAdapter: tmux,
      transcriptStore: new TranscriptStore({ transcriptsRoot: join(tmpdir(), "extcli-bind-transcripts"), enabled: false }),
      claudeContextProvisioner: { ensureContextCollector: () => {} } } as never);
    expect(await claim.bind({ discoveredId: discovered.id, rigId, logicalId: "story.desk" })).toMatchObject({ ok: true });
    expect(sessions.getBindingForNode(deskNode)).toMatchObject({ attachmentType: "tmux", tmuxSession: "desk-pane", tmuxPane: "%7" });
    expect(deskEntry()).not.toHaveProperty("externalAttachment");
    expect(deskEntry().sessionStatus).not.toBe("attached");
    expect(repo.isExternalCliSeat(DESK)).toBe(false);
    // The reconciler probes it again, so a tmux session that's gone reads detached.
    const probes: string[] = [];
    const reconciler = new Reconciler({ db, sessionRegistry: sessions, eventBus: bus, readProcesses: async () => [],
      tmuxAdapter: { hasSession: async () => false, probeSession: async (name: string) => { probes.push(name); return { state: "absent" }; } } as unknown as TmuxAdapter });
    await reconciler.reconcile(rigId);
    expect(probes).toContain("desk-pane");
  });

  it("rig status says how many seats are attached beside the running count, and only when there are some", () => {
    const status = (lifecycles: Array<"running" | "unknown" | "detached">) => composeRigStatus({ rigId, rigName: "studio",
      nodes: lifecycles.map((lifecycleState, i) => ({ logicalId: `s.${i}`, runtime: "claude-code", lifecycleState })),
      plan: { status: "plan", mode: "restore", rigId, rigName: "studio", snapshot: null, wouldCaptureCurrentState: true, mutated: false,
        nodes: lifecycles.map((_, i) => ({ logicalId: `s.${i}`, intendedAction: "resume-original", tokenState: "present", freshRequired: false })) } as never });
    expect(status(["running", "running", "unknown"])).toMatchObject({ seatsRunning: 2, seatsTotal: 3, seatsAttached: 1 });
    expect(status(["running", "running", "unknown"]).src).toContain("ps: 2/3 running · 1 attached · lifecycle=running");
    expect(status(["running", "detached"])).not.toHaveProperty("seatsAttached");
    expect(status(["running", "detached"]).src).toContain("ps: 1/2 running · lifecycle=degraded");
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

// A workflow's role-only step reaches an attached seat that holds the role, as it did while its record read running: it reads
// its own queue. Its lifecycle still reads unknown.
describe("role-only workflow routing to a seat joined with rig attach", () => {
  let db: ReturnType<typeof createDb>, bus: EventBus, repo: QueueRepository, rigId: string, scratch: string;
  beforeEach(async () => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db), podRepo = new PodRepository(db);
    bus = new EventBus(db);
    rigId = rigs.createRig("studio").id;
    const pod = podRepo.createPod(rigId, "story", "Story");
    rigs.addNode(rigId, "story.desk", { runtime: "claude-code", role: "writer", podId: pod.id, cwd: "/tmp" });
    const attach = new SelfAttachService({ db, rigRepo: rigs, podRepo, sessionRegistry: sessions, eventBus: bus,
      tmuxAdapter: { hasSession: async () => false, probeSession: async () => ({ state: "absent" }), listSessions: async () => [] } as never });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("selfAttachService" as never, attach); await next(); });
    app.route("/api/rigs", rigsRoutes);
    const attached = await app.request(`/api/rigs/${rigId}/attach-self`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ logicalId: "story.desk" }) });
    expect(await attached.json()).toMatchObject({ ok: true, sessionName: DESK, attachmentType: "external_cli" });
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    repo.attachOutbox(new OutboxHandler(db));
    scratch = mkdtempSync(join(tmpdir(), "extcli-workflow-"));
  });
  afterEach(() => { db.close(); rmSync(scratch, { recursive: true, force: true }); });

  it("a role-only entry selects the attached writer, whose lifecycle still reads unknown", async () => {
    const specPath = join(scratch, "writer.yaml");
    writeFileSync(specPath, [
      "workflow:", "  id: extcli-writer", "  version: 1", "  objective: write through an attached conversation", "  target:", "    rig: studio",
      "  entry:", "    role: writer", "  roles:", "    writer: {}", "  steps:", "    - id: write", "      actor_role: writer",
      "      allowed_exits:", "        - done", "        - failed", "",
    ].join("\n"));
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: repo, exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" } });
    const implicit = await runtime.instantiate({ specPath, rootObjective: "role selected", createdBySession: "author@studio" });
    expect(implicit.entryOwnerSession).toBe(DESK);
    expect(repo.getById(implicit.entryQitemId)?.destinationSession).toBe(DESK);
    expect(getNodeInventory(db, rigId)[0]).toMatchObject({ lifecycleState: "unknown", sessionStatus: "attached" });
  });

  it("the resolver's live gate admits an attached seat only while its lifecycle reads unknown", () => {
    const facts = (over: Partial<Parameters<typeof selectRoleSeat>[0]["candidates"][number]>) => ({ logicalId: "story.desk", role: "writer",
      nodeKind: "agent" as const, lifecycleState: "unknown", runtime: "claude-code", pendingWorkCount: 0, coordinate: DESK, rawSessionName: DESK, ...over });
    expect(selectRoleSeat({ role: "writer", candidates: [facts({ externallyAttached: true })] }).seat).toBe(DESK);
    for (const over of [{}, { externallyAttached: false }, { externallyAttached: true, lifecycleState: "attention_required" }, { externallyAttached: true, lifecycleState: "detached" }]) {
      expect(selectRoleSeat({ role: "writer", candidates: [facts(over)] })).toMatchObject({ seat: null,
        disqualified: [{ disqualifier: `not_live(lifecycleState=${over.lifecycleState ?? "unknown"})` }] });
    }
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
