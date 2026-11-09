// A Pi seat's command is staged into a private script that execs it (execInScript), so the agent replaces the staging
// shell. A declared account home adds a credential scrub to that command; composed as `unset …; …`, the staged
// `exec unset …` failed and no agent started (0.7.11). The real SeatLaunchEnvironment composes each Pi caller's
// command, the real TmuxAdapter stages it, and /bin/sh runs the staged script with stale provider keys in its environment.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const stale = { PI_CODING_AGENT_DIR: "/pi/stale", MISTRAL_API_KEY: "fixture-mistral", GEMINI_API_KEY: "fixture-gemini", OPENAI_API_KEY: "fixture-openai", ANTHROPIC_API_KEY: "fixture-anthropic" };

async function staged(target: Parameters<SeatLaunchEnvironment["command"]>[2], selection: "selected" | "none") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-staged-exec-")));
  roots.push(root);
  const cli = path.join(root, "rig");
  fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  // Stands in for the Pi runner: says which process it is and what it was given. A real seat's command runs past the
  // 512-byte direct-typing bound (its runner path, state root and environment), so it is staged; this path does too.
  const runnerDir = path.join(root, ...Array.from({ length: 8 }, () => "nested-runner-directory-" + "x".repeat(24)));
  fs.mkdirSync(runnerDir, { recursive: true });
  const runner = path.join(runnerDir, "pi-runner");
  fs.writeFileSync(runner, "#!/bin/sh\nprintf 'pid=%s\\n' \"$$\"\nenv\n", { mode: 0o700 });
  const paneTmux = {
    getPaneCommand: async () => "bash",
    getSessionEnv: async (_session: string, key: string) => key === "OPENRIG_NODE_ID" ? "pi-node" : "seat@rig",
  } as unknown as TmuxAdapter;
  const launch = new SeatLaunchEnvironment(paneTmux, { PATH: "/usr/bin:/bin", OPENRIG_HOME: root }, root, cli, undefined,
    (_node, _runtime, clearing) => selection === "none" ? undefined : clearing ? "/pi/configured" : "/pi/selected");
  const command = await launch.command("seat@rig", runner, target);
  const script = path.join(root, "launch.sh");
  const files = new Map<string, string>();
  let names = 0;
  const fileOps: TmuxFileOps = {
    // The first name is the staged script; later ones are the paste buffer that types its invocation.
    tmpName: () => names++ === 0 ? script : path.join(root, "paste.txt"), bufferName: () => "buffer",
    writeFile: vi.fn(async (file, text) => { files.set(file, text); }),
    unlink: vi.fn(async file => { files.delete(file); }),
  };
  const transport = new TmuxAdapter(vi.fn(async (request: string) => request.includes("#{pane_current_command}") ? "bash" : ""), fileOps);
  expect(await transport.sendShellCommand("seat@rig", command, undefined, { stageIfLong: true, execInScript: true })).toEqual({ ok: true });
  const body = files.get(script);
  if (body === undefined) return { command, body, ran: null };
  fs.writeFileSync(script, body, { mode: 0o600 });
  const child = spawn("/bin/sh", [script], { env: { PATH: "/usr/bin:/bin", ...stale } });
  let out = "", err = "";
  child.stdout.on("data", c => { out += c; });
  child.stderr.on("data", c => { err += c; });
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  return { command, body, ran: { code, out, err, shellPid: child.pid } };
}

it.each([
  ["launch, selection read from the seat", { nodeId: "pi-node", runtime: "pi", generation: "g1" }, "/pi/selected"],
  ["resume with the seat's selection", { runtime: "pi", nodeId: "pi-node", accountHome: "/pi/selected" }, "/pi/selected"],
  ["account switch to a new home", { nodeId: "pi-node", runtime: "pi", accountHome: "/pi/switched" }, "/pi/switched"],
  ["clear back to the configured home", { nodeId: "pi-node", runtime: "pi", accountHome: null }, "/pi/configured"],
] as const)("%s: the staged script scrubs provider keys and execs the agent in its own process", async (_case, target, home) => {
  const { body, ran } = await staged(target, "selected");
  expect(body).toBeDefined();
  expect(ran!.err).toBe("");
  expect(ran!.code).toBe(0);
  expect(ran!.out).toContain(`PI_CODING_AGENT_DIR=${home}\n`);
  expect(ran!.out).not.toContain("fixture-");
  // exec: the agent took over the staging shell's process.
  expect(ran!.out).toContain(`pid=${ran!.shellPid}\n`);
});

it("a Pi seat with no account selection composes and stages exactly as before", async () => {
  const { command, body, ran } = await staged({ nodeId: "pi-node", runtime: "pi" }, "none");
  expect(command.startsWith("/usr/bin/env '")).toBe(true);
  expect(command).not.toMatch(/(^|[ ;])(unset|-u) /);
  if (body !== undefined) {
    expect(body.split("\n")[1]).toBe(`exec ${command}`);
    expect(ran!.code).toBe(0);
    expect(ran!.out).toContain(`pid=${ran!.shellPid}\n`);
  }
});

it("a clear with no configured home still removes the stale home, and the agent still execs", async () => {
  const { body, ran } = await staged({ nodeId: "pi-node", runtime: "pi", accountHome: null }, "none");
  expect(body).toBeDefined();
  expect(ran!.err).toBe("");
  expect(ran!.code).toBe(0);
  expect(ran!.out).not.toContain("PI_CODING_AGENT_DIR=");
  expect(ran!.out).toContain(`pid=${ran!.shellPid}\n`);
});
