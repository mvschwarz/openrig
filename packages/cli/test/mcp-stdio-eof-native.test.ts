import { expect, it } from "vitest";
import { spawn } from "node:child_process";

it.each(["0", "99999"])("initializes and lists tools over stdio despite daemon port %s", async (port) => {
  const source = new URL("../src/commands/mcp.ts", import.meta.url).href;
  const script = `import { mcpCommand } from ${JSON.stringify(source)}; await mcpCommand().parseAsync(["serve", "--port", ${JSON.stringify(port)}], { from: "user" });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let err = ""; let buffer = ""; let initialized = false; let tools: unknown; let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
  child.stderr.on("data", (chunk) => { err += chunk; });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const reply = JSON.parse(line);
      if (reply.id === 1 && reply.result) {
        initialized = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (reply.id === 2) {
        tools = reply.result?.tools;
        child.stdin.end();
      }
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "port-startup-test", version: "1" } } });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  clearTimeout(timer);
  expect({ code, timedOut, initialized }, err).toEqual({ code: 0, timedOut: false, initialized: true });
  expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "rig_status" })]));
  expect(err.split("\n").filter((line) => line.startsWith("Warning:"))).toEqual([
    `Warning: daemon port ${port} is outside [1, 65535]; MCP will start, but daemon tool calls may fail. Check --port.`,
  ]);
}, 15_000);

it.each(["eof", "sigterm"])("finishes rig mcp serve after native %s", async (mode) => {
  const source = new URL("../src/commands/mcp.ts", import.meta.url).href;
  const script = `import { mcpCommand } from ${JSON.stringify(source)}; console.error("module-ready"); await mcpCommand().parseAsync(["serve", "--port", "7433"], { from: "user" }); console.error("command-closed");`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let err = ""; let ready = false; let timedOut = false;
  let timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
  child.stderr.on("data", (chunk) => {
    err += chunk;
    if (!ready && err.includes("module-ready")) {
      ready = true; clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2000);
      if (mode === "eof") child.stdin.end();
      else child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "owned-native-test", version: "1" } } }) + "\n");
    }
  });
  let stdout = ""; let signaled = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (mode === "sigterm" && !signaled && stdout.includes('"id":1')) { signaled = true; child.kill("SIGTERM"); }
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  clearTimeout(timer);
  expect({ code, ready, timedOut }).toEqual({ code: 0, ready: true, timedOut: false });
  expect(err).toContain("command-closed");
});
