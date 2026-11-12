import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SeatLaunchEnvironment, launchExecutable, publicSeatEnvironment, resolveLaunchWrapperArgv } from "../src/domain/seat-launch-environment.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { codexDaemonSupportProbe } from "../src/domain/codex-daemon-support.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "seat-env-regression-")); roots.push(root);
  const shared = path.join(root, "shared bin's"), user = path.join(root, "user"), runtime = path.join(root, "runtime"), cwd = path.join(root, "workspace");
  for (const dir of [shared, user, runtime, cwd]) mkdirSync(dir);
  const exe = (file: string, text: string) => writeFileSync(file, text, { mode: 0o700 });
  const cli = path.join(root, "installed-cli"); exe(cli, "#!/bin/sh\nprintf installed-rig\\n\n");
  for (const name of ["rig", "node", "python", "git", "claude"]) {
    exe(path.join(shared, name), "#!/bin/sh\nprintf shared-tool\\n\n");
    exe(path.join(user, name), "#!/bin/sh\nprintf user-tool\\n\n");
  }
  const env = { PATH: `${shared}:/usr/bin:/bin`, OPENRIG_HOME: path.join(root, "instance"), OPENRIG_URL: "http://127.0.0.1:7433", HOME: root };
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = { getSessionEnv: vi.fn(async (_s: string, key: string) => identity[key]), getPaneCommand: vi.fn(async () => "bash"), sendShellCommand: vi.fn(async (_session: string, _command: string) => ({ ok: true })) };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Fourth argument injects only a fake installed CLI path; production derives its paired CLI.
  const launch = new (SeatLaunchEnvironment as any)(tmux, env, root, cli) as SeatLaunchEnvironment;
  const run = (command: string) => exec("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd, env: { ...env, PATH: `${user}:/usr/bin:/bin` }, timeout: 5000 });
  return { root, shared, user, runtime, cwd, cli, env, identity, tmux, warn, launch, run, exe };
}

it.each(["transport", "missing-node", "missing-session", "different-node"])("A: %s keeps the previous Claude command with one diagnostic", async kind => {
  const f = fixture();
  if (kind === "transport") f.tmux.getSessionEnv.mockRejectedValue(Error("unavailable"));
  if (kind === "missing-node") delete f.identity.OPENRIG_NODE_ID;
  if (kind === "missing-session") delete f.identity.OPENRIG_SESSION_NAME;
  const command = await f.launch.command("seat@rig", "claude --resume 'old'", { nodeId: kind === "different-node" ? "other" : "node" });
  expect(command).toBe("claude --resume 'old'"); expect(f.warn).toHaveBeenCalledTimes(1);
});
it("A: Codex metadata failure preserves its previous literal launch PATH", async () => {
  const f = fixture(); f.tmux.getSessionEnv.mockRejectedValue(Error("unavailable"));
  expect(await f.launch.command("seat@rig", "codex --no-daemon", { codexCwd: f.cwd })).toBe(`env PATH=${shellQuote(f.env.PATH)} codex --no-daemon`);
  expect(f.warn).toHaveBeenCalledTimes(1);
});
it.each(["not-a-url", "http://user:synthetic-secret@localhost:1234", "http://localhost:1234?token=synthetic-secret", "http://localhost:1234#synthetic-secret"])("A: unsafe URL is omitted without dropping other public metadata: %s", value => {
  const f = fixture();
  expect(publicSeatEnvironment({ OPENRIG_HOME: f.env.OPENRIG_HOME, OPENRIG_URL: value })).toEqual({ OPENRIG_HOME: f.env.OPENRIG_HOME });
  expect(f.warn).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.warn.mock.calls)).not.toContain(value);
});
it("A/B: rig need not be on the daemon PATH; the linked CLI belongs to this install", async () => {
  const f = fixture(); f.env.PATH = "/usr/bin:/bin";
  const command = await f.launch.command("seat@rig", "/bin/sh -c 'command -v rig'");
  const rig = (await f.run(command)).stdout.trim();
  expect(rig.startsWith(path.join(f.env.OPENRIG_HOME, "run", "seat-bin") + path.sep)).toBe(true);
  expect(readlinkSync(rig)).toBe(realpathSync(f.cli)); expect(readdirSync(path.dirname(rig))).toEqual(["rig"]);
});
it("A: a missing paired CLI does not introduce a launch refusal", async () => {
  const f = fixture();
  const launch = new (SeatLaunchEnvironment as any)(f.tmux, f.env, f.root, path.join(f.root, "missing-cli")) as SeatLaunchEnvironment;
  expect(await launch.command("seat@rig", "claude")).toBe("claude"); expect(f.warn).toHaveBeenCalledTimes(1);
});
it("B: the owned rig-only directory leaves node/python/git/claude order intact", async () => {
  const f = fixture();
  const cmd = "/bin/sh -c 'for tool in rig node python git claude; do command -v \"$tool\"; done'";
  const paths = (await f.run(await f.launch.command("seat@rig", cmd))).stdout.trim().split("\n");
  expect(readlinkSync(paths[0]!)).toBe(realpathSync(f.cli)); expect(paths.slice(1)).toEqual(["node", "python", "git", "claude"].map(t => path.join(f.user, t)));
});
it.each(["claude", "codex"])("D: nushell retains the previous literal %s command", async runtime => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue("nu");
  const command = await f.launch.command("seat@rig", `${runtime} --resume 'old'`, runtime === "codex" ? { codexCwd: f.cwd } : {});
  expect(command).toBe(runtime === "codex" ? `env PATH=${shellQuote(f.env.PATH)} codex --resume 'old'` : "claude --resume 'old'");
  expect(command).not.toContain('"$PATH"'); expect(f.warn).toHaveBeenCalledTimes(1);
});
it.each(["fresh", "resume", "fork"] as const)("C: %s uses the probe's separate Node interpreter while preserving user PATH", async kind => {
  const f = fixture(), nodeBin = path.join(f.root, "node interpreter");
  mkdirSync(nodeBin); symlinkSync(process.execPath, path.join(nodeBin, "node"));
  expect(["/usr/bin", "/bin", f.shared, f.runtime]).not.toContain(nodeBin);
  f.exe(path.join(f.runtime, "codex"), `#!/usr/bin/env node\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else console.log(JSON.stringify({started:true,node:process.execPath,path:process.env.PATH}));\n`);
  // There is no Node in the pane PATH. The capability query really executes this npm-style entry.
  f.env.PATH = [f.runtime, nodeBin, f.shared, "/usr/bin", "/bin"].join(":");
  const launch = new (SeatLaunchEnvironment as any)(f.tmux, f.env, f.root, f.cli) as SeatLaunchEnvironment;
  const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, seatLaunchEnvironment: launch, launchPath: f.env.PATH,
    detectDaemonSupport: codexDaemonSupportProbe(f.env.PATH), resolveGitAddDirs: async () => [], listProcesses: () => [], sleep: async () => {},
    fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, homedir: f.root } });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("new-thread");
  vi.spyOn(adapter as any, "captureVerifiedForkId").mockResolvedValue("new-thread");
  const binding: any = { id: "b", nodeId: "node", tmuxSession: "seat@rig", tmuxPane: "%1", cwd: f.cwd };
  const result = await adapter.launchHarness(binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "old" } : kind === "fork" ? { forkSource: { kind: "native_id", value: "parent" } } : {}) });
  expect(result.ok).toBe(true);
  const command = (f.tmux.sendShellCommand.mock.calls.at(-1) as unknown as string[])[1]!;
  const userPath = "/usr/bin:/bin";
  const { stdout } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd: f.cwd, env: { ...f.env, PATH: userPath }, timeout: 5000 });
  const observed = JSON.parse(stdout); expect(observed.started).toBe(true); expect(observed.node).toBe(process.execPath);
  expect(observed.path.split(":").slice(1).join(":")).toBe(userPath);
});

it("B: the default resolver links this workspace's built CLI, not its PATH-first rig", async () => {
  const f = fixture();
  const launch = new SeatLaunchEnvironment(f.tmux as any, f.env, f.root);
  const rig = (await f.run(await launch.command("seat@rig", "/bin/sh -c 'command -v rig'"))).stdout.trim();
  expect(readlinkSync(rig)).toBe(realpathSync(path.resolve(import.meta.dirname, "../../cli/dist/bin-wrapper.js")));
  expect(f.warn).not.toHaveBeenCalled();
});
it("B: a reused link remains rig-only; unexpected contents are preserved and fall back", async () => {
  const f = fixture(), command = "/bin/sh -c 'command -v rig'";
  const rig = (await f.run(await f.launch.command("seat@rig", command))).stdout.trim();
  expect((await f.run(await f.launch.command("seat@rig", command))).stdout.trim()).toBe(rig);
  f.exe(path.join(path.dirname(rig), "node"), "#!/bin/sh\nexit 0\n");
  expect(await f.launch.command("seat@rig", "claude")).toBe("claude");
  expect(readdirSync(path.dirname(rig)).sort()).toEqual(["node", "rig"]);
  expect(readlinkSync(rig)).toBe(realpathSync(f.cli)); expect(f.warn).toHaveBeenCalledTimes(1);
});

it("export helper resolves executable from cwd when PATH has empty segments", () => {
  const f = fixture();
  const exePath = path.join(f.cwd, "codex");
  f.exe(exePath, "#!/bin/sh\nexit 0\n");
  expect(launchExecutable("codex", ":", f.cwd)).toBe(exePath);
});


it.each(["nu", "nu.exe", "fish", "csh", "", "unknown"])("Pi preserves its account-free command on an unsupported pane: %s", async shell => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue(shell);
  const command = "node '/runner.js' --session '/history.jsonl'";
  expect(await f.launch.command("seat@rig", command, { runtime: "pi" })).toBe(command);
  expect(f.tmux.getSessionEnv).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledTimes(1);
});

const REFUSAL_CMD = "printf '%s\\n' 'OpenRig: launch_wrapper unavailable; no agent started.' >&2; false";

it("launch_wrapper prefixes before pinned Node interpreter + Codex entry and after public env envelope", async () => {
  const f = fixture(), nodeBin = path.join(f.root, "node interpreter");
  mkdirSync(nodeBin); symlinkSync(process.execPath, path.join(nodeBin, "node"));
  f.exe(path.join(f.runtime, "codex"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({started:true,node:process.execPath,argv:process.argv.slice(2),path:process.env.PATH}));\n`);
  f.exe(path.join(f.shared, "my-wrapper"), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do arg="$1"; shift; [ "$arg" = "--" ] && break; done\nexec "$@"\n`);
  f.env.PATH = [f.runtime, nodeBin, f.shared, "/usr/bin", "/bin"].join(":");
  f.identity.OPENRIG_RUNTIME = "codex";
  const launch = new (SeatLaunchEnvironment as any)(f.tmux, f.env, f.root, f.cli) as SeatLaunchEnvironment;
  const unwrapped = await launch.command("seat@rig", "codex --no-daemon", { codexCwd: f.cwd, runtime: "codex" });
  const wrapped = await launch.command("seat@rig", "codex --no-daemon", { codexCwd: f.cwd, runtime: "codex", launchWrapper: ["my-wrapper", "literal $1", "--"] } as any);
  expect(await launch.command("seat@rig", "codex --no-daemon", { codexCwd: f.cwd, runtime: "codex", launchWrapper: [] } as any)).toBe(unwrapped);
  const expectedPrefix = `${shellQuote(path.join(f.shared, "my-wrapper"))} 'literal $1' '--' ${shellQuote(path.join(nodeBin, "node"))} ${shellQuote(path.join(f.runtime, "codex"))} --no-daemon`;
  expect(wrapped.endsWith(expectedPrefix)).toBe(true);
  const { stdout } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", wrapped], { cwd: f.cwd, env: { ...f.env, PATH: "/usr/bin:/bin" }, timeout: 5000 });
  expect(JSON.parse(stdout)).toMatchObject({ started: true, node: process.execPath, argv: ["--no-daemon"] });
});

it.each([
  "missing-wrapper",
  "non-executable-wrapper",
  "directory-wrapper",
  "relative-dot-wrapper",
  "relative-sub-wrapper",
  "empty-executable",
  "newline-arg",
  "nul-arg",
  "empty-daemon-path",
  "transport-error",
  "missing-node-id",
  "missing-session-name",
  "different-node-id",
  "missing-paired-cli",
  "polluted-seat-bin",
  "nu-shell",
  "fish-shell",
  "unknown-shell",
  "unsupported-runtime-pi",
  "unsupported-runtime-omp",
  "unsupported-runtime-terminal",
  "missing-runtime",
] as const)("launch_wrapper fails closed without bare fallback on %s", async failure => {
  const f = fixture();
  f.exe(path.join(f.shared, "codex"), "#!/bin/sh\nprintf codex-started\\n\n");
  f.exe(path.join(f.shared, "valid-wrapper"), "#!/bin/sh\nexec \"$@\"\n");
  writeFileSync(path.join(f.shared, "non-exec-wrapper"), "#!/bin/sh\nexec \"$@\"\n", { mode: 0o600 });
  mkdirSync(path.join(f.shared, "dir-wrapper"));
  f.exe(path.join(f.cwd, "valid-wrapper"), "#!/bin/sh\nexec \"$@\"\n");

  let wrapper: string[] = ["valid-wrapper", "--"];
  let runtime: string | undefined = "codex";
  let nodeId = "node";
  let launch = f.launch;

  if (failure === "missing-wrapper") wrapper = ["does-not-exist", "--"];
  if (failure === "non-executable-wrapper") wrapper = ["non-exec-wrapper", "--"];
  if (failure === "directory-wrapper") wrapper = ["dir-wrapper", "--"];
  if (failure === "relative-dot-wrapper") wrapper = ["./valid-wrapper", "--"];
  if (failure === "relative-sub-wrapper") wrapper = ["sub/valid-wrapper", "--"];
  if (failure === "empty-executable") wrapper = ["", "--"];
  if (failure === "newline-arg") wrapper = ["valid-wrapper", "bad\narg"];
  if (failure === "nul-arg") wrapper = ["valid-wrapper", "bad\0arg"];
  if (failure === "empty-daemon-path") f.env.PATH = "";
  if (failure === "transport-error") f.tmux.getSessionEnv.mockRejectedValue(new Error("transport secret-value"));
  if (failure === "missing-node-id") delete f.identity.OPENRIG_NODE_ID;
  if (failure === "missing-session-name") delete f.identity.OPENRIG_SESSION_NAME;
  if (failure === "different-node-id") nodeId = "other-node";
  if (failure === "missing-paired-cli") launch = new (SeatLaunchEnvironment as any)(f.tmux, f.env, f.root, path.join(f.root, "no-cli")) as SeatLaunchEnvironment;
  if (failure === "polluted-seat-bin") {
    const rig = (await f.run(await f.launch.command("seat@rig", "/bin/sh -c 'command -v rig'"))).stdout.trim();
    f.exe(path.join(path.dirname(rig), "extra"), "#!/bin/sh\nexit 0\n");
    f.warn.mockClear();
  }
  if (failure === "nu-shell") f.tmux.getPaneCommand.mockResolvedValue("nu");
  if (failure === "fish-shell") { f.tmux.getPaneCommand.mockResolvedValue("fish"); runtime = "codex"; }
  if (failure === "unknown-shell") f.tmux.getPaneCommand.mockResolvedValue("unknown");
  if (failure === "unsupported-runtime-pi") runtime = "pi";
  if (failure === "unsupported-runtime-omp") runtime = "omp";
  if (failure === "unsupported-runtime-terminal") runtime = "terminal";
  if (failure === "missing-runtime") runtime = undefined;

  const nativeCmd = runtime === "codex" ? "codex --no-daemon" : "node '/runner.js' --session '/s.jsonl'";
  const result = await launch.command("seat@rig", nativeCmd, {
    nodeId,
    ...(runtime ? { runtime } : {}),
    ...(runtime === "codex" ? { codexCwd: f.cwd } : {}),
    launchWrapper: wrapper,
  } as any);
  expect(result).toBe(REFUSAL_CMD);
  expect(result).not.toContain("runner.js");
  expect(result).not.toContain("codex --no-daemon");
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.warn.mock.calls)).not.toContain("secret-value");
});

it("resolveLaunchWrapperArgv rejects empty PATH or empty array and resolves wrapper[0] on daemonCwd", () => {
  const f = fixture();
  f.exe(path.join(f.shared, "valid-wrapper"), "#!/bin/sh\nexec \"$@\"\n");
  expect(resolveLaunchWrapperArgv(["valid-wrapper", "--"], f.env.PATH, f.root)).toEqual([
    path.join(f.shared, "valid-wrapper"),
    "--",
  ]);
  expect(() => resolveLaunchWrapperArgv(["valid-wrapper"], "", f.root)).toThrow(/daemon launch PATH/);
  expect(() => resolveLaunchWrapperArgv([], f.env.PATH, f.root)).toThrow(/empty/);
});
