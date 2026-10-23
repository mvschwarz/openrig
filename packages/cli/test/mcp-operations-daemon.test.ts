// The MCP server's operation table against the daemon itself: every registered tool named once, each tool's hints matching
// its effect, every route the table names mounted in the daemon's app, and the newest reads answering through their real
// routes with the shared error shape.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer, MCP_OPERATIONS } from "../src/mcp-server.js";

const HINTS = {
  read: { readOnlyHint: true },
  additive: { readOnlyHint: false, destructiveHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true },
} as const;
/** Route parameters compared by position: `:qitemId` and `:id` are the same slot. */
const shape = (route: string) => route.replace(/:[^/]+/g, ":");

describe("MCP operation table against the daemon", () => {
  let db: Database.Database;
  let home: string;
  let server: ServerType;
  let url: string;
  let routes: Array<{ method: string; path: string }>;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ops-"));
    process.env.OPENRIG_HOME = home;
    const { app } = createTestApp(db);
    routes = app.routes;
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  async function connect() {
    const mcp = createMcpServer(new DaemonClient(url));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "operations", version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await mcp.close(); });
    return client;
  }

  it("names every registered tool once, with hints that match each tool's effect", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(MCP_OPERATIONS.map((op) => op.tool).sort()).toEqual(tools.map((tool) => tool.name).sort());
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    for (const op of MCP_OPERATIONS) {
      expect(hints[op.tool], op.tool).toEqual(HINTS[op.effect]);
    }
  });

  it("mounts every route the table names in the daemon", () => {
    const mounted = new Set(routes.map((route) => `${route.method} ${shape(route.path)}`));
    for (const route of [...MCP_OPERATIONS.flatMap((op) => op.routes), "GET /api/rigs/summary"]) {
      const [method, routePath] = route.split(" ");
      expect(mounted.has(`${method} ${shape(routePath!)}`), route).toBe(true);
    }
  });

  it("answers rig_whoami and rig_restore_status through their real routes, with the shared error shape", async () => {
    process.env.OPENRIG_SESSION_NAME = "nobody@no-rig";
    const client = await connect();

    // The route reads the seat from ?sessionName=: a seat it doesn't manage answers 404 (a missing query would be 400).
    const who = await client.callTool({ name: "rig_whoami", arguments: {} });
    expect(who.isError).toBe(true);
    expect(who.structuredContent).toMatchObject({ ok: false, code: "http_404", status: 404 });
    expect((who.structuredContent as { message: string }).message).toContain("nobody@no-rig");

    const attempt = await client.callTool({ name: "rig_restore_status", arguments: { rigId: "01RIGNOTHERE", attemptId: 1 } });
    expect(attempt.isError).toBe(true);
    expect(attempt.structuredContent).toMatchObject({ ok: false, code: "attempt_not_found", status: 404 });
  });
});
