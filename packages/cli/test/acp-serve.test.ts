// rig acp serve against the real queue: the daemon's queueRoutes and QueueRepository over a fully migrated test DB, on
// loopback, driven by a scripted ACP client over a stream pair. The team's moves go through the same HTTP routes a seat's
// CLI uses, each as its own seat.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PassThrough } from "node:stream";
import type Database from "better-sqlite3";
import { createFullTestDb } from "../../daemon/test/helpers/test-app.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/client.js";
import { daemonTeamQueue } from "../src/commands/acp.js";
import { AUTH_METHOD_ID, serveAcpAgent, type AcpAgentOptions, type TeamConnection } from "../src/acp/agent-server.js";
import { JsonRpcRequestError, StreamJsonRpcPeer } from "../src/acp/json-rpc-stdio.js";

const CALLER = "human-ada@external";
const LEAD = "lead@team";
const IMPL = "impl@team";
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let port = 0;
const url = () => `http://127.0.0.1:${port}`;
const ambient = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME"].map((key) => [key, process.env[key]] as const);

beforeAll(async () => {
  for (const [key] of ambient) delete process.env[key];
  db = createFullTestDb();
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  await new Promise<void>((resolve) => { server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: { port: number }) => { port = info.port; resolve(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.close();
  for (const [key, value] of ambient) if (value !== undefined) process.env[key] = value;
});

const ends: PassThrough[] = [];
afterEach(() => { for (const end of ends.splice(0)) end.end(); });

/** A scripted ACP client wired to an in-process rig acp serve. */
function connect(overrides: Partial<AcpAgentOptions> = {}, receiver: string | null = LEAD) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  ends.push(toAgent);
  const out: string[] = [];
  fromAgent.on("data", (chunk: Buffer) => out.push(chunk.toString()));
  const team: TeamConnection = { queue: daemonTeamQueue(new DaemonClient(url(), { sessionName: CALLER })), caller: CALLER, receiver: receiver ?? undefined };
  const agent = new StreamJsonRpcPeer(toAgent, fromAgent);
  serveAcpAgent(agent, { connect: async () => team, version: "9.9.9-test", pollMs: 10, closed: agent.closed, ...overrides });
  const client = new StreamJsonRpcPeer(fromAgent, toAgent);
  const updates: Array<Record<string, unknown>> = [];
  client.onNotification("session/update", (params) => updates.push((params as { update: Record<string, unknown> }).update));
  return { client, updates, out };
}

async function open(client: StreamJsonRpcPeer): Promise<string> {
  await client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zed", title: "Zed" } });
  await client.request("authenticate", { methodId: AUTH_METHOD_ID });
  return ((await client.request("session/new", { cwd: "/tmp", mcpServers: [] })) as { sessionId: string }).sessionId;
}

const prompt = (sessionId: string, text: string) => ({ sessionId, prompt: [{ type: "text", text }] });
const seat = (session: string) => new DaemonClient(url(), { sessionName: session });
/** A team seat's move through the queue routes; a refused move fails the test with the daemon's answer. */
async function move(session: string, path: string, body: Record<string, unknown>): Promise<void> {
  const response = await seat(session).post(path, body);
  if (response.status >= 400) throw new Error(`${session} ${path}: HTTP ${response.status} ${JSON.stringify(response.data)}`);
}
const rowsTo = (destination: string) => db.prepare("SELECT qitem_id, source_session, state, body, tags FROM queue_items WHERE destination_session = ? ORDER BY rowid").all(destination) as Array<{ qitem_id: string; source_session: string; state: string; body: string; tags: string }>;
const messages = (updates: Array<Record<string, unknown>>) => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => (u.content as { text: string }).text);

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("rig acp serve", () => {
  it("answers initialize without reaching OpenRig, and offers the one real sign-in method", async () => {
    let connected = 0;
    const { client, out } = connect({ connect: async () => { connected += 1; return { error: "unused" }; } });
    const init = (await client.request("initialize", { protocolVersion: 1, clientCapabilities: { terminal: true } })) as Record<string, any>;
    expect(init.protocolVersion).toBe(1);
    expect(init.authMethods).toEqual([expect.objectContaining({ id: AUTH_METHOD_ID, name: "OpenRig on this machine" })]);
    expect(init.authMethods[0].type).toBeUndefined();
    expect(init.agentInfo).toEqual({ name: "openrig", title: "OpenRig", version: "9.9.9-test" });
    expect(init.agentCapabilities.loadSession).toBe(false);
    expect(connected).toBe(0);
    for (const line of out.join("").split("\n").filter(Boolean)) expect(JSON.parse(line).jsonrpc).toBe("2.0");
  });

  it("sign-in and a new session fail with auth_required and the guidance when OpenRig can't be reached", async () => {
    const { client } = connect({ connect: async () => ({ error: "OpenRig daemon is not running. Start it with: rig daemon start" }) });
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    for (const [method, params] of [["authenticate", { methodId: AUTH_METHOD_ID }], ["session/new", { cwd: "/tmp", mcpServers: [] }]] as const) {
      const error = await client.request(method, params).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(JsonRpcRequestError);
      expect((error as JsonRpcRequestError).error).toEqual({ code: -32000, message: "OpenRig daemon is not running. Start it with: rig daemon start" });
    }
    const unknown = await client.request("authenticate", { methodId: "api-key" }).then(() => undefined, (e: unknown) => e);
    expect((unknown as JsonRpcRequestError).error.code).toBe(-32602);
  });

  it("a prompt becomes the caller's row to the receiver; handoffs and notes come back attributed; the resolution is the reply", async () => {
    const { client, updates } = connect();
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Please fix the login bug\nIt fails on Safari."));

    const task = await until(() => rowsTo(LEAD)[0], "the row to the lead");
    expect(task.source_session).toBe(CALLER);
    expect(task.state).toBe("pending");
    expect(task.body).toMatch(/^Please fix the login bug\nIt fails on Safari\.\n\n---\nSent by human-ada@external from Zed through rig acp serve \(session acps-/);
    expect(task.body).toContain("close it with a resolution written for human-ada@external");
    expect(JSON.parse(task.tags)).toEqual(["acp-serve", `acp-session:${sessionId}`]);

    await move(LEAD, `/api/queue/${task.qitem_id}/claim`, {});
    await move(LEAD, `/api/queue/${task.qitem_id}/update`, { state: "in-progress", transitionNote: "reproduced on Safari 19" });
    await move(LEAD, `/api/queue/${task.qitem_id}/handoff`, { toSession: IMPL, transitionNote: "impl owns the auth code", nudge: false });
    const next = await until(() => rowsTo(IMPL)[0], "the impl row");
    await move(IMPL, `/api/queue/${next.qitem_id}/claim`, {});
    await move(IMPL, `/api/queue/${next.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Fixed in PR 123: the cookie lacked SameSite=None." });

    expect(await turn).toEqual({ stopReason: "end_turn" });
    const calls = updates.filter((u) => u.sessionUpdate === "tool_call");
    expect(calls.map((u) => [u.toolCallId, u.title])).toEqual([
      [task.qitem_id, `Sent to ${LEAD} (${task.qitem_id})`],
      [next.qitem_id, `Handed to ${IMPL} (${next.qitem_id})`],
    ]);
    const lastOf = (id: string) => updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === id).at(-1)!;
    expect(lastOf(task.qitem_id).status).toBe("completed");
    const leadLines = ((lastOf(task.qitem_id).content as Array<{ content: { text: string } }>)[0]!.content.text);
    expect(leadLines).toMatch(/Z lead@team · in-progress: reproduced on Safari 19/);
    expect(lastOf(next.qitem_id).status).toBe("completed");
    expect(messages(updates).at(-1)).toBe(`${IMPL} closed ${next.qitem_id} done.\n\nFixed in PR 123: the cookie lacked SameSite=None.`);
  });

  it("cancel stops waiting, never the work; the next prompt is a follow-up that names the open item", async () => {
    const { client, updates } = connect({}, "solo@team");
    const sessionId = await open(client);
    const first = client.request("session/prompt", prompt(sessionId, "Draft the release notes"));
    const row = await until(() => rowsTo("solo@team")[0], "the first row");
    client.notify("session/cancel", { sessionId });
    expect(await first).toEqual({ stopReason: "cancelled" });
    expect(messages(updates).at(-1)).toBe(`Stopped waiting. ${row.qitem_id} is still pending with solo@team: cancelling here doesn't stop the team's work. A new prompt in this session goes to the team as a follow-up and shows where this stands.`);
    expect(rowsTo("solo@team")[0]!.state).toBe("pending");

    const second = client.request("session/prompt", prompt(sessionId, "Also mention the Safari fix"));
    const followUp = await until(() => rowsTo("solo@team")[1], "the follow-up row");
    expect(followUp.body).toContain(`Follows up on ${row.qitem_id} (pending).`);
    expect(messages(updates)).toContain(`${row.qitem_id} is still pending with solo@team. Sending this as a follow-up.\n\n`);
    await move("solo@team", `/api/queue/${followUp.qitem_id}/claim`, {});
    await move("solo@team", `/api/queue/${followUp.qitem_id}/update`, { state: "done", closureReason: "canceled", resolution: "Needs the first item first." });
    expect(await second).toEqual({ stopReason: "end_turn" });
    expect(messages(updates).at(-1)).toBe(`solo@team closed ${followUp.qitem_id} done (canceled).\n\nNeeds the first item first.`);
  });

  it("with no receiver configured, a prompt sends nothing and says how to set one", async () => {
    const { client, updates } = connect({}, null);
    const sessionId = await open(client);
    const before = (db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(await client.request("session/prompt", prompt(sessionId, "anything"))).toEqual({ stopReason: "end_turn" });
    expect((db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number }).n).toBe(before);
    expect(messages(updates).at(-1)).toContain("Add `--to <member@rig>`");
  });

  it("an unknown method gets JSON-RPC's method-not-found", async () => {
    const { client } = connect();
    const error = await client.request("session/fork", { sessionId: "x" }).then(() => undefined, (e: unknown) => e);
    expect((error as JsonRpcRequestError).error).toEqual({ code: -32601, message: "Method not found: session/fork" });
  });
});
