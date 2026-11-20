// I3b: the MCP adapter's validated caller recorded beside the P21 stamp (principal:v1 + identity_principal), only on a
// direct attributed request from a loopback peer; everything else records exactly what it did before.
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { parseIdentityPrincipal, resolveRecordedIdentity } from "../src/routes/require-sender-identity.js";
import { createTestApp } from "./helpers/test-app.js";
import { vi } from "vitest";
import Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { identityPrincipalSchema } from "../src/db/migrations/140_identity_principal.js";

const ALICE = JSON.stringify({ source: "file", id: "alice" });
const GRANT_SERVICE = JSON.stringify({ source: "grant-service", id: "cus_VVMAexample01", grant: "8977f2dc0000aaaa1111bbbb", version: 6 });

/** A request as resolveRecordedIdentity reads it: its headers and its TCP peer. */
function request(headers: Record<string, string>, peer: string | null = "127.0.0.1"): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { req: { header: (name: string) => lower[name.toLowerCase()] }, env: peer === null ? {} : { incoming: { socket: { remoteAddress: peer } } } } as unknown as Context;
}

const databases: ReturnType<typeof createDb>[] = [];
const servers: ServerType[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  databases.splice(0).forEach((db) => db.close());
});
function database(migrations = ALL_MIGRATIONS) {
  const db = createDb(":memory:");
  databases.push(db);
  migrate(db, migrations);
  return db;
}

describe("principal:v1: the adapter's caller, only on a direct attributed request", () => {
  it("records the principal only for transport:v1 from a loopback peer with the closed shape; otherwise exactly today's stamp", () => {
    const direct = { "X-OpenRig-Session": "alice@team", "X-OpenRig-Principal": ALICE };
    const attributed = { provenance: "transport:v1" as const };
    expect(resolveRecordedIdentity(request(direct), attributed)).toEqual({ identityProvenance: "principal:v1", identityPrincipal: ALICE });
    expect(resolveRecordedIdentity(request(direct, "::ffff:127.0.0.1"), attributed).identityProvenance).toBe("principal:v1");
    expect(resolveRecordedIdentity(request({ ...direct, "X-OpenRig-Principal": GRANT_SERVICE }, "::1"), attributed).identityPrincipal).toBe(GRANT_SERVICE);

    const unchanged: Array<[string, Context, { provenance: "transport:v1" | "claimed:v1" | "origin-unknown:v1" }, string]> = [
      ["a remote peer", request(direct, "192.0.2.10"), attributed, "transport:v1"],
      ["no socket", request(direct, null), attributed, "transport:v1"],
      ["a relayed hop", request({ ...direct, "X-OpenRig-Relay": "host-b", "X-OpenRig-Provenance": "transport:v1" }), attributed, "relay:v1"],
      ["an unknown origin", request({ ...direct, "X-OpenRig-Origin-Unknown": "true" }), { provenance: "origin-unknown:v1" }, "origin-unknown:v1"],
      ["a claimed actor", request({ "X-OpenRig-Principal": ALICE }), { provenance: "claimed:v1" }, "claimed:v1"],
      ["no principal header", request({ "X-OpenRig-Session": "alice@team" }), attributed, "transport:v1"],
      // A same-host proxy or forwarder delivers a remote caller from loopback; its forwarding headers say so.
      ...["X-Forwarded-For", "Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "Via"].map((name) =>
        [`a forwarded request (${name})`, request({ ...direct, [name]: "203.0.113.7" }), attributed, "transport:v1"] as [string, Context, typeof attributed, string]),
    ];
    for (const [, c, identity, expected] of unchanged) {
      expect(resolveRecordedIdentity(c, identity)).toEqual({ identityProvenance: expected, identityPrincipal: null });
    }
  });

  it("accepts only the closed shape and never stores more than it names", () => {
    for (const bad of [
      "not json", "[]", "null", JSON.stringify({ source: "env", id: "x" }), JSON.stringify({ source: "file", id: "" }),
      JSON.stringify({ source: "file", id: "x", token: "orm_secret" }), JSON.stringify({ source: "grant-service", id: "x", grant: 5 }),
      // No other name stands in for a source, a retired one included.
      JSON.stringify({ source: "legacy-service", id: "x" }),
      JSON.stringify({ source: "file", id: "x".repeat(600) }),
    ]) expect(parseIdentityPrincipal(bad)).toBeNull();
    expect(parseIdentityPrincipal(JSON.stringify({ version: 6, grant: "g", id: "cus_x", source: "grant-service" })))
      .toBe(JSON.stringify({ source: "grant-service", id: "cus_x", grant: "g", version: 6 }));
  });

  it("keeps a principal only beside principal:v1, and a principal:v1 without one records the seat's stamp", () => {
    const db = database();
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
      VALUES ('q1', 'x', 'x', 'alice@team', 'impl@team', 'pending', 'routine', 'b')`).run();
    const log = new QueueTransitionLog(db);
    expect(log.append({ qitemId: "q1", state: "pending", actorSession: "alice@team", identityProvenance: "principal:v1", identityPrincipal: ALICE }))
      .toMatchObject({ identityProvenance: "principal:v1", identityPrincipal: ALICE });
    expect(log.append({ qitemId: "q1", state: "pending", actorSession: "alice@team", identityProvenance: "principal:v1" }))
      .toMatchObject({ identityProvenance: "transport:v1", identityPrincipal: null });
    expect(log.append({ qitemId: "q1", state: "pending", actorSession: "alice@team", identityProvenance: "transport:v1", identityPrincipal: ALICE }))
      .toMatchObject({ identityProvenance: "transport:v1", identityPrincipal: null });

    const outbox = new OutboxHandler(db);
    const row = (id: string) => db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM outbox_entries WHERE outbox_id = ?").get(id);
    outbox.record({ outboxId: "o1", senderSession: "alice@team", destinationSession: "impl@team", body: "b", identityProvenance: "principal:v1", identityPrincipal: ALICE });
    outbox.record({ outboxId: "o2", senderSession: "alice@team", destinationSession: "impl@team", body: "b", identityProvenance: "principal:v1" });
    expect([row("o1"), row("o2")]).toEqual([{ p: "principal:v1", who: ALICE }, { p: "transport:v1", who: null }]);

    // A schema from before 140: today's stamp, never principal:v1 without its principal.
    const before = database(ALL_MIGRATIONS.filter((m) => m.name !== "140_identity_principal.sql"));
    before.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
      VALUES ('q1', 'x', 'x', 'alice@team', 'impl@team', 'pending', 'routine', 'b')`).run();
    expect(new QueueTransitionLog(before).append({ qitemId: "q1", state: "pending", actorSession: "alice@team", identityProvenance: "principal:v1", identityPrincipal: ALICE }).identityProvenance)
      .toBe("transport:v1");
  });

  it("moves a row's principal with it into the archive and back out through history", () => {
    const db = database();
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
      VALUES ('done1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'alice@team', 'impl@team', 'done', 'routine', 'b')`).run();
    new QueueTransitionLog(db).append({ qitemId: "done1", state: "done", actorSession: "alice@team", identityProvenance: "principal:v1", identityPrincipal: ALICE, closureReason: "no-follow-on" });
    db.prepare("UPDATE queue_transitions SET ts = '2026-01-01T00:00:00.000Z'").run();
    expect(archiveAgedTerminalTransitions(db, { nowIso: "2026-09-01T00:00:00.000Z", transitionsRetentionDays: 30 }).archivedRows).toBe(1);
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM queue_transitions_archive").get()).toEqual({ p: "principal:v1", who: ALICE });
    expect(new QueueTransitionLog(db).listForQitem("done1")[0]).toMatchObject({ identityProvenance: "principal:v1", identityPrincipal: ALICE });
  });

  it("over a real socket: the request's own transitions carry it, what they set off carries the seat's stamp, and a relayed or forged hop gets none", async () => {
    const db = database();
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(new OutboxHandler(db));
    const { app } = createTestApp(db, { appDeps: { queueRepo: repo } });
    const server = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/queue`;
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const as = (seat: string, principal?: string) => ({ "X-OpenRig-Session": seat, ...(principal ? { "X-OpenRig-Principal": principal } : {}) });
    const stamps = (id: string) => (db.prepare("SELECT identity_provenance AS p, identity_principal AS who, transition_note AS note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id").all(id) as Array<{ p: string; who: string | null; note: string }>);

    const created = await (await post("/create", { destinationSession: "lead@team", body: "task", nudge: false }, as("alice@team", ALICE))).json() as { qitemId: string };
    expect(stamps(created.qitemId)).toEqual([expect.objectContaining({ p: "principal:v1", who: ALICE, note: "created" })]);

    // The successor's created transition and the source close are the request's own; the wake it stages is not.
    expect((await post(`/${created.qitemId}/handoff`, { toSession: "impl@team", nudge: false }, as("lead@team", GRANT_SERVICE))).status).toBe(201);
    expect(stamps(created.qitemId).at(-1)).toMatchObject({ p: "principal:v1", who: GRANT_SERVICE });
    const successor = db.prepare("SELECT qitem_id AS id FROM queue_items WHERE handed_off_from = ?").get(created.qitemId) as { id: string };
    expect(stamps(successor.id)[0]).toMatchObject({ p: "principal:v1", who: GRANT_SERVICE });
    for (const wake of db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM outbox_entries").all()) {
      expect(wake).toEqual({ p: "transport:v1", who: null });
    }

    // Relayed, unknown-origin and malformed: today's stamp, no principal.
    const relayed = await (await post("/create", { destinationSession: "lead@team", body: "relayed", nudge: false },
      { ...as("bob@team", ALICE), "X-OpenRig-Relay": "host-b", "X-OpenRig-Provenance": "transport:v1" })).json() as { qitemId: string };
    expect(stamps(relayed.qitemId)[0]).toMatchObject({ p: "relay:v1", who: null });
    const unknownOrigin = await (await post("/create", { destinationSession: "lead@team", body: "x", nudge: false },
      { ...as("bob@team", ALICE), "X-OpenRig-Origin-Unknown": "true" })).json() as { qitemId: string };
    expect(stamps(unknownOrigin.qitemId)[0]).toMatchObject({ p: "origin-unknown:v1", who: null });
    const malformed = await (await post("/create", { destinationSession: "lead@team", body: "x", nudge: false },
      as("bob@team", JSON.stringify({ source: "file", id: "bob", token: "orm_secret" })))).json() as { qitemId: string };
    expect(stamps(malformed.qitemId)[0]).toMatchObject({ p: "transport:v1", who: null });

    // Claim, update and unclaim record it too.
    const work = await (await post("/create", { destinationSession: "carol@team", body: "work", nudge: false }, as("lead@team"))).json() as { qitemId: string };
    const carol = JSON.stringify({ source: "file", id: "carol" });
    expect((await post(`/${work.qitemId}/claim`, {}, as("carol@team", carol))).status).toBe(200);
    expect((await post(`/${work.qitemId}/update`, { transitionNote: "on it" }, as("carol@team", carol))).status).toBe(200);
    expect((await post(`/${work.qitemId}/unclaim`, { reason: "later" }, as("carol@team", carol))).status).toBe(200);
    expect(stamps(work.qitemId).map(({ p, who }) => [p, who])).toEqual([
      ["transport:v1", null], ["principal:v1", carol], ["principal:v1", carol], ["principal:v1", carol],
    ]);
  });
  it("a send the typing guard holds keeps the principal on the outbox row it retains", async () => {
    const db = new Database(":memory:");
    databases.push(db as never);
    db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a');");
    db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
    db.exec("ALTER TABLE outbox_entries ADD COLUMN identity_provenance TEXT;");
    db.exec(identityPrincipalSchema.sql.split("\n").filter((line) => line.includes("outbox_entries")).join("\n"));
    const target: GuardTarget = { nodeId: "a", session: "a", occupant: "g1", pane: "%1" };
    const guard = new SeatDeliveryGuard(db, (name) => (name === "a" || name === "%1" ? target : null));
    const tmux = new TmuxAdapter(async () => "", { writeFile: async () => {}, unlink: async () => {}, tmpName: () => "/inert/launch", bufferName: () => "inert-buffer" });
    tmux.deliveryGuard = guard;
    vi.spyOn(tmux, "listPanes").mockImplementation(async () => [{ id: "%1" } as never]);
    const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: {} as never, sessionRegistry: {} as never, sleep: async () => {} });
    await guard.set("a", true, "person", "draft");
    const held = await transport.send("a", "for alice", { actorSession: "alice@team", identityProvenance: "principal:v1", identityPrincipal: ALICE });
    expect(held).toMatchObject({ ok: true, outcome: "retained", sent: false });
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM outbox_entries").all()).toEqual([{ p: "principal:v1", who: ALICE }]);
  });

  it("the send route hands the transport the principal it decided before sending, and none for a forwarded request", async () => {
    const db = database();
    const sent: Array<Record<string, unknown>> = [];
    const transport = {
      resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "impl@team" }] }),
      send: async (_session: string, _text: string, opts: Record<string, unknown>) => { sent.push(opts); return { ok: true, sessionName: "impl@team", sent: true, outboxIds: ["held-1"] }; },
    };
    const { app } = createTestApp(db, { appDeps: { sessionTransport: transport as never } });
    const server = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    servers.push(server);
    const send = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/transport/send`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@team", "X-OpenRig-Principal": ALICE, ...headers },
      body: JSON.stringify({ session: "impl@team", text: "hello" }) });
    expect((await send({})).status).toBe(200);
    expect((await send({ "X-Forwarded-For": "203.0.113.7" })).status).toBe(200);
    expect(sent.map((opts) => [opts.identityProvenance, opts.identityPrincipal ?? null])).toEqual([["principal:v1", ALICE], ["transport:v1", null]]);
  });
});
