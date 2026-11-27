import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { ulid } from "ulid";
// OPR.0.5.6.24 F-14 + R2 repair — the parked-owner consumer contract.
// Current reminders do not depend on old attempt notes. Positive prompt refusal
// and failure history remains available to the real wake-or-escalate ladder.
import {
  makeParkedOwnerConsumerPolicy,
  makeRigAnchor,
  RESERVE_PREFIX,
  CLOSE_PREFIX,
  DELIVERED_PREFIX,
  ESCALATED_PREFIX,
  REFUSED_PREFIX,
  FAILED_PREFIX,
  openPromptRefusals,
  currentParkedOwnerNoInputFailure,
  NUDGE_FAIL_PREFIX,
  PARKED_OWNER_POLICY_NAME,
  parkedOwnerSpecYaml,
  intervalWords,
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
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
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

  /** Every row starts with a stated transition, as the repository writes one at creation. */
  constructor() { for (const id of ROW_IDS) this.record(id, SEAT, "in-progress", "claimed"); }

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
  occupantGeneration: (sessionName: string) => string | null = () => "gen-1",
): ParkedOwnerConsumerDeps {
  return {
    diagnoseRig: () => ({ seats }),
    history: {
      listForJob: (_j, limit) => history.slice(0, limit),
      countForJob: () => history.length,
      // As the real log reads it: the newest typed-and-submitted send to this occupant.
      latestAcceptedSendTo: (_j, target, generation) =>
        history.find((e) => e.deliveryTargetSession === target && e.outcome === "sent" && e.deliveryStatus === "ok"
          && e.evaluationNotes?.["deliveryFact"] === "accepted" && e.evaluationNotes?.["occupantGeneration"] === generation) ?? null,
    },
    rows: store.deps(),
    occupantGeneration,
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
    // As the engine records an attempt: only a delivered one reads sent.
    outcome: (input.deliveryStatus ?? "ok") === "ok" ? "sent"
      : input.deliveryReason?.startsWith("Refused:") && input.deliveryReason.includes("interactive prompt") ? "refused" : "failed",
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
    expect(result.message).toContain("After a recorded delivery to this occupant");
    expect(result.message).not.toContain("won't wake you again");
    expect(result.message).toContain("for a claimed in-progress row, the wake-or-escalate ladder also retries a failed wake");
    expect(result.message).not.toContain("handles a wake that failed to deliver");
    expect(result.message).toContain("rig view show held");
    expect(result.message).not.toContain("S01");
    expect(result.message).not.toContain("OPR.0.5.5.1");
  });

  it("a no-longer-parked episode closure does not claim that its agent resumed", async () => {
    const store = new RowStore();
    await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()],store)).evaluate(makeJob());
    await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat({parked:false})],store)).evaluate(makeJob());
    const closed = store.appended.filter(x => x.note.startsWith(CLOSE_PREFIX));
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every(x => x.note.includes("no longer observed parked"))).toBe(true);
    expect(closed.some(x => x.note.includes("seat resumed"))).toBe(false);
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
    let reads = 0;
    store.openIds = () => ++reads === 1 ? ROW_IDS : ROW_IDS.slice(1); // the fresh reread sees the primary row close
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/obligation[-_]closed[-_]between[-_]derive[-_]and[-_]wake/);
  });

  describe("a repeat for the same set waits for a change in what the seat holds", () => {
    // Each sent wake is reported delivered, as the engine records it; the next pass lands that on the row.
    const harness = () => {
      const store = new RowStore();
      const history: WatchdogHistoryEntry[] = [];
      let generation: string | null = "gen-1";
      const wake = async (seat = parkedSeat()) => {
        const result = await makeParkedOwnerConsumerPolicy(makeDeps([seat], store, history, () => generation)).evaluate(makeJob());
        if (result.action === "send") history.unshift(sentHistory({ episodeKey: String(result.notes?.["episodeKey"]), primaryRow: String(result.notes?.["primaryRow"]) }));
        return result;
      };
      const occupant = (next: string | null) => { generation = next; };
      return { store, history, wake, occupant, resume: () => wake(parkedSeat({ parked: false })) };
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
      expect(String(second.notes?.["episodeKey"])).toContain("#");
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
      expect(String(second.notes?.["episodeKey"])).toContain("#");
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
      expect(String(result.notes?.["episodeKey"])).toContain("#");
    });

    it("a row handed to a new owner (same set) gets the new owner's first wake", async () => {
      const { wake, resume } = harness();
      await wake();
      await resume(); // the old owner's wake was delivered and its episode closed
      const handedOver = parkedSeat({ sessionName: SEAT2 });
      expect((await wake(handedOver)).action).toBe("send");
    });

    it("a fallback while the old owner's episode is still open gives the new owner its wake", async () => {
      const { wake } = harness();
      expect((await wake()).action).toBe("send"); // the old owner stays parked: its episode stays open
      const handedOver = await wake(parkedSeat({ sessionName: SEAT2 }));
      expect(handedOver.action).toBe("send");
      expect(String(handedOver.notes?.["episodeKey"]).startsWith(`${SEAT2}|`)).toBe(true);
    });

    it("a new occupant at the same seat gets its first wake; the same occupant stays suppressed", async () => {
      const { wake, resume, occupant } = harness();
      await wake();
      await resume();
      expect(skippedWhy(await wake())).toEqual(["unchanged-since-last-wake"]);
      occupant("gen-2"); // a handover, fresh launch or restore keeps the session name and writes nothing on the rows
      await resume();
      expect((await wake()).action).toBe("send");
      await resume();
      expect(skippedWhy(await wake())).toEqual(["unchanged-since-last-wake"]);
    });

    it("a new occupant isn't held by the previous occupant's open episode", async () => {
      const { wake, occupant } = harness();
      await wake();
      occupant("gen-2");
      expect((await wake()).action).toBe("send");
    });

    it("an unknown generation cannot prove the same occupant, so an open attempt does not veto a repeat", async () => {
      const { store, wake, resume, occupant } = harness();
      occupant(null);
      await wake();
      expect(store.appended.find((a) => a.note.startsWith(RESERVE_PREFIX))?.note).not.toContain("generation");
      expect((await wake()).action).toBe("send");
      await resume();
      expect((await wake()).action).toBe("send");
      await resume();
      occupant("gen-1"); // a wake recorded without a generation doesn't count for a known occupant
      expect((await wake()).action).toBe("send");
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

    it("a state with no baseline state before the reserve counts as a change", async () => {
      const { store, wake, resume } = harness();
      store.transitions.set(ROW_IDS[1]!, [{ ts: "2026-10-10T23:59:59.000Z", transitionNote: "created" }]);
      await wake();
      await resume();
      store.record(ROW_IDS[1]!, SEAT2, "pending", "state change by another seat");
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
    expect(afterRefusal.action).toBe("skip");
    expect(JSON.stringify(afterRefusal.notes)).toContain("destination-refused-interactive-prompt");
    expect(afterRefusal.notes?.["skippedSeats"]).toMatchObject([{ seat: SEAT, why: "destination-refused-interactive-prompt",
      primaryRow: primary, obligations: ROW_IDS, episodeKey: key, refusalReason: expect.stringContaining(refusal) }]);
    expect(openPromptRefusals(store.transitions.get(primary) ?? [])).toMatchObject([{ key, ids: ROW_IDS }]);
    expect(store.appended.some((a) => a.note.startsWith(REFUSED_PREFIX))).toBe(true);
    expect(store.nudges).toHaveLength(0);
    // Generic failure on a second store → FAILED note + ladder vocabulary; never mislabeled refused.
    const store2 = new RowStore();
    const sent2 = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store2)).evaluate(makeJob());
    const key2 = String(sent2.notes?.["episodeKey"]);
    const primary2 = String(sent2.notes?.["primaryRow"]);
    const h2 = [sentHistory({ episodeKey: key2, primaryRow: primary2, deliveryStatus: "failed", deliveryReason: "transport timeout after 5000ms" })];
    const afterGeneric = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store2, h2)).evaluate(makeJob());
    expect(afterGeneric.action).toBe("send");
    expect(openPromptRefusals(store2.transitions.get(primary2) ?? [])).toEqual([]);
    expect(store2.appended.some((a) => a.note.startsWith(FAILED_PREFIX))).toBe(true);
    expect(store2.nudges.some((n) => n.result.startsWith(NUDGE_FAIL_PREFIX))).toBe(true);
  });

  it("a newer uncertain input is not overwritten by an older failed attempt during reporting", async () => {
    const store = new RowStore();
    const first = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    const key = String(first.notes?.["episodeKey"]), primary = String(first.notes?.["primaryRow"]);
    const latest = sentHistory({ episodeKey: key, primaryRow: primary, deliveryStatus: "failed", deliveryReason: "Text write outcome unconfirmed" });
    latest.evaluationNotes!["deliveryInputPhase"] = "attempted";
    const older = sentHistory({ episodeKey: `${key}-old`, primaryRow: primary, deliveryStatus: "failed", deliveryReason: "transport unavailable" });
    await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store, [latest, older])).evaluate(makeJob());
    expect(store.nudges).toEqual([{ qitemId: primary, result: "indeterminate: parked-owner wake delivery — Text write outcome unconfirmed" }]);
  });

  it("anchor + structural pins: stable per-rig tuple; arbitrated-only; no second scheduler", () => {
    expect(makeRigAnchor("test-rig")).toBe("parked-owner-consumer@test-rig");
    const src = readModuleSource();
    expect(src).toMatch(/diagnoseRigParked|RigParkedDiagnosis|diagnoseRig/);
    expect(src).not.toMatch(/AgentActivityStore|getLatestForNode|activity-relay|hook/);
    expect(src).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
  });

  it("parked owner rotation tries every current owner again without receipt-based starvation", async () => {
    const store = new RowStore(); const history: WatchdogHistoryEntry[] = [];
    for (const target of [SEAT, SEAT2, SEAT, SEAT2]) {
      const result = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat(), parkedSeat({ sessionName: SEAT2 })], store, history)).evaluate(makeJob());
      expect(result.action).toBe("send");
      if (result.action !== "send") return;
      expect(result.target.session).toBe(target);
      history.unshift({ ...sentHistory({ episodeKey: String(result.notes?.["episodeKey"]), primaryRow: String(result.notes?.["primaryRow"]) }), deliveryTargetSession: target, deliveryStatus: "failed" });
    }
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

  it("at the real seam: a recorded delivery waits for change, then the owner note re-arms it", async () => {
    const qitemId = await mkClaimedRow();
    const items = [{ qitemId, state: "in-progress", summary: null }];
    const history: WatchdogHistoryEntry[] = [];
    const run = async (parked: boolean) => {
      const result = await makeParkedOwnerConsumerPolicy({
        diagnoseRig: () => ({ seats: [parkedSeat({ parked, obligations: { items, held: [] } })] }),
        history: { listForJob: (_j, l) => history.slice(0, l), countForJob: () => history.length },
        rows: realRows(),
        occupantGeneration: () => "gen-1",
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

  it("retention pruning cannot turn a current obligation into an already-delivered no-op", async () => {
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
    // The row's old receipt survives, but no longer vetoes the current reminder:
    const again = await makeParkedOwnerConsumerPolicy(deps).evaluate(makeJob({ jobId: job.jobId }));
    expect(again.action).toBe("send");
  });

  it("at the real history log: an owner's last reminder holds its interval behind any number of newer rows", async () => {
    const qitemId = await mkClaimedRow();
    const seat = parkedSeat({ obligations: { items: [{ qitemId, state: "in-progress", summary: null }], held: [] } });
    const log = new WatchdogHistoryLog(db);
    const job = new WatchdogJobsRepository(db).register({
      policy: PARKED_OWNER_POLICY_NAME,
      specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(RIG)}\n`,
      targetSession: makeRigAnchor(RIG),
      intervalSeconds: 120,
      activeWakeIntervalSeconds: null,
      registeredBySession: "daemon@kernel",
    });
    const NOW = Date.now();
    // Recorded now, as the engine records a send once it has returned: the interval runs from here.
    log.record({ jobId: job.jobId, evaluatedAt: new Date(NOW - 10 * 60_000).toISOString(), outcome: "sent",
      deliveryTargetSession: SEAT, deliveryStatus: "ok",
      evaluationNotes: { obligations: ["qitem-earlier"], deliveryFact: "accepted", occupantGeneration: "gen-1" } });
    for (let i = 0; i < 300; i++) {
      log.record({ jobId: job.jobId, evaluatedAt: new Date(NOW - 60_000 + i).toISOString(), outcome: "skipped",
        skipReason: "all-parked-owners-deferred" });
    }
    // Attempts at the same seat that never reached it, newer than the reminder: they don't hide it either.
    for (let i = 0; i < 80; i++) {
      log.record({ jobId: job.jobId, evaluatedAt: new Date(NOW - 5 * 60_000 + i).toISOString(), outcome: "failed",
        deliveryTargetSession: SEAT, deliveryStatus: "failed", evaluationNotes: { obligations: [qitemId] } });
    }
    // Nor do newer sends that don't start an interval: unknown whether submitted, a queue row, another occupant's.
    for (let i = 0; i < 8; i++) {
      log.record({ jobId: job.jobId, evaluatedAt: new Date(NOW - 4 * 60_000 + i).toISOString(), outcome: "sent",
        deliveryTargetSession: SEAT, deliveryStatus: i % 2 === 0 ? "ok" : "queued_as_row",
        evaluationNotes: { obligations: [qitemId], deliveryFact: "unknown", occupantGeneration: "gen-1" } });
      log.record({ jobId: job.jobId, evaluatedAt: new Date(NOW - 3 * 60_000 + i).toISOString(), outcome: "sent",
        deliveryTargetSession: SEAT, deliveryStatus: "ok",
        evaluationNotes: { obligations: [qitemId], deliveryFact: "accepted", occupantGeneration: "gen-0" } });
    }
    const deps: ParkedOwnerConsumerDeps = {
      diagnoseRig: () => ({ seats: [seat] }),
      history: { listForJob: (j, l) => log.listForJob(j, l), countForJob: (j) => log.countForJob(j),
        latestAcceptedSendTo: (j, s, g) => log.latestAcceptedSendTo(j, s, g) },
      rows: realRows(),
      occupantGeneration: () => "gen-1",
      now: () => NOW,
    };
    const held = await makeParkedOwnerConsumerPolicy(deps).evaluate(makeJob({ jobId: job.jobId }));
    expect(held).toMatchObject({ action: "skip", reason: "all-parked-owners-deferred" });
    expect(JSON.stringify(held.notes)).toContain("owner-min-interval");
    const later = await makeParkedOwnerConsumerPolicy({ ...deps, now: () => NOW + 61 * 60_000 })
      .evaluate(makeJob({ jobId: job.jobId }));
    expect(later).toMatchObject({ action: "send", notes: { newSinceLastWake: [qitemId] } });
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

  it.each([{ count: 2, retained: true }, { count: 27, retained: false }])("rotation reaches all $count owners with retained=$retained across a bounded history", async ({ count, retained }) => {
    const names = Array.from({ length: count }, (_, i) => `s${String(i).padStart(2, "0")}@${RIG}`);
    const seats = await Promise.all(names.map(async sessionName => parkedSeat({ sessionName,
      obligations: { items: [{ qitemId: await mkClaimedRow(sessionName), state: "in-progress", summary: null }], held: [] } })));
    const jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db);
    const job = jobs.register({ policy: PARKED_OWNER_POLICY_NAME, targetSession: makeRigAnchor(RIG), intervalSeconds: 120,
      registeredBySession: SEAT, specYaml: "interval_seconds: 120\n" });
    const policy = makeParkedOwnerConsumerPolicy({ diagnoseRig: () => ({ seats }), rows: realRows(), history,
      occupantGeneration: () => null }); // unknown occupant never proves a prior ok reached this occupant
    const targets: string[] = [];
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db), additionalPolicies: [policy],
      deliver: async ({ targetSession }) => { targets.push(targetSession); return retained ? { status: "retained" } : { status: "ok" }; } });
    for (let i = 0; i < count + 1; i++) await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
    expect(targets).toEqual([...names, names[0]]);
    if (retained) expect(history.listForJob(job.jobId, 1)[0]).toMatchObject({ outcome: "skipped", deliveryStatus: "retained" });
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

// #1933 — a seat that just handed work off, or just asked a person, has only started waiting. The first reminder
// waits until its arbitrated waiting state has been unchanged for a grace; a seat still holding the work after it is
// reminded as before, an unknown start keeps the reminder, and a seat at a prompt gets no grace.
describe("a delivered reminder whose rows stay unclaimed reaches someone who can act, once", () => {
  // The rows are pending (never claimed); each sent wake is recorded delivered, as the engine records it.
  const unclaimedSeat = (state = "pending") => parkedSeat({
    obligations: { items: ROW_IDS.map((qitemId) => ({ qitemId, state, summary: null })), held: [] },
  });
  type Escalation = { seat: string; qitemIds: string[]; deliveredAt: string; episodeKey: string };
  const harness = (state = "pending", escalate: (input: Escalation) => Promise<string[]> = async () => [SEAT2]) => {
    const store = new RowStore();
    const history: WatchdogHistoryEntry[] = [];
    const told: Escalation[] = [];
    let now = Date.parse("2026-10-11T00:00:00.000Z");
    const evaluate = async (seat: ParkedSeatDiagnosisView) => {
      const result = await makeParkedOwnerConsumerPolicy({ ...makeDeps([seat], store, history), now: () => now,
        escalateUnclaimed: async (input) => { told.push(input); return escalate(input); } }).evaluate(makeJob());
      if (result.action === "send") history.unshift(sentHistory({ episodeKey: String(result.notes?.["episodeKey"]), primaryRow: String(result.notes?.["primaryRow"]) }));
      return result;
    };
    return { store, told, advance: (ms: number) => { now += ms; },
      wake: () => evaluate(unclaimedSeat(state)), resume: () => evaluate(parkedSeat({ parked: false })) };
  };

  it("escalates once when the delivered reminder is older than the bound and its rows are still pending", async () => {
    const { store, told, advance, wake, resume } = harness();
    const first = await wake();
    expect(first.action).toBe("send");
    await resume();
    advance(14 * 60_000);
    await wake();
    expect(told).toHaveLength(0);
    advance(2 * 60_000);
    const repeat = await wake();
    expect(repeat.action).toBe("skip");
    expect(told).toEqual([{ seat: SEAT, qitemIds: ROW_IDS, episodeKey: String(first.notes?.["episodeKey"]),
      deliveredAt: store.transitions.get(String(first.notes?.["primaryRow"]))!.find((t) => t.transitionNote?.startsWith(DELIVERED_PREFIX))!.ts }]);
    expect(store.appended.filter((a) => a.note.startsWith(ESCALATED_PREFIX)).map((a) => a.note))
      .toEqual([`${ESCALATED_PREFIX} ${String(first.notes?.["episodeKey"])} to ${SEAT2}`]);
    // The seat itself isn't woken again, and its reminder isn't reopened.
    expect(store.appended.filter((a) => a.note.startsWith(RESERVE_PREFIX))).toHaveLength(1);
  });

  it("doesn't escalate rows the seat claimed", async () => {
    const { told, advance, wake, resume } = harness("in-progress");
    await wake();
    await resume();
    advance(30 * 60_000);
    await wake();
    expect(told).toHaveLength(0);
  });

  const failureOf = (result: { notes?: Record<string, unknown> }) =>
    ((result.notes?.["skippedSeats"] as Array<{ escalationFailure?: unknown }> | undefined) ?? []).map((s) => s.escalationFailure).filter(Boolean);

  it("says in the pass's notes when no one can be resolved to tell, marks nothing escalated, and tries again later", async () => {
    const noPerson = Object.assign(new Error("Workflow human fallback needs one registered human"), { code: "no_registered_person" });
    const { store, told, advance, wake, resume } = harness("pending", async () => { throw noPerson; });
    const first = await wake();
    await resume();
    advance(16 * 60_000);
    const failed = await wake();
    expect(failed.action).toBe("skip");
    expect(failureOf(failed)).toEqual([{ episodeKey: String(first.notes?.["episodeKey"]), failure: "no_registered_person" }]);
    expect(store.appended.filter((a) => a.note.startsWith(ESCALATED_PREFIX))).toHaveLength(0);
    await wake();
    expect(told).toHaveLength(2);
  });

  it("records exactly one escalation once a write that failed succeeds on a later pass", async () => {
    let calls = 0;
    const { store, advance, wake, resume } = harness("pending", async () => {
      if (++calls === 1) throw new Error("SQLITE_BUSY: database is locked");
      return [SEAT2];
    });
    await wake();
    await resume();
    advance(16 * 60_000);
    expect(failureOf(await wake())).toEqual([expect.objectContaining({ failure: "Error" })]);
    expect(failureOf(await wake())).toEqual([]);
    await wake();
    expect(calls).toBe(2);
    expect(store.appended.filter((a) => a.note.startsWith(ESCALATED_PREFIX))).toHaveLength(1);
  });

  it("doesn't repeat the escalation on a later tick", async () => {
    const { store, told, advance, wake, resume } = harness();
    await wake();
    await resume();
    advance(16 * 60_000);
    await wake();
    advance(60 * 60_000);
    await wake();
    await wake();
    expect(told).toHaveLength(1);
    expect(store.appended.filter((a) => a.note.startsWith(ESCALATED_PREFIX))).toHaveLength(1);
  });
});

describe("#1933: the first reminder waits a grace after the seat starts waiting", () => {
  const NOW = Date.parse("2026-10-25T03:00:00.000Z");
  const GRACE_MS = 5 * 60_000;
  const waitingFor = (ms: number | null) => parkedSeat({
    activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null }, ...(ms === null ? {} : { since: new Date(NOW - ms).toISOString() }) },
  } as Partial<ParkedSeatDiagnosisView>);
  const evaluate = (seat: ParkedSeatDiagnosisView, store = new RowStore()) =>
    makeParkedOwnerConsumerPolicy({ ...makeDeps([seat], store), now: () => NOW } as ParkedOwnerConsumerDeps).evaluate(makeJob());

  it("a seat that started waiting 30 s ago is not reminded on this tick, and nothing is reserved", async () => {
    const store = new RowStore();
    const ev = await evaluate(waitingFor(30_000), store);
    expect(ev.action).toBe("skip");
    expect((ev as { notes?: { skippedSeats?: unknown } }).notes?.skippedSeats).toEqual([{ seat: SEAT, why: "waiting-grace" }]);
    expect(store.appended).toEqual([]);
  });

  it("a seat still idle with its rows after the grace is reminded as before", async () => {
    const ev = await evaluate(waitingFor(GRACE_MS + 1_000));
    expect(ev.action).toBe("send");
    expect((ev as { target?: { session: string } }).target?.session).toBe(SEAT);
  });

  it("an unknown start of the wait assumes no grace: the reminder still goes", async () => {
    expect((await evaluate(waitingFor(null))).action).toBe("send");
  });

  it("a seat stopped at a prompt 30 s ago is still attempted, so whoever can clear the prompt hears as soon as today", async () => {
    const atPrompt = parkedSeat({
      activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "selection_prompt" }, since: new Date(NOW - 30_000).toISOString() },
    } as Partial<ParkedSeatDiagnosisView>);
    expect((await evaluate(atPrompt)).action).toBe("send");
  });

  it("the grace reaches the consumer from the shipped diagnosis: the arbitrated state's last change is the start of the wait", async () => {
    const { diagnoseRigParked } = await import("../src/domain/parked-query.js");
    const seatState = (changedAt: string) => ({
      seatNodeId: "node-1", activity: "idle-at-prompt" as const, needsInput: { count: 0, reason: null }, needsInputEvidence: null,
      decidedBy: "lifecycle-hooks" as const, seq: 3, changedAt, rungs: [], lastSwap: null,
    });
    const diagnose = (changedAt: string) => diagnoseRigParked({
      getSeatState: () => seatState(changedAt),
      listOpenObligations: (_d, limit) => ({ rows: [{ qitemId: ROW_IDS[0]!, state: "in-progress" }], limit }),
    }, [{ seatNodeId: "node-1", sessionName: SEAT }]);
    const run = (changedAt: string) => makeParkedOwnerConsumerPolicy({
      ...makeDeps([], new RowStore()), diagnoseRig: () => diagnose(changedAt) as never, now: () => NOW,
    } as ParkedOwnerConsumerDeps).evaluate(makeJob());
    expect((await run(new Date(NOW - 60_000).toISOString())).action).toBe("skip");
    expect((await run(new Date(NOW - GRACE_MS - 1_000).toISOString())).action).toBe("send");
  });
});


// #2661 (b) — the turn is over but a shell the owner started still runs: no parked reminder within the ceiling.
describe("#2661: a live background shell defers the parked reminder up to its ceiling", () => {
  const NOW = Date.parse("2026-11-07T12:00:00.000Z");
  const CEILING_MS = 60 * 60_000;
  const withShell = (ms: number, needsInput = 0) => parkedSeat({
    activity: { value: "idle-at-prompt", needsInput: { count: needsInput, reason: needsInput ? "selection_prompt" : null },
      since: new Date(NOW - 2 * CEILING_MS).toISOString(), backgroundWork: { observedAt: new Date(NOW - ms).toISOString() } },
  } as Partial<ParkedSeatDiagnosisView>);
  const evaluate = (seat: ParkedSeatDiagnosisView, store = new RowStore()) =>
    makeParkedOwnerConsumerPolicy({ ...makeDeps([seat], store), now: () => NOW } as ParkedOwnerConsumerDeps).evaluate(makeJob());

  it("a seat whose shell started 20 min ago is not reminded, and nothing is reserved", async () => {
    const store = new RowStore();
    const ev = await evaluate(withShell(20 * 60_000), store);
    expect(ev.action).toBe("skip");
    expect((ev as { notes?: { skippedSeats?: unknown } }).notes?.skippedSeats).toEqual([{ seat: SEAT, why: "background-shell" }]);
    expect(store.appended).toEqual([]);
  });

  it("past the ceiling the reminder goes, and its evidence names the shell", async () => {
    const ev = await evaluate(withShell(CEILING_MS + 60_000));
    expect(ev.action).toBe("send");
    expect((ev as { notes?: { evidence?: string } }).notes?.evidence).toBe("arbitrated-idle-at-prompt; background-shell-past-ceiling");
  });

  it("a seat at a prompt is still attempted, shell or not", async () => {
    const ev = await evaluate(withShell(60_000, 1));
    expect(ev.action).toBe("send");
    expect((ev as { notes?: { evidence?: string } }).notes?.evidence).toBe("arbitrated-idle-at-prompt");
  });

  it("the shell reaches the consumer from the shipped diagnosis", async () => {
    const { diagnoseRigParked } = await import("../src/domain/parked-query.js");
    const diagnose = (shellAt: string | null) => diagnoseRigParked({
      getSeatState: () => ({
        seatNodeId: "node-1", activity: "idle-at-prompt" as const, needsInput: { count: 0, reason: null }, needsInputEvidence: null,
        backgroundWork: shellAt ? { rung: "self-report" as const, observedAt: shellAt } : null,
        decidedBy: "self-report" as const, seq: 3, changedAt: new Date(NOW - 2 * CEILING_MS).toISOString(), rungs: [], lastSwap: null,
      }),
      listOpenObligations: (_d, limit) => ({ rows: [{ qitemId: ROW_IDS[0]!, state: "in-progress" }], limit }),
    }, [{ seatNodeId: "node-1", sessionName: SEAT }]);
    const run = (shellAt: string | null) => makeParkedOwnerConsumerPolicy({
      ...makeDeps([], new RowStore()), diagnoseRig: () => diagnose(shellAt) as never, now: () => NOW,
    } as ParkedOwnerConsumerDeps).evaluate(makeJob());
    expect((await run(new Date(NOW - 5 * 60_000).toISOString())).action).toBe("skip");
    expect((await run(null)).action).toBe("send");
  });
});

describe("parked reminders after a positive no-input quota rejection", () => {
  const quotaState = "guard-revision-a:100:8192";
  const failedQuota = (result: Awaited<ReturnType<ReturnType<typeof makeParkedOwnerConsumerPolicy>["evaluate"]>>, phase: string | undefined = "not_reached") => {
    const entry = sentHistory({ episodeKey: String(result.notes?.["episodeKey"]), primaryRow: String(result.notes?.["primaryRow"]), deliveryStatus: "failed", deliveryReason: "Held-message quota is full; no input was written." });
    entry.evaluationNotes = { ...entry.evaluationNotes, deliveryCode: "retained_quota_full", ...(phase ? { deliveryInputPhase: phase } : {}) };
    return entry;
  };
  const policy = (store: RowStore, history: WatchdogHistoryEntry[], state = quotaState, terminal = false) =>
    makeParkedOwnerConsumerPolicy({ ...makeDeps([parkedSeat()], store, history), retentionState: () => state, isTerminalSeat: () => terminal } as ParkedOwnerConsumerDeps);

  it("bounds unchanged attempts AND row bookkeeping across restart and history pruning", async () => {
    const store = new RowStore();
    const first = await policy(store, []).evaluate(makeJob());
    expect(first.action).toBe("send");
    const history = [failedQuota(first)];
    const next = await policy(store, history).evaluate(makeJob());
    expect(next).toMatchObject({ action: "skip", notes: { skippedSeats: [{ seat: SEAT, why: "retention-quota-unchanged" }] } });
    const writes = store.appended.length;
    const nudges = store.nudges.length;
    expect(store.nudges[0]?.result).toContain("retained_quota_full");
    expect(store.nudges[0]?.result).toContain("not_reached");
    for (let i = 0; i < 100; i++) {
      expect((await policy(store, i < 50 ? history : []).evaluate(makeJob())).action).toBe("skip");
    }
    expect(store.appended).toHaveLength(writes);
    expect(store.nudges).toHaveLength(nudges);
    expect(nudges).toBe(1);
  });

  it.each(["quota-released", "guard-revision-b:off"])("rechecks admission when %s changes", async state => {
    const store = new RowStore();
    const first = await policy(store, []).evaluate(makeJob());
    const history = [failedQuota(first)];
    expect((await policy(store, history).evaluate(makeJob())).action).toBe("skip");
    const retry = await policy(store, history, state).evaluate(makeJob());
    expect(retry.action).toBe("send");
    const delivered = sentHistory({ episodeKey: String(retry.notes?.["episodeKey"]), primaryRow: String(retry.notes?.["primaryRow"]) });
    expect((await policy(store, [delivered, ...history], state).evaluate(makeJob())).action).toBe("skip");
  });

  it.each([undefined, "attempted", "written"])("does not turn phase %s into positive no-input admission", async phase => {
    const store = new RowStore();
    const first = await policy(store, []).evaluate(makeJob());
    const entry = failedQuota(first, phase);
    if (phase === undefined) delete entry.evaluationNotes!["deliveryInputPhase"];
    expect((await policy(store, [entry]).evaluate(makeJob())).action).toBe("send");
  });

  it("leaves an ordinary transient failure retryable", async () => {
    const store = new RowStore();
    const first = await policy(store, []).evaluate(makeJob());
    const entry = failedQuota(first);
    delete entry.evaluationNotes!["deliveryCode"];
    expect((await policy(store, [entry]).evaluate(makeJob())).action).toBe("send");
  });

  it("records terminal-only custody once without reserving recurring input attempts", async () => {
    const store = new RowStore();
    const first = await policy(store, [], quotaState, true).evaluate(makeJob());
    expect(first).toMatchObject({ action: "skip", notes: { skippedSeats: [{ seat: SEAT, why: "terminal-seat" }] } });
    expect(store.nudges).toHaveLength(1);
    expect(store.nudges[0]?.result).toContain("failed:terminal-seat:");
    expect(store.nudges[0]?.result).toContain("route it to an agent seat");
    const writes = store.appended.length;
    for (let i = 0; i < 100; i++) expect((await policy(store, [], quotaState, true).evaluate(makeJob())).action).toBe("skip");
    expect(store.appended).toHaveLength(writes);
    expect(store.nudges).toHaveLength(1);
    expect((await policy(store, [], quotaState, false).evaluate(makeJob())).action).toBe("send");
  });
});


describe("a queue-only seat and the parked-owner reminder (#3076)", () => {
  const queueOnly = (store: RowStore, q: boolean, history: WatchdogHistoryEntry[] = [], generation = "gen-1") =>
    makeParkedOwnerConsumerPolicy({ ...makeDeps([parkedSeat()], store, history, () => generation), isQueueOnlySeat: () => q } as ParkedOwnerConsumerDeps);

  it("types nothing: its open rows are the reminder, held once per occupant with no nudge result, never a failure", async () => {
    const store = new RowStore();
    const first = await queueOnly(store, true).evaluate(makeJob());
    expect(first).toMatchObject({ action: "skip", notes: { skippedSeats: [{ seat: SEAT, why: "queue-only-seat" }] } });
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.note).toMatch(/^parked-owner wake held: .*; code queue_only_seat; input not_reached;/);
    expect(store.appended[0]!.note.startsWith(FAILED_PREFIX)).toBe(false);
    expect(store.nudges).toEqual([]);
    expect(currentParkedOwnerNoInputFailure(store.deps().listTransitions(store.appended[0]!.qitemId))).toBeNull();
    for (let i = 0; i < 20; i++) expect((await queueOnly(store, true).evaluate(makeJob())).action).toBe("skip");
    expect(store.appended).toHaveLength(1);
    // A new occupant is told once more; nothing is typed to it either.
    expect((await queueOnly(store, true, [], "gen-2").evaluate(makeJob())).action).toBe("skip");
    expect(store.appended).toHaveLength(2);
    expect(store.nudges).toEqual([]);
    // Leaving queue-only, the reminder types as before.
    expect((await queueOnly(store, false).evaluate(makeJob())).action).toBe("send");
  });

  it("through the engine, the held reminder is one history row and one event, not one per scan", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db);
      const job = jobs.register({ policy: PARKED_OWNER_POLICY_NAME, targetSession: makeRigAnchor(RIG), intervalSeconds: 120,
        registeredBySession: SEAT, specYaml: "interval_seconds: 120\n" });
      const store = new RowStore();
      const policy = makeParkedOwnerConsumerPolicy({ ...makeDeps([parkedSeat()], store), history, isQueueOnlySeat: () => true });
      const typed: string[] = [];
      const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db), additionalPolicies: [policy],
        deliver: async ({ targetSession }) => { typed.push(targetSession); return { status: "ok" }; } });
      const events = () => (db.prepare("SELECT count(*) AS n FROM events WHERE type LIKE 'watchdog.evaluation_%'").get() as { n: number }).n;
      for (let i = 0; i < 10; i++) await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
      expect(typed).toEqual([]);
      expect(history.countForJob(job.jobId)).toBe(1);
      expect(events()).toBe(1);
      expect(store.appended).toHaveLength(1);
    } finally { db.close(); }
  });

  it("a no-input failure recorded before the seat turned queue-only is superseded by the held note: no stuck-sweep finding", async () => {
    const store = new RowStore();
    await makeParkedOwnerConsumerPolicy({ ...makeDeps([parkedSeat()], store), isTerminalSeat: () => true }).evaluate(makeJob());
    const row = store.appended[0]!.qitemId;
    expect(currentParkedOwnerNoInputFailure(store.deps().listTransitions(row))).toMatchObject({ code: "terminal_seat" });
    // The seat is now queue-only (and no longer bound to a terminal): its reminder is held, and the old refusal no longer
    // says why input stopped, so the stuck sweep's parked-owner-no-input check finds nothing to report.
    expect((await queueOnly(store, true).evaluate(makeJob())).action).toBe("skip");
    expect(store.appended.at(-1)!.note.startsWith("parked-owner wake held:")).toBe(true);
    expect(currentParkedOwnerNoInputFailure(store.deps().listTransitions(row))).toBeNull();
  });

  it("a bound terminal seat stays a terminal seat at queue-only: refused as one, never held", async () => {
    const store = new RowStore();
    const policy = makeParkedOwnerConsumerPolicy({ ...makeDeps([parkedSeat()], store), isQueueOnlySeat: () => true, isTerminalSeat: () => true });
    expect(await policy.evaluate(makeJob())).toMatchObject({ action: "skip", notes: { skippedSeats: [{ seat: SEAT, why: "terminal-seat" }] } });
    const notes = store.appended.map(({ note }) => note);
    expect(notes.filter(n => n.startsWith(FAILED_PREFIX))).toEqual([expect.stringMatching(/; code terminal_seat; input not_reached;/)]);
    expect(notes.some(n => n.startsWith("parked-owner wake held:"))).toBe(false);
    expect(store.nudges.map(({ result }) => result)).toEqual([expect.stringMatching(/^failed:terminal-seat: /)]);
  });

  it("a reminder decided before the seat turned queue-only is held at delivery: no cold row, and on the row neither delivered nor failed", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const jobs = new WatchdogJobsRepository(db), history = new WatchdogHistoryLog(db);
      const job = jobs.register({ policy: PARKED_OWNER_POLICY_NAME, targetSession: makeRigAnchor(RIG), intervalSeconds: 120,
        registeredBySession: SEAT, specYaml: "interval_seconds: 120\n" });
      const store = new RowStore();
      // The policy still reads the seat as typed; by delivery its guard is at queue-only.
      const level = { queueOnly: false };
      const policy = makeParkedOwnerConsumerPolicy({ ...makeDeps([parkedSeat()], store), history, isQueueOnlySeat: () => level.queueOnly });
      const typed: string[] = [];
      const rows: string[] = [];
      const deliver = makeWatchdogDeliver({ sessionTransport: { send: async (session: string) => { typed.push(session); return { ok: true }; } },
        isQueueOnlySeat: () => true,
        createQueueRow: async (row: { qitemId: string }) => { rows.push(row.qitemId); return { qitemId: row.qitemId, state: "pending" }; } } as never);
      const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db), additionalPolicies: [policy], deliver });
      await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
      expect(typed).toEqual([]);
      expect(rows).toEqual([]);
      expect(history.listForJob(job.jobId, 1)[0]).toMatchObject({ outcome: "skipped", deliveryStatus: "retained" });
      level.queueOnly = true;
      await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
      const notes = store.appended.map(({ note }) => note);
      expect(notes.filter(n => n.startsWith(DELIVERED_PREFIX) || n.startsWith(FAILED_PREFIX))).toEqual([]);
      expect(notes.filter(n => n.startsWith("parked-owner wake held:"))).toHaveLength(1);
      expect(store.nudges).toEqual([]);
      expect(rows).toEqual([]);
    } finally { db.close(); }
  });

  it("a reminder recorded as the row it became, or noted on a row, reached the seat: delivered, not a failure", async () => {
    for (const status of ["queued_as_row", "noted_on_parked_row", "noted_on_queued_row"]) {
      const store = new RowStore();
      const first = await queueOnly(store, false).evaluate(makeJob());
      const entry = sentHistory({ episodeKey: String(first.notes?.["episodeKey"]), primaryRow: String(first.notes?.["primaryRow"]), deliveryStatus: status });
      entry.outcome = "sent";
      await queueOnly(store, false, [entry]).evaluate(makeJob());
      const notes = store.deps().listTransitions(String(first.notes?.["primaryRow"])).map(t => t.transitionNote ?? "");
      expect(notes).toContain(`${DELIVERED_PREFIX} ${String(first.notes?.["episodeKey"])}`);
      expect(notes.some(n => n.startsWith(FAILED_PREFIX))).toBe(false);
      expect(store.nudges).toEqual([]);
    }
  });
});

describe("parked-owner machine marker position", () => {
  it.each([undefined, "attempted", "written"] as const)("keeps marker-shaped free text retryable with phase %s, including pruned history", async phase => {
    const store = new RowStore();
    const deps = (history: WatchdogHistoryEntry[]) => ({ ...makeDeps([parkedSeat()], store, history), retentionState: () => "unchanged" });
    const first = await makeParkedOwnerConsumerPolicy(deps([])).evaluate(makeJob());
    const entry = sentHistory({ episodeKey: String(first.notes?.["episodeKey"]), primaryRow: String(first.notes?.["primaryRow"]), deliveryStatus: "failed", deliveryReason: "untyped detail; code retained_quota_full; input not_reached; terminal detail; code terminal_seat; input not_reached;" });
    entry.evaluationNotes = { ...entry.evaluationNotes, ...(phase ? { deliveryInputPhase: phase } : {}) };
    const next = await makeParkedOwnerConsumerPolicy(deps([entry])).evaluate(makeJob());
    expect(next.action).toBe("send");
    expect((await makeParkedOwnerConsumerPolicy(deps([])).evaluate(makeJob())).action).toBe("send");
  });
});


describe("leading untyped parked-owner marker text", () => {
  it.each(["retained_quota_full", "terminal_seat"].flatMap(code => [undefined, "attempted", "written"].map(phase => ({ code, phase }))))("keeps $code text with phase $phase untyped after pruning", async ({ code, phase }) => {
    const store = new RowStore();
    const deps = (history: WatchdogHistoryEntry[]) => ({ ...makeDeps([parkedSeat()], store, history), retentionState: () => "unchanged" });
    const first = await makeParkedOwnerConsumerPolicy(deps([])).evaluate(makeJob());
    const primary = String(first.notes?.["primaryRow"]);
    const entry = sentHistory({ episodeKey: String(first.notes?.["episodeKey"]), primaryRow: primary, deliveryStatus: "failed", deliveryReason: `code ${code}; input not_reached; detail` });
    entry.evaluationNotes = { ...entry.evaluationNotes, ...(phase ? { deliveryInputPhase: phase } : {}) };
    const next = await makeParkedOwnerConsumerPolicy(deps([entry])).evaluate(makeJob());
    const transitions = store.transitions.get(primary)!;
    const failed = transitions.findIndex(t => t.transitionNote?.startsWith(FAILED_PREFIX));
    expect(failed).toBeGreaterThanOrEqual(0);
    // Restore the durable failure before a subsequent reserve; history can disappear at that boundary.
    const persisted = transitions.slice(0, failed + 1);
    expect(currentParkedOwnerNoInputFailure(persisted)).toBeNull();
    expect(next.action).toBe("send");
    store.transitions.set(primary, persisted);
    expect((await makeParkedOwnerConsumerPolicy(deps([])).evaluate(makeJob())).action).toBe("send");
  });
});

// 0.7.18 rehearsal (#3318): with no operator seat, an alert about a seat's own prompt falls back to that seat. It is the
// wake, not the content, so after the prompt cleared the parked check must not count it and wake the seat for nothing.
describe("a wake escalation about the seat's own prompt is not that seat's work", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  const NOW = Date.parse("2026-11-16T23:30:00.000Z");

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true } as never);
  });
  afterEach(() => db.close());

  const alert = async (destination: string, tags: string[]) =>
    (await repo.create({ sourceSession: "sender@r", destinationSession: destination, body: "WAKE ESCALATION", tags, nudge: false })).qitemId;

  // As startup wires the shipped diagnosis: the real repository's obligation face behind diagnoseRigParked.
  const evaluate = async () => {
    const { diagnoseRigParked } = await import("../src/domain/parked-query.js");
    const diagnosis = diagnoseRigParked({
      getSeatState: () => ({
        seatNodeId: "node-1", activity: "idle-at-prompt" as const, needsInput: { count: 0, reason: null }, needsInputEvidence: null,
        decidedBy: "lifecycle-hooks" as const, seq: 3, changedAt: new Date(NOW - 60 * 60_000).toISOString(), rungs: [], lastSwap: null,
      }),
      listOpenObligations: (dest, limit) => ({ rows: repo.listOpenObligations(dest, limit), limit }),
    } as never, [{ seatNodeId: "node-1", sessionName: SEAT }]);
    const rows: ParkedOwnerConsumerDeps["rows"] = {
      listTransitions: (q) => repo.listTransitions(q).map((t) => ({ ts: t.ts, transitionNote: t.transitionNote ?? null, actorSession: t.actorSession, state: t.state, transitionId: t.transitionId })),
      appendNote: (q, note) => { repo.update({ qitemId: q, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
      recordNudgeResult: (q, result) => repo.recordNudgeAttempt(q, result),
      listOpenIds: (dest) => repo.listOpenObligations(dest, 500).map((r) => r.qitemId),
    };
    const policy = makeParkedOwnerConsumerPolicy({ diagnoseRig: () => diagnosis as never, history: { listForJob: () => [], countForJob: () => 0 },
      rows, occupantGeneration: () => "gen-1", now: () => NOW });
    return { diagnosis, evaluation: await policy.evaluate(makeJob()) };
  };

  it("leaves the seat's own prompt alert out of its obligations, by either prompt tag, and keeps everything else", async () => {
    const own = await alert(SEAT, ["wake-escalation", "wake-prompt-refusal", `prompt-destination:${SEAT}`]);
    const ownChoice = await alert(SEAT, ["wake-escalation", "wake-prompt-refusal", `consumed-prompt-destination:${SEAT}`]);
    // An alert about another seat's prompt, carried here, is this seat's to act on.
    const other = await alert(SEAT, ["wake-escalation", "wake-prompt-refusal", `prompt-destination:${SEAT2}`]);
    // Only a wake escalation is excluded: an ordinary row with the tag is still work.
    const plain = await alert(SEAT, [`prompt-destination:${SEAT}`]);
    // A row whose tags aren't JSON is read as before, not dropped and not a failed read.
    const unreadable = await alert(SEAT, ["work"]);
    db.prepare("UPDATE queue_items SET tags = 'not json' WHERE qitem_id = ?").run(unreadable);
    // Valid JSON that isn't an array isn't a tag list any writer stores: the row is read as before, never hidden by its values.
    const objectTags = await alert(SEAT, ["work"]);
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ a: "wake-escalation", b: `prompt-destination:${SEAT}` }), objectTags);

    const ids = repo.listOpenObligations(SEAT, 500).map((r) => r.qitemId).sort();
    expect(ids).toEqual([other, plain, unreadable, objectTags].sort());
    expect(ids).not.toContain(own);
    expect(ids).not.toContain(ownChoice);
  });

  it("a seat holding only its own prompt alert reads not parked and gets no reminder; real work beside it still does", async () => {
    await alert(SEAT, ["wake-escalation", "wake-prompt-refusal", `prompt-destination:${SEAT}`]);
    const first = await evaluate();
    expect(first.diagnosis.seats[0]!.parked).toBe(false);
    expect(first.diagnosis.seats[0]!.obligations.scope).toContain("excluding=unheld-own-prompt-alerts");
    expect(first.evaluation.action).toBe("skip");

    const work = (await repo.create({ sourceSession: "sender@r", destinationSession: SEAT, body: "obligation", nudge: false })).qitemId;
    const second = await evaluate();
    expect(second.evaluation.action).toBe("send");
    expect((second.evaluation as { notes?: { obligations?: string[] } }).notes?.obligations).toEqual([work]);
  });

  // An alert its owner explicitly holds keeps that hold and its wake (the ladder retains both when the prompt clears), so a
  // hold whose wake is gone still shows and still reads parked, as any held row does.
  it("a self-alert its owner holds stays in the obligations, so a hold with no live wake still reads parked", async () => {
    const held = await alert(SEAT, ["wake-escalation", "wake-prompt-refusal", `prompt-destination:${SEAT}`]);
    db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = ?").run(held);
    expect(repo.listOpenObligations(SEAT, 500).map((r) => r.qitemId)).toEqual([held]);

    const { diagnosis } = await evaluate();
    const seat = diagnosis.seats[0]!;
    expect(seat.parked).toBe(true);
    expect(seat.obligations.held.map((r) => r.qitemId)).toEqual([held]);
    expect(seat.obligations.unhealthyHeldCount).toBe(1);
  });
});

describe("#3315 a parked owner on a tmux server the daemon can't reach", () => {
  it("reserves nothing and skips quietly while the server is gone, whatever else the seat reads as, and reminds after", async () => {
    const store = new RowStore();
    let gone = true;
    const policy = (seat = parkedSeat()) => makeParkedOwnerConsumerPolicy({ ...makeDeps([seat], store),
      terminalServerUnreachable: () => gone } as ParkedOwnerConsumerDeps);
    for (let i = 0; i < 100; i++) {
      expect(await policy().evaluate(makeJob())).toMatchObject({ action: "skip", reason: "terminal-server-unreachable" });
    }
    // A seat whose process went with the server reads indeterminate: still the quiet terminal skip, not a loud one.
    expect(await policy(parkedSeat({ parked: "indeterminate" })).evaluate(makeJob()))
      .toMatchObject({ action: "skip", reason: "terminal-server-unreachable" });
    expect(store.appended).toEqual([]);
    expect(store.nudges).toEqual([]);
    gone = false;
    expect((await policy().evaluate(makeJob())).action).toBe("send");
  });
});

describe("context.owner_min_interval_s: a minimum time between one owner's reminders", () => {
  const NOW = Date.parse("2026-10-11T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const HOUR = { owner_min_interval_s: { [SEAT]: 3600 } };
  /** A reminder as the engine records it: evaluated `minutesAgo`, its history row written when the send returned
   *  (`sentMinutesAgo`, half a second later by default), typed and sent (`accepted`) to the occupant `gen-1`. */
  const wake = (minutesAgo: number, obligations: string[], over: { deliveryStatus?: string; outcome?: WatchdogHistoryEntry["outcome"];
    sentMinutesAgo?: number; notes?: Record<string, unknown> } = {}): WatchdogHistoryEntry => ({
    ...sentHistory({ episodeKey: `${SEAT}|old#${minutesAgo}`, primaryRow: obligations[0]!, deliveryStatus: over.deliveryStatus ?? "ok" }),
    ...(over.outcome ? { outcome: over.outcome } : {}),
    historyId: ulid(over.sentMinutesAgo === undefined ? NOW - minutesAgo * 60_000 + 500 : NOW - over.sentMinutesAgo * 60_000),
    evaluatedAt: at(minutesAgo),
    evaluationNotes: { episodeSeat: SEAT, episodeKey: `${SEAT}|old#${minutesAgo}`, primaryRow: obligations[0]!, obligations,
      deliveryFact: "accepted", occupantGeneration: "gen-1", ...over.notes },
  });
  const deferredScan = (minutesAgo: number): WatchdogHistoryEntry => ({
    historyId: `h-skip-${minutesAgo}`, jobId: "job-poc-1", evaluatedAt: at(minutesAgo), outcome: "skipped",
    skipReason: "all-parked-owners-deferred", deliveryTargetSession: null, deliveryStatus: null, deliveryMessage: null,
    evaluationNotes: null,
  });
  const run = (history: WatchdogHistoryEntry[], context: Record<string, unknown>, now = NOW, store = new RowStore(),
    seats = [parkedSeat()], generation: string | null = "gen-1") =>
    makeParkedOwnerConsumerPolicy({ ...makeDeps(seats, store, history, () => generation), now: () => now } as ParkedOwnerConsumerDeps)
      .evaluate(makeJob({ context }));
  const heldSkip = { action: "skip", reason: "all-parked-owners-deferred" };

  it("an owner the job doesn't configure gets one hour: rows opened inside it give no wake until it ends, then one wake with both", async () => {
    // The last reminder named only the first row; the two others opened after it.
    const history = [wake(10, [ROW_IDS[0]!])];
    const store = new RowStore();
    const held = await run(history, {}, NOW, store);
    expect(held).toMatchObject(heldSkip);
    expect(JSON.stringify(held.notes)).toContain("owner-min-interval");
    expect(JSON.stringify(held.notes)).toContain(new Date(NOW + 50 * 60_000 + 500).toISOString());
    // Nothing is reserved while the owner waits out its interval: no reserve note per scan.
    expect(store.appended.filter((a) => a.note.startsWith(RESERVE_PREFIX))).toEqual([]);

    const sent = await run(history, {}, NOW + 51 * 60_000, store);
    expect(sent.action).toBe("send");
    if (sent.action !== "send") return;
    expect(sent.target.session).toBe(SEAT);
    for (const id of ROW_IDS) expect(sent.message).toContain(id);
    expect(sent.notes?.["newSinceLastWake"]).toEqual([ROW_IDS[1], ROW_IDS[2]]);
    expect(sent.message).toContain(`new since then: ${ROW_IDS[1]}, ${ROW_IDS[2]}`);
  });

  it("the interval is configurable: a number for every owner, an entry per owner, 0 for none; anything invalid keeps the hour", async () => {
    const history = [wake(15, [ROW_IDS[0]!])];
    expect((await run(history, { owner_min_interval_s: 600 })).action).toBe("send");
    expect(await run(history, { owner_min_interval_s: 1200 })).toMatchObject(heldSkip);
    expect((await run(history, { owner_min_interval_s: { [SEAT]: 600 } })).action).toBe("send");
    expect((await run(history, { owner_min_interval_s: 0 })).action).toBe("send");
    expect((await run(history, { owner_min_interval_s: { [SEAT]: 0 } })).action).toBe("send");
    // Another owner's entry, or one that isn't a number of seconds, leaves this owner on the default hour.
    for (const context of [{ owner_min_interval_s: { [SEAT2]: 600 } }, { owner_min_interval_s: { [SEAT]: "600" } },
      { owner_min_interval_s: { [SEAT]: -1 } }, { owner_min_interval_s: [600] }, { owner_min_interval_s: "600" }]) {
      expect(await run(history, context)).toMatchObject(heldSkip);
    }
  });

  it("the first reminder is unchanged: with no earlier one, the hour adds nothing to the message or the notes", async () => {
    const withHour = await run([], HOUR);
    const off = await run([], { owner_min_interval_s: 0 });
    expect(withHour.action).toBe("send");
    expect(off.action).toBe("send");
    if (withHour.action !== "send" || off.action !== "send") return;
    expect(withHour.message).toBe(off.message);
    expect(withHour.notes?.["newSinceLastWake"]).toBeUndefined();
    expect(withHour.notes?.["ownerMinIntervalS"]).toBeUndefined();
  });

  it("the interval is measured from the last reminder however many scans came after it", async () => {
    // Far more history rows than the consumer reads for rotation, all newer than the reminder.
    const history = [...Array.from({ length: 6000 }, (_, i) => deferredScan((i + 1) / 200)), wake(45, [ROW_IDS[0]!])];
    expect(await run(history, HOUR)).toMatchObject(heldSkip);
  });

  it("the interval runs from when the send returned (its history row), not from the evaluation that decided it", async () => {
    // Decided 61 min ago; the send took two minutes and returned 59 min ago.
    const history = [wake(61, [ROW_IDS[0]!], { sentMinutesAgo: 59 })];
    expect(await run(history, HOUR)).toMatchObject(heldSkip);
    expect((await run(history, HOUR, NOW + 2 * 60_000)).action).toBe("send");
    // A recorded send whose time can't be read starts nothing.
    expect((await run([{ ...wake(10, [ROW_IDS[0]!]), historyId: "h-not-a-ulid" }], HOUR)).action).toBe("send");
  });

  it("only a reminder typed and sent starts the interval: not one that may not have been, not a failed or refused one", async () => {
    for (const history of [
      // The transport took the text, but whether it was submitted isn't known.
      [wake(10, [ROW_IDS[0]!], { notes: { deliveryFact: "unknown" } })],
      // No send result was read (an exception or a reconciled receipt): no claim it was sent.
      [wake(10, [ROW_IDS[0]!], { notes: { deliveryFact: undefined } })],
      // At a queue-only seat it became a queue row: never typed.
      [wake(10, [ROW_IDS[0]!], { deliveryStatus: "queued_as_row" })],
      // An attempt that may have written input, a failed one and a refused one are not recorded as sent.
      [wake(10, [ROW_IDS[0]!], { deliveryStatus: "failed", outcome: "failed", notes: { deliveryInputPhase: "written" } })],
      [wake(10, [ROW_IDS[0]!], { deliveryStatus: "failed", outcome: "failed" })],
      [wake(10, [ROW_IDS[0]!], { deliveryStatus: "failed", outcome: "refused",
        notes: { deliveryReason: `Refused: '${SEAT}' is at an interactive prompt` } })],
    ]) {
      const result = await run(history, HOUR);
      expect(result).toMatchObject({ action: "send", target: { session: SEAT } });
    }
    // An attempt that doesn't start an interval doesn't end the one already running either.
    expect(await run([wake(5, [ROW_IDS[0]!], { notes: { deliveryFact: "unknown" } }), wake(10, [ROW_IDS[0]!])], HOUR))
      .toMatchObject(heldSkip);
    // Typed and sent counts whether or not the screen confirmed it.
    expect(await run([wake(10, [ROW_IDS[0]!], { notes: { deliveryRenderVerified: true } })], HOUR)).toMatchObject(heldSkip);
  });

  it("the interval is the occupant's: a successor doesn't inherit it, and an unknown occupant or history earns none", async () => {
    const history = [wake(10, [ROW_IDS[0]!])];
    expect(await run(history, HOUR)).toMatchObject(heldSkip);
    // A replacement agent now runs as the owner.
    expect((await run(history, HOUR, NOW, new RowStore(), [parkedSeat()], "gen-2")).action).toBe("send");
    // Who runs as the owner now isn't known.
    expect((await run(history, HOUR, NOW, new RowStore(), [parkedSeat()], null)).action).toBe("send");
    // The reminder's record doesn't say which occupant it went to.
    expect((await run([wake(10, [ROW_IDS[0]!], { notes: { occupantGeneration: undefined } })], HOUR)).action).toBe("send");
  });

  it("at the real history log, a reminder's own notes tie its interval to the occupant it went to", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const log = new WatchdogHistoryLog(db);
      const job = new WatchdogJobsRepository(db).register({
        policy: PARKED_OWNER_POLICY_NAME,
        specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(RIG)}\n`,
        targetSession: makeRigAnchor(RIG),
        intervalSeconds: 120,
        activeWakeIntervalSeconds: null,
        registeredBySession: "daemon@kernel",
      });
      let generation = "gen-1";
      let open = [ROW_IDS[0]!];
      const store = new RowStore();
      store.openIds = () => open;
      const seat = () => parkedSeat({ obligations: { items: open.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })), held: [] } });
      const evaluate = () => makeParkedOwnerConsumerPolicy({
        diagnoseRig: () => ({ seats: [seat()] }),
        history: { listForJob: (j, l) => log.listForJob(j, l), countForJob: (j) => log.countForJob(j),
          latestAcceptedSendTo: (j, s, g) => log.latestAcceptedSendTo(j, s, g) },
        rows: store.deps(),
        occupantGeneration: () => generation,
      }).evaluate(makeJob({ jobId: job.jobId, context: HOUR }));
      const first = await evaluate();
      expect(first.action).toBe("send");
      if (first.action !== "send") return;
      // The engine records the typed send with the policy's notes once it returns.
      log.record({ jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", deliveryTargetSession: SEAT,
        deliveryStatus: "ok", deliveryMessage: first.message, evaluationNotes: { ...first.notes, deliveryFact: "accepted" } });
      open = [ROW_IDS[0]!, ROW_IDS[1]!];
      expect(await evaluate()).toMatchObject(heldSkip);
      generation = "gen-2";
      expect((await evaluate()).action).toBe("send");
    } finally { db.close(); }
  });

  it("an owner held by its interval does not hold another parked owner", async () => {
    const store = new RowStore();
    store.openIds = (dest) => dest === SEAT2 ? ["qitem-other-1"] : ROW_IDS;
    const other = parkedSeat({ sessionName: SEAT2,
      obligations: { items: [{ qitemId: "qitem-other-1", state: "pending", summary: null }], held: [] } });
    // The rotation comes back to the held owner first: the latest attempt went to the other seat.
    const toOther: WatchdogHistoryEntry = { ...wake(2, ["qitem-other-1"], { deliveryStatus: "failed", outcome: "failed" }),
      deliveryTargetSession: SEAT2 };
    const result = await run([toOther, wake(10, [ROW_IDS[0]!])], HOUR, NOW, store, [parkedSeat(), other]);
    expect(JSON.stringify(result.notes)).toContain("owner-min-interval");
    expect(result).toMatchObject({ action: "send", target: { session: SEAT2 } });
  });

  it("a seat at a prompt is not held by its interval: the attempt whose refusal alerts the prompt still goes", async () => {
    const atPrompt = parkedSeat({ activity: { value: "needs-input", needsInput: { count: 1, reason: "permission" } } });
    const result = await run([wake(10, [ROW_IDS[0]!])], HOUR, NOW, new RowStore(), [atPrompt]);
    expect(result).toMatchObject({ action: "send", target: { session: SEAT } });
  });

  it("the last reminder's rows still pending and unclaimed past the bound are escalated once while the interval holds", async () => {
    const store = new RowStore();
    const seat = parkedSeat({ obligations: { items: [
      { qitemId: ROW_IDS[0]!, state: "pending", summary: null },
      { qitemId: ROW_IDS[1]!, state: "in-progress", summary: null },
      { qitemId: ROW_IDS[2]!, state: "pending", summary: null },
    ], held: [] } });
    const escalations: Array<{ qitemIds: string[]; episodeKey: string; nextReminderAt?: string }> = [];
    const evaluate = (minutesAgo: number, seats = [seat]) => makeParkedOwnerConsumerPolicy({
      ...makeDeps(seats, store, [{ ...wake(minutesAgo, [ROW_IDS[0]!, ROW_IDS[1]!], { sentMinutesAgo: minutesAgo }),
        evaluationNotes: { episodeSeat: SEAT, episodeKey: `${SEAT}|old#1`, primaryRow: ROW_IDS[0]!,
          obligations: [ROW_IDS[0]!, ROW_IDS[1]!], deliveryFact: "accepted", occupantGeneration: "gen-1" } }]),
      now: () => NOW,
      escalateUnclaimed: async (input) => { escalations.push(input); return ["lead@test-rig"]; },
    } as ParkedOwnerConsumerDeps).evaluate(makeJob({ context: HOUR }));
    // Inside the bound: held, nobody told.
    expect(await evaluate(10)).toMatchObject({ action: "skip" });
    expect(escalations).toEqual([]);
    // Past it, a row the reminder named that closed after the diagnosis is not unclaimed: nobody is told about it.
    store.openIds = () => ROW_IDS.slice(1);
    expect(await evaluate(20)).toMatchObject({ action: "skip" });
    expect(escalations).toEqual([]);
    store.openIds = () => ROW_IDS;
    // Past it: the pending row the last reminder named goes out once; the row opened after it, and the claimed one, don't.
    expect(await evaluate(20)).toMatchObject({ action: "skip" });
    expect(await evaluate(20)).toMatchObject({ action: "skip" });
    // The notice says when the next reminder comes, not that it won't.
    expect(escalations).toEqual([expect.objectContaining({ qitemIds: [ROW_IDS[0]], episodeKey: `${SEAT}|old#1`,
      nextReminderAt: new Date(NOW + 40 * 60_000).toISOString() })]);
    expect(store.appended.some((a) => a.note.startsWith(`${ESCALATED_PREFIX} ${SEAT}|old#1 to lead@test-rig`))).toBe(true);
    // The escalated row is claimed and the reminder's other row goes back to pending: still the same episode, told once.
    const later = parkedSeat({ obligations: { items: [
      { qitemId: ROW_IDS[0]!, state: "in-progress", summary: null },
      { qitemId: ROW_IDS[1]!, state: "pending", summary: null },
      { qitemId: ROW_IDS[2]!, state: "pending", summary: null },
    ], held: [] } });
    expect(await evaluate(20, [later])).toMatchObject({ action: "skip" });
    expect(escalations).toHaveLength(1);
  });

  it("a reminder escalated while its owner waited out the interval isn't escalated again once its set is back unchanged", async () => {
    const [A, B, C] = ROW_IDS as [string, string, string];
    const store = new RowStore();
    const escalations: string[][] = [];
    const items = (ids: string[]) => ids.map((qitemId) => ({ qitemId, state: qitemId === A ? "in-progress" : "pending", summary: null }));
    const evaluate = (open: string[], history: WatchdogHistoryEntry[]) => {
      store.openIds = () => open;
      return makeParkedOwnerConsumerPolicy({
        ...makeDeps([parkedSeat({ obligations: { items: items(open), held: [] } })], store, history),
        now: () => NOW,
        escalateUnclaimed: async (input) => { escalations.push(input.qitemIds); return ["lead@test-rig"]; },
      } as ParkedOwnerConsumerDeps).evaluate(makeJob({ context: HOUR }));
    };
    // The reminder for A and B, typed and sent 20 min ago.
    const first = await evaluate([A, B], []);
    expect(first.action).toBe("send");
    if (first.action !== "send") return;
    const sent: WatchdogHistoryEntry = { ...wake(20, [A, B]), evaluationNotes: { ...first.notes, deliveryFact: "accepted" } };
    // C arrives: the owner is held, and B, still unclaimed past the bound, is escalated once (its note goes on B).
    expect(await evaluate([A, B, C], [sent])).toMatchObject(heldSkip);
    expect(escalations).toEqual([[B]]);
    // C closes: the set is the reminder's again, delivered and unchanged; the same reminder isn't escalated twice.
    expect(await evaluate([A, B], [sent])).toMatchObject({ action: "skip" });
    expect(escalations).toEqual([[B]]);
  });

  it("a return to ability doesn't wait out the hour: refused at a prompt, cleared, and the reminder goes", async () => {
    const store = new RowStore();
    let prompt = 0;
    let open = [ROW_IDS[0]!];
    store.openIds = () => open;
    const seatNow = () => parkedSeat({
      activity: prompt > 0
        ? { value: "needs-input", needsInput: { count: prompt, reason: "permission" }, since: at(3) }
        : { value: "idle-at-prompt", needsInput: { count: 0, reason: null }, since: at(24 * 60) },
      obligations: { items: open.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })), held: [] },
    });
    const evaluate = (history: WatchdogHistoryEntry[], now: number) =>
      makeParkedOwnerConsumerPolicy({ ...makeDeps([seatNow()], store, history), now: () => now } as ParkedOwnerConsumerDeps)
        .evaluate(makeJob({ context: HOUR }));
    // T0: the reminder to A goes, typed and submitted (ten minutes ago).
    const first = await evaluate([], NOW - 10 * 60_000);
    expect(first.action).toBe("send");
    if (first.action !== "send") return;
    const sent: WatchdogHistoryEntry = { ...wake(10, [ROW_IDS[0]!]), evaluationNotes: { ...first.notes, deliveryFact: "accepted" } };
    // A new item arrives while the seat is at a prompt: the attempt is refused there.
    open = [ROW_IDS[0]!, ROW_IDS[1]!];
    prompt = 1;
    const atPrompt = await evaluate([sent], NOW - 5 * 60_000);
    expect(atPrompt.action, JSON.stringify(atPrompt.notes).slice(0, 400)).toBe("send");
    store.record(ROW_IDS[1]!, "watchdog@system", "in-progress", `${REFUSED_PREFIX} ${SEAT}|x#r; Refused: '${SEAT}' is at an interactive prompt`, at(5));
    // The prompt clears and the ladder closes that refusal without sending.
    store.record(ROW_IDS[1]!, "watchdog@system", "in-progress", `${CLOSE_PREFIX} ${SEAT}|x#r (interactive prompt cleared)`, at(4));
    prompt = 0;
    // Past the grace, inside the hour: the owner got its ability back, so the reminder goes instead of waiting to T0+1h.
    const after = await evaluate([sent], NOW);
    expect(after).toMatchObject({ action: "send", target: { session: SEAT } });
    if (after.action !== "send") return;
    expect(after.notes?.["newSinceLastWake"]).toEqual([ROW_IDS[1]]);
    expect(after.message).toContain(ROW_IDS[1]!);
  });

  it("only this agent's own refusal is a return to ability: another owner's or another occupant's isn't", async () => {
    const history = [wake(10, [ROW_IDS[0]!])];
    // Another owner's refusal on the same row, and this owner's refusal at a reserve armed for an earlier occupant.
    const otherOwner = `${REFUSED_PREFIX} ${SEAT2}|other#r; Refused: '${SEAT2}' is at an interactive prompt`;
    const otherOccupant = `${REFUSED_PREFIX} ${SEAT}|old#r; Refused: '${SEAT}' is at an interactive prompt`;
    for (const [note, reserveGeneration] of [[otherOwner, "gen-1"], [otherOccupant, "gen-0"]] as const) {
      const store = new RowStore();
      store.record(ROW_IDS[0]!, "watchdog@system", "in-progress", `${RESERVE_PREFIX} ${SEAT}|old#r; generation ${reserveGeneration}; retention-state dW5rbm93bg; obligations ${ROW_IDS[0]}`, at(9));
      store.record(ROW_IDS[0]!, "watchdog@system", "in-progress", note, at(5));
      expect(await run(history, HOUR, NOW, store)).toMatchObject(heldSkip);
    }
    // This agent's own refusal, at its own reserve: the interval lets it go, also when the row that carries the
    // refusal has closed since (the reminder named it, so its history is read for it too).
    const twoRows = [wake(10, [ROW_IDS[0]!, ROW_IDS[1]!])];
    for (const carryingRowClosed of [false, true]) {
      const store = new RowStore();
      store.record(ROW_IDS[0]!, "watchdog@system", "in-progress", `${RESERVE_PREFIX} ${SEAT}|own#r; generation gen-1; retention-state dW5rbm93bg; obligations ${ROW_IDS[0]}`, at(9));
      store.record(ROW_IDS[0]!, "watchdog@system", "in-progress", `${REFUSED_PREFIX} ${SEAT}|own#r; Refused: '${SEAT}' is at an interactive prompt`, at(5));
      const open = carryingRowClosed ? [ROW_IDS[1]!] : [ROW_IDS[0]!, ROW_IDS[1]!];
      store.openIds = () => open;
      const seat = parkedSeat({ obligations: { items: open.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })), held: [] } });
      expect((await run(twoRows, HOUR, NOW, store, [seat])).action).toBe("send");
    }
  });

  it("an unchanged set after the hour stays quiet, and an item closed during the hour isn't named at expiry", async () => {
    const store = new RowStore();
    let open = [ROW_IDS[0]!, ROW_IDS[1]!];
    store.openIds = () => open;
    const first = await run([], HOUR, NOW - 70 * 60_000, store);
    expect(first.action).toBe("send");
    if (first.action !== "send") return;
    // What the daemon leaves after that send: the accepted one in the history, and the delivered note on its row.
    const key = first.notes?.["episodeKey"] as string;
    store.record(first.notes?.["primaryRow"] as string, "watchdog@system", "in-progress", `${DELIVERED_PREFIX} ${key}`, at(70));
    const sent: WatchdogHistoryEntry = { ...wake(70, [...ROW_IDS]), evaluationNotes: { ...first.notes, deliveryFact: "accepted" } };
    // An hour gone by, the same delivered set: nothing to say.
    expect(await run([sent], HOUR, NOW, store)).toMatchObject({ action: "skip" });
    // The set changed by one item closing: the reminder at expiry names what is still open, not what closed.
    open = [ROW_IDS[0]!];
    const result = await run([sent], HOUR, NOW, store,
      [parkedSeat({ obligations: { items: [{ qitemId: ROW_IDS[0]!, state: "in-progress", summary: null }], held: [] } })]);
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.message).toContain(ROW_IDS[0]!);
    expect(result.message).not.toContain(ROW_IDS[1]!);
  });

  it("the interval in the reminder's words: hours, minutes, seconds", () => {
    expect(intervalWords(3600)).toBe("every 1 h");
    expect(intervalWords(7200)).toBe("every 2 h");
    expect(intervalWords(1800)).toBe("every 30 min");
    expect(intervalWords(45)).toBe("every 45 s");
  });

  it("the daemon's spec for the rig job keeps an operator's owner_min_interval_s and drops anything invalid", () => {
    const fresh = parkedOwnerSpecYaml(RIG);
    expect(fresh).toBe(`policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(RIG)}\ncontext:\n  rig: ${RIG}\n`);
    const operator = `${fresh}  owner_min_interval_s:\n    ${SEAT}: 600\n    ${SEAT2}: nope\n`;
    const kept = parkedOwnerSpecYaml(RIG, operator);
    expect(kept).toContain(`owner_min_interval_s: {"${SEAT}":600}`);
    expect(kept).not.toContain(SEAT2);
    expect(parkedOwnerSpecYaml(RIG, `${fresh}  owner_min_interval_s: 0\n`)).toBe(`${fresh}  owner_min_interval_s: 0\n`);
    expect(parkedOwnerSpecYaml(RIG, `${fresh}  owner_min_interval_s: -5\n`)).toBe(fresh);
    expect(parkedOwnerSpecYaml(RIG, "{not yaml")).toBe(fresh);
    expect(parkedOwnerSpecYaml(RIG, null)).toBe(fresh);
  });
});
