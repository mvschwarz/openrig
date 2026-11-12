// #3018 — reported-origin evidence on remote writes: the origin a non-local caller reports about itself is recorded as
// CLAIMED beside the receiving hop's transport identity and any loopback-established principal. Missing or malformed
// reads as unknown and never refuses a write; the claim is evidence only, never identity, actor, principal, or permission.
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
import { StreamStore } from "../src/domain/stream-store.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { MAX_CLAIMED_ORIGIN_LENGTH, claimedOriginFor, parseClaimedOrigin, resolveRecordedIdentity } from "../src/routes/require-sender-identity.js";
import { createTestApp } from "./helpers/test-app.js";

const ALICE = JSON.stringify({ source: "file", id: "alice" });

/** A request as the identity helpers read it: its headers and its TCP peer. */
function request(headers: Record<string, string>, peer: string | null = "192.0.2.10"): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { req: { header: (name: string) => lower[name.toLowerCase()] }, env: peer === null ? {} : { incoming: { socket: { remoteAddress: peer } } } } as unknown as Context;
}

const databases: ReturnType<typeof createDb>[] = [];
const servers: ServerType[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  databases.splice(0).forEach((db) => db.close());
});
function database() {
  const db = createDb(":memory:");
  databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  return db;
}

describe("#3018 parseClaimedOrigin: form only, bounded, unknown on anything else", () => {
  it("reads the third segment of the session-with-origin form", () => {
    expect(parseClaimedOrigin("alice@team@host-remote1")).toBe("host-remote1");
    expect(parseClaimedOrigin("  alice@team@mm2-openrig1  ")).toBe("mm2-openrig1");
    expect(parseClaimedOrigin("alice@team@host.1_a-b")).toBe("host.1_a-b");
    expect(parseClaimedOrigin(`alice@team@${"h".repeat(MAX_CLAIMED_ORIGIN_LENGTH)}`)).toBe("h".repeat(MAX_CLAIMED_ORIGIN_LENGTH));
  });

  it("reads every other shape as unknown, never as a refusal", () => {
    for (const unknown of [
      undefined, "", "   ", "alice", "alice@team", "alice@team@host@extra", "@team@host", "alice@@host", "alice@team@",
      "alice@team@..", "alice@team@-host", "alice@team@ho st", "alice@team@host/1", "alice@team@host:7433",
      `alice@team@${"h".repeat(MAX_CLAIMED_ORIGIN_LENGTH + 1)}`,
    ]) expect(parseClaimedOrigin(unknown), String(unknown)).toBeNull();
  });
});

describe("#3018 claimedOriginFor: remote hopped requests carry a claim, a direct local client does not", () => {
  const triple = { "X-OpenRig-Session": "alice@team@host-remote1" };
  it("parses the claim from a non-loopback peer", () => {
    expect(claimedOriginFor(request(triple))).toBe("host-remote1");
    expect(claimedOriginFor(request(triple, "2001:db8::7"))).toBe("host-remote1");
  });
  it("parses nothing from a direct local client, and a forwarded loopback request is not direct local", () => {
    expect(claimedOriginFor(request(triple, "127.0.0.1"))).toBeNull();
    expect(claimedOriginFor(request(triple, "::ffff:127.0.0.1"))).toBeNull();
    expect(claimedOriginFor(request({ ...triple, "X-Forwarded-For": "203.0.113.7" }, "127.0.0.1"))).toBe("host-remote1");
  });
});

describe("#3018 resolveRecordedIdentity: the claim rides beside, never inside, the stamp and principal", () => {
  it("records a remote claim beside the transport stamp, with no principal", () => {
    expect(resolveRecordedIdentity(request({ "X-OpenRig-Session": "alice@team@host-remote1", "X-OpenRig-Principal": ALICE }), { provenance: "transport:v1" }))
      .toEqual({ identityProvenance: "transport:v1", identityPrincipal: null, claimedOrigin: "host-remote1" });
  });

  it("keeps a loopback principal established and separate from a claimed origin", () => {
    expect(resolveRecordedIdentity(request({ "X-OpenRig-Session": "alice@team@host-local", "X-OpenRig-Principal": ALICE }, "127.0.0.1"), { provenance: "transport:v1" }))
      .toEqual({ identityProvenance: "principal:v1", identityPrincipal: ALICE, claimedOrigin: null });
    // A forwarded loopback request is not a local client: no principal, and its claim is evidence only.
    expect(resolveRecordedIdentity(request({ "X-OpenRig-Session": "alice@team@host-remote1", "X-OpenRig-Principal": ALICE, "X-Forwarded-For": "203.0.113.7" }, "127.0.0.1"), { provenance: "transport:v1" }))
      .toEqual({ identityProvenance: "transport:v1", identityPrincipal: null, claimedOrigin: "host-remote1" });
  });

  it("degrades a malformed or absent claim to unknown without touching the stamp", () => {
    for (const headers of [
      { "X-OpenRig-Session": "alice@team" },
      {},
      { "X-OpenRig-Session": "alice@team@host/1" },
      { "X-OpenRig-Session": "alice@team@host@extra" },
    ]) {
      expect(resolveRecordedIdentity(request(headers), { provenance: "transport:v1" }))
        .toEqual({ identityProvenance: "transport:v1", identityPrincipal: null, claimedOrigin: null });
    }
  });

  it("never strengthens a relayed or claimed actor with an origin claim", () => {
    expect(resolveRecordedIdentity(request({ "X-OpenRig-Session": "alice@team@host-remote1", "X-OpenRig-Relay": "host-relay", "X-OpenRig-Provenance": "transport:v1" }), { provenance: "transport:v1" }))
      .toMatchObject({ identityProvenance: "relay:v1", claimedOrigin: "host-remote1" });
    expect(resolveRecordedIdentity(request({ "X-OpenRig-Session": "alice@team@host-remote1" }), { provenance: "claimed:v1" }))
      .toMatchObject({ identityProvenance: "claimed:v1", claimedOrigin: "host-remote1" });
  });
});

describe("#3018 a remote write records the claim on the row it already writes", () => {
  const row = (db: ReturnType<typeof database>, qitemId: string) =>
    db.prepare("SELECT actor_session AS actor, identity_provenance AS p, identity_principal AS who, claimed_origin AS origin FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id").all(qitemId) as Array<{ actor: string; p: string; who: string | null; origin: string | null }>;

  it("records a remote stream claim through the HTTP route and returns it to readers", async () => {
    // Given a fully migrated stream store behind the real route.
    const db = database();
    const streams = new StreamStore(db, new EventBus(db));
    const { app } = createTestApp(db, { appDeps: { streamStore: streams } });
    // When a remote caller emits with its existing origin-qualified header.
    const response = await app.request("/api/stream/emit", {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@team@host-remote1" },
      body: JSON.stringify({ streamItemId: "remote-stream", body: "hello" }),
    });
    // Then the claim is evidence beside the unchanged transport-derived source.
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceSession: "alice@team@host-remote1", claimedOrigin: "host-remote1" });
    expect(streams.getById("remote-stream")).toMatchObject({ claimedOrigin: "host-remote1" });
  });

  it("returns a stored outbox claim alongside the sender", () => {
    // Given an outbox with the claimed-origin migration.
    const outbox = new OutboxHandler(database());
    // When it records the remote caller's evidence.
    outbox.record({ outboxId: "remote-outbox", senderSession: "alice@team@host-remote1", destinationSession: "impl@team",
      body: "hello", identityProvenance: "transport:v1", claimedOrigin: "host-remote1" });
    // Then readers can see the claim without reconstructing it from the sender.
    expect(outbox.getById("remote-outbox")).toMatchObject({ senderSession: "alice@team@host-remote1", claimedOrigin: "host-remote1" });
  });

  it("records the claim on create, claim and update; malformed and absent read as unknown and the write proceeds", async () => {
    const db = database();
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const { app } = createTestApp(db, { appDeps: { queueRepo: repo } });
    const create = (headers: Record<string, string>, body: Record<string, unknown>) =>
      app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ nudge: false, ...body }) });

    const claimed = await create({ "X-OpenRig-Session": "alice@team@host-remote1" }, { destinationSession: "impl@team", body: "task" });
    expect(claimed.status).toBe(201);
    expect(row(db, ((await claimed.json()) as { qitemId: string }).qitemId)).toEqual([
      { actor: "alice@team@host-remote1", p: "transport:v1", who: null, origin: "host-remote1" },
    ]);

    const malformed = await create({ "X-OpenRig-Session": "alice@team@host/1" }, { destinationSession: "impl@team", body: "task" });
    expect(malformed.status).toBe(201);
    expect(row(db, ((await malformed.json()) as { qitemId: string }).qitemId)).toEqual([
      { actor: "alice@team@host/1", p: "transport:v1", who: null, origin: null },
    ]);

    const absent = await create({}, { sourceSession: "bob@team", destinationSession: "impl@team", body: "task" });
    expect(absent.status).toBe(201);
    expect(row(db, ((await absent.json()) as { qitemId: string }).qitemId)).toEqual([
      { actor: "bob@team", p: "claimed:v1", who: null, origin: null },
    ]);

    const work = ((await (await create({ "X-OpenRig-Session": "lead@team@host-remote1" }, { destinationSession: "carol@team", body: "work" })).json()) as { qitemId: string }).qitemId;
    const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
      app.request(`/api/queue${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    // The claim and the update are this caller's own writes: each records the claim it carried.
    expect((await post(`/${work}/claim`, { "X-OpenRig-Session": "carol@team" })).status).toBe(200);
    expect((await post(`/${work}/update`, { "X-OpenRig-Session": "carol@team@host-remote1" }, { transitionNote: "on it" })).status).toBe(200);
    expect(row(db, work).map(({ p, origin }) => [p, origin])).toEqual([
      ["transport:v1", "host-remote1"], ["transport:v1", null], ["transport:v1", "host-remote1"],
    ]);
  }, 30_000);

  it("a forged claim grants nothing: no principal, the wire seat is the actor, and a wrong seat still refuses", async () => {
    const db = database();
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const { app } = createTestApp(db, { appDeps: { queueRepo: repo } });
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@team@host-evil", "X-OpenRig-Principal": ALICE },
      // The body names another actor; the wire seat supersedes it, exactly as it did before the claim existed.
      body: JSON.stringify({ sourceSession: "mallory@team", destinationSession: "carol@team", body: "work", nudge: false }),
    });
    expect(create.status).toBe(201);
    const qitemId = ((await create.json()) as { qitemId: string }).qitemId;
    expect(db.prepare("SELECT actor_session AS actor, identity_provenance AS p, identity_principal AS who, claimed_origin AS origin FROM queue_transitions WHERE qitem_id = ?").get(qitemId))
      .toEqual({ actor: "alice@team@host-evil", p: "transport:v1", who: null, origin: "host-evil" });

    // The claim grants nothing: the wrong seat is still refused with it and without it alike.
    for (const seat of ["mallory@team", "mallory@team@host-evil"]) {
      expect((await app.request(`/api/queue/${qitemId}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": seat }, body: JSON.stringify({}),
      })).status, seat).toBe(403);
    }
    // The holder claims it as it did before the claim existed: no refusal, no invented principal, no origin.
    expect((await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "carol@team" }, body: JSON.stringify({}),
    })).status).toBe(200);
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who, claimed_origin AS origin FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC").get(qitemId))
      .toEqual({ p: "transport:v1", who: null, origin: null });
  }, 30_000);

  it("over a real socket a loopback principal is established exactly as before, with no claimed origin", async () => {
    const db = database();
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const { app } = createTestApp(db, { appDeps: { queueRepo: repo } });
    const server = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/queue/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@team@host-self-claim", "X-OpenRig-Principal": ALICE },
      body: JSON.stringify({ destinationSession: "impl@team", body: "task", nudge: false }),
    });
    expect(res.status).toBe(201);
    const qitemId = ((await res.json()) as { qitemId: string }).qitemId;
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who, claimed_origin AS origin FROM queue_transitions WHERE qitem_id = ?").get(qitemId))
      .toEqual({ p: "principal:v1", who: ALICE, origin: null });
  }, 30_000);

  it("keeps the claim on the inbox, outbox and stream rows those stores write, and on the archived transition", () => {
    const db = database();
    const eventBus = new EventBus(db);
    const repo = new QueueRepository(db, eventBus, { validateRig: () => true });
    const outbox = new OutboxHandler(db);
    const inbox = new InboxHandler(db, eventBus, repo);
    const streams = new StreamStore(db, eventBus);

    inbox.drop({ destinationSession: "impl@team", senderSession: "alice@team@host-remote1", body: "b", identityProvenance: "transport:v1", claimedOrigin: "host-remote1" });
    outbox.record({ outboxId: "o1", senderSession: "alice@team@host-remote1", destinationSession: "impl@team", body: "b", identityProvenance: "transport:v1", claimedOrigin: "host-remote1" });
    streams.emit({ streamItemId: "s1", sourceSession: "alice@team@host-remote1", body: "b", identityProvenance: "transport:v1", claimedOrigin: "host-remote1" });
    expect(db.prepare("SELECT claimed_origin AS origin FROM inbox_entries").get()).toEqual({ origin: "host-remote1" });
    expect(db.prepare("SELECT claimed_origin AS origin FROM outbox_entries").get()).toEqual({ origin: "host-remote1" });
    expect(db.prepare("SELECT claimed_origin AS origin FROM stream_items").get()).toEqual({ origin: "host-remote1" });

    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
      VALUES ('done1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'alice@team@host-remote1', 'impl@team', 'done', 'routine', 'b')`).run();
    const log = new QueueTransitionLog(db);
    log.append({ qitemId: "done1", state: "done", actorSession: "alice@team@host-remote1", identityProvenance: "transport:v1", claimedOrigin: "host-remote1", closureReason: "no-follow-on" });
    db.prepare("UPDATE queue_transitions SET ts = '2026-01-01T00:00:00.000Z'").run();
    expect(archiveAgedTerminalTransitions(db, { nowIso: "2026-09-01T00:00:00.000Z", transitionsRetentionDays: 30 }).archivedRows).toBe(1);
    expect(db.prepare("SELECT claimed_origin AS origin FROM queue_transitions_archive").get()).toEqual({ origin: "host-remote1" });
    expect(log.listForQitem("done1")[0]).toMatchObject({ claimedOrigin: "host-remote1" });
  });
});
