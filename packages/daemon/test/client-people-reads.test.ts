// A client in a separate Node process uses documented HTTP reads against the production
// gateway/queue routes and browser boundary. No connector, native agent or shared daemon.
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { queueRoutes } from "../src/routes/queue.js";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { addHumanFragment, loadHumanRegistry } from "../src/domain/gateway/human-registry.js";
import { setDefaultPerson } from "../src/domain/gateway/participants.js";

const run = promisify(execFile);
const client = [
  'const [base, paths, headers] = process.argv.slice(1);',
  'const results = [];',
  'for (const path of JSON.parse(paths)) {',
  '  const response = await fetch(base + path, { headers: JSON.parse(headers) });',
  '  const text = await response.text();',
  '  let body; try { body = JSON.parse(text); } catch { body = text; }',
  '  results.push({ status: response.status, body });',
  '}',
  'process.stdout.write(JSON.stringify(results));',
].join("\n");

interface Read { status: number; body: any }
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "client-people-reads-"));
  vi.stubEnv("OPENRIG_HOME", home);
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home) });
  const app = new Hono();
  app.use("/api/*", browserBoundary({ webUiEnabled: false, bearerTokens: [], discoverSelfNames: async () => [] }));
  app.use("*", async (c, next) => { c.set("queueRepo" as never, queue as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home }));
  app.route("/api/queue", queueRoutes());
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned HTTP listener");
  const read = async (paths: string[], headers: Record<string, string> = {}): Promise<Read[]> => {
    const result = await run(process.execPath, ["--input-type=module", "-e", client,
      "http://127.0.0.1:" + address.port, JSON.stringify(paths), JSON.stringify(headers)],
    { timeout: 10_000, env: {}, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
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
  return { home, db, queue, register, row, read, close: async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
  } };
}

it("an external client reads connectorless and Slack people with the chosen default, without binding secrets", async () => {
  const f = await fixture();
  try {
    f.register("alex"); f.register("sam", true);
    expect(setDefaultPerson("alex", f.home)).toMatchObject({ ok: true });
    expect(loadHumanRegistry(f.home)).toMatchObject({ ok: true });
    const before = f.db.serialize();
    const [response] = await f.read(["/api/gateway/participants"]);
    expect(response!.status).toBe(200);
    expect(response!.body.participants.map((p: any) => [p.id, p.address, p.kind, p.default]))
      .toEqual([["alex", "alex@external", "person", true], ["sam", "sam@external", "person", false]]);
    expect(response!.body.default).toEqual({ id: "alex", address: "alex@external", source: "chosen" });
    const text = JSON.stringify(response!.body);
    for (const privateField of ["connectorBindings", "secretsRef", "vault://", "U" + "SAM", "sideFile", f.home])
      expect(text).not.toContain(privateField);
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});

it("a remote read preserves the existing no-choice result for several people", async () => {
  const f = await fixture();
  try {
    f.register("alex"); f.register("sam", true);
    const [response] = await f.read(["/api/gateway/participants"]);
    expect(response!.status).toBe(200);
    expect(response!.body.default).toMatchObject({ id: null, source: "none", reason: expect.stringContaining("none is the default") });
  } finally { await f.close(); }
});

it("a remote read preserves the only-person fallback without a connector", async () => {
  const f = await fixture();
  try {
    f.register("alex");
    const [response] = await f.read(["/api/gateway/participants"]);
    expect(response!.status).toBe(200);
    expect(response!.body.default).toEqual({ id: "alex", address: "alex@external", source: "only-person" });
  } finally { await f.close(); }
});

it("a no-Slack client reads open updates without manufacturing a delivery receipt", async () => {
  const f = await fixture();
  try {
    f.register("alex"); f.register("sam", true);
    await f.row("ask", "alex@external", "decision");
    await f.row("fyi", "alex@external"); await f.row("working", "alex@external", "update", "in-progress");
    await f.row("closed", "alex@external", "update", "done");
    await f.row("other-person", "sam@external");
    const before = f.db.serialize();
    const [asks, closed, updates] = await f.read([
      "/api/queue/list?destinationSession=alex%40external&state=pending,in-progress,blocked",
      "/api/queue/closed", "/api/queue/human-updates?delivered=any&destinationSession=alex%40external",
    ]);
    expect(asks!.status).toBe(200);
    expect(asks!.body.map((r: QueueItem) => r.qitemId).sort()).toEqual(["ask", "fyi", "working"]);
    expect(asks!.body.find((r: QueueItem) => r.qitemId === "ask").humanIntent).toBe("decision");
    expect(closed!.body).toMatchObject({ state: "done", humanIntent: "update", resolution: "Acknowledged" });
    expect(updates!.status).toBe(200);
    expect(updates!.body.items.map((r: QueueItem) => r.qitemId).sort()).toEqual(["fyi", "working"]);
    for (const item of updates!.body.items) {
      expect(item.humanIntent).toBe("update");
      expect(item).not.toHaveProperty("deliveredAt"); expect(item).not.toHaveProperty("deliveryReceipt");
    }
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});

it("the open-update recipient filter runs before the bounded window", async () => {
  const f = await fixture();
  try {
    f.register("alex"); f.register("sam", true);
    await f.row("alex-old", "alex@external");
    for (let i = 0; i < 105; i++) await f.row("sam-" + i, "sam@external");
    const [response] = await f.read(["/api/queue/human-updates?delivered=any&destinationSession=alex%40external&limit=1"]);
    expect(response!.status).toBe(200);
    expect(response!.body.items.map((r: QueueItem) => r.qitemId)).toEqual(["alex-old"]);
    expect(response!.body.truncated).toBe(false);
  } finally { await f.close(); }
});

it("an explicit unknown or agent recipient never widens an open update read", async () => {
  const f = await fixture();
  try {
    f.register("alex");
    await f.row("alex-fyi", "alex@external");
    await f.row("agent-fyi", "worker@fixture");
    const [owned, unknown, agent] = await f.read([
      "/api/queue/human-updates?delivered=any&destinationSession=alex%40external",
      "/api/queue/human-updates?delivered=any&destinationSession=unknown%40external",
      "/api/queue/human-updates?delivered=any&destinationSession=worker%40fixture",
    ]);
    expect(owned!.body.items.map((r: QueueItem) => r.qitemId)).toEqual(["alex-fyi"]);
    expect(unknown!.body.items).toEqual([]); expect(agent!.body.items).toEqual([]);
  } finally { await f.close(); }
});

it("the existing default update history still requires a receipt and includes closed delivered Slack updates", async () => {
  const f = await fixture();
  try {
    f.register("alex"); f.register("sam", true);
    await f.row("no-slack", "alex@external"); await f.row("posted", "sam@external", "update", "done");
    f.queue.transitionLog.append({ qitemId: "posted", state: "done", actorSession: "author@fixture",
      transitionNote: "slack-owner-notification-posted 1000.0001" });
    const before = f.db.serialize();
    const [response] = await f.read(["/api/queue/human-updates"]);
    expect(response!.status).toBe(200);
    expect(response!.body.items.map((r: QueueItem) => r.qitemId)).toEqual(["posted"]);
    expect(response!.body.items[0]).toMatchObject({ state: "done", humanIntent: "update", deliveryReceipt: expect.stringContaining("1000.0001") });
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});

it("the existing browser-origin boundary still rejects the people and update reads", async () => {
  const f = await fixture();
  try {
    f.register("alex");
    const before = f.db.serialize();
    const responses = await f.read(["/api/gateway/participants",
      "/api/queue/human-updates?delivered=any&destinationSession=alex%40external"], { Origin: "https://unrelated.invalid" });
    expect(responses.map(r => r.status)).toEqual([403, 403]);
    expect(f.db.serialize()).toEqual(before);
  } finally { await f.close(); }
});
