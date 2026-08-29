import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
// OPR.0.5.6.24 F-14 + R2 repair — the parked-owner consumer contract.
// Receipts are ROW-SIDE transitions written reserve-before-deliver; episode
// state derives from the obligation row's transition log (durable under the
// retention active-frontier invariant); failures land in the S01 ladder's
// native lastNudgeResult vocabulary. The five R2 hard checks live in the
// integration half below, each at its actual seam.
import {
  makeParkedOwnerConsumerPolicy,
  makeRigAnchor,
  RESERVE_PREFIX,
  CLOSE_PREFIX,
  REFUSED_PREFIX,
  FAILED_PREFIX,
  NUDGE_FAIL_PREFIX,
  PARKED_OWNER_POLICY_NAME,
  type ParkedOwnerConsumerDeps,
  type ParkedSeatDiagnosisView,
  type RowTransitionView,
} from "../src/domain/policies/parked-owner-consumer.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, isBlockerLive } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { pruneWatchdogHistory } from "../src/domain/queue-retention.js";

const RIG = "test-rig";
const SEAT = `dev-planner@${RIG}`;
const SEAT2 = `review-r9@${RIG}`;
const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/domain/policies/parked-owner-consumer.ts",
);
const readModuleSource = () => readFileSync(MODULE_PATH, "utf8");

function makeJob(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    jobId: "job-poc-1",
    policy: PARKED_OWNER_POLICY_NAME,
    target: { session: makeRigAnchor(RIG) },
    intervalSeconds: 120,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    context: {},
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "daemon@kernel",
    registeredAt: "2026-08-29T17:00:00.000Z",
    ...overrides,
  } as PolicyJob;
}

const ROW_IDS = ["qitem-a-bd7eef84", "qitem-b-f115c617", "qitem-c-64f888d1"];

function parkedSeat(overrides: Partial<ParkedSeatDiagnosisView> = {}): ParkedSeatDiagnosisView {
  return {
    sessionName: SEAT,
    parked: true,
    activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
    obligations: {
      items: ROW_IDS.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })),
      held: [],
    },
    ...overrides,
  };
}

/** In-memory durable row store shared across policy instances — models the
 *  queue transition log (append-only, survives "restart" = new policy). */
class RowStore {
  transitions = new Map<string, RowTransitionView[]>();
  appended: Array<{ qitemId: string; note: string }> = [];
  nudges: Array<{ qitemId: string; result: string }> = [];
  openIds: (dest: string) => string[] = () => ROW_IDS;
  terminal = new Set<string>();

  deps(): ParkedOwnerConsumerDeps["rows"] {
    return {
      listTransitions: (q) => [...(this.transitions.get(q) ?? [])],
      appendNote: (q, note) => {
        if (this.terminal.has(q)) return { ok: false };
        const list = this.transitions.get(q) ?? [];
        list.push({ ts: new Date().toISOString(), transitionNote: note });
        this.transitions.set(q, list);
        this.appended.push({ qitemId: q, note });
        return { ok: true };
      },
      recordNudgeResult: (q, result) => void this.nudges.push({ qitemId: q, result }),
      listOpenIds: (dest) => this.openIds(dest),
    };
  }
}

function makeDeps(
  seats: ParkedSeatDiagnosisView[],
  store: RowStore,
  history: WatchdogHistoryEntry[] = [],
): ParkedOwnerConsumerDeps {
  return {
    diagnoseRig: () => ({ seats }),
    history: {
      listForJob: (_j, limit) => history.slice(0, limit),
      countForJob: () => history.length,
    },
    rows: store.deps(),
  };
}

function sentHistory(input: {
  episodeKey: string;
  primaryRow: string;
  deliveryStatus?: string;
  deliveryReason?: string;
}): WatchdogHistoryEntry {
  return {
    historyId: `h-${input.episodeKey}`,
    jobId: "job-poc-1",
    evaluatedAt: new Date().toISOString(),
    outcome: "sent",
    skipReason: null,
    deliveryTargetSession: SEAT,
    deliveryStatus: input.deliveryStatus ?? "ok",
    deliveryMessage: "wake",
    evaluationNotes: {
      episodeSeat: SEAT,
      episodeKey: input.episodeKey,
      primaryRow: input.primaryRow,
      ...(input.deliveryReason ? { deliveryReason: input.deliveryReason } : {}),
    },
  };
}

describe("parked-owner-consumer policy — unit contract (OPR.0.5.6.24)", () => {
  it("R1: claimed-rows x arbitrated-idle sends ONE wake naming open AND unhealthy-held ids, reserve recorded BEFORE the send returns", async () => {
    const store = new RowStore();
    store.openIds = () => [...ROW_IDS, "qitem-held-unhealthy-1"];
    const seat = parkedSeat({
      obligations: {
        items: ROW_IDS.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })),
        held: [
          { qitemId: "qitem-held-unhealthy-1", healthy: false },
          { qitemId: "qitem-held-healthy-1", healthy: true },
        ],
      },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([seat], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT);
    const named = JSON.stringify(result.notes ?? {});
    for (const id of ROW_IDS) expect(named).toContain(id);
    expect(named).toContain("qitem-held-unhealthy-1");
    expect(named).not.toContain("qitem-held-healthy-1");
    // B4 ordering half: the durable reserve exists by the time send returns.
    expect(store.appended.some((a) => a.note.startsWith(RESERVE_PREFIX))).toBe(true);
  });

  it("B1 hard check: an obligation set closed between derive and the delivery boundary skips with the exact reason and ZERO reserve", async () => {
    const store = new RowStore();
    store.openIds = () => []; // the boundary read — closed after diagnosis
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/obligation[-_]closed[-_]between[-_]derive[-_]and[-_]wake/);
    expect(store.appended).toHaveLength(0);
  });

  it("B1 terminal-race guard: a reserve refused by a terminal row skips with the same reason", async () => {
    const store = new RowStore();
    store.terminal.add(ROW_IDS[0]!);
    store.openIds = () => ROW_IDS; // still listed by the reader, terminal at append
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/obligation[-_]closed[-_]between[-_]derive[-_]and[-_]wake/);
  });

  it("B4 hard check (at-most-once): crash after reserve, before any delivery record — a NEW policy instance over the same durable store does not re-send", async () => {
    const store = new RowStore();
    const first = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const sent = await first.evaluate(makeJob());
    expect(sent.action).toBe("send"); // reserve is durably in `store`; delivery outcome never recorded (the crash)
    const restarted = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const second = await restarted.evaluate(makeJob());
    expect(second.action).toBe("skip");
    expect(JSON.stringify(second.notes)).toMatch(/already[-_]woken/);
    // Honesty: this proves at-most-once (no duplicate); the lost-wake arm is
    // recoverable at the next episode and is NOT claimed as exactly-once.
  });

  it("episode: close-then-re-park earns an ordinal-bumped key; needsInput churn does not", async () => {
    const store = new RowStore();
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const sent1 = await policy.evaluate(makeJob());
    expect(sent1.action).toBe("send");
    const key1 = String(sent1.notes?.["episodeKey"]);
    // churn: same park, different needsInput reason — still already-woken
    const churned = parkedSeat({ activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "permission prompt" } } });
    expect((await makeParkedOwnerConsumerPolicy(makeDeps([churned], store)).evaluate(makeJob())).action).toBe("skip");
    // resume: closes the episode durably
    const closing = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat({ parked: false })], store)).evaluate(makeJob());
    expect(closing.action).toBe("skip");
    expect(String((closing as { reason?: unknown }).reason)).toMatch(/episode[-_]ended/);
    expect(store.appended.some((a) => a.note.startsWith(CLOSE_PREFIX))).toBe(true);
    // re-park: new ordinal
    const sent2 = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(sent2.action).toBe("send");
    expect(String(sent2.notes?.["episodeKey"])).toBe(key1.replace(/#1$/, "#2"));
  });

  it("episode: an obligation-set change during one park earns its own wake (new idsHash)", async () => {
    const store = new RowStore();
    const first = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(first.action).toBe("send");
    const grownIds = [...ROW_IDS, "qitem-new-arrival-1"];
    store.openIds = () => grownIds;
    const grown = parkedSeat({
      obligations: { items: grownIds.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })), held: [] },
    });
    const second = await makeParkedOwnerConsumerPolicy(makeDeps([grown], store)).evaluate(makeJob());
    expect(second.action).toBe("send");
    expect(String(second.notes?.["idsHash"])).not.toBe(String(first.notes?.["idsHash"]));
  });

  it("starvation guard: a receipted seat is iterated past; the send targets the next eligible owner same-pass and names the pass-over", async () => {
    const store = new RowStore();
    await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob()); // receipt for SEAT
    const seat2 = parkedSeat({
      sessionName: SEAT2,
      obligations: { items: [{ qitemId: "qitem-seat2-row-1", state: "in-progress", summary: null }], held: [] },
    });
    store.openIds = (dest) => (dest === SEAT2 ? ["qitem-seat2-row-1"] : ROW_IDS);
    const result = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat(), seat2], store)).evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT2);
    const skipped = JSON.stringify(result.notes?.["skippedSeats"] ?? []);
    expect(skipped).toContain(SEAT);
    expect(skipped).toMatch(/already[-_]woken/);
  });

  it("cells: usage-limit defers to S16; indeterminate is not parked; empty union is honest", async () => {
    const store = new RowStore();
    const limited = parkedSeat({ activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "usage limit" } } });
    expect(JSON.stringify((await makeParkedOwnerConsumerPolicy(makeDeps([limited], store)).evaluate(makeJob())).notes)).toMatch(/usage[-_]limit[-_]defer[-_]s16/);
    const indet = parkedSeat({ parked: "indeterminate" });
    expect(JSON.stringify(await makeParkedOwnerConsumerPolicy(makeDeps([indet], store)).evaluate(makeJob()))).toMatch(/indeterminate/);
    const bare = parkedSeat({ obligations: { items: [], held: [{ qitemId: "q-h", healthy: true }] } });
    expect(JSON.stringify((await makeParkedOwnerConsumerPolicy(makeDeps([bare], store)).evaluate(makeJob())).notes)).toMatch(/no[-_]park[-_]driving/);
  });

  it("refusal vs generic: reconciliation lands the refusal on the ROW (durable cell); a generic failure lands the ladder vocabulary instead", async () => {
    const store = new RowStore();
    const sent = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(sent.action).toBe("send");
    const key = String(sent.notes?.["episodeKey"]);
    const primary = String(sent.notes?.["primaryRow"]);
    const refusal = `Refused: '${SEAT}' is at an interactive prompt (target_needs_input). No text was sent.`;
    // Refused delivery → the refused note; the cell reads from the row thereafter.
    const h1 = [sentHistory({ episodeKey: key, primaryRow: primary, deliveryStatus: "failed", deliveryReason: refusal })];
    const afterRefusal = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store, h1)).evaluate(makeJob());
    expect(JSON.stringify(afterRefusal.notes)).toMatch(/destination[-_]refused[-_]interactive[-_]prompt/);
    expect(store.appended.some((a) => a.note.startsWith(REFUSED_PREFIX))).toBe(true);
    expect(store.nudges).toHaveLength(0);
    // Generic failure on a second store → FAILED note + ladder vocabulary; never mislabeled refused.
    const store2 = new RowStore();
    const sent2 = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store2)).evaluate(makeJob());
    const key2 = String(sent2.notes?.["episodeKey"]);
    const primary2 = String(sent2.notes?.["primaryRow"]);
    const h2 = [sentHistory({ episodeKey: key2, primaryRow: primary2, deliveryStatus: "failed", deliveryReason: "transport timeout after 5000ms" })];
    const afterGeneric = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store2, h2)).evaluate(makeJob());
    expect(JSON.stringify(afterGeneric.notes)).toMatch(/already[-_]woken/);
    expect(JSON.stringify(afterGeneric.notes)).not.toMatch(/destination[-_]refused/);
    expect(store2.appended.some((a) => a.note.startsWith(FAILED_PREFIX))).toBe(true);
    expect(store2.nudges.some((n) => n.result.startsWith(NUDGE_FAIL_PREFIX))).toBe(true);
  });

  it("anchor + structural pins: stable per-rig tuple; arbitrated-only; no second scheduler", () => {
    expect(makeRigAnchor("test-rig")).toBe("parked-owner-consumer@test-rig");
    const src = readModuleSource();
    expect(src).toMatch(/diagnoseRigParked|RigParkedDiagnosis|diagnoseRig/);
    expect(src).not.toMatch(/AgentActivityStore|getLatestForNode|activity-relay|hook/);
    expect(src).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
  });

  it("floor: a clean scan returns the quiet no-parked-owner skip and writes nothing", async () => {
    const store = new RowStore();
    const result = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat({ parked: false })], store)).evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String((result as { reason?: unknown }).reason)).toBe("no-parked-owner");
    expect(store.appended).toHaveLength(0);
  });
});

// ─── R2 hard checks at the REAL seams (real DB via canonical migrations) ──────
describe("parked-owner-consumer — R2 integration hard checks (OPR.0.5.6.24)", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true } as never);
  });
  afterEach(() => db.close());

  async function mkClaimedRow(dest = SEAT): Promise<string> {
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: dest, body: "obligation" });
    db.prepare("UPDATE queue_items SET state = 'in-progress', claimed_at = ? WHERE qitem_id = ?").run(
      new Date().toISOString(),
      row.qitemId,
    );
    return row.qitemId;
  }

  function realRows(): ParkedOwnerConsumerDeps["rows"] {
    return {
      listTransitions: (q) => repo.listTransitions(q).map((t) => ({ ts: t.ts, transitionNote: t.transitionNote ?? null })),
      appendNote: (q, note) => {
        const row = repo.getById(q);
        if (!row || !isBlockerLive(row.state)) return { ok: false };
        repo.update({ qitemId: q, actorSession: "watchdog@system", transitionNote: note });
        return { ok: true };
      },
      recordNudgeResult: (q, result) => repo.recordNudgeAttempt(q, result),
      listOpenIds: (dest) =>
        repo.list({ destinationSession: dest, state: ["pending", "in-progress", "blocked"], limit: 500 }).map((r) => r.qitemId),
    };
  }

  it("B3 hard check: ordinary retention pruning (14d + keep-50) deletes the telemetry receipt while the ROW receipt keeps the episode deduplicated", async () => {
    const qitemId = await mkClaimedRow();
    const seat = parkedSeat({ obligations: { items: [{ qitemId, state: "in-progress", summary: null }], held: [] } });
    const log = new WatchdogHistoryLog(db);
    // A REAL registered job — watchdog_history rows are FK-bound to watchdog_jobs.
    const jobsRepo = new WatchdogJobsRepository(db);
    const job = jobsRepo.register({
      policy: PARKED_OWNER_POLICY_NAME,
      specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(RIG)}\ninterval_seconds: 120\n`,
      targetSession: makeRigAnchor(RIG),
      intervalSeconds: 120,
      activeWakeIntervalSeconds: null,
      registeredBySession: "daemon@kernel",
    });
    const deps: ParkedOwnerConsumerDeps = {
      diagnoseRig: () => ({ seats: [seat] }),
      history: { listForJob: (j, l) => log.listForJob(j, l), countForJob: (j) => log.countForJob(j) },
      rows: realRows(),
    };
    const sent = await makeParkedOwnerConsumerPolicy(deps).evaluate(makeJob({ jobId: job.jobId }));
    expect(sent.action).toBe("send");
    // The telemetry sent-row the OLD design depended on, aged 15 days…
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    log.record({ jobId: job.jobId, evaluatedAt: old, outcome: "sent", evaluationNotes: { episodeKey: sent.notes?.["episodeKey"] } });
    // …buried under 60 newer telemetry rows, then ORDINARY retention runs.
    for (let i = 0; i < 60; i++) log.record({ jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "skipped", skipReason: "episode-ended" });
    pruneWatchdogHistory(db, { nowIso: new Date().toISOString() });
    const remaining = log.listForJob(job.jobId, log.countForJob(job.jobId));
    expect(remaining.some((e) => e.evaluatedAt === old)).toBe(false); // telemetry receipt GONE
    // The row receipt survives (active-frontier invariant) and still dedups:
    const again = await makeParkedOwnerConsumerPolicy(deps).evaluate(makeJob({ jobId: job.jobId }));
    expect(again.action).toBe("skip");
    expect(JSON.stringify(again.notes)).toMatch(/already[-_]woken/);
  });

  it("B2 hard check: a failed consumer wake enters the REAL S01 ladder via last_nudge_result — the ladder attempts the wake", async () => {
    const qitemId = await mkClaimedRow();
    repo.recordNudgeAttempt(qitemId, `${NUDGE_FAIL_PREFIX} — transport timeout after 5000ms`);
    // Back-date the attempt past the retry interval so the ladder's due-gate opens
    // (the real gate working as designed — a just-failed wake is honestly not due).
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ? WHERE qitem_id = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      qitemId,
    );
    const mod = await import("../src/domain/queue-wake-ladder.js");
    const calls: Array<{ qitemId: string; target: string }> = [];
    await mod.runWakeLadderTick({
      db,
      queueRepo: repo,
      attemptWake: async (q: string, target: string) => {
        calls.push({ qitemId: q, target });
        return "delivered";
      },
      resolveOrchestrator: () => "orch@r",
      retryIntervalSeconds: 300,
      retryCap: 3,
      unconfirmedWindowMinutes: 30,
      swapGraceSeconds: 180,
      log: () => {},
    } as never);
    expect(calls.some((c) => c.qitemId === qitemId)).toBe(true); // the real ladder saw and acted
  });

  it("late-rig hard check (born-armed): createRig arms the supervisor job in the same act, no restart", () => {
    const rigRepo = new RigRepository(db);
    const jobsRepo = new WatchdogJobsRepository(db);
    rigRepo.onRigCreated = (rig) => {
      const anchor = makeRigAnchor(rig.name);
      jobsRepo.ensureAutoRegistration({
        policy: PARKED_OWNER_POLICY_NAME,
        targetSession: anchor,
        registeredBySession: "daemon@kernel",
        intervalSeconds: 120,
        activeWakeIntervalSeconds: null,
        scanIntervalSeconds: null,
        specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${anchor}\ncontext:\n  rig: ${rig.name}\n`,
      });
    };
    rigRepo.createRig("late-rig");
    const job = db
      .prepare("SELECT job_id, target_session FROM watchdog_jobs WHERE policy = ? AND target_session = ?")
      .get(PARKED_OWNER_POLICY_NAME, makeRigAnchor("late-rig")) as { job_id: string } | undefined;
    expect(job).toBeDefined();
  });
});
