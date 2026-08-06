import { describe, it, expect } from "vitest";
import { buildCrashCartModel, type CrashCartDiscoveryInput } from "../src/crash-cart/crash-cart-model.js";
import { renderCrashCartView, renderUnverifiedView } from "../src/crash-cart/render-crash-cart.js";

// Crash-cart (rulings) — the two non-DOWN framings; content-level (the in-shell wrapping is covered by
// crash-cart-in-shell.test.ts):
//  UNVERIFIED = evidence verbatim + retry + quit, ZERO recovery actions.
//  FIRST-RUN = DOWN + no DB found (no rigs, no prior activity) → onboarding framing, NEVER a crash story.

describe("renderUnverifiedView — cannot-verify content (no recovery offered)", () => {
  const body = renderUnverifiedView({
    pidState: "alive (pid 4242)",
    probeResult: "timeout",
    failedSignal: "healthz timed out after 3 probes",
  })
    .map((l) => l.text)
    .join("\n");

  it("names it NOT-confirmed-down and shows the evidence verbatim", () => {
    expect(body).toContain("cannot verify the daemon");
    expect(body.toLowerCase()).toContain("not confirmed down");
    expect(body).toContain("alive (pid 4242)");
    expect(body).toContain("timeout");
    expect(body).toContain("healthz timed out after 3 probes");
  });

  it("offers retry + quit + the rig-status hint, and NO recovery action", () => {
    expect(body).toContain("r retry");
    expect(body).toContain("q quit");
    expect(body).toContain("rig status");
    expect(body).not.toContain("RESTORE EVERYTHING");
  });
});

describe("buildCrashCartModel — first-run vs recovery mode", () => {
  const withRigs: CrashCartDiscoveryInput = {
    header: { lastActivityAt: "2026-08-06T08:12:00Z" },
    foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
    whereWorkStopped: [],
  };
  const empty: CrashCartDiscoveryInput = { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] };

  it("recovery mode when there is evidence of prior life (rigs and/or last activity)", () => {
    expect(buildCrashCartModel(withRigs).mode).toBe("recovery");
  });

  it("first-run mode when no rigs AND no prior activity (DOWN + no DB)", () => {
    expect(buildCrashCartModel(empty).mode).toBe("first-run");
  });
});

describe("renderCrashCartView — first-run framing is onboarding, never a crash story", () => {
  const firstRun = buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] });
  const body = renderCrashCartView(firstRun).map((l) => l.text).join("\n");

  it("shows onboarding framing, no crash header, no RESTORE-of-nothing", () => {
    expect(body).not.toContain("daemon not running");
    expect(body).not.toContain("RESTORE EVERYTHING");
    expect(body.toLowerCase()).toContain("onboarding");
    expect(body.toLowerCase()).toMatch(/no rigs|first|nothing to restore|welcome|new here/);
  });

  it("recovery framing still shows the crash header + RESTORE (unchanged)", () => {
    const rec = buildCrashCartModel({
      header: { lastActivityAt: "2026-08-06T08:12:00Z" },
      foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
      whereWorkStopped: [],
    });
    const rb = renderCrashCartView(rec).map((l) => l.text).join("\n");
    expect(rb).toContain("◌ daemon not running");
    expect(rb).toContain("⏎ RESTORE EVERYTHING");
  });
});
