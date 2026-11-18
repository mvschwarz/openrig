import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { makeQueueRecordingCheck, makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RosterMember } from "../src/domain/rosters.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import {
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

  it("R4 / C3: deduplicates by (source, dest) across target changes, enforces provenance & ASCII case isolation, and enforces atomic verifyBeforeCreate dedup", async () => {
    const alphaUpper = seedSeat("ops", "coord.alpha", "Alpha@ops");
    seedSeat("ops", "coord.alpha_lower", "alpha@ops");
    seedSeat("ops", "coord.operator", "operator@ops");
    seedSeat("ops", "work.parked", "parked@ops", { running: false, bound: false });

    // Distinct ASCII case sources stay isolated; two rows per source coalesce into one notice.
    await createNoNudge("Alpha@ops", "parked@ops", "A1");
    await createNoNudge("Alpha@ops", "parked@ops", "A2");
    await createNoNudge("alpha@ops", "parked@ops", "a1");

    // P2-2: HTTP spoof matching source_session = dest, destination_session = target, handed_off_from = NULL, and exact tags:
    // ONLY identity_provenance IS NULL rejects it.
    const spoofRes = await appFor().request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "parked@ops" },
      body: JSON.stringify({
        destinationSession: "Alpha@ops",
        body: "forged http",
        summary: "forged http",
        tags: [STUCK_SWEEP_FINDING_TAG, unroutableNoticeTag("Alpha@ops", "parked@ops")],
        nudge: false,
      }),
    });
    expect(spoofRes.status).toBe(201);
    const httpSpoof = await spoofRes.json() as { qitemId: string };

    // Direct queue.create spoof with wrong source_session must also fail shape check.
    await queue.create({
      sourceSession: "Alpha@ops",
      destinationSession: "alpha@ops",
      body: "wrong shape",
      tags: [STUCK_SWEEP_FINDING_TAG, unroutableNoticeTag("alpha@ops", "parked@ops")],
      nudge: false,
    });

    await sweep();
    const realNotices = unroutableNotices().filter((n) => n.sourceSession === "parked@ops" && n.qitemId !== httpSpoof.qitemId);
    expect(realNotices.filter((n) => n.destinationSession === "Alpha@ops")).toHaveLength(1);
    expect(realNotices.filter((n) => n.destinationSession === "alpha@ops")).toHaveLength(1);

    // P3-1: Second pass while open creates zero duplicates, even if Alpha@ops stops and notice target shifts to operator@ops.
    const countBefore = realNotices.length;
    await sweep();
    expect(unroutableNotices().filter((n) => n.sourceSession === "parked@ops" && n.qitemId !== httpSpoof.qitemId)).toHaveLength(countBefore);
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(alphaUpper.nodeId);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(alphaUpper.nodeId);
    await sweep({ resolveRecoveryAgentSeat: () => "operator@ops" });
    expect(unroutableNotices().filter((n) => (n.tags ?? []).includes(unroutableNoticeTag("Alpha@ops", "parked@ops")) && n.qitemId !== httpSpoof.qitemId)).toHaveLength(1);

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
        // Insert an open sweep-shaped root right before create's transaction checks verifyBeforeCreate.
        await origCreate({
          sourceSession: input.sourceSession,
          destinationSession: input.destinationSession,
          body: input.body,
          summary: input.summary,
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

  it("R6: creates notice once without rewriting count/body and never extends authority across handoff children", async () => {
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

    // Handing off the open notice marks child foreign; sweep does not modify child and creates a fresh root notice for remaining work.
    const { created: child } = await queue.handoff({
      qitemId: notice!.qitemId,
      fromSession: "lead@ops",
      toSession: "helper@ops",
      body: "Forwarded for review",
      nudge: false,
    });
    queue.update({ qitemId: r1.qitemId, actorSession: "lead@ops", state: "canceled" });
    await sweep({ now });

    expect(queue.getByIdOrThrow(child.qitemId)).toMatchObject({ state: "pending", body: "Forwarded for review" });
    const freshLead = findingsTo("lead@ops").filter(isOpen);
    expect(freshLead).toHaveLength(1);
    expect(freshLead[0]!.qitemId).not.toBe(notice!.qitemId);
    expect(freshLead[0]!.body).toContain("1 unclaimed row from lead@ops to parked@ops");
    expect(r2.state).toBe("pending");
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
});
