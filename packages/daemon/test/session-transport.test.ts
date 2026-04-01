import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema]);
  return db;
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle prompt\n❯ "),
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

describe("SessionTransport", () => {
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

  function createTransport(tmux?: TmuxAdapter) {
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
    });
  }

  function seedCanonicalRig() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
    return { rig, node, session };
  }

  function seedLegacyRig() {
    const rig = rigRepo.createRig("r00-legacy");
    const node = rigRepo.addNode(rig.id, "worker-a", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "r00-legacy-worker-a");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r00-legacy-worker-a" });
    return { rig, node, session };
  }

  // Test 1: send calls sendText -> delay -> sendKeys C-m
  it("send calls sendText then sendKeys C-m with delay", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    const tmux = mockTmux({
      sendText: async () => { callOrder.push("sendText"); return { ok: true }; },
      sendKeys: async (_t, keys) => { callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["sendText", "sendKeys:C-m"]);
  });

  // Test 2: send to canonical session name resolves correctly
  it("send to canonical session name resolves correctly", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "message");
  });

  // Test 3: send to legacy session name resolves correctly
  it("send to legacy session name resolves correctly", async () => {
    seedLegacyRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("r00-legacy-worker-a", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("r00-legacy-worker-a", "message");
  });

  // Test 4: send to missing session returns error with guidance
  it("send to missing session returns error with guidance", async () => {
    const tmux = mockTmux({ hasSession: async () => false });
    const transport = createTransport(tmux);

    const result = await transport.send("nonexistent", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session_missing");
    expect(result.error).toContain("not found");
    expect(result.error).toContain("rigged ps");
  });

  // Test 5: send where sendKeys C-m fails returns "text visible but not submitted"
  it("send where C-m fails returns submit_failed with guidance", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("submit_failed");
    expect(result.error).toContain("visible");
    expect(result.error).toContain("not submitted");
  });

  // Test 6: send with verify captures pane and checks for text
  it("send with verify checks pane for sent text", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "some output\nhello\n❯ ",
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
  });

  // Test 7: send with mid-work detected → refusal
  it("send with mid-work detected refuses with reason mid_work", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing files\nesc to interrupt",
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
    expect(result.error).toContain("mid-task");
    expect(result.error).toContain("force");
  });

  // Test 8: send with mid-work + force sends anyway
  it("send with mid-work + force sends anyway", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { force: true });
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  // Test 9: send when tmux unavailable → guided error
  it("send when tmux unavailable returns tmux_unavailable with guidance", async () => {
    const tmux = mockTmux({
      hasSession: async () => { throw new Error("no server running"); },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
    expect(result.error).toContain("tmux");
  });

  // Test 10: capture returns pane content
  it("capture returns pane content for existing session", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "line1\nline2\nline3",
    });
    const transport = createTransport(tmux);

    const result = await transport.capture("dev-impl@my-rig");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("line1");
  });

  // Test 11: resolveSessions by rig returns running sessions
  it("resolveSessions by rig returns running sessions", async () => {
    seedCanonicalRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ rig: "my-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@my-rig");
    }
  });

  // Test 12: resolveSessions global returns all running sessions across all rigs
  it("resolveSessions global returns all running sessions across all rigs", async () => {
    seedCanonicalRig(); // rig "my-rig" with dev-impl@my-rig
    seedLegacyRig();    // rig "r00-legacy" with r00-legacy-worker-a
    const transport = createTransport();

    const result = await transport.resolveSessions({ global: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(2);
      const names = result.sessions.map((s) => s.sessionName).sort();
      expect(names).toContain("dev-impl@my-rig");
      expect(names).toContain("r00-legacy-worker-a");
    }
  });

  // Test 13: resolveSessions by pod filters by logicalId prefix
  it("resolveSessions by pod filters by logicalId prefix", async () => {
    const rig = rigRepo.createRig("multi-rig");
    // dev pod
    const devNode = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const devSess = sessionRegistry.registerSession(devNode.id, "dev-impl@multi-rig");
    sessionRegistry.updateStatus(devSess.id, "running");
    sessionRegistry.updateBinding(devNode.id, { tmuxSession: "dev-impl@multi-rig" });
    // orch pod
    const orchNode = rigRepo.addNode(rig.id, "orch.lead", { role: "orchestrator", runtime: "claude-code" });
    const orchSess = sessionRegistry.registerSession(orchNode.id, "orch-lead@multi-rig");
    sessionRegistry.updateStatus(orchSess.id, "running");
    sessionRegistry.updateBinding(orchNode.id, { tmuxSession: "orch-lead@multi-rig" });

    const transport = createTransport();
    const result = await transport.resolveSessions({ pod: "dev", rig: "multi-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@multi-rig");
    }
  });
});
