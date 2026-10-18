import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { compactNodeProjection } from "../../cli/src/commands/ps.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, ProjectionResult, ReadinessResult, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const blocked: ReadinessResult = { ready: false, code: "trust_gate", reason: "fixture trust prompt" };

describe("ContextMonitor readiness ownership", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let events: EventBus;
  let repo: RigRepository;
  let home: string;
  beforeEach(() => {
    db = createFullTestDb(); registry = new SessionRegistry(db); events = new EventBus(db); repo = new RigRepository(db);
    home = mkdtempSync(join(tmpdir(), "readiness-race-"));
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  function seed(runtime = "claude-code", name = "dev-agent@fixture") {
    const rig = repo.createRig(name);
    const node = repo.addNode(rig.id, "agent", { runtime });
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, "failed");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%11" });
    return { rig, node, session };
  }
  function makeMonitor(runtime: string, checkReady: (binding: NodeBinding) => Promise<ReadinessResult>) {
    return new ContextMonitor(db, new ContextUsageStore(db, { stateDir: home, codexHomeDir: home }),
      undefined, undefined, { [runtime]: { checkReady } });
  }
  function state(id: string) {
    return db.prepare("SELECT status, startup_status, startup_completed_at FROM sessions WHERE id = ?").get(id);
  }

  it.each(["claude-code", "codex"].flatMap(runtime => [true, false].flatMap(ready =>
    ["replacement", "generation", "pane", "window", "binding session", "clear binding", "external", "exited", "pending", "ready", "new failed attempt"]
      .map(change => ({ runtime, ready, change })))))("discards $runtime ready=$ready after $change", async ({ runtime, ready, change }) => {
    const result: ReadinessResult = ready ? { ready: true } : blocked;
    const { rig, node, session } = seed(runtime);
    const gate = deferred<ReadinessResult>(); const entered = deferred<void>();
    const check = vi.fn(() => { entered.resolve(); return gate.promise; });
    const monitor = makeMonitor(runtime, check);
    const poll = monitor.pollOnce(); await entered.promise;
    if (change === "replacement") registry.registerSession(node.id, session.sessionName);
    if (change === "generation") registry.mintOccupantTenure(node.id, "handover");
    if (change === "pane") registry.updateBinding(node.id, { tmuxPane: "%22" });
    if (change === "window") registry.updateBinding(node.id, { tmuxWindow: "@22" });
    if (change === "binding session") registry.updateBinding(node.id, { tmuxSession: "dev-replacement@fixture" });
    if (change === "clear binding") registry.clearBinding(node.id);
    if (change === "external") registry.updateBinding(node.id, { attachmentType: "external_cli" });
    if (change === "exited") registry.updateStatus(session.id, "exited");
    if (change === "pending" || change === "ready") registry.updateStartupStatus(session.id, change);
    if (change === "new failed attempt") {
      events.emit({ type: "node.startup_pending", rigId: rig.id, nodeId: node.id });
      events.emit({ type: "node.startup_failed", rigId: rig.id, nodeId: node.id, sessionId: session.id, error: "new attempt failed" });
    }
    const rows = () => db.prepare("SELECT id, status, startup_status, startup_completed_at FROM sessions ORDER BY id").all();
    const before = rows();
    gate.resolve(result); await poll;
    expect(rows(), `${runtime}: ${change}, ready=${result.ready}`).toEqual(before);
  });

  it("does not probe a later seat using an obsolete poll snapshot", async () => {
    const seeds = [seed("claude-code", "dev-one@fixture"), seed("claude-code", "dev-two@fixture")];
    const entered = deferred<NodeBinding>(); const gate = deferred<void>();
    const check = vi.fn(async (binding: NodeBinding) => { entered.resolve(binding); await gate.promise; return blocked; });
    const poll = makeMonitor("claude-code", check).pollOnce();
    const first = await entered.promise;
    const later = seeds.find(({ node }) => node.id !== first.nodeId)!;
    registry.updateStartupStatus(later.session.id, "ready");
    gate.resolve(); await poll;
    expect(check).toHaveBeenCalledTimes(1);
    expect(state(later.session.id)).toMatchObject({ startup_status: "ready" });
  });

  it.each(["pending", "ready", "failed"] as const)("a delayed probe cannot overwrite a real startup retry at %s", async status => {
    const { rig, node, session } = seed();
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      capturePaneContent: vi.fn(async () => "❯ \n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n"),
    } as unknown as TmuxAdapter;
    const adapter: RuntimeAdapter = {
      runtime: "claude-code", listInstalled: async () => [],
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })),
    };
    const input: StartupInput = {
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { ...registry.getBindingForNode(node.id)!, cwd: home }, adapter, isRestore: false,
      plan: { runtime: "claude-code", cwd: home, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [{ type: "send_text", value: "fixture role", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }],
    };
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux, sleep: async () => {} });
    vi.mocked(adapter.project).mockResolvedValueOnce({ projected: [], skipped: [], failed: [{ effectiveId: "fixture", error: "projection unavailable" }] });
    expect((await orchestrator.startNode(input)).startupStatus).toBe("failed");
    expect(tmux.sendText).not.toHaveBeenCalled();
    const probe = deferred<ReadinessResult>(); const entered = deferred<void>();
    const monitor = makeMonitor("claude-code", () => { entered.resolve(); return probe.promise; });
    const poll = monitor.pollOnce(); await entered.promise;
    const projection = deferred<ProjectionResult>();
    if (status === "pending") vi.mocked(adapter.project).mockReturnValueOnce(projection.promise);
    if (status === "failed") vi.mocked(adapter.project).mockResolvedValueOnce({ projected: [], skipped: [], failed: [{ effectiveId: "fixture", error: "new projection failure" }] });
    const retry = orchestrator.startNode(input);
    if (status !== "pending") await retry;
    const before = state(session.id);
    probe.resolve(status === "failed" ? { ready: true } : blocked); await poll;
    const after = state(session.id);
    projection.resolve({ projected: [], skipped: [], failed: [] }); await retry;
    expect(before).toMatchObject({ startup_status: status });
    expect(after).toEqual(before);
    expect(tmux.sendText).toHaveBeenCalledTimes(status === "failed" ? 0 : 1);
  });

  it.each([true, false])("still applies an unchanged current probe and repeats safely (ready=%s)", async ready => {
    const { session } = seed();
    const check = vi.fn(async () => ready ? { ready: true } as const : blocked);
    const monitor = makeMonitor("claude-code", check);
    await monitor.pollOnce();
    const first = state(session.id);
    expect(first).toMatchObject({ startup_status: ready ? "ready" : "attention_required" });
    await monitor.pollOnce();
    expect(state(session.id)).toEqual(first);
    expect(check).toHaveBeenCalledTimes(ready ? 1 : 2);
  });

  it.each(["claude-code", "codex"].flatMap(runtime => [true, false].map(ready => ({ runtime, ready }))))(
    "probes the recorded $runtime session despite a lasting binding mismatch (ready=$ready)", async ({ runtime, ready }) => {
      const { rig, node, session } = seed(runtime);
      registry.updateBinding(node.id, { tmuxSession: "dev-other@fixture" });
      const binding = registry.getBindingForNode(node.id);
      const check = vi.fn(async () => ready ? { ready: true } as const : blocked);
      const monitor = makeMonitor(runtime, check);

      await monitor.pollOnce();
      expect(state(session.id)).toMatchObject({ status: "running", startup_status: ready ? "ready" : "attention_required" });
      const inventory = getNodeInventory(db, rig.id);
      expect(inventory).toMatchObject([{ nodeId: node.id, startupStatus: ready ? "ready" : "attention_required" }]);
      expect(compactNodeProjection(inventory)).toMatchObject([{ startupStatus: ready ? "ready" : "attention_required" }]);
      expect(check).toHaveBeenCalledWith(expect.objectContaining({ nodeId: node.id, tmuxSession: session.sessionName }));
      const first = state(session.id);
      await monitor.pollOnce();
      expect(state(session.id)).toEqual(first);
      expect(check).toHaveBeenCalledTimes(ready ? 1 : 2);
      expect(registry.getBindingForNode(node.id)).toEqual(binding);
    },
  );

  it("keeps a failed probe unknown and lets the next current probe recover", async () => {
    const { session } = seed();
    const check = vi.fn<() => Promise<ReadinessResult>>()
      .mockRejectedValueOnce(new Error("fixture observation unavailable")).mockResolvedValue({ ready: true });
    const monitor = makeMonitor("claude-code", check);
    const before = state(session.id);
    await monitor.pollOnce(); expect(state(session.id)).toEqual(before);
    await monitor.pollOnce(); expect(state(session.id)).toMatchObject({ startup_status: "ready" });
  });
});
