// OPR.0.4.3.19 forward-fix — the activity DOT (getActivityStateWithSource)
// must consume the liveness identity verdict, not silently ignore it. A
// mismatch/pane_missing verdict overrides output-derived activity so a
// dead/orphaned/squatted pane never renders active/running green — even when
// the (orphan's) tmux output makes terminalActive true (the visible
// false-green the guard blocked).

import { describe, it, expect } from "vitest";
import {
  getActivityState,
  getActivityStateWithSource,
  identityVerdictDownranksRunning,
} from "../src/lib/activity-visuals.js";
import type { AgentActivitySummary, SeatIdentityVerdictSummary } from "../src/hooks/useNodeInventory.js";

const freshHookRunning: AgentActivitySummary = {
  state: "running",
  reason: "user_prompt",
  evidenceSource: "runtime_hook",
  sampledAt: "2026-07-02T12:00:00.000Z",
  stale: false,
  fallback: false,
};

function v(kind: SeatIdentityVerdictSummary["verdict"]): SeatIdentityVerdictSummary {
  return { verdict: kind, reason: kind === "mismatch" ? "process_identity_mismatch" : null };
}

describe("identityVerdictDownranksRunning", () => {
  it("only mismatch/pane_missing down-rank; verified/tmux_unavailable/absent do not", () => {
    expect(identityVerdictDownranksRunning(v("mismatch"))).toBe(true);
    expect(identityVerdictDownranksRunning(v("pane_missing"))).toBe(true);
    expect(identityVerdictDownranksRunning(v("verified"))).toBe(false);
    expect(identityVerdictDownranksRunning(v("tmux_unavailable"))).toBe(false);
    expect(identityVerdictDownranksRunning(null)).toBe(false);
    expect(identityVerdictDownranksRunning(undefined)).toBe(false);
  });
});

describe("getActivityStateWithSource identity gate (no false-green dot)", () => {
  it("PRIMARY — mismatch + terminalActive=true → NON-GREEN (needs_input), NOT running", () => {
    const r = getActivityStateWithSource(null, true, v("mismatch"));
    expect(r.state).toBe("needs_input");
    expect(r.state).not.toBe("running");
  });

  it("mismatch overrides even a fresh runtime-hook 'running'", () => {
    const r = getActivityStateWithSource(freshHookRunning, true, v("mismatch"));
    expect(r.state).toBe("needs_input");
  });

  it("pane_missing + terminalActive=true → NON-GREEN, NOT running", () => {
    expect(getActivityStateWithSource(null, true, v("pane_missing")).state).toBe("needs_input");
  });

  it("verified verdict does NOT down-rank — terminalActive=true still renders running (no-regression)", () => {
    expect(getActivityStateWithSource(null, true, v("verified")).state).toBe("running");
  });

  it("absent verdict preserves existing behavior (no-regression)", () => {
    expect(getActivityState(null, true)).toBe("running");
    expect(getActivityState(freshHookRunning, false)).toBe("running");
  });
});
