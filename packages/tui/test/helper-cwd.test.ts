import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const runner = fileURLToPath(new URL("../../../node_modules/vite-node/vite-node.mjs", import.meta.url));
const source = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tui-cwd-")));
  const home = join(root, "home"), cwd = join(root, "worktree");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const calls = join(root, "calls.jsonl"), cli = join(root, "rig.mjs");
  // These helpers only record their actual cwd/arguments; no terminal, daemon or rig is started.
  const record = `const call = { cwd: process.cwd(), args: process.argv.slice(2), url: process.env.OPENRIG_URL };
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + '\\n');`;
  await writeFile(cli, `import { appendFileSync } from 'node:fs';
${record}
if (call.args[0] === 'terminal') console.log(JSON.stringify({ ok: true, opened: ['fixture'], absent: [], degraded: [] }));
else if (call.args[0] === 'config') console.log('{"value":"UTC"}');
else if (call.args[0] === 'crash-cart') console.log('{"state":"unverified","evidence":{"reason":"fixture probe"}}');
else if (call.args[0] !== 'up') process.exitCode = 2;
`);
  await writeFile(join(root, "local-reading.js"), `const { appendFileSync } = require('node:fs');
${record}
console.log(JSON.stringify({ source: call.cwd }));`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENRIG_|RIGGED_|CMUX_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, OPENRIG_HOME: home, OPENRIG_TUI_CLI_ENTRY: cli, OPENRIG_TUI_SOCKET: join(root, "t.sock") });
  return { root, home, cwd, cli, env, calls: async () => (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}

it.each([false, true])("helpers preserve a live cwd and recover a deleted cwd (deleted: %s)", async deleted => {
  const f = await fixture();
  try {
    const probe = join(f.root, "probe.ts");
    await writeFile(probe, `
import { rmSync } from 'node:fs';
import { readLocal } from ${JSON.stringify(source("local-reading.ts"))};
import { openTerminalInWindow } from ${JSON.stringify(source("terminals/open-window.ts"))};
import { launchProcess, spawnLaunch } from ${JSON.stringify(source("specs/launch.ts"))};
async function run() {
  process.chdir(${JSON.stringify(f.cwd)});
  if (${deleted}) rmSync(${JSON.stringify(f.cwd)}, { recursive: true });
  const result: Record<string, unknown> = {};
  result.read = await readLocal(${JSON.stringify(f.cli)}, { op: 'roots' });
  try { result.terminal = await openTerminalInWindow('saved:fixture', 'http://selected.example:7433', ${JSON.stringify(f.cli)}, 'same-plan'); }
  catch (error) { result.terminal = String(error); }
  result.launch = await spawnLaunch(launchProcess({ source: 'fixture', folder: ${JSON.stringify(f.home)}, host: 'local' },
    'http://selected.example:7433', process.env, process.execPath, [${JSON.stringify(f.cli)}]));
  try { result.parentCwd = process.cwd(); } catch (error) { result.parentCwd = (error as NodeJS.ErrnoException).code; }
  console.log('RESULT:' + JSON.stringify(result));
}
void run();
`);
    const { stdout } = await promisify(execFile)(process.execPath, [runner, "--script", probe], { env: f.env, timeout: 15_000 });
    const result = JSON.parse(stdout.split("RESULT:")[1]!);
    const expected = deleted ? f.home : f.cwd;
    expect(result.read).toEqual({ source: expected });
    expect(result.terminal).toMatchObject({ ok: true, opened: ["fixture"] });
    expect(result.launch).toBe(0);
    expect(result.parentCwd).toBe(deleted ? "ENOENT" : f.cwd);
    const calls = await f.calls();
    expect(calls.map(call => call.cwd)).toEqual([expected, expected, expected]);
    expect(calls.map(call => call.args)).toEqual([
      [JSON.stringify({ op: "roots" })],
      ["terminal", "open", "--window", "--json", "--expected-plan", "same-plan", "--", "saved:fixture"],
      ["up", "--cwd", f.home, "--", "fixture"],
    ]);
    expect(calls.slice(1).map(call => call.url)).toEqual(["http://selected.example:7433", "http://selected.example:7433"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 25_000);

it("the running TUI can repeat its startup helper after its start folder is deleted", async () => {
  const f = await fixture();
  // A private server returns a failed read; it never accepts a lifecycle operation.
  const server = createServer((_, res) => { res.writeHead(503); res.end("fixture unavailable"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const child = spawn(process.execPath, [runner, "--script", source("main.ts"), "--no-color", "--url", `http://127.0.0.1:${address.port}`],
    { cwd: f.cwd, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const ended = new Promise(resolve => child.once("exit", resolve));
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 8_000;
    while (!await check()) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`TUI helper did not complete: ${errors}\n${output.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    await until(async () => output.includes("rig doctor --help") && (await f.calls()).some(call => call.args[0] === "crash-cart"));
    await rm(f.cwd, { recursive: true });
    child.stdin.write("r");
    await until(async () => (await f.calls()).filter(call => call.args[0] === "crash-cart").length === 2);
    const calls = await f.calls();
    expect(calls.find(call => call.args[0] === "config")?.cwd).toBe(f.cwd);
    expect(calls.filter(call => call.args[0] === "crash-cart").map(call => call.cwd)).toEqual([f.cwd, f.home]);
    expect(errors).not.toContain("uv_cwd");
  } finally {
    child.kill("SIGKILL"); await ended;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
}, 25_000);
