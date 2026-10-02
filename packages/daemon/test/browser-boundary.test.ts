import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  browserBoundary,
  discoverTailscaleSelfNames,
  osOwnNames,
  parseHostHeader,
  parseOrigin,
  type BrowserBoundaryOptions,
} from "../src/middleware/browser-boundary.js";

const SELF = "openrig-vm.taile8a08.ts.net";

function guarded(opts: Partial<BrowserBoundaryOptions> = {}) {
  const lines: string[] = [];
  const decisions: Array<{ outcome: string; code?: string }> = [];
  let hits = 0;
  const app = new Hono();
  app.use("/api/*", browserBoundary({
    webUiEnabled: false,
    bearerTokens: [],
    hostName: () => "Box-1.local",
    warn: (line) => lines.push(line),
    onDecision: (d) => decisions.push(d),
    ...opts,
  }));
  app.all("/api/*", (c) => { hits++; return c.json({ ok: true }); });
  const send = async (h: { host?: string; origin?: string; auth?: string; method?: string; path?: string }) => {
    const headers: Record<string, string> = {};
    if (h.host !== undefined) headers["Host"] = h.host;
    if (h.origin !== undefined) headers["Origin"] = h.origin;
    if (h.auth !== undefined) headers["Authorization"] = h.auth;
    const res = await app.request(h.path ?? "/api/ps", { method: h.method ?? "GET", headers });
    return { status: res.status, body: await res.json() as { error?: string; code?: string } };
  };
  return { send, lines, decisions, hits: () => hits };
}

describe("parsing and normalization", () => {
  it("parses Host: case, trailing dot, IPv6, default and explicit ports, malformed forms", () => {
    expect(parseHostHeader(undefined)).toEqual({ kind: "absent" });
    expect(parseHostHeader("LOCALHOST.:7433")).toEqual({ kind: "ok", hostname: "localhost", port: "7433" });
    expect(parseHostHeader("[::1]:7433")).toEqual({ kind: "ok", hostname: "::1", port: "7433" });
    expect(parseHostHeader("example.test")).toEqual({ kind: "ok", hostname: "example.test", port: "80" });
    for (const bad of ["", "a b", "x@y", "host/path", "[zz]:1", "h:99999", "h:0", "a,b", "a, b", "h:"]) {
      expect(parseHostHeader(bad)).toEqual({ kind: "malformed" });
    }
  });

  it("parses Origin: null is opaque, paths/userinfo/lists are malformed, default ports resolve", () => {
    expect(parseOrigin("null")).toEqual({ kind: "opaque" });
    expect(parseOrigin("http://LOCALHOST.:7433")).toEqual({ kind: "ok", scheme: "http", hostname: "localhost", port: "7433" });
    expect(parseOrigin("http://localhost")).toEqual({ kind: "ok", scheme: "http", hostname: "localhost", port: "80" });
    expect(parseOrigin("https://x.test")).toEqual({ kind: "ok", scheme: "https", hostname: "x.test", port: "443" });
    for (const bad of ["not a url", "http://localhost:7433/x", "http://u:p@localhost", "http://a, http://b", "", "http://h?q=1"]) {
      expect(parseOrigin(bad)).toEqual({ kind: "malformed" });
    }
  });

  it("derives OS own names: full, first label, and .local", () => {
    expect(osOwnNames(() => "Box-1.local")).toEqual(["box-1.local", "box-1"]);
    expect(osOwnNames(() => "studio")).toEqual(["studio", "studio.local"]);
  });
});

describe("target-name rule", () => {
  it("accepts absent Host, loopback, IPv4/IPv6 literals and OS own names", async () => {
    const g = guarded();
    for (const host of [undefined, "localhost:7433", "LOCALHOST.:7433", "127.0.0.1:7433", "[::1]:7433",
      "100.106.37.120:7433", "[::ffff:127.0.0.1]:7433", "192.168.1.5", "box-1.local:7433", "box-1:7433", "BOX-1.LOCAL."]) {
      expect((await g.send({ host })).status, String(host)).toBe(200);
    }
    expect(g.hits()).toBe(11);
  });

  it("refuses unknown, peer-suffix and malformed names with zero handler effects", async () => {
    const g = guarded({ discoverSelfNames: async () => [SELF] });
    await new Promise((r) => setTimeout(r, 10));
    for (const host of ["evil.example:7433", "other-vm.taile8a08.ts.net:7433", "taile8a08.ts.net", `${SELF}.evil.example`]) {
      const r = await g.send({ host });
      expect(r.status, host).toBe(403);
      expect(r.body.code).toBe("untrusted_host");
      expect(r.body.error).toContain("OPENRIG_ALLOWED_HOSTS");
    }
    for (const host of ["a b", "x@y", "h:99999", "a, b"]) {
      expect((await g.send({ host })).body.code, host).toBe("untrusted_host");
    }
    expect(g.hits()).toBe(0);
  });

  it("accepts the exact discovered self MagicDNS name and its short form only", async () => {
    const g = guarded({ discoverSelfNames: async () => [`${SELF}.`] });
    await new Promise((r) => setTimeout(r, 10));
    expect((await g.send({ host: `${SELF}:7433` })).status).toBe(200);
    expect((await g.send({ host: "OPENRIG-VM:7433" })).status).toBe(200);
    expect((await g.send({ host: "other-vm:7433" })).status).toBe(403);
  });

  it("OPENRIG_ALLOWED_HOSTS admits names; OPENRIG_ALLOWED_ORIGINS does not", async () => {
    expect((await guarded({ allowedHosts: "rig.example.com" }).send({ host: "rig.example.com:7433" })).status).toBe(200);
    expect((await guarded({ allowedOrigins: "rig.example.com,http://rig.example.com:7433" }).send({ host: "rig.example.com:7433" })).status).toBe(403);
  });
});

describe("discovery controls", () => {
  it("unavailable, malformed and failing discovery leave loopback/IP working and the name refused", async () => {
    for (const discoverSelfNames of [
      async () => [] as string[],
      async () => ["bad name!", "", "a..b", "-x.ts.net"],
      async () => { throw new Error("ESERVFAIL"); },
    ]) {
      const g = guarded({ discoverSelfNames, rediscoverAfterMs: 60_000 });
      expect((await g.send({ host: "127.0.0.1:7433" })).status).toBe(200);
      expect((await g.send({ host: `${SELF}:7433` })).status).toBe(403);
    }
  });

  it("a timed-out lookup is bounded and never delays loopback/IP requests", async () => {
    const g = guarded({ discoverSelfNames: () => new Promise<string[]>(() => {}), discoveryTimeoutMs: 50 });
    const t0 = Date.now();
    expect((await g.send({ host: "127.0.0.1:7433" })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(40);
    const t1 = Date.now();
    expect((await g.send({ host: `${SELF}:7433` })).status).toBe(403);
    expect(Date.now() - t1).toBeLessThan(1000);
  });

  it("an unrecognized name triggers at most one bounded re-lookup per window, single-flight", async () => {
    let calls = 0;
    let names: string[] = [];
    let clock = 1_000;
    const g = guarded({ discoverSelfNames: async () => { calls++; return names; }, rediscoverAfterMs: 10_000, now: () => clock });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    names = [SELF];
    expect((await g.send({ host: `${SELF}:7433` })).status).toBe(403); // inside the window: no re-lookup
    expect(calls).toBe(1);
    clock += 10_000;
    const results = await Promise.all([g.send({ host: `${SELF}:7433` }), g.send({ host: `${SELF}:7433` })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(calls).toBe(2);
  });

  it("discoverTailscaleSelfNames: no tailnet IP means no lookup; names are validated and short forms added", async () => {
    const reverse = vi.fn(async () => [`${SELF}.`, "bad name!"]);
    expect(await discoverTailscaleSelfNames({ timeoutMs: 10, tailscaleIp: () => null, reverse })).toEqual([]);
    expect(reverse).not.toHaveBeenCalled();
    expect(await discoverTailscaleSelfNames({ timeoutMs: 10, tailscaleIp: () => "100.106.37.120", reverse })).toEqual([SELF, "openrig-vm"]);
  });
});

describe("browser-origin rule", () => {
  it("UI off trusts no default origin; UI on trusts only the exact own UI origin", async () => {
    const off = guarded();
    expect((await off.send({ host: "localhost:7433", origin: "http://localhost:7433" })).body.code).toBe("browser_origin_refused");
    const on = guarded({ webUiEnabled: true });
    expect((await on.send({ host: "localhost:7433", origin: "http://localhost:7433" })).status).toBe(200);
    expect((await on.send({ host: "127.0.0.1:7433", origin: "http://127.0.0.1:7433" })).status).toBe(200);
    expect((await on.send({ host: "localhost", origin: "http://localhost" })).status).toBe(200);
    expect((await on.send({ host: "localhost:7433", origin: "http://LOCALHOST.:7433" })).status).toBe(200);
    for (const [host, origin] of [
      ["localhost:7433", "http://localhost:5173"], // other-port local app or dev server
      ["127.0.0.1:7433", "http://localhost:7433"], // origin is not this request's target
      ["localhost:7433", "https://localhost:7433"],
      ["evil.example:7433", "http://evil.example:7433"], // rebinding shape
      ["localhost:7433", "null"],
      ["localhost:7433", "http://localhost:7433/path"],
    ] as const) {
      const r = await on.send({ host, origin });
      expect(r.status, `${host} ${origin}`).toBe(403);
    }
    expect((await on.send({ origin: "http://localhost:7433" })).body.code).toBe("browser_origin_refused"); // no Host
  });

  it("explicit origins keep main's formats and are independent of target-name allowances", async () => {
    const g = guarded({ allowedOrigins: "http://localhost:5173, tools.example, chrome-extension://abc" });
    expect((await g.send({ host: "localhost:7433", origin: "http://localhost:5173" })).status).toBe(200);
    expect((await g.send({ host: "127.0.0.1:7433", origin: "https://tools.example:8443" })).status).toBe(200);
    expect((await g.send({ host: "127.0.0.1:7433", origin: "chrome-extension://abc" })).status).toBe(200);
    expect((await g.send({ host: "localhost:7433", origin: "http://localhost:5174" })).status).toBe(403);
    const hostOnly = guarded({ allowedHosts: "rig.example.com", webUiEnabled: false });
    const r = await hostOnly.send({ host: "rig.example.com:7433", origin: "http://rig.example.com:7433" });
    expect(r.body.code).toBe("browser_origin_refused");
  });

  it("refusal bodies follow {error, code} with a remedy and never echo allowance lists", async () => {
    const g = guarded({ allowedOrigins: "http://secret-allowed.example" });
    const r = await g.send({ host: "localhost:7433", origin: "http://evil.example" });
    expect(r.body.code).toBe("browser_origin_refused");
    expect(r.body.error).toContain("OPENRIG_ALLOWED_ORIGINS");
    expect(r.body.error).toContain("cannot read this response");
    expect(JSON.stringify(r.body)).not.toContain("secret-allowed");
  });
});

describe("bearer token waiver", () => {
  it("a valid configured Authorization token waives only the target-name refusal", async () => {
    const g = guarded({ bearerTokens: [null, "tok-123"] });
    expect((await g.send({ host: "custom.example:7433", auth: "Bearer tok-123" })).status).toBe(200);
    expect((await g.send({ host: "custom.example:7433", auth: "Bearer wrong" })).status).toBe(403);
    expect((await g.send({ host: "custom.example:7433", path: "/api/ps?token=tok-123" })).status).toBe(403);
    expect((await g.send({ host: "a b", auth: "Bearer tok-123" })).status).toBe(403); // malformed is not waived
    const r = await g.send({ host: "custom.example:7433", auth: "Bearer tok-123", origin: "http://evil.example" });
    expect(r.body.code).toBe("browser_origin_refused");
  });

  it("no configured token means no waiver", async () => {
    const g = guarded({ bearerTokens: [null, ""] });
    expect((await g.send({ host: "custom.example:7433", auth: "Bearer " })).status).toBe(403);
  });
});

describe("one decision and bounded logging", () => {
  it("records one decision per request and logs distinct refusals up to 20, then one suppression line", async () => {
    const g = guarded();
    for (let i = 0; i < 100; i++) await g.send({ host: "same.example" });
    expect(g.lines).toHaveLength(1);
    for (let i = 0; i < 30; i++) await g.send({ host: `n${i}.example`, path: "/api/ps?token=SECRET" });
    expect(g.lines).toHaveLength(21);
    expect(g.lines.at(-1)).toContain("not logged");
    expect(g.lines.join("\n")).not.toContain("SECRET");
    expect(g.decisions).toHaveLength(130);
  });
});
