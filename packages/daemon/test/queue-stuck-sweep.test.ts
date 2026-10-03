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
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

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
    expect(findings[0]!.evidenceRef).toBe(`rig queue show ${row.qitemId}`);
  });

  it.each(["human@host", "human-owner@kernel"])("a finding for %s carries real source evidence, stays unroutable, dedupes, and resolves", async (destinationSession) => {
    // Disable the repository's pre-topology transport shortcut. Resolution is
    // real; the injected transport must never receive these unknown addresses.
    db.prepare("INSERT INTO rigs(id,name) VALUES ('fixture-rig','r')").run();
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime,profile) VALUES ('fixture-node','fixture-rig','worker','codex','none')").run();
    const sent: string[] = [];
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      transport: { send: async (destination) => { sent.push(destination); return { ok: true, verified: true }; } },
    });
    const source = await mkRow();
    const row = await repo.create({
      sourceSession: "sender@r", destinationSession, body: "An actual work row awaits a decision",
      summary: "Fixture decision", evidenceRef: `rig queue show ${source.qitemId}`,
    });
    expect(row.lastNudgeResult).toMatch(/^unroutable:/);
    const first = await runSweep();
    expect(first.result.outcome).toBe("findings");
    expect(first.status.snapshot()).toMatchObject({ lastOutcome: "findings", lastError: null });
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.evidenceRef).toBe(`rig queue show ${row.qitemId}`);
    expect(repo.getById(finding.evidenceRef!.slice("rig queue show ".length))?.body).toBe(row.body);
    expect(finding.destinationSession).toBe(destinationSession);
    expect(finding.lastNudgeResult).toMatch(/^unroutable:/);
    expect(sent).toEqual([]);

    expect((await runSweep()).result.findings).toContainEqual(expect.objectContaining({ findingQitemId: finding.qitemId, action: "refreshed" }));
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
    await repo.update({ qitemId: row.qitemId, actorSession: row.sourceSession, state: "done", closureReason: "no-follow-on", transitionNote: "fixture resolved" });
    expect((await runSweep()).result.findings).toContainEqual(expect.objectContaining({ findingQitemId: finding.qitemId, action: "closed" }));
    expect(repo.getById(finding.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });

    await expect(repo.create({ sourceSession: "sender@r", destinationSession, body: "Missing evidence", summary: "Decision" }))
      .rejects.toMatchObject({ code: "human_route_fields_required" });
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

  it("HOST-QUALIFIED KEY: a foreign successor is classified without a local lookup, for closed source rows", async () => {
    const row = await mkRow();
    const foreign = "qitem-xh-0123456789abcdef@vps-b";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: foreign,
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(foreign);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
  });

  it("IDEMPOTENT REFRESH: three consecutive sweeps over an unresolved finding keep ONE open finding row without manufacturing progress", async () => {
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
    expect(transitions.some((t) => /refresh/i.test(t.transition_note ?? ""))).toBe(false);
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
      state: "done",
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

// #318: a generic close to a seat address (e.g. state=done closure_reason=handed_off_to
// closure_target=next@r) without a linked local successor must be swept as a dangling closure.
// Transactional handoffs (which atomically create linked successors) and explicit repairs
// (creating a linked successor or reopening) are respected and not flagged / auto-close the finding.
describe("#318 seat-target handoff closure without successor", () => {
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

  it("GENERIC SEAT-TARGET CLOSE WITHOUT SUCCESSOR: swept as dangling-closure with successor-verification-required", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });

    const { result } = await runSweep();
    expect(result.outcome).toBe("findings");
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!).toMatchObject({
      state: "pending",
      destinationSession: "worker@r",
    });
    expect(findings[0]!.summary).toContain("successor-verification-required");
    expect(findings[0]!.body).toContain("- next@r");
    expect(findings[0]!.body).toContain("OPENRIG_URL=<registered-host> rig queue list --destination next@r");
    expect(findings[0]!.body).toContain("custody-verified: <target>");
    expect(findings[0]!.tags).toContain(`stuck-sweep:dangling-closure:${row.qitemId}`);
  });

  it("TRANSACTIONAL HANDOFF: repo.handoff to a seat target creates linked successor in same txn — zero findings", async () => {
    const row = await mkRow();
    await repo.handoff({
      qitemId: row.qitemId,
      fromSession: "worker@r",
      toSession: "next@r",
      nudge: false,
    });

    const { result } = await runSweep();
    expect(result.outcome).toBe("clean");
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("TRANSACTIONAL HANDOFF-AND-COMPLETE: repo.handoffAndComplete to a seat target creates linked successor in same txn — zero findings", async () => {
    const row = await mkRow();
    await repo.handoffAndComplete({
      qitemId: row.qitemId,
      fromSession: "worker@r",
      toSession: "next@r",
      nudge: false,
    });

    const { result } = await runSweep();
    expect(result.outcome).toBe("clean");
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("EXPLICIT SUCCESSOR WITH LINEAGE: successor created with chainOfRecord before generic close is not flagged", async () => {
    const row = await mkRow();
    await repo.create({
      sourceSession: "worker@r",
      destinationSession: "next@r",
      body: "follow-on",
      chainOfRecord: [row.qitemId],
      nudge: false,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });

    const { result } = await runSweep();
    expect(result.outcome).toBe("clean");
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("UNRELATED ITEM FOR SAME SEAT DOES NOT SUPPRESS: row for next@r without lineage to source leaves it flagged", async () => {
    const row = await mkRow();
    await repo.create({
      sourceSession: "other@r",
      destinationSession: "next@r",
      body: "unrelated obligation",
      nudge: false,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });

    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain("- next@r");
  });

  it("REMOTE CUSTODY NOTE SILENCES SEAT TARGET: custody-verified note on source row prevents finding", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: "custody-verified: next@r confirmed on parent host via OPENRIG_URL read",
    });

    const { result } = await runSweep();
    expect(result.outcome).toBe("clean");
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("DISPOSITION AUTO-CLOSES OPEN FINDING: remote verification note appended after finding mints auto-resolves on next sweep", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    await runSweep();
    const open = (await findingsFor(row.qitemId))[0]!;
    expect(open.state).toBe("pending");

    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: "custody-verified: next@r confirmed on remote host",
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

  it("LOCAL REPAIR BY CREATING SUCCESSOR: creating linked successor auto-resolves open finding on next sweep", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);

    await repo.create({
      sourceSession: "worker@r",
      destinationSession: "next@r",
      chainOfRecord: [row.qitemId],
      body: "repaired successor",
      nudge: false,
    });
    const next = await runSweep();
    expect(next.result.findings).toContainEqual(expect.objectContaining({
      kind: "dangling-closure",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]!.state).toBe("done");
  });

  it("LOCAL REPAIR BY REOPEN: reopening source row auto-resolves open finding on next sweep", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);

    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "in-progress",
      reopen: true,
      transitionNote: "reopened to repair missing successor",
    });
    const next = await runSweep();
    expect(next.result.findings).toContainEqual(expect.objectContaining({
      kind: "dangling-closure",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]!.state).toBe("done");
  });

  it("MIXED COMMA FAN-OUT WITH SEAT TARGET: reports only unresolved seat member when one member has successor", async () => {
    const row = await mkRow();
    await repo.create({
      sourceSession: "worker@r",
      destinationSession: "local-valid@r",
      chainOfRecord: [row.qitemId],
      body: "local valid",
      nudge: false,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "local-valid@r,missing-seat@r",
    });

    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain("- missing-seat@r");
    expect(findings[0]!.body).not.toContain("- local-valid@r");
  });

  it("SKIP HANDED-OFF ROWS: a row with state 'handed-off' is skipped by the sweep even without a successor", async () => {
    const row = await mkRow();
    db.prepare(
      "UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', closure_target = 'next@r' WHERE qitem_id = ?"
    ).run(row.qitemId);

    const { result } = await runSweep();
    expect(result.outcome).toBe("clean");
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("UPGRADE / RECENT WINDOW: closure outside the custody window gives no finding; closure inside window is flagged", async () => {
    const oldRow = await mkRow();
    await repo.update({
      qitemId: oldRow.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    // Age oldRow to 48 hours ago (outside 24h default window)
    const oldTime = new Date(Date.now() - 48 * 3_600_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(oldTime, oldRow.qitemId);

    const recentRow = await mkRow();
    await repo.update({
      qitemId: recentRow.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    // Age recentRow to 2 hours ago (inside 24h window)
    const recentTime = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(recentTime, recentRow.qitemId);

    const { result } = await runSweep();
    expect(result.outcome).toBe("findings");
    expect(await findingsFor(oldRow.qitemId)).toHaveLength(0);
    expect(await findingsFor(recentRow.qitemId)).toHaveLength(1);
  });

  it("UPGRADE / RECENT WINDOW: custodyWindowHours in deps configures the scan window", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    const pastTime = new Date(Date.now() - 36 * 3_600_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(pastTime, row.qitemId);

    // Outside default 24h window -> clean
    const sweepDefault = await runSweep();
    expect(sweepDefault.result.outcome).toBe("clean");
    expect(await findingsFor(row.qitemId)).toHaveLength(0);

    // Inside custom 48h window -> flagged
    const sweepCustom = await runSweep({ custodyWindowHours: 48 });
    expect(sweepCustom.result.outcome).toBe("findings");
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("UPGRADE / RECENT WINDOW: open finding remains active and monitored after window elapses until resolved", async () => {
    const row = await mkRow();
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: "next@r",
    });
    // First sweep within window creates finding
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.state).toBe("pending");

    // Age row past window (e.g. 30 hours ago)
    const pastTime = new Date(Date.now() - 30 * 3_600_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run(pastTime, row.qitemId);

    // Finding is NOT closed simply because time passed; it is refreshed
    const secondSweep = await runSweep();
    expect(secondSweep.result.findings).toContainEqual(expect.objectContaining({
      kind: "dangling-closure",
      qitemId: row.qitemId,
      action: "refreshed",
    }));
    expect((await findingsFor(row.qitemId))[0]!.state).toBe("pending");

    // Once resolved, it closes
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: "custody-verified: next@r confirmed",
    });
    const thirdSweep = await runSweep();
    expect(thirdSweep.result.findings).toContainEqual(expect.objectContaining({
      kind: "dangling-closure",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]!.state).toBe("done");
  });

  it("RECIPE COMMAND: verificationCommand generates --destination for seat targets", async () => {
    const { mod } = await runSweep();
    expect(mod.verificationCommand("next@r")).toBe("OPENRIG_URL=<registered-host> rig queue list --destination next@r");
    expect(mod.verificationCommand("qitem-123")).toBe("OPENRIG_URL=<registered-host> rig queue show qitem-123");
    expect(mod.verificationCommand("(unspecified)")).toBe("OPENRIG_URL=<registered-host> rig queue list");
  });
});

// #514: an ask already POSTED to a registered human in its current delivery episode is waiting on
// that human, not stuck. The unclaimed net must not raise a finding for it (which would post the
// human a second time), and the waiting view must not promise that sweep.
describe("#514 unclaimed sweep and a pending ask posted to a registered human", () => {
  const OWNER = { entityId: "human-owner", class: "human", displayName: "Owner", address: "human-owner@external",
    connectorBindings: [{ connector: "slack", ref: "U0OWNER", primary: true }], prefs: {} } as unknown as HumanFragment;
  const human = (entityId: string) => ({ entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
    connectorBindings: [], prefs: {} }) as unknown as HumanFragment;
  const ALPHA = human("human-alpha");
  const BETA = human("human-beta");
  // A registered human whose id has no human- prefix: its canonical alias (owner@kernel) cannot carry an intent.
  const PLAIN = human("owner");
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true as const, entities: [OWNER, ALPHA, BETA, PLAIN] }),
      transport: { send: async () => ({ ok: true, verified: true }) },
    });
  });
  afterEach(() => { db.close(); });

  async function ask(destinationSession = "human-owner@external"): Promise<QueueItem> {
    return repo.create({ sourceSession: "asker@r", destinationSession, body: "Pick option A or B", summary: "A or B?",
      evidenceRef: "rig queue show qitem-fixture", humanIntent: "decision" } as never);
  }
  const currentKey = (id: string) => `${id}:${repo.transitionLog.latestOwnerNotificationForQitem(id)!.transitionId}`;
  const receipt = (id: string, kind: "posted" | "transport-failed", key = currentKey(id)) => repo.update({
    qitemId: id, actorSession: "daemon@kernel",
    transitionNote: `slack-owner-notification-${kind} notification_key=${key} level=ALERT ${kind === "posted" ? "message_ts=1.2" : "detail=http-500"}`,
  });
  /** Fixture aging of existing facts: the row and every transition move back by `minutes`. */
  function age(id: string, minutes = 61): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, id);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, id);
  }
  async function sweep() {
    const mod = await sweepMod();
    return mod.runStuckSweep({ db, queueRepo: repo, status: mod.createStuckSweepStatus(), resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false });
  }
  async function findingsFor(qitemId: string): Promise<QueueItem[]> {
    const mod = await sweepMod();
    return repo.list({ limit: 500 }).filter((i) => (i.tags ?? []).includes(mod.STUCK_SWEEP_FINDING_TAG)
      && (i.tags ?? []).some((t) => t.endsWith(`:${qitemId}`)));
  }

  // human-owner@kernel is the registry alias form (canonical member name = entity id).
  it.each(["human-owner@external", "human-owner@kernel"])("a %s ask with a POSTED receipt for its current episode gets no finding and stays the human's open decision", async (destination) => {
    const row = await ask(destination);
    receipt(row.qitemId, "posted");
    age(row.qitemId);
    await sweep();
    expect(await findingsFor(row.qitemId)).toEqual([]);
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", sourceSession: "asker@r", destinationSession: destination });
    expect(repo.listAttention({ destinationSession: destination }).map((i) => i.qitemId)).toContain(row.qitemId);
  });

  it.each(["human-owner@external", "human-owner@kernel"])("the waiting view of a POSTED %s ask does not promise the unclaimed sweep", async (destination) => {
    const row = await ask(destination);
    receipt(row.qitemId, "posted");
    age(row.qitemId);
    const backstop = repo.waitingView(row.qitemId)!.nextBackstop;
    expect(backstop.mechanism).not.toContain("queue-stuck-sweep:unclaimed");
    expect(backstop).toMatchObject({ owner: destination, dueAt: null, intervalSeconds: null });
  });

  it("an agent's unclaimed row still gets its finding, and its waiting view still names the sweep", async () => {
    const row = await repo.create({ sourceSession: "asker@r", destinationSession: "worker@r", body: "work" });
    age(row.qitemId);
    expect(repo.waitingView(row.qitemId)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:unclaimed");
    await sweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it.each(["never-posted", "transport-failed"] as const)("a %s human ask keeps its existing finding", async (outcome) => {
    const row = await ask();
    if (outcome === "transport-failed") receipt(row.qitemId, "transport-failed");
    age(row.qitemId);
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe(outcome);
    expect(repo.waitingView(row.qitemId)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:unclaimed");
    await sweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("a posted-looking note on an ask with no current human episode (unregistered @external) does not suppress the finding", async () => {
    const row = await ask("stranger@external");
    expect(repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)).toBeFalsy();
    receipt(row.qitemId, "posted", `${row.qitemId}:0`);
    age(row.qitemId);
    // deliveryOutcomeFor keeps its legacy row-scoped fallback; that is not a current human episode.
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("posted");
    expect(repo.humanNotificationPostedThisEpisode(row.qitemId)).toBe(false);
    await sweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("a POSTED receipt for an earlier episode cannot suppress a newer, unposted one (the predicate and view pin it; the finding may be either half's)", async () => {
    const row = await ask();
    receipt(row.qitemId, "posted");
    const firstKey = currentKey(row.qitemId);
    await repo.update({ qitemId: row.qitemId, actorSession: "asker@r", state: "blocked", blockedOn: "human-owner@external",
      transitionNote: "parked on the owner" } as never);
    await repo.update({ qitemId: row.qitemId, actorSession: "asker@r", state: "pending", transitionNote: "back to pending" } as never);
    expect(currentKey(row.qitemId)).not.toBe(firstKey);
    age(row.qitemId);
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("never-posted");
    // The finding below may come from the undelivered half; the episode scoping itself is pinned here.
    expect(repo.humanNotificationPostedThisEpisode(row.qitemId)).toBe(false);
    expect(repo.waitingView(row.qitemId)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:unclaimed");
    await sweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("an open finding for an ask that is later POSTED closes through the normal path; the ask stays open", async () => {
    const row = await ask();
    age(row.qitemId);
    await sweep();
    const [finding] = await findingsFor(row.qitemId);
    expect(finding).toBeDefined();
    receipt(row.qitemId, "posted");
    const second = await sweep();
    expect(second.findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "closed" }));
    expect(repo.getById(finding!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", destinationSession: "human-owner@external" });
  });

  const unclaimedFinding = async (qitemId: string) => (await findingsFor(qitemId))
    .filter((f) => (f.tags ?? []).includes(`stuck-sweep:unclaimed-obligation:${qitemId}`));

  it("a registered alias without an intent (owner@kernel) is suppressed like its @external address", async () => {
    const row = await repo.create({ sourceSession: "asker@r", destinationSession: "owner@kernel", body: "Pick option A or B",
      summary: "A or B?", evidenceRef: "rig queue show qitem-fixture" });
    receipt(row.qitemId, "posted");
    age(row.qitemId);
    expect(repo.humanNotificationPostedThisEpisode(row.qitemId)).toBe(true);
    await sweep();
    expect(await findingsFor(row.qitemId)).toEqual([]);
  });

  // F1 (review-r2): the latest delivery episode describes a resolution notice, not an unanswered ask to the destination.
  it("an agent's row claimed, parked on a human, resolved with a POSTED notice, then unclaimed keeps its unclaimed finding", async () => {
    const row = await repo.create({ sourceSession: "asker@r", destinationSession: "worker@r", body: "work" });
    const id = row.qitemId;
    repo.claim({ qitemId: id, destinationSession: "worker@r" });
    await repo.update({ qitemId: id, actorSession: "worker@r", state: "blocked", blockedOn: "human-owner@external",
      transitionNote: "needs a human decision" } as never);
    await repo.update({ qitemId: id, actorSession: "human-owner@external", state: "in-progress",
      ownerNotificationKind: "human-decision-resolved", transitionNote: "decision supplied" } as never);
    receipt(id, "posted");
    repo.unclaim(id, "worker@r", "handing back for pickup");
    age(id);
    expect(repo.getById(id)).toMatchObject({ state: "pending", destinationSession: "worker@r", claimedAt: null });
    expect(repo.humanNotificationPostedThisEpisode(id)).toBe(false);
    expect(repo.waitingView(id)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:unclaimed");
    await sweep();
    expect(await unclaimedFinding(id)).toHaveLength(1);
  });

  // F2 (review-r2): routeToFallback changes the recipient without opening a new notification episode.
  it("a POSTED receipt to alpha does not suppress the obligation after routeToFallback to beta", async () => {
    const row = await ask("human-alpha@external");
    const id = row.qitemId;
    receipt(id, "posted");
    repo.routeToFallback(id, "human-beta@external", "recipient change");
    age(id);
    // The ledger's existing recipient association is unchanged; only the suppression is bound to the recipient.
    expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("posted");
    expect(repo.humanNotificationPostedThisEpisode(id)).toBe(false);
    expect(repo.waitingView(id)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:unclaimed");
    await sweep();
    const findings = await unclaimedFinding(id);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.destinationSession).toBe("human-beta@external");
  });

  it("an ask returned to pending after a POSTED park notice keeps its finding: the park's recipient is not retained", async () => {
    const row = await ask();
    const id = row.qitemId;
    receipt(id, "posted");
    await repo.update({ qitemId: id, actorSession: "asker@r", state: "blocked", blockedOn: "human-owner@external",
      transitionNote: "parked on the owner" } as never);
    receipt(id, "posted");
    await repo.update({ qitemId: id, actorSession: "asker@r", state: "pending", transitionNote: "back to pending" } as never);
    age(id);
    expect(repo.deliveryOutcomeFor(id)?.outcome).toBe("posted");
    expect(repo.humanNotificationPostedThisEpisode(id)).toBe(false);
    expect(repo.waitingView(id)!.nextBackstop.mechanism).toBe("queue-stuck-sweep:unclaimed");
    await sweep();
    expect(await unclaimedFinding(id)).toHaveLength(1);
  });
});
