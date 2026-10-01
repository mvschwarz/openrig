import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, remoteDaemonClient } from "../src/client.js";
import { proofCommand } from "../src/commands/proof.js";
import { parkedCommand } from "../src/commands/parked.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

describe("default client endpoint selection", () => {
  let root: string;
  let home: string;
  const servers: http.Server[] = [];
  const fallback = "http://configured.invalid:28123";
  const state = (port = 27451, extra = {}) => ({ pid: process.pid, port, host: "127.0.0.1", ...extra });
  const writeState = (value: unknown, target = home) => fs.writeFileSync(path.join(target, "daemon.json"), JSON.stringify(value));
  const configure = (target = home) => fs.writeFileSync(path.join(target, "config.json"), JSON.stringify({ daemon: { host: "configured.invalid", port: 28123 } }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "client-endpoint-"));
    home = path.join(root, "a");
    fs.mkdirSync(home);
    for (const key of ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_HOST", "RIGGED_HOST", "OPENRIG_PORT", "RIGGED_PORT", "RIGGED_HOME", "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME", "OPENRIG_TERMINAL_BEARER_TOKEN"]) vi.stubEnv(key, undefined);
    vi.stubEnv("OPENRIG_HOME", home);
    configure();
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
    vi.restoreAllMocks();
    resetFetchAllowlist();
    vi.unstubAllEnvs();
    process.exitCode = 0;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the actual live-home endpoint ahead of configured startup defaults without rewriting either file", () => {
    writeState(state());
    const before = fs.readFileSync(path.join(home, "daemon.json"));
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
    expect(fs.readFileSync(path.join(home, "daemon.json"))).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).daemon.port).toBe(28123);
  });

  it("preserves explicit baseUrl, primary URL and legacy URL precedence over state", () => {
    writeState(state());
    vi.stubEnv("RIGGED_URL", "http://legacy.invalid:28001");
    expect(new DaemonClient().baseUrl).toBe("http://legacy.invalid:28001");
    vi.stubEnv("OPENRIG_URL", "http://explicit.invalid:28002");
    expect(new DaemonClient().baseUrl).toBe("http://explicit.invalid:28002");
    expect(new DaemonClient("http://argument.invalid:28003").baseUrl).toBe("http://argument.invalid:28003");
  });

  it("uses host/port config and its env overrides when no state exists", () => {
    expect(new DaemonClient().baseUrl).toBe(fallback);
    vi.stubEnv("OPENRIG_HOST", "env.invalid");
    vi.stubEnv("OPENRIG_PORT", "28004");
    expect(new DaemonClient().baseUrl).toBe("http://env.invalid:28004");
    vi.stubEnv("OPENRIG_HOST", undefined);
    vi.stubEnv("OPENRIG_PORT", undefined);
    vi.stubEnv("RIGGED_HOST", "legacy-config.invalid");
    vi.stubEnv("RIGGED_PORT", "28005");
    expect(new DaemonClient().baseUrl).toBe("http://legacy-config.invalid:28005");
  });

  it("uses the existing default when both state and config are absent (no network request)", () => {
    fs.unlinkSync(path.join(home, "config.json"));
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:7433");
  });

  it("keeps a live endpoint when startup host/port configuration changes", () => {
    writeState(state());
    vi.stubEnv("OPENRIG_PORT", "28004");
    vi.stubEnv("OPENRIG_HOST", "future.invalid");
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
  });

  it("falls back on a dead PID without removing the state", () => {
    writeState(state());
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(new DaemonClient().baseUrl).toBe(fallback);
    expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(true);
  });

  it("does not mistake a permission-denied liveness check for a dead endpoint", () => {
    writeState(state());
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
  });

  it.each([null, [], {}, { pid: -1, port: 27451 }, { pid: "12", port: 27451 }, { pid: process.pid, port: "27451" }, { pid: process.pid, port: 0 }, { pid: process.pid, port: 65536 }, { pid: process.pid, port: 1.5 }, { pid: process.pid, port: 27451, host: 12 }])("falls back on unusable state shape: %j", value => {
    writeState(value);
    expect(new DaemonClient().baseUrl).toBe(fallback);
  });

  it("falls back on malformed JSON", () => {
    fs.writeFileSync(path.join(home, "daemon.json"), "{");
    expect(new DaemonClient().baseUrl).toBe(fallback);
  });

  it("supports old state without a host and honors a persisted custom host", () => {
    writeState({ pid: process.pid, port: 27451 });
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
    writeState(state(27451, { host: "custom.invalid" }));
    expect(new DaemonClient().baseUrl).toBe("http://custom.invalid:27451");
  });

  it("resolves home per construction, accepts RIGGED_HOME, and never discovers a sibling", () => {
    writeState(state());
    const first = new DaemonClient();
    const other = path.join(root, "b");
    fs.mkdirSync(other);
    configure(other);
    vi.stubEnv("OPENRIG_HOME", other);
    expect(new DaemonClient().baseUrl).toBe(fallback);
    writeState(state(27452), other);
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27452");
    expect(first.baseUrl).toBe("http://127.0.0.1:27451");
    vi.stubEnv("OPENRIG_HOME", undefined);
    vi.stubEnv("RIGGED_HOME", home);
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:27451");
  });

  it("preserves remote destination and origin identity while local state exists", async () => {
    writeState(state());
    vi.stubEnv("OPENRIG_SESSION_NAME", "author@fixture");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}"));
    const client = remoteDaemonClient(url => new DaemonClient(url, { fetchImpl }), "http://remote.invalid:28006", "origin-fixture");
    await client.post("/api/proof/judge", { fixture: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual(["http://remote.invalid:28006/api/proof/judge", expect.objectContaining({ headers: expect.objectContaining({ "X-OpenRig-Session": "author@fixture@origin-fixture" }) })]);
  });

  it("routes actual proof reads, intercepted judgments and parked to each selected home's server", async () => {
    const received: Array<{ server: string; method: string; url: string; body: unknown; sender?: string }> = [];
    const start = async (name: string, port: number) => {
      const server = http.createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        received.push({ server: name, method: req.method!, url: req.url!, body: text ? JSON.parse(text) : null, sender: req.headers["x-openrig-session"] as string | undefined });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url?.startsWith("/api/proof?")
          ? { items: [{ id: "fixture-item", index: 1, text: "fixture", revision: "r1", judgment: null }] }
          : { ok: true, fixture: name }));
      });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      servers.push(server);
      const actualPort = (server.address() as { port: number }).port;
      allowFetchTarget(`http://127.0.0.1:${actualPort}`);
      return actualPort;
    };
    const a = await start("A", Number(process.env.F1_SERVER_A_PORT ?? 0));
    const b = await start("B", Number(process.env.F1_SERVER_B_PORT ?? 0));
    const other = path.join(root, "b"); fs.mkdirSync(other);
    writeState(state(a)); writeState(state(b), other);
    // Deliberately conflicting startup config exposes a wrong-home write on the old client.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { host: "127.0.0.1", port: b } }));
    fs.writeFileSync(path.join(other, "config.json"), JSON.stringify({ daemon: { host: "127.0.0.1", port: a } }));
    vi.stubEnv("OPENRIG_SESSION_NAME", "author@fixture");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const selected: string[] = [];
    for (const target of [home, other]) {
      vi.stubEnv("OPENRIG_HOME", target);
      selected.push(new DaemonClient().baseUrl);
      await proofCommand().parseAsync(["show", "fixture", "--json"], { from: "user" });
      await proofCommand().parseAsync(["judge", "fixture#1", "--verdict", "accept", "--reason", "routing fixture only", "--json"], { from: "user" });
      await parkedCommand().parseAsync(["author@fixture", "--json"], { from: "user" });
      expect(process.exitCode ?? 0).toBe(0);
    }
    process.stdout.write(`F1 routing receipt ${JSON.stringify({ endpoints: { A: a, B: b }, selected, received })}\n`);
    expect(selected).toEqual([`http://127.0.0.1:${a}`, `http://127.0.0.1:${b}`]);
    expect(received.map(r => [r.server, r.method, r.url])).toEqual(["A", "B"].flatMap(name => [
      [name, "GET", "/api/proof?scope=fixture"], [name, "GET", "/api/proof?scope=fixture"],
      [name, "POST", "/api/proof/judge"], [name, "GET", "/api/activity/parked?seat=author%40fixture"],
    ]));
    expect(received.filter(r => r.method === "POST").map(r => r.body)).toEqual(["A", "B"].map(() => expect.objectContaining({ item: "fixture-item", expectedRevision: "r1", verdict: "accept" })));
    expect(received.every(r => r.sender === "author@fixture")).toBe(true);
  });
});
