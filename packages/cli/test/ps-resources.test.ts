import { afterEach, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import { psRoutes } from "../../daemon/src/routes/ps.js";
import { PsProjectionService } from "../../daemon/src/domain/ps-projection.js";
import { createFullTestDb } from "../../daemon/test/helpers/test-app.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); });

async function fixture() {
  const db = createFullTestDb();
  db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'fixture')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n', 'r', 'builder')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s', 'n', 'fixture-builder', 'running')").run();
  db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES ('archived', 'archived-fixture', datetime('now'))").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('archived-n', 'archived', 'builder')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('archived-s', 'archived-n', 'archived-builder', 'running')").run();
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("psProjectionService" as never, new PsProjectionService({ db }) as never); await next(); });
  app.route("/api/ps", psRoutes);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as { port: number }).port;
  close = () => new Promise<void>((resolve, reject) => { server.close((err) => { db.close(); err ? reject(err) : resolve(); }); });
  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  const deps = { clientFactory: () => client, lifecycleDeps: {
    exists: (p: string) => p === STATE_FILE,
    readFile: () => JSON.stringify({ pid: 123, port, db: "fixture.sqlite", startedAt: new Date().toISOString() }),
    fetch: async () => ({ ok: true }), isProcessAlive: () => true,
    spawn: vi.fn(), kill: vi.fn(), writeFile: vi.fn(), removeFile: vi.fn(), mkdirp: vi.fn(), openForAppend: vi.fn(),
  } };
  const command = new Command().addCommand(psCommand(deps as never));
  return { client, command };
}

it("serves running-seat/load measurements without changing the ordinary bare-array projection", async () => {
  const { client } = await fixture();
  const normal = await client.get<unknown>("/api/ps");
  expect(Array.isArray(normal.data)).toBe(true);
  expect(normal.data).toHaveLength(1);
  const response = await client.get<{ cpuCount: number; runningSeats: number; capture: { rotatingSeats: number; maxIdleIntervalMs: number | null } }>("/api/ps/resources");
  expect(response.status).toBe(200);
  expect(response.data.runningSeats).toBe(2);
  expect(response.data.cpuCount).toBeGreaterThan(0);
  expect(response.data.capture.rotatingSeats).toBe(0);
  expect(response.data.capture.maxIdleIntervalMs).toBeNull();
});

it("renders both native HTTP JSON and explicit human resource semantics", async () => {
  const { command } = await fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps", "--resources", "--json"]);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ runningSeats: 2 });
  log.mockClear();
  await command.parseAsync(["node", "rig", "ps", "--resources"]);
  expect(log.mock.calls.flat().join("\n")).toContain(process.platform === "win32" ? "unavailable on this platform" : "not CPU utilization");
  expect(log.mock.calls.flat().join("\n")).toContain("not daemon CPU time");
  expect(log.mock.calls.flat().join("\n")).toContain("unavailable ms idle ceiling");
  expect(log.mock.calls.flat().join("\n")).not.toContain("0 ms idle ceiling");
});

async function remoteFixture(status: 200 | 401 | 403 | 404 | 429 | 500) {
  vi.stubEnv("OPENRIG_RESOURCE_TEST_BEARER", "public-fixture-token");
  let authorization: string | undefined;
  const app = new Hono();
  app.get("/api/ps/resources", (c) => {
    authorization = c.req.header("authorization");
    if (status === 200) return c.json({ cpuCount: 4, runningSeats: 2, loadAverage: null, loadPerCpu: null,
      capture: { rotatingSeats: 2, idleSeats: 1, captures: 4, failures: 0, capturedBytes: 100,
        captureDurationMs: 10, activeIntervalMs: 2000, maxIdleIntervalMs: 6000, lines: 1000 } });
    return c.json({ error: "fixture failure" }, status);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as { port: number }).port;
  close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const command = new Command().addCommand(psCommand({
    clientFactory: (url) => new DaemonClient(url),
    lifecycleDeps: { exists: () => false, readFile: () => null } as never,
    hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "fixture-host", transport: "http", url: `http://127.0.0.1:${port}`, bearer_env: "OPENRIG_RESOURCE_TEST_BEARER" }] } }),
  }));
  return { command, authorization: () => authorization };
}

it("names the registered remote host in successful human resource output", async () => {
  const { command } = await remoteFixture(200);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources"]);
  expect(log.mock.calls[0]![0]).toBe("Host: fixture-host · 4 available CPUs · 2 running seats");
  expect(log.mock.calls.flat().join("\n")).toContain("6000 ms idle ceiling");
});

it.each([401, 403, 429, 500] as const)("preserves remote resource HTTP %s JSON classification and exit status through actual bearer transport", async (status) => {
  const { command, authorization } = await remoteFixture(status);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources", "--json"]);
    expect(authorization()).toBe("Bearer public-fixture-token");
    expect(process.exitCode).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      ok: false, cross_host: { host: "fixture-host" },
      failedStep: status === 401 || status === 403 ? "permission-gate" : "remote-command-failed",
      error: `HTTP ${status}`,
    });
  } finally { process.exitCode = previousExitCode; vi.unstubAllEnvs(); }
});

it("names the remote host for a human permission failure", async () => {
  const { command } = await remoteFixture(403);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources"]);
    expect(process.exitCode).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("cross-host (host=fixture-host): HTTP 403");
  } finally { process.exitCode = previousExitCode; vi.unstubAllEnvs(); }
});

it.each([false, true])("retains the older-daemon HTTP404 diagnostic and exit2 with json=%s", async (json) => {
  const { command } = await remoteFixture(404);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await command.parseAsync(["node", "rig", "ps", "--host", "fixture-host", "--resources", ...(json ? ["--json"] : [])]);
    expect(process.exitCode).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Host resource measurements unavailable (HTTP 404); this host may need a newer daemon.");
  } finally { process.exitCode = previousExitCode; vi.unstubAllEnvs(); }
});
