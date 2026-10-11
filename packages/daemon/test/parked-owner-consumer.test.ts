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
  DELIVERED_PREFIX,
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
  private clock = Date.parse("2026-10-11T00:00:00.000Z");
  private nextId = 1;

  /** One second per transition, so order never depends on the wall clock. */
  private tick(): string { this.clock += 1000; return new Date(this.clock).toISOString(); }

  /** A transition written by someone other than the consumer: a seat's note, or a state change. */
  record(qitemId: string, actorSession: string, state: string, note = "note", ts = this.tick()): void {
    const list = this.transitions.get(qitemId) ?? [];
    list.push({ ts, transitionNote: note, actorSession, state, transitionId: this.nextId++ });
    this.transitions.set(qitemId, list);
  }

  deps(): ParkedOwnerConsumerDeps["rows"] {
    return {
      listTransitions: (q) => [...(this.transitions.get(q) ?? [])],
      appendNote: (q, note) => {
        if (this.terminal.has(q)) return { ok: false };
        const list = this.transitions.get(q) ?? [];
        // The consumer's own notes: system bookkeeping that keeps the row's state.
        list.push({ ts: this.tick(), transitionNote: note, actorSession: "watchdog@system", state: list.at(-1)?.state ?? "in-progress", transitionId: this.nextId++ });
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

  it("emits the stable wake-or-escalate capability name without historical slice shorthand", async () => {
    const result = await makeParkedOwnerConsumerPolicy(
      makeDeps([parkedSeat()], new RowStore()),
    ).evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.message).toContain("wake-or-escalate");
    expect(result.message).toContain("no further wake for these same rows until you update one of them or one changes state");
    expect(result.message).toContain("rig view show held");
    expect(result.message).not.toContain("S01");
    expect(result.message).not.toContain("OPR.0.5.5.1");
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
    // the seat changes what it holds, then re-parks: new ordinal
    store.record(ROW_IDS[0]!, SEAT, "in-progress", "progress note");
    const sent2 = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(sent2.action).toBe("send");
    expect(String(sent2.notes?.["episodeKey"])).toBe(key1.replace(/#1$/, "#2"));
  });

  describe("a repeat for the same set waits for a change in what the seat holds", () => {
    // Each sent wake is reported delivered, as the engine records it; the next pass lands that on the row.
    const harness = () => {
      const store = new RowStore();
      const history: WatchdogHistoryEntry[] = [];
      const wake = async (seat = parkedSeat()) => {
        const result = await makeParkedOwnerConsumerPolicy(makeDeps([seat], store, history)).evaluate(makeJob());
        if (result.action === "send") history.unshift(sentHistory({ episodeKey: String(result.notes?.["episodeKey"]), primaryRow: String(result.notes?.["primaryRow"]) }));
        return result;
      };
      return { store, history, wake, resume: () => wake(parkedSeat({ parked: false })) };
    };
    const skippedWhy = (result: { notes?: Record<string, unknown> }) =>
      ((result.notes?.["skippedSeats"] as Array<{ why: string }> | undefined) ?? []).map((s) => s.why);

    it("an unchanged repeat is skipped: the seat resumed and re-parked with nothing changed", async () => {
      const { store, wake, resume } = harness();
      expect((await wake()).action).toBe("send");
      await resume();
      expect(store.appended.some((a) => a.note.startsWith(DELIVERED_PREFIX))).toBe(true);
      const repeat = await wake();
      expect(repeat.action).toBe("skip");
      expect(skippedWhy(repeat)).toEqual(["unchanged-since-last-wake"]);
      expect(store.appended.filter((a) => a.note.startsWith(RESERVE_PREFIX))).toHaveLength(1);
    });

    it("another seat's note on the row isn't a change", async () => {
      const { store, wake, resume } = harness();
      await wake();
      await resume();
      store.record(ROW_IDS[1]!, SEAT2, "in-progress", "relay from another seat");
      expect(skippedWhy(await wake())).toEqual(["unchanged-since-last-wake"]);
    });

    it("the seat's own note re-arms exactly one wake", async () => {
      const { store, wake, resume } = harness();
      await wake();
      await resume();
      store.record(ROW_IDS[2]!, SEAT, "in-progress", "progress note");
      const second = await wake();
      expect(second.action).toBe("send");
      expect(String(second.notes?.["episodeKey"])).toMatch(/#2$/);
      await resume();
      expect(skippedWhy(await wake())).toEqual(["unchanged-since-last-wake"]);
    });

    it("an owner note in the same millisecond as the reserve still re-arms, by transition order", async () => {
      const { store, wake, resume } = harness();
      const first = await wake();
      const primary = String(first.notes?.["primaryRow"]);
      const reserveTs = store.transitions.get(primary)!.find((t) => t.transitionNote?.startsWith(RESERVE_PREFIX))!.ts;
      store.record(ROW_IDS[1]!, SEAT, "in-progress", "progress note", reserveTs);
      await resume();
      expect((await wake()).action).toBe("send");
    });

    it("a state change by anyone re-arms one wake", async () => {
      const { store, wake, resume } = harness();
      await wake();
      await resume();
      store.record(ROW_IDS[0]!, "queue@system", "pending", "auto-unparked");
      const second = await wake();
      expect(second.action).toBe("send");
      expect(String(second.notes?.["episodeKey"])).toMatch(/#2$/);
    });

    it("a new obligation set wakes as today", async () => {
      const { store, wake, resume } = harness();
      await wake();
      await resume();
      const extra = "qitem-d-0a1b2c3d";
      store.openIds = () => [...ROW_IDS, extra];
      const grown = parkedSeat({ obligations: { items: [...ROW_IDS, extra].map((qitemId) => ({ qitemId, state: "in-progress", summary: null })), held: [] } });
      const result = await wake(grown);
      expect(result.action).toBe("send");
      expect(String(result.notes?.["episodeKey"])).toMatch(/#1$/);
    });

    it("a reserve with no recorded delivery (a stop between reserve and delivery) isn't treated as delivered", async () => {
      const { history, wake, resume } = harness();
      await wake();
      history.length = 0; // the engine never recorded a delivery
      await resume();
      expect((await wake()).action).toBe("send");
    });

    it("a set whose last wake failed or was refused isn't suppressed", async () => {
      const refusal = `Refused: '${SEAT}' is at an interactive prompt (target_needs_input). No text was sent.`;
      for (const reason of ["transport timeout after 5000ms", refusal]) {
        const { history, wake, resume } = harness();
        const first = await wake();
        history[0] = sentHistory({ episodeKey: String(first.notes?.["episodeKey"]), primaryRow: String(first.notes?.["primaryRow"]), deliveryStatus: "failed", deliveryReason: reason });
        await resume();
        expect((await wake()).action).toBe("send");
      }
    });

    it("a view without actor or state can't show a row unchanged, so the repeat is sent", async () => {
      const { store, wake, resume } = harness();
      await wake();
      await resume();
      store.transitions.get(ROW_IDS[0]!)!.push({ ts: "2026-10-11T23:59:59.000Z", transitionNote: "legacy note" });
      expect((await wake()).action).toBe("send");
    });
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
      // As startup.ts maps it.
      listTransitions: (q) => repo.listTransitions(q).map((t) => ({ ts: t.ts, transitionNote: t.transitionNote ?? null, actorSession: t.actorSession, state: t.state, transitionId: t.transitionId })),
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

  it("at the real seam: a resume and re-park with nothing changed skips; the seat's own note re-arms one wake", async () => {
    const qitemId = await mkClaimedRow();
    const items = [{ qitemId, state: "in-progress", summary: null }];
    const history: WatchdogHistoryEntry[] = [];
    const run = async (parked: boolean) => {
      const result = await makeParkedOwnerConsumerPolicy({
        diagnoseRig: () => ({ seats: [parkedSeat({ parked, obligations: { items, held: [] } })] }),
        history: { listForJob: (_j, l) => history.slice(0, l), countForJob: () => history.length },
        rows: realRows(),
      }).evaluate(makeJob());
      if (result.action === "send") history.unshift(sentHistory({ episodeKey: String(result.notes?.["episodeKey"]), primaryRow: qitemId }));
      return result;
    };
    expect((await run(true)).action).toBe("send");
    await run(false); // the delivery lands on the row, and the seat's turn closes the episode "(seat resumed)"
    const repeat = await run(true);
    expect(repeat.action).toBe("skip");
    expect(JSON.stringify(repeat.notes)).toContain("unchanged-since-last-wake");
    repo.update({ qitemId, actorSession: SEAT, transitionNote: "progress" }); // ordered by transition id, not its millisecond
    expect((await run(true)).action).toBe("send");
  });

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

  it("B2 hard check (real-persistence discriminator): consumer failure enters the ladder, SURVIVES the ladder's own generic overwrite, retries to cap, and reaches escalation", async () => {
    const qitemId = await mkClaimedRow();
    // Consumer origin, durably: the FAILED transition note (what the consumer's
    // reconciliation appends) + the initial consumer-prefixed nudge result.
    repo.update({
      qitemId,
      actorSession: "watchdog@system",
      transitionNote: `${FAILED_PREFIX} ${SEAT}|deadbeef00000000#1; transport timeout after 5000ms`,
    });
    repo.recordNudgeAttempt(qitemId, `${NUDGE_FAIL_PREFIX} — transport timeout after 5000ms`);
    const backdate = () => {
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ? WHERE qitem_id = ?").run(
        new Date(Date.now() - 10 * 60_000).toISOString(),
        qitemId,
      );
      db.prepare(
        "UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND (transition_note LIKE 'wake-attempt:%' OR transition_note LIKE 'escalation-rung:%')",
      ).run(new Date(Date.now() - 10 * 60_000).toISOString(), qitemId);
    };
    const mod = await import("../src/domain/queue-wake-ladder.js");
    const calls: string[] = [];
    // The PRODUCTION persistence emulated at the seam: every attempt lands a
    // GENERIC transport failure in last_nudge_result (what the default
    // attemptWake's maybeNudge path writes) — R2's overwrite, exercised live.
    const tick = () =>
      mod.runWakeLadderTick({
        db,
        queueRepo: repo,
        attemptWake: async (q: string, target: string) => {
          calls.push(q);
          const generic = "failed:tmux session not found";
          repo.recordNudgeAttempt(q, generic);
          return generic;
        },
        resolveOrchestrator: () => "orch@r",
        retryIntervalSeconds: 300,
        retryCap: 3,
        unconfirmedWindowMinutes: 30,
        swapGraceSeconds: 180,
        log: () => {},
      } as never);
    backdate();
    await tick(); // entry: consumer prefix selects the row; retry persists GENERIC
    expect(calls.filter((q) => q === qitemId).length).toBe(1);
    expect(repo.getById(qitemId)?.lastNudgeResult).toBe("failed:tmux session not found"); // the overwrite is real
    backdate();
    await tick(); // RE-ENTRY after the overwrite — the durable note keeps eligibility
    expect(calls.filter((q) => q === qitemId).length).toBe(2);
    backdate();
    await tick(); // third attempt reaches the cap
    expect(calls.filter((q) => q === qitemId).length).toBeGreaterThanOrEqual(3);
    backdate();
    await tick(); // past cap: escalation phase must be REACHABLE (rung/exhausted marker)
    const markers = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid")
      .all(qitemId) as Array<{ transition_note: string | null }>;
    const joined = markers.map((m) => m.transition_note ?? "").join("\n");
    expect(joined).toMatch(/escalation-rung:|ladder-exhausted:/);
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
