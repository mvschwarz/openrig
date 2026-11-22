// #3728 — a refusal the daemon sees stays diagnosable when the caller loses stderr. Real routes, a real EventBus and a
// migrated SQLite. Three outcomes stay apart: (1) a refusal leaves one event and no row, (2) a send kept as a failed message
// in the sender's outbox (#3142) leaves its outbox row and no refusal event, (3) a forwarded write whose result is unknown
// leaves its own event, not a refusal. The refused command's response is the same with or without the event.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { PRUNABLE_EVENT_TYPES } from "../src/domain/queue-retention.js";
import { queueRoutes } from "../src/routes/queue.js";
import { transportRoutes } from "../src/routes/transport.js";
import { eventsRoute } from "../src/routes/events.js";

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { vi.useRealTimers(); databases.splice(0).forEach((db) => db.close()); });

function fixture(deps: { resolve?: unknown; fetchImpl?: typeof fetch; brokenBus?: boolean; advisory?: unknown } = {}) {
  const db = createDb(":memory:"); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  const outbox = new OutboxHandler(db);
  const transport = { resolveSessions: vi.fn(async () => deps.resolve ?? { ok: false, code: "not_found", error: "No session resolved" }), send: vi.fn() };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("db", db);
    // The sender-outbox path asks the repository for the destination status; the real lookup needs a topology.
    set("queueRepo", deps.advisory ? Object.assign(Object.create(repo), { destinationAdvisory: () => deps.advisory }) : repo); set("outboxHandler", outbox); set("sessionTransport", transport);
    set("eventBus", deps.brokenBus ? { emit: () => { throw new Error("event log unavailable"); } } : bus);
    set("hostRegistryLoader", () => ({ ok: true, registry: { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433" }] } }));
    if (deps.fetchImpl) set("remoteFetchImpl", deps.fetchImpl);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  app.route("/api/transport", transportRoutes());
  app.route("/api/events", eventsRoute);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@src-rig" }, body: JSON.stringify(body) });
  const postAnonymous = (path: string, body: unknown) => app.request(path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const events = (type: string) => (db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
  return { db, bus, outbox, post, postAnonymous, events, rows, app };
}

describe("#3728 (1) a refusal the daemon sees leaves one event, and the response is unchanged", () => {
  it("a queue create refused for a missing body is recorded with its reason, status and parties, never the body", async () => {
    const f = fixture();
    const res = await f.post("/api/queue/create", { destinationSession: "dev@dst-rig" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body is required" });
    expect(f.rows()).toBe(0);
    expect(f.events("queue.create_refused")).toEqual([{ type: "queue.create_refused", sourceSession: "sender@src-rig",
      destinationSession: "dev@dst-rig", reason: "body is required", status: 400, hostId: null }]);
  });

  it("a queue create refused with a coded error records that code", async () => {
    const f = fixture();
    const res = await f.post("/api/queue/create", { destinationSession: "dev@dst-rig", body: "x", returnRoute: "not an address" });
    expect(res.status).toBe(400);
    expect(f.events("queue.create_refused")).toMatchObject([{ reason: "invalid_return_route", status: 400, destinationSession: "dev@dst-rig" }]);
  });

  it("a create with no sender header records the actor it resolved from the body claim", async () => {
    const f = fixture();
    const res = await f.postAnonymous("/api/queue/create", { sourceSession: "claimed@src-rig", destinationSession: "dev@dst-rig" });
    expect(res.status).toBe(400);
    expect(f.events("queue.create_refused")).toMatchObject([{ sourceSession: "claimed@src-rig", reason: "body is required" }]);
  });

  it("a queue create naming an unregistered host is a refusal that names the host", async () => {
    const f = fixture({ fetchImpl: (async () => { throw new Error("unreachable in this test"); }) as typeof fetch });
    const res = await f.post("/api/queue/create", { destinationSession: "dev@dst-rig", body: "x", hostId: "nowhere" });
    expect(res.status).toBe(502);
    expect(f.events("queue.create_refused")).toMatchObject([{ reason: "remote_queue_write_failed", status: 502, hostId: "nowhere" }]);
    expect(f.events("queue.create_remote_unknown")).toEqual([]);
  });

  it("an accepted queue create leaves no refusal event", async () => {
    const f = fixture();
    const res = await f.post("/api/queue/create", { destinationSession: "ghost@nowhere", body: "x", nudge: false });
    expect(res.status).toBe(201);
    expect(f.events("queue.create_refused")).toEqual([]);
  });

  it("a send to a destination that does not resolve and cannot be kept in the outbox is recorded", async () => {
    const f = fixture();
    const res = await f.post("/api/transport/send", { session: "ghost@nowhere", submitOnly: true });
    expect(res.status).toBe(404);
    expect(f.events("transport.send_refused")).toEqual([{ type: "transport.send_refused", senderSession: "sender@src-rig",
      session: "ghost@nowhere", reason: "destination_not_found", status: 404 }]);
  });

  it("an ambiguous destination is recorded as its own reason", async () => {
    const f = fixture({ resolve: { ok: false, code: "ambiguous", error: "Two seats resolved" } });
    const res = await f.post("/api/transport/send", { session: "dev", text: "hi" });
    expect(res.status).toBe(409);
    expect(f.events("transport.send_refused")).toMatchObject([{ reason: "ambiguous_destination", status: 409 }]);
  });

  it("the events are read back through the existing /api/events replay and age out with the other history", async () => {
    const f = fixture();
    await f.post("/api/queue/create", { destinationSession: "dev@dst-rig" });
    const replay = f.bus.replayPage(0, f.bus.maxSeq(), 50, undefined, []);
    expect(replay.map((event) => event.type)).toContain("queue.create_refused");
    expect(PRUNABLE_EVENT_TYPES).toEqual(expect.arrayContaining(["queue.create_refused", "queue.create_remote_unknown", "transport.send_refused"]));
  });

  it("a send whose outbox record cannot be written is still recorded as a refusal", async () => {
    const f = fixture({ advisory: { code: "destination_status", status: "missing", destinationSession: "ghost@nowhere", availableDestinations: [], message: "No live seat." } });
    vi.spyOn(f.outbox, "record").mockImplementation(() => { throw new Error("disk full"); });
    const res = await f.post("/api/transport/send", { session: "ghost@nowhere", text: "keep this" });
    expect(res.status).toBe(503);
    expect(f.events("transport.send_refused")).toMatchObject([{ session: "ghost@nowhere", reason: "destination_not_found_unrecorded", status: 503 }]);
  });

  it("a send whose record was kept but could not be marked failed is not recorded as unrecorded", async () => {
    const f = fixture({ advisory: { code: "destination_status", status: "missing", destinationSession: "ghost@nowhere", availableDestinations: [], message: "No live seat." } });
    vi.spyOn(f.outbox, "markFailed").mockImplementation(() => { throw new Error("disk full"); });
    const res = await f.post("/api/transport/send", { session: "ghost@nowhere", text: "keep this" });
    const body = await res.json() as { outboxIds: string[] };
    expect(res.status).toBe(503);
    expect(body.outboxIds).toHaveLength(1);
    expect(f.outbox.getById(body.outboxIds[0]!)).toMatchObject({ senderSession: "sender@src-rig" });
    expect(f.events("transport.send_refused")).toEqual([]);
  });

  it("an event log that cannot be written does not change the refusal", async () => {
    const f = fixture({ brokenBus: true });
    const res = await f.post("/api/queue/create", { destinationSession: "dev@dst-rig" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body is required" });
  });
});

describe("#3728 (2) a send kept in the sender's outbox is not a refusal", () => {
  it("records the failed outbox message and no refusal event", async () => {
    const f = fixture({ advisory: { code: "destination_status", status: "missing", destinationSession: "ghost@nowhere", availableDestinations: [], message: "No live seat." } });
    const res = await f.post("/api/transport/send", { session: "ghost@nowhere", text: "keep this", exactText: "keep this" });
    const body = await res.json() as { outcome: string; outboxIds: string[] };
    expect(res.status).toBe(200);
    expect(body.outcome).toBe("recorded");
    expect(f.outbox.getById(body.outboxIds[0]!)).toMatchObject({ senderSession: "sender@src-rig", deliveryState: "failed" });
    expect(f.events("transport.send_refused")).toEqual([]);
  });
});

describe("#3728 (3) a forwarded write whose result is unknown is its own event, not a refusal", () => {
  it("a timed-out forward records the unknown outcome with the minted id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const f = fixture({ fetchImpl: hung });
    const pending = f.post("/api/queue/create", { qitemId: "qitem-remote-1", destinationSession: "dev@dst-rig", body: "x", hostId: "vps-b" });
    await vi.advanceTimersByTimeAsync(10_001);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_queue_write_failed", outcome: "indeterminate" });
    expect(f.events("queue.create_remote_unknown")).toEqual([{ type: "queue.create_remote_unknown", qitemId: "qitem-remote-1",
      sourceSession: "sender@src-rig", destinationSession: "dev@dst-rig", hostId: "vps-b", failureClass: "unreachable" }]);
    expect(f.events("queue.create_refused")).toEqual([]);
  });

  it("a timed-out forward with no qitemId records the id the daemon minted, the one it forwarded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const forwarded: string[] = [];
    const hung = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      forwarded.push((JSON.parse(init.body as string) as { qitemId: string }).qitemId);
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const f = fixture({ fetchImpl: hung });
    const pending = f.post("/api/queue/create", { destinationSession: "dev@dst-rig", body: "x", hostId: "vps-b" });
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(forwarded).toHaveLength(1);
    expect(f.events("queue.create_remote_unknown")).toMatchObject([{ qitemId: forwarded[0] }]);
  });

  it("a forward the remote host itself refused is a refusal, with the host named", async () => {
    const refused = (async () => new Response(JSON.stringify({ error: "body is required" }), { status: 400, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const f = fixture({ fetchImpl: refused });
    const res = await f.post("/api/queue/create", { destinationSession: "dev@dst-rig", body: "x", hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect(f.events("queue.create_refused")).toMatchObject([{ hostId: "vps-b", status: 502 }]);
    expect(f.events("queue.create_remote_unknown")).toEqual([]);
  });
});
