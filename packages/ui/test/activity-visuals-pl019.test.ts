// PL-019: shared activity visual mapping. Pure logic — no React, no DOM.
// Validates the four-state palette + the staleness threshold + the
// running-only animation rule (per orch design guidance: pulses not
// blinking; needs_input is the static eye-catcher; idle/unknown are
// motion-free).

import { describe, it, expect } from "vitest";
import {
  getActivityState,
  getActivityStateWithSource,
  getActivityLabel,
  getActivityBgClass,
  getActivityTextClass,
  getActivityAnimationClass,
  isActivityStale,
  shortQitemTail,
  type ActivityState,
} from "../src/lib/activity-visuals.js";

const STATES: ActivityState[] = ["running", "needs_input", "idle", "unknown"];

describe("PL-019 activity-visuals", () => {
  describe("getActivityState", () => {
    it("returns 'unknown' when activity is null/undefined", () => {
      expect(getActivityState(null)).toBe("unknown");
      expect(getActivityState(undefined)).toBe("unknown");
    });

    it("returns the state from the activity payload", () => {
      for (const state of STATES) {
        expect(getActivityState({ state, reason: "x", evidenceSource: "y", sampledAt: "z" })).toBe(state);
      }
    });
  });

  describe("getActivityLabel / getActivityBgClass / getActivityTextClass", () => {
    it("provides a non-empty label for every state", () => {
      for (const state of STATES) {
        expect(getActivityLabel(state).length).toBeGreaterThan(0);
      }
    });

    it("running uses warm green/teal (emerald-500)", () => {
      expect(getActivityBgClass("running")).toBe("bg-emerald-500");
    });

    it("needs_input uses the eye-catcher amber-500 (the one state designed to grab attention)", () => {
      expect(getActivityBgClass("needs_input")).toBe("bg-amber-500");
    });

    it("idle uses calm cool slate (no warm attention-grabbing)", () => {
      expect(getActivityBgClass("idle")).toBe("bg-slate-400");
    });

    it("unknown uses desaturated stone (ignorable)", () => {
      expect(getActivityBgClass("unknown")).toBe("bg-stone-300");
    });

    it("text classes mirror bg classes with -600/-500/-400 contrast", () => {
      expect(getActivityTextClass("running")).toBe("text-emerald-600");
      expect(getActivityTextClass("needs_input")).toBe("text-amber-600");
      expect(getActivityTextClass("idle")).toBe("text-slate-500");
      expect(getActivityTextClass("unknown")).toBe("text-stone-400");
    });
  });

  describe("getActivityAnimationClass", () => {
    it("running gets the slow-pulse class (subtle, not flashy)", () => {
      expect(getActivityAnimationClass("running")).toBe("activity-pulse-running");
    });

    it("needs_input does NOT animate — it grabs attention via static color (per orch design)", () => {
      expect(getActivityAnimationClass("needs_input")).toBe("");
    });

    it("idle and unknown never animate (no motion)", () => {
      expect(getActivityAnimationClass("idle")).toBe("");
      expect(getActivityAnimationClass("unknown")).toBe("");
    });
  });

  describe("isActivityStale", () => {
    it("returns false when activity is null/undefined", () => {
      expect(isActivityStale(null)).toBe(false);
      expect(isActivityStale(undefined)).toBe(false);
    });

    it("returns true when explicit staleness exceeds threshold (~30s)", () => {
      expect(isActivityStale({ state: "idle", reason: "x", evidenceSource: "y", sampledAt: "2026-05-04T00:00:00.000Z", staleness: 60 })).toBe(true);
    });

    it("returns false when explicit staleness is within threshold", () => {
      expect(isActivityStale({ state: "idle", reason: "x", evidenceSource: "y", sampledAt: "2026-05-04T00:00:00.000Z", staleness: 5 })).toBe(false);
    });

    it("falls back to age-from-sampledAt when staleness is missing", () => {
      const longAgo = new Date(Date.now() - 120_000).toISOString();
      expect(isActivityStale({ state: "idle", reason: "x", evidenceSource: "y", sampledAt: longAgo })).toBe(true);
    });

    it("returns false for fresh sampledAt without explicit staleness", () => {
      const fresh = new Date(Date.now() - 1_000).toISOString();
      expect(isActivityStale({ state: "running", reason: "x", evidenceSource: "y", sampledAt: fresh })).toBe(false);
    });
  });

  describe("dot fallback precedence matrix (OPR.0.4.0.18)", () => {
    it("fresh hook running wins over terminalActive=false", () => {
      const r = getActivityStateWithSource({ state: "running", reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" }, false);
      expect(r).toEqual({ state: "running", source: "hook" });
    });

    it("fresh hook needs_input wins over terminalActive=true", () => {
      const r = getActivityStateWithSource({ state: "needs_input", reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" }, true);
      expect(r).toEqual({ state: "needs_input", source: "hook" });
    });

    it("stale/unknown hook + terminalActive=true => running from terminal_activity", () => {
      const r = getActivityStateWithSource({ state: "unknown", reason: "stale_runtime_hook", evidenceSource: "runtime_hook", sampledAt: "z", stale: true }, true);
      expect(r).toEqual({ state: "running", source: "terminal_activity" });
    });

    it("stale/unknown hook + terminalActive=false => idle from terminal_activity", () => {
      const r = getActivityStateWithSource({ state: "unknown", reason: "stale_runtime_hook", evidenceSource: "runtime_hook", sampledAt: "z", stale: true }, false);
      expect(r).toEqual({ state: "idle", source: "terminal_activity" });
    });

    it("no hook (null) + terminalActive=true => running from terminal_activity", () => {
      const r = getActivityStateWithSource(null, true);
      expect(r).toEqual({ state: "running", source: "terminal_activity" });
    });

    it("no hook (null) + terminalActive=false => idle from terminal_activity", () => {
      const r = getActivityStateWithSource(null, false);
      expect(r).toEqual({ state: "idle", source: "terminal_activity" });
    });

    it("no hook + terminalActive=null => unknown from none", () => {
      const r = getActivityStateWithSource(null, null);
      expect(r).toEqual({ state: "unknown", source: "none" });
    });

    it("NEVER emits needs_input from terminal_activity fallback", () => {
      for (const ta of [true, false, null, undefined]) {
        const r = getActivityStateWithSource(null, ta);
        if (r.source === "terminal_activity") {
          expect(r.state).not.toBe("needs_input");
        }
        const r2 = getActivityStateWithSource({ state: "unknown", reason: "x", evidenceSource: "y", sampledAt: "z" }, ta);
        if (r2.source === "terminal_activity") {
          expect(r2.state).not.toBe("needs_input");
        }
      }
    });

    it("pane_heuristic running + terminalActive=true => terminal_activity (not hook)", () => {
      const r = getActivityStateWithSource(
        { state: "running", reason: "x", evidenceSource: "pane_heuristic", sampledAt: "z" },
        true,
      );
      expect(r).toEqual({ state: "running", source: "terminal_activity" });
    });

    it("pane_heuristic idle + terminalActive=false => terminal_activity (not hook)", () => {
      const r = getActivityStateWithSource(
        { state: "idle", reason: "x", evidenceSource: "pane_heuristic", sampledAt: "z" },
        false,
      );
      expect(r).toEqual({ state: "idle", source: "terminal_activity" });
    });

    it("pane_heuristic running + terminalActive=null => source pane_heuristic (not hook)", () => {
      const r = getActivityStateWithSource(
        { state: "running", reason: "x", evidenceSource: "pane_heuristic", sampledAt: "z" },
        null,
      );
      expect(r).toEqual({ state: "running", source: "pane_heuristic" });
    });

    it("unknown pane_heuristic + terminalActive=null => source none (not hook)", () => {
      const r = getActivityStateWithSource(
        { state: "unknown", reason: "capture_failed", evidenceSource: "pane_heuristic", sampledAt: "z" },
        null,
      );
      expect(r.source).not.toBe("hook");
      expect(r).toEqual({ state: "unknown", source: "none" });
    });

    it("unknown runtime_hook (stale) + terminalActive=null => source hook", () => {
      const r = getActivityStateWithSource(
        { state: "unknown", reason: "stale_runtime_hook", evidenceSource: "runtime_hook", sampledAt: "z", stale: true },
        null,
      );
      expect(r).toEqual({ state: "unknown", source: "hook" });
    });

    it("runtime_hook running always source=hook regardless of terminalActive", () => {
      const r = getActivityStateWithSource(
        { state: "running", reason: "x", evidenceSource: "runtime_hook", sampledAt: "z" },
        false,
      );
      expect(r).toEqual({ state: "running", source: "hook" });
    });

    it("backward compat: single-arg getActivityState still works", () => {
      expect(getActivityState(null)).toBe("unknown");
      expect(getActivityState({ state: "running", reason: "x", evidenceSource: "y", sampledAt: "z" })).toBe("running");
    });
  });

  describe("shortQitemTail", () => {
    it("returns the last 8 chars for normal ULID-tail qitem ids", () => {
      expect(shortQitemTail("qitem-20260504001234-abcd1234")).toBe("abcd1234");
    });

    it("returns the full id verbatim when shorter than 8 chars", () => {
      expect(shortQitemTail("q-1")).toBe("q-1");
    });
  });
});
