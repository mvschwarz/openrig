// The MCP queue tools against the daemon's real queue routes, over HTTP, through the real DaemonClient: a seat
// configured once (OPENRIG_SESSION_NAME in the MCP server's env) hands a task to another seat and reads the
// answer back by the task's id. Nothing in the tool calls names the sender.
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
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

const DESK = "desk@team";
const IMPL = "impl@team";

describe("MCP queue tools on the daemon's queue routes", () => {
  let db: Database.Database;
  let home: string;
  let server: ServerType;
  let url: string;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    // Every migration, as an installed daemon has: the queue routes read columns the reduced test schema lacks.
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-queue-"));
    process.env.OPENRIG_HOME = home;
    const inert = async () => ({ ok: false, error: "inert fixture" });
    const { app } = createTestApp(db, {
      appDeps: {
        sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
        queueRepo: new QueueRepository(db, new EventBus(db), { validateRig: () => true }),
      },
    });
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

  /** An MCP connection whose server runs as `seat`, the way a desktop app's MCP entry sets it once. */
  async function connectAs(seat: string) {
    const mcp = createMcpServer(new DaemonClient(url));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: seat, version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await mcp.close(); });
    return async (name: string, args: Record<string, unknown>) => {
      // The env is read per request at DaemonClient's one stamping point, as in a server process of its own.
      process.env.OPENRIG_SESSION_NAME = seat;
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, data: JSON.parse((result.content as Array<{ text: string }>)[0]!.text), structured: result.structuredContent };
    };
  }

  it("delegates a task and reads the assignee's answer back by its id, under each seat's configured identity", async () => {
    const desk = await connectAs(DESK);
    const impl = await connectAs(IMPL);

    const created = await desk("rig_queue_create", { destination: IMPL, body: "Summarise the failing test.", summary: "summarise failure" });
    expect(created.isError).toBe(false);
    const qitemId = created.data.qitemId as string;
    expect(qitemId).toMatch(/^qitem-/);

    const owned = await impl("rig_queue_list", { owned: true });
    expect(JSON.stringify(owned.data)).toContain(qitemId);
    expect((await impl("rig_queue_claim", { qitemId })).isError).toBe(false);
    expect((await impl("rig_queue_update", { qitemId, state: "done", closureReason: "no-follow-on", note: "ANSWER: the fixture path is stale." })).isError).toBe(false);

    const shown = await desk("rig_queue_show", { qitemId });
    expect(shown.isError).toBe(false);
    expect(shown.data.item).toMatchObject({ qitemId, sourceSession: expect.stringMatching(/^desk@team/), destinationSession: IMPL });
    const transitions = JSON.stringify(shown.data.transitions);
    expect(transitions).toContain("ANSWER: the fixture path is stale.");
    expect(transitions).toContain("transport:v1");
    expect(transitions).toContain(IMPL);

    const mine = await desk("rig_queue_list", { mine: true, all: true });
    expect(JSON.stringify(mine.data)).toContain(qitemId);
  });

  it("keeps the assignee's answer as the item's resolution, reopens the item only deliberately, and names queue errors by their code", async () => {
    const desk = await connectAs(DESK);
    const impl = await connectAs(IMPL);
    const qitemId = (await desk("rig_queue_create", { destination: IMPL, body: "Name the stale fixture." })).data.qitemId as string;
    expect((await impl("rig_queue_claim", { qitemId })).isError).toBe(false);
    expect((await impl("rig_queue_update", { qitemId, state: "done", closureReason: "no-follow-on", resolution: "ANSWER: fixtures/old.json" })).isError).toBe(false);

    const closed = await desk("rig_queue_show", { qitemId });
    expect(closed.data.item).toMatchObject({ state: "done", resolution: "ANSWER: fixtures/old.json" });

    // Moving a closed item back takes reopen and a note; without reopen the daemon refuses it.
    const refused = await impl("rig_queue_update", { qitemId, state: "pending", note: "one more detail" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toContain("terminal_reopen_requires_ack");
    // The queue answers { error: <code>, message: <how to fix it> }: the structured result keeps both.
    expect(refused.data.message).toEqual(expect.stringMatching(/\S/));
    expect(refused.structured).toEqual({ ok: false, code: "terminal_reopen_requires_ack", message: refused.data.message, status: 409 });
    expect((await desk("rig_queue_show", { qitemId: "qitem-not-here" })).structured).toMatchObject({ ok: false, code: "qitem_not_found", status: 404 });
    expect((await impl("rig_queue_update", { qitemId, state: "pending", reopen: true, note: "one more detail" })).isError).toBe(false);
    expect((await desk("rig_queue_show", { qitemId })).data.item).toMatchObject({ state: "pending" });
  });

  it("records the configured seat as the source even when nothing else names it", async () => {
    const desk = await connectAs(DESK);
    const created = await desk("rig_queue_create", { destination: IMPL, body: "fixture" });
    const row = db.prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?").get(created.data.qitemId) as { source_session: string };
    expect(row.source_session).toMatch(/^desk@team/);
  });
});
