import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const token = "00000000-0000-4000-8000-000000000006";
const autoScreen = "Restored conversation\n─────────\n❯\u00a0\n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";
const payload = "RC6 harmless startup content";
const startedAt = "Thu Oct  1 05:53:16 2026";

describe("auto-mode startup content requires the launched Claude identity", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it.each(["exact", "exit-zsh", "exit-bash", "missing", "wrong-token", "ambiguous", "background", "replaced-pane", "replaced-process", "unavailable", "plain-shell", "resume-missing"])("startup: %s", async (mode) => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("auto-startup"), node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code" });
    const name = "test-c@auto-startup", session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const calls: { kind: string; text?: string; keys?: string[] }[] = [];
    let processReads = 0;
    const listProcesses = vi.fn(async () => {
      processReads++;
      if (mode === "unavailable") throw new Error("fixture observation unavailable");
      const native = { pid: 102, ppid: 101, pgid: mode === "background" ? 999 : 101, tpgid: 101,
        executableName: "claude", startedAt: mode === "replaced-process" && processReads > 1 ? "changed" : startedAt,
        command: `/opt/claude.exe --permission-mode auto --session-id ${mode === "wrong-token" ? "other-token" : token} --name ${name}` };
      return [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh fixture-launch.txt", startedAt },
        ...(["exit-zsh", "exit-bash", "missing", "plain-shell", "resume-missing"].includes(mode) ? [] : [native]),
        ...(mode === "ambiguous" ? [{ ...native, pid: 103 }] : []),
      ];
    });
    const tmux = {
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => mode === "exit-zsh" ? "zsh" : mode === "exit-bash" ? "bash" : "sh"),
      capturePaneContent: vi.fn(async () => mode === "plain-shell" ? "admin@host ~ % " : autoScreen + (mode.startsWith("exit-") ? "Resume this session with:\nclaude --resume old\nadmin@host ~ % " : "")),
      getPanePid: vi.fn(async () => 100),
      listPanes: vi.fn(async () => [{ id: mode === "replaced-pane" && processReads > 0 ? "%2" : "%1" }]),
      sendShellCommand: vi.fn(async (_target: string, text: string) => { calls.push({ kind: "launch", text }); return { ok: true as const }; }),
      sendText: vi.fn(async (_target: string, text: string) => { calls.push({ kind: "content", text }); return { ok: true as const }; }),
      sendKeys: vi.fn(async (_target: string, keys: string[]) => { calls.push({ kind: "submit", keys }); return { ok: true as const }; }),
    } as unknown as TmuxAdapter;
    const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {}, sessionIdFactory: () => token,
      claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`, assertCurrent: () => {}, configDir: "/fixture" }) } as unknown as ClaudeManagedLaunch,
      fsOps: { exists: () => false, readFile: () => payload, writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} },
    });
    const binding: NodeBinding = { id: "binding", nodeId: node.id, tmuxSession: name, tmuxPane: "%1", tmuxWindow: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture", permissionMode: "auto" };
    const result = await new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.id, binding, adapter,
      plan: { runtime: "claude-code", cwd: "/fixture", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [] } as never,
      resolvedStartupFiles: [{ path: "startup.txt", absolutePath: "/fixture/startup.txt", ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [], isRestore: false, sessionName: name, readinessTimeoutMs: 1,
      ...(mode === "resume-missing" ? { resumeToken: token, resumeType: "claude_id", allowFreshFallback: true } : {}),
    });
    // Launch authorization is distinct from permission to paste/submit startup content.
    expect(calls.filter(c => c.kind === "launch")).toEqual([{ kind: "launch", text: `claude --permission-mode auto ${mode === "resume-missing" ? "--resume" : "--session-id"} ${token} --name ${name}` }]);
    if (mode === "resume-missing") expect(result.startupStatus).toBe("attention_required");
    expect({ ok: result.ok, content: calls.filter(c => c.kind === "content"), submit: calls.filter(c => c.kind === "submit") }).toEqual({
      ok: mode === "exact", content: mode === "exact" ? [{ kind: "content", text: payload }] : [], submit: mode === "exact" ? [{ kind: "submit", keys: ["C-m"] }] : [],
    });
    // Orchestrator checks readiness before content and once more at completion.
    if (mode === "exact") expect(listProcesses).toHaveBeenCalledTimes(4);
    if (mode === "plain-shell") expect(listProcesses).not.toHaveBeenCalled();
  });
});
