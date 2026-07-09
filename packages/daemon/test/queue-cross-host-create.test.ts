// OPR.0.4.6.MH3 C1 — cross-host queue CREATE (forward-then-strip) + origin-side
// PK identity handling. The load-bearing pins:
//   - no-host / "local" create = today's local path byte-identical (FR-6);
//   - a registered http host FORWARDS the whole body (minted id + provenance +
//     nudge, hostId stripped) to /api/queue/create; origin response verbatim;
//     NO local row ever written (FR-2, origin-owns-the-record);
//   - unknown / ssh / unreachable host = structured host-named failure, nothing
//     written (FR-2 honest-failure taxonomy);
//   - origin-side: a re-forwarded create with the SAME id absorbs on the PK when
//     identity matches (FR-5/Q-a), and a same-id/different-identity create is a
//     structured qitem_id_reuse conflict, never a silent overwrite.

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
import {
  QueueRepository,
  QueueRepositoryError,
  isQitemPrimaryKeyConflict,
} from "../src/domain/queue-repository.js";
import { queueRoutes, crossHostProvenanceTags, CROSS_HOST_TAG } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};
process.env["MH3B"] = "remote-token";

function jsonResponse(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeApp(opts: {
  db: Database.Database;
  bus: EventBus;
  fetchImpl?: typeof fetch;
}): Hono {
  const queueRepo = new QueueRepository(opts.db, opts.bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", opts.bus);
    set("queueRepo", queueRepo);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (opts.fetchImpl) set("remoteFetchImpl", opts.fetchImpl);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

function post(app: Hono, body: Record<string, unknown>) {
  return app.request("/api/queue/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
}

const BASE = { sourceSession: "orch@rig-a", destinationSession: "dev@rig-b", body: "do the thing" };

describe("MH-3 C1 — cross-host queue create (route)", () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    bus = new EventBus(db);
  });
  afterEach(() => db.close());

  it("no-host create: the local path runs and writes ONE local row (FR-6 zero-regression)", async () => {
    const app = makeApp({ db, bus });
    const res = await post(app, BASE);
    expect(res.status).toBe(201);
    expect(rowCount(db)).toBe(1);
    const item = (await res.json()) as { destinationSession: string; hostId?: unknown };
    expect(item.destinationSession).toBe("dev@rig-b");
    expect("hostId" in item).toBe(false);
  });

  it('hostId "local": same local path, one local row, no forward', async () => {
    let forwarded = false;
    const app = makeApp({ db, bus, fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    const res = await post(app, { ...BASE, hostId: "local" });
    expect(res.status).toBe(201);
    expect(rowCount(db)).toBe(1);
    expect(forwarded).toBe(false);
  });

  it("cross-host create: forwards the WHOLE body (minted id, provenance, nudge) with hostId STRIPPED; origin response verbatim; NO local row", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const app = makeApp({
      db,
      bus,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capture.url = String(url);
        capture.body = JSON.parse(String(init?.body));
        return jsonResponse({ qitemId: "qitem-origin-1", destinationSession: "dev@rig-b", state: "pending" }, 201);
      }) as unknown as typeof fetch,
    });
    const res = await post(app, { ...BASE, hostId: "vps-b", nudge: true, tags: ["existing"] });
    expect(res.status).toBe(201);
    // Origin response verbatim.
    expect((await res.json()) as { qitemId: string }).toMatchObject({ qitemId: "qitem-origin-1" });
    // Forwarded to the origin's create route.
    expect(capture.url).toContain("/api/queue/create");
    // Minted id present (Q-a — not caller-dependent).
    expect(String(capture.body?.["qitemId"])).toMatch(/^qitem-/);
    // hostId stripped at the edge (BR-1 — never in-band).
    expect("hostId" in (capture.body ?? {})).toBe(false);
    // Whole body incl. nudge forwarded (FR-3).
    expect(capture.body?.["nudge"]).toBe(true);
    // Provenance appended, existing tag preserved (D-4).
    expect(capture.body?.["tags"]).toContain(CROSS_HOST_TAG);
    expect(capture.body?.["tags"]).toContain("existing");
    // NO local row (origin-owns-the-record).
    expect(rowCount(db)).toBe(0);
  });

  it("cross-host create with a caller --id: forwards THAT id (mint only if absent)", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const app = makeApp({
      db,
      bus,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        capture.body = JSON.parse(String(init?.body));
        return jsonResponse({ qitemId: "qitem-mine" });
      }) as unknown as typeof fetch,
    });
    await post(app, { ...BASE, hostId: "vps-b", qitemId: "qitem-mine" });
    expect(capture.body?.["qitemId"]).toBe("qitem-mine");
  });

  it("unknown host: structured host-named failure (502), NOTHING written locally", async () => {
    const app = makeApp({ db, bus });
    const res = await post(app, { ...BASE, hostId: "nope" });
    expect(res.status).toBe(502);
    const err = (await res.json()) as { error: string; hostId: string; failureClass: string };
    expect(err.error).toBe("remote_queue_write_failed");
    expect(err.hostId).toBe("nope");
    expect(err.failureClass).toBe("unknown-host");
    expect(rowCount(db)).toBe(0);
  });

  it("ssh host: unsupported-transport (502), NOTHING written locally", async () => {
    const app = makeApp({ db, bus });
    const res = await post(app, { ...BASE, hostId: "ssh-1" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ failureClass: "unsupported-transport" });
    expect(rowCount(db)).toBe(0);
  });

  it("origin unreachable: structured unreachable failure, NOTHING written locally", async () => {
    const app = makeApp({
      db,
      bus,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const res = await post(app, { ...BASE, hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ failureClass: "unreachable" });
    expect(rowCount(db)).toBe(0);
  });
});

describe("MH-3 C1 — origin-side PK identity handling (repo)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
  });
  afterEach(() => db.close());

  it("PK absorb: a re-forwarded create with the SAME id + matching identity returns the existing row, exactly one row", async () => {
    const first = await repo.create({ qitemId: "qitem-x", ...BASE, nudge: false });
    const again = await repo.create({ qitemId: "qitem-x", ...BASE, nudge: false });
    expect(again.qitemId).toBe(first.qitemId);
    expect(again.tsCreated).toBe(first.tsCreated); // the STORED row, not a new insert
    expect(rowCount(db)).toBe(1);
  });

  it("id-reuse: same id, DIFFERENT destination = structured qitem_id_reuse conflict; original untouched", async () => {
    await repo.create({ qitemId: "qitem-x", ...BASE, nudge: false });
    await expect(
      repo.create({ qitemId: "qitem-x", sourceSession: "orch@rig-a", destinationSession: "SOMEONE@rig-z", body: "different", nudge: false }),
    ).rejects.toMatchObject({ code: "qitem_id_reuse" });
    const row = db.prepare("SELECT destination_session d FROM queue_items WHERE qitem_id = 'qitem-x'").get() as { d: string };
    expect(row.d).toBe("dev@rig-b"); // never overwritten
    expect(rowCount(db)).toBe(1);
  });
});

describe("MH-3 C1 — pure helpers", () => {
  it("crossHostProvenanceTags: appends marker + from-host, preserves existing, idempotent", () => {
    const once = crossHostProvenanceTags(["keep"]);
    expect(once).toContain("keep");
    expect(once).toContain(CROSS_HOST_TAG);
    expect(once.some((t) => t.startsWith("from-host:"))).toBe(true);
    // idempotent — re-tagging an already-tagged list adds nothing new.
    expect(crossHostProvenanceTags(once).length).toBe(once.length);
    // undefined base is safe.
    expect(crossHostProvenanceTags(undefined)).toContain(CROSS_HOST_TAG);
  });

  it("isQitemPrimaryKeyConflict: true for PK/UNIQUE constraint on qitem_id, false otherwise", () => {
    const byCode = Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
    expect(isQitemPrimaryKeyConflict(byCode)).toBe(true);
    const byMsg = new Error("UNIQUE constraint failed: queue_items.qitem_id");
    expect(isQitemPrimaryKeyConflict(byMsg)).toBe(true);
    expect(isQitemPrimaryKeyConflict(new Error("some other error"))).toBe(false);
    expect(isQitemPrimaryKeyConflict("not an error")).toBe(false);
  });
});
