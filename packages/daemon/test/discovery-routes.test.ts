import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { createTestApp } from "./helpers/test-app.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema,
];

function getEvents(database: Database.Database): Array<{ type: string; payload: string }> {
  return database.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
}

describe("Discovery API routes", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => { db.close(); });

  function seedDiscovery(tmuxSession: string = "organic", tmuxPane: string = "%0") {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run(`ds-${tmuxSession}-${tmuxPane}`, tmuxSession, tmuxPane, "claude-code", "high");
    return `ds-${tmuxSession}-${tmuxPane}`;
  }

  function seedRig() {
    const rig = setup.rigRepo.createRig("test-rig");
    return rig;
  }

  // T1: POST /scan returns discovered sessions
  it("POST /api/discovery/scan returns sessions", async () => {
    // Scanner will find nothing (mock adapter returns empty), but route should work
    const res = await app.request("/api/discovery/scan", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  // T1b: POST /scan with scanner failure -> 500 with structured error
  it("POST /api/discovery/scan with scanner failure returns 500 with error", async () => {
    // Override scanner to throw
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => {
      throw new Error("tmux boom");
    };

    const res = await app.request("/api/discovery/scan", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("tmux boom");
  });

  // T2: GET /discovery lists with status filter
  it("GET /api/discovery?status=active lists active sessions", async () => {
    seedDiscovery("s1", "%0");
    seedDiscovery("s2", "%0");

    const res = await app.request("/api/discovery?status=active");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("GET /api/discovery filters by runtime hint and minimum confidence", async () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-claude", "claude-team", "%0", "claude-code", "high");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-codex", "codex-team", "%0", "codex", "medium");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-shell", "shell", "%0", "terminal", "high");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-weak", "weak", "%0", "claude-code", "low");

    const res = await app.request("/api/discovery?status=active&runtimeHint=claude-code,codex&minConfidence=medium");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((row: { id: string }) => row.id)).toEqual(["ds-claude", "ds-codex"]);
  });

  // T3: GET /:id returns detail
  it("GET /api/discovery/:id returns session detail", async () => {
    const id = seedDiscovery();

    const res = await app.request(`/api/discovery/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.runtimeHint).toBe("claude-code");
  });

  // T4: POST /:id/claim success -> 201
  it("POST /api/discovery/:id/claim creates managed node", async () => {
    const id = seedDiscovery();
    const rig = seedRig();

    const res = await app.request(`/api/discovery/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBeTruthy();
  });

  it("POST /api/discovery/:id/bind binds into an existing managed node", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/workspace" });

    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "orch.lead" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBeTruthy();
  });

  it("POST /api/discovery/:id/adopt binds into an existing managed node target", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/workspace" });

    const res = await app.request(`/api/discovery/${id}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rigId: rig.id,
        target: { kind: "node", logicalId: "orch.lead" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("bind");
    expect(body.logicalId).toBe("orch.lead");
  });

  it("POST /api/discovery/:id/adopt creates a new node inside a pod target and binds it", async () => {
    const id = seedDiscovery("research-scout", "%2");
    const rig = seedRig();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-research", rig.id, "research", "Research");
    setup.rigRepo.addNode(rig.id, "research.mapper", { runtime: "claude-code", podId: "pod-research" });

    const res = await app.request(`/api/discovery/${id}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rigId: rig.id,
        target: { kind: "pod", podId: "pod-research", podNamespace: "research", memberName: "scout" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("create_and_bind");
    expect(body.logicalId).toBe("research.scout");

    const claimedNode = setup.rigRepo.getRig(rig.id)?.nodes.find((node) => node.logicalId === "research.scout");
    expect(claimedNode?.podId).toBe("pod-research");
    expect(claimedNode?.binding?.tmuxSession).toBe("research-scout");
  });

  // T5a: Claim nonexistent discovery -> 404
  it("claim nonexistent discovery returns 404", async () => {
    const rig = seedRig();
    const res = await app.request("/api/discovery/nonexistent/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(res.status).toBe(404);
  });

  // T5b: Claim nonexistent rig -> 404
  it("claim into nonexistent rig returns 404", async () => {
    const id = seedDiscovery();
    const res = await app.request(`/api/discovery/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: "nonexistent-rig" }),
    });
    expect(res.status).toBe(404);
  });

  // T5c: Missing rigId -> 400
  it("claim with missing rigId returns 400", async () => {
    const id = seedDiscovery();
    const res = await app.request(`/api/discovery/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("bind with missing logicalId returns 400", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(res.status).toBe(400);
  });

  // T6a: Already claimed -> 409
  it("claim already-claimed session returns 409", async () => {
    const id = seedDiscovery();
    const rig = seedRig();

    // Claim once
    await app.request(`/api/discovery/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });

    // Claim again
    const res = await app.request(`/api/discovery/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "different" }),
    });
    expect(res.status).toBe(409);
  });

  // T6b: Duplicate logicalId -> 409
  it("claim with duplicate logicalId returns 409", async () => {
    const id1 = seedDiscovery("s1", "%0");
    const id2 = seedDiscovery("s2", "%0");
    const rig = seedRig();

    // Claim first with logical_id "dev"
    await app.request(`/api/discovery/${id1}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "dev" }),
    });

    // Claim second with same logical_id -> 409
    const res = await app.request(`/api/discovery/${id2}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "dev" }),
    });
    expect(res.status).toBe(409);
  });

  // T7: createDaemon wires discovery (GET /discovery -> 200)
  it("createDaemon wires discovery routes", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const res = await daemonApp.request("/api/discovery");
      expect(res.status).toBe(200);
    } finally {
      daemonDb.close();
    }
  });

  // T11: Same-db-handle assertion for discovery deps (via createApp import)
  it("createApp rejects mismatched discoveryRepo db handle", async () => {
    const db2 = createDb();
    migrate(db2, ALL_MIGRATIONS);

    const { createApp } = await import("../src/server.js");
    const { DiscoveryRepository } = await import("../src/domain/discovery-repository.js");

    // Build good deps from existing test app, then swap discoveryRepo with wrong db
    const goodSetup = createTestApp(db);
    const mismatchedRepo = new DiscoveryRepository(db2);

    expect(() => {
      createApp({ ...goodSetup, discoveryRepo: mismatchedRepo });
    }).toThrow(/discoveryRepo.*same db handle/);

    db2.close();
  });

  // T12a: POST /scan -> session.discovered event via route
  it("POST /scan emits session.discovered event through route/coordinator", async () => {
    // Override the mock scanner to return a pane
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => ({
      panes: [{ tmuxSession: "organic", tmuxWindow: "0", tmuxPane: "%0", pid: 1234, cwd: "/tmp", activeCommand: "claude" }],
      scannedAt: new Date().toISOString(),
    });

    await app.request("/api/discovery/scan", { method: "POST" });

    const events = getEvents(db).filter((e) => e.type === "session.discovered");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.tmuxSession).toBe("organic");
  });

  // T12b: POST /scan (rescan after disappear) -> session.vanished via route
  it("POST /scan emits session.vanished when session disappears", async () => {
    // First scan: session present
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => ({
      panes: [{ tmuxSession: "ephemeral", tmuxWindow: "0", tmuxPane: "%5", pid: 999, cwd: "/tmp", activeCommand: "bash" }],
      scannedAt: new Date().toISOString(),
    });
    await app.request("/api/discovery/scan", { method: "POST" });

    // Second scan: session gone
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => ({
      panes: [],
      scannedAt: new Date().toISOString(),
    });
    await app.request("/api/discovery/scan", { method: "POST" });

    const events = getEvents(db).filter((e) => e.type === "session.vanished");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.tmuxSession).toBe("ephemeral");
  });

  // T12c: POST /:id/claim -> node.claimed event
  it("POST /:id/claim emits node.claimed event", async () => {
    const id = seedDiscovery();
    const rig = seedRig();

    await app.request(`/api/discovery/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });

    const events = getEvents(db).filter((e) => e.type === "node.claimed");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
  });
});
