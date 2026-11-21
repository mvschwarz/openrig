import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { makeQueueRecordingCheck, makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RosterMember } from "../src/domain/rosters.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { isTmuxBoundSession, wireTerminalReachability } from "../src/domain/terminal-server-seats.js";
import { recoveryTag } from "../src/domain/queue-recovery.js";
import * as stuckSweep from "../src/domain/queue-stuck-sweep.js";
import {
  BACKLOG_FOLDED_TAG,
  createStuckSweepStatus,
  runStuckSweep,
  STUCK_SWEEP_FINDING_TAG,
  STUCK_SWEEP_YIELD_EVERY_ROWS,
  unclaimedBacklogTag,
  UNROUTABLE_NOTICE_PREFIX,
  unroutableNoticeTag,
} from "../src/domain/queue-stuck-sweep.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("stuck sweep: create-once unreachable notices (#514)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queue: QueueRepository;
  let seq: number;
  let nudgesSent: Array<{ destination: string; text: string }>;
  let hostedMembers: RosterMember[];

  function makeRepo(): QueueRepository {
    const repo = new QueueRepository(db, bus, {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      isHostedMember: (session) => hostedMembers.some((m) => m.seat === session),
      hostedWake: () => null,
      hostedMembers: () => hostedMembers,
    });
    repo.attachTransport({
      send: async (destination, text) => {
        nudgesSent.push({ destination, text });
        return { ok: true, verified: true, sent: true, inputPhase: "written" };
      },
    });
    return repo;
  }

  function seedSeat(rigName: string, logicalId: string, session: string, opts: { running?: boolean | "exited"; bound?: boolean } = {}) {
    const running = opts.running ?? true;
    const bound = opts.bound ?? true;
    const rigRow = db.prepare("SELECT id FROM rigs WHERE name = ?").get(rigName) as { id: string } | undefined;
    const rigId = rigRow?.id ?? (() => {
      const id = `rig-${rigName}`;
      db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(id, rigName);
      return id;
    })();
    const nodeId = `node-${++seq}`;
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, 'claude-code', '/tmp')").run(nodeId, rigId, logicalId);
    if (running) {
      const status = running === "exited" ? "exited" : "running";
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, '2026-11-18T00:00:00Z')")
        .run(`sess-${seq}`, nodeId, session, status);
    }
    if (bound) {
      db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, 'tmux', ?, ?)")
        .run(`bind-${seq}`, nodeId, session, `%${seq}`);
    }
    return { rigId, nodeId, session };
  }

  function markPaneMissing(nodeId: string, sessionName: string, reason: "session_missing" | "pane_exited" = "session_missing"): void {
    const binding = db.prepare("SELECT tmux_pane FROM bindings WHERE node_id = ?").get(nodeId) as { tmux_pane: string | null } | undefined;
    new SeatIdentityStore(db).upsert({
      nodeId,
      verdict: "pane_missing",
      evidenceSource: reason === "pane_exited" ? "pane_process" : "tmux_session",
      reason,
      evidence: { registeredPane: binding?.tmux_pane ?? "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName,
      observedAt: new Date().toISOString(),
    });
  }

  function appFor(r: QueueRepository = queue): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus as never);
      c.set("queueRepo" as never, r as never);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    return app;
  }

  async function ageRow(qitemId: string, ageMinutes: number, now = new Date()): Promise<void> {
    const oldTs = new Date(now.getTime() - ageMinutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ?, ts_updated = ? WHERE qitem_id = ?").run(oldTs, oldTs, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(oldTs, qitemId);
  }

  async function createNoNudge(sourceSession: string, destinationSession: string, body: string, ageMinutes = 90, now = new Date(), summary?: string): Promise<QueueItem> {
    const row = await queue.create({ sourceSession, destinationSession, body, ...(summary !== undefined ? { summary } : {}), nudge: false });
    await ageRow(row.qitemId, ageMinutes, now);
    return queue.getByIdOrThrow(row.qitemId);
  }

  async function sweep(overrides: Record<string, unknown> = {}) {
    return runStuckSweep({
      db,
      queueRepo: queue,
      status: createStuckSweepStatus(),
      unclaimedAgeMinutes: 60,
      log: () => {},
      isRegisteredHost: () => false,
      resolveRecoveryAgentSeat: () => null,
      resolveOperatorSeat: () => null,
      ...overrides,
    });
  }

  const allFindings = (): QueueItem[] =>
    queue.list({ limit: 500 }).filter((r) => (r.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
  const findingsTo = (session: string): QueueItem[] =>
    allFindings().filter((r) => r.destinationSession === session);
  const unroutableNotices = (): QueueItem[] =>
    allFindings().filter((r) => (r.tags ?? []).some((t) => t.startsWith(UNROUTABLE_NOTICE_PREFIX)));
  const isOpen = (row: QueueItem): boolean => row.state === "pending" || row.state === "in-progress" || row.state === "blocked";

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    seq = 0;
    nudgesSent = [];
    hostedMembers = [];
    queue = makeRepo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("R1 / C6: keeps existing #2430 and #3049 paths on main with zero cross-kind release against #514", async () => {
    hostedMembers = [{ seat: "helper@hub", kind: "agent", label: "Helper" } as unknown as RosterMember];
    queue = makeRepo();
    seedSeat("ops", "coord.lead", "lead@ops");
    const dev = seedSeat("ops", "work.dev", "dev@ops", { running: true, bound: true });
    seedSeat("hub", "coord.lead", "lead@hub");

    const now = new Date();
    // 1) Open #2430 notice on dev@ops while bound, then dev@ops loses binding: #514 opens alongside #2430 with no cross-kind release.
    const rDev = await createNoNudge("lead@ops", "dev@ops", "Active task", 90, now);
    await sweep({ now });
    const [own2430] = findingsTo("dev@ops").filter((n) => (n.tags ?? []).includes(unclaimedBacklogTag("dev@ops")));
    expect(own2430?.state).toBe("pending");

    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(dev.nodeId);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(dev.nodeId);
    // 2) Hosted polling member concurrently holds nudged (#3049) and --no-nudge (#514) rows from lead@hub.
    const hNudged = await queue.create({ sourceSession: "lead@hub", destinationSession: "helper@hub", body: "Hosted nudged" });
    db.prepare("UPDATE queue_items SET last_nudge_result = 'awaiting-pickup: helper@hub is a hosted member' WHERE qitem_id = ?").run(hNudged.qitemId);
    await ageRow(hNudged.qitemId, 90, now);
    const hNoNudge = await createNoNudge("lead@hub", "helper@hub", "Hosted no-nudge", 90, now);

    await sweep({ now });
    expect(queue.getByIdOrThrow(own2430!.qitemId).state).toBe("pending");
    const [n514Dev] = findingsTo("lead@ops").filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "dev@ops")));
    expect(n514Dev?.state).toBe("pending");

    const hubOpen = findingsTo("lead@hub").filter(isOpen);
    expect(hubOpen).toHaveLength(2);
    const n3049 = hubOpen.find((n) => (n.tags ?? []).includes(unclaimedBacklogTag("helper@hub")));
    const n514Hub = hubOpen.find((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@hub", "helper@hub")));
    expect(n3049).toBeDefined();
    expect(n514Hub).toBeDefined();

    // Closing only nudged row closes #3049 while leaving #514 open; closing rDev closes both notices cleanly.
    queue.update({ qitemId: hNudged.qitemId, actorSession: "lead@hub", state: "canceled" });
    queue.update({ qitemId: rDev.qitemId, actorSession: "lead@ops", state: "canceled" });
    await sweep({ now });
    expect(queue.getByIdOrThrow(n3049!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(queue.getByIdOrThrow(n514Hub!.qitemId).state).toBe("pending");
    expect(queue.getByIdOrThrow(own2430!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(queue.getByIdOrThrow(n514Dev!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(queue.getByIdOrThrow(hNoNudge.qitemId).state).toBe("pending");

    // 3) P2-1 / R11-F1: exited seat keeping its tmux binding with no pane_missing verdict keeps #2430 standing notice and zero #514 or per-row flood.
    seedSeat("ops", "work.exitedbound", "exitedbound@ops", { running: "exited", bound: true });
    await createNoNudge("lead@ops", "exitedbound@ops", "Kept binding 1", 90, now);
    await createNoNudge("lead@ops", "exitedbound@ops", "Kept binding 2", 90, now);
    await sweep({ now });
    const exitedOpen = findingsTo("exitedbound@ops").filter(isOpen);
    expect(exitedOpen).toHaveLength(1);
    expect(exitedOpen[0]!.tags).toContain(unclaimedBacklogTag("exitedbound@ops"));
    expect(allFindings().some((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "exitedbound@ops")))).toBe(false);
  });

  it("R2 / C1: intercepts unclaimed --no-nudge and verified rows on unreachable destinations while preserving main claimed/rerouted paths", async () => {
    hostedMembers = [{ seat: "helper@hub", kind: "agent", label: "Helper" } as unknown as RosterMember];
    queue = makeRepo();
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "coord.operator", "operator@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });
    seedSeat("ops", "work.offline", "offline@ops", { running: "exited", bound: false });
    const worker = seedSeat("ops", "work.worker", "worker@ops", { running: true, bound: true });
    const stopped = seedSeat("ops", "work.stopped", "stopped@ops", { running: true, bound: true });
    markPaneMissing(stopped.nodeId, "stopped@ops", "session_missing");

    const now = new Date();
    // Prior verified row whose destination then loses session and binding.
    const verified = await queue.create({ sourceSession: "lead@ops", destinationSession: "worker@ops", body: "Verified then stopped" });
    expect(verified.lastNudgeResult).toBe("verified");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(worker.nodeId);
    db.prepare("DELETE FROM sessions WHERE node_id = ?").run(worker.nodeId);
    await ageRow(verified.qitemId, 90, now);

    // --no-nudge rows to parked, unbound (running=true, bound=false), mistyped, and non-polled hosted destinations.
    await createNoNudge("lead@ops", "parked@ops", "Parked task", 90, now);
    await createNoNudge("lead@ops", "offline@ops", "Unbound task", 90, now);
    await createNoNudge("lead@ops", "typo@ops", "Typo task", 90, now);
    const hostedVerified = await queue.create({ sourceSession: "lead@ops", destinationSession: "helper@hub", body: "Hosted verified", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_result = 'verified' WHERE qitem_id = ?").run(hostedVerified.qitemId);
    await ageRow(hostedVerified.qitemId, 90, now);

    // C1 boundaries preserved on main: (a) stalled-after-claim at stopped seat uses routeAroundMissing -> operator@ops;
    // (b) unclaimed row at session_missing seat with configured operatorAgent already routes via routeAroundMissing -> operator@ops.
    const claimedStopped = await createNoNudge("lead@ops", "stopped@ops", "Claimed stopped", 95, now);
    queue.claim({ qitemId: claimedStopped.qitemId, destinationSession: "stopped@ops" });
    const claimTs = new Date(now.getTime() - 90 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ? WHERE qitem_id = ?").run(claimTs, claimedStopped.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND state = 'in-progress'").run(claimTs, claimedStopped.qitemId);
    const unclaimedMissingWithOp = await createNoNudge("lead@ops", "stopped@ops", "Missing with op", 90, now);

    nudgesSent = [];
    await sweep({ now, resolveRecoveryAgentSeat: () => "operator@ops" });

    for (const unreachable of ["parked@ops", "offline@ops", "worker@ops", "typo@ops", "helper@hub", "stopped@ops"]) {
      expect(findingsTo(unreachable)).toHaveLength(0);
      expect(nudgesSent.filter((n) => n.destination === unreachable)).toHaveLength(0);
    }
    const leadTags = findingsTo("lead@ops").flatMap((n) => n.tags ?? []);
    for (const dest of ["worker@ops", "parked@ops", "offline@ops", "typo@ops", "helper@hub"]) {
      expect(leadTags).toContain(unroutableNoticeTag("lead@ops", dest));
    }
    // Preserved main routeAroundMissing paths sent per-row findings to operator@ops without being intercepted by R2.
    const opFindings = findingsTo("operator@ops");
    expect(opFindings.some((f) => f.body.includes(claimedStopped.qitemId))).toBe(true);
    expect(opFindings.some((f) => f.body.includes(unclaimedMissingWithOp.qitemId))).toBe(true);

    // Live re-check before emit: a row claimed during yield produces zero notices.
    const parkedLate = await createNoNudge("lead@ops", "parked2@ops", "Late claim", 90, now);
    const filler = seedSeat("ops", "work.filler", "filler@ops", { running: true, bound: true });
    expect(filler.session).toBe("filler@ops");
    let triggered = false;
    const origGet = queue.getById.bind(queue);
    queue.getById = ((id: string, opts?: { waiting?: boolean }) => {
      if (id === parkedLate.qitemId && !triggered && queue.list({ limit: 500 }).some((x) => (x.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")))) {
        triggered = true;
        queue.claim({ qitemId: parkedLate.qitemId, destinationSession: "parked2@ops" });
      }
      return origGet(id, opts);
    }) as typeof queue.getById;
    await sweep({ now });
    expect(allFindings().some((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked2@ops")))).toBe(false);
  });

  it("R3 / C2: targets source, operatorAgent, or operatorSeat, and records unreported when none is reachable", async () => {
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });
    seedSeat("ops", "coord.operator", "operator@ops");
    const humanSeat = "human@external";

    // Reject unaccepted external creator, fallback to operatorAgent, then operatorSeat.
    let humans: HumanFragment[] = [{
      entityId: "human",
      class: "human",
      displayName: "Human",
      address: humanSeat,
      connectorBindings: [{ kind: "slack", connectorRef: "slack:test", secretsRef: "vault:test", role: "primary" }],
      prefs: { deliveryClass: "A" },
    }];
    const rigs = new RigRepository(db);
    const topo = makeTopologyDestinationCheck({ findRigsByName: (n) => rigs.findRigsByName(n), loadHumanRegistry: () => ({ ok: true, entities: humans }) });
    queue = new QueueRepository(db, bus, {
      validateRig: topo,
      canRecordDestination: makeQueueRecordingCheck(topo),
      loadHumanRegistry: () => ({ ok: true, entities: humans }),
      transport: { send: async (d, t) => { nudgesSent.push({ destination: d, text: t }); return { ok: true, verified: true, sent: true, inputPhase: "written" }; } },
    });

    const row = await createNoNudge("deadsrc@ops", "parked@ops", "Dead source task", 90);
    // 1) No reachable fallback anywhere -> 0 items, 0 wakes, recorded as action="unreported" with destination.
    const rUnreported = await runStuckSweep({
      db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60,
      log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null,
    });
    expect(rUnreported.outcome).toBe("findings");
    expect(allFindings()).toHaveLength(0);
    expect(nudgesSent).toHaveLength(0);
    expect(rUnreported.findings).toContainEqual({
      kind: "unroutable-notice", qitemId: row.qitemId, findingQitemId: "", action: "unreported", destination: "parked@ops",
    });

    // 2) Reachable operatorSeat when operatorAgent is absent.
    await runStuckSweep({
      db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60,
      log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => humanSeat,
    });
    expect(findingsTo(humanSeat)).toHaveLength(1);

    // 3) OperatorAgent wins before operatorSeat when both are configured.
    db.prepare("DELETE FROM queue_items WHERE tags LIKE ?").run(`%"${STUCK_SWEEP_FINDING_TAG}"%`);
    await runStuckSweep({
      db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60,
      log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => "operator@ops", resolveOperatorSeat: () => humanSeat,
    });
    expect(findingsTo("operator@ops")).toHaveLength(1);
    expect(findingsTo(humanSeat)).toHaveLength(0);
    humans = [];
  });

  it("R4 / C3: deduplicates by (source, dest) across target changes, enforces ASCII case isolation, and enforces atomic verifyBeforeCreate dedup", async () => {
    const alphaUpper = seedSeat("ops", "coord.alpha", "Alpha@ops");
    seedSeat("ops", "coord.alpha_lower", "alpha@ops");
    seedSeat("ops", "coord.operator", "operator@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    // Distinct ASCII case sources stay isolated; two rows per source coalesce into one notice.
    await createNoNudge("Alpha@ops", "parked@ops", "A1");
    await createNoNudge("Alpha@ops", "parked@ops", "A2");
    await createNoNudge("alpha@ops", "parked@ops", "a1");

    await sweep();
    const realNotices = unroutableNotices().filter((n) => n.sourceSession === "parked@ops");
    expect(realNotices.filter((n) => n.destinationSession === "Alpha@ops")).toHaveLength(1);
    expect(realNotices.filter((n) => n.destinationSession === "alpha@ops")).toHaveLength(1);

    // P3-1: Second pass while open creates zero duplicates, even if Alpha@ops stops and notice target shifts to operator@ops.
    const countBefore = realNotices.length;
    await sweep();
    expect(unroutableNotices().filter((n) => n.sourceSession === "parked@ops")).toHaveLength(countBefore);
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(alphaUpper.nodeId);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(alphaUpper.nodeId);
    await sweep({ resolveRecoveryAgentSeat: () => "operator@ops" });
    expect(unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("Alpha@ops", "parked@ops")))).toHaveLength(1);

    // P3-2: Two sources differing only in ASCII case sharing operator@ops get distinct notices and isolated dismissals.
    await createNoNudge("CaseSrc@ops", "parked@ops", "Upper case fallback");
    await sweep({ resolveRecoveryAgentSeat: () => "operator@ops" });
    const [nUpper] = unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("CaseSrc@ops", "parked@ops")));
    expect(nUpper).toBeDefined();
    expect(nUpper!.destinationSession).toBe("operator@ops");
    await queue.update({ qitemId: nUpper!.qitemId, actorSession: "operator@ops", state: "canceled", transitionNote: "dismiss upper only" });

    await createNoNudge("casesrc@ops", "parked@ops", "Lower case fallback");
    await sweep({ resolveRecoveryAgentSeat: () => "operator@ops" });
    expect(queue.getByIdOrThrow(nUpper!.qitemId).state).toBe("canceled");
    const upperOpen = unroutableNotices().filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("CaseSrc@ops", "parked@ops")));
    const lowerOpen = unroutableNotices().filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("casesrc@ops", "parked@ops")));
    expect(upperOpen).toHaveLength(0);
    expect(lowerOpen).toHaveLength(1);
    expect(lowerOpen[0]!.destinationSession).toBe("operator@ops");

    await createNoNudge("alpha@ops", "parked2@ops", "Race check");
    const origCreate = queue.create.bind(queue);
    queue.create = (async (input, verifyBeforeCreate) => {
      if ((input.tags ?? []).includes(unroutableNoticeTag("alpha@ops", "parked2@ops"))) {
        // Insert an open tag-matched notice right before create's transaction checks verifyBeforeCreate.
        await origCreate({
          sourceSession: input.sourceSession,
          destinationSession: input.destinationSession,
          body: input.body,
          summary: input.summary,
          evidenceRef: input.evidenceRef,
          tags: input.tags,
          nudge: false,
        });
      }
      return origCreate(input, verifyBeforeCreate);
    }) as typeof queue.create;
    const raceRes = await sweep();
    expect(raceRes.outcome).toBe("findings");
    const parked2Open = unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("alpha@ops", "parked2@ops")));
    expect(parked2Open).toHaveLength(1);
  });

  it("R5 / C5: minimal notice body names count, source, destination, and list command only (no item IDs or summaries)", async () => {
    seedSeat("ops", "coord.sendera", "senderA@ops");
    seedSeat("ops", "coord.senderb", "senderB@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const r1 = await createNoNudge("senderA@ops", "parked@ops", "Secret A task body 1", 90, new Date(), "Secret A summary 1");
    const r2 = await createNoNudge("senderA@ops", "parked@ops", "Secret A task body 2", 90, new Date(), "Secret A summary 2");
    await createNoNudge("senderB@ops", "parked@ops", "Confidential B task", 90, new Date(), "Confidential B summary");

    await sweep();
    const [noticeA] = findingsTo("senderA@ops");
    expect(noticeA).toBeDefined();
    expect(noticeA!.body).toContain("2 unclaimed rows from senderA@ops to parked@ops");
    expect(noticeA!.body).toContain("destination: parked@ops");
    expect(noticeA!.body).toContain("rig queue list --destination parked@ops --state pending");
    expect(noticeA!.body).not.toContain(r1.qitemId);
    expect(noticeA!.body).not.toContain(r2.qitemId);
    expect(noticeA!.body).not.toContain("Secret A summary");
    expect(noticeA!.body).not.toContain("Secret A task body");
    expect(noticeA!.body).not.toContain("Confidential B");
    expect(nudgesSent.filter((n) => n.destination === "senderA@ops")).toHaveLength(1);
  });

  it("R6: creates notice once without rewriting count/body and follows tag-identified handoff children", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "coord.helper", "helper@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const r1 = await createNoNudge("lead@ops", "parked@ops", "Initial task", 90, now, "Initial summary");
    await sweep({ now });
    const [notice] = findingsTo("lead@ops");
    const initialBody = notice!.body;
    const initialSummary = notice!.summary;
    expect(initialBody).toContain("1 unclaimed row from lead@ops to parked@ops");

    // Additional qualifying row arrives -> notice is NOT rewritten and count stays "1 unclaimed row".
    const r2 = await createNoNudge("lead@ops", "parked@ops", "Second task", 90, now, "Second summary");
    await sweep({ now });
    const afterAdd = queue.getByIdOrThrow(notice!.qitemId);
    expect(afterAdd.body).toBe(initialBody);
    expect(afterAdd.summary).toBe(initialSummary);
    expect(findingsTo("lead@ops").filter(isOpen)).toHaveLength(1);

    // Handing off copies STUCK_SWEEP_FINDING_TAG + unroutable-notice tag to child: sweep recognizes child without filing a duplicate and resolves it once work clears.
    const { created: child } = await queue.handoff({
      qitemId: notice!.qitemId,
      fromSession: "lead@ops",
      toSession: "helper@ops",
      body: "Forwarded for review",
      nudge: false,
    });
    queue.update({ qitemId: r1.qitemId, actorSession: "lead@ops", state: "canceled" });
    const handedSweep = await sweep({ now });

    expect(handedSweep.findings).toContainEqual({
      kind: "unroutable-notice",
      qitemId: "lead@ops~>parked@ops",
      findingQitemId: child.qitemId,
      action: "refreshed",
    });
    expect(queue.getByIdOrThrow(child.qitemId)).toMatchObject({ state: "pending", body: "Forwarded for review" });
    expect(findingsTo("lead@ops").filter(isOpen)).toHaveLength(0);
    expect(unroutableNotices().filter(isOpen)).toHaveLength(1);

    queue.update({ qitemId: r2.qitemId, actorSession: "lead@ops", state: "canceled" });
    await sweep({ now });
    expect(queue.getByIdOrThrow(child.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("R7: stays open across raised age thresholds while work waits, and closes done on row resolution or destination recovery", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    const parked = seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    await createNoNudge("lead@ops", "parked@ops", "Waiting item", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops");
    expect(notice?.state).toBe("pending");

    // Raised threshold hides the row from detection -> R7 live re-check without age threshold keeps notice open.
    await sweep({ now, unclaimedAgeMinutes: 240 });
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");

    // Destination starts and binds -> destination recovers -> sweep closes #514 notice done/no-follow-on.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-up', ?, 'parked@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(parked.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-up', ?, 'tmux', 'parked@ops', '%77')")
      .run(parked.nodeId);
    await sweep({ now });
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("R8 / C4: non-sweep close suppresses until newer evidence while sweep no-follow-on close does not suppress if destination fails again", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    const worker = seedSeat("ops", "work.flaky", "flaky@ops", { running: false, bound: false });

    const t0 = new Date(Date.now() - 120 * 60_000);
    await createNoNudge("lead@ops", "flaky@ops", "First flap row", 90, new Date());
    await sweep();
    const [n1] = findingsTo("lead@ops").filter(isOpen);
    expect(n1).toBeDefined();

    // 1) Operator/recipient dismisses n1 -> suppressed while no newer row arrives.
    await queue.update({ qitemId: n1!.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "acknowledged" });
    await sweep();
    expect(findingsTo("lead@ops").filter(isOpen)).toHaveLength(0);

    // Newer work arrives after dismissal -> creates n2 cleanly.
    const r2 = await queue.create({ sourceSession: "lead@ops", destinationSession: "flaky@ops", body: "Newer work", nudge: false });
    const later = new Date(Date.now() + 5_000);
    db.prepare("UPDATE queue_items SET ts_created = ?, ts_updated = ? WHERE qitem_id = ?").run(later.toISOString(), later.toISOString(), r2.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(later.toISOString(), r2.qitemId);
    const futureSweep = new Date(Date.now() + 90 * 60_000);
    await sweep({ now: futureSweep });
    const [n2] = findingsTo("lead@ops").filter(isOpen);
    expect(n2).toBeDefined();

    // 2) C4: flaky@ops recovers so sweep (stuck-sweep@system, no-follow-on) closes n2, then flaky@ops stops again with SAME old rows -> MUST NOT suppress.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-flaky', ?, 'flaky@ops', 'running', ?)")
      .run(worker.nodeId, t0.toISOString());
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-flaky', ?, 'tmux', 'flaky@ops', '%88')")
      .run(worker.nodeId);
    await sweep({ now: new Date(futureSweep.getTime() + 60_000) });
    expect(queue.getByIdOrThrow(n2!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });

    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(worker.nodeId);
    db.prepare("DELETE FROM sessions WHERE node_id = ?").run(worker.nodeId);
    await sweep({ now: new Date(futureSweep.getTime() + 120_000) });
    const n3Open = findingsTo("lead@ops").filter((r) => isOpen(r) && (r.tags ?? []).includes(unroutableNoticeTag("lead@ops", "flaky@ops")));
    expect(n3Open).toHaveLength(1);
    expect(n3Open[0]!.qitemId).not.toBe(n2!.qitemId);
  });

  it("identifies notices by STUCK_SWEEP_FINDING_TAG plus unroutable-notice tag alone and exports findUnroutableNotice for #3541", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const noticeTag = unroutableNoticeTag("lead@ops", "parked@ops");
    expect(typeof stuckSweep.findUnroutableNotice).toBe("function");

    // A row carrying only one of the two tags, or only a substring, does not match and is never closed.
    const missingFindingTag = await queue.create({
      sourceSession: "lead@ops",
      destinationSession: "lead@ops",
      body: "Missing STUCK_SWEEP_FINDING_TAG",
      tags: [noticeTag],
      nudge: false,
    });
    const substringOnly = await queue.create({
      sourceSession: "lead@ops",
      destinationSession: "lead@ops",
      body: "Substring tag only",
      tags: [STUCK_SWEEP_FINDING_TAG, `note:${noticeTag}`],
      nudge: false,
    });
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops")).toBeNull();
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops", { states: [] })).toBeNull();

    // 1) A notice created via HTTP with arbitrary body/qitemId and non-null identity_provenance IS identified by its tags alone.
    const httpRes = await appFor().request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@ops" },
      body: JSON.stringify({
        destinationSession: "lead@ops",
        body: "Custom notice body without 5-line format",
        tags: [STUCK_SWEEP_FINDING_TAG, noticeTag],
        nudge: false,
      }),
    });
    expect(httpRes.status).toBe(201);
    const httpNotice = await httpRes.json() as { qitemId: string };
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops")).toMatchObject({
      qitemId: httpNotice.qitemId,
      state: "pending",
      destinationSession: "lead@ops",
    });
    // Exact ASCII case isolation holds in the exported lookup.
    expect(stuckSweep.findUnroutableNotice(db, "Lead@ops", "parked@ops")).toBeNull();

    // Sweep refreshes the tag-identified HTTP notice instead of creating a duplicate, and closes it when work clears.
    const work = await createNoNudge("lead@ops", "parked@ops", "Work waiting at parked@ops", 90, new Date());
    const refreshRes = await sweep();
    expect(refreshRes.findings).toContainEqual({
      kind: "unroutable-notice",
      qitemId: "lead@ops~>parked@ops",
      findingQitemId: httpNotice.qitemId,
      action: "refreshed",
    });
    expect(unroutableNotices().filter(isOpen)).toHaveLength(1);

    // Deleting the 'created' transition does not prevent tag-only lookup or resolution.
    db.prepare("DELETE FROM queue_transitions WHERE qitem_id = ? AND transition_note = 'created'").run(httpNotice.qitemId);
    queue.update({ qitemId: work.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "resolved" });
    await sweep();
    expect(queue.getByIdOrThrow(httpNotice.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(queue.getByIdOrThrow(missingFindingTag.qitemId).state).toBe("pending");
    expect(queue.getByIdOrThrow(substringOnly.qitemId).state).toBe("pending");

    // Closed lookup finds the resolved notice, while open lookup returns null.
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops")).toBeNull();
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops", { states: ["done", "canceled"] })).toMatchObject({
      qitemId: httpNotice.qitemId,
      state: "done",
    });

    // 2) A row tagged post-creation via addTags is also recognized as the notice (no duplicate filed, closes on clear).
    const taggedLater = await queue.create({
      sourceSession: "parked@ops",
      destinationSession: "lead@ops",
      body: "Tagged post-creation",
      tags: ["ops-note"],
      nudge: false,
    });
    queue.addTags({ qitemId: taggedLater.qitemId, actorSession: "lead@ops", tags: [STUCK_SWEEP_FINDING_TAG, noticeTag] });
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops")?.qitemId).toBe(taggedLater.qitemId);

    const work2 = await createNoNudge("lead@ops", "parked@ops", "Second waiting row", 90, new Date());
    const res2 = await sweep();
    expect(res2.findings).toContainEqual({
      kind: "unroutable-notice",
      qitemId: "lead@ops~>parked@ops",
      findingQitemId: taggedLater.qitemId,
      action: "refreshed",
    });
    queue.update({ qitemId: work2.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "resolved" });
    await sweep();
    expect(queue.getByIdOrThrow(taggedLater.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });

    // 3) Query plan for the actual SQL executed by findUnroutableNotice uses idx_queue_items_recovery_tags rather than scanning by state.
    let lookupSql = "";
    const origPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      lookupSql = sql;
      return origPrepare(sql);
    }) as typeof db.prepare);
    expect(stuckSweep.findUnroutableNotice(db, "lead@ops", "parked@ops")).toBeNull();
    prepareSpy.mockRestore();
    expect(lookupSql).not.toBe("");
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${lookupSql}`)
      .all("pending", "in-progress", "blocked", STUCK_SWEEP_FINDING_TAG, noticeTag) as Array<{ detail: string }>;
    expect(plan.some((p) => p.detail.includes("idx_queue_items_recovery_tags"))).toBe(true);
  });

  it("P2-A: seat losing binding during sweep yield before #2430 creation skips #2430 without waking the stopped seat", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    // Seed enough bound seats before dev@ops so backlogSeats yields at STUCK_SWEEP_YIELD_EVERY_ROWS.
    const fillerRows = new Set<string>();
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const seatName = `filler-${String(i).padStart(3, "0")}@ops`;
      seedSeat("ops", `work.filler${i}`, seatName, { running: true, bound: true });
      const row = await createNoNudge("lead@ops", seatName, `Filler backlog ${i}`, 90, new Date());
      fillerRows.add(row.qitemId);
    }
    const dev = seedSeat("ops", "work.dev", "dev@ops", { running: true, bound: true });
    await createNoNudge("lead@ops", "dev@ops", "Lost binding mid-pass task", 90, new Date());

    const origGetById = queue.getById.bind(queue);
    let droppedDev = false;
    vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (!droppedDev && fillerRows.has(id)) {
        droppedDev = true;
        setImmediate(() => {
          db.prepare("DELETE FROM bindings WHERE node_id = ?").run(dev.nodeId);
          db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(dev.nodeId);
        });
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    await sweep();

    expect(droppedDev).toBe(true);
    expect(nudgesSent.filter((n) => n.destination === "dev@ops")).toHaveLength(0);
    expect(findingsTo("dev@ops").filter((n) => (n.tags ?? []).includes(unclaimedBacklogTag("dev@ops")))).toHaveLength(0);
    const n514 = findingsTo("lead@ops").filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "dev@ops")));
    expect(n514).toHaveLength(1);
    expect(n514[0]!.state).toBe("pending");
  });

  it("P2-B: large #514 group refresh and resolution check yield every STUCK_SWEEP_YIELD_EVERY_ROWS rows", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    const parked = seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const total = STUCK_SWEEP_YIELD_EVERY_ROWS * 2 + 10;
    const now = new Date();
    const rowIds: string[] = [];
    for (let i = 0; i < total; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Batch item ${i}`, 90, now);
      rowIds.push(r.qitemId);
    }

    const startTicker = () => {
      let ticks = 0;
      let stopped = false;
      const step = () => {
        if (stopped) return;
        ticks++;
        setImmediate(step);
      };
      setImmediate(step);
      return { now: () => ticks, stop: () => { stopped = true; } };
    };

    // 1) Large group.rows refresh yields and observes a mid-group cancellation before creating the #514 notice.
    const rowIdSet = new Set(rowIds);
    const origGetById = queue.getById.bind(queue);
    const ticker1 = startTicker();
    const refreshTicks: number[] = [];
    let scheduledCancel = false;
    const getByIdSpy = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (rowIdSet.has(id)) {
        refreshTicks.push(ticker1.now());
        if (!scheduledCancel) {
          scheduledCancel = true;
          const tailId = rowIds[total - 1]!;
          setImmediate(() => {
            queue.update({ qitemId: tailId, actorSession: "lead@ops", state: "canceled", transitionNote: "canceled during yield" });
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    await sweep({ now });
    ticker1.stop();
    getByIdSpy.mockRestore();

    expect(refreshTicks.length).toBeGreaterThanOrEqual(total);
    expect(refreshTicks[refreshTicks.length - 1]!).toBeGreaterThan(refreshTicks[0]!);
    const [notice] = findingsTo("lead@ops").filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice).toBeDefined();
    expect(notice!.body).toContain(`${total - 1} unclaimed rows from lead@ops to parked@ops`);

    // Cancel old aged rows so openUnroutableNotices resolution check runs across fresh (<60m) pending rows.
    for (const id of rowIds.slice(0, total - 1)) {
      queue.update({ qitemId: id, actorSession: "lead@ops", state: "canceled", transitionNote: "cleared old batch" });
    }
    const freshPendingIds = new Set<string>();
    for (let i = 0; i < total; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Fresh pending item ${i}`, 5, now);
      freshPendingIds.add(r.qitemId);
    }

    // Destination starts recovered so pendingRows inspects rows one-by-one; mid-scan yield unbinds parked@ops again -> keeps notice open.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-up-p2b', ?, 'parked@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(parked.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-up-p2b', ?, 'tmux', 'parked@ops', '%92')")
      .run(parked.nodeId);

    const ticker2 = startTicker();
    const resTicksFirst: number[] = [];
    let unbindQueued = false;
    const spy2 = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (freshPendingIds.has(id)) {
        resTicksFirst.push(ticker2.now());
        if (!unbindQueued) {
          unbindQueued = true;
          setImmediate(() => {
            db.prepare("DELETE FROM bindings WHERE node_id = ?").run(parked.nodeId);
            db.prepare("DELETE FROM sessions WHERE node_id = ?").run(parked.nodeId);
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    await sweep({ now });
    ticker2.stop();
    spy2.mockRestore();

    expect(resTicksFirst.length).toBeGreaterThanOrEqual(2);
    expect(resTicksFirst.length).toBeLessThanOrEqual(STUCK_SWEEP_YIELD_EVERY_ROWS + 1);
    expect(resTicksFirst[resTicksFirst.length - 1]!).toBeGreaterThan(resTicksFirst[0]!);
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");

    // Now keep parked@ops recovered across the full 110-row resolution scan: yields across the entire scan and closes cleanly.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-up-p2b2', ?, 'parked@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(parked.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-up-p2b2', ?, 'tmux', 'parked@ops', '%93')")
      .run(parked.nodeId);

    const ticker3 = startTicker();
    const resTicksFull: number[] = [];
    const spy3 = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (freshPendingIds.has(id)) resTicksFull.push(ticker3.now());
      return origGetById(id, opts);
    }) as typeof queue.getById);

    await sweep({ now });
    ticker3.stop();
    spy3.mockRestore();

    expect(resTicksFull).toHaveLength(total);
    expect(resTicksFull[resTicksFull.length - 1]!).toBeGreaterThan(resTicksFull[0]!);
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("terminal hold starting during pending-row yield keeps open notice while work remains and closes once work finishes", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    const worker = seedSeat("ops", "work.worker", "worker@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "worker@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "worker@ops")));
    expect(notice).toBeDefined();

    // Recover worker@ops with a running tmux binding and cancel the aged row so openUnroutableNotices enters the else scan.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-up-a01', ?, 'worker@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(worker.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-up-a01', ?, 'tmux', 'worker@ops', '%95')")
      .run(worker.nodeId);
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by fresh pending batch" });

    const pendingIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "worker@ops", `Pending held work ${i}`, 5, now);
      pendingIds.push(r.qitemId);
    }
    const pendingSet = new Set(pendingIds);

    let terminalLost = false;
    queue.deliveryDrains.attachTerminalHold(
      (session) => terminalLost && isTmuxBoundSession(db, session),
      () => terminalLost,
    );

    // 1) Hold starts during the pendingRows yield while pending work remains -> notice MUST stay open.
    const origGetById = queue.getById.bind(queue);
    let holdTriggered = false;
    const spyHold = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (!holdTriggered && pendingSet.has(id)) {
        holdTriggered = true;
        setImmediate(() => { terminalLost = true; });
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);
    await sweep({ now });
    spyHold.mockRestore();

    expect(holdTriggered).toBe(true);
    expect(queue.deliveryDrains.holds("worker@ops")).toBe(true);
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");

    // 2) Steady-state sweep while held and pending work remains still keeps notice open.
    await sweep({ now });
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");

    // 3) Hold starts during the pendingRows yield AND all pending work completes during that yield -> notice MUST close.
    terminalLost = false;
    let holdAndCompleteTriggered = false;
    const spyHoldComplete = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (!holdAndCompleteTriggered && pendingSet.has(id)) {
        holdAndCompleteTriggered = true;
        setImmediate(() => {
          terminalLost = true;
          for (const pid of pendingIds) {
            queue.update({ qitemId: pid, actorSession: "worker@ops", state: "done", closureReason: "no-follow-on" });
          }
        });
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);
    await sweep({ now });
    spyHoldComplete.mockRestore();

    expect(holdAndCompleteTriggered).toBe(true);
    expect(queue.deliveryDrains.holds("worker@ops")).toBe(true);
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });

    // 4) Steady-state closure under active terminal hold once the last pending item completes.
    terminalLost = false;
    const worker2 = seedSeat("ops", "work.worker2", "worker2@ops", { running: false, bound: false });
    const w2Row = await createNoNudge("lead@ops", "worker2@ops", "Held steady-state work", 90, now);
    await sweep({ now });
    const [notice2] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "worker2@ops")));
    expect(notice2).toBeDefined();

    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-up-a01b', ?, 'worker2@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(worker2.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-up-a01b', ?, 'tmux', 'worker2@ops', '%96')")
      .run(worker2.nodeId);
    terminalLost = true;
    await sweep({ now });
    expect(queue.getByIdOrThrow(notice2!.qitemId).state).toBe("pending");

    queue.update({ qitemId: w2Row.qitemId, actorSession: "worker2@ops", state: "done", closureReason: "no-follow-on" });
    await sweep({ now });
    expect(queue.getByIdOrThrow(notice2!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("combined terminal hold suppresses notices for held tmux destination and defers wake for held tmux recipient until server returns", async () => {
    const outbox = new OutboxHandler(db);
    queue.attachOutbox(outbox);

    seedSeat("ops", "coord.lead", "lead@ops", { running: true, bound: true });
    const heldDest = seedSeat("ops", "work.held", "held@ops", { running: "exited", bound: true });
    markPaneMissing(heldDest.nodeId, "held@ops", "session_missing");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const socket = "/tmp/term-hold-514-test/sock";
    let serverUp = true;
    const adapter = new TmuxAdapter(async (command) => {
      if (!serverUp) throw new Error(`Command failed: ${command}\nno server running on ${socket}`);
      if (command.startsWith("tmux has-session")) return "";
      throw new Error(`Unexpected command: ${command}`);
    });
    let returnDrain: Promise<unknown> | undefined;
    const reach = wireTerminalReachability({
      db,
      adapter,
      drains: queue.deliveryDrains,
      socket,
      emit: () => {},
      drainPendingWakeIntents: (opts) => {
        returnDrain = queue.drainPendingWakeIntents(opts);
        return returnDrain;
      },
      retryPromptWakes: () => {},
    });

    try {
      serverUp = false;
      await adapter.probeSession("lead@ops");
      expect(queue.deliveryDrains.holds("lead@ops")).toBe(true);
      expect(queue.deliveryDrains.holds("held@ops")).toBe(true);
      expect(queue.deliveryDrains.holds("parked@ops")).toBe(false);

      const now = new Date();
      await createNoNudge("lead@ops", "held@ops", "Work for held tmux destination", 90, now);
      await createNoNudge("lead@ops", "parked@ops", "Work for unbound parked destination", 90, now);

      nudgesSent = [];
      await sweep({ now });

      // Held tmux destination gets no #514 notice while server is unreachable.
      expect(unroutableNotices().some((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "held@ops")))).toBe(false);

      // Unbound destination creates its #514 notice to lead@ops; wake stays pending in outbox with zero transport sends while held.
      const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
      expect(notice).toBeDefined();
      expect(nudgesSent).toHaveLength(0);
      const wakeEntry = outbox.getById(`${WAKE_INTENT_PREFIX}${notice!.qitemId}`);
      expect(wakeEntry?.deliveryState).toBe("pending");
      expect(wakeEntry?.destinationSession).toBe("lead@ops");

      // Server returns -> hold ends -> deferred wake intent drains and delivers cleanly.
      serverUp = true;
      await adapter.probeSession("lead@ops");
      expect(queue.deliveryDrains.holds("lead@ops")).toBe(false);
      expect(returnDrain).toBeDefined();
      await returnDrain;
      expect(nudgesSent.filter((n) => n.destination === "lead@ops")).toHaveLength(1);
      expect(outbox.getById(`${WAKE_INTENT_PREFIX}${notice!.qitemId}`)?.deliveryState).toBe("delivered");
    } finally {
      reach.stop();
    }
  });

  it("recounts qualifying rows inside the create transaction, stopping at zero and updating count after mid-yield cancellations", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });
    seedSeat("ops", "work.parked2", "parked2@ops", { running: false, bound: false });
    seedSeat("ops", "work.parked3", "parked3@ops", { running: false, bound: false });

    const now = new Date();
    const batchSize = STUCK_SWEEP_YIELD_EVERY_ROWS + 10;

    // 1) All rows canceled during a later yield in group.rows refresh (after early rows already entered liveRows) -> zero notices created.
    const allCancelIds: string[] = [];
    for (let i = 0; i < batchSize; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `All-cancel row ${i}`, 90, now);
      allCancelIds.push(r.qitemId);
    }
    const allCancelSet = new Set(allCancelIds);
    const origGetById = queue.getById.bind(queue);
    let allCancelReads = 0;
    let allCanceledDuringYield = false;
    const spyAllCancel = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (allCancelSet.has(id)) {
        allCancelReads++;
        // Trigger on the second pass (group.rows refresh), once early rows are already in liveRows.
        if (!allCanceledDuringYield && allCancelReads === batchSize + 5) {
          setImmediate(() => {
            allCanceledDuringYield = true;
            for (const qid of allCancelIds) {
              queue.update({ qitemId: qid, actorSession: "lead@ops", state: "canceled", transitionNote: "canceled during group yield" });
            }
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    nudgesSent = [];
    const resAllCancel = await sweep({ now });
    spyAllCancel.mockRestore();

    expect(allCanceledDuringYield).toBe(true);
    expect(resAllCancel.outcome).toBe("clean");
    expect(unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")))).toHaveLength(0);
    expect(nudgesSent).toHaveLength(0);

    // 2) Partial cancellation of already-counted rows (0..19) during yield -> notice count reflects the 40 surviving rows, not 60.
    const partialCancelIds: string[] = [];
    for (let i = 0; i < batchSize; i++) {
      const r = await createNoNudge("lead@ops", "parked2@ops", `Partial-cancel row ${i}`, 90, now);
      partialCancelIds.push(r.qitemId);
    }
    const partialSet = new Set(partialCancelIds);
    let partialReads = 0;
    let partialCanceledDuringYield = false;
    const spyPartial = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (partialSet.has(id)) {
        partialReads++;
        if (!partialCanceledDuringYield && partialReads === batchSize + 5) {
          setImmediate(() => {
            partialCanceledDuringYield = true;
            for (const qid of partialCancelIds.slice(0, 20)) {
              queue.update({ qitemId: qid, actorSession: "lead@ops", state: "canceled", transitionNote: "early row canceled during yield" });
            }
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resPartial = await sweep({ now });
    spyPartial.mockRestore();

    expect(partialCanceledDuringYield).toBe(true);
    expect(resPartial.outcome).toBe("findings");
    const [partialNotice] = unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked2@ops")));
    expect(partialNotice).toBeDefined();
    expect(partialNotice!.body).toContain(`${batchSize - 20} unclaimed rows from lead@ops to parked2@ops`);
    expect(partialNotice!.summary).toContain(`${batchSize - 20} unclaimed rows`);

    // 3) Last qualifying row canceled right before create's transaction callback runs -> verifyBeforeCreate recounts 0 and skips cleanly.
    const raceRow = await createNoNudge("lead@ops", "parked3@ops", "Canceled right before create txn", 90, now);
    const origCreate = queue.create.bind(queue);
    let canceledBeforeTxn = false;
    queue.create = (async (input, verifyBeforeCreate) => {
      if (!canceledBeforeTxn && (input.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked3@ops"))) {
        canceledBeforeTxn = true;
        queue.update({ qitemId: raceRow.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "canceled before create txn" });
      }
      return origCreate(input, verifyBeforeCreate);
    }) as typeof queue.create;

    nudgesSent = [];
    const resPreTxn = await sweep({ now });
    queue.create = origCreate;

    expect(canceledBeforeTxn).toBe(true);
    expect(resPreTxn.outcome).not.toBe("failed");
    expect(resPreTxn.error).toBeUndefined();
    expect(unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked3@ops")))).toHaveLength(0);
    expect(nudgesSent).toHaveLength(0);
  });

  it("refreshes hosted polling status after a yield so dropping a hosted member during close scan keeps the notice open", async () => {
    hostedMembers = [{ seat: "helper@hub", kind: "agent", label: "Helper" } as unknown as RosterMember];
    queue = makeRepo();
    seedSeat("ops", "coord.lead", "lead@ops", { running: false, bound: false });
    seedSeat("ops", "coord.watcher", "watcher@ops", { running: true, bound: true });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "helper@hub", "Initial no-nudge row", 90, now);
    await sweep({ now, resolveRecoveryAgentSeat: () => "watcher@ops" });
    const [notice] = findingsTo("watcher@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "helper@hub")));
    expect(notice).toBeDefined();

    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by polled batch" });

    const polledIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "helper@hub", `Hosted polled row ${i}`, 5, now);
      db.prepare("UPDATE queue_items SET last_nudge_result = 'awaiting-pickup: helper@hub is a hosted member' WHERE qitem_id = ?").run(r.qitemId);
      polledIds.push(r.qitemId);
    }

    // Drop helper@hub from hostedMembers during the close-scan yield so remaining rows become unreachable non-polled work.
    const origGetById = queue.getById.bind(queue);
    const firstId = polledIds[0]!;
    let sawFirstRow = false;
    let droppedFromRoster = false;
    const spy = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (id === firstId && !sawFirstRow) {
        sawFirstRow = true;
        setImmediate(() => {
          hostedMembers = [];
          droppedFromRoster = true;
        });
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resKeep = await sweep({ now });
    spy.mockRestore();

    expect(sawFirstRow).toBe(true);
    expect(droppedFromRoster).toBe(true);
    expect(resKeep.outcome).toBe("clean");
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");

    // Restoring helper@hub to hostedMembers lets the next sweep close the notice cleanly.
    hostedMembers = [{ seat: "helper@hub", kind: "agent", label: "Helper" } as unknown as RosterMember];
    const resClose = await sweep({ now });
    expect(resClose.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("keeps no-yield close scan synchronous through update and closes a yielding set of stably recovery-covered rows while honoring delivery holds", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    const parked = seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "parked@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice1] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice1).toBeDefined();

    // 1) No-yield close scan stays inline with zero implicit await before queue.update.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-sync', ?, 'parked@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(parked.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-sync', ?, 'tmux', 'parked@ops', '%94')")
      .run(parked.nodeId);
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by single fresh row" });
    const shortRow = await createNoNudge("lead@ops", "parked@ops", "Short scan fresh row", 5, now);

    const origGetById = queue.getById.bind(queue);
    const origUpdate = queue.update.bind(queue);
    let microtaskQueued = false;
    let microtaskRan = false;
    let closeObs: { microtaskRanAtUpdate: boolean; bindingsAtUpdate: number } | null = null;
    const getSpy = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (id === shortRow.qitemId && !microtaskQueued) {
        microtaskQueued = true;
        Promise.resolve().then(() => {
          microtaskRan = true;
          db.prepare("DELETE FROM bindings WHERE node_id = ?").run(parked.nodeId);
          db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(parked.nodeId);
        });
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);
    const updSpy = vi.spyOn(queue, "update").mockImplementation(((input: Parameters<typeof queue.update>[0]) => {
      if (input.qitemId === notice1!.qitemId) {
        const bindingsAtUpdate = (db.prepare("SELECT COUNT(*) AS n FROM bindings WHERE node_id = ?").get(parked.nodeId) as { n: number }).n;
        closeObs = { microtaskRanAtUpdate: microtaskRan, bindingsAtUpdate };
      }
      return origUpdate(input);
    }) as typeof queue.update);

    const resSync = await sweep({ now });
    getSpy.mockRestore();
    updSpy.mockRestore();

    expect(resSync.outcome).toBe("findings");
    expect(microtaskQueued).toBe(true);
    expect(microtaskRan).toBe(true);
    expect(closeObs).toEqual({ microtaskRanAtUpdate: false, bindingsAtUpdate: 1 });
    expect(queue.getByIdOrThrow(notice1!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });

    // 2) A yielding set of stably recovery-covered rows closes cleanly, while a genuine delivery hold keeps open.
    const parked2 = seedSeat("ops", "work.parked2", "parked2@ops", { running: false, bound: false });
    const seedRow = await createNoNudge("lead@ops", "parked2@ops", "Seed parked2 notice", 90, now);
    await sweep({ now });
    const [notice2] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked2@ops")));
    expect(notice2).toBeDefined();
    queue.update({ qitemId: seedRow.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by recovery-covered batch" });

    const coveredIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "parked2@ops", `Recovery-covered row ${i}`, 5, now);
      coveredIds.push(r.qitemId);
      await queue.create({
        sourceSession: "lead@ops",
        destinationSession: "lead@ops",
        body: `Open recovery for ${r.qitemId}`,
        tags: [STUCK_SWEEP_FINDING_TAG, recoveryTag(r.qitemId)],
        nudge: false,
      });
    }

    let holdActive = true;
    queue.deliveryDrains.attachTerminalHold(
      (session) => holdActive && session === "parked2@ops",
      () => holdActive,
    );
    const resHeld = await sweep({ now });
    expect(resHeld.outcome).toBe("clean");
    expect(queue.getByIdOrThrow(notice2!.qitemId).state).toBe("pending");

    holdActive = false;
    const resClosed = await sweep({ now });
    expect(resClosed.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice2!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(parked2.session).toBe("parked2@ops");
  });

  it("keeps open notice when a new uncovered row is inserted for the pair during a close-scan yield", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "parked@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice).toBeDefined();
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by covered batch" });

    const coveredIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Covered row ${i}`, 5, now);
      coveredIds.push(r.qitemId);
      await queue.create({
        sourceSession: "lead@ops",
        destinationSession: "lead@ops",
        body: `Open recovery for ${r.qitemId}`,
        tags: [STUCK_SWEEP_FINDING_TAG, recoveryTag(r.qitemId)],
        nudge: false,
      });
    }
    const coveredSet = new Set(coveredIds);

    const origGetById = queue.getById.bind(queue);
    let coveredReads = 0;
    let readsAtInjection = 0;
    let insertedInYield = false;
    let insertedRowPromise: Promise<QueueItem> | null = null;
    const spy = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (coveredSet.has(id)) {
        coveredReads++;
        // Schedule once the close-scan batch is visibly underway; the callback runs inside the mid-batch yieldLoop.
        if (coveredReads === 2) {
          setImmediate(() => {
            readsAtInjection = coveredReads;
            insertedRowPromise = queue.create({
              sourceSession: "lead@ops",
              destinationSession: "parked@ops",
              body: "New uncovered row inserted during close-scan yield",
              nudge: false,
            });
            insertedInYield = db.prepare(
              "SELECT 1 FROM queue_items WHERE source_session = 'lead@ops' AND destination_session = 'parked@ops' AND body = ?",
            ).get("New uncovered row inserted during close-scan yield") !== undefined;
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resKeep = await sweep({ now });
    spy.mockRestore();

    expect(insertedInYield).toBe(true);
    expect(readsAtInjection).toBeGreaterThanOrEqual(2);
    expect(readsAtInjection).toBeLessThan(coveredIds.length);
    expect(coveredReads).toBe(coveredIds.length);
    expect(insertedRowPromise).not.toBeNull();
    const insertedRow = await insertedRowPromise!;
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");
    expect(resKeep.outcome).toBe("clean");

    // Once the newly inserted uncovered row closes, the next sweep closes the notice cleanly.
    queue.update({ qitemId: insertedRow.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "resolved new row" });
    const resClose = await sweep({ now });
    expect(resClose.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("keeps open notice when an earlier row loses folded recovery coverage during a later close-scan yield", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "parked@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice).toBeDefined();
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by covered batch" });

    const coveredIds: string[] = [];
    const recoveryIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Covered row ${i}`, 5, now);
      coveredIds.push(r.qitemId);
      const rec = await queue.create({
        sourceSession: "lead@ops",
        destinationSession: "lead@ops",
        body: `Open recovery for ${r.qitemId}`,
        tags: [STUCK_SWEEP_FINDING_TAG, recoveryTag(r.qitemId)],
        nudge: false,
      });
      recoveryIds.push(rec.qitemId);
    }
    const coveredSet = new Set(coveredIds);

    // Earlier row's recovery finding is folded and closed during the later close-scan yield while the row itself is untouched.
    const origGetById = queue.getById.bind(queue);
    const firstId = coveredIds[0]!;
    const firstRecoveryId = recoveryIds[0]!;
    let coveredReads = 0;
    let readsAtInjection = 0;
    let sawFirstBeforeYield = false;
    let recoveryFolded = false;
    const spyFold = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (coveredSet.has(id)) {
        coveredReads++;
        if (id === firstId) sawFirstBeforeYield = true;
        if (coveredReads === 2) {
          setImmediate(() => {
            readsAtInjection = coveredReads;
            db.prepare(
              "UPDATE queue_items SET tags = json_insert(tags, '$[#]', ?) WHERE qitem_id = ? AND json_valid(tags)",
            ).run(BACKLOG_FOLDED_TAG, firstRecoveryId);
            queue.update({
              qitemId: firstRecoveryId,
              actorSession: "stuck-sweep@system",
              state: "done",
              closureReason: "no-follow-on",
              transitionNote: "folded during later close-scan yield",
            });
            recoveryFolded = true;
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resFoldKeep = await sweep({ now });
    spyFold.mockRestore();

    expect(sawFirstBeforeYield).toBe(true);
    expect(recoveryFolded).toBe(true);
    expect(readsAtInjection).toBeGreaterThanOrEqual(2);
    expect(readsAtInjection).toBeLessThan(coveredIds.length);
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");
    expect(resFoldKeep.outcome).toBe("clean");

    // Once the uncovered earlier row closes, the next sweep closes the notice cleanly.
    queue.update({ qitemId: firstId, actorSession: "lead@ops", state: "canceled", transitionNote: "resolved earlier row" });
    const resClose = await sweep({ now });
    expect(resClose.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("keeps open notice when an earlier row's closed recovery is superseded by a newer transition during a later close-scan yield", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "parked@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice).toBeDefined();
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by covered batch" });

    const coveredIds: string[] = [];
    const recoveryIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Covered row ${i}`, 5, now);
      coveredIds.push(r.qitemId);
      const rec = await queue.create({
        sourceSession: "lead@ops",
        destinationSession: "lead@ops",
        body: `Open recovery for ${r.qitemId}`,
        tags: [STUCK_SWEEP_FINDING_TAG, recoveryTag(r.qitemId)],
        nudge: false,
      });
      recoveryIds.push(rec.qitemId);
    }
    const coveredSet = new Set(coveredIds);

    const origGetById = queue.getById.bind(queue);
    const firstId = coveredIds[0]!;
    const firstRecoveryId = recoveryIds[0]!;
    let coveredReads = 0;
    let readsAtInjection = 0;
    let sawFirstBeforeYield = false;
    let recoverySuperseded = false;
    const spySupersede = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (coveredSet.has(id)) {
        coveredReads++;
        if (id === firstId) sawFirstBeforeYield = true;
        if (coveredReads === 2) {
          setImmediate(() => {
            readsAtInjection = coveredReads;
            queue.update({
              qitemId: firstRecoveryId,
              actorSession: "lead@ops",
              state: "done",
              closureReason: "no-follow-on",
              transitionNote: "closed recovery during later yield",
            });
            queue.update({
              qitemId: firstId,
              actorSession: "lead@ops",
              transitionNote: "follow-up after recovery closed",
            });
            recoverySuperseded = true;
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resSupersedeKeep = await sweep({ now });
    spySupersede.mockRestore();

    expect(sawFirstBeforeYield).toBe(true);
    expect(recoverySuperseded).toBe(true);
    expect(readsAtInjection).toBeGreaterThanOrEqual(2);
    expect(readsAtInjection).toBeLessThan(coveredIds.length);
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");
    expect(resSupersedeKeep.outcome).toBe("clean");

    queue.update({ qitemId: firstId, actorSession: "lead@ops", state: "canceled", transitionNote: "resolved earlier row" });
    const resClose = await sweep({ now });
    expect(resClose.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("keeps open notice when destination becomes unroutable during yield while remaining rows are recovery-covered", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    const parked = seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "parked@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice).toBeDefined();
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by mixed batch" });

    // Early rows are uncovered; tail rows scanned after the yield are recovery-covered so only envKey invalidation catches the unbind.
    const batchIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Mixed row ${i}`, 5, now);
      batchIds.push(r.qitemId);
      if (i >= STUCK_SWEEP_YIELD_EVERY_ROWS - 10) {
        await queue.create({
          sourceSession: "lead@ops",
          destinationSession: "lead@ops",
          body: `Open recovery for tail row ${r.qitemId}`,
          tags: [STUCK_SWEEP_FINDING_TAG, recoveryTag(r.qitemId)],
          nudge: false,
        });
      }
    }
    const batchSet = new Set(batchIds);

    // Start destination bound so the uncovered early rows pass before the yield.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-env-change', ?, 'parked@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(parked.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-env-change', ?, 'tmux', 'parked@ops', '%97')")
      .run(parked.nodeId);

    const origGetById = queue.getById.bind(queue);
    let batchReads = 0;
    let readsAtUnbind = 0;
    let unboundDuringYield = false;
    const spy = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (batchSet.has(id)) {
        batchReads++;
        if (batchReads === 2) {
          setImmediate(() => {
            readsAtUnbind = batchReads;
            db.prepare("DELETE FROM bindings WHERE node_id = ?").run(parked.nodeId);
            db.prepare("DELETE FROM sessions WHERE node_id = ?").run(parked.nodeId);
            unboundDuringYield = true;
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resKeep = await sweep({ now });
    spy.mockRestore();

    expect(unboundDuringYield).toBe(true);
    expect(readsAtUnbind).toBeGreaterThanOrEqual(2);
    expect(readsAtUnbind).toBeLessThan(batchIds.length);
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");
    expect(resKeep.outcome).toBe("clean");

    // Rebinding parked@ops allows the next sweep to close the notice cleanly.
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-env-recover', ?, 'parked@ops', 'running', '2026-11-18T00:00:00Z')")
      .run(parked.nodeId);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-env-recover', ?, 'tmux', 'parked@ops', '%98')")
      .run(parked.nodeId);
    const resClose = await sweep({ now });
    expect(resClose.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("keeps open notice when continuous mid-yield row mutations hit the close-scan pass bound", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    const now = new Date();
    const initial = await createNoNudge("lead@ops", "parked@ops", "Initial unreachable task", 90, now);
    await sweep({ now });
    const [notice] = findingsTo("lead@ops").filter((n) => isOpen(n) && (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")));
    expect(notice).toBeDefined();
    queue.update({ qitemId: initial.qitemId, actorSession: "lead@ops", state: "canceled", transitionNote: "replaced by churning covered batch" });

    const coveredIds: string[] = [];
    for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 5; i++) {
      const r = await createNoNudge("lead@ops", "parked@ops", `Churn row ${i}`, 5, now);
      coveredIds.push(r.qitemId);
      await queue.create({
        sourceSession: "lead@ops",
        destinationSession: "lead@ops",
        body: `Open recovery for churn row ${r.qitemId}`,
        tags: [STUCK_SWEEP_FINDING_TAG, recoveryTag(r.qitemId)],
        nudge: false,
      });
    }
    const coveredSet = new Set(coveredIds);

    // Mutate ts_updated on the batch during each pass's yield so passes 0, 1, and 2 all see dirty rows and hit the pass-2 fail-open bound.
    const origGetById = queue.getById.bind(queue);
    let totalReads = 0;
    let passReads = 0;
    let mutationsApplied = 0;
    let pendingImmediate: ReturnType<typeof setImmediate> | null = null;
    const spy = vi.spyOn(queue, "getById").mockImplementation(((id: string, opts?: { waiting?: boolean }) => {
      if (coveredSet.has(id)) {
        totalReads++;
        passReads++;
        if (pendingImmediate === null && mutationsApplied < 3 && passReads >= 2) {
          pendingImmediate = setImmediate(() => {
            pendingImmediate = null;
            mutationsApplied++;
            const bumped = new Date(now.getTime() + mutationsApplied * 1000).toISOString();
            for (const cid of coveredIds) {
              db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(bumped, cid);
            }
            passReads = 0;
          });
        }
      }
      return origGetById(id, opts);
    }) as typeof queue.getById);

    const resBound = await sweep({ now });
    if (pendingImmediate !== null) clearImmediate(pendingImmediate);
    spy.mockRestore();

    expect(mutationsApplied).toBe(3);
    expect(totalReads).toBeGreaterThan(coveredIds.length * 2);
    expect(queue.getByIdOrThrow(notice!.qitemId).state).toBe("pending");
    expect(resBound.outcome).toBe("clean");

    // Once churn stops, the next sweep closes the notice cleanly.
    const resClose = await sweep({ now });
    expect(resClose.outcome).toBe("findings");
    expect(queue.getByIdOrThrow(notice!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("excludes rows rerouted to another unreachable destination from the create-transaction recount", async () => {
    seedSeat("ops", "coord.lead", "lead@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });
    seedSeat("ops", "work.parked2", "parked2@ops", { running: false, bound: false });

    const now = new Date();
    const row = await createNoNudge("lead@ops", "parked@ops", "Rerouted right before create txn", 90, now);

    const origCreate = queue.create.bind(queue);
    let reroutedBeforeTxn = false;
    queue.create = (async (input, verifyBeforeCreate) => {
      if (!reroutedBeforeTxn && (input.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops"))) {
        reroutedBeforeTxn = true;
        db.prepare("UPDATE queue_items SET destination_session = 'parked2@ops' WHERE qitem_id = ?").run(row.qitemId);
      }
      return origCreate(input, verifyBeforeCreate);
    }) as typeof queue.create;

    nudgesSent = [];
    const res = await sweep({ now });
    queue.create = origCreate;

    expect(reroutedBeforeTxn).toBe(true);
    expect(unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("lead@ops", "parked@ops")))).toHaveLength(0);
    expect(res.outcome).toBe("clean");
    expect(res.error).toBeUndefined();
    expect(nudgesSent).toHaveLength(0);
  });
});
