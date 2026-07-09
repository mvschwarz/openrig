// OPR.0.4.6.MH3 guard fixback (review of 86ba8b42, Finding 1) — PL-007
// target_repo validation must run on the SOURCE host BEFORE any cross-host
// forward. The validation authority is the source rig's typed workspace,
// which lives HERE; the target daemon passes-through when it doesn't know
// the source rig, so a bypass is not recoverable remotely. Pins:
//   - cross-host create/handoff/handoff-and-complete with an INVALID explicit
//     targetRepo → 400 unknown_target_repo, NO forward fired, no local write,
//     and (handoff variants) the source NOT closed;
//   - a VALID explicit targetRepo still forwards (the check gates, it does
//     not block the feature);
//   - an INHERITED source.targetRepo (no explicit override) is NOT
//     re-validated on handoff — it was already accepted on the source row
//     (guard fix shape, point 2).

import { describe, it, expect, afterEach } from "vitest";
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
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" }],
};
process.env["MH3B"] = "remote-token";

// The fake PL-007 authority: source rig "rig-a" declares exactly one repo.
const FAKE_RIG_REPO = {
  findRigsByName: (name: string) => (name === "rig-a" ? [{ id: "rig-a-id" }] : []),
  getRigWorkspace: (rigId: string) =>
    rigId === "rig-a-id" ? { repos: [{ name: "repo-ok" }] } : null,
};

function makeHarness() {
  const db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  let forwardCount = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", repo);
    set("rigRepo", FAKE_RIG_REPO);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", (async (_u: unknown, init?: RequestInit) => {
      forwardCount += 1;
      const b = JSON.parse(String((init as { body?: unknown })?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ qitemId: b["qitemId"] ?? "qitem-origin" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const rowCount = () => (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
  return { db, repo, post, rowCount, forwards: () => forwardCount };
}

describe("MH-3 guard fixback — PL-007 target_repo validates BEFORE any cross-host forward", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => h?.db.close());

  it("cross-host CREATE with an invalid explicit targetRepo: 400 unknown_target_repo, NO forward, no local write", async () => {
    h = makeHarness();
    const res = await h.post("/api/queue/create", {
      sourceSession: "orch@rig-a", destinationSession: "dev@rig-b",
      body: "x", hostId: "vps-b", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown_target_repo" });
    expect(h.forwards()).toBe(0);
    expect(h.rowCount()).toBe(0);
  });

  it("cross-host CREATE with a valid explicit targetRepo: validated, then forwarded (no local row)", async () => {
    h = makeHarness();
    const res = await h.post("/api/queue/create", {
      sourceSession: "orch@rig-a", destinationSession: "dev@rig-b",
      body: "x", hostId: "vps-b", targetRepo: "repo-ok", nudge: false,
    });
    expect(res.status).toBe(201);
    expect(h.forwards()).toBe(1);
    expect(h.rowCount()).toBe(0);
  });

  it("cross-host HANDOFF with an invalid explicit targetRepo: 400 BEFORE the forward; source NOT closed", async () => {
    h = makeHarness();
    await h.repo.create({ qitemId: "qitem-src", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const res = await h.post("/api/queue/qitem-src/handoff", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown_target_repo" });
    expect(h.forwards()).toBe(0);
    const source = h.repo.getById("qitem-src")!;
    expect(source.state).toBe("pending");
    expect(source.closureTarget).toBeNull();
  });

  it("cross-host HANDOFF-AND-COMPLETE with an invalid explicit targetRepo: 400 BEFORE the forward; source NOT closed", async () => {
    h = makeHarness();
    await h.repo.create({ qitemId: "qitem-src2", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const res = await h.post("/api/queue/qitem-src2/handoff-and-complete", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(res.status).toBe(400);
    expect(h.forwards()).toBe(0);
    expect(h.repo.getById("qitem-src2")!.state).toBe("pending");
  });

  it("cross-host HANDOFF with a valid explicit targetRepo: validated, forwarded, source closed", async () => {
    h = makeHarness();
    await h.repo.create({ qitemId: "qitem-src3", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const res = await h.post("/api/queue/qitem-src3/handoff", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", targetRepo: "repo-ok", nudge: false,
    });
    expect(res.status).toBe(201);
    expect(h.forwards()).toBe(1);
    expect(h.repo.getById("qitem-src3")!.state).toBe("handed-off");
  });

  it("INHERITED source.targetRepo (no explicit override) is NOT re-validated on cross-host handoff (already accepted on the source row)", async () => {
    h = makeHarness();
    // Seed the source row with a targetRepo the fake authority would REJECT
    // today (repo layer accepts it — older rows / evolved workspaces exist).
    await h.repo.create({ qitemId: "qitem-src4", sourceSession: "someone@rig-z", destinationSession: "worker@rig-a", body: "src", targetRepo: "repo-legacy", nudge: false });
    const res = await h.post("/api/queue/qitem-src4/handoff", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", nudge: false,
    });
    // No explicit override → no re-validation → the forward proceeds and the
    // inherited value rides the forwarded body.
    expect(res.status).toBe(201);
    expect(h.forwards()).toBe(1);
    expect(h.repo.getById("qitem-src4")!.state).toBe("handed-off");
  });

  it("LOCAL create/handoff validation ordering unchanged (invalid explicit targetRepo still 400s locally)", async () => {
    h = makeHarness();
    const create = await h.post("/api/queue/create", {
      sourceSession: "orch@rig-a", destinationSession: "worker@rig-a",
      body: "x", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(create.status).toBe(400);
    await h.repo.create({ qitemId: "qitem-src5", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const handoff = await h.post("/api/queue/qitem-src5/handoff", {
      fromSession: "worker@rig-a", toSession: "peer@rig-a", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(handoff.status).toBe(400);
  });
});
