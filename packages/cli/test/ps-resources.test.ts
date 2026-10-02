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
  const response = await client.get<{ cpuCount: number; runningSeats: number; capture: { rotatingSeats: number } }>("/api/ps/resources");
  expect(response.status).toBe(200);
  expect(response.data.runningSeats).toBe(1);
  expect(response.data.cpuCount).toBeGreaterThan(0);
  expect(response.data.capture.rotatingSeats).toBe(0);
});

it("renders both native HTTP JSON and explicit human resource semantics", async () => {
  const { command } = await fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps", "--resources", "--json"]);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ runningSeats: 1 });
  log.mockClear();
  await command.parseAsync(["node", "rig", "ps", "--resources"]);
  expect(log.mock.calls.flat().join("\n")).toContain(process.platform === "win32" ? "unavailable on this platform" : "not CPU utilization");
  expect(log.mock.calls.flat().join("\n")).toContain("not daemon CPU time");
});
