import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { createApp } from "../src/server.js";

function createTestApp() {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema]);
  const rigRepo = new RigRepository(db);
  return { app: createApp({ rigRepo }), db };
}

describe("Hono server (production app)", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const { app, db } = createTestApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    db.close();
  });

  it("GET /unknown returns 404", async () => {
    const { app, db } = createTestApp();
    const res = await app.request("/unknown");
    expect(res.status).toBe(404);
    db.close();
  });

  it("production app mounts /api/rigs (not healthz-only)", async () => {
    const { app, db } = createTestApp();
    const res = await app.request("/api/rigs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    db.close();
  });
});
