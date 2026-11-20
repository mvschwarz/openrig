import { memoryProjectionFiles } from "./helpers/omp-files.js";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as realFs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";
import { OmpTuiResumeAdapter } from "../src/adapters/omp-tui-resume.js";
import { OmpSeatLauncher } from "../src/adapters/omp-seat-launch.js";
import { ompSeatPaths } from "../src/adapters/omp-seat-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionEntry, ProjectionPlan } from "../src/domain/projection-planner.js";

// OMP runs natively in the pane. These tests model the pane and the seat extension: a sent launch command stands
// for OMP starting, and `omp` (below) decides what its extension then writes to the seat sidecar.

const stateRoot = "/openrig/state/omp";
const seat = "omp-worker@rig";
const paths = ompSeatPaths(stateRoot, seat);
const parentFile = "/openrig/state/omp/parent/sessions/parent.jsonl";
const currentFile = `${paths.sessionsDir}/current.jsonl`;
const extension = "/daemon/assets/omp/openrig-seat.js";

type Omp = (launchId: string, command: string) => Record<string, unknown> | null;

function fakeSeat(files: Record<string, string>, omp: Omp = (launchId) => ({ ready: true, launchId, sessionFile: currentFile, auth: "ok", updatedAt: "t" })) {
  const fs = {
    ...memoryProjectionFiles(files),
    copyFile: (source: string, dest: string) => { files[dest] = files[source]!; },
    readFile: (path: string) => files[path]!,
    writeFile: (path: string, content: string) => { files[path] = content; },
    exists: (path: string) => path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
    mkdirp: () => {},
    listFiles: (dir: string) => {
      const found = Object.keys(files).filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1));
      if (found.length === 0 && dir in files) throw new Error("ENOTDIR");
      return found;
    },
  };
  let paneCommand = "zsh";
  const tmux = {
    sendShellCommand: vi.fn(async (_session: string, command: string) => {
      const launchId = /OPENRIG_OMP_LAUNCH_ID=([^' ]+)/.exec(command)?.[1] ?? "";
      const written = omp(launchId, command);
      if (written) { files[paths.statePath] = JSON.stringify({ ...written, pid: 102, updatedAt: "2026-11-11T00:00:00Z" }); paneCommand = "omp"; }
      return { ok: true };
    }),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    getPanePid: vi.fn(async () => 101),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async (_target?: string) => paneCommand),
    capturePaneContent: vi.fn(async () => ""),
  };
  const launcher = new OmpSeatLauncher({
    tmux: tmux as unknown as TmuxAdapter, fsOps: fs, stateRoot, seatExtensionPath: extension, sleep: async () => {},
    newLaunchId: () => "attempt-1", now: () => "2026-11-11T00:00:00.000Z",
  });
  const listProcesses = vi.fn(async () => [{ pid: 102, ppid: 101, command: "omp", startedAt: "2026-11-10T00:00:00Z" }]);
  const boundPaneForSession = vi.fn((_session: string): string | null => null);
  const adapter = new OmpTuiRuntimeAdapter({ tmux: tmux as unknown as TmuxAdapter, fsOps: fs, launcher, sleep: async () => {},
    listProcesses, boundPaneForSession });
  const sent = () => vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[1] ?? "";
  return { fs, tmux, launcher, adapter, sent, listProcesses, boundPaneForSession, setPaneCommand: (command: string) => { paneCommand = command; } };
}

const binding = (extra: Record<string, unknown> = {}) => ({ tmuxSession: seat, cwd: "/work", model: "openrouter/example", launchPosture: "floor", ...extra }) as never;

describe("OMP launches natively", () => {
  it("leaves the existing launch state intact when dispatch loses the seat", async () => {
    const files = { [paths.statePath]: "previous launch" };
    const { adapter, tmux } = fakeSeat(files);
    const result = await adapter.launchHarness(binding(), { name: seat, beforeNativeDispatch: () => false });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("changed before dispatch") });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(files[paths.statePath]).toBe("previous launch");
  });

  it("types omp itself, with the seat's own home and the seat extension, and never a runner", async () => {
    const { adapter, sent, tmux } = fakeSeat({});
    await adapter.launchHarness(binding({ effort: "high" }), { name: seat });
    const command = sent();
    expect(command).not.toContain("pi-runner");
    expect(command).not.toContain("'--mode'");
    expect(command).toContain(`'HOME=${paths.seatRoot}'`);
    expect(command).toContain(`'PI_CODING_AGENT_DIR=${paths.agentDir}'`);
    expect(command).toContain("'OMP_SKIP_SETUP=1'");
    expect(command).toContain(`'omp' '--cwd' '/work' '--session-dir' '${paths.sessionsDir}' '--approval-mode' 'always-ask' '--config' '${paths.launchConfigPath}' '-e' '${extension}' '--model' 'openrouter/example' '--thinking' 'high'`);
    // Staged and exec'd by /bin/sh whatever the pane's shell is, so the forwarded-name expansions are always POSIX.
    expect(vi.mocked(tmux.sendShellCommand).mock.calls[0]?.[3]).toEqual({ execInScript: true });
  });

  it.each(["constructor", "__proto__", "toString"])("launches a provider named %s without forwarding another provider's environment", async provider => {
    const { adapter, sent } = fakeSeat({});
    await adapter.launchHarness(binding({ model: provider + "/model" }), { name: seat });
    expect(sent()).toContain(provider + "/model");
    expect(sent()).not.toContain("ANTHROPIC_API_KEY");
  });

  it("forwards only named variables, by reference: the declared provider's key crosses, another provider's doesn't", async () => {
    const { adapter, sent } = fakeSeat({});
    await adapter.launchHarness(binding({ model: "anthropic/claude-example" }), { name: seat });
    const command = sent();
    expect(command).toContain('${ANTHROPIC_API_KEY+"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"}');
    expect(command).toContain('${ANTHROPIC_BASE_URL+"ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"}');
    expect(command).toContain('${OPENRIG_SESSION_NAME+"OPENRIG_SESSION_NAME=$OPENRIG_SESSION_NAME"}');
    expect(command).not.toContain("OPENROUTER_API_KEY");
    // The install-wide hook token never enters OMP's environment: OMP hands that environment to its shell tools.
    expect(command).not.toContain("OPENRIG_ACTIVITY_HOOK_TOKEN");
    expect(command).toContain("exec /usr/bin/env -i ");
  });

  it("writes this launch's settings overlay and scopes the sidecar to the attempt before typing", async () => {
    const order: string[] = [];
    const { adapter, fs, tmux } = fakeSeat({});
    const write = fs.writeFile;
    fs.writeFile = (path, content) => { order.push(path); write(path, content); };
    vi.mocked(tmux.sendShellCommand).mockImplementationOnce(async () => { order.push("typed"); return { ok: false, message: "pane busy" } as never; });
    const result = await adapter.launchHarness(binding(), { name: seat });
    expect(result).toMatchObject({ ok: false, error: "Failed to send launch command: pane busy" });
    expect(order).toEqual([paths.launchConfigPath, paths.statePath, "typed"]);
    expect(fs.readFile(paths.launchConfigPath)).toContain("setupWizard: false");
    expect(JSON.parse(fs.readFile(paths.statePath))).toEqual({ ready: false, launchId: "attempt-1", updatedAt: "2026-11-11T00:00:00.000Z" });
  });

  it("ignores a ready sidecar left by an earlier OMP process", async () => {
    const stale = JSON.stringify({ ready: true, launchId: "older-attempt", sessionFile: currentFile, updatedAt: "t" });
    // This launch's OMP never reports: only the stale record's id would say ready.
    const { adapter, tmux, fs } = fakeSeat({ [paths.statePath]: stale, [currentFile]: "history" }, () => null);
    vi.mocked(tmux.sendShellCommand).mockImplementationOnce(async () => { fs.writeFile(paths.statePath, stale); return { ok: true }; });
    const result = await adapter.launchHarness(binding(), { name: seat });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it.each([["full_bypass", "yolo"], [undefined, "always-ask"]])("maps posture %s to %s and reports what it applied", async (launchPosture, approvalMode) => {
    const { adapter, sent } = fakeSeat({ [currentFile]: "session" });
    const result = await adapter.launchHarness(binding({ launchPosture }), { name: seat });
    expect(result).toMatchObject({ ok: true, appliedLaunch: { runtime: "omp-tui", axis: "permission", state: "observed", value: approvalMode } });
    expect(sent()).toContain(`'--approval-mode' '${approvalMode}'`);
  });

  it("loads managed skill storage on launch", async () => {
    const { adapter, fs, sent } = fakeSeat({ [currentFile]: "session" });
    await adapter.launchHarness(binding({ seatSkillsRoot: "/state/seats/rig/seat/omp/skills" }), { name: seat });
    expect(sent()).toContain("'-e' '/state/seats/rig/seat/omp'");
    expect(fs.readFile(paths.launchConfigPath)).not.toContain("skills:");
  });

  it("refuses a launch_wrapper without environment support and a resume combined with a fork, typing nothing", async () => {
    const { adapter, tmux } = fakeSeat({ [currentFile]: "session" });
    expect(await adapter.launchHarness(binding({ launchWrapper: ["sandbox"] }), { name: seat })).toMatchObject({ ok: false, error: expect.stringMatching(/launch_wrapper/) });
    expect(await adapter.launchHarness(binding(), { name: seat, resumeToken: currentFile, forkSource: { kind: "native_id", value: parentFile } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/mutually exclusive/) });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });
});

describe("OMP exact session tokens", () => {
  it("resumes only the OMP token, and returns the same validated session file", async () => {
    const { adapter, sent } = fakeSeat({ [currentFile]: "session" });
    const result = await adapter.launchHarness(binding(), { name: seat, resumeToken: currentFile });
    expect(result).toEqual({ ok: true, resumeToken: currentFile, resumeType: "omp_tui_session_file", appliedLaunch: { runtime: "omp-tui", axis: "permission", state: "observed", value: "always-ask" } });
    expect(sent()).toContain(`'--session' '${currentFile}'`);
  });

  it("fails an exact resume when OMP comes up on a different session file", async () => {
    const requested = `${paths.sessionsDir}/requested.jsonl`;
    const { adapter } = fakeSeat({ [requested]: "history", [currentFile]: "other session" });
    const result = await adapter.launchHarness(binding(), { name: seat, resumeToken: requested });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringMatching(/does not report the requested session file/) });
  });

  it("refuses to resume a session file that is gone, without typing, as a missing conversation", async () => {
    const { adapter, tmux } = fakeSeat({});
    const result = await adapter.launchHarness(binding(), { name: seat, resumeToken: currentFile });
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh", missingConversation: true });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("reads OMP's own not-found line when it exits before loading the extension", async () => {
    const { adapter, tmux } = fakeSeat({ [currentFile]: "session" }, () => null);
    vi.mocked(tmux.capturePaneContent).mockResolvedValueOnce("").mockResolvedValue(`Error: Session "${currentFile}" not found.\nRun \`omp --resume\` without an argument to pick from recent sessions.\n$ `);
    const result = await adapter.launchHarness(binding(), { name: seat, resumeToken: currentFile });
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh", missingConversation: true });
  });

  it.each(["historical", "wrong-file"])("keeps a %s not-found message from authorizing a fresh conversation", async kind => {
    const { adapter, tmux } = fakeSeat({ [currentFile]: "session" }, () => null);
    const line = 'Error: Session "' + (kind === "historical" ? currentFile : parentFile) + '" not found.';
    tmux.capturePaneContent.mockResolvedValueOnce(kind === "historical" ? line : "").mockResolvedValue(line);
    expect(await adapter.launchHarness(binding(), { name: seat, resumeToken: currentFile })).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("rejects an ID-form fork that still reports the parent conversation", async () => {
    const { adapter } = fakeSeat({}, launchId => ({ ready: true, launchId, sessionId: "parent-id", sessionFile: currentFile, updatedAt: "t" }));
    expect(await adapter.launchHarness(binding(), { name: seat, forkSource: { kind: "native_id", value: "parent-id" } }))
      .toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("reports an OMP that exits during startup as needing attention, with the pane's last lines", async () => {
    const { adapter, tmux } = fakeSeat({}, () => null);
    vi.mocked(tmux.capturePaneContent).mockResolvedValue("env: 'omp': No such file or directory\n$ ");
    const result = await adapter.launchHarness(binding(), { name: seat });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", evidence: expect.stringContaining("No such file or directory") });
  });

  it("forks a parent exact file and captures a distinct child token", async () => {
    const { adapter, sent } = fakeSeat({ [parentFile]: "session", [currentFile]: "forked session" });
    const result = await adapter.launchHarness(binding({ launchPosture: "full_bypass" }), { name: seat, forkSource: { kind: "native_id", value: parentFile } });
    expect(result).toMatchObject({ ok: true, resumeToken: currentFile, resumeType: "omp_tui_session_file", appliedLaunch: { runtime: "omp-tui", axis: "permission", value: "yolo" } });
    expect(sent()).toContain(`'--fork' '${parentFile}'`);
  });

  it("refuses a fork that reports the parent's own file", async () => {
    const { adapter } = fakeSeat({ [parentFile]: "session" }, (launchId) => ({ ready: true, launchId, sessionFile: parentFile, updatedAt: "t" }));
    const result = await adapter.launchHarness(binding(), { name: seat, forkSource: { kind: "native_id", value: parentFile } });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/parent session file or ID instead of the post-fork child/) });
  });

  it("reports a ready fresh seat without claiming an unwritten resume token", async () => {
    const { adapter, fs } = fakeSeat({});
    const result = await adapter.launchHarness(binding(), { name: seat });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("launch failed");
    expect(result.resumeToken).toBeUndefined();
    expect(adapter.readSessionFile(seat)).toEqual({ ok: false, reason: "missing_sidecar" });
    fs.writeFile(currentFile, "persisted first turn");
    expect(adapter.readSessionFile(seat)).toEqual({ ok: true, sessionFile: currentFile });
  });

  it("resume adapter refuses Pi tokens and proves the requested file via the sidecar", async () => {
    const { launcher, sent, fs } = fakeSeat({ [currentFile]: "session" });
    const adapter = new OmpTuiResumeAdapter(launcher, (path) => fs.exists(path));
    expect(adapter.canResume("pi_session_file", currentFile)).toBe(false);
    const result = await adapter.resume(seat, "omp_tui_session_file", currentFile, "/work", "openrouter/example", "floor", "high");
    expect(result).toMatchObject({ ok: true, appliedLaunch: { runtime: "omp-tui", axis: "permission", value: "always-ask" } });
    expect(sent()).toContain("'--thinking' 'high'");
    expect(sent()).toContain(`'--session' '${currentFile}'`);
    expect(await adapter.resume(seat, "omp_tui_session_file", `${paths.sessionsDir}/gone.jsonl`, "/work")).toMatchObject({ ok: false, code: "retry_fresh" });
  });
});

describe("OMP readiness", () => {
  it("is ready only while OMP holds the pane", async () => {
    const { adapter, setPaneCommand } = fakeSeat({});
    expect(await adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
    await adapter.launchHarness(binding(), { name: seat });
    expect(await adapter.checkReady(binding())).toEqual({ ready: true });
    // OMP was killed: its last sidecar still says ready, but the pane is back at the shell.
    setPaneCommand("-zsh");
    expect(await adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
  });

  it.each(["exited", "replaced"])("refuses the stale identity file after the bound pane's writer is %s", async change => {
    const files = { [currentFile]: "history", [paths.statePath]: JSON.stringify({ ready: true, launchId: "launch",
      generation: "original", pid: 102, sessionFile: currentFile, updatedAt: "2026-11-11T00:00:00Z" }) };
    const { adapter, listProcesses, tmux } = fakeSeat(files);
    const original = { pid: 102, ppid: 101, command: "omp", startedAt: "2026-11-10T00:00:00Z" };
    listProcesses.mockResolvedValueOnce([original]).mockResolvedValueOnce(change === "exited" ? []
      : [{ ...original, startedAt: "2026-11-11T00:00:01Z" }]);
    expect(await adapter.readLiveSessionFile(seat, "original", "%4")).toEqual({ ok: false, reason: "process_unreadable" });
    expect(tmux.getPanePid.mock.calls).toEqual([["%4"], ["%4"]]);
  });

  it.each(["provided", "lookup"])("checks readiness in the bound pane (%s) while a different pane in its session is active", async source => {
    const { adapter, tmux, boundPaneForSession } = fakeSeat({ [paths.statePath]: JSON.stringify({ ready: true, launchId: "launch",
      auth: "ok", pid: 102, sessionFile: currentFile, updatedAt: "2026-11-11T00:00:00Z" }) });
    tmux.getPaneCommand.mockImplementation(async target => target === "%4" ? "omp" : "zsh");
    if (source === "lookup") boundPaneForSession.mockReturnValue("%4");
    expect(await adapter.checkReady(binding({ tmuxPane: source === "provided" ? "%4" : null }))).toEqual({ ready: true });
    expect(tmux.getPaneCommand).toHaveBeenCalledWith("%4");
  });

  it("reads OMP's own exit record, and a seat that hasn't reported yet as still starting", async () => {
    const exited = fakeSeat({}, (launchId) => ({ ready: false, launchId, exited: { code: 0, at: "t" }, updatedAt: "t" }));
    await exited.adapter.launchHarness(binding(), { name: seat });
    expect(await exited.adapter.checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });

    const starting = fakeSeat({ [paths.statePath]: JSON.stringify({ ready: false, launchId: "attempt-1", updatedAt: "t" }) });
    starting.setPaneCommand("omp");
    expect(await starting.adapter.checkReady(binding())).toMatchObject({ ready: false, code: "awaiting_runtime" });
  });

  it("an OMP at its prompt without credentials for its model needs a login, not a message", async () => {
    const { adapter } = fakeSeat({}, (launchId) => ({ ready: true, launchId, sessionFile: currentFile, auth: "missing", model: "anthropic/claude-example", updatedAt: "t" }));
    expect(await adapter.launchHarness(binding(), { name: seat })).toMatchObject({ ok: true });
    expect(await adapter.checkReady(binding())).toMatchObject({ ready: false, code: "login_required", reason: expect.stringContaining("anthropic/claude-example") });
  });
});

describe("OMP projection into the seat's own home", () => {
  const entry = (extra: Partial<ProjectionEntry>): ProjectionEntry =>
    ({ sourceSpec: "", sourcePath: "", resourcePath: "", classification: "safe_projection", ...extra }) as ProjectionEntry;
  const plan = (entries: ProjectionEntry[]): ProjectionPlan =>
    ({ runtime: "omp-tui", cwd: "/work", entries, startup: {}, conflicts: [], noOps: [], diagnostics: [] }) as unknown as ProjectionPlan;

  it("puts a skill and its helpers in the seat's skills folder", async () => {
    const { adapter, fs } = fakeSeat({ "/src/review/SKILL.md": "# skill", "/src/review/scripts/run.sh": "#!/bin/sh" });
    const result = await adapter.project(plan([entry({ category: "skill", effectiveId: "review", absolutePath: "/src/review" })]), binding());
    expect(result.projected).toEqual(["review"]);
    expect(fs.readFile(`${paths.agentDir}/skills/review/scripts/run.sh`)).toBe("#!/bin/sh");
    expect(adapter.skillTargetPath(seat, "review")).toBe(`${paths.agentDir}/skills/review/SKILL.md`);
  });

  it("protects edited managed skills during projection", async () => {
    const storage = "/tmp/omp-stock-test/state/seats/rig/seat/omp/skills";
    const { adapter, fs } = fakeSeat({ "/src/review/SKILL.md": "new source", [`${storage}/review/SKILL.md`]: "operator edit" });
    const result = await adapter.project(plan([entry({ category: "skill", effectiveId: "review", absolutePath: "/src/review", classification: "operator_conflict" })]), binding({ seatSkillsRoot: storage }));
    expect(result.skipped).toEqual(["review"]);
    expect(fs.readFile(`${storage}/review/SKILL.md`)).toBe("operator edit");
  });

  it("keeps managed guidance in the seat's agent folder, never the repository's AGENTS.md", async () => {
    const { adapter, fs } = fakeSeat({ "/src/guide.md": "Team guidance" });
    const choice = adapter.guidanceFileFor(binding());
    expect(choice).toEqual({ file: `${paths.agentDir}/AGENTS.md` });
    await adapter.project(plan([entry({ category: "guidance", effectiveId: "guide.md", mergeStrategy: "managed_block", absolutePath: "/src/guide.md" })]),
      binding({ guidanceFile: choice.file }));
    expect(fs.readFile(`${paths.agentDir}/AGENTS.md`)).toContain("Team guidance");
    expect(fs.exists("/work/AGENTS.md")).toBe(false);
  });

  it("loads a selected plugin that declares OMP extensions, and skips one written for another runtime", async () => {
    const { adapter, fs, sent } = fakeSeat({
      "/plugins/core/package.json": JSON.stringify({ name: "core", omp: { extensions: ["./omp/index.js"] } }),
      "/plugins/core/omp/index.js": "export default function () {}",
      "/plugins/core/skills/refocusing/SKILL.md": "# refocusing",
      "/plugins/claude-only/.claude-plugin/plugin.json": "{}",
      "/plugins/pinned/package.json": JSON.stringify({ omp: { extensions: ["./index.js"] } }),
    });
    const result = await adapter.project(plan([
      entry({ category: "plugin", effectiveId: "core", absolutePath: "/plugins/core" }),
      entry({ category: "plugin", effectiveId: "claude-only", absolutePath: "/plugins/claude-only" }),
      entry({ category: "plugin", effectiveId: "pinned", absolutePath: "/plugins/pinned", pluginType: "codex" }),
      entry({ category: "subagent", effectiveId: "helper", absolutePath: "/src/helper.md" }),
    ]), binding());
    expect(result).toMatchObject({ projected: ["core"], skipped: ["claude-only", "pinned", "helper"], failed: [] });
    expect(fs.exists(`${paths.pluginsDir}/core/skills/refocusing/SKILL.md`)).toBe(true);
    await adapter.launchHarness(binding(), { name: seat });
    // The plugin is loaded as an extension package after the seat extension, so its skills come with it.
    expect(sent()).toContain(`'-e' '${extension}' '-e' '${paths.pluginsDir}/core'`);
    expect(await adapter.listInstalled(binding())).toEqual(expect.arrayContaining([
      { effectiveId: "core", category: "plugin", installedPath: `${paths.pluginsDir}/core` },
    ]));
  });

  it.each(["removed", "foreign", "failed"])("keeps the last working copy only for a still-selected plugin when projection is %s", async change => {
    const { adapter, fs, launcher } = fakeSeat({
      "/plugins/core/package.json": JSON.stringify({ omp: { extensions: ["./index.js"] } }),
      "/plugins/core/index.js": "export default function () {}",
    });
    const selected = entry({ category: "plugin", effectiveId: "core", absolutePath: "/plugins/core" });
    await adapter.project(plan([selected]), binding());
    expect(launcher.pluginRoots(seat)).toEqual([`${paths.pluginsDir}/core`]);
    if (change === "failed") fs.copyFile = () => { throw new Error("copy failed"); };
    const result = await adapter.project(plan(change === "removed" ? [] : [
      { ...selected, ...(change === "foreign" ? { pluginType: "claude" as const } : {}) },
    ]), binding());
    expect(result.failed).toHaveLength(change === "failed" ? 1 : 0);
    expect(fs.exists(`${paths.pluginsDir}/core/index.js`)).toBe(true);
    expect(launcher.pluginRoots(seat)).toEqual(change === "failed" ? [paths.pluginsDir + "/core"] : []);
    expect((await adapter.listInstalled(binding())).filter(item => item.category === "plugin")).toHaveLength(change === "failed" ? 1 : 0);
  });

  it("uses OMP's whole-manifest precedence instead of borrowing Pi extensions", async () => {
    const { adapter, launcher } = fakeSeat({
      "/plugins/dual/package.json": JSON.stringify({ omp: { skills: ["./skills"] }, pi: { extensions: ["./pi-only.js"] } }),
      "/plugins/dual/pi-only.js": "export default function () {}",
    });
    const result = await adapter.project(plan([entry({ category: "plugin", effectiveId: "dual", absolutePath: "/plugins/dual" })]), binding());
    expect(result.projected).toEqual([]);
    expect(result.skipped).toEqual(["dual"]);
    expect(launcher.pluginRoots(seat)).toEqual([]);
  });

  it("does not discover plugin roots from unselected files or malformed selection metadata", () => {
    const { launcher, fs } = fakeSeat({ [`${paths.pluginsDir}/old/package.json`]: "{}" });
    expect(launcher.pluginRoots(seat)).toEqual([]);
    fs.writeFile(paths.selectedPluginsPath, JSON.stringify(["../old", ".", null]));
    expect(launcher.pluginRoots(seat)).toEqual([]);
    fs.writeFile(paths.selectedPluginsPath, "broken json");
    expect(launcher.pluginRoots(seat)).toEqual([]);
  });

  it("projects a portable skills-only plugin without an extension warning", async () => {
    const { adapter, fs, launcher } = fakeSeat({
      "/src/plugin/.claude-plugin/plugin.json": JSON.stringify({ name: "portable-acceptance", version: "1.0.0" }),
      "/src/plugin/.codex-plugin/plugin.json": JSON.stringify({ name: "portable-acceptance", version: "1.0.0" }),
      "/src/plugin/skills/portable/SKILL.md": "portable instructions",
    });
    const result = await adapter.project(plan([entry({ category: "plugin", effectiveId: "portable", absolutePath: "/src/plugin" })]), binding());
    expect(result).toEqual({ projected: ["portable"], skipped: [], failed: [] });
    expect(fs.readFile(`${paths.agentDir}/skills/portable/SKILL.md`)).toBe("portable instructions");
    expect(launcher.pluginRoots(seat)).toEqual([]);
  });

  it("projects portable skills from a Claude-only plugin without loading its hooks", async () => {
    const { adapter, fs, sent } = fakeSeat({
      "/src/plugin/.claude-plugin/plugin.json": "{}",
      "/src/plugin/skills/portable/SKILL.md": "portable instructions",
      "/src/plugin/hooks/unsafe.js": "must not execute",
    });
    const result = await adapter.project(plan([entry({ category: "plugin", effectiveId: "portable-plugin", absolutePath: "/src/plugin", pluginType: "claude" })]), binding());
    expect(result.projected).toEqual(["portable-plugin"]);
    expect(result.warnings).toBeUndefined();
    expect(fs.readFile(`${paths.agentDir}/skills/portable/SKILL.md`)).toBe("portable instructions");
    expect(fs.exists(`${paths.pluginsDir}/portable-plugin/hooks/unsafe.js`)).toBe(false);
    fs.writeFile("/src/plugin/skills/portable/SKILL.md", "updated instructions");
    await adapter.project(plan([entry({ category: "plugin", effectiveId: "portable-plugin", absolutePath: "/src/plugin", pluginType: "claude" })]), binding());
    expect(fs.readFile(`${paths.agentDir}/skills/portable/SKILL.md`)).toBe("updated instructions");
    await adapter.project(plan([entry({ category: "plugin", effectiveId: "competing-plugin", absolutePath: "/src/plugin", pluginType: "claude" })]), binding());
    expect(JSON.parse(fs.readFile(paths.agentDir + "/skills/portable/.openrig-plugin")).id).toBe("competing-plugin");
    await adapter.launchHarness(binding(), { name: seat });
    expect(sent()).not.toContain("portable-plugin");
  });

  it("delivers startup text as one pasted block followed by a single submit", async () => {
    const { adapter, tmux, fs } = fakeSeat({ "/src/first-turn.txt": "line one\nline two" });
    fs.writeFile(paths.statePath, JSON.stringify({ ready: true, launchId: "attempt-1", updatedAt: "t", inputProtocol: 1 }));
    tmux.sendText.mockImplementationOnce(async () => {
      fs.writeFile(paths.statePath, JSON.stringify({ ready: true, launchId: "attempt-1", updatedAt: "t", inputProtocol: 1,
        inputReceipt: { requestId: JSON.parse(fs.readFile(`${paths.statePath}.input.json`)).id, sequence: 1, sha256: createHash("sha256").update("line one\nline two").digest("hex") } }));
      return { ok: true };
    });
    const result = await adapter.deliverStartup([{ path: "first-turn.txt", absolutePath: "/src/first-turn.txt", ownerRoot: "/src",
      deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], binding());
    expect(result).toMatchObject({ delivered: 1, failed: [] });
    expect(tmux.sendText).toHaveBeenCalledWith(seat, "line one\nline two");
    expect(vi.mocked(tmux.sendKeys).mock.calls).toEqual([[seat, ["Enter"]]]);
  });
});

describe("OMP paste completion", () => {
  it("waits for the matching composer acknowledgement before submitting", async () => {
    const text = "small input";
    const digest = createHash("sha256").update(text).digest("hex");
    const state = { ready: true, launchId: "attempt-1", updatedAt: "t", inputProtocol: 1,
      inputReceipt: { sequence: 4, sha256: digest } };
    const { fs, launcher, tmux } = fakeSeat({ [paths.statePath]: JSON.stringify(state), "/src/input": text });
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let polls = 0;
    const adapter = new OmpTuiRuntimeAdapter({ fsOps: fs, launcher, tmux: tmux as never, sleep: async () => {
      if (++polls === 1) {
        fs.writeFile(paths.statePath, JSON.stringify({ ...state, inputReceipt: { sequence: 5, sha256: "partial" } }));
        return;
      }
      observed.resolve();
      await release.promise;
      const { id } = JSON.parse(fs.readFile(paths.statePath + ".input.json"));
      fs.writeFile(paths.statePath, JSON.stringify({ ...state, inputReceipt: { sequence: 6, requestId: id, sha256: digest } }));
    } });
    const sending = adapter.deliverStartup([{ path: "input", absolutePath: "/src/input", ownerRoot: "/src",
      deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], binding());
    await observed.promise;
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    release.resolve();
    expect(await sending).toMatchObject({ delivered: 1, failed: [] });
    expect(tmux.sendKeys.mock.calls).toEqual([[seat, ["Enter"]]]);
  });

  it("does not submit incomplete startup input on timeout", async () => {
    const { adapter, tmux, fs } = fakeSeat({ "/src/input": "payload", "/src/next": "later payload" });
    fs.writeFile(paths.statePath, JSON.stringify({ ready: true, launchId: "attempt-1", updatedAt: "t", inputProtocol: 1 }));
    const result = await adapter.deliverStartup([{ path: "input", absolutePath: "/src/input", ownerRoot: "/src",
      deliveryHint: "send_text", required: false, appliesOn: ["fresh_start"] },
      { path: "next", absolutePath: "/src/next", ownerRoot: "/src", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], binding());
    expect(result.delivered).toBe(0);
    expect(result.failed[0]?.error).toContain("Enter was not sent");
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("does not overwrite another pending input and disarms a cancelled request", () => {
    const { adapter, fs } = fakeSeat({ [paths.statePath]: JSON.stringify({ ready: true, launchId: "one", updatedAt: "t", inputProtocol: 1 }) });
    const first = adapter.prepareInput(seat, "first");
    const request = fs.readFile(`${paths.statePath}.input.json`);
    expect(() => adapter.prepareInput(seat, "second")).toThrow("still pending");
    expect(fs.readFile(`${paths.statePath}.input.json`)).toBe(request);
    first.cancel?.();
    const next = adapter.prepareInput(seat, "second");
    expect(fs.readFile(`${paths.statePath}.input.json`)).not.toBe(request);
    next.cancel?.();
  });

  it("refuses a replaced OMP process even if its receipt matches", async () => {
    const { adapter, fs } = fakeSeat({ [paths.statePath]: JSON.stringify({ ready: true, launchId: "first", updatedAt: "t", inputProtocol: 1 }) });
    const wait = adapter.prepareInput(seat, "x");
    fs.writeFile(paths.statePath, JSON.stringify({ ready: true, launchId: "second", updatedAt: "t", inputProtocol: 1,
      inputReceipt: { sequence: 1, sha256: createHash("sha256").update("x").digest("hex") } }));
    await expect(wait()).rejects.toThrow("changed or exited");
  });
});

it.each(["skill", "plugin"])("preserves binary bytes and executable modes in %s projection", async category => {
  const root = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "omp-binary-test-"));
  try {
    const source = nodePath.join(root, "source");
    realFs.mkdirSync(source);
    realFs.writeFileSync(nodePath.join(source, "SKILL.md"), "instructions");
    realFs.writeFileSync(nodePath.join(source, "package.json"), JSON.stringify({ omp: { extensions: ["index.js"] } }));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0, 0x80]);
    realFs.writeFileSync(nodePath.join(source, "asset"), bytes);
    realFs.chmodSync(nodePath.join(source, "asset"), 0o755);
    const fsOps = {
      readFile: (p: string) => realFs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => realFs.writeFileSync(p, c),
      copyFile: realFs.copyFileSync, exists: realFs.existsSync, mkdirp: (p: string) => { realFs.mkdirSync(p, { recursive: true }); },
      listFiles: (p: string) => realFs.readdirSync(p), statMode: (p: string) => realFs.statSync(p).mode, chmod: realFs.chmodSync,
    };
    const launcher = new OmpSeatLauncher({ fsOps, tmux: {} as never, stateRoot: root, seatExtensionPath: extension });
    const adapter = new OmpTuiRuntimeAdapter({ fsOps, launcher, tmux: {} as never });
    const result = await adapter.project({ entries: [{ category, effectiveId: "binary", absolutePath: source }] } as never, binding());
    expect(result.failed).toEqual([]);
    const target = category === "skill" ? nodePath.join(launcher.paths(seat).agentDir, "skills", "binary", "asset")
      : nodePath.join(launcher.paths(seat).pluginsDir, "binary", "asset");
    expect(realFs.readFileSync(target)).toEqual(bytes);
    expect(realFs.statSync(target).mode & 0o777).toBe(0o755);
  } finally { realFs.rmSync(root, { recursive: true, force: true }); }
});
