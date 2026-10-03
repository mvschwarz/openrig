import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SeatLaunchEnvironment, publicSeatEnvironment } from "../src/domain/seat-launch-environment.js";
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
  expect(readlinkSync(rig)).toBe(f.cli); expect(readdirSync(path.dirname(rig))).toEqual(["rig"]);
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
  expect(readlinkSync(paths[0]!)).toBe(f.cli); expect(paths.slice(1)).toEqual(["node", "python", "git", "claude"].map(t => path.join(f.user, t)));
});
it.each(["claude", "codex"])("D: nushell retains the previous literal %s command", async runtime => {
  const f = fixture(); f.tmux.getPaneCommand.mockResolvedValue("nu");
  const command = await f.launch.command("seat@rig", `${runtime} --resume 'old'`, runtime === "codex" ? { codexCwd: f.cwd } : {});
  expect(command).toBe(runtime === "codex" ? `env PATH=${shellQuote(f.env.PATH)} codex --resume 'old'` : "claude --resume 'old'");
  expect(command).not.toContain('"$PATH"'); expect(f.warn).toHaveBeenCalledTimes(1);
});
it.each(["fresh", "resume", "fork"] as const)("C: %s uses the probe's separate Node interpreter while preserving user PATH", async kind => {
  const f = fixture(), nodeBin = path.dirname(process.execPath);
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
  const binding: any = { id: "b", nodeId: "node", tmuxSession: "seat@rig", tmuxPane: "%1", cwd: f.cwd };
  const result = await adapter.launchHarness(binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "old" } : kind === "fork" ? { forkSource: { kind: "native_id", value: "parent" } } : {}) });
  expect(result.ok).toBe(true);
  const command = (f.tmux.sendShellCommand.mock.calls.at(-1) as unknown as string[])[1]!;
  const userPath = "/usr/bin:/bin";
  const { stdout } = await exec("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd: f.cwd, env: { ...f.env, PATH: userPath }, timeout: 5000 });
  const observed = JSON.parse(stdout); expect(observed.started).toBe(true); expect(observed.node).toBe(process.execPath);
  expect(observed.path.split(":").slice(1).join(":")).toBe(userPath);
});
