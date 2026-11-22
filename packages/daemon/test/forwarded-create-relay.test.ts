// #3018 — a forwarded queue create (`rig queue create --host <id>`) used to reach the host that keeps the record with
// only the body's sourceSession, so the receiving hop recorded `claimed:v1`. The forwarding daemon now relays the
// identity it resolved: the sender header re-stamped with its own host suffix (the value the forwarded body's
// sourceSession already carries), the relay marker, the carried provenance, and `Via` so a loopback receiver does not
// read the hop as a direct local client. A request with no transport identity stays header-less: a body claim is never
// laundered into a relayed one.
import { afterEach, describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { queueRoutes, relayedSenderHeaders } from "../src/routes/queue.js";
import { createTestApp } from "./helpers/test-app.js";

/** A request as relayedSenderHeaders reads it: just its headers. */
function request(headers: Record<string, string>): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { req: { header: (name: string) => lower[name.toLowerCase()] } } as unknown as Context;
}

const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  setSelfHostId(null);
});
function database() {
  const db = createDb(":memory:");
  databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  return db;
}

describe("#3018 relayedSenderHeaders: the identity a forwarding daemon hands to the host that keeps the record", () => {
  it("re-stamps the sender with this host's suffix and marks the request as a relay", () => {
    setSelfHostId("host-forwarder");
    expect(relayedSenderHeaders(request({ "x-openrig-session": "orch@rig-a" }))).toEqual({
      "x-openrig-session": "orch@rig-a@host-forwarder",
      "x-openrig-relay": "host-forwarder",
      via: "host-forwarder",
      "x-openrig-provenance": "transport:v1",
    });
  });

  it("carries claimed:v1 when the arriving request was itself a relay, so a second hop never strengthens it", () => {
    setSelfHostId("host-forwarder");
    const relayed = relayedSenderHeaders(request({ "x-openrig-session": "orch@rig-a@host-a", "x-openrig-relay": "host-a" }));
    expect(relayed?.["x-openrig-provenance"]).toBe("claimed:v1");
    expect(relayed?.["x-openrig-session"]).toBe("orch@rig-a@host-a");
  });

  it("keeps the origin-unknown marker and the sender verbatim", () => {
    setSelfHostId("host-forwarder");
    expect(relayedSenderHeaders(request({ "x-openrig-session": "orch@rig-a@owner@host-a", "x-openrig-origin-unknown": "true" }))).toEqual({
      "x-openrig-session": "orch@rig-a@owner@host-a",
      "x-openrig-origin-unknown": "true",
      "x-openrig-relay": "host-forwarder",
      via: "host-forwarder",
      "x-openrig-provenance": "origin-unknown:v1",
    });
  });

  it("stays header-less with no transport identity or no resolved self id (a body claim is never laundered)", () => {
    setSelfHostId("host-forwarder");
    expect(relayedSenderHeaders(request({}))).toBeUndefined();
    setSelfHostId(null);
    expect(relayedSenderHeaders(request({ "x-openrig-session": "orch@rig-a" }))).toBeUndefined();
  });
});

describe("#3018 a forwarded create relays the sender, so the host that keeps the record writes a relayed actor", () => {
  /** The forwarding daemon: its own registry entry for the receiver, its fetch replaying into that app. */
  function forwardingApp(receiver: Hono, forwarderRepo: QueueRepository, forwarderDb: ReturnType<typeof createDb>) {
    const forwarder = new Hono();
    forwarder.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("queueRepo", forwarderRepo);
      set("eventBus", new EventBus(forwarderDb));
      set("hostRegistryLoader", () => ({ ok: true, registry: { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433" }] } }));
      set("remoteFetchImpl", (async (url: string, init: RequestInit) => {
        // A real deployment's two daemons have their own ids; this in-process pair shares one global, so
        // switch it to the receiver's before its handlers read their own id (a foreign suffix is not stripped).
        setSelfHostId("host-receiver");
        return receiver.request(new URL(url).pathname, init);
      }) as typeof fetch);
      await next();
    });
    forwarder.route("/api/queue", queueRoutes());
    return forwarder;
  }

  const actorRow = (db: ReturnType<typeof database>, qitemId: string) =>
    db.prepare("SELECT actor_session AS actor, identity_provenance AS p, identity_principal AS who FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id").all(qitemId) as Array<{ actor: string; p: string; who: string | null }>;

  it("records the relayed actor and relay:v1 on the receiver; the forwarding daemon writes no row", async () => {
    const receiverDb = database();
    const receiverRepo = new QueueRepository(receiverDb, new EventBus(receiverDb), { validateRig: () => true });
    const { app: receiver } = createTestApp(receiverDb, { appDeps: { queueRepo: receiverRepo } });

    const forwarderDb = database();
    const forwarderRepo = new QueueRepository(forwarderDb, new EventBus(forwarderDb), { validateRig: () => true });
    const forwarder = forwardingApp(receiver, forwarderRepo, forwarderDb);

    setSelfHostId("host-forwarder");
    const res = await forwarder.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@rig-a" },
      body: JSON.stringify({ qitemId: "forwarded-1", destinationSession: "dev@rig-b", body: "do it", nudge: false, hostId: "vps-b" }),
    });
    expect(res.status).toBe(201);

    // Before the relay the receiver had only the forwarded body's sourceSession: claimed:v1, no sender.
    expect(actorRow(receiverDb, "forwarded-1")).toEqual([
      { actor: "orch@rig-a@host-forwarder", p: "relay:v1", who: null },
    ]);
    // Origin owns the record: nothing was written on the forwarding daemon.
    expect(forwarderRepo.getById("forwarded-1")).toBeNull();
  }, 30_000);

  it("forwards no identity header when the request carried none", async () => {
    const receiverDb = database();
    const receiverRepo = new QueueRepository(receiverDb, new EventBus(receiverDb), { validateRig: () => true });
    const { app: receiver } = createTestApp(receiverDb, { appDeps: { queueRepo: receiverRepo } });

    const forwarderDb = database();
    const forwarderRepo = new QueueRepository(forwarderDb, new EventBus(forwarderDb), { validateRig: () => true });
    const forwarder = forwardingApp(receiver, forwarderRepo, forwarderDb);
    const seen: Array<Record<string, string>> = [];
    const inner = receiver.request.bind(receiver);
    receiver.request = (async (input: string, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return inner(input, init);
    }) as typeof receiver.request;

    setSelfHostId("host-forwarder");
    const res = await forwarder.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qitemId: "forwarded-2", sourceSession: "orch@rig-a", destinationSession: "dev@rig-b", body: "do it", nudge: false, hostId: "vps-b" }),
    });
    expect(res.status).toBe(201);

    expect(seen[0]?.["x-openrig-session"]).toBeUndefined();
    expect(seen[0]?.["x-openrig-relay"]).toBeUndefined();
    expect(seen[0]?.via).toBeUndefined();
    // The body's stamped claim is the only identity the receiver has, and it stays claimed.
    expect(actorRow(receiverDb, "forwarded-2")).toEqual([
      { actor: "orch@rig-a@host-forwarder", p: "claimed:v1", who: null },
    ]);
  }, 30_000);
});
