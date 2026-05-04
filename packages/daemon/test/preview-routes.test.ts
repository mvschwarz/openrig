// Preview Terminal v0 (PL-018) — preview route tests.
//
// Pins the load-bearing behaviors:
//   - GET /api/rigs/:rigId/nodes/:logicalId/preview returns content + lines + capturedAt
//   - rate limiter caches subsequent requests within the window
//   - 503 when SessionTransport is unavailable
//   - 404 when rig/node missing
//   - 409 when session is unbound
//   - GET /api/sessions/:sessionName/preview alias works
//   - lines query param is clamped + defaulted

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { sessionsRoutes, nodesRoutes, sessionAdminRoutes } from "../src/routes/sessions.js";
import { PreviewRateLimiter } from "../src/domain/preview/preview-rate-limiter.js";

interface FakeNode {
  logicalId: string;
  id: string;
  binding: { tmuxSession: string | null } | null;
}

interface FakeRigRepo {
  getRig: (id: string) => { nodes: FakeNode[] } | null;
}

interface FakeCaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  reason?: string;
  error?: string;
}

class FakeSessionTransport {
  public calls: Array<{ sessionName: string; lines?: number }> = [];
  public response: FakeCaptureResult = { ok: true, sessionName: "x", content: "captured\nline2", lines: 50 };

  async capture(sessionName: string, opts?: { lines?: number }): Promise<FakeCaptureResult> {
    this.calls.push({ sessionName, lines: opts?.lines });
    return { ...this.response, sessionName };
  }
}

function buildApp(opts: {
  rigRepo: FakeRigRepo;
  sessionTransport: FakeSessionTransport | null;
  rateLimiter?: PreviewRateLimiter<unknown> | null;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, opts.rigRepo);
    c.set("sessionTransport" as never, opts.sessionTransport);
    if (opts.rateLimiter !== null) c.set("previewRateLimiter" as never, opts.rateLimiter ?? new PreviewRateLimiter(1000));
    await next();
  });
  app.route("/api/rigs/:rigId/nodes", nodesRoutes);
  app.route("/api/sessions", sessionAdminRoutes);
  return app;
}

describe("GET /api/rigs/:rigId/nodes/:logicalId/preview (PL-018)", () => {
  let transport: FakeSessionTransport;
  let rigRepo: FakeRigRepo;

  beforeEach(() => {
    transport = new FakeSessionTransport();
    rigRepo = {
      getRig: (id: string) =>
        id === "r-1"
          ? {
              nodes: [
                { logicalId: "driver", id: "node-1", binding: { tmuxSession: "velocity-driver@openrig-velocity" } },
                { logicalId: "guard", id: "node-2", binding: { tmuxSession: null } },
              ],
            }
          : null,
    };
  });

  it("returns content + lines + capturedAt", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string; lines: number; sessionName: string; capturedAt: string };
    expect(body.content).toBe("captured\nline2");
    expect(body.lines).toBe(50);
    expect(body.sessionName).toBe("velocity-driver@openrig-velocity");
    expect(body.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rate limiter caches subsequent requests within the window", async () => {
    const limiter = new PreviewRateLimiter<unknown>(60_000);
    const app = buildApp({ rigRepo, sessionTransport: transport, rateLimiter: limiter });
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    expect(transport.calls.length).toBe(1);
  });

  it("different lines query values use distinct cache keys", async () => {
    const limiter = new PreviewRateLimiter<unknown>(60_000);
    const app = buildApp({ rigRepo, sessionTransport: transport, rateLimiter: limiter });
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=200");
    expect(transport.calls.length).toBe(2);
    expect(transport.calls[0].lines).toBe(50);
    expect(transport.calls[1].lines).toBe(200);
  });

  it("clamps lines to a sensible upper bound (1000)", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=99999");
    expect(transport.calls[0].lines).toBe(1000);
  });

  it("defaults lines to 50 when missing or non-numeric", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    await app.request("/api/rigs/r-1/nodes/driver/preview");
    expect(transport.calls[0].lines).toBe(50);
    transport.calls.length = 0;

    // Use a fresh limiter so the second request isn't served from cache
    const app2 = buildApp({ rigRepo, sessionTransport: transport });
    await app2.request("/api/rigs/r-1/nodes/driver/preview?lines=banana");
    expect(transport.calls[0].lines).toBe(50);
  });

  it("503 when SessionTransport unavailable", async () => {
    const app = buildApp({ rigRepo, sessionTransport: null });
    const res = await app.request("/api/rigs/r-1/nodes/driver/preview");
    expect(res.status).toBe(503);
  });

  it("404 when rig is missing", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/missing/nodes/driver/preview");
    expect(res.status).toBe(404);
  });

  it("404 when node is missing", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/nonexistent/preview");
    expect(res.status).toBe(404);
  });

  it("409 when node has no tmux session bound", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/guard/preview");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("session_unbound");
  });

  it("502 surfaces capture failures with structured reason + hint", async () => {
    transport.response = { ok: false, sessionName: "x", reason: "session_missing", error: "Session not found" };
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/driver/preview");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; hint: string };
    expect(body.error).toBe("session_missing");
    expect(body.hint).toContain("Session not found");
  });
});

describe("GET /api/sessions/:sessionName/preview (PL-018 alias)", () => {
  let transport: FakeSessionTransport;

  beforeEach(() => {
    transport = new FakeSessionTransport();
  });

  it("session-keyed alias returns same payload shape", async () => {
    const app = buildApp({ rigRepo: { getRig: () => null }, sessionTransport: transport });
    const res = await app.request("/api/sessions/velocity-driver%40openrig-velocity/preview?lines=10");
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string; sessionName: string; lines: number };
    expect(body.sessionName).toBe("velocity-driver@openrig-velocity");
    expect(transport.calls[0].sessionName).toBe("velocity-driver@openrig-velocity");
  });

  it("503 when SessionTransport unavailable on alias too", async () => {
    const app = buildApp({ rigRepo: { getRig: () => null }, sessionTransport: null });
    const res = await app.request("/api/sessions/x/preview");
    expect(res.status).toBe(503);
  });
});
