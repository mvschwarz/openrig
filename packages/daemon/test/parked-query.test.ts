import { describe, it, expect } from "vitest";
import {
  diagnoseSeatParked,
  diagnoseRigParked,
  PARKED_OBLIGATION_LIMIT,
  type ParkedQueryDeps,
  type ObligationRow,
} from "../src/domain/parked-query.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A7 — the parked query, RED-first and both-sided (AM-3). At base no
// surface answers "are we parked?" — these pins define the derived diagnosis with
// per-input confidence, named obligation scope, and the limit guard.

const SEAT = { seatNodeId: "node-1", sessionName: "dev50-qa@v-openrig-build" };

function oracleState(overrides: Partial<ArbitratedSeatState>): ArbitratedSeatState {
  return {
    seatNodeId: SEAT.seatNodeId,
    activity: "idle-at-prompt",
    needsInput: { count: 0, reason: null },
    decidedBy: "window-sampling",
    seq: 7,
    changedAt: "2026-08-26T23:00:00.000Z",
    rungs: [],
    lastSwap: null,
    ...overrides,
  };
}

function deps(
  state: ArbitratedSeatState | null,
  rows: ObligationRow[],
  limit = PARKED_OBLIGATION_LIMIT,
  wakes: Record<string, unknown> = {},
): ParkedQueryDeps & { scopes: string[]; getParkWake: (qitemId: string) => unknown } {
  const scopes: string[] = [];
  return {
    scopes,
    getSeatState: () => state,
    getParkWake: (qitemId) => wakes[qitemId] ?? null,
    listOpenObligations: (destination, lim) => {
      scopes.push(`${destination}:${lim}`);
      return { rows: rows.slice(0, lim), limit: lim };
    },
  };
}

const pendingRow: ObligationRow = { qitemId: "qitem-1", state: "pending", summary: "review the thing" };
const heldRow: ObligationRow = { qitemId: "qitem-2", state: "blocked", summary: "deliberately held" };

describe("S19 A7 — the derived diagnosis, both park causes", () => {
  it("dropped-baton park: idle-at-prompt × an open pending row → PARKED, with the evidence on both sides", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [pendingRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.activity.value).toBe("idle-at-prompt");
    expect(d.activity.confidence).toBe("oracle");
    expect(d.obligations.openCount).toBe(1);
    expect(d.obligations.items[0]!.qitemId).toBe("qitem-1");
    expect(d.reason).toMatch(/idle/i);
  });

  it("needs-input park: a pending block with obligations → PARKED (the second founder-observed cause)", () => {
    const state = oracleState({ activity: "working", needsInput: { count: 1, reason: "permission prompt" } });
    const d = diagnoseSeatParked(deps(state, [pendingRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.reason).toMatch(/needs.input|permission/i);
  });

  it("working with obligations is NOT parked", () => {
    const d = diagnoseSeatParked(deps(oracleState({ activity: "working" }), [pendingRow]), SEAT);
    expect(d.parked).toBe(false);
  });

  it("idle with an EMPTY board is NOT parked (idle without owed work is just idle)", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), []), SEAT);
    expect(d.parked).toBe(false);
  });

  it("R25: a wakeless HELD row drives the diagnosis and teaches every repair path inline", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.obligations.heldCount).toBe(1);
    expect(d.obligations.openCount).toBe(0);
    expect(d.reason).toMatch(/watchdog id/i);
    expect(d.reason).toMatch(/timer/i);
    expect(d.reason).toMatch(/live blocker/i);
    expect(d.reason).toMatch(/workspace.*not.imminent/i);
  });

  it("R25 negative control: HELD with a live armed wake remains healthy", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow], PARKED_OBLIGATION_LIMIT, {
      "qitem-2": { kind: "watchdog", ref: "job-1", live: true, unconsumed: false },
    }), SEAT);
    expect(d.parked).toBe(false);
    expect(d.reason).toMatch(/healthy|live wake/i);
  });

  it("S16 preserves the optional absolute expiry on a named provider-limit wake", () => {
    const expiresAt = "2026-08-28T13:00:00.000Z";
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow], PARKED_OBLIGATION_LIMIT, {
      "qitem-2": {
        kind: "blocker",
        ref: "qitem-provider-limit",
        live: true,
        phase: "armed",
        deliveryStatus: null,
        unconsumed: false,
        expiresAt,
      },
    }), SEAT);

    expect(d.parked).toBe(false);
    expect(d.obligations.held[0]?.wake).toMatchObject({ expiresAt });
  });

  it("R25: a fired wake left blocked is visible as unconsumed", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow], PARKED_OBLIGATION_LIMIT, {
      "qitem-2": { kind: "timer", ref: "job-timer", live: true, unconsumed: true, deliveryStatus: "ok" },
    }), SEAT);
    expect(d.parked).toBe(true);
    expect(d.reason).toMatch(/unconsumed/i);
  });

  it("held AND pending together: parked on the pending row, held surfaced beside it", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow, pendingRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.obligations.openCount).toBe(1);
    expect(d.obligations.heldCount).toBe(1);
    expect(d.reason).toMatch(/watchdog id|timer|live blocker/i);
  });
});

describe("S19 A7 — AM-3: both-sided confidence, named scope, limit guard", () => {
  it("activity UNKNOWN → the verdict is INDETERMINATE, never a guessed NOT-PARKED", () => {
    const d = diagnoseSeatParked(deps(oracleState({ activity: "unknown", decidedBy: null }), [pendingRow]), SEAT);
    expect(d.parked).toBe("indeterminate");
    expect(d.confidence.activity).toBe("none");
    expect(d.reason).toMatch(/unknown|cannot/i);
  });

  it("no oracle state at all → INDETERMINATE with the missing input named", () => {
    const d = diagnoseSeatParked(deps(null, [pendingRow]), SEAT);
    expect(d.parked).toBe("indeterminate");
    expect(d.confidence.activity).toBe("none");
  });

  it("the obligation scope is NAMED in the output (destination + open-state, the exact read that ran)", () => {
    const dp = deps(oracleState({}), [pendingRow]);
    const d = diagnoseSeatParked(dp, SEAT);
    expect(d.obligations.scope).toContain(SEAT.sessionName);
    expect(d.obligations.scope).toMatch(/pending/);
    expect(dp.scopes).toHaveLength(1); // exactly one read, matching the named scope
  });

  it("LIMIT GUARD: a board at the limit returns truncation-possible honesty, never a silently-derived count", () => {
    const many: ObligationRow[] = Array.from({ length: PARKED_OBLIGATION_LIMIT + 50 }, (_, i) => ({
      qitemId: `qitem-load-${i}`,
      state: "pending" as const,
    }));
    const d = diagnoseSeatParked(deps(oracleState({}), many), SEAT);
    expect(d.parked).toBe(true); // truncation can only UNDERCOUNT — parked stands
    expect(d.obligations.complete).toBe(false);
    expect(d.confidence.obligations).toBe("truncation-possible");
  });

  it("derived at read time: two calls with a changed board give different answers (never stored)", () => {
    const state = oracleState({});
    expect(diagnoseSeatParked(deps(state, [pendingRow]), SEAT).parked).toBe(true);
    expect(diagnoseSeatParked(deps(state, []), SEAT).parked).toBe(false);
  });
});

describe("S19 A7 — rig-level: 'are we parked?'", () => {
  it("a rig is parked when ANY seat is parked; the parked seats are named", () => {
    const seats = [
      { seatNodeId: "node-1", sessionName: "a@rig" },
      { seatNodeId: "node-2", sessionName: "b@rig" },
    ];
    const states: Record<string, ArbitratedSeatState> = {
      "node-1": oracleState({ seatNodeId: "node-1", activity: "working" }),
      "node-2": oracleState({ seatNodeId: "node-2" }), // idle
    };
    const d = diagnoseRigParked({
      getSeatState: (id) => states[id] ?? null,
      listOpenObligations: (dest) => ({ rows: dest === "b@rig" ? [pendingRow] : [], limit: PARKED_OBLIGATION_LIMIT }),
    }, seats);
    expect(d.parked).toBe(true);
    expect(d.seats.find((s) => s.seatNodeId === "node-2")!.parked).toBe(true);
    expect(d.seats.find((s) => s.seatNodeId === "node-1")!.parked).toBe(false);
  });

  it("all seats working or clean → NOT parked; any indeterminate seat makes the RIG verdict indeterminate (never a false all-clear)", () => {
    const seats = [
      { seatNodeId: "node-1", sessionName: "a@rig" },
      { seatNodeId: "node-2", sessionName: "b@rig" },
    ];
    const states: Record<string, ArbitratedSeatState | null> = {
      "node-1": oracleState({ seatNodeId: "node-1", activity: "working" }),
      "node-2": null, // oracle has nothing — indeterminate
    };
    const d = diagnoseRigParked({
      getSeatState: (id) => states[id] ?? null,
      listOpenObligations: () => ({ rows: [pendingRow], limit: PARKED_OBLIGATION_LIMIT }),
    }, seats);
    expect(d.parked).toBe("indeterminate");
    expect(d.reason).toMatch(/node-2|indeterminate/i);
  });
});
