// #86 — Claude's native installer names its process, and so tmux's pane label, after its versioned file (2.1.300).
// An unmanaged seat whose label is a version reads as `claude` only when the OS executable path witnesses native
// Claude. Every case runs through existing seams, so the same file runs unchanged on main: the witnessed cases fail
// there (timeout, no verified resume, reconcile drift) and the refusals already hold.
import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { NativeProcessLister, NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";

const VERSION = "2.1.300";
const NATIVE_PATH = `/fixture/.local/share/claude/versions/${VERSION}`;
const startedAt = "Fri Oct 16 01:00:00 2026";

// The staging subshell exec'd Claude, so Claude leads the pane's foreground group under the pane shell.
// Also used as a process lister, which may be handed list options: only a string names a command.
function rows(command?: unknown): NativeProcessRow[] {
  if (typeof command !== "string") command = "claude --permission-mode acceptEdits --resume tok --name seat";
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 12, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 12, ppid: 10, pgid: 12, tpgid: 12, executableName: VERSION, executablePath: NATIVE_PATH, command: command as string, startedAt },
  ];
}

function mockTmux(label: string, panePid: () => Promise<number | null> = async () => 10): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => label),
    // Claude hasn't drawn its prompt yet: no screen text can prove the resume.
    capturePaneContent: vi.fn(async () => ""),
    getPanePid: vi.fn(panePid),
    listPanes: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    startPipePane: vi.fn(async () => ({ ok: true as const })),
    stopPipePane: vi.fn(async () => ({ ok: true as const })),
    setSessionOption: vi.fn(async () => ({ ok: true as const })),
    getSessionOption: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
}

const fsOps = {
  exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
} as unknown as ClaudeAdapterFsOps;

function binding(extra: Partial<NodeBinding> = {}): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "dev-impl@rig", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...extra };
}

// The seat's persisted managed permission mode; by default the seat has no managed selection.
type PermissionModeReader = (nodeId: string) => string | undefined;
const adapter = (tmux: TmuxAdapter, listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>,
  resolvePermissionMode: PermissionModeReader | null = () => undefined) =>
  new ClaudeCodeAdapter({ tmux, fsOps, listProcesses, sleep: async () => {}, ...(resolvePermissionMode ? { resolvePermissionMode } : {}) });

describe("#86 unmanaged launch wait", () => {
  it.each([
    ["OpenRig's own resume command", rows()],
    ["a flag from the user's own claude, which exact proof can't parse", rows("claude --strict-mcp-config --permission-mode acceptEdits --resume tok --name seat")],
  ])("resumes a witnessed native version label: %s", async (_name, processRows) => {
    const result = await adapter(mockTmux(VERSION), async () => processRows)
      .launchHarness(binding(), { name: "seat", resumeToken: "tok" });
    expect(result).toMatchObject({ ok: true, resumeToken: "tok" });
  });

  it("checkReady reads a witnessed native version label as Claude", async () => {
    expect(await adapter(mockTmux(VERSION), rows).checkReady(binding())).toEqual({ ready: true });
  });
});

describe("#86 refusals that stay refused", () => {
  const awaiting = { ready: false, code: "awaiting_runtime" };
  const cases: [string, NativeProcessRow[] | (() => NativeProcessRow[]), string?, (() => Promise<number | null>)?][] = [
    ["a path outside the native layout", rows().map(r => r.pid === 12 ? { ...r, executablePath: `/opt/other/${VERSION}` } : r)],
    ["a basename that isn't the OS name", rows().map(r => r.pid === 12 ? { ...r, executablePath: NATIVE_PATH.replace("300", "299") } : r)],
    ["argv0 that isn't claude", rows("node /fixture/cli.js --resume tok")],
    ["a version-only argv0", rows(`${VERSION} --resume tok`)],
    ["two candidates", [...rows(), { ...rows()[1]!, pid: 13 }]],
    // listNativeProcesses leaves the path unset when the OS read fails or times out.
    ["a path read that failed or timed out", rows().map(r => ({ ...r, executablePath: undefined }))],
    ["argv0 naming the native path, with no OS path read", rows(`${NATIVE_PATH} --resume tok`).map(r => ({ ...r, executablePath: undefined }))],
    ["argv0 naming the native path, with an unrelated OS path", rows(`${NATIVE_PATH} --resume tok`).map(r => r.pid === 12 ? { ...r, executablePath: "/opt/other/claude" } : r)],
    ["a background process", rows().map(r => r.pid === 12 ? { ...r, pgid: 88 } : r)],
    ["a label naming a different version", rows(), "2.1.301"],
    ["a pane pid change after the samples", rows(), VERSION, vi.fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(10).mockResolvedValueOnce(10).mockResolvedValue(11)],
  ];
  it.each(cases)("%s", async (_name, processRows, label = VERSION, panePid) => {
    const list = typeof processRows === "function" ? processRows : () => processRows;
    expect(await adapter(mockTmux(label, panePid), list).checkReady(binding())).toMatchObject(awaiting);
  });

  it("a process that changes between the two samples", async () => {
    const list = vi.fn<() => NativeProcessRow[]>().mockReturnValueOnce(rows())
      .mockReturnValue(rows().map(r => r.pid === 12 ? { ...r, startedAt: startedAt.replace("01:00:00", "01:00:01") } : r));
    expect(await adapter(mockTmux(VERSION), list).checkReady(binding())).toMatchObject(awaiting);
  });
});

describe("#86 results that don't change", () => {
  it("a managed seat keeps its exact proof; the witness isn't consulted", async () => {
    const list = vi.fn(rows);
    expect(await adapter(mockTmux(VERSION), list).checkReady(binding({ permissionMode: "auto" })))
      .toMatchObject({ ready: false, code: "awaiting_runtime" });
    expect(list).not.toHaveBeenCalled();
  });

  it.each<[string, PermissionModeReader | null]>([
    ["a persisted managed selection, through a binding without permissionMode", () => "auto"],
    ["an unreadable selection", () => { throw new Error("Invalid persisted native permission selection; launch refused."); }],
    ["no selection reader", null],
  ])("the witness isn't consulted with %s", async (_name, resolvePermissionMode) => {
    const list = vi.fn(rows);
    expect(await adapter(mockTmux(VERSION), list, resolvePermissionMode).checkReady(binding()))
      .toMatchObject({ ready: false, code: "awaiting_runtime" });
    expect(list).not.toHaveBeenCalled();
  });

  it("a shell label over an idle shell stays a return to the shell", async () => {
    // Claude has exited: the pane's shell leads the foreground group again, with nothing else in it.
    const shellAlone = () => [{ ...rows()[0], tpgid: 10 }];
    expect(await adapter(mockTmux("zsh"), shellAlone).checkReady(binding())).toMatchObject({ ready: false, code: "returned_to_shell" });
  });

  it("a claude label stays ready by name, with no process read", async () => {
    const list = vi.fn(rows);
    expect(await adapter(mockTmux("claude"), list).checkReady(binding())).toEqual({ ready: true });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("#86 legacy restore resume", () => {
  const resumeAdapter = (tmux: TmuxAdapter, listProcesses: () => NativeProcessRow[], extra = {}) =>
    new ClaudeResumeAdapter(tmux, { listProcesses, pollMs: 1, maxWaitMs: 2, sleep: async () => {}, ...extra });

  it("an unmanaged resume with a witnessed native version label is verified", async () => {
    expect(await resumeAdapter(mockTmux(VERSION), rows).resume("dev-impl@rig", "claude_id", "tok", "/project"))
      .toMatchObject({ ok: true });
  });

  it("an unwitnessed version label stays unverified", async () => {
    const list = () => rows().map(r => ({ ...r, executablePath: undefined }));
    expect(await resumeAdapter(mockTmux(VERSION), list).resume("dev-impl@rig", "claude_id", "tok", "/project"))
      .toMatchObject({ ok: false, code: "attention_required" });
  });

  it("a managed resume keeps its exact proof; the witness isn't consulted", async () => {
    const list = vi.fn(rows);
    const claudeManagedLaunch = { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`,
      assertCurrent: () => {}, configDir: "/fixture", executable: NATIVE_PATH }) } as unknown as ClaudeManagedLaunch;
    const result = await resumeAdapter(mockTmux(VERSION), list, { claudeManagedLaunch })
      .resume("dev-impl@rig", "claude_id", "tok", "/project", undefined, undefined, "auto", "n1");
    expect(result).toMatchObject({ ok: false, code: "attention_required" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("#86 reconcile-session drift", () => {
  async function reconcile(listProcesses: () => NativeProcessRow[]) {
    const db = createFullTestDb();
    const tmux = mockTmux(VERSION);
    const setup = createTestApp(db, { tmux });
    const deps = { db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, discoveryRepo: setup.discoveryRepo,
      eventBus: setup.eventBus, tmuxAdapter: tmux, listProcesses };
    const claims = new ClaimService(deps as ConstructorParameters<typeof ClaimService>[0]);
    const rig = setup.rigRepo.createRig("drift-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo", podId: null });
    setup.sessionRegistry.markDetached(setup.sessionRegistry.registerSession(node.id, "dev-impl@drift-rig").id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@drift-rig" });
    const result = await claims.reconcileSession({ sessionName: "dev-impl@drift-rig" });
    db.close();
    if (!result.ok) throw new Error(result.message);
    return result.result;
  }

  it("a witnessed native version label confirms the runtime; continuity stays unverified", async () => {
    const result = await reconcile(rows);
    expect(result.projectionDrift.join(" ")).not.toContain("runtime unverified");
    expect(result.continuity).toBe("unverified");
  });

  it("an unwitnessed version label keeps the drift line", async () => {
    const result = await reconcile(() => rows().map(r => r.pid === 12 ? { ...r, executablePath: `/opt/other/${VERSION}` } : r));
    expect(result.projectionDrift.join(" ")).toContain(`runtime unverified: pane command "${VERSION}" does not confirm runtime "claude-code"`);
  });
});

describe("#86 recovery readiness (ContextMonitor.pollOnce) follows the seat's persisted selection", () => {
  async function poll(opts: { selection?: string; label?: string; rows: () => NativeProcessRow[] }): Promise<string> {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const node = rigRepo.addNode(rigRepo.createRig("recovery-rig").id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
    const session = sessions.registerSession(node.id, "dev-impl@recovery-rig");
    db.prepare("UPDATE sessions SET status = 'running', startup_status = 'attention_required' WHERE id = ?").run(session.id);
    const permissions = new NativePermissionStore(db);
    if (opts.selection) permissions.write(node.id, { runtime: "claude-code", mode: opts.selection }, "test", "managed seat");
    const stateDir = mkdtempSync(join(tmpdir(), "label-witness-"));
    const claude = new ClaudeCodeAdapter({ tmux: mockTmux(opts.label ?? VERSION), fsOps, listProcesses: opts.rows, sleep: async () => {},
      resolvePermissionMode: (nodeId) => permissions.resolve(nodeId, "claude-code").permissionMode });
    const monitor = new ContextMonitor(db, new ContextUsageStore(db, { stateDir, codexHomeDir: stateDir }),
      { ensureContextCollector: () => {}, checkReady: (b) => claude.checkReady(b) });
    try {
      await monitor.pollOnce();
      return (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string }).startup_status;
    } finally {
      monitor.stop();
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  it.each<[string, Parameters<typeof poll>[0], string]>([
    ["managed auto, a version label, the wrong conversation", { selection: "auto", rows: () => rows("claude --permission-mode auto --resume other --name seat") }, "attention_required"],
    ["managed auto, a version label, no OS path", { selection: "auto", rows: () => rows().map(r => ({ ...r, executablePath: undefined })) }, "attention_required"],
    ["managed auto, the ordinary claude label, as on main", { selection: "auto", label: "claude", rows }, "ready"],
    ["unmanaged, a witnessed version label", { rows }, "ready"],
  ])("%s", async (_name, opts, expected) => {
    expect(await poll(opts)).toBe(expected);
  });
});

describe("#86 an actual path-read timeout ends the witness for the rest of one wait", () => {
  const unwitnessed = () => rows().map(r => ({ ...r, executablePath: undefined }));
  // As listNativeProcesses does when the OS read times out: the path stays unset and the caller is told.
  const timedOut: NativeProcessLister = (opts) => { opts?.onPathReadTimeout?.(); return unwitnessed(); };
  const launch = (claude: ClaudeCodeAdapter) => claude.launchHarness(binding(), { name: "seat", resumeToken: "tok" });
  // The witness's own reads carry its timeout listener; main's process checks call the same lister without one.
  const witnessReads = (list: ReturnType<typeof vi.fn>) =>
    list.mock.calls.filter(([opts]) => typeof opts === "object" && opts !== null && "onPathReadTimeout" in opts).length;
  // Main's result for the same process evidence: a managed seat never consults the witness.
  const mainResult = () => launch(adapter(mockTmux(VERSION), vi.fn(unwitnessed), () => "auto"));

  it.each<[string, () => NativeProcessLister, number]>([
    ["a first-sample timeout", () => vi.fn(timedOut), 1],
    ["a second-sample timeout", () => vi.fn<NativeProcessLister>().mockImplementationOnce(() => rows()).mockImplementation(timedOut), 2],
  ])("the launch wait stops reading after %s and ends with main's result", async (_name, makeList, reads) => {
    const list = makeList();
    const result = await launch(adapter(mockTmux(VERSION), list));
    expect(result).toEqual(await mainResult());
    expect(result.ok).toBe(false);
    expect(witnessReads(list as ReturnType<typeof vi.fn>)).toBe(reads);
  });

  it("a missing path without a timeout isn't one: every observation still tries", async () => {
    const list = vi.fn(unwitnessed);
    const tmux = mockTmux(VERSION);
    expect(await launch(adapter(tmux, list))).toMatchObject({ ok: false });
    const observations = vi.mocked(tmux.capturePaneContent).mock.calls.length;
    expect(observations).toBeGreaterThan(16);
    expect(witnessReads(list)).toBe(observations);
  });

  it("a later, independent launch wait uses a healthy witness", async () => {
    let read: NativeProcessLister = timedOut;
    const claude = adapter(mockTmux(VERSION), (opts) => read(opts));
    expect(await launch(claude)).toMatchObject({ ok: false });
    read = () => rows();
    expect(await launch(claude)).toMatchObject({ ok: true, resumeToken: "tok" });
  });

  it("the legacy restore wait reads once after a timeout, and its next wait uses a healthy witness", async () => {
    let read: NativeProcessLister = timedOut;
    const list = vi.fn<NativeProcessLister>((opts) => read(opts));
    const resume = new ClaudeResumeAdapter(mockTmux(VERSION), { listProcesses: list, sleep: async () => {} });
    expect(await resume.resume("dev-impl@rig", "claude_id", "tok", "/project")).toMatchObject({ ok: false, code: "attention_required" });
    expect(list).toHaveBeenCalledTimes(1);
    read = () => rows();
    expect(await resume.resume("dev-impl@rig", "claude_id", "tok", "/project")).toMatchObject({ ok: true });
  });
});
