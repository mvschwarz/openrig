// The MCP queue tools against the daemon's real queue routes, over HTTP, through the real DaemonClient: a seat
// configured once (OPENRIG_SESSION_NAME in the MCP server's env) hands a task to another seat and reads the
// answer back by the task's id. Nothing in the tool calls names the sender.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { SessionRegistry } from "../../daemon/src/domain/session-registry.js";
import { RunnerPermissions } from "../../daemon/src/domain/runner-permissions.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

const DESK = "desk@team";
const IMPL = "impl@team";

describe("MCP queue tools on the daemon's queue routes", () => {
  let db: Database.Database;
  let home: string;
  let shared: string;
  let server: ServerType;
  let url: string;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME, node: process.env.OPENRIG_NODE_ID, legacyNode: process.env.RIGGED_NODE_ID };

  beforeEach(async () => {
    // Outside any seat OpenRig launched, whatever runs these tests: a case that wants one sets OPENRIG_NODE_ID itself.
    delete process.env.OPENRIG_NODE_ID;
    delete process.env.RIGGED_NODE_ID;
    // Every migration, as an installed daemon has: the queue routes read columns the reduced test schema lacks.
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-queue-"));
    process.env.OPENRIG_HOME = home;
    // One shared root, canonical as the daemon resolves it at startup (a temp directory can sit behind a symlink).
    shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shared-")));
    const inert = async () => ({ ok: false, error: "inert fixture" });
    const queueRepo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    // The wake store attached, as the daemon attaches it at startup: a handoff makes its successor's wake durable there.
    queueRepo.attachOutbox(new OutboxHandler(db));
    const { app } = createTestApp(db, {
      appDeps: {
        sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
        queueRepo,
        filesAllowlist: [{ name: "proof", canonicalPath: shared }],
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
    fs.rmSync(shared, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
    if (saved.node === undefined) delete process.env.OPENRIG_NODE_ID; else process.env.OPENRIG_NODE_ID = saved.node;
    if (saved.legacyNode === undefined) delete process.env.RIGGED_NODE_ID; else process.env.RIGGED_NODE_ID = saved.legacyNode;
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

  it("follows a handed-on task to the item that carries it, and finds finished work by time", async () => {
    const desk = await connectAs(DESK);
    const impl = await connectAs(IMPL);
    const qitemId = (await desk("rig_queue_create", { destination: IMPL, body: "Fix the stale fixture." })).data.qitemId as string;
    expect((await impl("rig_queue_claim", { qitemId })).isError).toBe(false);
    // An open item has no successor key: its result reads as before.
    expect("successor" in (await desk("rig_queue_show", { qitemId })).data).toBe(false);

    // The assignee hands it on with the CLI's route, as a seat with a shell does.
    const handoff = await fetch(`${url}/api/queue/${qitemId}/handoff`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": IMPL },
      body: JSON.stringify({ toSession: "qa@team", nudge: false }),
    });
    expect(handoff.status).toBe(201);
    const next = ((await handoff.json()) as { created: { qitemId: string } }).created.qitemId;

    const shown = await desk("rig_queue_show", { qitemId });
    expect(shown.data.item).toMatchObject({ state: "handed-off" });
    // An unscoped caller gets the daemon's successor fields as they are.
    expect(shown.data.item.successors).toEqual([{ qitemId: next, destinationSession: "qa@team", state: "pending", via: "handedOffFrom" }]);
    expect(shown.structured).toMatchObject({ successor: { qitemId: next, destinationSession: "qa@team", state: "pending" } });
    expect(shown.data.successor).toEqual((shown.structured as { successor: unknown }).successor);
    const onward = await desk("rig_queue_list", { handedOffFrom: qitemId });
    expect((onward.structured as { items: Array<{ qitemId: string }> }).items.map((item) => item.qitemId)).toEqual([next]);

    const since = async (time: string) => ((await desk("rig_queue_list", { destination: "qa@team", since: time })).structured as { items: unknown[] }).items.length;
    expect(await since("2000-01-01T00:00:00Z")).toBe(1);
    expect(await since("2999-01-01T00:00:00Z")).toBe(0);
    const invalid = await desk("rig_queue_list", { destination: "qa@team", since: "yesterday" });
    expect(invalid.isError).toBe(true);
    expect(invalid.structured).toMatchObject({ ok: false, code: "updated_since_invalid", status: 400 });
  });

  it("lets a seat with no shell pass its task on in one step, and put back one it won't finish", async () => {
    const desk = await connectAs(DESK);
    const impl = await connectAs(IMPL);
    const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    const qitemId = (await desk("rig_queue_create", { destination: IMPL, body: "Fix the stale fixture." })).data.qitemId as string;
    expect((await impl("rig_queue_claim", { qitemId })).isError).toBe(false);

    const handed = await impl("rig_queue_handoff", { qitemId, to: "qa@team", note: "fixed; needs a check", summary: "check the fixture fix" });
    expect(handed.isError).toBe(false);
    const created = (handed.structured as { created: { qitemId: string } }).created;
    expect(handed.structured).toMatchObject({
      closed: { qitemId, state: "handed-off", closureReason: "handed_off_to", closureTarget: "qa@team" },
      created: { destinationSession: "qa@team", sourceSession: expect.stringMatching(/^impl@team/), state: "pending", chainOfRecord: [qitemId], body: "Fix the stale fixture." },
    });
    // The person who delegated follows it from their own item, and the transition says who passed it on and why.
    const shown = await desk("rig_queue_show", { qitemId });
    expect(shown.structured).toMatchObject({ successor: { qitemId: created.qitemId, destinationSession: "qa@team", state: "pending" } });
    const transitions = JSON.stringify(shown.data.transitions);
    expect(transitions).toContain("fixed; needs a check");
    expect(transitions).toContain("transport:v1");

    // A retry after the handoff landed opens nothing new: the daemon names the closed item.
    const before = rows();
    const again = await impl("rig_queue_handoff", { qitemId, to: "qa@team" });
    expect(again.structured).toMatchObject({ ok: false, code: "qitem_already_terminal", status: 409 });
    expect(rows()).toBe(before);

    // Putting back: only a claimed item, which returns to pending for the same seat with the reason recorded.
    const second = (await desk("rig_queue_create", { destination: IMPL, body: "Profile the slow test." })).data.qitemId as string;
    expect((await impl("rig_queue_unclaim", { qitemId: second })).structured).toMatchObject({ ok: false, code: "qitem_not_in_progress", status: 409 });
    expect((await impl("rig_queue_claim", { qitemId: second })).isError).toBe(false);
    const putBack = await impl("rig_queue_unclaim", { qitemId: second, reason: "no capacity today" });
    expect(putBack.isError).toBe(false);
    expect(putBack.structured).toMatchObject({ qitemId: second, state: "pending", destinationSession: IMPL, claimedAt: null });
    expect(JSON.stringify((await desk("rig_queue_show", { qitemId: second })).data.transitions)).toContain("unclaimed: no capacity today");
    expect((await impl("rig_queue_claim", { qitemId: second })).isError).toBe(false);
  });

  it("records the configured seat as the source even when nothing else names it", async () => {
    const desk = await connectAs(DESK);
    const created = await desk("rig_queue_create", { destination: IMPL, body: "fixture" });
    const row = db.prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?").get(created.data.qitemId) as { source_session: string };
    expect(row.source_session).toMatch(/^desk@team/);
  });

  it("reads a finished task's artifact through a shared root, and says plainly when it can't", async () => {
    const desk = await connectAs(DESK);
    const impl = await connectAs(IMPL);
    const report = path.join(shared, "report.md");
    fs.writeFileSync(report, "RESULT: the fixture path was stale.\n");
    /** A task the assignee closes with this evidenceRef (none: an open task). */
    const finished = async (evidenceRef?: string) => {
      const qitemId = (await desk("rig_queue_create", { destination: IMPL, body: "Write up the failure." })).data.qitemId as string;
      if (evidenceRef === undefined) return qitemId;
      expect((await impl("rig_queue_claim", { qitemId })).isError).toBe(false);
      expect((await impl("rig_queue_update", { qitemId, state: "done", closureReason: "no-follow-on", evidenceRef })).isError).toBe(false);
      return qitemId;
    };

    const read = await desk("rig_artifact_read", { qitemId: await finished(report) });
    expect(read.isError).toBe(false);
    expect(read.structured).toMatchObject({ available: true, source: "evidenceRef", root: "proof", path: "report.md", binary: false,
      text: "RESULT: the fixture path was stale.\n", truncated: false });
    expect((await desk("rig_artifact_read", { root: "proof", path: "report.md" })).structured).toMatchObject({ source: "path", text: "RESULT: the fixture path was stale.\n" });

    // A long file is read on from nextOffset; the daemon's own containment refuses a path out of the root.
    fs.writeFileSync(path.join(shared, "long.md"), `${"a".repeat(48_000)}TAIL`);
    expect((await desk("rig_artifact_read", { root: "proof", path: "long.md" })).structured).toMatchObject({ truncated: true, nextOffset: 48_000, totalChars: 48_004 });
    expect((await desk("rig_artifact_read", { root: "proof", path: "long.md", offset: 48_000 })).structured).toMatchObject({ text: "TAIL", truncated: false });
    // A page that would end inside an emoji ends before it, and the next page starts with the whole emoji.
    fs.writeFileSync(path.join(shared, "emoji.md"), `${"a".repeat(47_999)}🚀TAIL`);
    expect((await desk("rig_artifact_read", { root: "proof", path: "emoji.md" })).structured)
      .toMatchObject({ text: "a".repeat(47_999), truncated: true, nextOffset: 47_999, totalChars: 48_005 });
    expect((await desk("rig_artifact_read", { root: "proof", path: "emoji.md", offset: 47_999 })).structured).toMatchObject({ text: "🚀TAIL", truncated: false });
    expect((await desk("rig_artifact_read", { root: "proof", path: "../outside.md" })).structured).toMatchObject({ ok: false, code: "path_escape", status: 400 });

    const outside = path.join(home, "notes.md");
    fs.writeFileSync(outside, "not shared");
    // The reference names a file where the daemon runs, which may be another machine: a link on this machine that leads into
    // the root says nothing about what the same path is there, so it isn't followed.
    fs.mkdirSync(path.join(shared, "old"));
    fs.writeFileSync(path.join(shared, "old", "report.md"), "not shared");
    fs.symlinkSync(path.join(shared, "old"), path.join(home, "alias"));
    const linked = path.join(home, "alias", "report.md");
    for (const [evidenceRef, reason] of [[outside, "outside every shared root"], [linked, "outside every shared root"],
      ["https://example.com/report", "a link"], [undefined, "no evidenceRef"]] as const) {
      const none = await desk("rig_artifact_read", { qitemId: await finished(evidenceRef) });
      expect(none.isError).toBe(false);
      expect(none.structured).toMatchObject({ available: false, evidenceRef: evidenceRef ?? null, roots: ["proof"] });
      expect((none.structured as { reason: string }).reason).toContain(reason);
      expect(JSON.stringify(none.data)).not.toContain("not shared");
    }
  });

  it("asks for a revision linked to the work it revises", async () => {
    const desk = await connectAs(DESK);
    const original = (await desk("rig_queue_create", { destination: IMPL, body: "Write up the failure." })).data.qitemId as string;
    const revision = await desk("rig_queue_create", { destination: IMPL, body: "Also cover the README.", revises: original });
    expect(revision.isError).toBe(false);
    const shown = await desk("rig_queue_show", { qitemId: revision.data.qitemId as string });
    expect(shown.data.item).toMatchObject({ chainOfRecord: [original], body: `Revision of ${original}.\n\nAlso cover the README.` });

    // Revising an item that doesn't exist creates nothing.
    const before = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect((await desk("rig_queue_create", { destination: IMPL, body: "x", revises: "qitem-not-here" })).structured).toMatchObject({ ok: false, code: "qitem_not_found", status: 404 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n).toBe(before);
  });

  it("decides nothing for a task that wasn't asked of a person", async () => {
    const desk = await connectAs(DESK);
    const qitemId = (await desk("rig_queue_create", { destination: IMPL, body: "Pick a layout." })).data.qitemId as string;
    expect((await desk("rig_human_decision_room", { qitemId })).structured).toMatchObject({ ok: false, code: "not-a-decision" });
    const refused = await desk("rig_queue_decide", { qitemId, applicationId: "app-1", choices: [{ chosen: "layout A" }], reason: "it's ready", reversible: true });
    expect(refused.isError).toBe(true);
    expect(refused.structured).toMatchObject({ ok: false, code: "not-a-decision", status: 409 });
    expect((await desk("rig_queue_show", { qitemId })).data.item).toMatchObject({ state: "pending", delegatedDecision: null });
  });

  // Slice 15 (claude9 and claude10's F1): the person's own conversation, with no seat, answers a seat's Claude Code
  // permission ask through the plugin's MCP tools, as `rig seat decide-permission` does in a shell.
  it("answers a seat's own permission ask with rig_seat_decide_permission, as relayed by the conversation and unconfirmed, the first answer counts, and an orphaned ask says it hasn't reached the prompt", async () => {
    const rigs = new RigRepository(db);
    const node = rigs.addNode(rigs.createRig("team").id, "dev.build", { runtime: "claude-code" });
    const sessions = new SessionRegistry(db);
    sessions.updateStatus(sessions.registerSession(node.id, "dev-build@team").id, "running");
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const route = "conversation-0123456789ab@kernel";
    const work = await repo.create({ sourceSession: "someone outside a seat", destinationSession: "dev-build@team", body: "Add the feature",
      returnRoute: route, returnRouteBasis: "issued", nudge: false });
    repo.update({ qitemId: work.qitemId, actorSession: "dev-build@team", state: "in-progress" });
    // The seat's PermissionRequest hook submits its prompt (the route's own service, as permission-answer.cjs reaches it).
    const permissions = new RunnerPermissions({ db, queueRepo: repo, eventBus: new EventBus(db), humanRegistry: () => ({ ok: true, entities: [] }) as never,
      ownerOf: () => null, currentGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null });
    const submitted = await permissions.submit({ nodeId: node.id, sessionName: "dev-build@team", generation: sessions.currentOccupantTenure(node.id)!.generationUuid }, {
      nativeRef: "claude-session-1", turnId: "invocation-1", requestId: "invocation-1", nativeHook: "claude-code", holdSeconds: 86400,
      action: { tool: "Bash", input: { command: "git commit -m 'Add the feature'" }, agent: null }, toolCall: { title: "Bash", kind: "Bash" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    expect(submitted).toMatchObject({ ok: true, askedOf: route });
    const askId = (submitted as { askId: string }).askId;

    // The plugin's server in a raw Claude Code conversation: no seat.
    delete process.env.OPENRIG_SESSION_NAME;
    const mcp = createMcpServer(new DaemonClient(url));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "conversation", version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await mcp.close(); });
    const decided = await client.callTool({ name: "rig_seat_decide_permission", arguments: { askId, option: "allow", relay: true, personSaid: "Yes, commit it" } });
    expect(decided.isError).toBeFalsy();
    expect(decided.structuredContent).toMatchObject({ ok: true, state: "answered", optionId: "allow",
      native: { hook: "claude-code", answeredAs: "relayed", by: "someone outside a seat", reported: "Yes, commit it" } });
    const again = await client.callTool({ name: "rig_seat_decide_permission", arguments: { askId, option: "deny", relay: true, personSaid: "no" } });
    expect(again.structuredContent).toMatchObject({ ok: true, state: "answered", optionId: "allow", native: { unchanged: true } });
    const unknown = await client.callTool({ name: "rig_seat_decide_permission", arguments: { askId: "qitem-runner-permission-000000000000000000000000", option: "allow" } });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ ok: false, code: "not_found", status: 404 });
    // Its hook was reading (it had just submitted), so the reply said nothing of the kind below.
    expect((decided.structuredContent as { native: Record<string, unknown> }).native).not.toHaveProperty("notReached");

    // The seat's next prompt, whose hook was then killed outright: two minutes on, an answer is recorded and the tool's reply
    // says plainly that it hasn't reached the seat's prompt.
    const next = await permissions.submit({ nodeId: node.id, sessionName: "dev-build@team", generation: sessions.currentOccupantTenure(node.id)!.generationUuid }, {
      nativeRef: "claude-session-1", turnId: "invocation-2", requestId: "invocation-2", nativeHook: "claude-code", holdSeconds: 86400,
      action: { tool: "Bash", input: { command: "git push origin feature" }, agent: null }, toolCall: { title: "Bash", kind: "Bash" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60_000);
      const orphaned = await client.callTool({ name: "rig_seat_decide_permission",
        arguments: { askId: (next as { askId: string }).askId, option: "allow", relay: true, personSaid: "yes" } });
      expect(orphaned.isError).toBeFalsy();
      expect(orphaned.structuredContent).toMatchObject({ ok: true, state: "answered", optionId: "allow",
        native: { answeredAs: "relayed", notReached: expect.stringContaining("It hasn't reached dev-build@team's prompt") } });
    } finally {
      vi.useRealTimers();
    }
  });

  // claude12's F12b: the conversation that handed the work over, with no seat, answers its seat's ask through the plugin's
  // MCP tool. The decision names the address OpenRig issued it (under the key its own stdio server derives), as
  // OPENRIG_SESSION_NAME=<address> does in a shell, not "someone outside a seat". That's attribution only: a relay still
  // reads relayed and unconfirmed. Another conversation's server, whose key wasn't issued that address, isn't it.
  it("records a seatless conversation's decision on its own ask as its issued address, never as the person's own answer", async () => {
    const rigs = new RigRepository(db);
    const node = rigs.addNode(rigs.createRig("team").id, "dev.build", { runtime: "claude-code" });
    const sessions = new SessionRegistry(db);
    sessions.updateStatus(sessions.registerSession(node.id, "dev-build@team").id, "running");
    delete process.env.OPENRIG_SESSION_NAME;
    const conversation = async (key: string) => {
      const mcp = createMcpServer(new DaemonClient(url), { conversationKey: () => key });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "conversation", version: "1.0.0" });
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      closers.push(async () => { await client.close(); await mcp.close(); });
      return client;
    };
    const mine = await conversation("claude:conversation-1:4242");
    const other = await conversation("claude:conversation-2:4343");
    // The handoff, through the same server: with no seat, OpenRig issues this conversation an address under its key.
    expect((await mine.callTool({ name: "rig_queue_create", arguments: { destination: "dev-build@team", body: "Add the feature" } })).isError).toBeFalsy();
    const permissions = new RunnerPermissions({ db, queueRepo: new QueueRepository(db, new EventBus(db), { validateRig: () => true }), eventBus: new EventBus(db),
      humanRegistry: () => ({ ok: true, entities: [] }) as never, ownerOf: () => null, currentGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null });
    const ask = async (turn: string) => {
      const submitted = await permissions.submit({ nodeId: node.id, sessionName: "dev-build@team", generation: sessions.currentOccupantTenure(node.id)!.generationUuid }, {
        nativeRef: "claude-session-1", turnId: turn, requestId: turn, nativeHook: "claude-code", holdSeconds: 86400,
        action: { tool: "Bash", input: { command: `git commit -m '${turn}'` }, agent: null }, toolCall: { title: "Bash", kind: "Bash" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
      return submitted as { askId: string; askedOf: string };
    };
    const first = await ask("invocation-1");
    expect(first.askedOf).toMatch(/^conversation-[0-9a-f]{12}@kernel$/);
    const decided = await mine.callTool({ name: "rig_seat_decide_permission", arguments: { askId: first.askId, option: "allow", relay: true, personSaid: "yes" } });
    expect(decided.structuredContent).toMatchObject({ ok: true, state: "answered", optionId: "allow",
      native: { answeredAs: "relayed", by: first.askedOf, reported: "yes",
        message: `Allowed once: ${first.askedOf} relayed this as the person's answer (unconfirmed: OpenRig didn't get this answer from them). ${first.askedOf} reports they said: "yes"` } });
    // Another conversation's server can't take this conversation's address: it decides as before, outside a seat.
    const second = await ask("invocation-2");
    expect((await other.callTool({ name: "rig_seat_decide_permission", arguments: { askId: second.askId, option: "deny", reason: "not this one" } })).structuredContent)
      .toMatchObject({ ok: true, state: "answered", optionId: "deny", native: { answeredAs: "agent", by: "someone outside a seat" } });
  });

  // R3: with no seat, the conversation closes a team question sent to its issued address with the same MCP tools a seat
  // uses (claim, then update with the person's words as the resolution), as that address, so the question keeps its
  // answer and the seat's work parked on it comes back. Another conversation's server isn't that address: as before, its
  // update names no sender and nothing changes.
  it("lets a seatless conversation claim and close a question sent to its issued address, as that address", async () => {
    delete process.env.OPENRIG_SESSION_NAME;
    const conversation = async (key: string) => {
      const mcp = createMcpServer(new DaemonClient(url), { conversationKey: () => key });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "conversation", version: "1.0.0" });
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      closers.push(async () => { await client.close(); await mcp.close(); });
      return client;
    };
    const mine = await conversation("claude:conversation-1:4242");
    const other = await conversation("claude:conversation-2:4343");
    expect((await mine.callTool({ name: "rig_queue_create", arguments: { destination: "dev-build@team", body: "Add the feature" } })).isError).toBeFalsy();
    const listed = await new DaemonClient(url).get(`/api/queue/list?${new URLSearchParams({ destinationSession: "dev-build@team" })}`);
    const work = (listed.data as Array<{ qitemId: string; returnRoute: string }>)[0]!;
    const address = work.returnRoute;
    expect(address).toMatch(/^conversation-[0-9a-f]{12}@kernel$/);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const question = await repo.create({ sourceSession: "dev-build@team", destinationSession: address, body: "Exclude all four files?" });
    repo.update({ qitemId: work.qitemId, actorSession: "dev-build@team", state: "blocked", blockedOn: question.qitemId });
    expect(repo.getById(work.qitemId)?.state).toBe("blocked");

    const elsewhere = await other.callTool({ name: "rig_queue_update",
      arguments: { qitemId: question.qitemId, state: "done", closureReason: "no-follow-on", resolution: "Yes" } });
    expect(elsewhere.isError).toBe(true);
    expect(repo.getById(question.qitemId)?.state).toBe("pending");

    expect((await mine.callTool({ name: "rig_queue_claim", arguments: { qitemId: question.qitemId } })).isError).toBeFalsy();
    expect(repo.getById(question.qitemId)?.state).toBe("in-progress");
    expect((await mine.callTool({ name: "rig_queue_update",
      arguments: { qitemId: question.qitemId, state: "done", closureReason: "no-follow-on", resolution: "Yes, exclude all four" } })).isError).toBeFalsy();
    expect(repo.getById(question.qitemId)).toMatchObject({ state: "done", resolution: "Yes, exclude all four" });
    expect(repo.listTransitions(question.qitemId).slice(-2).map((t) => t.actorSession)).toEqual([address, address]);
    expect(repo.getById(work.qitemId)?.state).toBe("pending");
  });

  /** The plugin's stdio server in a conversation whose key is `key`, as `rig mcp serve` derives it. */
  async function conversationServer(key: string) {
    const mcp = createMcpServer(new DaemonClient(url), { conversationKey: () => key });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "conversation", version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await mcp.close(); });
    return client;
  }
  const createdId = (result: unknown): string =>
    JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text).qitemId as string;

  // Slice 15 for 0.7.25: a person's own conversation hears its team's questions even when its MCP entry names a seat for
  // its tools. Its create gets the issued route by default, with the configured seat still the sender; it acts as that
  // address on a question sent there; and an explicit returnRoute still decides.
  it("gives an outside conversation with a configured seat its issued return route by default, and lets it act as that address", async () => {
    const seat = "cursor@team";
    const mine = await conversationServer("claude:conversation-1:4242");
    process.env.OPENRIG_SESSION_NAME = seat;
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const created = await mine.callTool({ name: "rig_queue_create", arguments: { destination: "dev-build@team", body: "Add the feature" } });
    expect(created.isError).toBeFalsy();
    const work = repo.getById(createdId(created))!;
    expect(work).toMatchObject({ sourceSession: seat, returnRouteBasis: "issued" });
    expect(work.returnRoute).toMatch(/^conversation-[0-9a-f]{12}@kernel$/);
    expect(work.tags?.some((tag) => tag.endsWith(":claude:conversation-1:4242"))).toBe(true);

    const question = await repo.create({ sourceSession: "dev-build@team", destinationSession: work.returnRoute!, body: "Exclude all four files?" });
    expect((await mine.callTool({ name: "rig_queue_claim", arguments: { qitemId: question.qitemId } })).isError).toBeFalsy();
    expect((await mine.callTool({ name: "rig_queue_update",
      arguments: { qitemId: question.qitemId, state: "done", closureReason: "no-follow-on", resolution: "Yes, exclude all four" } })).isError).toBeFalsy();
    expect(repo.getById(question.qitemId)).toMatchObject({ state: "done", resolution: "Yes, exclude all four" });
    expect(repo.listTransitions(question.qitemId).slice(-2).map((t) => t.actorSession)).toEqual([work.returnRoute, work.returnRoute]);

    const own = await mine.callTool({ name: "rig_queue_create", arguments: { destination: "dev-build@team", body: "Another", returnRoute: "self" } });
    expect(repo.getById(createdId(own))).toMatchObject({ returnRoute: seat, returnRouteBasis: "caller" });
  });

  // Under a seat OpenRig launched (OPENRIG_NODE_ID in the server's env, as Claude Code passes it on), a configured seat is
  // that seat's own tool identity: no default route, with or without a configured seat, since the hooks never read an issued
  // address there, and the server acts as itself, never as an issued address. An explicit auto still issues one.
  it("gives no default return route under a seat OpenRig launched, configured or not, and an explicit auto still issues one", async () => {
    const mine = await conversationServer("claude:conversation-1:4242");
    process.env.OPENRIG_NODE_ID = "01KXTESTNODE";
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    for (const seat of ["dev-build@team", undefined]) {
      if (seat) process.env.OPENRIG_SESSION_NAME = seat; else delete process.env.OPENRIG_SESSION_NAME;
      const created = await mine.callTool({ name: "rig_queue_create", arguments: { destination: IMPL, body: `From ${seat ?? "no seat"}` } });
      expect(created.isError).toBeFalsy();
      const row = repo.getById(createdId(created))!;
      expect(row.returnRoute ?? null).toBeNull();
      expect(row.tags?.some((tag) => tag.endsWith(":claude:conversation-1:4242")) ?? false).toBe(false);
    }

    process.env.OPENRIG_SESSION_NAME = "dev-build@team";
    const explicit = await mine.callTool({ name: "rig_queue_create", arguments: { destination: IMPL, body: "Explicit", returnRoute: "auto" } });
    const issued = repo.getById(createdId(explicit))!;
    expect(issued).toMatchObject({ sourceSession: "dev-build@team", returnRouteBasis: "issued" });
    expect(issued.returnRoute).toMatch(/^conversation-[0-9a-f]{12}@kernel$/);
    const question = await repo.create({ sourceSession: IMPL, destinationSession: issued.returnRoute!, body: "Which one?" });
    await mine.callTool({ name: "rig_queue_update", arguments: { qitemId: question.qitemId, state: "done", closureReason: "no-follow-on", resolution: "This one" } });
    expect(repo.listTransitions(question.qitemId).map((t) => t.actorSession)).not.toContain(issued.returnRoute);
  });
});
