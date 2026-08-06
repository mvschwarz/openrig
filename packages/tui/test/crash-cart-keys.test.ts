import { describe, it, expect } from "vitest";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";
import type { CrashCartRenderOpts } from "../src/crash-cart/from-emit.js";
import type { CrashCartModel } from "../src/crash-cart/crash-cart-model.js";

// Crash-cart C3 follow-on — the cockpit action keys, gated on a daemon-down screen being active. The
// RESOLVER is pure (key + screen state → action); main.ts performs the action (exec / re-probe). RESTORE
// (⏎) routes to the C1 batch conductor — EXCLUDED this wave, so it resolves to a labeled seam, never a
// silent no-op. Keys differ by mode: recovery cockpit offers restore/inspect; first-run only onboarding+start.

const opts = (daemonState?: "down" | "unverified", mode?: CrashCartModel["mode"]): CrashCartRenderOpts =>
  daemonState === "down"
    ? { daemonState, crashCart: { mode: mode ?? "recovery", header: { lastSeen: "", uptimeText: "", reasonText: "" }, foundOnHost: [], whereWorkStopped: [] } }
    : daemonState === "unverified"
      ? { daemonState, daemonEvidence: { pidState: "", probeResult: "", failedSignal: "" } }
      : {};

describe("resolveCrashCartKey — cockpit action keys (gated on daemon-down)", () => {
  it("recovery cockpit: s/i/n/enter → start-daemon/inspect/onboarding/restore", () => {
    expect(resolveCrashCartKey("s", opts("down", "recovery"))).toBe("start-daemon");
    expect(resolveCrashCartKey("i", opts("down", "recovery"))).toBe("inspect");
    expect(resolveCrashCartKey("n", opts("down", "recovery"))).toBe("onboarding");
    expect(resolveCrashCartKey("enter", opts("down", "recovery"))).toBe("restore");
  });

  it("first-run: only start-daemon + onboarding (no restore-of-nothing, no inspect)", () => {
    expect(resolveCrashCartKey("s", opts("down", "first-run"))).toBe("start-daemon");
    expect(resolveCrashCartKey("n", opts("down", "first-run"))).toBe("onboarding");
    expect(resolveCrashCartKey("enter", opts("down", "first-run"))).toBeNull();
    expect(resolveCrashCartKey("i", opts("down", "first-run"))).toBeNull();
  });

  it("UNVERIFIED: r → retry (re-probe); no recovery actions", () => {
    expect(resolveCrashCartKey("r", opts("unverified"))).toBe("retry");
    expect(resolveCrashCartKey("s", opts("unverified"))).toBeNull();
    expect(resolveCrashCartKey("enter", opts("unverified"))).toBeNull();
  });

  it("normal TUI (no daemon-down screen): every key → null (keys fall through to normal handling)", () => {
    for (const k of ["s", "i", "n", "r", "enter"]) expect(resolveCrashCartKey(k, opts())).toBeNull();
  });
});
