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
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
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
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
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
});
