// A control socket that cannot be bound must not end the launcher. The socket is how an agent reads
// and drives this TUI, so losing it costs that, and the operator should still get a TUI that draws,
// with the loss said plainly rather than a process that exits before the first frame.

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const tsxLoader = new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

it("starts without a control socket when neither endpoint can be bound, and says what that costs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "t-")));
  const cli = join(root, "rig.mjs");
  // Answers as `rig` does on a machine with no daemon, so the crash cart stays out of the way.
  await writeFile(cli, `if (process.argv[2] === 'config') console.log('{"value":"UTC"}'); else process.exitCode = 2;\n`);
  // A regular file where a directory would have to be. mkdirSync(recursive, { recursive: true }) on the
  // socket's parent then fails with ENOTDIR, which the fallback treats as recoverable, and the
  // alternate endpoint in the same folder fails the same way. A missing directory would not do: the
  // bind creates its own parent folder first, so it would succeed.
  const blocked = join(root, "file");
  await writeFile(blocked, "not a directory\n");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENRIG_|RIGGED_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: root,
    OPENRIG_HOME: root,
    OPENRIG_TUI_CLI_ENTRY: cli,
    OPENRIG_TUI_SOCKET: join(blocked, "sub", "t.sock"),
  });
  const child = spawn(process.execPath, ["--import", tsxLoader, main, "--demo", "--no-color"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const ended = new Promise(resolve => child.once("exit", resolve));
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  try {
    const deadline = Date.now() + 20_000;
    while (!output.includes("openrig-build")) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the TUI exited instead of starting: ${errors}\n${output.slice(-1500)}`);
      if (Date.now() > deadline) throw new Error(`the TUI did not draw: ${errors}\n${output.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // It drew a frame, it is still running, and the loss is named twice: once in the notice, and once in
    // the status bar, which stays true after the notice is replaced by whatever is chosen next.
    expect(child.exitCode).toBeNull();
    expect(output).toContain("Control socket unavailable");
    expect(output).toContain("socket: unavailable");
  } finally {
    child.kill("SIGKILL"); await ended;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);