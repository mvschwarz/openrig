import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator, getLatestStartupFailedEvent } from "../src/domain/startup-orchestrator.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

describe("startup completion observes its runtime instead of inheriting cached identity (#3578)", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  function fixture(runtime: "claude-code" | "codex" | "terminal", state: "runtime" | "shell" | "missing" | "unreadable") {
    const repo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const bus = new EventBus(db);
    const rig = repo.createRig("completion");
    const node = repo.addNode(rig.id, "dev.impl", { runtime });
    const name = "dev-impl@completion";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const binding = registry.getBindingForNode(node.id)!;
    const store = new SeatIdentityStore(db);
    const cached = {
      nodeId: node.id, verdict: "verified" as const, evidenceSource: "pane_process" as const, reason: null,
      sessionName: name, observedAt: "2000-01-01T00:00:00.000Z",
      evidence: { registeredPane: "%1", observedPid: 42, observedCommand: runtime, matchedLayer: 1 },
    };
    store.upsert(cached);
    let launchCompleted = false;
    const command = state === "shell" || runtime === "terminal" ? "bash" : runtime === "claude-code" ? "claude" : "codex";
    const tmux = new TmuxAdapter(async (cmd) => {
      if (!launchCompleted) throw new Error("runtime observation preceded launch completion");
      if (state === "unreadable") throw new Error("fixture transport unavailable");
      if (cmd.includes("list-panes")) return state === "missing" ? "" : "%1|0|/project|80|24|1";
      if (cmd.includes("#{pane_pid}")) return "42";
      if (cmd.includes("#{pane_current_command}")) return command;
      throw new Error(`Unexpected fixture command: ${cmd}`);
    });
    const adapter: RuntimeAdapter = {
      runtime, listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => { launchCompleted = true; return { ok: true }; },
      // The runtime was interactive during readiness. It can exit before the final result.
      checkReady: async () => ({ ready: true }),
    };
    const processes: NativeProcessRow[] = [{ pid: 42, ppid: 1, pgid: 42, tpgid: 42,
      executableName: command, command, argv: [command], startedAt: "Sat Jan  1 00:00:00 2000" }];
    const orchestrator = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: bus, tmuxAdapter: tmux,
      listProcesses: async () => processes, sleep: async () => undefined });
    const start = (isRestore: boolean) => orchestrator.startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.id, binding, adapter,
      plan: { runtime, cwd: "/project", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore,
    });
    return { start, store, cached, bus, node, session };
  }

  for (const isRestore of [false, true]) {
    for (const runtime of ["claude-code", "codex"] as const) {
      it.each(["shell", "missing", "unreadable"] as const)(`${runtime}, restore=${isRestore}: cached verified cannot certify %s`, async state => {
        const f = fixture(runtime, state);
        const result = await f.start(isRestore);
        expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
        expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
        const failure = getLatestStartupFailedEvent(db, f.node.id, f.session.id);
        expect(failure?.readinessCode).toBe(state === "shell" ? "returned_to_shell" : "runtime_identity_unverified");
        expect(db.prepare("SELECT seq FROM events WHERE type = 'node.startup_ready' AND node_id = ?").all(f.node.id)).toHaveLength(0);
      });

      it(`${runtime}, restore=${isRestore}: publishes a new positive observation before success`, async () => {
        const f = fixture(runtime, "runtime");
        expect(await f.start(isRestore)).toMatchObject({ ok: true, startupStatus: "ready" });
        const observed = f.store.getForNode(f.node.id);
        expect(observed).toMatchObject({ verdict: "verified", sessionName: f.cached.sessionName });
        expect(Date.parse(observed!.observedAt)).toBeGreaterThan(Date.parse(f.cached.observedAt));
      });
    }
  }

  it("a terminal session removed before completion cannot inherit verified identity", async () => {
    const f = fixture("terminal", "missing");
    expect(await f.start(false)).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("pane_missing");
  });

  it("an older sweep finishing late cannot replace the completion observation", async () => {
    const f = fixture("claude-code", "shell");
    await f.start(false);
    f.store.upsert(f.cached);
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
  });
});
