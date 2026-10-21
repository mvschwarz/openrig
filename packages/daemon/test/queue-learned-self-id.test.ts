// #1642: a queue forward accepts a host's learned self-id from the selected daemon's own home. The
// binding (`host-bindings.json`, written by `rig host doctor`) is eligible only while it records the URL
// it was learned at, that URL is still the entry's URL, and no conflicting observation is recorded.
// URL equality is an eligibility rule here, not live proof of identity. Self/local handling comes first;
// a registry id, then a declared hostId, outrank any binding; every other resolver caller is unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { resolveHost, resolvePlacementHost, type HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

const TOKEN = "host-5f2e9c1a";
const URL_B = "http://vm-b:7433";

type Binding = { hostId: string; firstObservedAt: string; lastObservedAt: string; observedUrl?: string; conflict?: { hostId: string; observedAt: string } };
const bound = (over: Partial<Binding> = {}): Binding => ({ hostId: TOKEN, firstObservedAt: "x", lastObservedAt: "x", observedUrl: URL_B, ...over });

function makeApp(db: Database.Database, registry: HostRegistry, bindings: Record<string, Binding> | null, forwarded: string[]): Hono {
  const bus = new EventBus(db);
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", queueRepo);
    set("hostRegistryLoader", () => ({ ok: true, registry }));
    set("hostBindingsLoader", () => ({ version: 1, bindings: bindings ?? {} }));
    set("remoteFetchImpl", (async (url: string | URL | Request) => {
      forwarded.push(String(url));
      return new Response(JSON.stringify({ qitemId: "qitem-origin-1", state: "pending" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

function create(app: Hono, hostId: string) {
  return app.request("/api/queue/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": "lead@build" },
    body: JSON.stringify({ sourceSession: "lead@build", destinationSession: "lead@delivery", body: "work", hostId, nudge: false }),
  });
}

function rows(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
}

describe("#1642: queue forwards accept an eligible learned self-id from the daemon's own home", () => {
  let db: Database.Database;
  let forwarded: string[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    forwarded = [];
  });
  afterEach(() => {
    setSelfHostId(null);
    db.close();
  });

  const REG_B: HostRegistry = { hosts: [{ id: "vm-b", transport: "http", url: URL_B }] };

  it("a binding learned at the entry's current URL, with no conflict, forwards to that entry", async () => {
    const res = await create(makeApp(db, REG_B, { "vm-b": bound() }, forwarded), TOKEN);
    expect(res.status).toBe(201);
    expect(forwarded).toEqual([`${URL_B}/api/queue/create`]);
    expect(rows(db)).toBe(0);
  });

  it("a registry id outranks a binding for the same token", async () => {
    const registry: HostRegistry = { hosts: [{ id: TOKEN, transport: "http", url: "http://vm-a:7433" }, { id: "vm-b", transport: "http", url: URL_B }] };
    await create(makeApp(db, registry, { "vm-b": bound() }, forwarded), TOKEN);
    expect(forwarded).toEqual(["http://vm-a:7433/api/queue/create"]);
  });

  it("a declared hostId outranks a binding for the same token", async () => {
    const registry: HostRegistry = { hosts: [{ id: "vm-a", transport: "http", url: "http://vm-a:7433", hostId: TOKEN }, { id: "vm-b", transport: "http", url: URL_B }] };
    await create(makeApp(db, registry, { "vm-b": bound() }, forwarded), TOKEN);
    expect(forwarded).toEqual(["http://vm-a:7433/api/queue/create"]);
  });

  it("the daemon's own self-id still takes the local path, whatever the bindings say", async () => {
    setSelfHostId(TOKEN);
    const res = await create(makeApp(db, REG_B, { "vm-b": bound() }, forwarded), TOKEN);
    expect(res.status).toBe(201);
    expect(forwarded).toEqual([]);
    expect(rows(db)).toBe(1);
  });

  const INELIGIBLE: Array<[string, Binding, string]> = [
    ["learned before URLs were recorded", bound({ observedUrl: undefined }), "was learned before its URL was recorded"],
    ["learned at a URL the entry no longer has", bound({ observedUrl: "http://vm-old:7433" }), `was learned at http://vm-old:7433, but the entry now points at ${URL_B}`],
    ["carrying a recorded conflict", bound({ conflict: { hostId: "host-0000beef", observedAt: "y" } }), "has a recorded conflict"],
  ];
  for (const [label, binding, reason] of INELIGIBLE) {
    it(`a binding ${label} is refused before any forward, naming the reason and the routes that work`, async () => {
      const res = await create(makeApp(db, REG_B, { "vm-b": binding }, forwarded), TOKEN);
      expect(res.status).toBe(502);
      const err = (await res.json()) as { error: string; failureClass: string; hostId: string; detail: string };
      expect(err).toMatchObject({ error: "remote_queue_write_failed", failureClass: "unknown-host", hostId: TOKEN });
      expect(err.detail).toContain(reason);
      expect(err.detail).toContain("rig host doctor vm-b");
      expect(err.detail).toContain("--host vm-b");
      expect(forwarded).toEqual([]);
      expect(rows(db)).toBe(0);
    });
  }

  it("with no bindings file the refusal is today's, word for word", async () => {
    const res = await create(makeApp(db, REG_B, null, forwarded), TOKEN);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { detail: string }).detail).toBe(`unknown host id '${TOKEN}'. Known host ids: vm-b.`);
    expect(forwarded).toEqual([]);
  });

  it("placement and every other resolveHost caller ignore bindings", () => {
    expect(resolveHost(REG_B, TOKEN).ok).toBe(false);
    expect(resolvePlacementHost(REG_B, TOKEN).ok).toBe(false);
  });
});
