import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ComposeServicesAdapter, windowsServicePort } from "../src/adapters/compose-services-adapter.js";
import { evaluateWaitTargets } from "../src/domain/services-readiness.js";
import { allowFetchTarget } from "../../cli/test/fetch-guard.js";

const exec = promisify(execFile);
const noShell = async () => { throw new Error("unexpected shell execution"); };
describe.skipIf(process.platform !== "win32")("native Windows Compose services", () => {
  it("sends Docker argv literally through a native executable boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-compose-argv-"));
    try {
      const receiver = path.join(root, "receiver.cjs"), receipt = path.join(root, "calls.jsonl");
      await writeFile(receiver, `const args=process.argv.slice(2);require('node:fs').appendFileSync(${JSON.stringify(receipt)},JSON.stringify(args)+'\\n');console.log(args.includes('--format')?'[{"Service":"db","State":"running"}]':'');`);
      const adapter = new ComposeServicesAdapter(noShell, async args => (await exec(process.execPath, [receiver, ...args], { windowsHide: true })).stdout);
      const opts = { composeFile: "C:\\space & percent%\\compose's.yaml", projectName: "owned-project", profiles: ["profile space;literal"] };
      expect(await adapter.up(opts)).toEqual({ ok: true });
      expect((await adapter.status(opts)).services[0]?.name).toBe("db");
      expect((await adapter.logs({ ...opts, tail: 0, service: "db's name & literal" })).ok).toBe(true);
      expect(await adapter.down({ ...opts, policy: "down_and_volumes" })).toEqual({ ok: true });
      const calls = (await readFile(receipt, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const prefix = ["docker", "compose", "-f", opts.composeFile, "-p", opts.projectName, "--profile", opts.profiles[0]];
      expect(calls).toEqual([
        [...prefix, "up", "-d"], [...prefix, "ps", "--format", "json"],
        [...prefix, "logs", "--tail", "0", "db's name & literal"], [...prefix, "down", "--volumes"],
      ]);
      expect(await adapter.down({ ...opts, policy: "leave_running" })).toEqual({ ok: true });
      expect((await readFile(receipt, "utf8")).trim().split("\n")).toHaveLength(4);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("probes an owned HTTP server without curl and does not follow redirects", async () => {
    let forbidden = 0;
    const server = createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { location: "/must-not-follow" }); res.end(); }
      else if (req.url === "/must-not-follow") { forbidden++; res.end(); }
      else if (req.url === "/hang") { /* abort deadline owns this socket */ }
      else { res.writeHead(req.url === "/bad" ? 503 : 204); res.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    allowFetchTarget(origin);
    const adapter = new ComposeServicesAdapter(noShell, noShell);
    try {
      expect(await adapter.probeHttp(origin)).toBe(true);
      expect(await adapter.probeHttp(origin + "/redirect")).toBe(true);
      expect(forbidden).toBe(0);
      expect(await adapter.probeHttp(origin + "/bad")).toBe(false);
      expect(await adapter.probeHttp(origin + "/hang", 50)).toBe(false);
      expect(await adapter.probeTcp(`127.0.0.1:${(server.address() as { port: number }).port}`)).toBe(true);
      expect(await adapter.checkTcp("127.0.0.1:openrig-fixture-no-such-service")).toEqual({ ok: false, reason: "named_port_unknown" });
      expect((await evaluateWaitTargets([{ tcp: "127.0.0.1:openrig-fixture-no-such-service" }], adapter))[0]?.detail).toContain("Windows services database");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("resolves TCP names and aliases without treating UDP or malformed entries as ports", () => {
    const services = "http 80/tcp www # comment\nhttp 81/udp alias\ncustom 32123/tcp alias-name\nbad 99999/tcp invalid\n";
    expect(windowsServicePort(services, "www")).toBe(80);
    expect(windowsServicePort(services, "ALIAS-NAME")).toBe(32123);
    expect(windowsServicePort(services, "alias")).toBeUndefined();
    expect(windowsServicePort(services, "invalid")).toBeUndefined();
  });
});
