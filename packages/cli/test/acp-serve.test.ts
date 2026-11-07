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
import { AUTH_METHOD_ID, serveAcpAgent, type AcpAgentOptions, type TeamConnection, type TeamQueue } from "../src/acp/agent-server.js";
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
  const repo = new QueueRepository(db, bus, { validateRig: (session) => !session.endsWith("@gone-rig") });
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
function connect(overrides: Partial<AcpAgentOptions> = {}, receiver: string | null = LEAD, wrap: (queue: TeamQueue) => TeamQueue = (q) => q) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  ends.push(toAgent);
  const out: string[] = [];
  fromAgent.on("data", (chunk: Buffer) => out.push(chunk.toString()));
  const team: TeamConnection = { queue: wrap(daemonTeamQueue(new DaemonClient(url(), { sessionName: CALLER }))), caller: CALLER, receiver: receiver ?? undefined };
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

  it("a handoff-and-complete passes the work on: the reply is the successor's result, not the first row's done", async () => {
    const { client, updates } = connect({}, "front@team");
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Upgrade the parser"));
    const task = await until(() => rowsTo("front@team")[0], "the front row");
    await move("front@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("front@team", `/api/queue/${task.qitem_id}/handoff-and-complete`, { toSession: "back@team", transitionNote: "back owns the parser", nudge: false });
    expect(db.prepare("SELECT state, closure_reason FROM queue_items WHERE qitem_id = ?").get(task.qitem_id)).toEqual({ state: "done", closure_reason: "handed_off_to" });
    const next = await until(() => rowsTo("back@team")[0], "the back row");
    await move("back@team", `/api/queue/${next.qitem_id}/claim`, {});
    await move("back@team", `/api/queue/${next.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Parser upgraded to 3.2." });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.toolCallId)).toEqual([task.qitem_id, next.qitem_id]);
    expect(messages(updates).at(-1)).toBe(`back@team closed ${next.qitem_id} done.\n\nParser upgraded to 3.2.`);
  });

  it("the reply names the seat that closed the row: not its owner by default, nor one that wrote a note after the close", async () => {
    // A slow poll, so the close and the later note both land before the agent reads the row again.
    const { client, updates } = connect({ pollMs: 500 }, "closer@team");
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Ship the hotfix"));
    const task = await until(() => rowsTo("closer@team")[0], "the row");
    // The lead closes its report's row: the closer is neither the row's owner nor the newest writer.
    await move("closer@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("lead@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Hotfix shipped." });
    await move("watcher@team", `/api/queue/${task.qitem_id}/update`, { transitionNote: "seen, thanks" });
    const notes = db.prepare("SELECT actor_session FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid").all(task.qitem_id) as Array<{ actor_session: string }>;
    expect(notes.at(-1)!.actor_session).toBe("watcher@team");
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(messages(updates).at(-1)).toBe(`lead@team closed ${task.qitem_id} done.\n\nHotfix shipped.`);
  });

  it("a create whose answer is lost but whose row landed carries on with that row", async () => {
    const lostAck = (q: TeamQueue): TeamQueue => ({ ...q, create: async (row) => { await q.create(row); throw new Error("socket hang up"); } });
    const { client, updates } = connect({}, "acked@team", lostAck);
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Rotate the logs"));
    const task = await until(() => rowsTo("acked@team")[0], "the row");
    await move("acked@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("acked@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Rotated." });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(rowsTo("acked@team")).toHaveLength(1);
    expect(messages(updates).at(-1)).toBe(`acked@team closed ${task.qitem_id} done.\n\nRotated.`);
  });

  it("a create that can't be confirmed either way is named as unknown, and the next prompt names it", async () => {
    let readbacks = 0;
    const blind = (q: TeamQueue): TeamQueue => ({
      ...q,
      create: async (row) => { await q.create(row); throw new Error("socket hang up"); },
      find: async (id) => { readbacks += 1; if (readbacks === 1) throw new Error("connect ECONNREFUSED"); return q.find(id); },
    });
    const { client, updates } = connect({}, "unsure@team", blind);
    const sessionId = await open(client);
    const error = await client.request("session/prompt", prompt(sessionId, "Archive March")).then(() => undefined, (e: unknown) => e);
    const first = rowsTo("unsure@team")[0]!;
    expect((error as JsonRpcRequestError).error).toMatchObject({ code: -32603, message: `Couldn't confirm ${first.qitem_id}: socket hang up` });
    expect(messages(updates).at(-1)).toBe(`Sending ${first.qitem_id} to unsure@team got no answer (socket hang up), and it couldn't be read back: delivery is unconfirmed, so it may still reach the team. A new prompt in this session names it, and \`rig queue show ${first.qitem_id}\` shows it if it landed.`);

    const second = client.request("session/prompt", prompt(sessionId, "Archive March, please"));
    const followUp = await until(() => rowsTo("unsure@team")[1], "the follow-up row");
    expect(followUp.body).toContain(`Follows up on ${first.qitem_id} (pending).`);
    expect(messages(updates)).toContain(`${first.qitem_id} is still pending with unsure@team. Sending this as a follow-up.\n\n`);
    client.notify("session/cancel", { sessionId });
    expect(await second).toEqual({ stopReason: "cancelled" });
  });

  it("an unanswered create that isn't found on the immediate readback stays unconfirmed, and is named when it lands late", async () => {
    // The request is still in flight when the agent reads back: it lands only after the readback found nothing.
    let late: (() => Promise<void>) | undefined;
    const slow = (q: TeamQueue): TeamQueue => ({ ...q, create: async (row) => {
      if (late) return q.create(row);
      late = () => q.create(row);
      throw new Error("socket hang up");
    } });
    const { client, updates } = connect({}, "late@team", slow);
    const sessionId = await open(client);
    const error = await client.request("session/prompt", prompt(sessionId, "Tag the release")).then(() => undefined, (e: unknown) => e);
    expect(rowsTo("late@team")).toHaveLength(0);
    const id = /Couldn't confirm (qitem-\S+):/.exec((error as JsonRpcRequestError).error.message)![1]!;
    expect(messages(updates).at(-1)).toBe(`Sending ${id} to late@team got no answer (socket hang up), and it wasn't found on the immediate readback: delivery is unconfirmed, so it may still reach the team. A new prompt in this session names it, and \`rig queue show ${id}\` shows it if it landed.`);

    await late!();
    expect(rowsTo("late@team")[0]!.qitem_id).toBe(id);
    const second = client.request("session/prompt", prompt(sessionId, "Tag the release, please"));
    const followUp = await until(() => rowsTo("late@team")[1], "the follow-up row");
    expect(followUp.body).toContain(`Follows up on ${id} (pending).`);
    client.notify("session/cancel", { sessionId });
    expect(await second).toEqual({ stopReason: "cancelled" });
  });

  it("a create the daemon answers with a refusal is said plainly, and nothing is kept as sent", async () => {
    // A seat whose rig has left the topology can't be sent work: the queue answers with a refusal.
    const { client, updates } = connect({}, "lead@gone-rig");
    const sessionId = await open(client);
    const error = await client.request("session/prompt", prompt(sessionId, "Anything")).then(() => undefined, (e: unknown) => e);
    expect((error as JsonRpcRequestError).error.code).toBe(-32603);
    expect((error as JsonRpcRequestError).error.message).toMatch(/^The team's queue refused the task: HTTP 4\d\d: /);
    expect(rowsTo("lead@gone-rig")).toHaveLength(0);
    expect(messages(updates)).toEqual([]);
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
