import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getTimeInState,
  computeActivityRollup,
  formatRollupLabel,
  isHookGradeNeedsInput,
  getActivityStateWithSource,
  type AgentActivitySummary,
} from "../src/lib/activity-visuals.js";
import {
  isSyntheticFeedCard,
  eventDerivedSeqsForPrune,
  needsInputSeatToFeedCard,
} from "../src/lib/attention-feed.js";

afterEach(() => { vi.useRealTimers(); });

describe("getTimeInState (FR-2)", () => {
  it("prefers eventAt over sampledAt for hook activity", () => {
    vi.useFakeTimers({ now: new Date("2026-06-19T01:00:00Z") });
    const activity: AgentActivitySummary = {
      state: "running",
      reason: "hook",
      evidenceSource: "runtime_hook",
      sampledAt: "2026-06-19T01:00:00Z",
      eventAt: "2026-06-19T00:56:00Z",
    };
    const result = getTimeInState(activity);
    expect(result).not.toBeNull();
    expect(result!.seconds).toBe(240);
    expect(result!.label).toBe("4m");
  });

  it("eventAt 4m-old + sampledAt=now shows 4m (does NOT reset on refetch)", () => {
    vi.useFakeTimers({ now: new Date("2026-06-19T01:00:00Z") });
    const activity: AgentActivitySummary = {
      state: "running",
      reason: "hook",
      evidenceSource: "runtime_hook",
      sampledAt: "2026-06-19T01:00:00Z",
      eventAt: "2026-06-19T00:56:00Z",
    };
    expect(getTimeInState(activity)!.seconds).toBe(240);
  });

  it("falls back to sampledAt when eventAt is absent (pane/session)", () => {
    vi.useFakeTimers({ now: new Date("2026-06-19T01:00:00Z") });
    const activity: AgentActivitySummary = {
      state: "idle",
      reason: "pane",
      evidenceSource: "pane_heuristic",
      sampledAt: "2026-06-19T00:58:00Z",
    };
    const result = getTimeInState(activity);
    expect(result).not.toBeNull();
    expect(result!.seconds).toBe(120);
    expect(result!.label).toBe("2m");
  });

  it("returns null for null activity", () => {
    expect(getTimeInState(null)).toBeNull();
  });

  it("formats hours correctly", () => {
    vi.useFakeTimers({ now: new Date("2026-06-19T03:00:00Z") });
    const activity: AgentActivitySummary = {
      state: "running",
      reason: "hook",
      evidenceSource: "runtime_hook",
      sampledAt: "2026-06-19T03:00:00Z",
      eventAt: "2026-06-19T01:30:00Z",
    };
    expect(getTimeInState(activity)!.label).toBe("1h 30m");
  });
});

describe("computeActivityRollup (FR-3)", () => {
  it("counts states correctly with no double-count", () => {
    const items = [
      { activity: { state: "running" as const, reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" }, terminalActive: true },
      { activity: { state: "running" as const, reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" }, terminalActive: true },
      { activity: { state: "idle" as const, reason: "x", evidenceSource: "pane_heuristic", sampledAt: "z" }, terminalActive: false },
      { activity: { state: "needs_input" as const, reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" }, terminalActive: null },
      { activity: { state: "unknown" as const, reason: "x", evidenceSource: "pane_heuristic", sampledAt: "z" }, terminalActive: null },
    ];
    const rollup = computeActivityRollup(items);
    expect(rollup.working).toBe(2);
    expect(rollup.idle).toBe(1);
    expect(rollup.needsInput).toBe(1);
    expect(rollup.needsInputHookGrade).toBe(1);
    expect(rollup.unknown).toBe(1);
    expect(rollup.total).toBe(5);
    expect(rollup.working + rollup.idle + rollup.needsInput + rollup.unknown).toBe(rollup.total);
  });

  it("formats rollup label with hook-grade needs_input as 'needs you'", () => {
    const rollup = { working: 3, idle: 2, needsInput: 1, needsInputHookGrade: 1, unknown: 0, total: 6 };
    expect(formatRollupLabel(rollup)).toBe("3 working · 2 idle · 1 needs you");
  });

  it("pane-grade needs_input labeled activity-grade in rollup (AC-4)", () => {
    const items = [
      { activity: { state: "needs_input" as const, reason: "hook", evidenceSource: "runtime_hook", sampledAt: "z" }, terminalActive: null },
      { activity: { state: "needs_input" as const, reason: "pane", evidenceSource: "pane_heuristic", sampledAt: "z" }, terminalActive: null },
      { activity: { state: "running" as const, reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" }, terminalActive: true },
    ];
    const rollup = computeActivityRollup(items);
    expect(rollup.needsInput).toBe(2);
    expect(rollup.needsInputHookGrade).toBe(1);
    const label = formatRollupLabel(rollup);
    expect(label).toContain("1 needs you");
    expect(label).toContain("1 needs input (activity-grade)");
    expect(label).not.toMatch(/2 needs you/);
  });
});

describe("AC-4 honesty regression", () => {
  it("pane_heuristic needs_input is NOT elevated as hook-grade", () => {
    const result = getActivityStateWithSource(
      { state: "needs_input", reason: "attention", evidenceSource: "pane_heuristic", sampledAt: "z" },
      null,
    );
    expect(result.state).toBe("needs_input");
    expect(result.source).not.toBe("hook");
    expect(isHookGradeNeedsInput(result)).toBe(false);
  });

  it("hook-grade needs_input requires source===hook", () => {
    const result = getActivityStateWithSource(
      { state: "needs_input", reason: "prompt", evidenceSource: "runtime_hook", sampledAt: "z" },
      null,
    );
    expect(result.source).toBe("hook");
    expect(isHookGradeNeedsInput(result)).toBe(true);
  });

  it("activity-needs-input cards are classified as synthetic (no seq collision)", () => {
    const card = needsInputSeatToFeedCard({
      logicalId: "dev.impl",
      sessionName: "dev-impl@rig",
      source: "hook",
      eventAt: "2026-06-19T00:00:00Z",
    });
    expect(isSyntheticFeedCard(card)).toBe(true);
    expect(card.source.seq).toBe(-1);
  });

  it("cross-rig logicalId collision produces distinct card ids", () => {
    const card1 = needsInputSeatToFeedCard({ logicalId: "dev.impl", source: "hook", rigId: "rig-a" });
    const card2 = needsInputSeatToFeedCard({ logicalId: "dev.impl", source: "hook", rigId: "rig-b" });
    expect(card1.id).not.toBe(card2.id);
    expect(card1.id).toContain("rig-a");
    expect(card2.id).toContain("rig-b");
  });

  it("eventDerivedSeqsForPrune excludes activity-needs-input cards", () => {
    const eventCard = { id: "evt-1", source: { seq: 42 } } as any;
    const needsInputCard = needsInputSeatToFeedCard({
      logicalId: "dev.impl",
      source: "hook",
    });
    const seqs = eventDerivedSeqsForPrune([eventCard, needsInputCard]);
    expect(seqs).toEqual([42]);
    expect(seqs).not.toContain(-1);
  });

  it("pane_heuristic needs_input is visible but activity-grade labeled", () => {
    const result = getActivityStateWithSource(
      { state: "needs_input", reason: "attention", evidenceSource: "pane_heuristic", sampledAt: "z" },
      null,
    );
    expect(result.state).toBe("needs_input");
    expect(result.source).toBe("pane_heuristic");
  });
});
