import { describe, it, expect, vi } from "vitest";
import { emitCrashCartState } from "../src/domain/crash-cart-emit.js";

// Crash-cart C3 — emitCrashCartState is the SSOT for the `rig crash-cart --json` payload (rail 3: ONE
// JSON = the 3-state verdict + discovery). It composes the detector + the C2 read VERBATIM (rail 2).
// A fail-closed refusal of the read emits STRUCTURED JSON (a refusal note, NO discovery) so the TUI
// never renders the cockpit from a refusal. The sub-steps are injected → deterministic.

const deps = (over: Partial<Parameters<typeof emitCrashCartState>[0]> = {}) => ({
  resolveState: async () => "down" as const,
  assembleEvidence: async () => ({ pidState: "dead", probeResult: "refused", failedSignal: "connection refused" }),
  loadDiscovery: async () => ({ header: { lastActivityAt: null, lastBootAt: null, firstBootAt: null, hostId: null, stopReason: null, priorUptimeMs: null }, foundOnHost: [], whereWorkStopped: [] }),
  ...over,
});

describe("emitCrashCartState — the verb's JSON verdict", () => {
  it("UP → just the state (no evidence, no discovery, no read attempted)", async () => {
    const loadDiscovery = vi.fn(deps().loadDiscovery);
    const out = await emitCrashCartState(deps({ resolveState: async () => "up", loadDiscovery }));
    expect(out).toEqual({ state: "up" });
    expect(loadDiscovery).not.toHaveBeenCalled();
  });

  it("UNVERIFIED → state + evidence, NO discovery (read not attempted)", async () => {
    const loadDiscovery = vi.fn(deps().loadDiscovery);
    const out = await emitCrashCartState(deps({ resolveState: async () => "unverified", loadDiscovery }));
    expect(out.state).toBe("unverified");
    expect(out.evidence).toEqual({ pidState: "dead", probeResult: "refused", failedSignal: "connection refused" });
    expect(out.discovery).toBeUndefined();
    expect(loadDiscovery).not.toHaveBeenCalled();
  });

  it("DOWN + read succeeds → state + discovery", async () => {
    const out = await emitCrashCartState(deps({ resolveState: async () => "down" }));
    expect(out.state).toBe("down");
    expect(out.discovery).toBeTruthy();
    expect(out.refusal).toBeUndefined();
  });

  it("DOWN + read REFUSES → structured refusal (note, NO discovery — TUI won't render the cockpit)", async () => {
    const out = await emitCrashCartState(
      deps({
        resolveState: async () => "down",
        loadDiscovery: async () => {
          throw new Error("a daemon answered /healthz — refusing the direct read");
        },
      }),
    );
    expect(out.state).toBe("down");
    expect(out.discovery).toBeUndefined();
    expect(out.refusal).toContain("refusing the direct read");
  });
});
