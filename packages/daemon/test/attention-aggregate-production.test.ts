import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import { getSelfHostId, setSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { createTestApp } from "./helpers/test-app.js";

async function fixture(hosts: HttpHostEntry[] = [], subscriptions: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "attention-http-"));
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db));
  const settings = new SettingsStore(join(dir, "config.json"));
  for (const id of subscriptions) settings.set("feed.subscriptions." + id + ".enabled", "true");
  const built = createTestApp(db, { appDeps: { queueRepo: queue, settingsStore: settings } });
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    requests.push({ path: new URL(c.req.url).pathname, authorization: c.req.header("authorization") ?? null });
    c.set("hostRegistryLoader" as never, (() => ({ ok: true, registry: { hosts } })) as never);
    await next();
  });
  // createTestApp calls production createApp, including the global read-through.
  app.route("/", built.app);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a port");
  const origin = "http://127.0.0.1:" + address.port;
  const row = (id: string) => db.prepare(
    "INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary) VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(id, "2026-11-23T00:00:00Z", "2026-11-23T00:00:00Z", "author@fixture", "human-founder@external", "pending", "urgent", "Body " + id, "Summary " + id);
  return { db, queue, settings, requests, origin, row, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

it.each(["configured", "tokenless"] as const)("production aggregate selects its target with %s credentials, without origin fan-out", async (mode) => {
  const unrelated = await fixture();
  const remote = await fixture([{ id: "unrelated", transport: "http", url: unrelated.origin }], ["unrelated"]);
  const host: HttpHostEntry = { id: "other", transport: "http", url: remote.origin,
    ...(mode === "configured" ? { bearer_env: "OPENRIG_ATTENTION_TEST_TOKEN" } : {}) };
  const home = await fixture([host, { id: "unrelated", transport: "http", url: unrelated.origin }], ["unrelated"]);
  const beforeToken = process.env.OPENRIG_ATTENTION_TEST_TOKEN;
  process.env.OPENRIG_ATTENTION_TEST_TOKEN = "target-token";
  try {
    remote.row("target-row"); home.row("home-row"); unrelated.row("unrelated-row");
    const localRead = vi.spyOn(home.queue, "listAttention");
    const subscriptions = vi.spyOn(home.settings, "listFeedHostSubscriptions");
    const before = remote.db.serialize();
    const response = await fetch(home.origin + "/api/queue/attention-aggregate?host=other", { headers: { Authorization: "Bearer application-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ qitemId: "target-row", hostId: "other" }], hosts: [{ hostId: "other", status: "ok" }] });
    expect(localRead).not.toHaveBeenCalled(); expect(subscriptions).not.toHaveBeenCalled();
    expect(unrelated.requests).toEqual([]);
    expect(remote.requests).toEqual([{ path: "/api/queue/list", authorization: mode === "configured" ? "Bearer target-token" : null }]);
    expect(remote.db.serialize().equals(before)).toBe(true);
  } finally {
    if (beforeToken === undefined) delete process.env.OPENRIG_ATTENTION_TEST_TOKEN; else process.env.OPENRIG_ATTENTION_TEST_TOKEN = beforeToken;
    await home.close(); await remote.close(); await unrelated.close();
  }
}, 15_000);

it("production aggregate reports unknown and unavailable targets without local fallback", async () => {
  const offline = await fixture(); const offlineUrl = offline.origin; await offline.close();
  const home = await fixture([{ id: "offline", transport: "http", url: offlineUrl }]);
  try {
    home.row("home-row"); const localRead = vi.spyOn(home.queue, "listAttention");
    for (const id of ["missing", "offline"]) {
      const response = await fetch(home.origin + "/api/queue/attention-aggregate?host=" + id);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: [], hosts: [{ hostId: id, status: "unreachable", error: expect.any(String) }] });
    }
    expect(localRead).not.toHaveBeenCalled();
  } finally { await home.close(); }
}, 15_000);

it("production aggregate keeps absent-host fan-out, literal local, and explicit self-id selection distinct", async () => {
  const remote = await fixture();
  const home = await fixture([{ id: "self-fixture", transport: "http", url: remote.origin }], ["self-fixture"]);
  const previous = getSelfHostId(); setSelfHostId("self-fixture");
  try {
    home.row("home-row"); remote.row("target-row");
    const read = async (query: string) => {
      const response = await fetch(home.origin + "/api/queue/attention-aggregate" + query);
      expect(response.status).toBe(200); return response.json();
    };
    expect((await read("")).items.map((r: { qitemId: string }) => r.qitemId)).toEqual(["home-row", "target-row"]);
    expect(await read("?host=local")).toMatchObject({ items: [{ qitemId: "home-row", hostId: "local" }], hosts: [{ hostId: "local", status: "ok" }] });
    expect(await read("?host=self-fixture")).toMatchObject({ items: [{ qitemId: "target-row", hostId: "self-fixture" }], hosts: [{ hostId: "self-fixture", status: "ok" }] });
  } finally { setSelfHostId(previous); await home.close(); await remote.close(); }
}, 15_000);

it("production aggregate exception is GET-only and leaves other queue reads unchanged", async () => {
  const home = await fixture();
  try {
    const post = await fetch(home.origin + "/api/queue/attention-aggregate?host=other", { method: "POST" });
    expect(post.status).toBe(405); expect(await post.json()).toMatchObject({ error: "cross_host_write_refused" });
    const list = await fetch(home.origin + "/api/queue/list?host=other");
    expect(list.status).toBe(403); expect(await list.json()).toMatchObject({ error: "read_through_path_not_allowed" });
  } finally { await home.close(); }
}, 15_000);
