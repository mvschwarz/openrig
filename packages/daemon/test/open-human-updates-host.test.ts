import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { LoadResult } from "../src/domain/gateway/human-registry.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import { createTestApp } from "./helpers/test-app.js";

const person = (id: string): LoadResult => ({ ok: true, entities: [{ entityId: id, class: "human", displayName: id,
  address: id + "@external", connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "vault://fixture/" + id, role: "primary", handle: "U_FIXTURE" }], prefs: { deliveryClass: "B" } }] });

async function fixture(opts: { hosts?: HttpHostEntry[]; people?: LoadResult; fetchImpl?: typeof fetch } = {}) {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => opts.people ?? { ok: true, entities: [] } });
  const built = createTestApp(db, { appDeps: { queueRepo: queue } });
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    requests.push({ url: c.req.url, authorization: c.req.header("authorization") ?? null });
    c.set("hostRegistryLoader" as never, (() => ({ ok: true, registry: { hosts: opts.hosts ?? [] } })) as never);
    if (opts.fetchImpl) c.set("remoteFetchImpl" as never, opts.fetchImpl as never);
    await next();
  });
  // Exercise the production middleware order and actual queue route, not a queue-only route fixture.
  app.route("/", built.app);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind an owned HTTP port");
  const origin = "http://127.0.0.1:" + address.port;
  const row = (id: string, destination = "human@kernel", priority = "routine") => db.prepare(
    "INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,human_intent) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).run(id, "2026-11-23T00:00:00Z", "2026-11-23T00:00:00Z", "author@fixture", destination, "pending", priority, "Body " + id, "Summary " + id, "update");
  return { db, queue, origin, requests, row, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  } };
}

it.each(["configured", "tokenless"] as const)("FYI host target uses %s credentials and the origin view over actual HTTP", async (mode) => {
  const remote = await fixture({ people: person("remote-person") });
  const host: HttpHostEntry = { id: "other", transport: "http", url: remote.origin,
    ...(mode === "configured" ? { bearer_env: "OPENRIG_FYI_TEST_TOKEN" } : {}) };
  const home = await fixture({ hosts: [host], people: person("home-person") });
  const previous = process.env.OPENRIG_FYI_TEST_TOKEN;
  process.env.OPENRIG_FYI_TEST_TOKEN = "target-token";
  try {
    remote.row("remote-top", "remote-person@external", "urgent"); remote.row("remote-tail", "remote-person@external"); home.row("home-only", "home-person@external");
    const query = "/api/queue/open-human-updates?view=remote-person&limit=1";
    const expected = await (await fetch(remote.origin + query)).json(); remote.requests.length = 0;
    const localRead = vi.spyOn(home.queue, "listOpenHumanUpdates");
    const before = remote.db.serialize();
    const result = await fetch(home.origin + query + "&host=other", { headers: { Authorization: "Bearer application-token" } });
    expect(result.status).toBe(200); const body = await result.json(); expect(body).toEqual(expected);
    expect(body).toMatchObject({ limit: 1, truncated: true, perspective: { basis: "chosen-here", viewing: "remote-person@external" }, items: [{ qitemId: "remote-top", humanIntent: "update" }] });
    expect(localRead).not.toHaveBeenCalled(); expect(remote.requests).toHaveLength(1);
    const forwarded = new URL(remote.requests[0]!.url);
    expect(forwarded.searchParams.has("host")).toBe(false); expect(forwarded.searchParams.get("view")).toBe("remote-person");
    expect(remote.requests[0]!.authorization).toBe(mode === "configured" ? "Bearer target-token" : null);
    expect(remote.db.serialize().equals(before)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OPENRIG_FYI_TEST_TOKEN; else process.env.OPENRIG_FYI_TEST_TOKEN = previous;
    await home.close(); await remote.close();
  }
}, 15_000);

it.each(["empty", "unavailable"] as const)("FYI host %s people registry stays unfiltered without inventing a perspective", async (mode) => {
  const remote = await fixture({ people: mode === "empty" ? { ok: true, entities: [] } : { ok: false, error: "fixture registry unavailable" } });
  const home = await fixture({ hosts: [{ id: "other", transport: "http", url: remote.origin }], people: person("home-person") });
  try {
    remote.row("target-open"); home.row("home-only");
    const response = await fetch(home.origin + "/api/queue/open-human-updates?host=other&view=missing&limit=20");
    expect(response.status).toBe(200); const body = await response.json();
    expect(body).toMatchObject({ items: [{ qitemId: "target-open", humanIntent: "update" }], limit: 20, truncated: false });
    expect(body).not.toHaveProperty("perspective");
  } finally { await home.close(); await remote.close(); }
}, 15_000);

it("FYI host unknown named view remains empty and explicitly unknown at the origin", async () => {
  const remote = await fixture({ people: person("remote-person") });
  const home = await fixture({ hosts: [{ id: "other", transport: "http", url: remote.origin }] });
  try {
    remote.row("target-open", "remote-person@external");
    const response = await fetch(home.origin + "/api/queue/open-human-updates?host=other&view=missing");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], perspective: { basis: "unknown", requested: "missing" } });
  } finally { await home.close(); await remote.close(); }
}, 15_000);

it("FYI host unavailable target is a read failure without a local or all-host fallback", async () => {
  let calls = 0;
  const home = await fixture({ hosts: [{ id: "other", transport: "http", url: "http://unavailable.invalid:7433" }],
    fetchImpl: (async () => { calls++; throw new Error("fixture target offline"); }) as typeof fetch });
  try {
    home.row("must-not-read"); const localRead = vi.spyOn(home.queue, "listOpenHumanUpdates");
    const response = await fetch(home.origin + "/api/queue/open-human-updates?host=other");
    expect(response.status).toBe(502); const body = await response.json();
    expect(body).toMatchObject({ error: "remote_read_failed", hostId: "other", failureClass: "unreachable" });
    expect(body).not.toHaveProperty("items"); expect(calls).toBe(1); expect(localRead).not.toHaveBeenCalled();
  } finally { await home.close(); }
}, 15_000);

it("FYI host unknown target is resolved before any read or dial", async () => {
  let calls = 0;
  const home = await fixture({ fetchImpl: (async () => { calls++; throw new Error("must not dial"); }) as typeof fetch });
  try {
    home.row("must-not-read"); const localRead = vi.spyOn(home.queue, "listOpenHumanUpdates");
    const response = await fetch(home.origin + "/api/queue/open-human-updates?host=missing");
    expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ error: "remote_read_failed", hostId: "missing", failureClass: "unknown-host" });
    expect(calls).toBe(0); expect(localRead).not.toHaveBeenCalled();
  } finally { await home.close(); }
}, 15_000);
