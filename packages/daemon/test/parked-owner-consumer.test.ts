import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// OPR.0.5.6.24 F-14 — the parked-owner consumer contract (ruled R1-R5 +
// desk seams 41983/41985): episode identity is PURELY history-derived, the
// whole shipped diagnosis is inherited (unhealthy HELD included), skip cells
// come from real surfaces, and one seat can never throttle or starve another.
import {
  makeParkedOwnerConsumerPolicy,
  makeRigAnchor,
  type ParkedOwnerConsumerDeps,
  type ParkedSeatDiagnosisView,
} from "../src/domain/policies/parked-owner-consumer.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const RIG = "test-rig";
const SEAT = `dev-planner@${RIG}`;
const SEAT2 = `dev-driver@${RIG}`;
const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/domain/policies/parked-owner-consumer.ts",
);
const readModuleSource = () => readFileSync(MODULE_PATH, "utf8");

function makeJob(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    jobId: "job-poc-1",
    policy: "parked-owner-consumer",
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

const ROW_IDS = [
  "qitem-20260828190838-bd7eef84",
  "qitem-20260828235231-f115c617",
  "qitem-20260829001330-64f888d1",
];

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

function sentEntry(input: {
  seat: string;
  idsHash: string;
  episodeKey: string;
  deliveryReason?: string;
  extraNotes?: Record<string, unknown>;
}): WatchdogHistoryEntry {
  return {
    historyId: `h-${input.episodeKey}`,
    jobId: "job-poc-1",
    evaluatedAt: "2026-08-29T17:30:00.000Z",
    outcome: "sent",
    skipReason: null,
    deliveryTargetSession: input.seat,
    deliveryStatus: input.deliveryReason ? "failed" : "ok",
    deliveryMessage: "wake",
    evaluationNotes: {
      episodeSeat: input.seat,
      idsHash: input.idsHash,
      episodeKey: input.episodeKey,
      ...(input.deliveryReason ? { deliveryReason: input.deliveryReason } : {}),
      ...(input.extraNotes ?? {}),
    },
  };
}

function makeDeps(
  seats: ParkedSeatDiagnosisView[],
  history: WatchdogHistoryEntry[] = [],
): ParkedOwnerConsumerDeps {
  return {
    diagnoseRig: () => ({ seats }),
    history: {
      listForJob: (_jobId, limit) => history.slice(0, limit),
      countForJob: () => history.length,
    },
  };
}

/** Derive the idsHash the same way the module does — via the module's own send
 *  (one evaluation against empty history yields the canonical key parts). */
async function canonicalKeyParts(seat: ParkedSeatDiagnosisView): Promise<{ idsHash: string; episodeKey: string }> {
  const policy = makeParkedOwnerConsumerPolicy(makeDeps([seat]));
  const r = await policy.evaluate(makeJob());
  if (r.action !== "send") throw new Error(`fixture expected send, got ${r.action}: ${JSON.stringify(r)}`);
  return { idsHash: String(r.notes?.["idsHash"]), episodeKey: String(r.notes?.["episodeKey"]) };
}

describe("parked-owner-consumer policy (OPR.0.5.6.24 F-14)", () => {
  // R1 — THE SPECIMEN DIES: three claimed rows x arbitrated-idle -> one send
  // naming every park-driving row id (open items PLUS unhealthy HELD — the
  // whole shipped diagnosis inherited, desk gap 3).
  it("R1: claimed-rows x arbitrated-idle sends ONE wake naming open AND unhealthy-held ids", async () => {
    const seat = parkedSeat({
      obligations: {
        items: ROW_IDS.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })),
        held: [
          { qitemId: "qitem-held-unhealthy-1", healthy: false },
          { qitemId: "qitem-held-healthy-1", healthy: true },
        ],
      },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([seat]));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT);
    const named = JSON.stringify(result.notes ?? {});
    for (const id of ROW_IDS) expect(named).toContain(id);
    expect(named).toContain("qitem-held-unhealthy-1");
    expect(named).not.toContain("qitem-held-healthy-1");
  });

  // P1 — CONTINUOUS-PARK CHURN: needsInput reason changes mid-park must not
  // re-wake (episode identity carries no activity epoch).
  it("P1: needsInput churn during one continuous park does not re-wake (skip already-woken)", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const history = [sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey })];
    const churned = parkedSeat({
      activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "permission prompt" } },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([churned], history));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String((result as { reason?: unknown }).reason)).toMatch(/already[-_]woken/);
  });

  // P2 — NOTHING IN MEMORY: a FRESH policy instance over the same history
  // still skips (the receipt is the durable history row, not instance state).
  it("P2: a new policy instance with the same history does not re-wake", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const history = [sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey })];
    const first = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], history));
    const second = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], history));
    expect((await first.evaluate(makeJob())).action).toBe("skip");
    expect((await second.evaluate(makeJob())).action).toBe("skip");
  });

  // P3 — CLOSE THEN RE-PARK: an observed not-parked scan durably closes the
  // open key (the episode-ended row), and a later re-park of the same
  // seat+obligations earns the next ordinal's send.
  it("P3: observed not-parked closes the episode durably; re-park earns a new ordinal send", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const history: WatchdogHistoryEntry[] = [
      sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey }),
    ];
    // Not-parked scan: closure recorded via the bounded episode-ended skip.
    const notParked = parkedSeat({ parked: false });
    const closingPolicy = makeParkedOwnerConsumerPolicy(makeDeps([notParked], history));
    const closing = await closingPolicy.evaluate(makeJob());
    expect(closing.action).toBe("skip");
    expect(String((closing as { reason?: unknown }).reason)).toMatch(/episode[-_]ended/);
    const closures = (closing.notes?.["episodeClosures"] ?? []) as string[];
    expect(closures).toContain(parts.episodeKey);
    // The closure row lands in durable history (newest first), as the engine would record it.
    history.unshift({
      historyId: "h-closure-1",
      jobId: "job-poc-1",
      evaluatedAt: "2026-08-29T17:31:00.000Z",
      outcome: "skipped",
      skipReason: "episode-ended",
      deliveryTargetSession: null,
      deliveryStatus: null,
      deliveryMessage: null,
      evaluationNotes: { episodeClosures: closures },
    });
    // Re-park, same seat + same obligation set: a NEW ordinal-bumped send.
    const rePolicy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], history));
    const result = await rePolicy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(String(result.notes?.["episodeKey"])).toBe(`${SEAT}|${parts.idsHash}#2`);
  });

  // Obligation-set change while the seat STAYS parked is a new episode
  // (locked identity: seat+obligation) — desk gap 2's second arm.
  it("obligation-set change during one park earns its own wake (new idsHash key)", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const history = [sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey })];
    const grown = parkedSeat({
      obligations: {
        items: [...ROW_IDS, "qitem-new-arrival-1"].map((qitemId) => ({ qitemId, state: "in-progress", summary: null })),
        held: [],
      },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([grown], history));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(String(result.notes?.["idsHash"])).not.toBe(parts.idsHash);
  });

  // STARVATION GUARD: one receipted seat never blocks the next eligible owner
  // in the SAME pass; the passed-over seat is named honestly.
  it("multi-seat: an already-receipted seat is iterated past and the send targets the next eligible owner same-pass", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const history = [sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey })];
    const seat2 = parkedSeat({
      sessionName: SEAT2,
      obligations: { items: [{ qitemId: "qitem-seat2-row-1", state: "in-progress", summary: null }], held: [] },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat(), seat2], history));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT2);
    const skipped = JSON.stringify(result.notes?.["skippedSeats"] ?? []);
    expect(skipped).toContain(SEAT);
    expect(skipped).toMatch(/already[-_]woken/);
  });

  // R3a — the empty cell fires ONLY when the union of park-driving ids is empty.
  it("R3a: parked with zero park-driving obligations skips with no-park-driving-obligation", async () => {
    const bare = parkedSeat({ obligations: { items: [], held: [{ qitemId: "q-h", healthy: true }] } });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([bare]));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String((result as { reason?: unknown }).reason)).toMatch(/all-parked-owners-deferred/);
    expect(JSON.stringify(result.notes)).toMatch(/no[-_]park[-_]driving/);
  });

  // R3b — usage-limit defers to S16's timed wake, via the REAL surface reason.
  it("R3b: a usage-limit park defers to S16 (zero sends; the real needsInput.reason drives it)", async () => {
    const limited = parkedSeat({
      activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "usage limit" } },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([limited]));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/usage[-_]limit[-_]defer[-_]s16/);
  });

  // R3c — S21 inheritance: indeterminate is NOT parked, no wake.
  it("R3c: an INDETERMINATE arbitrated verdict gets no wake", async () => {
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat({ parked: "indeterminate" })]));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result)).toMatch(/indeterminate/);
  });

  // P5 — REFUSAL vs GENERIC (desk seam 3): only the transport's
  // interactive-prompt refusal earns the refused cell; a generic failure
  // stays already-woken. Both cells never block ANOTHER eligible seat.
  it("P5a: an interactive-prompt refusal on the open episode reads destination-refused-interactive-prompt", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const refusal = `Refused: '${SEAT}' is at an interactive prompt (target_needs_input). No text was sent.`;
    const history = [
      sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey, deliveryReason: refusal }),
    ];
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], history));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/destination[-_]refused[-_]interactive[-_]prompt/);
  });

  it("P5b: a generic delivery failure is NOT labeled refused (already-woken governs) and a second eligible seat still gets its send same-pass", async () => {
    const parts = await canonicalKeyParts(parkedSeat());
    const history = [
      sentEntry({ seat: SEAT, idsHash: parts.idsHash, episodeKey: parts.episodeKey, deliveryReason: "transport timeout after 5000ms" }),
    ];
    const seat2 = parkedSeat({
      sessionName: SEAT2,
      obligations: { items: [{ qitemId: "qitem-seat2-row-1", state: "in-progress", summary: null }], held: [] },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat(), seat2], history));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT2);
    const skipped = JSON.stringify(result.notes?.["skippedSeats"] ?? []);
    expect(skipped).toContain(SEAT);
    expect(skipped).toMatch(/already[-_]woken/);
    expect(skipped).not.toMatch(/destination[-_]refused/);
  });

  // ANCHOR PIN: the per-rig registration identity is a design, not a placeholder.
  it("anchor: makeRigAnchor yields the stable per-rig tuple member", () => {
    expect(makeRigAnchor("test-rig")).toBe("parked-owner-consumer@test-rig");
  });

  // R4 — ARBITRATED-ONLY, structurally: the module consumes the shipped rig
  // diagnosis and has zero raw-evidence reads.
  it("R4: the module consumes the shipped diagnosis surface and has ZERO raw-evidence reads", () => {
    const src = readModuleSource();
    expect(src).toMatch(/diagnoseRigParked|RigParkedDiagnosis|diagnoseRig/);
    expect(src).not.toMatch(/AgentActivityStore|getLatestForNode|activity-relay|hook/);
  });

  // R5 — NO SECOND SCHEDULER, structurally.
  it("R5: no timer/scheduler/state-machine entry point outside the watchdog surface", () => {
    const src = readModuleSource();
    expect(src).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
    expect(src).toMatch(/makeParkedOwnerConsumerPolicy/);
  });

  // Quiet floor (the S02 idiom): a fully clean scan is the no-parked-owner
  // skip — the engine suppresses it from history (pinned engine-side).
  it("floor: a clean scan returns the quiet no-parked-owner skip", async () => {
    const active = parkedSeat({ parked: false });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([active]));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String((result as { reason?: unknown }).reason)).toBe("no-parked-owner");
  });
});
