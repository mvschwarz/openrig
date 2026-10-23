import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runner = fileURLToPath(new URL("../../../node_modules/vite-node/vite-node.mjs", import.meta.url));
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

it("--demo draws its fixture with no daemon and never runs the daemon-down probe", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tui-demo-")));
  const calls = join(root, "calls.jsonl"), cli = join(root, "rig.mjs");
  // Answers as `rig` does on a machine with no daemon: the crash-cart probe reports a first run.
  await writeFile(cli, `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'config') console.log('{"value":"UTC"}');
else if (args[0] === 'crash-cart') console.log(JSON.stringify({ state: 'down', discovery: { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] } }));
else process.exitCode = 2;
`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENRIG_|RIGGED_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: root, OPENRIG_HOME: root, OPENRIG_TUI_CLI_ENTRY: cli, OPENRIG_TUI_SOCKET: join(root, "t.sock") });
  const child = spawn(process.execPath, [runner, "--script", main, "--demo", "--no-color"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const ended = new Promise(resolve => child.once("exit", resolve));
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const recorded = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
  try {
    const deadline = Date.now() + 15_000;
    while (!(output.includes("openrig-build") && (await recorded()).some(args => args[0] === "config"))) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`demo did not draw: ${errors}\n${output.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // The launch probe starts with the timezone read; give it time to answer and redraw if it ran.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect((await recorded()).map(args => args[0])).not.toContain("crash-cart");
    expect(output).not.toContain("CRASH-CART");
  } finally {
    child.kill("SIGKILL"); await ended;
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
