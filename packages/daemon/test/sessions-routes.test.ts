import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

function unavailableCmux() {
  const factory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  return new CmuxAdapter(factory, { timeoutMs: 50 });
}

function connectedCmux() {
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string) => {
      if (method === "capabilities") return { capabilities: ["surface.focus"] };
      return { ok: true };
    },
    close: () => {},
  });
  return new CmuxAdapter(factory, { timeoutMs: 1000 });
}

describe("Session routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/rigs/:rigId/sessions -> session list", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");

    const res = await app.request(`/api/rigs/${rig.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].sessionName).toBe("r01-dev1-impl");
  });

  it("POST .../launch -> 201 + sessionName + session + binding, binding.tmuxSession === sessionName", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionName).toBe("r01-dev1-impl");
    expect(body.session).toBeDefined();
    expect(body.session.sessionName).toBe("r01-dev1-impl");
    expect(body.binding).toBeDefined();
    expect(body.binding.tmuxSession).toBe("r01-dev1-impl");
    expect(body.binding.tmuxSession).toBe(body.sessionName);
  });

  it("POST .../launch already-bound -> 409", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("POST .../launch nonexistent node -> 404", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/nonexistent/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST .../launch with ordinary rig name normalizes to r00-managed session name", async () => {
    const { app, rigRepo } = createTestApp(db);
    // Ordinary rig names are normalized into the managed r00- namespace.
    const rig = rigRepo.createRig("badname");
    rigRepo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/worker/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionName).toBe("r00-badname-worker");
    expect(body.session.sessionName).toBe("r00-badname-worker");
    expect(body.binding.tmuxSession).toBe("r00-badname-worker");
  });

  it("POST .../focus with valid cmux binding -> calls focusSurface", async () => {
    const cmux = connectedCmux();
    await cmux.connect();
    const focusSpy = vi.spyOn(cmux, "focusSurface");
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface-42" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Prove focusSurface was actually called with the correct surface ID
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(focusSpy).toHaveBeenCalledWith("surface-42");
  });

  it("POST .../focus node has no cmux surface -> 409, cmux NOT called", async () => {
    const cmux = connectedCmux();
    await cmux.connect();
    const focusSpy = vi.spyOn(cmux, "focusSurface");
    const { app, rigRepo } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    // Prove focusSurface was NOT called
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("POST .../focus nonexistent logicalId -> 404", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/nonexistent/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST .../focus cmux unavailable -> 200 { ok: false, code: 'unavailable' }", async () => {
    const cmux = unavailableCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface-42" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unavailable");
  });

  // NS-T08: node inventory route
  it("GET /api/rigs/:rigId/nodes -> node inventory array", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-rig");

    const res = await app.request(`/api/rigs/${rig.id}/nodes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].logicalId).toBe("dev.impl");
    expect(body[0].nodeKind).toBe("agent");
    expect(body[0].canonicalSessionName).toBe("dev-impl@test-rig");
  });

  it("GET /api/rigs/:rigId/nodes -> 404 for unknown rig", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/rigs/nonexistent/nodes");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // NS-T09: node detail route
  it("GET /api/rigs/:rigId/nodes/:logicalId -> node detail", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-rig");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logicalId).toBe("dev.impl");
    expect(body.nodeKind).toBe("agent");
    expect(Array.isArray(body.startupFiles)).toBe(true);
    expect(Array.isArray(body.recentEvents)).toBe(true);
  });

  it("GET /api/rigs/:rigId/nodes/:logicalId -> 404 for unknown node", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const res = await app.request(`/api/rigs/${rig.id}/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  // Task 5: node detail returns peers, edges, transcript, compactSpec
  it("node detail returns peers for other nodes in same rig", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const n2 = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");
    sessionRegistry.registerSession(n2.id, "dev-qa@test");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].logicalId).toBe("dev.qa");
    expect(body.peers[0].canonicalSessionName).toBe("dev-qa@test");
    expect(body.peers[0].runtime).toBe("codex");
  });

  it("node detail returns outgoing and incoming edges", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const n2 = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");
    sessionRegistry.registerSession(n2.id, "dev-qa@test");
    rigRepo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.edges.outgoing).toHaveLength(1);
    expect(body.edges.outgoing[0].kind).toBe("delegates_to");
    expect(body.edges.outgoing[0].to.logicalId).toBe("dev.qa");
    expect(body.edges.incoming).toHaveLength(0);

    // Check from qa perspective
    const res2 = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.qa")}`);
    const body2 = await res2.json();
    expect(body2.edges.incoming).toHaveLength(1);
    expect(body2.edges.incoming[0].from.logicalId).toBe("dev.impl");
    expect(body2.edges.outgoing).toHaveLength(0);
  });

  it("node detail returns compact spec summary", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", profile: "default" });
    // Set resolved spec fields
    db.prepare("UPDATE nodes SET resolved_spec_name = ?, resolved_spec_version = ? WHERE id = ?")
      .run("impl-agent", "1.0.0", n1.id);
    sessionRegistry.registerSession(n1.id, "dev-impl@test");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.compactSpec).toBeDefined();
    expect(body.compactSpec.name).toBe("impl-agent");
    expect(body.compactSpec.version).toBe("1.0.0");
    expect(body.compactSpec.profile).toBe("default");
    expect(typeof body.compactSpec.skillCount).toBe("number");
    expect(typeof body.compactSpec.guidanceCount).toBe("number");
  });

  it("node detail returns transcript info (defaults to disabled without TranscriptStore)", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.transcript).toBeDefined();
    expect(body.transcript.enabled).toBe(false);
    expect(body.transcript.path).toBeNull();
    expect(body.transcript.tailCommand).toBeNull();
  });

  it("node detail returns enriched transcript info when TranscriptStore is enabled", async () => {
    const { TranscriptStore } = await import("../src/domain/transcript-store.js");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const tmpDir = path.join(os.tmpdir(), `rigged-test-transcript-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const transcriptStore = new TranscriptStore(tmpDir);
    const { createApp } = await import("../src/server.js");
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("test-rig");
    const n1 = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(n1.id, "dev-impl@test-rig");

    // Build a minimal app with TranscriptStore wired
    const appWithTranscript = createApp({ ...setup, transcriptStore });

    const res = await appWithTranscript.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.transcript.enabled).toBe(true);
    expect(body.transcript.path).toContain("test-rig");
    expect(body.transcript.path).toContain("dev-impl@test-rig");
    expect(body.transcript.tailCommand).toBe("rigged transcript dev-impl@test-rig --tail 100");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
