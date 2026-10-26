import { TerminalPolicyStore } from "../src/domain/terminal-policy.js";
// OPR.0.4.3.14 — manual compaction trigger route (POST /api/compaction/trigger).
//
// Proves: the route resolves the target + reads the EXISTING context-usage
// projection BEFORE calling the enforcer (known usage permits a manual request
// independently of the threshold); non-Claude → 422 runtime_filter; unknown usage → 409 no_usage_data
// (route passes null, never invents a value); ambiguous → 409; missing field →
// 400; enforcer-unwired → 503. Reuses the shipped SessionTransport + the SAME
// ClaudeCompactionEnforcer (no second path).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
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
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

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

function idleTmux(sendText?: (target: string, text: string) => Promise<{ ok: true }>, sendKeys?: () => Promise<{ ok: true }>): TmuxAdapter {
  return {
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText: sendText ?? (async () => ({ ok: true as const })),
    sendKeys: sendKeys ?? (async () => ({ ok: true as const })),
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
  enforcer: ClaudeCompactionEnforcer;
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

  function buildApp(opts?: { wireEnforcer?: boolean; completeMap?: boolean; bearerToken?: string; afterPreparation?: () => void; afterPreparationSubmit?: () => void | Promise<void> }): AppParts {
    const sentTexts: string[] = [];
    let clock = Date.now();
    const sleep = async (ms: number) => { clock += ms; };
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: idleTmux(async (_t, text) => {
        sentTexts.push(text);
        const marker = text.match(/<!-- openrig-compaction-complete .*? -->/)?.[0];
        const target = text.match(/Write this attempt's complete restore map to ("(?:[^"\\]|\\.)*")/);
        if (opts?.completeMap !== false && marker && target) { const file = JSON.parse(target[1]!); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "# Fixture map\n" + marker); }
        if (marker && target) opts?.afterPreparation?.();
        return { ok: true as const };
      }, async () => { await opts?.afterPreparationSubmit?.(); return { ok: true as const }; }),
      now: () => new Date(clock),
      sleep,
      waitForIdlePollMs: 1,
    });
    const enforcer = new ClaudeCompactionEnforcer(makeSettings(), transport, {
      terminalPolicies: new TerminalPolicyStore(db),
      openrigHome: stateDir, manualPrepWaitMs: 1000, resolveOccupantGeneration: () => "fixture-generation",
      now: () => clock, sleep,
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sessionTransport" as never, transport);
      c.set("contextUsageStore" as never, usageStore);
      c.set("db" as never, db);
      if (opts?.wireEnforcer !== false) c.set("compactionEnforcer" as never, enforcer);
      await next();
    });
    app.route("/api/compaction", compactionRoutes({ bearerToken: opts?.bearerToken }));
    return { app, sentTexts, enforcer };
  }

  it("keeps OpenRig's compaction authority while a no-peer preset refuses a peer trigger", async () => {
    const { claudeNodeId } = seed();
    new TerminalPolicyStore(db).write(claudeNodeId, { preset: "no-peer-interventions", helpers: [], exceptions: {} }, "person", "No peer interventions");
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 90));
    const { app, sentTexts, enforcer } = buildApp();
    const refused = await app.request("/api/compaction/trigger", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-qa@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: "terminal_policy_refused" });
    expect(sentTexts).toEqual([]);
    expect(await enforcer.maybeAutoCompact({ nodeId: claudeNodeId, sessionName: "dev-impl@my-rig", runtime: "claude-code", usedPercentage: 90 })).toEqual({ triggered: true });
    expect(sentTexts).toHaveLength(1);
    expect(enforcer.getPreparationState("dev-impl@my-rig")?.policyActor).toEqual({ source: "openrig" });
  });

  it("keeps automatic compaction running with an unreadable policy while the account reports unknown", async () => {
    const { claudeNodeId } = seed();
    db.prepare("UPDATE seat_terminal_policies SET config_json='{' WHERE node_id=?").run(claudeNodeId);
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 90));
    const { app, enforcer, sentTexts } = buildApp();
    const peer = await app.request("/api/compaction/trigger", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-qa@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }) });
    expect(await peer.json()).toMatchObject({ reason: "terminal_policy_unavailable" });
    for (let tick = 0; tick < 2; tick++) expect(await enforcer.maybeAutoCompact({ nodeId: claudeNodeId,
      sessionName: "dev-impl@my-rig", runtime: "claude-code", usedPercentage: 90 })).toEqual({ triggered: true });
    expect(sentTexts[1]).toContain("/compact");
    const account = await createTestApp(db).app.request("/api/seat/status/dev-impl@my-rig");
    expect(await account.json()).toMatchObject({ terminalPolicy: { state: "unknown" } });
  });

  it("honours an explicit self-compaction exception without changing peer or OpenRig authority", async () => {
    const { claudeNodeId } = seed();
    new TerminalPolicyStore(db).write(claudeNodeId, { preset: "full-control", helpers: [], exceptions: { self: { compaction: "deny" } } }, "person", "Do not compact yourself");
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 42));
    const { app, sentTexts } = buildApp();
    const response = await app.request("/api/compaction/trigger", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-impl@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", skipMap: true }) });
    expect(response.status).toBe(409);
    expect(sentTexts).toEqual([]);
  });

  it("lets an authorised peer finish compaction while automatic compaction is denied", async () => {
    const { claudeNodeId } = seed();
    new TerminalPolicyStore(db).write(claudeNodeId, { preset: "full-control", helpers: [],
      exceptions: { openrig: { compaction: "deny" } } }, "person", "Only compact on request");
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 90));
    const { app, enforcer, sentTexts } = buildApp({ afterPreparationSubmit: async () => {
      if (sentTexts.length === 1) expect(await enforcer.maybeAutoCompact({ nodeId: claudeNodeId,
        sessionName: "dev-impl@my-rig", runtime: "claude-code", usedPercentage: 90 }))
        .toEqual({ triggered: false, reason: "terminal_policy_refused" });
    } });
    const response = await app.request("/api/compaction/trigger", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-qa@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }) });
    expect(response.status).toBe(200);
    expect(sentTexts).toHaveLength(2);
    expect(sentTexts[1]).toContain("/compact");
  });

  it("does not submit compact when its initiating actor loses authority during preparation", async () => {
    const { claudeNodeId } = seed();
    const store = new TerminalPolicyStore(db);
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 42));
    const { app, sentTexts } = buildApp({ afterPreparationSubmit: () => store.write(claudeNodeId,
      { preset: "no-peer-interventions", helpers: [], exceptions: {} }, "person", "Stop peer compaction") });
    const response = await app.request("/api/compaction/trigger", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-qa@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "terminal_policy_refused", preparation: { delivery: "delivered", compact: "not_sent" } });
    expect(sentTexts.some(text => text.startsWith("/compact"))).toBe(false);
  });

  it("keeps a policy refusal after preparation paste uncertain instead of claiming no input", async () => {
    const { claudeNodeId } = seed();
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 42));
    const { app } = buildApp({ afterPreparation: () => new TerminalPolicyStore(db).write(claudeNodeId,
      { preset: "no-peer-interventions", helpers: [], exceptions: {} }, "person", "Stop peer compaction") });
    const response = await app.request("/api/compaction/trigger", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-qa@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ preparation: { delivery: "uncertain", compact: "not_sent" } });
  });

  it("known below-threshold usage permits manual preparation, then /compact follows", async () => {
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
    expect(body).toEqual({ ok: true, session: "dev-impl@my-rig", stage: "compact-sent", compact: expect.stringMatching(/^submitted, unconfirmed: /) });
    // The manual request does not claim that the threshold was reached.
    expect(sentTexts[0]).toContain("OpenRig manual compaction was requested");
    expect(sentTexts[0]).not.toContain("configured compaction threshold");
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
  it("an explicit skip-map uses the same route/enforcer without a published map", async () => {
    const { claudeNodeId } = seed();
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 42));
    const { app, sentTexts } = buildApp({ completeMap: false });
    const res = await app.request("/api/compaction/trigger", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", skipMap: true }),
    });
    expect(res.status).toBe(200);
    expect(sentTexts.filter(t => t.startsWith("/compact"))).toHaveLength(1);
    const state = await app.request("/api/compaction/state?session=dev-impl@my-rig");
    expect((await state.json()).preparation.status).toBe("compact-sent");
  });

  it("cancel disarms a waiting attempt; state reads do not submit compact", async () => {
    seed();
    const { app, sentTexts, enforcer } = buildApp({ completeMap: false });
    await enforcer.maybeAutoCompact({ sessionName: "dev-impl@my-rig", runtime: "claude-code", usedPercentage: 90 });
    const cancel = await app.request("/api/compaction/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect((await cancel.json()).preparation).toMatchObject({ status: "stopped", reason: "preparation_cancelled" });
    const state = await app.request("/api/compaction/state?session=dev-impl@my-rig");
    expect((await state.json()).preparation.status).toBe("stopped");
    expect(sentTexts.filter(t => t.startsWith("/compact"))).toHaveLength(0);
  });

  it("skip-map and cancel preserve bearer authorization and reject malformed opt-in", async () => {
    seed();
    const { app, sentTexts } = buildApp({ bearerToken: "fixture-token" });
    for (const verb of ["trigger", "cancel"]) {
      const denied = await app.request(`/api/compaction/${verb}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "dev-impl@my-rig", skipMap: true }),
      });
      expect(denied.status).toBe(401);
    }
    const malformed = await app.request("/api/compaction/trigger", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
      body: JSON.stringify({ session: "dev-impl@my-rig", skipMap: "yes" }),
    });
    expect(malformed.status).toBe(400);
    expect(sentTexts).toHaveLength(0);
  });

});
