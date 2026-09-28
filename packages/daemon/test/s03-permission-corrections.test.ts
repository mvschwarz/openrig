import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { Hono } from "hono";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { claudePostureFlag, codexPostureArg } from "../src/adapters/yolo-mode.js";
import { permissionBindingOverride, validateNativePermissionSelection } from "../src/domain/native-permission-selection.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { PermissionDriftObserver } from "../src/domain/permission-drift-observer.js";
import { diagnoseRuntimePosture, observeClaudePermission, observeCodexSandbox, renderPermissionDriftSummary } from "../src/domain/permission-drift.js";
import { whoamiRoutes } from "../src/routes/whoami.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// No provider process runs: the red control supplies the daemon's different vocabulary.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const fsOps = { readFile: () => { throw Error("forbidden read"); }, writeFile: () => { throw Error("forbidden write"); },
  exists: () => false, mkdirp: () => { throw Error("forbidden mkdir"); }, copyFile: () => { throw Error("forbidden copy"); } };
const binding: NodeBinding = { id: "binding", nodeId: "node", attachmentType: "tmux", tmuxSession: "seat", tmuxWindow: null,
  tmuxPane: "%1", cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/seat/older-cli", permissionMode: "auto" };
function transport() {
  const sendText = vi.fn(async (_target: string, _text: string) => ({ ok: false as const, message: "offline stop before submission" }));
  return { sendText, tmux: { sendText, sendKeys: () => { throw Error("forbidden input"); } } as unknown as TmuxAdapter };
}
function daemonHelp() {
  vi.stubEnv("PATH", "/daemon/new-cli/bin");
  vi.mocked(execFile).mockImplementation(((command: string, args: string[], options: any, done: any) => {
    // A target context would see different options, including with relative PATH entries.
    const seat = options.cwd === binding.cwd && options.env?.PATH === "./bin:/seat/bin";
    done(null, `--permission-mode <mode> (choices: "acceptEdits"${seat ? "" : ', "auto"'})`);
  }) as any);
}
describe("S03 F1 unresolved seat support refuses before effects", () => {
  it.each(["fresh", "resume", "fork", "legacy"])("does not use daemon cwd/PATH as seat support on %s", async path => {
    daemonHelp(); const t = transport();
    const result = path === "legacy"
      ? await new ClaudeResumeAdapter(t.tmux).resume("seat", "claude_id", "original", binding.cwd, "floor", null, "auto")
      : await new ClaudeCodeAdapter({ tmux: t.tmux, fsOps }).launchHarness(binding, { name: "seat",
        ...(path === "resume" ? { resumeToken: "original" } : {}),
        ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("launch context");
    expect(t.sendText).not.toHaveBeenCalled(); expect(execFile).not.toHaveBeenCalled();
  });
  it("refuses the production selection without writing desired state or audit", async () => {
    daemonHelp(); const prepare = vi.fn(() => { throw Error("unexpected DB access"); }); const db = { prepare };
    const service = new SeatLifecycleService({ db, rigRepo: { db }, sessionRegistry: { db }, eventBus: { db }, tmuxAdapter: {} } as any);
    vi.spyOn(service as any, "resolveSeat").mockReturnValue({ nodeId: "node", entry: { runtime: "claude-code" } });
    vi.spyOn(service as any, "describe").mockReturnValue({ nodeId: "node", rigId: "rig", logicalId: "owner", rigName: "rig" });
    expect(await service.setPermissions({ seatRef: "owner@rig", mode: "auto", actor: "operator", reason: "selected" }))
      .toMatchObject({ ok: false, code: "permission_selection_refused" });
    expect(prepare).not.toHaveBeenCalled(); expect(execFile).not.toHaveBeenCalled();
  });
  it.each([undefined, "floor", "full_bypass"] as const)("retains the ordinary/legacy launch path for %s", async launchPosture => {
    const t = transport();
    await new ClaudeCodeAdapter({ tmux: t.tmux, fsOps }).launchHarness({ ...binding, permissionMode: undefined, launchPosture }, { name: "seat" });
    expect(t.sendText).toHaveBeenCalledOnce();
    expect(t.sendText.mock.calls[0]?.[1]).toContain(claudePostureFlag({}, launchPosture));
    const legacy = transport();
    await new ClaudeResumeAdapter(legacy.tmux).resume("seat", "claude_id", "original", binding.cwd, launchPosture);
    expect(legacy.sendText).toHaveBeenCalledOnce(); expect(execFile).not.toHaveBeenCalled();
  });
});

const modes = ["acceptEdits", "auto", "bypassPermissions"];
const diagnosticFs = { readFile: () => JSON.stringify({ permissions: { defaultMode: "acceptEdits", deny: ["example"] } }),
  cwdReadable: () => true, commandAvailable: () => true, claudePermissionModes: () => modes };
describe("S03 F2 argument/config evidence is not native enforcement", () => {
  it.each(["codex", "claude-code"])("retains older unmarked %s observations without upgrading their evidence", runtime => {
    const applied = runtime === "codex" ? observeCodexSandbox("-s workspace-write") : observeClaudePermission("--dangerously-skip-permissions");
    delete applied.reason; const before = JSON.stringify(applied);
    const result = diagnoseRuntimePosture({ runtime, cwd: binding.cwd, applied, fs: diagnosticFs });
    expect(result.enforcement).toMatchObject({ state: "unknown", expected: applied.value, effective: null });
    expect(JSON.stringify(applied)).toBe(before);
  });
  it.each([["codex", "floor"], ["codex", "full_bypass"], ["claude-code", "floor"], ["claude-code", "full_bypass"],
    ["claude-code", "acceptEdits"], ["claude-code", "auto"], ["claude-code", "bypassPermissions"]])("keeps %s/%s unknown", (runtime, mode) => {
    const selected = permissionBindingOverride(validateNativePermissionSelection(runtime!, mode!, modes));
    const applied = runtime === "codex" ? observeCodexSandbox(codexPostureArg("", {}, selected.launchPosture))
      : observeClaudePermission(claudePostureFlag({}, selected.launchPosture, selected.permissionMode));
    const result = diagnoseRuntimePosture({ runtime: runtime!, cwd: binding.cwd, applied, fs: diagnosticFs });
    expect(applied.reason).toBe("emitted_launch_arguments");
    expect(result.enforcement).toMatchObject({ state: "unknown", expected: applied.value, effective: null, reason: "native_permission_effect_unverified" });
    expect(renderPermissionDriftSummary(result)).not.toContain("ALIGNED");
    if (runtime === "claude-code") expect(result).toMatchObject({ configuration: { observed: { defaultMode: "acceptEdits", deny: ["example"] } } });
  });
  it("whoami passes through current-generation argument and separate settings observations", async () => {
    const applied = observeClaudePermission("--permission-mode acceptEdits");
    const stored = { generation_uuid: "current", runtime: applied.runtime, axis: applied.axis, observation_state: applied.state,
      value: applied.value, reason: applied.reason, approval_policy: null, observed_at: "retained" };
    const db = { prepare: (sql: string) => ({ get: () => sql.includes("SELECT runtime, cwd") ? { runtime: "claude-code", cwd: binding.cwd } : stored }) };
    const observer = new PermissionDriftObserver({ db: db as any, fs: diagnosticFs });
    const app = new Hono(); app.use("*", async (c, next) => {
      c.set("whoamiService" as never, { resolve: () => ({ identity: { nodeId: "node" } }) } as never);
      c.set("permissionDriftObserver" as never, observer as never); await next();
    }); app.route("/whoami", whoamiRoutes());
    const response = await app.request("/whoami?nodeId=node&diagnostics=permission");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ permissionDrift: { enforcement: { state: "unknown", effective: null },
      configuration: { observed: { defaultMode: "acceptEdits" }, sourcePath: `${binding.cwd}/.claude/settings.local.json` } } });
    expect(stored.value).toBe("acceptEdits");
  });
});
