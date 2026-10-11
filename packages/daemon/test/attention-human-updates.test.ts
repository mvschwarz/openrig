import { expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { get } from "node:http";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { attentionRoutes } from "../src/routes/attention.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { AttentionRead } from "../src/attention-surface.js";

async function fixture() {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("queueRepo" as never, queue as never); await next(); });
  app.route("/api/attention", attentionRoutes());
  app.route("/api/queue", queueRoutes());
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind an owned TCP port");
  const readJson = (route: string): Promise<unknown> => new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port: address.port, path: route }, response => {
      let body = ""; response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { expect(response.statusCode).toBe(200); resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
  const read = async (id?: string) => await readJson("/api/attention" + (id ? "?item=" + encodeURIComponent(id) : "")) as AttentionRead;
  const row = (id: string, opts: { destination?: string; intent?: "update" | "decision" | null; state?: string; priority?: string; at?: string; blockedOn?: string } = {}) => {
    const at = opts.at ?? "2026-10-07T12:00:00Z";
    db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,human_intent,human_detail,blocked_on) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, at, at, "author@fixture", opts.destination ?? "human@kernel", opts.state ?? "pending", opts.priority ?? "routine",
        "Body for " + id, "Summary " + id, opts.intent === undefined ? "update" : opts.intent, "Supplement " + id, opts.blockedOn ?? null);
  };
  return { db, queue, row, read, readJson, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  } };
}

it("serves never-delivered open human updates as read-only FYIs over actual HTTP", async () => {
  const f = await fixture();
  try {
    f.row("urgent", { priority: "urgent" });
    f.row("working", { state: "in-progress", destination: "human-reader@external" });
    f.row("blocked", { state: "blocked" });
    const before = f.db.serialize();
    const read = await f.read("queue-update:urgent");
    expect(read.items.map(i => i.id).sort()).toEqual(["queue-update:blocked", "queue-update:urgent", "queue-update:working"]);
    expect(read.items.every(i => i.kind === "update" && i.unblocks === null)).toBe(true);
    expect(read.detail?.item).toMatchObject({ id: "queue-update:urgent", urgency: "urgent", recipient: "human@kernel" });
    const detail = read.detail?.lines.join("\n") ?? "";
    expect(detail).toContain("Body for urgent"); expect(detail).toContain("Supplement urgent");
    expect(detail).toContain("no action needed"); expect(detail).not.toContain("Decision route:");
    expect(detail).not.toContain("Delivered:");
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});

it("filters agent, malformed and closed update rows before the bounded human window", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1100; i++) f.row("malformed-" + i, { destination: "human-@kernel", at: "2026-10-08T12:00:00Z" });
    f.row("agent", { destination: "writer@fixture" });
    f.row("closed", { state: "done" }); f.row("canceled", { state: "canceled" });
    f.row("valid", { destination: "human-founder@external" });
    const read = await f.read();
    expect(read.items.map(i => i.id)).toEqual(["queue-update:valid"]);
    expect(read.sources.find(s => s.source === "queue updates")?.state).toBe("available");
    expect((await f.read("queue-update:closed")).detail?.lines).toContain("State: done");
    expect((await f.read()).items.some(i => i.id === "queue-update:closed")).toBe(false);
  } finally { await f.close(); }
});

it("bounds current update coverage while admitting an older urgent item before routine rows", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1001; i++) f.row("routine-" + i, { at: "2026-10-08T12:00:00Z" });
    f.row("urgent-old", { priority: "urgent", at: "2026-10-01T12:00:00Z" });
    const read = await f.read();
    expect(read.items).toHaveLength(1000);
    expect(read.items[0]?.id).toBe("queue-update:urgent-old");
    expect(read.sources.find(s => s.source === "queue updates")).toMatchObject({ state: "partial", detail: expect.stringContaining("1000") });
  } finally { await f.close(); }
});

it("reports a failed update reader without dropping working human decisions", async () => {
  const f = await fixture();
  try {
    f.row("decision", { intent: "decision" }); f.row("fyi");
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => {
      if (sql.includes("human_intent = 'update'")) throw new Error("owned_update_reader_failed");
      return prepare(sql);
    }) as typeof f.db.prepare;
    const read = await f.read();
    expect(read.items.map(i => i.id)).toEqual(["queue:decision"]);
    expect(read.sources.find(s => s.source === "queue")?.state).toBe("available");
    expect(read.sources.find(s => s.source === "queue updates")).toMatchObject({ state: "unavailable", detail: "owned_update_reader_failed" });
  } finally { await f.close(); }
});

it("preserves explicit decisions, legacy decisions and human blockers as actions", async () => {
  const f = await fixture();
  try {
    f.row("decision", { intent: "decision" }); f.row("legacy", { intent: null });
    f.row("blocker", { destination: "writer@fixture", intent: "decision", state: "blocked", blockedOn: "human-reader@external" });
    f.row("agent", { destination: "writer@fixture", intent: "decision" }); f.row("closed", { intent: "decision", state: "done" });
    const before = f.db.serialize(), read = await f.read("queue:decision");
    expect(read.items.filter(i => i.kind === "action").map(i => i.id).sort()).toEqual(["queue:blocker", "queue:decision", "queue:legacy"]);
    expect(read.detail?.lines.join("\n")).toContain("Decision route:");
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});

it("keeps the delivery-history endpoint receipt based and permits closed delivered FYIs", async () => {
  const f = await fixture();
  try {
    f.row("never-delivered"); f.row("delivered", { state: "done" });
    f.queue.transitionLog.append({ qitemId: "delivered", state: "done", actorSession: "author@fixture", transitionNote: "slack-owner-notification-posted 1000.0001" });
    const before = f.db.serialize();
    const history = await f.readJson("/api/queue/human-updates?limit=20") as { items: Array<{ qitemId: string; deliveryReceipt: string }> };
    expect(history.items.map(i => i.qitemId)).toEqual(["delivered"]);
    expect(history.items[0]?.deliveryReceipt).toContain("1000.0001");
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});


it("ranks older critical updates before urgent and routine rows at the repository limit", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 1001; i++) f.row("routine-" + i, { at: "2026-10-08T12:00:00Z" });
    f.row("urgent", { priority: "urgent", at: "2026-10-07T12:00:00Z" });
    f.row("critical", { priority: "critical", at: "2026-10-01T12:00:00Z" });
    expect(f.queue.listOpenHumanUpdates({ limit: 1 }).map(q => q.qitemId)).toEqual(["critical"]);
    expect(f.queue.listOpenHumanUpdates({ limit: 2 }).map(q => q.qitemId)).toEqual(["critical", "urgent"]);
  } finally { await f.close(); }
});

it("keeps critical, urgent then routine updates in the actual HTTP attention response", async () => {
  const f = await fixture();
  try {
    f.row("routine", { at: "2026-10-08T12:00:00Z" });
    f.row("urgent", { priority: "urgent", at: "2026-10-07T12:00:00Z" });
    f.row("critical", { priority: "critical", at: "2026-10-01T12:00:00Z" });
    const before = f.db.serialize();
    expect((await f.read()).items.map(i => i.id)).toEqual(["queue-update:critical", "queue-update:urgent", "queue-update:routine"]);
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});
