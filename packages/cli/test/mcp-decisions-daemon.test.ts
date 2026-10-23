// The MCP decision tools against the daemon's real gateway and queue routes, over HTTP: the seat that asked a person reads
// the decision room of the mode they have on and records a decision beside their answers, never as one. A person's own
// answer isn't written by any MCP tool.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { addHumanFragment, loadHumanRegistry } from "../../daemon/src/domain/gateway/human-registry.js";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

const DESIGNER = "designer@team";
const questions = [{ id: "design", question: "Which design?", options: [{ id: "a", label: "Layout A" }, { id: "b", label: "Layout B" }] }];

describe("MCP decision tools on the daemon's gateway and queue routes", () => {
  let db: Database.Database;
  let home: string;
  let repo: QueueRepository;
  let server: ServerType;
  let url: string;
  const closers: Array<() => Promise<void>> = [];
  const saved = process.env.OPENRIG_SESSION_NAME;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-decide-"));
    expect(addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external", prefs: { deliveryClass: "B" },
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: "U-ALEX" }] }, home).ok).toBe(true);
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home) });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("db" as never, db as never); c.set("queueRepo" as never, repo as never); await next(); });
    app.route("/api/gateway", gatewayRoutes({ home }));
    app.route("/api/queue", queueRoutes());
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
    if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved;
  });

  async function connectAs(seat: string) {
    const mcp = createMcpServer(new DaemonClient(url));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: seat, version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await mcp.close(); });
    return async (name: string, args: Record<string, unknown>) => {
      process.env.OPENRIG_SESSION_NAME = seat;
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, structured: result.structuredContent as Record<string, any> };
    };
  }

  /** The person turns a mode on, with or without a decision room, through the gateway's own routes. */
  async function modeOn(withRoom: boolean) {
    const call = (method: string, route: string, body: unknown) => fetch(`${url}${route}`, {
      method, headers: { "Content-Type": "application/json", "X-OpenRig-Session": "operator@kernel" }, body: JSON.stringify(body) });
    await call("PUT", "/api/gateway/human/alex/modes/asleep", { availability: "away", ...(withRoom ? { decisionRoom: "decide design choices you'd normally ask me", exclusions: ["spending"] } : {}) });
    expect((await call("POST", "/api/gateway/human/alex/modes/asleep/apply", {})).status).toBe(200);
  }

  const ask = async () => (await repo.create({ sourceSession: DESIGNER, destinationSession: "alex@external", summary: "Landing page layout",
    body: "Pick a layout.", humanIntent: "decision", humanQuestions: questions, nudge: false } as never)).qitemId;

  it("records a decision inside the person's room, beside their answers, and only for the seat that asked", async () => {
    const designer = await connectAs(DESIGNER);
    const other = await connectAs("other@team");
    const qitemId = await ask();

    // At their desk there's no room: nothing is decided for them, and the ask stays theirs.
    const atDesk = await designer("rig_human_decision_room", { qitemId });
    expect(atDesk.structured).toMatchObject({ qitemId, entityId: "alex", decisionRoom: null });
    const choose = { qitemId, applicationId: "none", choices: [{ questionId: "design", chosen: "a" }], reason: "A is ready", reversible: true };
    expect((await designer("rig_queue_decide", choose)).structured).toMatchObject({ ok: false, code: "no-active-mode", status: 409 });

    await modeOn(true);
    const room = (await designer("rig_human_decision_room", { qitemId })).structured.decisionRoom as Record<string, any>;
    expect(room).toMatchObject({ modeName: "asleep", words: "decide design choices you'd normally ask me", exclusions: ["spending"] });

    expect((await other("rig_queue_decide", { ...choose, applicationId: room.applicationId })).structured).toMatchObject({ ok: false, code: "not-the-asking-agent", status: 409 });
    const decided = await designer("rig_queue_decide", { ...choose, applicationId: room.applicationId });
    expect(decided.isError).toBe(false);
    expect(decided.structured.item).toMatchObject({ state: "done", humanAnswers: null,
      delegatedDecision: { applicationId: room.applicationId, decidedBy: DESIGNER, reversible: true, choices: [expect.objectContaining({ questionId: "design", chosen: "a" })] } });
    expect(repo.getById(qitemId)).toMatchObject({ humanAnswers: null });
  });

  it("decides nothing when the person's mode gives no room", async () => {
    const designer = await connectAs(DESIGNER);
    const qitemId = await ask();
    await modeOn(false);
    const read = await designer("rig_human_decision_room", { qitemId });
    expect(read.structured).toMatchObject({ decisionRoom: null, modeName: "asleep" });
    expect(read.structured.why).toContain("no decision room");
    const refused = await designer("rig_queue_decide", { qitemId, applicationId: "any", choices: [{ questionId: "design", chosen: "a" }], reason: "A is ready", reversible: true });
    expect(refused.structured).toMatchObject({ ok: false, code: "no-decision-room", status: 409 });
    expect(repo.getById(qitemId)).toMatchObject({ state: "pending", humanAnswers: null, delegatedDecision: null });
  });
});
