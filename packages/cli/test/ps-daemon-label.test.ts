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

/** Serves /api/ps over a fresh test db. activeRigs=0 yields a daemon whose
 *  only rig is archived — the "No active rigs" empty-fleet shape. */
async function fixture(activeRigs = 1) {
  const db = createFullTestDb();
  if (activeRigs > 0) {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'fixture')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n', 'r', 'builder')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s', 'n', 'fixture-builder', 'running')").run();
  }
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
  return { baseUrl: `http://127.0.0.1:${port}`, command };
}

it("names the daemon on the rollup line when rigs are listed", async () => {
  const { baseUrl, command } = await fixture(1);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps"]);
  const rollup = log.mock.calls.flat().find((l) => /needs? attention/.test(String(l)));
  expect(rollup).toBeDefined();
  expect(String(rollup)).toMatch(/1 rig · 1 seat · 0 need attention · daemon http:\/\/127\.0\.0\.1:\d+$/);
  expect(String(rollup)).toContain(`daemon ${baseUrl}`);
});

it("names the daemon on the empty-fleet lines — the wrong-daemon trap case", async () => {
  const { baseUrl, command } = await fixture(0);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps"]);
  const lines = log.mock.calls.flat().map(String).join("\n");
  expect(lines).toContain(`No active rigs · 1 archived (rig ps --include-archived) · daemon ${baseUrl}`);
});

it("names the daemon on the filter-miss line", async () => {
  const { baseUrl, command } = await fixture(1);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await command.parseAsync(["node", "rig", "ps", "--filter", "lifecycleState=attention_required"]);
  const miss = log.mock.calls.flat().find((l) => String(l).startsWith("No rigs match"));
  expect(String(miss)).toContain(`daemon ${baseUrl}`);
});
