// Supplied menu captures and modeled process/input execution; no native Claude approval input.
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { attachAgentActivity, getNodeInventory } from "../src/domain/node-inventory.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { classifyPaneActivity, mapPaneState, probeSessionActivity, SessionTransport } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { transportRoutes } from "../src/routes/transport.js";

const oldMenu = `  2 new MCP servers found in .mcp.json
  Select any you wish to enable.

  MCP servers may execute code or access system resources. All tool calls
  require approval. Learn more in the MCP documentation.

  ❯ [✔] dummy1
    [✔] dummy2
 Space to select · Enter to confirm · Esc to reject all`;
const newMenu = oldMenu.replace("in .mcp.json", "in this project")
  .replace(" Space to select · Enter to confirm · Esc to reject all", "       Enable selected\n Space to select · Esc to reject all");
const rule = "─".repeat(60);
const composer = `Claude Code v2.1.303\n${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const frames = [
  { id: "old-current-MCP", pane: oldMenu },
  { id: "2.1.303-current-MCP", pane: newMenu },
  { id: "genuine-composer", pane: composer },
  { id: "old-MCP-history-before-composer", pane: `${oldMenu}\n\n${composer}` },
  { id: "new-MCP-history-before-composer", pane: `${newMenu}\n\n${composer}` },
  { id: "ordinary-current-permission", pane: "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel" },
  { id: "MCP-prose-before-composer", pane: `The project has new MCP servers. Select any you wish to enable.\n\n${composer}` },
  { id: "clipped-new-MCP", pane: newMenu.split("\n").slice(0, 3).join("\n") },
  { id: "current-checkbox-cursor-without-normal-composer", pane: "Choose\n❯ [✔] option\nSpace to select · Esc to reject all" },
];
const cleanup: Array<() => void | Promise<void>> = [];
const records: unknown[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
afterAll(() => {
  const dir = process.env.CHECKPOINT_OUTPUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "observations.json"), JSON.stringify(records, null, 2) + "\n");
});

describe("current Claude MCP menus through assessment, readiness and HTTP send", () => {
  it.each(frames)("$id", async frame => {
    const db = new Database(":memory:"); cleanup.push(() => db.close()); migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('node','rig','worker','claude-code');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('binding','node','worker@test','%1');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('session','node','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('generation','node',1,'g1','fresh');`);
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); guard.recoverActivation();
    let staged = "", command = "claude";
    const effects: Array<{ kind: string; argv: string[]; text?: string }> = [];
    const tmux = new TmuxAdapter(async () => "", {
      writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/input", bufferName: () => "input",
    }, async argv => {
      if (argv[1] === "paste-buffer") effects.push({ kind: "paste", argv: [...argv], text: staged });
      if (argv[1] === "send-keys") effects.push({ kind: "keys", argv: [...argv] });
      return "";
    });
    tmux.deliveryGuard = guard;
    vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    vi.spyOn(tmux, "getPaneCommand").mockImplementation(async () => command);
    vi.spyOn(tmux, "getPanePid").mockResolvedValue(null);
    vi.spyOn(tmux, "capturePaneContent").mockResolvedValue(frame.pane);
    const fsError = () => { throw new Error("unexpected filesystem effect"); };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: {
      exists: () => false, readFile: fsError, writeFile: fsError, mkdirp: fsError, copyFile: fsError,
    }, listProcesses: () => [], sleep: async () => {} });
    const binding = { id: "binding", nodeId: "node", tmuxSession: "worker@test", tmuxWindow: null, tmuxPane: "%1",
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture" };
    const assessments = [
      { paneCommand: "bash", verified: false }, { paneCommand: "bash", verified: true }, { paneCommand: "claude", verified: false },
    ].map(input => ({ ...input, result: assessNativeResumeProbe({ runtime: "claude-code", paneContent: frame.pane,
      paneCommand: input.paneCommand, ...(input.verified ? { claudeResumeIdentityVerified: true } : {}) }) }));
    const readiness: unknown[] = [];
    for (const paneCommand of ["bash", "claude"]) { command = paneCommand; readiness.push({ paneCommand, result: await adapter.checkReady(binding) }); }
    command = "claude";
    const now = new Date("2026-10-19T19:30:00Z");
    const eventBus = new EventBus(db), activity = new AgentActivityStore({ db, eventBus });
    const transport = new SessionTransport({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux,
      eventBus, agentActivityStore: activity, now: () => now, sleep: async () => {} });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/transport", transportRoutes());
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const sends: Array<{ hook: string; status: number; body: { ok: boolean; reason?: string }; effects: typeof effects }> = [];
    for (const hook of ["none", "running", "permission"] as const) {
      if (hook !== "none") activity.recordHookEvent({ runtime: "claude-code", sessionName: "worker@test",
        hookEvent: hook === "running" ? "UserPromptSubmit" : "Notification", ...(hook === "permission" ? { subtype: "permission_prompt" } : {}), occurredAt: now.toISOString() });
      effects.length = 0;
      const response = await fetch(`http://127.0.0.1:${port}/api/transport/send`, { method: "POST",
        headers: { "content-type": "application/json", "x-openrig-session": "sender@test" },
        body: JSON.stringify({ session: "worker@test", text: "ordinary status update" }) });
      const body = await response.json();
      sends.push({ hook, status: response.status, body, effects: structuredClone(effects) });
    }
    const classified = classifyPaneActivity(frame.pane, { runtime: "claude-code" });
    const structural = await new SeatStructuralActivityService(tmux).pollSeat("worker@test");
    // startup.ts's existing permission reader calls this seam with runtime codex.
    const startupActivity = await probeSessionActivity({ sessionName: "worker@test", runtime: "codex", attachmentType: "tmux", tmuxAdapter: tmux, now });
    const startupPermission = startupActivity.state === "unknown" ? null
      : startupActivity.state === "needs_input" && ["permission_prompt", "selection_prompt"].includes(startupActivity.reason);
    const inventory = await attachAgentActivity(getNodeInventory(db, "rig"), { tmuxAdapter: tmux, captureFallback: true, now });
    records.push({ id: frame.id, pane: frame.pane, assessments, readiness, classifier: classified, structural, startupPermission,
      inventory: inventory.map(x => x.agentActivity), sends });
    const currentMcp = frame.id === "old-current-MCP" || frame.id === "2.1.303-current-MCP";
    for (const { hook, status, body, effects } of sends) {
      const currentSelection = currentMcp || frame.id === "ordinary-current-permission";
      const blocked = hook === "permission" || ((hook === "none" || hook === "running") && currentSelection);
      expect(body.ok).toBe(!blocked);
      expect(status).toBe(blocked ? 409 : 200);
      expect(effects.map(x => x.kind)).toEqual(blocked ? [] : ["paste", "keys"]);
      if (blocked) expect(body).toMatchObject({ ok: false, reason: "target_needs_input" });
      else {
        expect(effects[0]?.text).toBe("ordinary status update");
        expect(effects[1]?.argv.at(-1)).toBe("Enter");
      }
    }
    const assessmentCodes: Record<string, string[]> = {
      "old-current-MCP": ["mcp_gate", "mcp_gate", "mcp_gate"],
      "2.1.303-current-MCP": ["mcp_gate", "mcp_gate", "mcp_gate"],
      "genuine-composer": ["active_runtime", "active_runtime", "active_runtime"],
      "old-MCP-history-before-composer": ["mcp_gate", "mcp_gate", "mcp_gate"], // Retained legacy probe limit.
      "new-MCP-history-before-composer": ["active_runtime", "active_runtime", "active_runtime"],
      "ordinary-current-permission": ["returned_to_shell", "verified_native_identity", "active_runtime"],
      "MCP-prose-before-composer": ["active_runtime", "active_runtime", "active_runtime"],
      "clipped-new-MCP": ["returned_to_shell", "returned_to_shell", "active_runtime"],
      "current-checkbox-cursor-without-normal-composer": ["returned_to_shell", "verified_native_identity", "active_runtime"],
    };
    expect(assessments.map(x => x.result.code)).toEqual(assessmentCodes[frame.id]);
    if (currentMcp) expect(assessments.map(x => x.result.status)).toEqual(["inconclusive", "inconclusive", "inconclusive"]);
    const ready = readiness as Array<{ result: { ready: boolean; code?: string } }>;
    expect(ready.map(x => x.result.ready)).toEqual(currentMcp || frame.id === "old-MCP-history-before-composer" ? [false, false]
      : ["ordinary-current-permission", "clipped-new-MCP", "current-checkbox-cursor-without-normal-composer"].includes(frame.id) ? [false, true] : [true, true]);
    if (currentMcp) expect(classified).toMatchObject({ state: "attention", reason: "selection_prompt" });
    expect(structural).toMatchObject({ state: classified.state, reason: classified.reason });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.agentActivity).toMatchObject({ state: mapPaneState(classified.state), reason: classified.reason });
    expect(startupPermission).toBe(currentMcp || frame.id === "ordinary-current-permission" ? true
      : ["clipped-new-MCP", "current-checkbox-cursor-without-normal-composer"].includes(frame.id) ? null : false);
  });
});

// The menu stays current when selection moves, but prose/partial structures do not acquire a veto.
describe("MCP menu structure and history boundaries", () => {
  const variants = [
    ["old unchecked", oldMenu.replaceAll("[✔]", "[ ]"), true],
    ["new unchecked", newMenu.replaceAll("[✔]", "[ ]"), true],
    ["second checkbox", newMenu.replace("❯ [✔] dummy1", "  [✔] dummy1").replace("[✔] dummy2", "❯ [ ] dummy2"), true],
    ["enable action", newMenu.replace("❯ [✔] dummy1", "  [✔] dummy1").replace("Enable selected", "❯ Enable selected"), true],
    ["CRLF and trailing blanks", newMenu.replaceAll("\n", "\r\n") + "\r\n ", true],
    ["single server", newMenu.replace("2 new", "1 new").replace("    [✔] dummy2\n", ""), true],
    ["wrong heading", newMenu.replace("new MCP servers", "new plugins"), false],
    ["missing instruction", newMenu.replace("Select any you wish to enable.", ""), false],
    ["missing warning", newMenu.replace("MCP servers may execute code or access system resources. All tool calls\n  require approval. Learn more in the MCP documentation.", ""), false],
    ["no checkbox items", newMenu.replace(/.*\[✔\].*\n/g, ""), false],
    ["unknown footer", newMenu.replace("Space to select · Esc to reject all", "Enter to continue"), false],
    ["no footer", newMenu.split("\n").slice(0, -1).join("\n"), false],
    ["menu followed by composer", newMenu + "\n" + composer, false],
    ["menu followed by composer draft", newMenu + "\n" + composer.replace("❯ ", "❯ a draft"), false],
  ] as const;
  it.each(variants)("%s", (_name, pane, current) => {
    const classification = classifyPaneActivity(pane, { runtime: "claude-code" });
    const noRuntime = classifyPaneActivity(pane); // Full inventory's structural poller omits a runtime.
    expect(classification.reason === "selection_prompt").toBe(current);
    expect(noRuntime.reason === "selection_prompt").toBe(current);
    const assessment = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: pane, claudeResumeIdentityVerified: true });
    expect(assessment.status).toBe(current ? "inconclusive" : "resumed");
    if (current) expect(assessment.code).toBe("mcp_gate");
  });
});
