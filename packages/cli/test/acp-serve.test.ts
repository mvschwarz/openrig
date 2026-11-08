// rig acp serve against the real queue: the daemon's queue and answer routes over a database with every migration, on
// loopback, driven by a scripted ACP client over a stream pair. The team's moves go through the same HTTP routes a seat's
// CLI uses, each as its own seat.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { missionControlRoutes } from "../../daemon/src/routes/mission-control.js";
import { MissionControlWriteContract } from "../../daemon/src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../../daemon/src/domain/mission-control/mission-control-action-log.js";
import { DaemonClient } from "../src/client.js";
import { daemonTeamQueue, unregisteredPersonNotice } from "../src/commands/acp.js";
import { addHumanFragment } from "../../daemon/src/domain/gateway/human-registry.js";
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
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  // The caller is a registered person, so the team's asks reach them and their answers record as theirs.
  const registry = { ok: true as const, entities: [{ entityId: "human-ada", class: "human" as const, displayName: "Ada", address: CALLER, connectorBindings: [],
    prefs: { deliveryClass: "B" as const, availability: "available" as const } }] };
  const repo = new QueueRepository(db, bus, { validateRig: (session) => !session.endsWith("@gone-rig"), loadHumanRegistry: () => registry as never });
  const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); c.set("missionControlWriteContract" as never, writeContract as never);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  app.route("/api/mission-control", missionControlRoutes());
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
  const inbound: Array<Record<string, any>> = [];
  const client = new StreamJsonRpcPeer(fromAgent, toAgent, (direction, packet) => { if (direction === "in") inbound.push(packet as Record<string, any>); });
  const updates: Array<Record<string, unknown>> = [];
  client.onNotification("session/update", (params) => updates.push((params as { update: Record<string, unknown> }).update));
  return { client, updates, out, inbound };
}

async function open(client: StreamJsonRpcPeer, clientCapabilities: Record<string, unknown> = {}): Promise<string> {
  await client.request("initialize", { protocolVersion: 1, clientCapabilities, clientInfo: { name: "zed", title: "Zed" } });
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
    expect(init.agentCapabilities.loadSession).toBe(true);
    expect(init.agentCapabilities.sessionCapabilities).toEqual({ list: {} });
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
    expect(JSON.parse(task.tags)).toEqual(["acp-serve", `acp-session:${sessionId}`, "acp-cwd:/tmp"]);

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
    // An app that shows the step collapsed (Zed) still shows its title, which leads with the row's latest note.
    const latest = db.prepare("SELECT actor_session, transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_note IS NOT NULL ORDER BY transition_id DESC LIMIT 1")
      .get(task.qitem_id) as { actor_session: string; transition_note: string };
    const titled = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === task.qitem_id && u.title).at(-1)!;
    expect(titled.title).toBe(`${latest.actor_session}: ${latest.transition_note} · Sent to ${LEAD} (${task.qitem_id})`);
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
    expect(messages(updates).at(-1)).toContain("`rig config set acp.to <member@rig>`, or add `--to <member@rig>`");
  });

  it("a question tagged for this chat comes as a permission request and the choice is recorded as the caller's answer; an untagged one is only named", async () => {
    const { client, updates } = connect({}, "asker@team");
    const asked: Array<Record<string, any>> = [];
    client.onRequest("session/request_permission", async (params) => {
      asked.push(params as Record<string, any>);
      return { outcome: { outcome: "selected", optionId: "b" } };
    });
    const sessionId = await open(client);
    // Asked before this turn by a seat the work never reaches: not this turn's question.
    await move("bystander@team", "/api/queue/create", { qitemId: "qitem-unrelated-ask", destinationSession: CALLER, body: "unrelated", summary: "Unrelated", nudge: false,
      humanQuestions: [{ id: "q1", question: "Unrelated?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] });
    const turn = client.request("session/prompt", prompt(sessionId, "Pick a database for the cache"));
    const task = await until(() => rowsTo("asker@team")[0], "the work row");
    await move("asker@team", `/api/queue/${task.qitem_id}/claim`, {});
    // Untagged, from the seat working on it: it could be another chat's, so it's named here, never asked.
    await move("asker@team", "/api/queue/create", { qitemId: "qitem-ask-untagged", destinationSession: CALLER, body: "Which region?", summary: "Region?", nudge: false,
      humanQuestions: [{ id: "q1", question: "Which region?", options: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }] }] });
    await move("asker@team", "/api/queue/create", { qitemId: "qitem-ask-db", destinationSession: CALLER, body: "Redis is faster; SQLite is already here.", summary: "Which store?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which store?", options: [{ id: "a", label: "Redis" }, { id: "b", label: "SQLite", recommended: true }] }] });
    const answered = await until(() => {
      const row = db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-db'").get() as { human_answers: string | null };
      return row.human_answers ? JSON.parse(row.human_answers) : undefined;
    }, "the recorded answer");
    expect(Object.keys(answered)).toEqual(["q1"]);
    expect(JSON.stringify(answered)).toContain("b");
    await move("asker@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "SQLite, as you chose." });
    expect(await turn).toEqual({ stopReason: "end_turn" });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.toolCall).toMatchObject({ toolCallId: "qitem-ask-db#q1", title: "asker@team asks: Which store?" });
    expect(asked[0]!.options).toEqual([{ optionId: "a", name: "Redis", kind: "allow_once" }, { optionId: "b", name: "SQLite (recommended)", kind: "allow_once" }]);
    const result = updates.filter((u) => u.toolCallId === "qitem-ask-db#q1").at(-1)!;
    expect(result.status).toBe("completed");
    expect((result.content as Array<{ content: { text: string } }>)[0]!.content.text).toBe("You answered: SQLite. asker@team gets it as your answer.");
    // "asker@team gets it as your answer": the answer path's reply row, from the caller to the seat that asked.
    const replies = db.prepare("SELECT body FROM queue_items WHERE source_session = ? AND destination_session = 'asker@team' AND reply_to = 'qitem-ask-db'").all(CALLER) as Array<{ body: string }>;
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain("SQLite");
    const unrelated = db.prepare("SELECT state, human_answers FROM queue_items WHERE qitem_id = 'qitem-unrelated-ask'").get() as { state: string; human_answers: string | null };
    expect(unrelated).toEqual({ state: "pending", human_answers: null });
    expect(messages(updates)).toContain("\n\nasker@team, which this work reached, has a question for you that isn't tagged for this chat (qitem-ask-untagged: Region?). Answer it in the OpenRig TUI or Slack.\n\n");
    expect(db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-untagged'").get()).toEqual({ human_answers: null });
    expect(task.body).toContain(`--tags acp-session:${sessionId}`);
  });

  it("an app that asks forms gets a question's choices as a form, each by its label, and the choice is recorded", async () => {
    const { client, updates } = connect({}, "former@team");
    const asked: Array<Record<string, any>> = [];
    client.onRequest("elicitation/create", async (params) => { asked.push(params as Record<string, any>); return { action: "accept", content: { q1: "SQLite (recommended)" } }; });
    client.onRequest("session/request_permission", async () => { throw new Error("no permission request was expected"); });
    const sessionId = await open(client, { elicitation: { form: {} } });
    const turn = client.request("session/prompt", prompt(sessionId, "Pick a store for the cache"));
    const task = await until(() => rowsTo("former@team")[0], "the work row");
    await move("former@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("former@team", "/api/queue/create", { qitemId: "qitem-form-db", destinationSession: CALLER, body: "Redis is faster; SQLite is already here.", summary: "Which store?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which store?", options: [{ id: "a", label: "Redis" }, { id: "b", label: "SQLite", recommended: true }] }] });
    const answered = await until(() => {
      const row = db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-form-db'").get() as { human_answers: string | null };
      return row.human_answers ? JSON.parse(row.human_answers) : undefined;
    }, "the recorded answer");
    expect(JSON.stringify(answered)).toContain("b");
    await move("former@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "SQLite." });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(asked).toEqual([{
      sessionId, toolCallId: "qitem-form-db#q1", mode: "form", message: "former@team asks: Which store?",
      requestedSchema: { type: "object", required: ["q1"], properties: { q1: { type: "string", title: "Which store?", enum: ["Redis", "SQLite (recommended)"] } } },
    }]);
    const result = updates.filter((u) => u.toolCallId === "qitem-form-db#q1").at(-1)!;
    expect((result.content as Array<{ content: { text: string } }>)[0]!.content.text).toBe("You answered: SQLite. former@team gets it as your answer.");
  });

  it("#2708 choices whose labels repeat carry their ids, so the answer names one choice", async () => {
    const { client } = connect({}, "twins@team");
    const asked: Array<Record<string, any>> = [];
    client.onRequest("elicitation/create", async (params) => { asked.push(params as Record<string, any>); return { action: "accept", content: { q1: "Same (b)" } }; });
    const sessionId = await open(client, { elicitation: { form: {} } });
    const turn = client.request("session/prompt", prompt(sessionId, "Pick one"));
    const task = await until(() => rowsTo("twins@team")[0], "the work row");
    await move("twins@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("twins@team", "/api/queue/create", { qitemId: "qitem-form-twins", destinationSession: CALLER, body: "Twins", summary: "Which?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "Same" }, { id: "b", label: "Same" }] }] });
    const answered = await until(() => {
      const row = db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-form-twins'").get() as { human_answers: string | null };
      return row.human_answers ? JSON.parse(row.human_answers) : undefined;
    }, "the recorded answer");
    expect(asked[0]!.requestedSchema.properties.q1.enum).toEqual(["Same (a)", "Same (b)"]);
    expect(JSON.stringify(answered)).toContain('"b"');
    client.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });

  it("a form declined, cancelled, or answered with no option of the question's records nothing; form: null gets a permission request", async () => {
    for (const [i, reply] of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { q1: "zzz" } }].entries()) {
      const { client, updates } = connect({}, `former${i}@team`);
      client.onRequest("elicitation/create", async () => reply);
      const sessionId = await open(client, { elicitation: { form: {} } });
      const turn = client.request("session/prompt", prompt(sessionId, "Pick one"));
      const task = await until(() => rowsTo(`former${i}@team`)[0], "the work row");
      await move(`former${i}@team`, `/api/queue/${task.qitem_id}/claim`, {});
      await move(`former${i}@team`, "/api/queue/create", { qitemId: `qitem-form-${i}`, destinationSession: CALLER, body: "Two ways", summary: "Way?", nudge: false,
        tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which way?", options: [{ id: "a", label: "Left" }, { id: "b", label: "Right" }] }] });
      const said = await until(() => updates.find((u) => u.toolCallId === `qitem-form-${i}#q1` && u.sessionUpdate === "tool_call_update"), "the outcome");
      expect((said.content as Array<{ content: { text: string } }>)[0]!.content.text, JSON.stringify(reply)).toBe("Not answered here. The question is still open in the OpenRig TUI and Slack.");
      expect(messages(updates), JSON.stringify(reply)).toContain(`\n\nNot answered here. former${i}@team's question "Which way?" (qitem-form-${i}) is still open in the OpenRig TUI and Slack.\n\n`);
      expect(db.prepare(`SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-form-${i}'`).get()).toEqual({ human_answers: null });
      client.notify("session/cancel", { sessionId });
      expect(await turn).toEqual({ stopReason: "cancelled" });
    }
    const { client } = connect({}, "nullform@team");
    let permissionAsked = false;
    client.onRequest("elicitation/create", async () => { throw new Error("form: null advertises no form mode"); });
    client.onRequest("session/request_permission", async () => { permissionAsked = true; return { outcome: { outcome: "cancelled" } }; });
    const sessionId = await open(client, { elicitation: { form: null } });
    const turn = client.request("session/prompt", prompt(sessionId, "Pick one"));
    const task = await until(() => rowsTo("nullform@team")[0], "the work row");
    await move("nullform@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("nullform@team", "/api/queue/create", { qitemId: "qitem-form-null", destinationSession: CALLER, body: "Two ways", summary: "Way?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which way?", options: [{ id: "a", label: "Left" }, { id: "b", label: "Right" }] }] });
    await until(() => (permissionAsked ? true : undefined), "the permission request");
    client.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });

  it("a question tagged for one chat is asked in that chat only, though another chat's work reached the same seat", async () => {
    const chatA = connect({}, "shared@team");
    const chatB = connect({}, "shared@team");
    const askedIn: Record<string, string[]> = { a: [], b: [] };
    chatA.client.onRequest("session/request_permission", async (params) => { askedIn.a.push((params as any).toolCall.toolCallId); return { outcome: { outcome: "cancelled" } }; });
    chatB.client.onRequest("session/request_permission", async (params) => { askedIn.b.push((params as any).toolCall.toolCallId); return { outcome: { outcome: "selected", optionId: "y" } }; });
    const a = await open(chatA.client);
    const b = await open(chatB.client);
    const turnA = chatA.client.request("session/prompt", prompt(a, "Chat A's task"));
    const turnB = chatB.client.request("session/prompt", prompt(b, "Chat B's task"));
    const [rowA, rowB] = await until(() => { const rows = rowsTo("shared@team"); return rows.length === 2 ? rows : undefined; }, "both rows");
    await move("shared@team", "/api/queue/create", { qitemId: "qitem-ask-for-b", destinationSession: CALLER, body: "For B only", summary: "B?", nudge: false,
      tags: [`acp-session:${b}`], humanQuestions: [{ id: "q1", question: "Ship B?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] });
    await until(() => (askedIn.b.length > 0 ? true : undefined), "B's question");
    for (const row of [rowA!, rowB!]) {
      await move("shared@team", `/api/queue/${row.qitem_id}/claim`, {});
      await move("shared@team", `/api/queue/${row.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Done." });
    }
    await Promise.all([turnA, turnB]);
    expect(askedIn).toEqual({ a: [], b: ["qitem-ask-for-b#q1"] });
    expect(chatA.updates.some((u) => String(u.toolCallId ?? "").startsWith("qitem-ask-for-b"))).toBe(false);
    expect(messages(chatA.updates).some((m) => m.includes("qitem-ask-for-b"))).toBe(false);
  });

  it("cancel waits for the app to settle the question it's showing, and nothing about it follows the cancelled answer", async () => {
    const { client, updates, inbound } = connect({}, "asker3@team");
    let answerCancelled!: () => void;
    client.onRequest("session/request_permission", () => new Promise((resolve) => {
      answerCancelled = () => setTimeout(() => resolve({ outcome: { outcome: "cancelled" } }), 50);
    }));
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Choose a theme"));
    await until(() => rowsTo("asker3@team")[0], "the work row");
    await move("asker3@team", "/api/queue/create", { qitemId: "qitem-ask-theme", destinationSession: CALLER, body: "Light or dark", summary: "Theme?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which theme?", options: [{ id: "l", label: "Light" }, { id: "d", label: "Dark" }] }] });
    await until(() => (answerCancelled ? true : undefined), "the question on screen");
    // As ACP has it: the app sends the cancel, then answers its open question as cancelled.
    client.notify("session/cancel", { sessionId });
    answerCancelled();
    expect(await turn).toEqual({ stopReason: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const end = inbound.findIndex((p) => p.result?.stopReason === "cancelled");
    const about = inbound.map((p, i) => ({ p, i })).filter(({ p }) => p.params?.update?.toolCallId === "qitem-ask-theme#q1");
    expect(about.at(-1)!.i).toBeLessThan(end);
    expect(about.at(-1)!.p.params.update.content[0].content.text).toBe("Not answered here. The question is still open in the OpenRig TUI and Slack.");
    const said = inbound.map((p, i) => ({ p, i })).filter(({ p }) => p.params?.update?.sessionUpdate === "agent_message_chunk"
      && p.params.update.content.text.includes(`asker3@team's question "Which theme?" (qitem-ask-theme) is still open`));
    expect(said).toHaveLength(1);
    expect(said[0]!.i).toBeLessThan(end);
    expect(updates.filter((u) => u.toolCallId === "qitem-ask-theme#q1")).toHaveLength(2);
    expect(db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-theme'").get()).toEqual({ human_answers: null });
  });

  it("after a cancel no new question goes to the app, even one already waiting when the cancel wakes the turn", async () => {
    // The poll never fires on its own here, so the only pass after the first is the one the cancel's wake runs.
    let scans = 0;
    let shown = false;
    const hiddenUntilCancel = (q: TeamQueue): TeamQueue => ({ ...q, openAsks: async (person) => { scans += 1; return shown ? q.openAsks(person) : []; } });
    const { client, updates } = connect({ pollMs: 60_000, sleep: (ms) => new Promise<void>((resolve) => { if (ms !== 60_000) setTimeout(resolve, ms); }) },
      "asker5@team", hiddenUntilCancel);
    const asked: string[] = [];
    client.onRequest("session/request_permission", async (params) => { asked.push((params as any).toolCall.toolCallId); return { outcome: { outcome: "cancelled" } }; });
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Pick a font"));
    await until(() => (scans > 0 ? true : undefined), "the first read of open questions");
    await move("asker5@team", "/api/queue/create", { qitemId: "qitem-ask-after-cancel", destinationSession: CALLER, body: "Serif or sans", summary: "Font?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which font?", options: [{ id: "s", label: "Serif" }, { id: "n", label: "Sans" }] }] });
    shown = true;
    client.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(asked).toEqual([]);
    expect(updates.some((u) => String(u.toolCallId ?? "").startsWith("qitem-ask-after-cancel"))).toBe(false);
    expect(db.prepare("SELECT state, human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-after-cancel'").get()).toEqual({ state: "pending", human_answers: null });
  });

  it("a cancel while an answer is being recorded keeps that answer and opens no further question from the ask", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slowAnswer = (q: TeamQueue): TeamQueue => ({ ...q, answer: async (...args) => { await held; return q.answer(...args); } });
    // The answer write is held until the cancel's settle wait (2 s, the only sleep that long here) has begun.
    const settleThenRelease = (ms: number) => { if (ms === 2000) release(); return new Promise<void>((resolve) => setTimeout(resolve, ms)); };
    const { client, updates } = connect({ sleep: settleThenRelease }, "asker6@team", slowAnswer);
    const asked: string[] = [];
    client.onRequest("session/request_permission", async (params) => {
      const id = (params as any).toolCall.toolCallId as string;
      asked.push(id);
      return id.endsWith("#q1") ? { outcome: { outcome: "selected", optionId: "y" } } : { outcome: { outcome: "cancelled" } };
    });
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Plan the launch"));
    await until(() => rowsTo("asker6@team")[0], "the work row");
    await move("asker6@team", "/api/queue/create", { qitemId: "qitem-ask-two", destinationSession: CALLER, body: "Two calls to make", summary: "Launch?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [
        { id: "q1", question: "Ship this week?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] },
        { id: "q2", question: "Announce it?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] });
    await until(() => (asked.length > 0 ? true : undefined), "the first question");
    client.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "cancelled" });
    expect(asked).toEqual(["qitem-ask-two#q1"]);
    expect(updates.some((u) => u.toolCallId === "qitem-ask-two#q2")).toBe(false);
    const recorded = db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-two'").get() as { human_answers: string | null };
    expect(JSON.parse(recorded.human_answers ?? "{}")).toEqual({ q1: "y" });
  });

  it("when the work closes with a question still on screen, the app is told before the turn ends, and a later reply answers nothing", async () => {
    const { client, inbound } = connect({}, "asker4@team");
    let answerLate!: () => void;
    client.onRequest("session/request_permission", () => new Promise((resolve) => { answerLate = () => resolve({ outcome: { outcome: "selected", optionId: "x" } }); }));
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Plan the offsite"));
    const task = await until(() => rowsTo("asker4@team")[0], "the work row");
    await move("asker4@team", "/api/queue/create", { qitemId: "qitem-ask-venue", destinationSession: CALLER, body: "Two venues", summary: "Venue?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which venue?", options: [{ id: "x", label: "Lisbon" }, { id: "z", label: "Oslo" }] }] });
    await until(() => (answerLate ? true : undefined), "the question on screen");
    await move("asker4@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("asker4@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Booked without it." });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    answerLate();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const end = inbound.findIndex((p) => p.result?.stopReason === "end_turn");
    const about = inbound.map((p, i) => ({ p, i })).filter(({ p }) => p.params?.update?.toolCallId === "qitem-ask-venue#q1");
    expect(about.at(-1)!.i).toBeLessThan(end);
    expect(about.at(-1)!.p.params.update.content[0].content.text).toBe("The work closed before this was answered here. The question is still open in the OpenRig TUI and Slack.");
    const said = inbound.findIndex((p) => p.params?.update?.sessionUpdate === "agent_message_chunk"
      && p.params.update.content.text === `\n\nThe work closed before this was answered here. asker4@team's question "Which venue?" (qitem-ask-venue) is still open in the OpenRig TUI and Slack.\n\n`);
    expect(said).toBeGreaterThan(-1);
    expect(said).toBeLessThan(end);
    expect(db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-venue'").get()).toEqual({ human_answers: null });
  });

  it("a question the caller dismisses stays open and unanswered", async () => {
    const { client, updates } = connect({}, "asker2@team");
    client.onRequest("session/request_permission", async () => ({ outcome: { outcome: "cancelled" } }));
    const sessionId = await open(client);
    const turn = client.request("session/prompt", prompt(sessionId, "Rename the service"));
    const task = await until(() => rowsTo("asker2@team")[0], "the work row");
    await move("asker2@team", "/api/queue/create", { qitemId: "qitem-ask-name", destinationSession: CALLER, body: "Two names", summary: "Name?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which name?", options: [{ id: "a", label: "Atlas" }, { id: "b", label: "Beacon" }] }] });
    await until(() => updates.find((u) => u.toolCallId === "qitem-ask-name#q1" && u.sessionUpdate === "tool_call_update"), "the dismissal");
    await move("asker2@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("asker2@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Kept the old name." });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    const dismissed = updates.filter((u) => u.toolCallId === "qitem-ask-name#q1").at(-1)!;
    expect(dismissed.status).toBeUndefined();
    expect((dismissed.content as Array<{ content: { text: string } }>)[0]!.content.text).toBe("Not answered here. The question is still open in the OpenRig TUI and Slack.");
    expect(messages(updates)).toContain(`\n\nNot answered here. asker2@team's question "Which name?" (qitem-ask-name) is still open in the OpenRig TUI and Slack.\n\n`);
    expect(db.prepare("SELECT state, human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-name'").get()).toEqual({ state: "pending", human_answers: null });
  });

  it("a question the app can't show is named in the chat as still open, with why", async () => {
    const { client, updates } = connect({}, "unshown@team");
    client.onRequest("elicitation/create", async () => { throw new Error("form rejected"); });
    const sessionId = await open(client, { elicitation: { form: {} } });
    const turn = client.request("session/prompt", prompt(sessionId, "Pick a color"));
    const task = await until(() => rowsTo("unshown@team")[0], "the work row");
    await move("unshown@team", "/api/queue/create", { qitemId: "qitem-ask-color", destinationSession: CALLER, body: "Two colors", summary: "Color?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which color?", options: [{ id: "r", label: "Red" }, { id: "g", label: "Green" }] }] });
    const card = await until(() => updates.find((u) => u.toolCallId === "qitem-ask-color#q1" && u.sessionUpdate === "tool_call_update"), "the failure");
    expect((card.content as Array<{ content: { text: string } }>)[0]!.content.text).toMatch(/^This app couldn't show the question \(.*form rejected.*\)\. The question is still open in the OpenRig TUI and Slack\.$/);
    expect(messages(updates).some((m) => /^\n\nThis app couldn't show the question \(.*form rejected.*\)\. unshown@team's question "Which color\?" \(qitem-ask-color\) is still open in the OpenRig TUI and Slack\.\n\n$/.test(m))).toBe(true);
    await move("unshown@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("unshown@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Picked red." });
    expect(await turn).toEqual({ stopReason: "end_turn" });
    expect(db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-color'").get()).toEqual({ human_answers: null });
  });

  it("a session is listed and reopened from its rows: the prompt, its work and the reply replay, and a follow-up continues it", async () => {
    const first = connect({}, "keeper@team");
    const sessionId = await open(first.client);
    const turn = first.client.request("session/prompt", prompt(sessionId, "Summarize yesterday's incidents"));
    const task = await until(() => rowsTo("keeper@team")[0], "the row");
    await move("keeper@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("keeper@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Two incidents, both closed." });
    await turn;

    // A new process, as after the app restarts.
    const second = connect({}, "keeper@team");
    await second.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const listed = (await second.client.request("session/list", {})) as { sessions: Array<Record<string, unknown>> };
    expect(listed.sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ cwd: "/tmp", title: "Summarize yesterday's incidents" });
    expect(((await second.client.request("session/list", { cwd: "/elsewhere" })) as { sessions: unknown[] }).sessions.find((s) => (s as { sessionId: string }).sessionId === sessionId)).toBeUndefined();
    expect(await second.client.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] })).toEqual({});
    expect(second.updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    expect((second.updates[0]!.content as { text: string }).text).toBe("Summarize yesterday's incidents");
    expect(messages(second.updates).at(-1)).toBe(`keeper@team closed ${task.qitem_id} done.\n\nTwo incidents, both closed.`);

    const followUp = second.client.request("session/prompt", prompt(sessionId, "And the week before?"));
    const next = await until(() => rowsTo("keeper@team")[1], "the follow-up row");
    expect(next.body).toContain(`Follows up on ${task.qitem_id} (done).`);
    expect(JSON.parse(next.tags)).toContain(`acp-session:${sessionId}`);
    second.client.notify("session/cancel", { sessionId });
    expect(await followUp).toEqual({ stopReason: "cancelled" });
    const missing = await second.client.request("session/load", { sessionId: "acps-nope", cwd: "/tmp", mcpServers: [] }).then(() => undefined, (e: unknown) => e);
    expect((missing as JsonRpcRequestError).error.code).toBe(-32602);
  });

  it("an app that wraps the person's words in its own instructions: they're the row's summary and the session's title", async () => {
    const { client } = connect({}, "wrapped@team");
    const sessionId = await open(client);
    const sent = "<t3_code_instructions>\nUse the preview_* tools.\n</t3_code_instructions>\n<runtime_info>\nmacOS\n</runtime_info>\n"
      + "<user_request>\nFix the flaky login test\n</user_request>";
    const turn = client.request("session/prompt", prompt(sessionId, sent));
    const task = await until(() => rowsTo("wrapped@team")[0], "the row");
    expect(db.prepare("SELECT summary FROM queue_items WHERE qitem_id = ?").get(task.qitem_id)).toEqual({ summary: "ACP: Fix the flaky login test" });
    expect(task.body.startsWith(sent)).toBe(true);
    const listed = (await client.request("session/list", {})) as { sessions: Array<Record<string, unknown>> };
    expect(listed.sessions.find((s) => s.sessionId === sessionId)).toMatchObject({ title: "Fix the flaky login test" });
    client.notify("session/cancel", { sessionId });
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });

  it("#2708 a prompt whose request marks aren't one pair keeps its own first line: an example is never taken for the request", async () => {
    for (const [i, sent] of [
      "<t3_code_instructions>\nFor example: <user_request>Delete the cache</user_request>\n</t3_code_instructions>\n<user_request>\nRepair the login test\n</user_request>",
      "<t3_code_instructions>\nThe request follows in <user_request>.\n</t3_code_instructions>\n<user_request>\nRepair the login test\n</user_request>",
    ].entries()) {
      const { client } = connect({}, `marked${i}@team`);
      const sessionId = await open(client);
      const turn = client.request("session/prompt", prompt(sessionId, sent));
      const task = await until(() => rowsTo(`marked${i}@team`)[0], "the row");
      expect(db.prepare("SELECT summary FROM queue_items WHERE qitem_id = ?").get(task.qitem_id), sent).toEqual({ summary: "ACP: <t3_code_instructions>" });
      const listed = (await client.request("session/list", {})) as { sessions: Array<Record<string, unknown>> };
      expect(listed.sessions.find((s) => s.sessionId === sessionId), sent).toMatchObject({ title: "<t3_code_instructions>" });
      client.notify("session/cancel", { sessionId });
      expect(await turn).toEqual({ stopReason: "cancelled" });
    }
  });

  it("a reopened session replays the questions asked during it with what's recorded, and asks nothing again", async () => {
    const first = connect({}, "asker7@team");
    first.client.onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "b" } }));
    const sessionId = await open(first.client);
    const turn = first.client.request("session/prompt", prompt(sessionId, "Pick a store"));
    const task = await until(() => rowsTo("asker7@team")[0], "the work row");
    await move("asker7@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("asker7@team", "/api/queue/create", { qitemId: "qitem-ask-replayed", destinationSession: CALLER, body: "Redis or SQLite", summary: "Store?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Which store?", options: [{ id: "a", label: "Redis" }, { id: "b", label: "SQLite" }] }] });
    await until(() => ((db.prepare("SELECT human_answers FROM queue_items WHERE qitem_id = 'qitem-ask-replayed'").get() as { human_answers: string | null }).human_answers ? true : undefined), "the answer");
    await move("asker7@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "SQLite it is." });
    await turn;

    const second = connect({}, "asker7@team");
    const asked: unknown[] = [];
    second.client.onRequest("session/request_permission", async (params) => { asked.push(params); return { outcome: { outcome: "cancelled" } }; });
    await second.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(await second.client.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] })).toEqual({});
    expect(second.updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "tool_call", "tool_call_update", "tool_call", "agent_message_chunk"]);
    expect(second.updates[3]).toMatchObject({ toolCallId: "qitem-ask-replayed#q1", status: "completed", title: "asker7@team asks: Which store?" });
    expect((second.updates[3]!.content as Array<{ content: { text: string } }>).map((c) => c.content.text)).toEqual(["Redis or SQLite", "You answered: SQLite."]);
    expect(messages(second.updates).at(-1)).toBe(`asker7@team closed ${task.qitem_id} done.\n\nSQLite it is.`);
    expect(asked).toEqual([]);
  });

  it("a reopened session shows, in the order asked, a question closed unanswered as closed and one still open as pending", async () => {
    const first = connect({}, "asker8@team");
    const sessionId = await open(first.client);
    const turn = first.client.request("session/prompt", prompt(sessionId, "Plan the release"));
    const task = await until(() => rowsTo("asker8@team")[0], "the work row");
    await move("asker8@team", `/api/queue/${task.qitem_id}/claim`, {});
    await move("asker8@team", `/api/queue/${task.qitem_id}/update`, { state: "done", closureReason: "no-follow-on", resolution: "Planned." });
    await turn;
    // Asked after the turn ended, so no live turn puts them to the app.
    const choices = [{ id: "y", label: "Yes" }, { id: "n", label: "No" }];
    await move("asker8@team", "/api/queue/create", { qitemId: "qitem-ask-closed-unanswered", destinationSession: CALLER, body: "Freeze on Friday?", summary: "Freeze?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Freeze on Friday?", options: choices }] });
    await move(CALLER, "/api/queue/qitem-ask-closed-unanswered/claim", {});
    await move(CALLER, "/api/queue/qitem-ask-closed-unanswered/update", { state: "done", closureReason: "no-follow-on", resolution: "Moot now." });
    await move("asker8@team", "/api/queue/create", { qitemId: "qitem-ask-still-open", destinationSession: CALLER, body: "Tag it 1.0?", summary: "Tag?", nudge: false,
      tags: [`acp-session:${sessionId}`], humanQuestions: [{ id: "q1", question: "Tag it 1.0?", options: choices }] });

    const second = connect({}, "asker8@team");
    const asked: unknown[] = [];
    second.client.onRequest("session/request_permission", async (params) => { asked.push(params); return { outcome: { outcome: "cancelled" } }; });
    await second.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(await second.client.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] })).toEqual({});
    const questions = second.updates.filter((u) => u.sessionUpdate === "tool_call" && String(u.toolCallId).includes("#"));
    expect(questions.map((u) => [u.toolCallId, u.status, (u.content as Array<{ content: { text: string } }>).at(-1)!.content.text])).toEqual([
      ["qitem-ask-closed-unanswered#q1", "completed", "Not answered: qitem-ask-closed-unanswered was closed (done)."],
      ["qitem-ask-still-open#q1", "pending", "Not answered yet. It's still open in the OpenRig TUI and Slack."],
    ]);
    expect(asked).toEqual([]);
  });

  it("a connection's notice is said once in each session, before its first prompt's work", async () => {
    const team: TeamConnection = { queue: daemonTeamQueue(new DaemonClient(url(), { sessionName: CALLER })), caller: CALLER, receiver: "noticed@team", notice: "Your team can't ask you questions here yet." };
    const { client, updates } = connect({ connect: async () => team });
    const sessionId = await open(client);
    for (const [i, text] of ["One", "Two"].entries()) {
      const turn = client.request("session/prompt", prompt(sessionId, text));
      await until(() => rowsTo("noticed@team")[i], `row ${i + 1}`);
      client.notify("session/cancel", { sessionId });
      expect(await turn).toEqual({ stopReason: "cancelled" });
    }
    expect(messages(updates).filter((m) => m.includes("can't ask you questions"))).toEqual(["Your team can't ask you questions here yet.\n\n"]);
    expect(messages(updates)[0]).toBe("Your team can't ask you questions here yet.\n\n");
  });

  it("names an unregistered person and how to register; says nothing for a registered person or a seat", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-people-"));
    try {
      expect(await unregisteredPersonNotice("dev@team", home)).toBeUndefined();
      expect(await unregisteredPersonNotice("cq-person@external", home)).toBe("Your team can't ask you questions here yet: cq-person@external isn't a registered person on this machine, so OpenRig refuses a question addressed to it. Your work is still sent. To be asked, register yourself with `rig gateway human add cq-person --display-name \"<your name>\" --delivery-class <A|B|C|D>`.");
      expect(addHumanFragment({ entityId: "ada", class: "human", displayName: "Ada", address: "ada@external", connectorBindings: [], prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
      expect(await unregisteredPersonNotice("ada@external", home)).toBeUndefined();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("an unknown method gets JSON-RPC's method-not-found", async () => {
    const { client } = connect();
    const error = await client.request("session/fork", { sessionId: "x" }).then(() => undefined, (e: unknown) => e);
    expect((error as JsonRpcRequestError).error).toEqual({ code: -32601, message: "Method not found: session/fork" });
  });
});
