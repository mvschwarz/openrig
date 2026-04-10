import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("Adapter routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/adapters/tmux/sessions -> tmux session list", async () => {
    const tmuxExec: ExecFn = async () => "my-session\t2\t2026-03-23\t1\n";
    const tmux = new TmuxAdapter(tmuxExec);

    const { app } = createTestApp(db, { tmux });
    const res = await app.request("/api/adapters/tmux/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("my-session");
  });

  it("GET /api/adapters/cmux/status after connect() -> capabilities", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.list", "surface.focus"] };
        return {};
      },
      close: () => {},
    });
    const cmux = new CmuxAdapter(cmuxFactory, { timeoutMs: 1000 });
    await cmux.connect();

    const { app } = createTestApp(db, { cmux });
    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.capabilities["workspace.list"]).toBe(true);
  });

  it("GET /api/adapters/cmux/status live-probes on every request, not cached", async () => {
    let callCount = 0;
    const cmuxFactory: CmuxTransportFactory = async () => {
      callCount++;
      if (callCount <= 2) {
        // First two calls succeed (initial connect + first status request probe)
        return {
          request: async (method: string) => {
            if (method === "capabilities") return { capabilities: ["surface.focus"] };
            return {};
          },
          close: () => {},
        };
      }
      // Subsequent calls fail (simulates cmux going away)
      throw new Error("cmux socket gone");
    };
    const cmux = new CmuxAdapter(cmuxFactory, { timeoutMs: 1000 });
    await cmux.connect(); // callCount = 1

    const { app } = createTestApp(db, { cmux });

    // First status request — should live-probe and return available=true
    const res1 = await app.request("/api/adapters/cmux/status");
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    expect(body1["available"]).toBe(true);

    // Second status request — factory now fails, live probe should detect unavailable
    const res2 = await app.request("/api/adapters/cmux/status");
    expect(res2.status).toBe(200); // HTTP 200 even on probe failure
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2["available"]).toBe(false);
  });

  it("GET /api/adapters/cmux/status cmux unavailable -> { available: false }", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const cmux = new CmuxAdapter(cmuxFactory, { timeoutMs: 50 });
    await cmux.connect();

    const { app } = createTestApp(db, { cmux });
    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.capabilities).toEqual({});
  });
});
