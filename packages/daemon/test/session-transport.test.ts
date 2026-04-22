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
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
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
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
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

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", {
      role: "orchestrator",
      runtime: "claude-code",
    });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
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
    expect(result.error).toContain("rig ps");
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
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        return captureCount < 3 ? "some output\n❯ " : "some output\nhello\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("send with verify does not false-positive on pre-existing pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
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

  it("send does not refuse on idle codex status lines truncated with unicode ellipsis", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Lane closed.",
        "",
        "  2 background terminals running · /ps to view · /stop to close",
        "",
        "› Summarize recent commits",
        "",
        "  gpt-5.4 xhigh fast · Context [████ ] · ~/code/substrate/shared-docs/rigs/kerne…",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send does not refuse on idle prompt lines ending in ascii ellipsis", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "ready prompt...\n❯ ",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send does not refuse when Working text is stale scrollback above an idle Codex prompt", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
        "",
        "› Use /skills to list available skills",
        "",
        "  gpt-5.4 xhigh fast · Context [█▉   ] · ~/code/projects/openrig-hub · Fas…",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send does not refuse when Working text is stale scrollback above an idle Claude Code prompt", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "✢ Working… (5m 9s · ↑ 4.4k tokens)",
        "  ⎿  Tip: Use /btw to ask a quick side question",
        "",
        "❯ ",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send still refuses when prompt char line contains mid-work text (active Claude input)", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ Working on a task.",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
  });

  it("send refuses when Codex trust-prompt choice line is the active pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "› 1. Yes, continue",
        "  2. Yes, allow all tools",
        "  3. No, cancel",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
  });

  it("send refuses when Claude Code trust-prompt choice line is the active pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ 1. Yes",
        "  2. Yes, allow all edits in domain/ during this session",
        "  3. No",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
  });

  it("send still refuses when Working footer is present with no idle prompt below it", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Reading file…",
        "",
        "◦ Working (2m 3s • esc to interrupt)",
        "  ⎿  Processing 4 files",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
  });

  it("send to terminal session with foreground non-shell command refuses with mid_work", async () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "infra.ui", {
      role: "ui", runtime: "terminal",
    });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@term-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "infra-ui@term-rig" });

    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "VITE ready\npress h + enter to show help",
      getPaneCommand: async () => "node",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("infra-ui@term-rig", "printf 'hello\\n'");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mid_work");
    expect(result.error).toContain("mid-task");
    expect(sendTextSpy).not.toHaveBeenCalled();
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

  it("send to external_cli target fails honestly before tmux transport", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.send("orch1-lead@rigged-buildout", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("transport_unavailable");
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
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

  it("capture for external_cli target fails honestly before tmux transport", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.capture("orch1-lead@rigged-buildout");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
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
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ global: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(3);
      const names = result.sessions.map((s) => s.sessionName).sort();
      expect(names).toContain("dev-impl@my-rig");
      expect(names).toContain("r00-legacy-worker-a");
      expect(names).toContain("orch1-lead@rigged-buildout");
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

  it("broadcast includes external_cli targets as explicit transport_unavailable failures", async () => {
    seedCanonicalRig();
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.broadcast({ global: true }, "hello", { force: true });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionName: "orch1-lead@rigged-buildout",
          ok: false,
          reason: "transport_unavailable",
        }),
      ]),
    );
  });
});
