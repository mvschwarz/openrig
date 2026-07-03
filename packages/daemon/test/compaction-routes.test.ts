// OPR.0.4.3.14 — manual compaction trigger route (POST /api/compaction/trigger).
//
// Proves: the route resolves the target + reads the EXISTING context-usage
// projection BEFORE calling the enforcer (the prep prompt carries the sourced
// usage %); non-Claude → 422 runtime_filter; unknown usage → 409 no_usage_data
// (route passes null, never invents a value); ambiguous → 409; missing field →
// 400; enforcer-unwired → 503. Reuses the shipped SessionTransport + the SAME
// ClaudeCompactionEnforcer (no second path).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { ClaudeCompactionPolicy, SettingsStore } from "../src/domain/user-settings/settings-store.js";
import type { ContextUsage } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { compactionRoutes } from "../src/routes/compaction.js";
import { createFullTestDb } from "./helpers/test-app.js";

const POLICY: ClaudeCompactionPolicy = {
  enabled: true,
  thresholdPercent: 80,
  preCompactInstruction: "",
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: "",
};

function makeSettings(): SettingsStore {
  return { resolveClaudeCompactionPolicy: () => POLICY } as unknown as SettingsStore;
}

function idleTmux(sendText?: (target: string, text: string) => Promise<{ ok: true }>): TmuxAdapter {
  return {
    hasSession: async () => true,
    sendText: sendText ?? (async () => ({ ok: true as const })),
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

function knownUsage(sessionName: string, usedPercentage: number): ContextUsage {
  return {
    availability: "known",
    reason: null,
    source: "claude_statusline_json",
    usedPercentage,
    remainingPercentage: 100 - usedPercentage,
    contextWindowSize: 200_000,
    totalInputTokens: null,
    totalOutputTokens: null,
    currentUsage: null,
    transcriptPath: "/tmp/claude.jsonl",
    sessionId: "sid-123",
    sessionName,
    sampledAt: new Date().toISOString(),
    fresh: true,
  };
}

interface AppParts {
  app: Hono;
  sentTexts: string[];
}

describe("compaction routes — POST /api/compaction/trigger", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let usageStore: ContextUsageStore;
  let stateDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    stateDir = mkdtempSync(join(tmpdir(), "compaction-route-"));
    usageStore = new ContextUsageStore(db, { stateDir });
  });

  afterEach(() => {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function seed(): { claudeNodeId: string; codexNodeId: string } {
    const rig = rigRepo.createRig("my-rig");
    const claude = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const s1 = sessionRegistry.registerSession(claude.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateBinding(claude.id, { tmuxSession: "dev-impl@my-rig" });

    const codex = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const s2 = sessionRegistry.registerSession(codex.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(s2.id, "running");
    sessionRegistry.updateBinding(codex.id, { tmuxSession: "dev-qa@my-rig" });
    return { claudeNodeId: claude.id, codexNodeId: codex.id };
  }

  function buildApp(opts?: { wireEnforcer?: boolean }): AppParts {
    const sentTexts: string[] = [];
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: idleTmux(async (_t, text) => { sentTexts.push(text); return { ok: true as const }; }),
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });
    const enforcer = new ClaudeCompactionEnforcer(makeSettings(), transport, { openrigHome: stateDir });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sessionTransport" as never, transport);
      c.set("contextUsageStore" as never, usageStore);
      c.set("db" as never, db);
      if (opts?.wireEnforcer !== false) c.set("compactionEnforcer" as never, enforcer);
      await next();
    });
    app.route("/api/compaction", compactionRoutes());
    return { app, sentTexts };
  }

  it("sources the KNOWN context-usage % before triggering: prep prompt carries it, /compact follows", async () => {
    const { claudeNodeId } = seed();
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 42));
    const { app, sentTexts } = buildApp();

    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, session: "dev-impl@my-rig", stage: "compact-sent" });
    // Phase 1 prep carries the sourced usage % (proves usage read before trigger).
    expect(sentTexts[0]).toContain("Current context usage is 42%");
    // Phase 2 /compact followed.
    expect(sentTexts[1]).toContain("/compact");
    expect(sentTexts).toHaveLength(2);
  });

  it("non-Claude seat → 422 runtime_filter (rejected, not silent no-op)", async () => {
    seed();
    const { app, sentTexts } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-qa@my-rig" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("runtime_filter");
    expect(sentTexts).toHaveLength(0);
  });

  it("unknown usage (no sample persisted) → 409 no_usage_data (never triggers blind)", async () => {
    seed();
    const { app, sentTexts } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("no_usage_data");
    expect(sentTexts).toHaveLength(0);
  });

  it("ambiguous session across rigs → 409", async () => {
    const rigA = rigRepo.createRig("rig-a");
    const nA = rigRepo.addNode(rigA.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(nA.id, "dev-impl@shared");
    const rigB = rigRepo.createRig("rig-b");
    const nB = rigRepo.addNode(rigB.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(nB.id, "dev-impl@shared");

    const { app } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@shared" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("ambiguous");
  });

  it("missing session field → 400", async () => {
    seed();
    const { app } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("enforcer not wired → 503 compaction_unavailable", async () => {
    seed();
    const { app } = buildApp({ wireEnforcer: false });
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("compaction_unavailable");
  });
});
