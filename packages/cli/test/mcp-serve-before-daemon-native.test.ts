import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// The plugin's server starts with the app, before the daemon: a tool call says it can't connect, and once the daemon
// answers, the next call in the same stdio session works, with no reconnect.
it("serves a person's app before the daemon starts, and reaches the daemon once it answers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-before-daemon-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, ".openrig");
  fs.mkdirSync(home);
  const port = await freePort();
  const source = new URL("../src/commands/mcp.ts", import.meta.url).href;
  const script = `import { mcpCommand } from ${JSON.stringify(source)}; await mcpCommand().parseAsync(["serve", "--front-door"], { from: "user" });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, OPENRIG_HOME: home, OPENRIG_PORT: String(port), OPENRIG_URL: "", RIGGED_URL: "", OPENRIG_HOST_SELECTED: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  const replies = new Map<number, { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }>();
  let err = ""; let buffer = ""; let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
  child.stderr.on("data", (chunk) => { err += chunk; });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  const callPs = (id: number) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "rig_ps", arguments: {} } });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const reply = JSON.parse(line);
      replies.set(reply.id, reply);
      if (reply.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        callPs(2);
      } else if (reply.id === 2) {
        // The daemon starts on the endpoint the server was already aimed at.
        const daemon = http.createServer((req, res) => {
          res.writeHead(req.url?.startsWith("/api/ps") || req.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
          res.end(req.url?.startsWith("/api/ps") ? JSON.stringify([{ name: "demo-rig" }]) : JSON.stringify({ ok: true }));
        });
        cleanups.push(() => new Promise<void>((resolve) => daemon.close(() => resolve())));
        daemon.listen(port, "127.0.0.1", () => callPs(3));
      } else if (reply.id === 3) {
        child.stdin.end();
      }
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "before-daemon-test", version: "1" } } });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  clearTimeout(timer);

  expect({ code, timedOut, initialized: !!replies.get(1)?.result }, err).toEqual({ code: 0, timedOut: false, initialized: true });
  const before = replies.get(2)?.result;
  expect(before?.isError).toBe(true);
  expect(before?.structuredContent).toMatchObject({ ok: false, code: "daemon_unreachable" });
  expect(before?.content?.[0]?.text).toContain(`Cannot connect to the OpenRig daemon at http://127.0.0.1:${port}`);
  const after = replies.get(3)?.result;
  expect(after?.isError).toBeUndefined();
  expect(after?.content?.[0]?.text).toBe(JSON.stringify([{ name: "demo-rig" }]));
  expect(err).toContain("Error: Daemon not running.");
  expect(err).toContain(`rig mcp serve: serving anyway. Tool calls go to the daemon at http://127.0.0.1:${port} and fail until it answers there.`);
}, 25_000);
