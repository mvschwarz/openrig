import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const require = createRequire(import.meta.url);
const hooks = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
const { spawnRig } = require(path.join(hooks, "rig-command.cjs"));
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it.runIf(process.platform === "win32")("dispatches the actual generated seat rig shim through the hook's paired CLI resolver", async () => {
  root = mkdtempSync(path.join(tmpdir(), "openrig-paired-hook O'Brien 用户-"));
  const pkg = path.join(root, "cli"), cli = path.join(pkg, "dist", "bin-wrapper.cjs"), home = path.join(root, "home");
  mkdirSync(path.dirname(cli), { recursive: true }); mkdirSync(home);
  const manifest = path.join(pkg, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/bin-wrapper.cjs" } }));
  writeFileSync(cli, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));");
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "owned-node", OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_RUNTIME: "claude-code" };
  const tmux = { getPaneCommand: vi.fn(async () => "powershell.exe"), getSessionEnv: vi.fn(async (_session: string, key: string) => identity[key] ?? null) } as unknown as TmuxAdapter;
  const launch = new SeatLaunchEnvironment(tmux, { OPENRIG_HOME: home, PATH: root }, root, cli, undefined, "win32");
  await launch.command("owned@fixture", "'owned-provider.exe'", { nodeId: "owned-node", runtime: "claude-code" });
  const seats = path.join(home, "run", "seat-bin");
  const bin = path.join(seats, readdirSync(seats)[0]!);
  const env = { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir(), PATH: bin, PATHEXT: ".CMD", OPENRIG_HOME: home };
  const args = ["context", "get", "packs/用户 O'Brien & %PATH%", ""];
  const result = spawnRig(args, { env, cwd: root, encoding: "utf8", timeout: 5000 });
  expect(result.status, result.error?.message).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ args, cwd: root });
  writeFileSync(cli, "process.stdout.write('# Owned paired context 用户\\n');");
  const hook = spawnSync(process.execPath, [path.join(hooks, "refocus.cjs"), "--runtime", "claude"], {
    env: { ...env, OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_WORK_PACKET: "0", OPENRIG_REFOCUS_CONTENT_REF: "packs/owned", OPENRIG_SEAT_PROJECT_DIR: "" },
    encoding: "utf8", timeout: 10000, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "owned-paired" }),
  });
  expect(hook.status, hook.stderr).toBe(0);
  expect(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext).toContain("# Owned paired context 用户\n");
  const shim = path.join(bin, "rig.cmd"), originalShim = readFileSync(shim, "utf8");
  const wrongBin = path.join(seats, "wrong-digest"); mkdirSync(wrongBin);
  writeFileSync(path.join(wrongBin, "rig.cmd"), originalShim);
  expect(spawnRig(args, { env: { ...env, PATH: wrongBin }, cwd: root, encoding: "utf8" }).error).toBeDefined();
  writeFileSync(shim, originalShim + "echo unrecognized-extra-command\r\n");
  expect(spawnRig(args, { env, cwd: root, encoding: "utf8" }).error).toBeDefined();
  writeFileSync(shim, originalShim.replace(process.execPath, cli));
  expect(spawnRig(args, { env, cwd: root, encoding: "utf8" }).error).toBeDefined();
  writeFileSync(shim, originalShim);
  writeFileSync(path.join(pkg, "dist", "other.cjs"), "throw new Error('must not execute');");
  writeFileSync(manifest, JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/other.cjs" } }));
  expect(spawnRig(args, { env, cwd: root, encoding: "utf8" }).error).toBeDefined();
  writeFileSync(manifest, JSON.stringify({ name: "unrelated", bin: { rig: "dist/bin-wrapper.cjs" } }));
  expect(spawnRig(args, { env, cwd: root, encoding: "utf8" }).error).toBeDefined();
});
