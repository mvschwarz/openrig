import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("queue recorded lineage read", () => {
  let db: Database.Database, repo: QueueRepository, app: Hono;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db));
    app = new Hono(); app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());
  const read = async (id: string) => app.request(`/api/queue/${encodeURIComponent(id)}/lineage`);
  const create = () => repo.create({ sourceSession: "one@rig", destinationSession: "two@rig", body: "recorded work", nudge: false });

  it("reads an ordinary row's distinct recorded ancestors and descendants without an app request", async () => {
    const parent = await create(), child = await create(), descendant = await create(), unrelated = await create();
    db.prepare("UPDATE queue_items SET reply_to=?, handed_off_from=?, blocked_on=? WHERE qitem_id=?")
      .run(parent.qitemId, parent.qitemId, parent.qitemId, child.qitemId);
    db.prepare("UPDATE queue_items SET reply_to=? WHERE qitem_id=?").run(child.qitemId, descendant.qitemId);
    const response = await read(child.qitemId); expect(response.status).toBe(200); const result = await response.json();
    expect(result).toMatchObject({ rootId: child.qitemId, scope: "this-daemon", status: "available", partial: false, completion: { status: "unknown" } });
    expect(result.nodes.map((n: { qitemId: string }) => n.qitemId).sort()).toEqual([parent.qitemId, child.qitemId, descendant.qitemId].sort());
    expect(result.nodes.some((n: { qitemId: string }) => n.qitemId === unrelated.qitemId)).toBe(false);
    expect(result.edges.filter((e: { to: string }) => e.to === child.qitemId).map((e: { relation: string }) => e.relation).sort()).toEqual(["reply-to", "handed-off-from", "blocked-on"].sort());
    expect(result.edges.every((e: { sourceQitemId: string; to: string }) => e.sourceQitemId === e.to)).toBe(true);
  });

  it("returns an unknown missing root and never returns erased row content", async () => {
    const missing = await read("qitem-not-recorded"); expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: "unknown", partial: true, completion: { status: "unknown" }, nodes: [] });
    const parent = await create(), child = await create();
    db.prepare("UPDATE queue_items SET reply_to=? WHERE qitem_id=?").run(parent.qitemId, child.qitemId);
    db.prepare("UPDATE queue_items SET content_erased_at=? WHERE qitem_id=?").run(new Date().toISOString(), parent.qitemId);
    const result = await (await read(child.qitemId)).json();
    expect(result.nodes).toHaveLength(1); expect(result.partialReasons).toContain("content-unavailable");
    expect(result.unresolved).toContainEqual({ reference: parent.qitemId, reason: "content-unavailable" });
    expect((await read(parent.qitemId)).status).toBe(404);
  });

  it("keeps cross-host references unresolved and closed records separate from goal completion", async () => {
    const item = await create();
    db.prepare("UPDATE queue_items SET state='done', blocked_on=?, handed_off_to=? WHERE qitem_id=?")
      .run("external:another-host/qitem-remote", "next@rig@another-host", item.qitemId);
    const result = await (await read(item.qitemId)).json();
    expect(result).toMatchObject({ scope: "this-daemon", status: "partial", partial: true, completion: { status: "unknown" } });
    expect(result.nodes[0]).toMatchObject({ state: "done", completion: { status: "closed-as-recorded" } });
    expect(result.unresolved).toContainEqual({ reference: "external:another-host/qitem-remote", reason: "not-recorded-locally" });
    expect(result.unresolved).toContainEqual({ reference: "next@rig@another-host", reason: "unresolved-successor" });
  });

  it("reports cycles, handoff depth and wide truncation without unbounded traversal", async () => {
    const cycle = await create(); db.prepare("UPDATE queue_items SET reply_to=? WHERE qitem_id=?").run(cycle.qitemId, cycle.qitemId);
    expect((await (await read(cycle.qitemId)).json()).partialReasons).toContain("cycle");
    const root = await create(); let previous = root;
    for (let i = 0; i < 23; i++) { const next = await create(); db.prepare("UPDATE queue_items SET handed_off_from=? WHERE qitem_id=?").run(previous.qitemId, next.qitemId); previous = next; }
    const deep = await (await read(root.qitemId)).json(); expect(deep.nodes).toHaveLength(21); expect(deep.partialReasons).toContain("handoff-limit");
    const wide = await create();
    for (let i = 0; i < 105; i++) { const next = await create(); db.prepare("UPDATE queue_items SET reply_to=? WHERE qitem_id=?").run(wide.qitemId, next.qitemId); }
    const bounded = await (await read(wide.qitemId)).json(); expect(bounded.nodes.length).toBeLessThanOrEqual(100);
    expect(bounded.partialReasons).toContain("related-limit"); expect(bounded.partialReasons).toContain("node-limit");
  });
});
