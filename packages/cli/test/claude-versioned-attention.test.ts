import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { Hono } from "hono";
import { seatCommand, type SeatDeps } from "../src/commands/seat.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { createFullTestDb } from "../../daemon/test/helpers/test-app.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { SessionRegistry } from "../../daemon/src/domain/session-registry.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { SnapshotRepository } from "../../daemon/src/domain/snapshot-repository.js";
import { CheckpointStore } from "../../daemon/src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../../daemon/src/domain/snapshot-capture.js";
import { NodeLauncher } from "../../daemon/src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../../daemon/src/domain/restore-orchestrator.js";
import { SeatAttentionReconciler } from "../../daemon/src/domain/seat-attention-reconciler.js";
import { SeatIdentityReconciler } from "../../daemon/src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../../daemon/src/domain/seat-identity-store.js";
import { AgentActivityStore } from "../../daemon/src/domain/agent-activity-store.js";
import { getNodeInventory } from "../../daemon/src/domain/node-inventory.js";
import { sessionAdminRoutes } from "../../daemon/src/routes/sessions.js";
import type { TmuxAdapter } from "../../daemon/src/adapters/tmux.js";
import type { NativeProcessRow } from "../../daemon/src/domain/native-process-lineage.js";

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

// Actual Commander -> Hono route -> attention service -> restore owner -> SQLite
// inventory. Only process/tmux observations and the CLI's transport are fake.
it.each(["valid", "unknown path", "wrong token", "no token", "PID reused", "login required"])("#273 full restore clear-attention composition: %s", async mode => {
  const db = createFullTestDb();
  try {
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db), checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("versioned"), name = "worker@versioned";
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "attention_required");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    if (mode !== "no token") sessionRegistry.updateResumeToken(session.id, "claude_id", "token", "scrape");
    const attempt = eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap" });
    eventBus.emit({ type: "restore.completed", rigId: rig.id, snapshotId: "snap", result: {
      snapshotId: "snap", preRestoreSnapshotId: null, rigResult: "failed", nodes: [{ nodeId: node.id, logicalId: "worker", status: "failed" }], warnings: [],
    } });
    const historical = db.prepare("SELECT * FROM events WHERE type LIKE 'restore.%'").all();
    const startedAt = "Sun Oct  4 15:21:03 2026";
    let calls = 0;
    const listProcesses = async (): Promise<NativeProcessRow[]> => {
      calls++;
      return [
        { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
        { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
        { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "2.1.289", command: `claude --session-id ${mode === "wrong token" ? "other" : "token"}`,
          startedAt: mode === "PID reused" && calls % 2 === 0 ? startedAt.replace("03", "04") : startedAt,
          executablePath: mode === "unknown path" ? undefined : "/fixture/.local/share/claude/versions/2.1.289" },
      ];
    };
    const sendText = vi.fn(), sendKeys = vi.fn();
    const tmux = {
      hasSession: async () => true, listSessions: async () => [{ name }], listPanes: async () => [{ id: "%1" }],
      getPanePid: async () => 10, getPaneCommand: async () => "zsh",
      readAllPaneProcesses: async () => new Map([["%1", { pid: 10, command: "zsh" }]]),
      capturePaneContent: async () => mode === "login required" ? "Not logged in · Run /login" : "Restored conversation\n❯\n⏵⏵ accept edits on",
      sendText, sendKeys,
    } as unknown as TmuxAdapter;
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      // These launch adapters must never be reached by read-only reconciliation.
      claudeResume: { resume: () => { throw new Error("no launch"); } } as never,
      codexResume: { resume: () => { throw new Error("no launch"); } } as never, listProcesses,
    });
    const clear = new SeatAttentionReconciler({ db, sessionRegistry, eventBus, agentActivityStore: new AgentActivityStore({ db, eventBus }), tmux, listProcesses,
      reconcileRestoreOutcome: (rigId, nodeId) => restore.reconcileNodeRuntimeTruth(rigId, nodeId),
    });
    await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode(node.id)?.verdict).toBe(["valid", "no token", "login required"].includes(mode) ? "verified" : "mismatch");
    expect(getNodeInventory(db, rig.id)[0]?.lifecycleState).toBe("attention_required");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("seatAttentionReconciler" as never, clear as never); c.set("terminalBearerToken" as never, "fixture" as never); await next(); });
    app.route("/api/sessions", sessionAdminRoutes);
    const lifecycleDeps: LifecycleDeps = {
      spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(),
      readFile: p => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 19731, db: "/fixture/test.sqlite", startedAt }) : null,
      writeFile: vi.fn(), removeFile: vi.fn(), exists: p => p === STATE_FILE, mkdirp: vi.fn(), openForAppend: () => 3, isProcessAlive: () => true,
    };
    const posted: string[] = [];
    const clientFactory: SeatDeps["clientFactory"] = () => ({ post: async (url: string, body: unknown) => {
      posted.push(url);
      const response = await app.request(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    } }) as never;
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = new Command().exitOverride().addCommand(seatCommand({ lifecycleDeps, clientFactory }));
    await cli.parseAsync(["node", "rig", "seat", "clear-attention", name, "--json"]);
    expect(posted).toEqual([`/api/sessions/${encodeURIComponent(name)}/clear-attention`]);
    const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(result.ok).toBe(mode === "valid");
    expect(getNodeInventory(db, rig.id)[0]?.lifecycleState).toBe(mode === "valid" ? "running" : "attention_required");
    const reconciled = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    expect(reconciled).toHaveLength(mode === "valid" ? 1 : 0);
    if (mode === "valid") {
      const event = JSON.parse(reconciled[0]!.payload);
      expect(event).toMatchObject({ attemptId: attempt.seq, to: "operator_recovered", evidence: { resumeTokenUsed: true, paneState: "usable" } });
      expect((await restore.reconcileNodeRuntimeTruth(rig.id, node.id)).ok).toBe(true);
      expect(db.prepare("SELECT * FROM events WHERE type = 'restore.outcome_reconciled'").all()).toHaveLength(1);
    }
    expect(db.prepare("SELECT * FROM events WHERE type IN ('restore.started', 'restore.completed')").all()).toEqual(historical);
    expect(sendText).not.toHaveBeenCalled(); expect(sendKeys).not.toHaveBeenCalled();
  } finally { db.close(); }
});
