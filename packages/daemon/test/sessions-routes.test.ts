import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import { PodRepository } from "../src/domain/pod-repository.js";
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

function failingCmux(failOn: string) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === failOn) throw new Error(`${failOn} failed: connection lost`);
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

function trackingCmux() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

function staleBindingCmux() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === "surface.focus") {
        const surfaceId = String((params as Record<string, unknown> | undefined)?.["surfaceId"] ?? "");
        if (surfaceId === "OK surface:78 pane:2 workspace:1") {
          throw new Error("Invalid surface handle: OK surface:78 pane:2 workspace:1");
        }
        return {};
      }
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
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

  it("POST .../launch rejects pod-aware nodes because the route bypasses startup orchestration", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("pod-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/impl",
      profile: "default",
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}/launch`, {
      method: "POST",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("pod_aware_launch_unsupported");
    expect(String(body.error)).toContain("bypasses startup orchestration");
    expect(sessionRegistry.getBindingForNode(node.id)).toBeNull();
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

  // -- open-cmux tests --

  it("POST .../open-cmux with existing cmuxSurface -> focused_existing, no create/send side effects", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface:42", cmuxWorkspace: "workspace:1" });

    // Clear capability call from connect
    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("focused_existing");

    // Only focusSurface should have been called — no create, no send, no workspace.current
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("surface.focus");
    expect(methodNames).not.toContain("surface.create");
    expect(methodNames).not.toContain("surface.sendText");
    expect(methodNames).not.toContain("workspace.current");
  });

  it("POST .../open-cmux with stale existing cmuxSurface -> recreates, rebinds, and focuses new surface", async () => {
    const { adapter: cmux, calls } = staleBindingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "r01-dev1-impl",
      cmuxWorkspace: "workspace:old",
      cmuxSurface: "OK surface:78 pane:2 workspace:1",
    });

    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    const methodNames = calls.map((c) => c.method);
    expect(methodNames.filter((name) => name === "surface.focus")).toHaveLength(2);
    expect(methodNames).toContain("workspace.current");
    expect(methodNames).toContain("surface.create");
    expect(methodNames).toContain("surface.sendText");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux tmux-backed node without cmuxSurface -> created_new, binds workspace+surface, sends tmux attach", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    // Must have used currentWorkspace as anchor, NOT created a new workspace
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("workspace.current");
    expect(methodNames).toContain("surface.create");
    expect(methodNames).toContain("surface.sendText");
    expect(methodNames).toContain("surface.focus");
    expect(methodNames).not.toContain("workspace.create");

    // sendText must contain tmux attach
    const sendCall = calls.find((c) => c.method === "surface.sendText");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall!.params as Record<string, unknown>;
    expect(String(sendParams["text"])).toBe("tmux attach -t r01-dev1-impl\n");
    expect(sendParams["workspaceId"]).toBe("workspace:1");

    const focusCalls = calls.filter((c) => c.method === "surface.focus");
    expect(focusCalls).toHaveLength(1);
    expect((focusCalls[0]!.params as Record<string, unknown>)["workspaceId"]).toBe("workspace:1");

    // Binding must be persisted with both workspace and surface
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux external-cli node -> created_helper, honest helper text, no tmux attach", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "ext-node");
    sessionRegistry.registerSession(node.id, "r01-ext-node");
    sessionRegistry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "r01-ext-node" });

    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/ext-node/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_helper");

    // Helper text must include honest commands, NOT tmux attach
    const sendCall = calls.find((c) => c.method === "surface.sendText");
    expect(sendCall).toBeDefined();
    const text = String((sendCall!.params as Record<string, unknown>)["text"]);
    expect(text).not.toContain("tmux attach");
    expect(text).toContain("rig capture r01-ext-node");
    expect(text).toContain("rig transcript r01-ext-node --tail 100");
    expect(text).toContain("rig send r01-ext-node");
    expect(text).toContain("--verify");
  });

  it("POST .../open-cmux sendText failure -> does not report ok:true, binding still persisted", async () => {
    const { adapter: cmux } = failingCmux("surface.sendText");
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toContain("connection lost");

    // Binding should still be persisted (surface was created before sendText failed)
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux focusSurface failure after creation -> does not report ok:true", async () => {
    const { adapter: cmux } = failingCmux("surface.focus");
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toContain("connection lost");
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
    expect(body.transcript.tailCommand).toBe("rig transcript dev-impl@test-rig --tail 100");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Context refresh route tests ---

  it("GET /api/rigs/:id/nodes?refresh=true calls contextMonitor.pollOnce before projection", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => {});
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const rig = setup.rigRepo.createRig("refresh-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    await appWithMonitor.request(`/api/rigs/${rig.id}/nodes?refresh=true`);

    expect(pollOnceSpy).toHaveBeenCalledOnce();
    db2.close();
  });

  it("GET /api/rigs/:id/nodes without refresh does not call pollOnce", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => {});
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const rig = setup.rigRepo.createRig("no-refresh-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    await appWithMonitor.request(`/api/rigs/${rig.id}/nodes`);

    expect(pollOnceSpy).not.toHaveBeenCalled();
    db2.close();
  });

  it("GET /api/rigs/:id/nodes?refresh=true returns 502 when pollOnce throws", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => { throw new Error("statusline read failed"); });
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const rig = setup.rigRepo.createRig("fail-refresh-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await appWithMonitor.request(`/api/rigs/${rig.id}/nodes?refresh=true`);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("context_refresh_failed");
    expect(body.detail).toContain("statusline read failed");
    db2.close();
  });

  it("GET /api/rigs/:id/nodes?refresh=true works when no contextMonitor is wired", async () => {
    const db2 = createFullTestDb();
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appNoMonitor = createApp({ ...setup }); // no contextMonitor
    const rig = setup.rigRepo.createRig("no-monitor-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await appNoMonitor.request(`/api/rigs/${rig.id}/nodes?refresh=true`);

    // Should succeed (no monitor = nothing to poll; returns stale data honestly)
    expect(res.status).toBe(200);
    db2.close();
  });
});
