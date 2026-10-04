import { expect, it } from "vitest";
import { spawn } from "node:child_process";

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
