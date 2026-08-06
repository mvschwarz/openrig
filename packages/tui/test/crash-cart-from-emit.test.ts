import { describe, it, expect } from "vitest";
import { crashCartRenderOpts, probeCrashCart, type CrashCartEmit } from "../src/crash-cart/from-emit.js";

// Crash-cart C3 unit-C — map the `rig crash-cart --json` verdict → the renderScreen daemon-down opts.
// DOWN+discovery → the cockpit; UNVERIFIED+evidence → the cannot-verify screen; UP → normal TUI. Rail 3:
// a DOWN+refusal (the read fail-closed because a daemon answered) NEVER renders the cockpit → normal TUI.

describe("crashCartRenderOpts — verdict → render opts", () => {
  it("DOWN + discovery → daemonState down + a built cockpit model", () => {
    const emit: CrashCartEmit = {
      state: "down",
      discovery: {
        header: { lastActivityAt: "2026-08-06T08:12:00Z" },
        foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
        whereWorkStopped: [],
      },
    };
    const o = crashCartRenderOpts(emit);
    expect(o.daemonState).toBe("down");
    expect(o.crashCart?.foundOnHost[0]?.name).toBe("alpha");
    expect(o.crashCart?.header.lastSeen).toBe("08:12");
  });

  it("UNVERIFIED + evidence → daemonState unverified + the evidence", () => {
    const o = crashCartRenderOpts({ state: "unverified", evidence: { pidState: "alive", probeResult: "timeout", failedSignal: "x" } });
    expect(o.daemonState).toBe("unverified");
    expect(o.daemonEvidence?.probeResult).toBe("timeout");
    expect(o.crashCart).toBeUndefined();
  });

  it("UP → normal TUI (no daemon-down opts)", () => {
    expect(crashCartRenderOpts({ state: "up" })).toEqual({});
  });

  it("DOWN + refusal → normal TUI, NEVER the cockpit (rail 3: a refusal means a daemon answered)", () => {
    const o = crashCartRenderOpts({ state: "down", refusal: "a daemon answered /healthz — refusing the direct read" });
    expect(o).toEqual({});
    expect(o.daemonState).toBeUndefined();
  });
});

describe("probeCrashCart — run the verb + map; failures never fabricate a cockpit", () => {
  it("maps valid verb JSON to opts", async () => {
    const o = await probeCrashCart(async () => JSON.stringify({ state: "unverified", evidence: { pidState: "p", probeResult: "timeout", failedSignal: "s" } }));
    expect(o.daemonState).toBe("unverified");
  });
  it("verb errors → normal TUI ({})", async () => {
    expect(await probeCrashCart(async () => { throw new Error("spawn failed"); })).toEqual({});
  });
  it("unparseable output → normal TUI ({})", async () => {
    expect(await probeCrashCart(async () => "not json")).toEqual({});
  });
});
