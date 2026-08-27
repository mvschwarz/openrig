import { describe, it, expect } from "vitest";
import { buildDaemonEnv, resolveBindIntent, verifyRequiredListeners } from "../src/daemon-lifecycle.js";

// OPR.0.5.5.20 — injected routing environment must never silently become daemon bind
// policy. Three seams pinned here: the env-construction passthrough (the incident's
// route B), the config-resolver intent seam (route A: ENV_MAP maps daemon.host ←
// OPENRIG_HOST, so injected env read as source="env"), and the restored listener gate.

describe("S20 — buildDaemonEnv: routing env never crosses into the daemon", () => {
  it("INCIDENT (route B): inherited OPENRIG_HOST/RIGGED_HOST from a managed environment are SCRUBBED when no intent is declared", () => {
    const env = buildDaemonEnv(
      { HOME: "/Users/op", PATH: "/bin", OPENRIG_HOST: "127.0.0.1", RIGGED_HOST: "127.0.0.1" },
      { port: 7433, db: "/tmp/t.db" }, // opts.host undefined = no operator opt-in
    );
    expect(env["OPENRIG_HOST"]).toBeUndefined();  // candidate at base: "127.0.0.1" — the outage
    expect(env["RIGGED_HOST"]).toBeUndefined();
    expect(env["OPENRIG_BIND_HOST"]).toBeUndefined();
    expect(env["HOME"]).toBe("/Users/op"); // ordinary passthrough untouched
  });

  it("declared intent exports the DEDICATED bind env plus a COHERENT routing env (seats route where the daemon binds)", () => {
    const env = buildDaemonEnv(
      { HOME: "/Users/op", OPENRIG_HOST: "10.0.0.9" }, // stale inherited routing is still ignored
      { port: 7433, host: "100.95.124.51", db: "/tmp/t.db" },
    );
    expect(env["OPENRIG_BIND_HOST"]).toBe("100.95.124.51");
    expect(env["OPENRIG_HOST"]).toBe("100.95.124.51"); // the routing half follows the DECLARED intent
  });

  it("an inherited OPENRIG_BIND_HOST passes through — the dedicated surface IS unambiguous operator opt-in", () => {
    const env = buildDaemonEnv(
      { HOME: "/Users/op", OPENRIG_BIND_HOST: "100.95.124.51" },
      { port: 7433, db: "/tmp/t.db" },
    );
    expect(env["OPENRIG_BIND_HOST"]).toBe("100.95.124.51");
  });
});

describe("S20 — resolveBindIntent (route A): the config resolver's env source never creates intent", () => {
  const cfg = { configHost: "127.0.0.1" };

  it("daemon.host resolved from ENV (the ENV_MAP ← OPENRIG_HOST overload) is NOT intent", () => {
    const r = resolveBindIntent({ flagHost: undefined, envBindHost: undefined, configSource: "env", ...cfg });
    expect(r.explicit).toBe(false);
    expect(r.host).toBeUndefined();
  });

  it("the --host flag, a FILE-sourced daemon.host, and OPENRIG_BIND_HOST each create intent", () => {
    expect(resolveBindIntent({ flagHost: "100.1.1.1", envBindHost: undefined, configSource: "default", ...cfg }))
      .toEqual({ explicit: true, host: "100.1.1.1" });
    expect(resolveBindIntent({ flagHost: undefined, envBindHost: undefined, configSource: "file", ...cfg }))
      .toEqual({ explicit: true, host: "127.0.0.1" });
    expect(resolveBindIntent({ flagHost: undefined, envBindHost: "100.2.2.2", configSource: "default", ...cfg }))
      .toEqual({ explicit: true, host: "100.2.2.2" });
  });

  it("no dedicated surface at all → no intent (the daemon's default multi-bind governs)", () => {
    expect(resolveBindIntent({ flagHost: undefined, envBindHost: undefined, configSource: "default", ...cfg }))
      .toEqual({ explicit: false, host: undefined });
  });
});

describe("S20 — the restored listener gate: adoption fails loudly on a dropped listener", () => {
  // r2 re-review repair: the probe is TRI-STATE — "healthy" | "unhealthy" |
  // "indeterminate". Positive bad-bind evidence (refused connection / explicit
  // unhealthy answer) may kill; a transient probe exception (timeout etc.) is
  // INDETERMINATE and must never be promoted to missing-listener evidence.
  const probeUp = (up: Set<string>) => async (url: string) =>
    [...up].some((h) => url.includes(h)) ? ("healthy" as const) : ("unhealthy" as const);

  it("0.5.3 REGRESSION SHAPE: default mode with tailscale detected but only loopback bound → LOUD failure naming the missing listener", async () => {
    const r = await verifyRequiredListeners({
      bind: { mode: "default", hosts: ["127.0.0.1"], tailscaleDetected: true },
      port: 7433,
      probe: probeUp(new Set(["127.0.0.1"])),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/listener/i);
    expect(r.reason).toMatch(/tailscale/i);
  });

  it("default mode, both listeners bound and probed → pass with each verified by its own healthz", async () => {
    const r = await verifyRequiredListeners({
      bind: { mode: "default", hosts: ["127.0.0.1", "100.95.124.60"], tailscaleDetected: true },
      port: 7433,
      probe: probeUp(new Set(["127.0.0.1", "100.95.124.60"])),
    });
    expect(r).toEqual({ ok: true, verified: ["127.0.0.1", "100.95.124.60"] });
  });

  it("a REPORTED host whose probe fails is a missing listener — binding evidence beats config echo", async () => {
    const r = await verifyRequiredListeners({
      bind: { mode: "default", hosts: ["127.0.0.1", "100.95.124.60"], tailscaleDetected: true },
      port: 7433,
      probe: probeUp(new Set(["127.0.0.1"])), // reported but unreachable
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toContain("100.95.124.60");
  });

  it("r2 REPAIR: a one-shot probe EXCEPTION is INDETERMINATE — never promoted to missing-listener evidence", async () => {
    let tailAttempts = 0;
    const r = await verifyRequiredListeners({
      bind: { mode: "default", hosts: ["127.0.0.1", "100.64.0.9"], tailscaleDetected: true },
      port: 7433,
      probe: async (url) => {
        if (url.includes("100.64.0.9")) {
          tailAttempts++;
          return "indeterminate"; // the wiring maps a thrown timeout here — provenance preserved
        }
        return "healthy";
      },
    });
    expect(tailAttempts).toBe(1);
    expect(r.ok).toBe("indeterminate"); // NOT false — no SIGTERM evidence exists
    if (r.ok === "indeterminate") expect(r.reason).toMatch(/indeterminate|could not be checked/i);
  });

  it("explicit mode requires exactly the declared host", async () => {
    const ok = await verifyRequiredListeners({
      bind: { mode: "explicit", hosts: ["100.95.124.51"], tailscaleDetected: true },
      port: 7433,
      probe: probeUp(new Set(["100.95.124.51"])),
    });
    expect(ok.ok).toBe(true);
    const bad = await verifyRequiredListeners({
      bind: { mode: "explicit", hosts: ["100.95.124.51"], tailscaleDetected: false },
      port: 7433,
      probe: probeUp(new Set()),
    });
    expect(bad.ok).toBe(false);
  });
});

// ── r2 re-review repair: the gate at the START level — probe error PROVENANCE ──
// A transient probe exception on a newly started daemon must never SIGTERM it;
// only positive bad-bind evidence (refused connection / explicit unhealthy) kills.
import { startDaemon, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { vi } from "vitest";

function gateDeps(tailBehavior: (attempt: number) => "ok" | "throw-timeout" | "throw-refused") {
  let tailAttempts = 0;
  let spawned = false;
  const kill = vi.fn(() => true);
  const bindBody = { bind: { mode: "default", hosts: ["127.0.0.1", "100.64.0.9"], tailscaleDetected: true } };
  const deps: LifecycleDeps = {
    spawn: vi.fn(() => { spawned = true; return { pid: 4242, unref: vi.fn() } as never; }),
    fetch: vi.fn(async (url: string) => {
      if (!spawned) throw new Error("connect ECONNREFUSED (nothing on the port yet)");
      if (url.includes("100.64.0.9")) {
        tailAttempts++;
        const behavior = tailBehavior(tailAttempts);
        if (behavior === "throw-timeout") throw new Error("fetch timeout while probing");
        if (behavior === "throw-refused") {
          const err = new Error("fetch failed") as Error & { cause?: { code: string } };
          err.cause = { code: "ECONNREFUSED" };
          throw err;
        }
      }
      return { ok: true, json: async () => bindBody } as never;
    }) as never,
    kill,
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
  return { deps, kill, tailAttempts: () => tailAttempts };
}

describe("S20 r2 repair — startDaemon gate: transient probe failure never kills a healthy daemon", () => {
  it("CONTROL: a one-shot probe TIMEOUT resolves the start WITHOUT SIGTERM (indeterminate, not evidence)", async () => {
    const { deps, kill } = gateDeps((attempt) => (attempt === 1 ? "throw-timeout" : "ok"));
    const state = await startDaemon({ port: 7433, db: "/tmp/t.db" }, deps);
    expect(state.pid).toBe(4242);
    expect(kill).not.toHaveBeenCalled(); // the reviewer's reproduction: candidate killed here
  });

  it("positive evidence still kills: a REFUSED tailscale listener SIGTERMs and fails loudly", async () => {
    const { deps, kill } = gateDeps(() => "throw-refused");
    await expect(startDaemon({ port: 7433, db: "/tmp/t.db" }, deps)).rejects.toThrow(/listener adoption gate/);
    expect(kill).toHaveBeenCalled();
  });
});
