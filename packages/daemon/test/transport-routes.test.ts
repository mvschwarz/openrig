import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
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
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { transportRoutes } from "../src/routes/transport.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(): TmuxAdapter {
  return {
    hasSession: async () => true,
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
    capturePaneContent: async () => "idle\n❯ ",
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: async () => null,
  } as unknown as TmuxAdapter;
}

function createApp(deps: { sessionTransport: SessionTransport }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionTransport" as never, deps.sessionTransport);
    await next();
  });
  app.route("/api/transport", transportRoutes());
  return app;
}

describe("transport routes", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    const node1 = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const sess1 = sessionRegistry.registerSession(node1.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sess1.id, "running");
    sessionRegistry.updateBinding(node1.id, { tmuxSession: "dev-impl@my-rig" });

    const node2 = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const sess2 = sessionRegistry.registerSession(node2.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(sess2.id, "running");
    sessionRegistry.updateBinding(node2.id, { tmuxSession: "dev-qa@my-rig" });
    return { rig, node1, node2 };
  }

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", { role: "orchestrator", runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
    return { rig, node, session };
  }

  it("POST /send with valid session returns 200 with SendResult", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionName).toBe("dev-impl@my-rig");
  });

  it("POST /send with mid-work refusal returns 409", async () => {
    seedRig();
    const tmux = {
      ...mockTmux(),
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("mid_work");
  });

  it("POST /send with ambiguous session returns 409", async () => {
    // Create two rigs, both with same canonical session name
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@shared", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("ambiguous");
  });

  it("POST /send to external_cli target returns 409 with honest transport guidance", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "orch1-lead@rigged-buildout", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transport_unavailable");
    expect(body.error).toContain("external CLI");
  });

  it("POST /capture with rig targeting returns multi-session results", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeDefined();
    expect(body.results.length).toBe(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("POST /capture with rig targeting includes external_cli targets as explicit failures", async () => {
    seedRig();
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "rigged-buildout" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.ok).toBe(false);
    expect(body.results[0]!.reason).toBe("transport_unavailable");
  });

  it("POST /capture for external_cli target returns 409 with honest transport guidance", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "orch1-lead@rigged-buildout" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transport_unavailable");
    expect(body.error).toContain("external CLI");
  });

  it("POST /broadcast without rig/pod broadcasts globally to all running sessions", async () => {
    seedRig(); // creates my-rig with dev-impl@my-rig and dev-qa@my-rig
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "global message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(2);
  });

  it("POST /broadcast with partial failure returns honest per-target outcomes", async () => {
    seedRig();
    let callCount = 0;
    const tmux = {
      ...mockTmux(),
      hasSession: async () => true,
      sendText: async () => {
        callCount++;
        // Second send fails
        if (callCount > 1) return { ok: false as const, code: "err", message: "failed" };
        return { ok: true as const };
      },
      capturePaneContent: async () => "idle\n❯ ",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "broadcast message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
  });

  it("POST /broadcast includes external_cli targets as explicit transport_unavailable failures", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "rigged-buildout", text: "broadcast message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.reason).toBe("transport_unavailable");
  });
});
