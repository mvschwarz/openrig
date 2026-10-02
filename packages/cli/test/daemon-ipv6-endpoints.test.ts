import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

let home: string;
const servers: http.Server[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-ipv6-endpoint-"));
  for (const key of ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_HOST", "RIGGED_HOST", "OPENRIG_PORT", "RIGGED_PORT", "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME"]) vi.stubEnv(key, undefined);
  vi.stubEnv("OPENRIG_HOME", home);
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  vi.unstubAllEnvs(); resetFetchAllowlist(); fs.rmSync(home, { recursive: true, force: true });
});
async function ipv6Server() {
  const received: string[] = [];
  const server = http.createServer((request, response) => {
    received.push(request.url!); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve); });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  allowFetchTarget(`http://[::1]:${port}`);
  return { port, received };
}
function deps(port: number, recorded: boolean): LifecycleDeps {
  const state = JSON.stringify({ pid: process.pid, host: "::1", port, startedAt: new Date().toISOString(), db: ":memory:" });
  return {
    spawn: () => { throw new Error("fixture must not spawn"); },
    fetch: async (url) => fetch(url),
    kill: () => { throw new Error("fixture must not signal"); },
    readFile: (file) => recorded && file.endsWith("daemon.json") ? state : null,
    writeFile: () => { throw new Error("fixture must not write"); },
    removeFile: () => { throw new Error("fixture must not remove"); },
    exists: (file) => recorded && file.endsWith("daemon.json"),
    mkdirp: () => { throw new Error("fixture must not mkdir"); },
    openForAppend: () => { throw new Error("fixture must not open"); },
    isProcessAlive: () => true,
  };
}
describe("CLI IPv6 daemon endpoints", () => {
  it.each(["recorded", "configured"])("reaches a native IPv6 server through the %s default client endpoint", async (source) => {
    const { port, received } = await ipv6Server();
    const file = source === "recorded" ? "daemon.json" : "config.json";
    fs.writeFileSync(path.join(home, file), JSON.stringify(source === "recorded"
      ? { pid: process.pid, host: "::1", port }
      : { daemon: { host: "::1", port } }));
    const result = await new DaemonClient().get("/api/fixture");
    expect(result).toEqual({ status: 200, data: { ok: true } });
    expect(received).toEqual(["/api/fixture"]);
  });
  it.each([true, false])("reads health from native IPv6 with recorded state=%s", async (recorded) => {
    const { port, received } = await ipv6Server();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { host: "::1", port } }));
    const status = await getDaemonStatus(deps(port, recorded));
    expect(status).toMatchObject({ state: "running", healthy: true, host: "::1", port });
    expect(received).toEqual(["/healthz"]);
    expect(getDaemonUrl(status)).toBe(`http://[::1]:${port}`);
  });
  it.each(["127.0.0.1", "daemon.invalid", "[::1]"])("preserves existing URL host spelling %s", (host) => {
    fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, host, port: 28123 }));
    expect(new DaemonClient().baseUrl).toBe(`http://${host}:28123`);
    expect(getDaemonUrl({ state: "running", host, port: 28123 })).toBe(`http://${host}:28123`);
  });
  it("preserves explicit URL precedence for IPv6", () => {
    fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, host: "::1", port: 28123 }));
    vi.stubEnv("OPENRIG_URL", "http://[::1]:28124");
    expect(new DaemonClient().baseUrl).toBe("http://[::1]:28124");
    expect(new DaemonClient("http://[::1]:28125").baseUrl).toBe("http://[::1]:28125");
  });
});
