import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { apiOriginProtection, hostHeaderHostname } from "../src/middleware/origin-guard.js";
import { createTestApp, createFullTestDb } from "./helpers/test-app.js";

describe("apiOriginProtection middleware", () => {
  it("allows requests without an Origin header (CLI, curl, server-to-server)", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("allows requests from localhost and 127.0.0.1 browser origins", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:5173",
      "https://localhost",
    ]) {
      const res = await app.request("/api/test", {
        headers: { Origin: origin },
      });
      expect(res.status).toBe(200);
    }
  });

  it("allows same-origin requests where Origin matches Host", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test", {
      headers: {
        Origin: "https://my-internal-rig.example.com",
        Host: "my-internal-rig.example.com:7433",
      },
    });
    expect(res.status).toBe(200);
  });

  it("allows same-origin requests on a bracketed IPv6 Host (#405)", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test", {
      headers: {
        Origin: "http://[fd7a::1]:7433",
        Host: "[fd7a::1]:7433",
      },
    });
    expect(res.status).toBe(200);
  });

  it("matches an IPv6 Host that differs only in case and zero compression", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test", {
      headers: {
        Origin: "http://[fd7a::1]:7433",
        Host: "[FD7A::0001]:7433",
      },
    });
    expect(res.status).toBe(200);
  });

  it("still rejects a different IPv6 host", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test", {
      headers: {
        Origin: "http://[fd7a::2]:7433",
        Host: "[fd7a::1]:7433",
      },
    });
    expect(res.status).toBe(403);
  });

  describe("hostHeaderHostname", () => {
    it("parses host[:port] forms, including bracketed IPv6", () => {
      expect(hostHeaderHostname("[fd7a::1]:7433")).toBe("[fd7a::1]");
      expect(hostHeaderHostname("[FD7A::0001]:7433")).toBe("[fd7a::1]");
      expect(hostHeaderHostname("rig.example.com:7433")).toBe("rig.example.com");
      expect(hostHeaderHostname("RIG.example.com")).toBe("rig.example.com");
      expect(hostHeaderHostname("127.0.0.1:7433")).toBe("127.0.0.1");
    });

    it("returns \"\" for values that are not a bare host[:port]", () => {
      // Each would otherwise parse to a hostname the server was not addressed
      // by, which must never widen the same-host comparison.
      expect(hostHeaderHostname(undefined)).toBe("");
      expect(hostHeaderHostname("")).toBe("");
      expect(hostHeaderHostname("   ")).toBe("");
      expect(hostHeaderHostname("attacker@victim.example.com")).toBe("");
      expect(hostHeaderHostname("victim.example.com/path")).toBe("");
      expect(hostHeaderHostname("victim.example.com?q=1")).toBe("");
      expect(hostHeaderHostname("victim.example.com#frag")).toBe("");
      expect(hostHeaderHostname("::1")).toBe("");
    });
  });

  it("allows explicitly configured allowed origins", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection({ allowedOrigins: ["https://dashboard.example.com"] }));
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test", {
      headers: { Origin: "https://dashboard.example.com" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects unauthorized external origins with 403 origin_rejected", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    for (const origin of [
      "https://evil.com",
      "http://attacker.org:8080",
      "https://phishing-site.net",
    ]) {
      const res = await app.request("/api/test", {
        headers: { Origin: origin },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("origin_rejected");
      expect(body.hint).toContain("not allowed");
    }
  });

  it("rejects malformed Origin headers with 403", async () => {
    const app = new Hono();
    app.use("/api/*", apiOriginProtection());
    app.get("/api/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/test", {
      headers: { Origin: "not-a-valid-url" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe("origin_rejected");
    expect(body.hint).toBe("Malformed Origin header");
  });

  it("blocks cross-origin browser requests on the real daemon app", async () => {
    const db = createFullTestDb();
    try {
      const { app } = createTestApp(db);
      const res = await app.request("/api/info", {
        headers: { Origin: "https://evil-cross-site.com" },
      });
      expect(res.status).toBe(403);
      // On the real app the /api browser boundary runs first, so its code and remedy are returned.
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("browser_origin_refused");
    } finally {
      db.close();
    }
  });
});
