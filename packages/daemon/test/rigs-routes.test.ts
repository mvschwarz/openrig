import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("Rig CRUD routes", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.rigRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/rigs -> 201 + created rig with id and name", async () => {
    const res = await app.request("/api/rigs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-rig" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-rig");
  });

  it("GET /api/rigs -> list of rigs", async () => {
    repo.createRig("rig-a");
    repo.createRig("rig-b");

    const res = await app.request("/api/rigs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBeDefined();
  });

  it("GET /api/rigs/:id -> full graph with nodes, edges, bindings", async () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rig.name).toBe("test-rig");
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].kind).toBe("delegates_to");
  });

  it("GET /api/rigs/:id -> unbound nodes have binding: null (not omitted)", async () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const worker = body.nodes.find((n: { logicalId: string }) => n.logicalId === "worker");
    expect(worker).toBeDefined();
    expect(worker).toHaveProperty("binding");
    expect(worker.binding).toBeNull();
  });

  it("GET /api/rigs/:id with nonexistent id -> 404", async () => {
    const res = await app.request("/api/rigs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/rigs/:id -> 204", async () => {
    const rig = repo.createRig("test-rig");

    const res = await app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(repo.getRig(rig.id)).toBeNull();
  });

  it("DELETE /api/rigs/:id with nonexistent id -> 204 (idempotent)", async () => {
    const res = await app.request("/api/rigs/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("POST /api/rigs with invalid body -> 400", async () => {
    const res = await app.request("/api/rigs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
