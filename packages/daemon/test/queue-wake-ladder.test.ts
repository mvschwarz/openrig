// S01 (OPR.0.5.5.1) — WAKE OR ESCALATE ON BATONS, RED-first. "A handoff whose wake fails
// must never silently park." Today one failed nudge is recorded and nothing follows (the
// measured dominant 0.5.3 failure class). After this slice a failed baton wake RETRIES on a
// bounded config-keyed schedule, then ESCALATES through named rungs (destination's
// orchestrator, then the operator surface), every step a recorded transition, none silent.
//
// NAMED INVARIANT (mini-req 7): THE ROW CARRIES THE OBLIGATION EXACTLY-ONCE; THE WAKE IS
// AT-LEAST-ONCE. The ladder retries the NUDGE, never the content — no mechanism here mints
// a duplicate obligation row (the single aggregate escalation row per destination is a NEW
// obligation to the orchestrator, deduped and refreshed).
//
// The ladder's state IS the transition log (AM-P3-F6): attempts, rungs, and suspension are
// derived from markers at every tick, so a daemon restart resumes at the exact position —
// forgotten-ladder and reset-count are both REDs below.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import {
  LADDER_ATTEMPT_PREFIX,
  LADDER_RUNG_PREFIX,
  LADDER_EXHAUSTED_PREFIX,
  STUCK_SWEEP_FINDING_TAG,
  runStuckSweep,
  createStuckSweepStatus,
} from "../src/domain/queue-stuck-sweep.js";

const ladderMod = () => import("../src/domain/queue-wake-ladder.js");

interface WakeCall {
  qitemId: string;
  target: string;
}

describe("S01 wake-or-escalate — retry ladder, named rungs, derived suspension", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let calls: WakeCall[];
  /** Scripted outcomes by target session; default failed. */
  let outcomes: Record<string, string>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    calls = [];
    outcomes = {};
    delete process.env.OPENRIG_WAKE_SUSPEND;
  });
  afterEach(() => {
    delete process.env.OPENRIG_WAKE_SUSPEND;
    db.close();
  });

  const attemptWake = async (qitemId: string, target: string): Promise<string> => {
    calls.push({ qitemId, target });
    return outcomes[target] ?? "failed:tmux session not found";
  };

  async function mkBaton(dest = "worker@r"): Promise<QueueItem> {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "relay@r",
      toSession: dest,
      nudge: false,
    });
    return created;
  }

  function setNudgeResult(qitemId: string, result: string, minutesAgo = 0): void {
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?").run(
      ts,
      result,
      qitemId,
    );
  }

  function ageCreated(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, qitemId);
  }

  /** Back-date every ladder marker so the next tick sees the interval elapsed. */
  function ageMarkers(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare(
      "UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND (transition_note LIKE 'wake-attempt:%' OR transition_note LIKE 'escalation-rung:%' OR transition_note LIKE 'ladder-suspend:%')",
    ).run(past, qitemId);
  }

  function markersOf(qitemId: string, prefix: string): string[] {
    const rows = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid")
      .all(qitemId) as Array<{ transition_note: string | null }>;
    return rows.map((r) => r.transition_note ?? "").filter((n) => n.startsWith(prefix));
  }

  /** Real managed-seat shape: the canonical session (dash form) and the node's
   *  logical_id (dotted form) are DEFINED INDEPENDENTLY — live topology has zero cases
   *  where they match, so any fixture deriving one from the other is fixture-blind.
   *  The durable link is the sessions-table binding, never a string transform. */
  let nodeSeq = 0;
  function bindSeat(sessionName: string, dottedLogicalId: string, rigName = "r"): string {
    const nodeId = `node-${++nodeSeq}`;
    db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(`rig-${rigName}`, rigName);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(
      nodeId,
      `rig-${rigName}`,
      dottedLogicalId,
    );
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')",
    ).run(`sess-${nodeId}`, nodeId, sessionName);
    return nodeId;
  }

  function setHandoverAt(dest: string, secondsAgo: number): void {
    const existing = db
      .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
      .get(dest) as { node_id: string } | undefined;
    const nodeId = existing?.node_id ?? bindSeat(dest, `fixture.swap-${nodeSeq}`);
    db.prepare("UPDATE nodes SET handover_at = ? WHERE id = ?").run(
      new Date(Date.now() - secondsAgo * 1000).toISOString(),
      nodeId,
    );
  }

  async function tick(overrides: Record<string, unknown> = {}) {
    const mod = await ladderMod();
    return mod.runWakeLadderTick({
      db,
      queueRepo: repo,
      attemptWake,
      resolveOrchestrator: () => "orch@r",
      retryIntervalSeconds: 300,
      retryCap: 3,
      unconfirmedWindowMinutes: 30,
      swapGraceSeconds: 180,
      log: () => {},
      ...overrides,
    });
  }

  async function escalationRowsFor(dest: string): Promise<QueueItem[]> {
    const mod = await ladderMod();
    return repo
      .list({ limit: 500 })
      .filter((i) => (i.tags ?? []).includes(mod.escalationDedupTag(dest)));
  }

  // ── G1: RETRY RECORDED, RED-FIRST ────────────────────────────────────────────

  it("RETRY RECORDED: a failed baton wake re-attempts on schedule; every attempt lands as a transition marker with its outcome", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick();
    expect(calls).toEqual([{ qitemId: baton.qitemId, target: "worker@r" }]);
    let attempts = markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/1\/3/);
    expect(attempts[0]).toMatch(/failed/); // the attempt's outcome is on the marker
    ageMarkers(baton.qitemId, 10);
    await tick();
    ageMarkers(baton.qitemId, 10);
    await tick();
    attempts = markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toMatch(/3\/3/); // counted from transitions, not memory
  });

  it("SCHEDULE HONORED: a tick inside the retry interval makes no attempt (bounded, never a hot loop)", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick();
    expect(calls).toHaveLength(1);
    await tick(); // marker is fresh — interval not elapsed
    expect(calls).toHaveLength(1);
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(1);
  });

  // ── G2: ESCALATION RUNGS FIRE IN ORDER ───────────────────────────────────────

  it("RUNGS IN ORDER: past the cap the orchestrator rung lands as a recorded transition with the reason, one aggregate escalation row, no duplicate baton rows", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    for (let i = 0; i < 3; i++) {
      await tick();
      ageMarkers(baton.qitemId, 10);
    }
    const before = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    await tick(); // past cap → orchestrator rung
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatch(/orchestrator/);
    expect(rungs[0]).toMatch(/wake failed 3 times over \d+ min/i); // the reason, named
    const escRows = await escalationRowsFor("worker@r");
    expect(escRows).toHaveLength(1);
    expect(escRows[0]!.destinationSession).toBe("orch@r");
    expect(escRows[0]!.body).toContain(baton.qitemId);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(after).toBe(before + 1); // exactly the one aggregate row — the baton is never duplicated
  });

  it("VIEW SURFACES IT: `view show escalations` returns the open wake-escalation aggregate", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    for (let i = 0; i < 4; i++) {
      await tick();
      ageMarkers(baton.qitemId, 10);
    }
    const projector = new ViewProjector(db);
    const view = projector.show("escalations");
    const escRows = await escalationRowsFor("worker@r");
    expect(escRows).toHaveLength(1);
    expect(view.rows.map((r) => r.qitem_id)).toContain(escRows[0]!.qitemId);
  });

  // ── G3: F1 — UNCONFIRMED NEVER RETRIES, YET NEVER PARKS ──────────────────────

  it("UNCONFIRMED NEVER RE-NUDGES (negative control): a delivered-ack-pending baton inside the window gets zero wake attempts", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "delivered-ack-pending", 5);
    await tick();
    expect(calls).toHaveLength(0);
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0);
  });

  it("UNCONFIRMED + NO PICKUP ESCALATES DIRECTLY: past the window with no pickup evidence, the ladder skips the retry rung — the destination is NEVER re-sent to", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "delivered-ack-pending", 45);
    ageCreated(baton.qitemId, 45);
    await tick();
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0); // no retry rung
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatch(/orchestrator/);
    expect(rungs[0]).toMatch(/unconfirmed/i);
    // Escalation is not a re-send: every delivery attempt went to the orchestrator, none to the destination.
    expect(calls.every((c) => c.target === "orch@r")).toBe(true);
    expect(calls.some((c) => c.target === "worker@r")).toBe(false);
  });

  it("UNCONFIRMED + PICKUP ACTIVITY NEVER ENTERS (negative control): a claimed baton past the window is left alone", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "delivered-ack-pending", 45);
    ageCreated(baton.qitemId, 45);
    repo.claim({ qitemId: baton.qitemId, destinationSession: "worker@r" }); // pickup evidence
    await tick();
    expect(calls).toHaveLength(0);
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(0);
  });

  it("INDETERMINATE OUTCOMES RIDE THE SAME CONFIRMATION PATH: an indeterminate: baton with no pickup escalates without any re-send", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "indeterminate:wake send timed out", 45);
    ageCreated(baton.qitemId, 45);
    await tick();
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0);
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(1);
    expect(calls.some((c) => c.target === "worker@r")).toBe(false);
  });

  // ── G4: F2 — SUSPENSION DERIVES FROM THE SWAP STATE ──────────────────────────

  it("SWAP SUSPENDS THE LADDER: a destination inside the post-swap grace gets ZERO wake attempts and one recorded suspend marker (the stale-wake-burst specimen)", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    setHandoverAt("worker@r", 10); // swap completed 10s ago — inside the 180s grace
    await tick();
    await tick(); // the burst shape: repeated due ticks during the swap window
    expect(calls).toHaveLength(0); // zero attempts during the grace
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0);
    expect(markersOf(baton.qitemId, "ladder-suspend:")).toHaveLength(1); // recorded once, not per tick
  });

  it("RESUME IS RECORDED: after the grace passes the ladder resumes with a recorded resume marker and the retry proceeds", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    setHandoverAt("worker@r", 10);
    await tick(); // suspended
    setHandoverAt("worker@r", 600); // grace (180s) has passed
    await tick();
    expect(markersOf(baton.qitemId, "ladder-resume:")).toHaveLength(1);
    expect(calls).toEqual([{ qitemId: baton.qitemId, target: "worker@r" }]);
  });

  it("DECLARED WINDOW IS OPERATOR OVERRIDE ONLY: OPENRIG_WAKE_SUSPEND suspends a destination with no swap in sight", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    process.env.OPENRIG_WAKE_SUSPEND = `worker@r:${new Date(Date.now() + 3600_000).toISOString()}`;
    await tick();
    expect(calls).toHaveLength(0);
    expect(markersOf(baton.qitemId, "ladder-suspend:")).toHaveLength(1);
    expect(markersOf(baton.qitemId, "ladder-suspend:")[0]).toMatch(/operator/i); // named as the override
  });

  // ── G5: F3 — STORMS AGGREGATE ────────────────────────────────────────────────

  it("STORMS AGGREGATE: one dead destination x five stuck batons yields ONE aggregated escalation naming all five, refreshed not duplicated", async () => {
    const batons: QueueItem[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await mkBaton();
      setNudgeResult(b.qitemId, "failed:tmux session not found", 120);
      // Pre-lay the exhausted retry history so all five are in the escalation phase.
      for (let a = 1; a <= 3; a++) {
        repo.transitionLog.append({
          qitemId: b.qitemId,
          state: "pending",
          actorSession: "wake-ladder@system",
          transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
        });
      }
      ageMarkers(b.qitemId, 30);
      batons.push(b);
    }
    await tick();
    const escRows = await escalationRowsFor("worker@r");
    expect(escRows).toHaveLength(1); // five separate escalations is the RED
    for (const b of batons) expect(escRows[0]!.body).toContain(b.qitemId);
    await tick(); // re-detection refreshes the aggregate
    expect(await escalationRowsFor("worker@r")).toHaveLength(1);
    const refreshNotes = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?")
      .all(escRows[0]!.qitemId) as Array<{ transition_note: string | null }>;
    expect(refreshNotes.some((n) => /refresh/i.test(n.transition_note ?? ""))).toBe(true);
  });

  it("DESTINATION RATE-BOUND: wake attempts across all ladders to one destination stay within the per-window bound", async () => {
    for (let i = 0; i < 5; i++) {
      const b = await mkBaton();
      setNudgeResult(b.qitemId, "failed:tmux session not found", 60);
    }
    await tick();
    const toWorker = calls.filter((c) => c.target === "worker@r");
    expect(toWorker.length).toBeLessThanOrEqual(3); // the cap doubles as the per-destination window bound
    expect(toWorker.length).toBeGreaterThan(0);
  });

  // ── G6: F4 — RUNGS DELIVER AND ADVANCE ───────────────────────────────────────

  it("RUNG FAILURE ADVANCES: an orchestrator-rung wake failure advances to the operator rung — recorded, bounded, no cycle — and the operator floor is stated honestly with the S11 citation", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    outcomes["orch@r"] = "failed:tmux session not found"; // the orchestrator rung's own wake fails
    await tick(); // orchestrator rung (fails)
    ageMarkers(baton.qitemId, 30);
    await tick(); // advances to operator rung
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(2);
    expect(rungs[0]).toMatch(/orchestrator/);
    expect(rungs[1]).toMatch(/operator/);
    expect(rungs[1]).toMatch(/escalation view/i); // the floor, honestly stated
    expect(rungs[1]).toMatch(/S11/); // the human-layer connector cited as the named future leg
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)).toHaveLength(1); // finite — the ladder ends
    const before = calls.length;
    ageMarkers(baton.qitemId, 30);
    await tick(); // no cycle: an exhausted ladder never re-fires
    expect(calls.length).toBe(before);
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(2);
  });

  it("DELIVERED ESCALATION COMPLETES THE LADDER: a successful orchestrator wake ends the ladder without an operator rung", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    outcomes["orch@r"] = "verified";
    await tick();
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(1);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)).toHaveLength(1);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)[0]).toMatch(/delivered/i);
  });

  it("RUNG 1 SELF-SKIPS: when the orchestrator resolves to the destination itself, the ladder goes straight to the operator rung", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    await tick({ resolveOrchestrator: () => "worker@r" }); // resolves to the destination itself
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs.some((r) => /orchestrator/.test(r) && /self-skip/i.test(r))).toBe(true);
    expect(rungs.some((r) => /operator/.test(r))).toBe(true);
    expect(calls.some((c) => c.target === "worker@r")).toBe(false); // never escalated INTO the dead seat
  });

  // ── G7: F5 — THE S02 SEAM HOLDS ──────────────────────────────────────────────

  it("SEAM (live ladder): a baton under a live ladder produces ZERO S02 undelivered findings", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick(); // one attempt marker → live ladder
    await runStuckSweep({
      db,
      queueRepo: repo,
      status: createStuckSweepStatus(),
      resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60,
      log: () => {},
    });
    const findings = repo.list({ limit: 500 }).filter((i) => (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
    expect(findings.filter((f) => (f.tags ?? []).some((t) => t.endsWith(`:${baton.qitemId}`)))).toHaveLength(0);
  });

  it("SEAM (handback): an exhausted ladder is S02's net again — exactly one finding across two sweeps", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    outcomes["orch@r"] = "failed:tmux session not found";
    await tick(); // orchestrator rung fails
    ageMarkers(baton.qitemId, 30);
    await tick(); // operator rung + exhausted
    const sweep = () =>
      runStuckSweep({
        db,
        queueRepo: repo,
        status: createStuckSweepStatus(),
        resolveOrchestrator: () => null,
        unclaimedAgeMinutes: 60,
        log: () => {},
      });
    await sweep();
    await sweep();
    const findings = repo
      .list({ limit: 500 })
      .filter(
        (i) =>
          (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG) &&
          (i.tags ?? []).some((t) => t.endsWith(`:${baton.qitemId}`)),
      );
    expect(findings).toHaveLength(1);
  });

  // ── G8: F6 — THE LADDER SURVIVES RESTART BY DERIVATION ───────────────────────

  it("RESTART KEEPS THE COUNT: two recorded attempts survive a restart — the next attempt is 3/3, never 1/3 (reset-count RED)", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    await tick();
    ageMarkers(baton.qitemId, 10);
    await tick();
    // "Restart": the tick holds NO memory — everything derives from the transitions.
    ageMarkers(baton.qitemId, 10);
    await tick();
    const attempts = markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toMatch(/3\/3/);
  });

  it("RESTART KEEPS THE RUNG: a recorded orchestrator rung survives a restart — the ladder advances to operator, never forgets (forgotten-ladder RED)", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    repo.transitionLog.append({
      qitemId: baton.qitemId,
      state: "pending",
      actorSession: "wake-ladder@system",
      transitionNote: `${LADDER_RUNG_PREFIX} orchestrator -> orch@r outcome=failed:tmux session not found reason=wake failed 3 times over 45 min`,
    });
    ageMarkers(baton.qitemId, 30);
    await tick(); // fresh derivation: must advance to operator, not restart retries
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(3); // no new attempts
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(2);
    expect(rungs[1]).toMatch(/operator/);
  });

  // ── Production identity resolution (fix round: review-r2 NOT-CLEAR) ─────────

  it("DEFAULT ORCHESTRATOR RESOLUTION: production identity shapes resolve through the session binding — dotted logical ids, dash-form canonical sessions, no string derivation", async () => {
    // The live-fleet shape: `orch-lead@r` binds a node whose logical_id is `orch.lead`.
    const orchNode = bindSeat("orch-lead@r", "orch.lead");
    const workerNode = bindSeat("worker-b2@r", "worker.b2");
    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e1', 'rig-r', ?, ?, 'delegates_to')",
    ).run(orchNode, workerNode);
    const row = await mkBaton("worker-b2@r");
    setNudgeResult(row.qitemId, "failed:tmux session not found", 120);
    // Past the cap so the escalation resolves the orchestrator via the default resolver.
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: row.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(row.qitemId, 30);
    await tick({ resolveOrchestrator: undefined }); // exercise the default
    const escRows = await escalationRowsFor("worker-b2@r");
    expect(escRows).toHaveLength(1);
    // The parent's CURRENT canonical session binding — never a synthesized logical_id@rig.
    expect(escRows[0]!.destinationSession).toBe("orch-lead@r");
    const rungs = markersOf(row.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs.some((r) => /orchestrator -> orch-lead@r/.test(r))).toBe(true);
  });

  it("SELF-SKIP IS VISIBLE (operator floor end-to-end): with no orchestrator, the operator rung produces an OPEN escalation row exposed by the escalations view and the health status", async () => {
    const baton = await mkBaton("worker-c3@r");
    bindSeat("worker-c3@r", "worker.c3"); // bound seat, but no delegates_to parent
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    const mod = await ladderMod();
    const status = mod.createWakeLadderStatus();
    await tick({ resolveOrchestrator: undefined, status });
    // The rungs recorded and the ladder ended...
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX).some((r) => /operator/.test(r))).toBe(true);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)).toHaveLength(1);
    // ...and the escalation OBJECT exists: an open row, visible on both floor surfaces.
    const escRows = await escalationRowsFor("worker-c3@r");
    expect(escRows).toHaveLength(1);
    expect(escRows[0]!.state).toBe("pending");
    expect(escRows[0]!.destinationSession).not.toBe("worker-c3@r"); // never INTO the dead seat
    const view = new ViewProjector(db).show("escalations");
    expect(view.rows.map((r) => r.qitem_id)).toContain(escRows[0]!.qitemId);
    expect(status.snapshot().escalationsOpen).toBeGreaterThanOrEqual(1);
  });

  // ── Config surface ───────────────────────────────────────────────────────────

  it("FOUNDER DEFAULTS: retry cadence 300s, cap 3, unconfirmed window 30min, swap grace 180s — daemon store and module constants twinned", async () => {
    const mod = await ladderMod();
    expect(mod.DEFAULT_WAKE_RETRY_INTERVAL_SECONDS).toBe(300);
    expect(mod.DEFAULT_WAKE_RETRY_CAP).toBe(3);
    expect(mod.DEFAULT_WAKE_UNCONFIRMED_WINDOW_MINUTES).toBe(30);
    expect(mod.DEFAULT_WAKE_SWAP_GRACE_SECONDS).toBe(180);
    const missingConfig = `/tmp/openrig-s01-missing-${process.pid}-${Date.now()}.json`;
    const store = new SettingsStore(missingConfig);
    expect(store.resolveOne("queue.wake_retry_interval_seconds" as never)).toMatchObject({ value: 300, source: "default" });
    expect(store.resolveOne("queue.wake_retry_cap" as never)).toMatchObject({ value: 3, source: "default" });
    expect(store.resolveOne("queue.wake_unconfirmed_window_minutes" as never)).toMatchObject({ value: 30, source: "default" });
    expect(store.resolveOne("queue.wake_swap_grace_seconds" as never)).toMatchObject({ value: 180, source: "default" });
  });
});
