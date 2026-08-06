import { describe, it, expect, vi } from "vitest";
import { classifyDaemonState, resolveDaemonState, type HealthzProbeResult } from "../src/crash-cart/daemon-state.js";

// Crash-cart C3 — the daemon-state classifier (planner+PM ruling, honest-degraded false-negative rail).
// THREE states: UP (healthz answered) · DOWN (POSITIVE evidence only: pid dead/absent AND healthz
// connection-REFUSED) · UNVERIFIED (everything else — timeout, wedged, foreign occupant). The cockpit
// + C2 read fire ONLY on DOWN; a probe blip must NEVER fabricate a crash narrative. Single-shot; the
// bounded retry is the caller's. All probes injected → hermetic.

const deps = (over: Partial<Parameters<typeof classifyDaemonState>[0]> = {}) => ({
  openrigHome: "/scratch/.openrig",
  readDaemonJson: () => ({ pid: 9, port: 7433, host: "127.0.0.1" }),
  isProcessAlive: () => false,
  probeHealthz: async () => "refused" as const,
  openrigUrl: undefined as string | undefined,
  ...over,
});

describe("classifyDaemonState — 3-state honest-degraded rail", () => {
  it("UP when healthz answers (even if the recorded pid looks dead)", async () => {
    expect(await classifyDaemonState(deps({ probeHealthz: async () => "answered" }))).toBe("up");
  });

  it("DOWN only on POSITIVE evidence: pid dead AND healthz refused", async () => {
    expect(await classifyDaemonState(deps({ isProcessAlive: () => false, probeHealthz: async () => "refused" }))).toBe("down");
  });

  it("DOWN when there is no daemon.json AND healthz refused", async () => {
    expect(await classifyDaemonState(deps({ readDaemonJson: () => undefined, probeHealthz: async () => "refused" }))).toBe("down");
  });

  it("UNVERIFIED when the pid is alive but healthz refused (process exists, not serving — wedged/starting)", async () => {
    expect(await classifyDaemonState(deps({ isProcessAlive: () => true, probeHealthz: async () => "refused" }))).toBe("unverified");
  });

  it("UNVERIFIED on a healthz TIMEOUT (never DOWN — a blip must not fabricate a crash)", async () => {
    expect(await classifyDaemonState(deps({ isProcessAlive: () => false, probeHealthz: async () => "timeout" }))).toBe("unverified");
  });

  it("UNVERIFIED when a non-openrig process answers the port", async () => {
    expect(await classifyDaemonState(deps({ probeHealthz: async () => "not-openrig" }))).toBe("unverified");
  });

  it("probes OPENRIG_URL when set, else daemon.json host:port, else the default", async () => {
    const seen: string[] = [];
    const probe = async (url: string) => {
      seen.push(url);
      return "refused" as const;
    };
    await classifyDaemonState(deps({ openrigUrl: "http://foreign:8080", probeHealthz: probe }));
    await classifyDaemonState(deps({ readDaemonJson: () => ({ pid: 9, port: 9999, host: "10.0.0.5" }), probeHealthz: probe }));
    await classifyDaemonState(deps({ readDaemonJson: () => undefined, probeHealthz: probe }));
    expect(seen).toEqual([
      "http://foreign:8080/healthz",
      "http://10.0.0.5:9999/healthz",
      "http://127.0.0.1:7433/healthz",
    ]);
  });
});

describe("resolveDaemonState — bounded retry (injected clock; timeout never promotes to DOWN)", () => {
  function seq(results: HealthzProbeResult[]) {
    let i = 0;
    return async () => results[Math.min(i++, results.length - 1)]!;
  }
  const rdeps = (over: Partial<Parameters<typeof resolveDaemonState>[0]> = {}) => ({
    openrigHome: "/scratch/.openrig",
    readDaemonJson: () => ({ pid: 9, port: 7433, host: "127.0.0.1" }),
    isProcessAlive: () => false,
    probeHealthz: seq(["timeout"]),
    openrigUrl: undefined as string | undefined,
    sleep: vi.fn(async () => {}),
    maxProbes: 3,
    retryDelayMs: 400,
    ...over,
  });

  it("resolves UP on the first answered probe, no retry", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["answered"]), sleep }))).toBe("up");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("resolves DOWN immediately on refused + pid-dead (decisive, no retry)", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["refused"]), sleep }))).toBe("down");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries through a transient timeout then resolves UP", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["timeout", "answered"]), sleep }))).toBe("up");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("persistent timeout → UNVERIFIED after the bound (never DOWN), with maxProbes-1 sleeps", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["timeout"]), sleep, maxProbes: 3 }))).toBe("unverified");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
