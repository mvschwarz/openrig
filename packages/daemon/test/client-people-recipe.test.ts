// A client in a separate Node process uses documented HTTP reads against the production
// gateway/queue routes and browser boundary. No connector, native agent or shared daemon.
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { setDefaultPerson } from "../src/domain/gateway/participants.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { queueRoutes } from "../src/routes/queue.js";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { addHumanFragment, loadHumanRegistry } from "../src/domain/gateway/human-registry.js";

const run = promisify(execFile);
const reference = readFileSync(new URL("../../../docs/reference/daemon-http-clients.md", import.meta.url), "utf8");
const client = reference.match(/```js\n(\/\/ client-people-example\n[\s\S]*?)```/)?.[1];
if (!client) throw new Error("Documented client example not found");
const pathClient = "const [base,path]=process.argv.slice(1); const r=await fetch(base+path); " +
  "if(!r.ok) throw new Error('HTTP '+r.status); console.log(JSON.stringify(await r.json()));";
const boundaryClient = "const [base,paths]=process.argv.slice(1); const statuses=[]; " +
  "for(const path of JSON.parse(paths)) statuses.push((await fetch(base+path,{headers:{Origin:'https://unrelated.invalid'}})).status); " +
  "console.log(JSON.stringify(statuses));";

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "client-people-reads-"));
  vi.stubEnv("OPENRIG_HOME", home);
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home), validateRig: () => true });
  const outbox = new OutboxHandler(db);
  const app = new Hono();
  app.use("/api/*", browserBoundary({ webUiEnabled: false, bearerTokens: [], discoverSelfNames: async () => [] }));
  app.use("*", async (c, next) => { c.set("queueRepo" as never, queue as never); c.set("outboxHandler" as never, outbox as never); await next(); });
  app.route("/api/queue", queueRoutes());
  app.route("/api/gateway", gatewayRoutes({ home }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned HTTP listener");
  const base = "http://127.0.0.1:" + address.port;
  const execute = async (code: string, args: string[]) => {
    const result = await run(process.execPath, ["--input-type=module", "-e", code, base, ...args],
      { timeout: 10_000, env: {}, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const read = (person: string) => execute(client, [person, "fixture"]);
  const register = (id: string, slack = false) => {
    const result = addHumanFragment({ entityId: id, class: "human", displayName: id,
      address: id + "@external", connectorBindings: slack
        ? [{ kind: "slack", connectorRef: "fixture-slack", secretsRef: "vault://fixture/never-return",
          role: "primary", handle: "U" + id.toUpperCase() }] : [], prefs: { deliveryClass: "B" } }, home);
    expect(result).toMatchObject({ ok: true });
  };
  const row = async (id: string, destination: string, intent: "decision" | "update" = "update", state = "pending") => {
    const item = await queue.create({ qitemId: id, sourceSession: "author@fixture", destinationSession: destination,
      body: "Body " + id, summary: "Summary " + id, humanIntent: intent, evidenceRef: "proof/" + id, nudge: false });
    if (state !== "pending") db.prepare("UPDATE queue_items SET state = ?, resolution = ? WHERE qitem_id = ?")
      .run(state, state === "done" ? "Acknowledged" : null, id);
    return queue.getById(item.qitemId)!;
  };
  return { home, db, queue, outbox, register, row, read, path: (path: string) => execute(pathClient, [path]), boundary: (paths: string[]) => execute(boundaryClient, [JSON.stringify(paths)]), close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(server.listening).toBe(false);
    db.close(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
  } };
}

it("the documented separate-process client reads people, asks, FYIs, closure and receipts without Slack", async () => {
  const f = await fixture();
  try {
    f.register("alex"); f.register("sam", true);
    expect(setDefaultPerson("alex", f.home).ok).toBe(true);
    await f.row("ask", "alex@external", "decision");
    await f.row("fyi", "alex@external");
    await f.row("working", "alex@external", "update", "in-progress");
    await f.row("acknowledged", "alex@external", "update", "done");
    await f.row("slack-open", "sam@external");
    await f.row("posted", "sam@external", "update", "done");
    f.queue.transitionLog.append({ qitemId: "posted", state: "done", actorSession: "author@fixture",
      transitionNote: "slack-owner-notification-posted 1000.0001" });
    for (const [outboxId, senderSession, destinationSession] of [
      ["inside", "author@fixture", "worker@fixture"],
      ["inbound", "author@elsewhere", "worker@fixture"],
      ["unrelated", "author@elsewhere", "worker@elsewhere"],
    ]) f.outbox.record({ outboxId, senderSession, destinationSession, body: outboxId });
    f.outbox.markDelivered("inside");
    await f.queue.create({ qitemId: "unrelated", sourceSession: "author@elsewhere",
      destinationSession: "worker@elsewhere", body: "Other rig", nudge: false });
    const before = f.db.serialize();
    const result = await f.read("alex");
    expect(result.participants.map((p: { id: string }) => p.id)).toEqual(["alex", "sam"]);
    expect(result.default).toEqual({ id: "alex", source: "chosen" });
    expect(result.asks.map((q: QueueItem) => q.qitemId)).toEqual(["ask"]);
    expect(result.asks[0]).toMatchObject({ state: "pending", humanIntent: "decision" });
    expect(result.updates.items.map((q: QueueItem) => q.qitemId).sort()).toEqual(["fyi", "working"]);
    expect(result.updates).toMatchObject({ limit: 20, truncated: false,
      perspective: { viewing: "alex@external", basis: "chosen-here" } });
    for (const item of result.updates.items) {
      expect(item.humanIntent).toBe("update");
      expect(item).not.toHaveProperty("deliveredAt"); expect(item).not.toHaveProperty("deliveryReceipt");
    }
    expect(result.receipts.items).toEqual([]);
    expect(result.rigHistory.map((q: QueueItem) => q.qitemId).sort())
      .toEqual(["acknowledged", "ask", "fyi", "posted", "slack-open", "working"]);
    expect(result.rigHistory.find((q: QueueItem) => q.qitemId === "acknowledged"))
      .toMatchObject({ state: "done", resolution: "Acknowledged" });
    expect(result.messages.map((m: { outboxId: string }) => m.outboxId).sort()).toEqual(["inbound", "inside"]);
    expect(result.messages.find((m: { outboxId: string }) => m.outboxId === "inside"))
      .toMatchObject({ deliveryState: "delivered", deliveredAt: expect.any(String) });
    expect(result.messages.find((m: { outboxId: string }) => m.outboxId === "inbound"))
      .toMatchObject({ deliveryState: "pending", deliveredAt: null });
    const perSeat = await f.path("/api/queue/outbox/list?senderSession=author%40elsewhere");
    expect(perSeat.map((m: { outboxId: string }) => m.outboxId).sort()).toEqual(["inbound", "unrelated"]);
    const slack = await f.read("sam");
    expect(slack.asks).toEqual([]);
    expect(slack.updates.items.map((q: QueueItem) => q.qitemId)).toEqual(["slack-open"]);
    expect(slack.receipts.items).toMatchObject([{ qitemId: "posted", state: "done", humanIntent: "update",
      deliveredAt: expect.any(String), deliveryReceipt: "slack-owner-notification-posted 1000.0001" }]);
    expect(JSON.stringify([result, slack])).not.toContain("vault://");
    expect(JSON.stringify([result, slack])).not.toContain("secretsRef");
    expect(f.db.serialize()).toEqual(before);
    console.info("[client recipe]", JSON.stringify({ default: result.default, asks: result.asks.map((q: QueueItem) => q.qitemId),
      updates: result.updates.items.map((q: QueueItem) => q.qitemId).sort(), receiptsWithoutSlack: result.receipts.items.length,
      closed: "acknowledged", rigHistory: result.rigHistory.length, rigOutbox: result.messages.map((m: { outboxId: string }) => m.outboxId).sort(),
      slackReceipts: slack.receipts.items.map((q: QueueItem) => q.qitemId), readOnly: true, credentialPointers: false }));
  } finally { await f.close(); }
});

it("the documented read families retain the browser-origin boundary", async () => {
  const f = await fixture();
  try {
    f.register("alex");
    const before = f.db.serialize();
    const statuses = await f.boundary(["/api/gateway/participants", "/api/queue/list?destinationSession=alex%40external",
      "/api/queue/open-human-updates?view=alex", "/api/queue/human-updates?view=alex", "/api/queue/outbox/list?rig=fixture"]);
    expect(statuses).toEqual([403, 403, 403, 403, 403]);
    expect(f.db.serialize()).toEqual(before);
    console.info("[client boundary]", JSON.stringify({ statuses, readOnly: true }));
  } finally { await f.close(); }
});
