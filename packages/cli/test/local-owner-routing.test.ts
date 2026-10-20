import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient, remoteDaemonClient } from "../src/client.js";
import { queueCommand } from "../src/commands/queue.js";
import { sendCommand } from "../src/commands/send.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";
import { allowFetchTarget } from "./fetch-guard.js";

const foreign = { state: "foreign" as const, pid: 42, uid: 502, callerUid: 501 };
let server: http.Server;
let base: string;
let business: string[];
beforeEach(async () => {
  vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
  vi.stubEnv("OPENRIG_SESSION_NAME", ""); vi.stubEnv("RIGGED_SESSION_NAME", "");
  vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "true");
  business = [];
  server = http.createServer((req, res) => {
    if (req.url !== "/healthz") business.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/healthz" ? { pid: 42 } : []));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  allowFetchTarget(base);
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined;
});
function client(state = foreign) {
  // A constructor URL can be an internal status result, not explicit user intent.
  const options = { ownerProbe: vi.fn(async () => state) };
  return { instance: new DaemonClient(base, options), probe: options.ownerProbe };
}
function lifecycle(): LifecycleDeps {
  return {
    exists: () => false, readFile: () => null, isProcessAlive: () => true,
    fetch: async () => ({ ok: true, json: async () => ({ pid: 42 }) }),
  } as unknown as LifecycleDeps;
}
describe("optional local user guard at actual CLI consumers", () => {
  it("foreign owner blocks a business read and write without calling either route", async () => {
    const { instance, probe } = client();
    await expect(instance.get("/api/queue")).rejects.toThrow(/different OS user/);
    await expect(instance.post("/api/transport/send", { text: "fixture" })).rejects.toThrow(/different OS user/);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(business).toEqual([]);
  });
  it("real queue list with a status-derived client sends no business GET", async () => {
    // Select the private port through the existing local configuration precedence.
    vi.stubEnv("OPENRIG_PORT", new URL(base).port);
    const { instance } = client();
    const cmd = new Command().addCommand(queueCommand({ lifecycleDeps: lifecycle(), clientFactory: () => instance }));
    await expect(cmd.parseAsync(["node", "rig", "queue", "list", "--json"])).rejects.toThrow(/different OS user/);
    expect(business).toEqual([]);
  });
  it("real send with a status-derived client sends no transport POST", async () => {
    vi.stubEnv("OPENRIG_PORT", new URL(base).port);
    const { instance } = client();
    const cmd = new Command().addCommand(sendCommand({ lifecycleDeps: lifecycle(), clientFactory: () => instance }));
    await expect(cmd.parseAsync(["node", "rig", "send", "seat@fixture", "harmless"])).rejects.toThrow(/different OS user/);
    expect(business).toEqual([]);
  });
  it.each(["same-user", "unknown"] as const)("real queue and send preserve %s/no-state/custom-port routing", async state => {
    vi.stubEnv("OPENRIG_PORT", new URL(base).port);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const instance = new DaemonClient(base, { ownerProbe: async () => state === "same-user"
      ? { state, pid: 42, uid: 501, callerUid: 501 } : { state, reason: "old_or_missing_health_pid" } });
    const deps = { lifecycleDeps: lifecycle(), clientFactory: () => instance };
    await new Command().addCommand(queueCommand(deps)).parseAsync(["node", "rig", "queue", "list", "--json"]);
    await new Command().addCommand(sendCommand(deps)).parseAsync(["node", "rig", "send", "seat@fixture", "harmless"]);
    expect(business).toHaveLength(2);
    expect(business[0]).toMatch(/^GET \/api\/queue\/list\?/);
    expect(business[1]).toBe("POST /api/transport/send");
    expect(process.exitCode).toBeUndefined();
  });
  it("real send retains its custom endpoint after health timeout and unknown ownership", async () => {
    vi.stubEnv("OPENRIG_PORT", new URL(base).port);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const options = { ownerProbe: async () => ({ state: "unknown" as const, reason: "timeout" }) };
    const deps = lifecycle(); deps.fetch = async () => { throw new Error("fixture health timeout"); };
    const selected: string[] = [];
    await new Command().addCommand(sendCommand({ lifecycleDeps: deps, clientFactory: url => {
      selected.push(url); return new DaemonClient(url, options);
    } })).parseAsync(["node", "rig", "send", "seat@fixture", "harmless"]);
    expect(selected).toEqual([base]);
    expect(business).toEqual(["POST /api/transport/send"]);
  });
  it("defaults off and performs no owner observation", async () => {
    vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "false");
    const { instance, probe } = client();
    await instance.get("/api/queue");
    expect(probe).not.toHaveBeenCalled();
    expect(business).toEqual(["GET /api/queue"]);
  });
  it.each(["same-user", "unknown"] as const)("%s retains the selected endpoint and allows GET and POST", async state => {
    const options = { ownerProbe: async () => ({ state, reason: "fixture" }) };
    const instance = new DaemonClient(base, options);
    await instance.get("/api/queue"); await instance.post("/api/transport/send", {});
    expect(business).toEqual(["GET /api/queue", "POST /api/transport/send"]);
  });
  it("checks again after an earlier same-user response", async () => {
    const probe = vi.fn().mockResolvedValueOnce({ state: "same-user" }).mockResolvedValue(foreign);
    const instance = new DaemonClient(base, { ownerProbe: probe });
    await instance.get("/api/queue");
    await expect(instance.post("/api/transport/send", {})).rejects.toThrow(/different OS user/);
    expect(business).toEqual(["GET /api/queue"]);
  });
  it.each(["OPENRIG_URL", "RIGGED_URL"])("preserves explicit %s intent", async key => {
    vi.stubEnv(key, base);
    const { instance, probe } = client();
    await instance.get("/api/queue");
    expect(probe).not.toHaveBeenCalled(); expect(business).toHaveLength(1);
  });
  it("an environment target does not authorize a different internal endpoint", async () => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
    await expect(client().instance.get("/api/queue")).rejects.toThrow(/different OS user/);
    expect(business).toEqual([]);
  });
  it("preserves registered remote/tunnel intent and diagnostic health reachability", async () => {
    const { instance, probe } = client();
    await instance.get("/healthz");
    expect(probe).not.toHaveBeenCalled();
    await remoteDaemonClient(() => instance, base).get("/api/queue");
    expect(probe).not.toHaveBeenCalled(); expect(business).toHaveLength(1);
  });
});
