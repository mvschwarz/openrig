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
//   dangling-closure     — internal compatibility key for the custody class: a terminal
//                          row whose successor cannot be verified in the local store. Its
//                          user-facing finding is verification-required/indeterminate, never
//                          a declaration of absence. Selection is by DESTINATION + obligation
//                          shape across ALL states, never by tag.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, deriveCrossHostSuccessorId, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";

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
  function ageClaim(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    const beforePast = new Date(Date.now() - (minutes + 1) * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, beforePast, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(past, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'").run(beforePast, qitemId);
  }
  function makeOverdue(qitemId: string): void {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(past, qitemId);
  }
  function failNudge(qitemId: string): void {
    setNudgeResult(qitemId, "failed:tmux session not found", new Date());
  }
  function setNudgeResult(qitemId: string, result: string, at: Date): void {
    db.prepare(
      "UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?",
    ).run(at.toISOString(), result, qitemId);
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
      // Hermetic default: no registered hosts. Tests that exercise the
      // proof-at-write trust arm inject their own registry view.
      isRegisteredHost: () => false,
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

  it("S04 PICKUP SEAM: stalled-after-claim routes one finding to the claimant and later motion auto-closes it", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    expect(repo.getById(row.qitemId)!.pickup?.state).toBe("stalled-after-claim");

    const first = await runSweep();
    expect(first.result.findings).toContainEqual(expect.objectContaining({
      kind: "stalled-after-claim",
      qitemId: row.qitemId,
      action: "created",
    }));
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.destinationSession).toBe("worker@r");

    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      transitionNote: "resumed work",
    });
    expect(repo.getById(row.qitemId)!.pickup?.state).toBe("working");
    const second = await runSweep();
    expect(second.result.findings).toContainEqual(expect.objectContaining({
      kind: "stalled-after-claim",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]).toMatchObject({
      state: "done",
      closureReason: "no-follow-on",
    });
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

  it("LOCAL-MISS HONEST: an unresolved local successor is verification-required, never declared dead or paired with a history-mutation instruction", async () => {
    const unresolved = await mkRow();
    repo.claim({ qitemId: unresolved.qitemId, destinationSession: "worker@r" });
    const missing = "qitem-20990101000000-deadbeef";
    repo.update({
      qitemId: unresolved.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
      transitionNote: "handed off to a successor not visible in this local store",
    });

    await runSweep();
    const findings = await findingsFor(unresolved.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(missing);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
    expect(findings[0]!.body).toContain("OPENRIG_URL=<registered-host> rig queue show");
    expect(findings[0]!.body).not.toMatch(/does not exist|dangling/i);
    expect(findings[0]!.body).not.toMatch(/Resolve the underlying row|rewrite the historical row/i);

    const successor = await repo.create({
      qitemId: "qitem-20990101000000-livefeed",
      sourceSession: "worker@r",
      destinationSession: "next@r",
      body: "successor",
    });
    const resolved = await mkRow();
    repo.claim({ qitemId: resolved.qitemId, destinationSession: "worker@r" });
    repo.update({
      qitemId: resolved.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: successor.qitemId,
      transitionNote: "handed off to a locally visible successor",
    });
    await runSweep();
    expect(await findingsFor(resolved.qitemId)).toHaveLength(0);
  });

  it("COMMA SPLIT: fully local fan-out is clean; a partial local miss names only the member requiring verification", async () => {
    const a = await repo.create({ qitemId: "qitem-local-a", sourceSession: "worker@r", destinationSession: "a@r", body: "a" });
    const b = await repo.create({ qitemId: "qitem-local-b", sourceSession: "worker@r", destinationSession: "b@r", body: "b" });
    const complete = await mkRow();
    repo.update({
      qitemId: complete.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: `${a.qitemId},${b.qitemId}`,
    });
    const partial = await mkRow();
    const missing = "qitem-local-missing";
    repo.update({
      qitemId: partial.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: `${a.qitemId},${missing}`,
    });

    await runSweep();
    expect(await findingsFor(complete.qitemId)).toHaveLength(0);
    const findings = await findingsFor(partial.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(missing);
    expect(findings[0]!.body).not.toContain(a.qitemId);
  });

  it("HOST-QUALIFIED KEY: a foreign successor is classified without a local lookup, including handed-off source rows", async () => {
    const row = await mkRow();
    const foreign = "qitem-xh-0123456789abcdef@vps-b";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "handed-off",
      closureReason: "handed_off_to",
      closureTarget: foreign,
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(foreign);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
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

  it("REMINT PINNED: closing a finding while its evidence is unchanged suppresses the next sweep", async () => {
    const row = await mkRow();
    failNudge(row.qitemId);
    await runSweep();
    const first = (await findingsFor(row.qitemId))[0]!;
    repo.update({
      qitemId: first.qitemId,
      actorSession: first.destinationSession,
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "verified and closed",
    });

    const next = await runSweep();
    expect(next.result.findings).not.toContainEqual(expect.objectContaining({ qitemId: row.qitemId, action: "created" }));
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("NEW EVIDENCE + RECUR AFTER AUTO-CLOSE: a newer nudge row-field timestamp mints exactly one successor finding without any underlying transition", async () => {
    const row = await mkRow();
    const initial = new Date(Date.now() - 60_000);
    setNudgeResult(row.qitemId, "failed:first", initial);
    await runSweep();

    setNudgeResult(row.qitemId, "verified", new Date());
    await runSweep();
    expect((await findingsFor(row.qitemId))[0]!.state).toBe("done");

    const futureEvidence = new Date(Date.now() + 60_000);
    setNudgeResult(row.qitemId, "failed:recurred", futureEvidence);
    const beforeTransitions = repo.transitionLog.listForQitem(row.qitemId).length;
    const recur = await runSweep();
    expect(recur.result.findings).toContainEqual(expect.objectContaining({
      kind: "undelivered-wake",
      qitemId: row.qitemId,
      action: "created",
    }));
    expect(await findingsFor(row.qitemId)).toHaveLength(2);
    expect(repo.transitionLog.listForQitem(row.qitemId)).toHaveLength(beforeTransitions);
  });

  it("OPEN FINDING WINS: an open finding is refreshed even when an older closed watermark exists for the same row and kind", async () => {
    const row = await mkRow();
    setNudgeResult(row.qitemId, "failed:first", new Date(Date.now() - 120_000));
    await runSweep();
    const closed = (await findingsFor(row.qitemId))[0]!;
    repo.update({
      qitemId: closed.qitemId,
      actorSession: closed.destinationSession,
      state: "done",
      closureReason: "no-follow-on",
    });
    setNudgeResult(row.qitemId, "failed:new", new Date(Date.now() + 60_000));
    await runSweep();
    const open = (await findingsFor(row.qitemId)).find((f) => f.state === "pending")!;

    const again = await runSweep();
    expect(again.result.findings).toContainEqual(expect.objectContaining({
      findingQitemId: open.qitemId,
      action: "refreshed",
    }));
    expect((await findingsFor(row.qitemId)).filter((f) => f.state === "pending")).toHaveLength(1);
  });

  it("EXACTLY-ONCE UNDER CONCURRENCY: two overlapping sweeps mint one finding row", async () => {
    const row = await mkRow();
    failNudge(row.qitemId);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gatedRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "create") {
          return async (...args: Parameters<QueueRepository["create"]>) => {
            arrivals += 1;
            if (arrivals === 2) release();
            await barrier;
            return target.create(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await Promise.all([
      runSweep({ queueRepo: gatedRepo }),
      runSweep({ queueRepo: gatedRepo }),
    ]);
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
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

  it("S01 SEAM — LATEST MARKER WINS: attempt → exhausted → attempt is live again and skipped", async () => {
    const mod = await sweepMod();
    const row = await mkRow();
    failNudge(row.qitemId);
    for (const transitionNote of [
      `${mod.LADDER_ATTEMPT_PREFIX} 1`,
      `${mod.LADDER_EXHAUSTED_PREFIX} old cycle exhausted`,
      `${mod.LADDER_ATTEMPT_PREFIX} 1 new cycle`,
    ]) {
      repo.update({ qitemId: row.qitemId, actorSession: "sender@r", transitionNote });
    }
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
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

  it("DEFAULT ORCHESTRATOR RESOLUTION: production identity shapes resolve through the durable session binding — dotted logical ids, dash-form canonical sessions, no string derivation", async () => {
    // The live-fleet shape (review-r2 fix round): `orch-lead@r` binds a node whose
    // logical_id is `orch.lead` — the two forms are defined independently; the durable
    // link is the sessions-table binding, never a string transform.
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-orch', 'rig1', 'orch.lead')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-worker', 'rig1', 'worker.b2')").run();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-orch', 'n-orch', 'orch-lead@r', 'running')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-worker', 'n-worker', 'worker-b2@r', 'running')",
    ).run();
    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e1', 'rig1', 'n-orch', 'n-worker', 'delegates_to')",
    ).run();
    const row = await mkRow("worker-b2@r");
    failNudge(row.qitemId);
    await runSweep({ resolveOrchestrator: undefined }); // exercise the default
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    // The parent's CURRENT canonical session binding — never a synthesized logical_id@rig.
    expect(findings[0]!.destinationSession).toBe("orch-lead@r");
  });

  // ——— S02 detector-family continuation (row c2172d32): a host-qualified target written by
  // the cross-host close is proof-at-write (routes/queue.ts creates the successor on the
  // registered host FIRST and closes second), and a manual registered-host read earns a
  // durable custody-verified disposition. Both silence the eternal verification-required
  // refresh; unregistered hosts and unverified local misses stay the honest indeterminate
  // class, and true local dangling detection plus auto-close are preserved.

  it("TRUSTED HOST-QUALIFIED: the real cross-host close's derived key on a REGISTERED host is custody evidence at write time — no finding", async () => {
    // The exact write the forwarding route performs AFTER its successor-create
    // succeeded (routes/queue.ts: forwardQueueWrite first, close second): the
    // deterministic derived successor id + the host qualifier + handed_off_to.
    const row = await mkRow();
    const derived = deriveCrossHostSuccessorId(row.qitemId, "next@r2", "mm2-parent");
    repo.closeCrossHostHandoffSource({
      qitemId: row.qitemId,
      fromSession: "worker@r",
      toSession: "next@r2",
      closureTarget: `${derived}@mm2-parent`,
      terminalState: "handed-off",
    });
    await runSweep({ isRegisteredHost: (h: string) => h === "mm2-parent" });
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("FORGED HOST-QUALIFIED IS NOT TRUSTED: a generic close writing a registered-host-shaped target without the derived key stays verification-required", async () => {
    // The generic update route accepts arbitrary closureTarget — a registered
    // host SUFFIX alone is syntax, not forward provenance. Only the id the
    // cross-host close derives from (source row, handed_off_to, host) counts.
    const row = await mkRow();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "handed-off",
      closureReason: "handed_off_to",
      closureTarget: "qitem-xh-0123456789abcdef@mm2-parent",
    });
    await runSweep({ isRegisteredHost: (h: string) => h === "mm2-parent" });
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain("qitem-xh-0123456789abcdef@mm2-parent");
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
  });

  it("DISPOSITION SURVIVES RETENTION: the custody-verified note still silences after the real archiver moves the terminal row's transitions", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon04";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${missing} confirmed on the parent host`,
    });
    // Age every transition past the 30-day window and run the SHIPPED archiver —
    // the actual retention mechanism, not a simulation of it.
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(aged, row.qitemId);
    const archived = archiveAgedTerminalTransitions(db, { nowIso: new Date().toISOString() });
    expect(archived.archivedRows).toBeGreaterThan(0);
    const activeLeft = db
      .prepare("SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id = ?")
      .get(row.qitemId) as { n: number };
    expect(activeLeft.n).toBe(0); // the disposition is GONE from the active table

    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("UNREGISTERED HOST STAYS INDETERMINATE: an unknown host qualifier still earns a verification-required finding with honest wording", async () => {
    const row = await mkRow();
    const foreign = "qitem-xh-fedcba9876543210@vps-unknown";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: foreign,
    });
    await runSweep({ isRegisteredHost: (h: string) => h === "mm2-parent" });
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(foreign);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
    expect(findings[0]!.body).not.toMatch(/does not exist|dangling/i);
  });

  it("CUSTODY-VERIFIED DISPOSITION: a durable custody-verified note on the closed row silences the bare-id local miss", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon01";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${missing} confirmed on the parent host via OPENRIG_URL read`,
    });
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("DISPOSITION CLOSES THE OPEN FINDING: verification landing after the finding minted auto-closes it on the next sweep, and the finding taught the recipe", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon02";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await runSweep();
    const open = (await findingsFor(row.qitemId))[0]!;
    expect(open.state).toBe("pending");
    // The finding body teaches how to record the verification durably.
    expect(open.body).toContain("custody-verified:");

    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${missing} confirmed on the parent host`,
    });
    const next = await runSweep();
    expect(next.result.findings).toContainEqual(expect.objectContaining({
      kind: "dangling-closure",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]).toMatchObject({
      state: "done",
      closureReason: "no-follow-on",
    });
  });

  it("MIXED COMMA MEMBER TRUST: a fan-out with one disposition-verified member and one local miss names only the unresolved member", async () => {
    // The realistic legacy shape: a comma fan-out whose verified member earned a
    // durable disposition (comma lists come from legacy/generic closes; the
    // cross-host close path writes exactly one derived target, never a list).
    const row = await mkRow();
    const missing = "qitem-local-missing2";
    const verified = "qitem-local-verified1";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: `${missing},${verified}`,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${verified} confirmed on the parent host`,
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    // The verification-targets checklist renders each member as "- <target>"; the
    // verified member must be absent THERE. (The body's last-transition line echoes
    // the custody-verified note verbatim, so a bare not-contains on the id would
    // fail on the disposition's own honest echo.)
    expect(findings[0]!.body).toContain(`- ${missing}`);
    expect(findings[0]!.body).not.toContain(`- ${verified}`);
  });

  it("DISPOSITION IS EXACT: a custody-verified note naming a DIFFERENT target silences nothing", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon03";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: "custody-verified: qitem-20990101000000-otherrow confirmed elsewhere",
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(missing);
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
