import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

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
});
