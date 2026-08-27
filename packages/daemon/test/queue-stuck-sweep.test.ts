// S02 (OPR.0.5.5.2) — STANDING STUCK SWEEP, RED-first. "queue overdue and queue undelivered
// are verbs someone must remember to run — nobody ran them." This slice makes the sweep a
// standing daemon loop: both halves swept on a config-keyed cadence, findings routed as rows
// to the owning seats, quiet sweeps cheap (one heartbeat, no rows), failures loud.
//
// The four finding kinds:
//   overdue-claim        — claimed-never-closed (the findOverdue half, verb unchanged);
//   undelivered-wake     — sender-believed-delivered-never-woken (the findUndelivered half),
//                          MINUS rows with a live S01 ladder (the seam: S01 makes its ladder
//                          legible on transitions exactly so this filter is derivable), PLUS
//                          the laddered-then-exhausted handback (exactly one finding);
//   unclaimed-obligation — the A1 net: created-with-destination rows carrying real
//                          obligations, unclaimed past a config-keyed age (parks excluded —
//                          state=blocked is S03 territory and legitimately waits);
//   dangling-closure     — the custody class: a terminal row whose closure_target names a
//                          successor qitem that does not exist. Selection is by DESTINATION +
//                          obligation shape across ALL states, never by tag.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const sweepMod = () => import("../src/domain/queue-stuck-sweep.js");

describe("S02 standing stuck sweep — both halves, routed findings, quiet-but-observable", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => {
    db.close();
  });

  async function mkRow(dest = "worker@r"): Promise<QueueItem> {
    return repo.create({ sourceSession: "sender@r", destinationSession: dest, body: "work" });
  }

  /** Fixture aging of EXISTING facts via SQL — product code never sees an injected clock. */
  function ageCreated(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, qitemId);
  }
  function makeOverdue(qitemId: string): void {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(past, qitemId);
  }
  function failNudge(qitemId: string): void {
    db.prepare(
      "UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?",
    ).run(new Date().toISOString(), "failed:tmux session not found", qitemId);
  }

  async function runSweep(overrides: Record<string, unknown> = {}) {
    const mod = await sweepMod();
    const status = mod.createStuckSweepStatus();
    const result = await mod.runStuckSweep({
      db,
      queueRepo: repo,
      status,
      resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60,
      log: () => {},
      ...overrides,
    });
    return { mod, status, result };
  }

  async function findingsFor(qitemId: string): Promise<QueueItem[]> {
    const mod = await sweepMod();
    const all = repo.list({ limit: 500 });
    return all.filter(
      (i) =>
        (i.tags ?? []).includes(mod.STUCK_SWEEP_FINDING_TAG) &&
        (i.tags ?? []).some((t) => t.endsWith(`:${qitemId}`)),
    );
  }

  it("OVERDUE HALF: a claimed-never-closed row past closure_required_at yields exactly one finding row to the claimant, evidence inline", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    const { result } = await runSweep();
    expect(result.outcome).toBe("findings");
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.destinationSession).toBe("worker@r"); // the seat holding the stuck obligation
    expect(f.body).toContain(row.qitemId); // row id
    expect(f.body).toMatch(/overdue|claimed/i);
    expect(f.body).toMatch(/\d+\s*min/i); // age
  });

  it("UNDELIVERED HALF: a pending row whose nudge failed yields exactly one finding routed to the destination's orchestrator", async () => {
    const row = await mkRow();
    failNudge(row.qitemId);
    const { result } = await runSweep({ resolveOrchestrator: () => "orch@r" });
    expect(result.outcome).toBe("findings");
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    // Nobody holds an undelivered obligation — it routes to the owner's orchestrator.
    expect(findings[0]!.destinationSession).toBe("orch@r");
    expect(findings[0]!.body).toContain(row.qitemId);
  });

  it("DESTINATION-NOT-TAG: a completely tagless stuck row is found (the 0.5.3 lesson's exact shape)", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("[]", row.qitemId);
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("ALL STATES / CUSTODY CLASS: a done row whose closure_target names a nonexistent successor qitem is found; an honestly-closed done row is not", async () => {
    const dangling = await mkRow();
    repo.claim({ qitemId: dangling.qitemId, destinationSession: "worker@r" });
    repo.update({
      qitemId: dangling.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "qitem-20990101000000-deadbeef",
      transitionNote: "handed off (successor never created — the custody defect)",
    });
    const honest = await mkRow();
    repo.claim({ qitemId: honest.qitemId, destinationSession: "worker@r" });
    repo.update({
      qitemId: honest.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "done honestly",
    });
    await runSweep();
    expect(await findingsFor(dangling.qitemId)).toHaveLength(1);
    expect(await findingsFor(honest.qitemId)).toHaveLength(0);
  });

  it("IDEMPOTENT REFRESH: three consecutive sweeps over an unresolved finding keep ONE open finding row and refresh its age", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    await runSweep();
    await runSweep();
    const { result } = await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(result.findings.some((f) => f.action === "refreshed")).toBe(true);
    const transitions = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts")
      .all(findings[0]!.qitemId) as Array<{ transition_note: string | null }>;
    expect(transitions.some((t) => /refresh/i.test(t.transition_note ?? ""))).toBe(true);
  });

  it("RESOLUTION CLOSES: when the underlying row resolves, the next sweep closes the finding with its reason", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    await runSweep();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "finished the work",
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.state).toBe("done");
    expect(findings[0]!.closureReason).toBeTruthy();
  });

  it("QUIET IS CHEAP: a clean sweep creates zero rows and records one observable heartbeat", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    const { status, result } = await runSweep();
    expect(result.outcome).toBe("clean");
    const after = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(after).toBe(before);
    const snap = status.snapshot();
    expect(snap.lastSweepAt).toBeTruthy();
    expect(snap.lastOutcome).toBe("clean");
  });

  it("FAILURE IS LOUD: a sweep that cannot run records a named error on the status surface, never a silent skip", async () => {
    const brokenDb = new Database(":memory:"); // no migrations — the sweep's own queries fail
    const mod = await sweepMod();
    const status = mod.createStuckSweepStatus();
    const loud: string[] = [];
    const result = await mod.runStuckSweep({
      db: brokenDb,
      queueRepo: repo, // the repo works; the sweep's db leg is what breaks
      status,
      resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60,
      log: (line: string) => loud.push(line),
    });
    brokenDb.close();
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeTruthy();
    const snap = status.snapshot();
    expect(snap.lastOutcome).toBe("failed");
    expect(snap.lastError).toBeTruthy();
    expect(loud.length).toBeGreaterThan(0); // the loudness is emitted, not just stored
  });

  it("S01 SEAM — LIVE LADDER SKIPPED: an undelivered row whose transitions carry a live ladder marker produces no finding (S01 owns it)", async () => {
    const mod = await sweepMod();
    expect(mod.LADDER_ATTEMPT_PREFIX).toBe("wake-attempt:");
    expect(mod.LADDER_EXHAUSTED_PREFIX).toBe("ladder-exhausted:");
    const row = await mkRow();
    failNudge(row.qitemId);
    repo.update({
      qitemId: row.qitemId,
      actorSession: "sender@r",
      transitionNote: `${mod.LADDER_ATTEMPT_PREFIX} 1 failed:tmux session not found`,
    });
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("S01 SEAM — EXHAUSTED HANDBACK CAUGHT: a laddered-then-exhausted row is the sweep's net again — exactly one finding", async () => {
    const mod = await sweepMod();
    const row = await mkRow();
    failNudge(row.qitemId);
    repo.update({
      qitemId: row.qitemId,
      actorSession: "sender@r",
      transitionNote: `${mod.LADDER_ATTEMPT_PREFIX} 3 failed:tmux session not found`,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "sender@r",
      transitionNote: `${mod.LADDER_EXHAUSTED_PREFIX} cap reached after 3 attempts`,
    });
    await runSweep();
    await runSweep(); // handback still dedups: never double-reported
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("A1 NET — UNCLAIMED OBLIGATION: a created-with-destination row unclaimed past the age threshold is found; a fresh one and a parked one are not", async () => {
    const stale = await mkRow();
    ageCreated(stale.qitemId, 120);
    const fresh = await mkRow();
    const parked = await mkRow();
    repo.update({
      qitemId: parked.qitemId,
      actorSession: "sender@r",
      state: "blocked",
      blockedOn: stale.qitemId,
      transitionNote: "parked on blocker",
    });
    ageCreated(parked.qitemId, 120);
    const { result } = await runSweep({ resolveOrchestrator: () => "orch@r" });
    expect(result.outcome).toBe("findings");
    const staleFindings = await findingsFor(stale.qitemId);
    expect(staleFindings).toHaveLength(1);
    expect(staleFindings[0]!.destinationSession).toBe("orch@r");
    expect(await findingsFor(fresh.qitemId)).toHaveLength(0);
    expect(await findingsFor(parked.qitemId)).toHaveLength(0); // parks legitimately wait (S03 territory)
  });

  it("NO CASCADE: finding rows never themselves produce findings — a re-sweep after routing mints zero new rows", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    await runSweep();
    const afterFirst = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    // Age the finding row itself past the unclaimed threshold — still not swept (self-exclusion).
    const findings = await findingsFor(row.qitemId);
    ageCreated(findings[0]!.qitemId, 120);
    await runSweep();
    const afterSecond = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(afterSecond).toBe(afterFirst);
  });

  it("DEFAULT ORCHESTRATOR RESOLUTION: the topology delegates_to parentage routes an ownerless finding without injection", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-orch', 'rig1', 'orch')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-worker', 'rig1', 'worker')").run();
    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e1', 'rig1', 'n-orch', 'n-worker', 'delegates_to')",
    ).run();
    const row = await mkRow("worker@r");
    failNudge(row.qitemId);
    await runSweep({ resolveOrchestrator: undefined }); // exercise the default
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.destinationSession).toBe("orch@r");
  });

  it("FOUNDER DEFAULTS: cadence 300s and unclaimed age 60min on the daemon config surface, twinned in the module constants", async () => {
    const mod = await sweepMod();
    expect(mod.DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS).toBe(300);
    expect(mod.DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES).toBe(60);
    const missingConfig = `/tmp/openrig-s02-missing-${process.pid}-${Date.now()}.json`;
    const store = new SettingsStore(missingConfig);
    expect(store.resolveOne("queue.stuck_sweep_interval_seconds" as never)).toMatchObject({
      value: 300,
      source: "default",
    });
    expect(store.resolveOne("queue.stuck_sweep_unclaimed_age_minutes" as never)).toMatchObject({
      value: 60,
      source: "default",
    });
  });
});
