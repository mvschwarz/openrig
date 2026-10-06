import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the TUI and return prompt after a real launch-group SIGINT, then restores normal SIGINT", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tui-sig-"));
  const cli = path.join(root, "rig.mjs");
  await writeFile(cli, `
if (process.argv[2] === 'config') console.log('{"value":"UTC"}');
else if (process.argv[2] === 'crash-cart') console.log('{"state":"up"}');
else if (process.argv[2] === 'up') {
  setInterval(() => {}, 1000);
  console.log('FIXTURE_UP_READY');
} else process.exitCode = 1;
`);
  const server = createServer((req, res) => {
    let data: unknown = [];
    if (req.url === "/api/specs/library") data = [{ id: "a1", kind: "rig", name: "signal-team", sourceType: "builtin" }];
    if (req.url === "/api/specs/library/a1/review") data = { kind: "rig", name: "signal-team", graph: { nodes: [], edges: [] } };
    if (req.url === "/api/scopes?detail=1") data = { missions: [] };
    if (req.url === "/api/review/fleet") data = { needsYou: { items: [] }, hosts: [] };
    if (req.url === "/api/queue/attention-aggregate") data = { hosts: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENRIG_|RIGGED_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: root, OPENRIG_HOME: root, OPENRIG_TUI_CLI_ENTRY: cli, OPENRIG_TUI_SOCKET: path.join(root, "t.sock") });
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/vite-node/vite-node.mjs", import.meta.url)), "--script",
    fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--instance", "launch-signal", "--no-color",
    "--url", `http://127.0.0.1:${address.port}`,
  ], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (!check()) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`TUI did not reach expected frame: ${errors}\n${output.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    await until(() => output.includes("no rigs served — proven empty"));
    child.stdin.write("spec signal-team\r");
    await until(() => output.includes("authored topology, not live status"));
    child.stdin.write("launch\r");
    await until(() => output.includes("Working folder: not chosen"));
    child.stdin.write(`launch-folder ${root}\r`);
    await until(() => output.includes("Launch · run this command"));
    // Four tab targets precede Launch. Use the real keyboard path, not a mocked act.
    child.stdin.write("\x1b[C" + "\x1b[B".repeat(4) + "\r");
    await until(() => output.includes("FIXTURE_UP_READY"));
    process.kill(-child.pid!, "SIGINT");
    await until(() => output.includes("Press Enter to return to OpenRig."));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(output).toContain("rig up ended by signal; inspect rig ps before retrying.");
    const beforeReturn = output.length;
    child.stdin.write("\r");
    await until(() => output.slice(beforeReturn).includes("authored topology, not live status"));
    child.kill("SIGINT");
    const ended = await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("normal SIGINT did not stop TUI")), 3000).unref())]);
    expect(ended).toEqual({ code: 0, signal: null });
  } finally {
    // Only the process group created by this fixture; no tmux or provider process.
    try { process.kill(-child.pid!, "SIGKILL"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
    await exit;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
