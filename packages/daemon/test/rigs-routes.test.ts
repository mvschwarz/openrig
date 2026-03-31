import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("Rig CRUD routes", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotRepo = setup.snapshotRepo;
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

  it("DELETE /api/rigs/:id -> rig.deleted event row in DB", async () => {
    const rig = repo.createRig("test-rig");

    const res = await app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const events = db
      .prepare("SELECT type, payload FROM events WHERE type = 'rig.deleted'")
      .all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
  });

  it("DELETE /api/rigs/:id with nonexistent id -> 204 + no rig.deleted event", async () => {
    const res = await app.request("/api/rigs/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(204);

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'rig.deleted'")
      .all();
    expect(events).toHaveLength(0);
  });

  it("DELETE /api/rigs/:id with sabotaged events -> rig still exists + no event row", async () => {
    const rig = repo.createRig("test-rig");

    // Sabotage events table so event insert fails inside the transaction
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const res = await app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    // Should fail (transaction rolled back)
    expect(res.status).toBe(500);

    // Rig still exists (rollback)
    expect(repo.getRig(rig.id)).not.toBeNull();

    // No partial event row
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("POST /api/rigs with invalid body -> 400", async () => {
    const res = await app.request("/api/rigs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // -- T21: Graph projection endpoint --

  it("GET /api/rigs/:id/graph -> RF JSON with correct node/edge counts", async () => {
    const rig = repo.createRig("r01");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
  });

  it("GET /api/rigs/:id/graph -> node.data includes status from session", async () => {
    const rig = repo.createRig("r01");
    const node = repo.addNode(rig.id, "dev1-impl", { role: "worker" });
    // Seed session through the app's injected sessionRegistry
    const session = sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    const nodeData = body.nodes.find((n: { data: { logicalId: string } }) => n.data.logicalId === "dev1-impl");
    expect(nodeData.data.status).toBe("running");
  });

  it("GET /api/rigs/:id/graph -> unbound node has binding: null in data", async () => {
    const rig = repo.createRig("r01");
    repo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    const nodeData = body.nodes[0];
    expect(nodeData.data).toHaveProperty("binding");
    expect(nodeData.data.binding).toBeNull();
  });

  it("GET /api/rigs/:id/graph -> nodes have type: 'rigNode'", async () => {
    const rig = repo.createRig("r01");
    repo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    expect(body.nodes[0].type).toBe("rigNode");
  });

  it("GET /api/rigs/:id/graph -> RF identity: node.id = opaque PK, edge uses PKs", async () => {
    const rig = repo.createRig("r01");
    const n1 = repo.addNode(rig.id, "a");
    const n2 = repo.addNode(rig.id, "b");
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();

    expect(body.nodes[0].id).toBe(n1.id);
    expect(body.nodes[1].id).toBe(n2.id);
    expect(body.edges[0].source).toBe(n1.id);
    expect(body.edges[0].target).toBe(n2.id);
  });

  it("GET /api/rigs/:id/graph -> node with no session has status: null", async () => {
    const rig = repo.createRig("r01");
    repo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    expect(body.nodes[0].data).toHaveProperty("status");
    expect(body.nodes[0].data.status).toBeNull();
  });

  it("GET /api/rigs/:id/graph with nonexistent id -> 404", async () => {
    const res = await app.request("/api/rigs/nonexistent/graph");
    expect(res.status).toBe(404);
  });

  // -- UX-T01b: Rig summary endpoint --

  it("GET /api/rigs/summary -> rig list with node counts", async () => {
    const rig1 = repo.createRig("alpha");
    repo.addNode(rig1.id, "orchestrator", { runtime: "claude-code" });
    repo.addNode(rig1.id, "worker", { runtime: "codex" });

    const rig2 = repo.createRig("beta");
    repo.addNode(rig2.id, "solo", { runtime: "claude-code" });

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(2);
    const alpha = body.find((r: { name: string }) => r.name === "alpha");
    const beta = body.find((r: { name: string }) => r.name === "beta");
    expect(alpha.id).toBe(rig1.id);
    expect(alpha.nodeCount).toBe(2);
    expect(beta.id).toBe(rig2.id);
    expect(beta.nodeCount).toBe(1);
  });

  it("GET /api/rigs/summary -> multiple snapshots with explicit timestamps, newest wins", async () => {
    const rig = repo.createRig("gamma");
    repo.addNode(rig.id, "worker", { runtime: "codex" });

    // Insert snapshots with explicit timestamps to prove newest-wins
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-old", rig.id, "manual", "complete", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-new", rig.id, "manual", "complete", "{}", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-mid", rig.id, "manual", "complete", "{}", "2026-03-23 02:00:00");

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const gamma = body.find((r: { name: string }) => r.name === "gamma");
    expect(gamma.latestSnapshotId).toBe("snap-new");
    expect(gamma.latestSnapshotAt).toBe("2026-03-23 03:00:00");
  });

  it("GET /api/rigs/summary -> no snapshots: both latestSnapshotAt and latestSnapshotId are null", async () => {
    const rig = repo.createRig("delta");
    repo.addNode(rig.id, "worker", { runtime: "codex" });

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const delta = body.find((r: { name: string }) => r.name === "delta");
    expect(delta).toBeDefined();
    expect(delta.latestSnapshotAt).toBeNull();
    expect(delta.latestSnapshotId).toBeNull();
  });

  it("GET /api/rigs/summary -> empty DB returns empty array", async () => {
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/rigs/summary -> returns array shape, not rig-by-id shape (route order guardrail)", async () => {
    // This test proves /summary is not swallowed by /:id
    // If /:id resolves first, "summary" would be treated as a rig ID
    // and return either a 404 or a rig-by-id object — not an array
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Must be an array (summary shape), not an object (rig-by-id shape or 404 error shape)
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/rigs/summary -> same-second snapshots: no duplicate rig rows, deterministic tiebreak by id", async () => {
    const rig = repo.createRig("epsilon");
    repo.addNode(rig.id, "worker", { runtime: "codex" });

    // Two snapshots with identical created_at — ULID "ZZZZ" sorts after "AAAA"
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("AAAA_snap", rig.id, "manual", "complete", "{}", "2026-03-23 05:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("ZZZZ_snap", rig.id, "manual", "complete", "{}", "2026-03-23 05:00:00");

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Must have exactly one row for epsilon (no duplicates)
    const epsilons = body.filter((r: { name: string }) => r.name === "epsilon");
    expect(epsilons).toHaveLength(1);
    // ZZZZ sorts after AAAA, so ZZZZ_snap should win the tiebreak
    expect(epsilons[0].latestSnapshotId).toBe("ZZZZ_snap");
  });

  // NS-T06: POST /api/rigs/:id/up — power-on from auto-pre-down snapshot
  it("POST /api/rigs/:id/up returns 404 when no auto-pre-down snapshot exists", async () => {
    const rig = repo.createRig("no-snap-rig");
    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_snapshot");
  });

  it("POST /api/rigs/:id/up returns 404 for nonexistent rig", async () => {
    const res = await app.request("/api/rigs/nonexistent/up", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("not found");
  });
});
