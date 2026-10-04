import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it("keeps the reached IPv6 daemon endpoint for MCP tool requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-endpoint-native-")); dirs.push(dir);
  const command = new URL("../src/commands/mcp.ts", import.meta.url).href;
  const client = new URL("../src/client.ts", import.meta.url).href;
  const daemon = new URL("../src/commands/daemon.ts", import.meta.url).href;
  const script = `import http from 'node:http'; import { mcpCommand } from ${JSON.stringify(command)}; import { DaemonClient } from ${JSON.stringify(client)}; import { realDeps } from ${JSON.stringify(daemon)};
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,selfHostId:'owned-ipv6-daemon'}));});
await new Promise(r=>server.listen(0,'::1',r)); process.env.OPENRIG_URL='http://[::1]:'+server.address().port;
const cmd=mcpCommand({lifecycleDeps:realDeps(),clientFactory:(url)=>{const c=new DaemonClient(url); void c.get('/healthz').then(r=>console.error('probe-ok:'+r.data.selfHostId),e=>console.error('probe-error:'+e.message));return c;}});
try {await cmd.parseAsync(['serve'],{from:'user'});} finally {await new Promise(r=>server.close(r));}`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, OPENRIG_HOME: dir, OPENRIG_HOST_SELECTED: "", OPENRIG_URL: "", RIGGED_URL: "" }, stdio: ["pipe", "pipe", "pipe"] });
  let err = ""; let signaled = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stderr.on("data", (chunk) => {
    err += chunk;
    if (!signaled && (err.includes("probe-ok:") || err.includes("probe-error:"))) { signaled = true; child.kill("SIGTERM"); }
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  clearTimeout(timer);
  expect(code, err).toBe(0);
  expect(err).toContain("probe-ok:owned-ipv6-daemon");
  expect(err).not.toContain("probe-error:");
});
