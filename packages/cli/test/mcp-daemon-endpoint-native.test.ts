import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps the reached IPv6 daemon endpoint for MCP tool requests", async (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-endpoint-native-"));
  dirs.push(dir);
  const command = new URL("../src/commands/mcp.ts", import.meta.url).href;
  const client = new URL("../src/client.ts", import.meta.url).href;
  const daemon = new URL("../src/commands/daemon.ts", import.meta.url).href;
  const script = `
import http from "node:http";
import { mcpCommand } from ${JSON.stringify(command)};
import { DaemonClient } from ${JSON.stringify(client)};
import { realDeps } from ${JSON.stringify(daemon)};

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, selfHostId: "owned-ipv6-daemon" }));
});
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
} catch (error) {
  if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) {
    console.error("ipv6-unavailable:" + error.code);
    process.exit(77);
  }
  throw error;
}
process.env.OPENRIG_URL = "http://[::1]:" + server.address().port;
const cmd = mcpCommand({
  lifecycleDeps: realDeps(),
  clientFactory: (url) => {
    const client = new DaemonClient(url);
    void client.get("/healthz").then(
      (result) => console.error("probe-ok:" + result.data.selfHostId),
      (error) => console.error("probe-error:" + error.message),
    );
    return client;
  },
});
try {
  await cmd.parseAsync(["serve"], { from: "user" });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: {
      ...process.env,
      OPENRIG_HOME: dir,
      OPENRIG_HOST_SELECTED: "",
      OPENRIG_URL: "",
      RIGGED_URL: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  let initialized = false;
  let stdout = "";
  let toolReply: { result?: { content?: Array<{ text?: string }>; isError?: boolean } } | undefined;
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stderr.on("data", (chunk) => {
    err += chunk;
    if (!initialized && (err.includes("probe-ok:") || err.includes("probe-error:"))) {
      initialized = true;
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "owned-ipv6-test", version: "1" } } });
    }
  });
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let end: number;
    while ((end = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      if (!line.trim()) continue;
      const reply = JSON.parse(line);
      if (reply.id === 1 && reply.result) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rig_status", arguments: {} } });
      } else if (reply.id === 2) { toolReply = reply; child.stdin.end(); }
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  clearTimeout(timer);
  if (code === 77 && /ipv6-unavailable:(EAFNOSUPPORT|EADDRNOTAVAIL)/.test(err)) {
    context.skip();
    return;
  }
  expect(code, err).toBe(0);
  expect(err).toContain("probe-ok:owned-ipv6-daemon");
  expect(err).not.toContain("probe-error:");
  expect(toolReply?.result?.isError).not.toBe(true);
  expect(toolReply?.result?.content?.some(item => item.text?.includes("owned-ipv6-daemon"))).toBe(true);
});
