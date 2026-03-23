import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { createApp } from "../src/server.js";
import { mockTmuxAdapter, unavailableCmuxAdapter } from "./helpers/test-app.js";

describe("Hono server (production app)", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    db.close();
  });

  it("GET /unknown returns 404", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/unknown");
    expect(res.status).toBe(404);
    db.close();
  });

  it("production app mounts /api/rigs (not healthz-only)", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/api/rigs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    db.close();
  });

  it("createApp throws if rigRepo and eventBus use different db handles", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();

    const rigRepo = new RigRepository(db1);
    const sessionRegistry = new SessionRegistry(db1);
    const eventBus = new EventBus(db2); // different handle
    const tmux = mockTmuxAdapter();
    const cmux = unavailableCmuxAdapter();
    const nodeLauncher = new NodeLauncher({ db: db1, rigRepo, sessionRegistry, eventBus: new EventBus(db1), tmuxAdapter: tmux });

    expect(() =>
      createApp({ rigRepo, sessionRegistry, eventBus, nodeLauncher, tmuxAdapter: tmux, cmuxAdapter: cmux })
    ).toThrow(/same db handle/);

    db1.close();
    db2.close();
  });
});
