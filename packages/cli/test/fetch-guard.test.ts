// P37 — request-layer hermeticity guard at globalThis.fetch. The permit rule is a
// SHAPE, not a registry: loopback (127.0.0.1 / ::1 / localhost) on an EPHEMERAL high
// port — exactly what server.listen(0) produces — is PERMITTED with zero registration;
// everything else is REFUSED (fail-closed default). allowFetchTarget stays as the
// escape hatch for a fixture that needs a fixed low port.
//
// THREE known-negatives (dev50-planner pins + the machine-boundary arm) — a guard
// proven only refusing is indistinguishable from a blanket denier broken in the safe
// direction: REFUSES the canonical daemon; PERMITS a loopback-ephemeral fixture;
// REFUSES a non-loopback target.
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

// The guard is installed by the shared setup (hermetic-env.setup.ts) for every file.
describe("fetch guard — allowlist by shape, fail-closed, three-sided", () => {
  afterEach(() => resetFetchAllowlist());

  it("REFUSES the canonical daemon target (:7433, both host forms) — the escape", async () => {
    await expect(fetch("http://localhost:7433/api/queue/x/update")).rejects.toThrow(/FETCH GUARD|daemon/i);
    await expect(fetch("http://127.0.0.1:7433/healthz")).rejects.toThrow(/FETCH GUARD|daemon/i);
  });

  it("PERMITS a loopback-ephemeral fixture BY SHAPE (server.listen(0), no registration)", async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`); // NOT registered — permitted by shape
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it("REFUSES a NON-LOOPBACK target (the machine-boundary arm — hosts.yaml's real remote)", async () => {
    await expect(fetch("http://100.95.124.51:7433/api/x")).rejects.toThrow(/FETCH GUARD|non-loopback/i);
  });

  it("FAILS CLOSED on a loopback WELL-KNOWN/low port (< ephemeral) that is not registered", async () => {
    await expect(fetch("http://127.0.0.1:8080/anything")).rejects.toThrow(/FETCH GUARD/i);
  });

  it("ESCAPE HATCH: allowFetchTarget PERMITS a fixed low-port fixture (the guard delegates; a real ECONNREFUSED is NOT the guard)", async () => {
    allowFetchTarget("http://127.0.0.1:8123");
    const err = await fetch("http://127.0.0.1:8123/x").then(() => null).catch((e) => e as Error);
    expect(err).not.toBeNull();
    expect(String(err?.message ?? "")).not.toMatch(/FETCH GUARD/); // permitted → real fetch's connection error, not the guard
  });

  it("a registered / loopback-ephemeral fixture does NOT widen the allowlist to the daemon", async () => {
    allowFetchTarget("http://127.0.0.1:8123");
    await expect(fetch("http://localhost:7433/api/x")).rejects.toThrow(/FETCH GUARD|daemon/i);
  });
});
