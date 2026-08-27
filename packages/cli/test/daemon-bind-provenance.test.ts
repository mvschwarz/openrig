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
  const probeUp = (up: Set<string>) => async (url: string) => [...up].some((h) => url.includes(h));

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
