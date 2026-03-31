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
});
