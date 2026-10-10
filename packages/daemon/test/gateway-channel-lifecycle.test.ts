import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { addHumanFragment, writeProjection } from "../src/domain/gateway/human-registry.js";

const homes: string[] = [];
const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }));
});

function fixture(opts: { registerHuman?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "channel-lifecycle-"));
  homes.push(home);
  if (opts.registerHuman !== false) addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external",
    connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "env:private-pointer", role: "primary" }],
    prefs: { deliveryClass: "B" } }, home);
  saveConfig({ ...DEFAULT_CONFIG, secretsEnvFile: "private-pointer", channel: "C-private" }, home);
  const restart = vi.fn();
  const db = createDb();
  databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  const queueRepo = new QueueRepository(db, new EventBus(db));
  const prepare = vi.spyOn(db, "prepare");
  const selectionCount = () => prepare.mock.calls.filter(([sql]) => /SELECT qitem_id FROM queue_items/.test(sql)).length;
  const alert = (id: string) => {
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body)
      VALUES (?, '2026-01-01', '2026-01-01', 'author@rig', 'alex@external', 'pending', 'fixture backlog')`).run(id);
    const result = db.prepare(`INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,owner_notification_level,owner_notification_kind)
      VALUES (?, '2026-01-01', 'pending', 'author@rig', 'ALERT', 'human-required')`).run(id);
    return `${id}:${result.lastInsertRowid}`;
  };
  const seen = () => [...new SeenStore(join(home, "state", "slack-outbound-seen.jsonl")).load()];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, queueRepo as never);
    c.set("gatewaySubsystem" as never, { restart, status: () => ({ state: loadConfig(home).enabled ? "active" : "disabled" }) } as never);
    await next();
  });
  app.route("/", gatewayRoutes({ home }));
  const post = (verb: string, body: object = {}) => app.request(`/slack/${verb}`, {
    method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator@rig" }, body: JSON.stringify(body),
  });
  const receipts = () => readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { home, app, restart, selectionCount, alert, seen, post, receipts };
}

describe("human channel lifecycle at the daemon door", () => {
  it("preserves disabled state when the existing backlog cannot be resolved", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "gateway", "humans.generated.yaml"), "invalid projection");
    const response = await f.post("enable");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "human_registry_unavailable" });
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.receipts().at(-1)).toMatchObject({ effect: "failed", after: null });
  });
  it("returns actionable JSON when the first enable has no human registry, without applying delivery state", async () => {
    const f = fixture({ registerHuman: false });
    const before = readFileSync(join(f.home, "slack-connector.json"), "utf8");
    const response = await f.post("enable");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: "human_registry_unavailable",
      message: expect.stringContaining("rig gateway human add"),
    });
    expect(readFileSync(join(f.home, "slack-connector.json"), "utf8")).toBe(before);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.selectionCount()).toBe(0);
    expect(existsSync(join(f.home, "state", "slack-outbound-seen.jsonl"))).toBe(false);
    expect(f.receipts().map(row => row.effect)).toEqual(["started", "failed"]);
    expect(f.receipts().at(-1)).toMatchObject({ before: { enabled: false }, after: null });
  });

  it("allows a valid empty registry to seed the backlog", async () => {
    const f = fixture({ registerHuman: false });
    f.alert("unregistered-backlog");
    expect(writeProjection(f.home).ok).toBe(true);
    const response = await f.post("enable");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, seeded: 0 });
    expect(f.seen()).toEqual([]);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.selectionCount()).toBe(1);
  });

  it("seeds the existing human backlog as history before enabling delivery", async () => {
    const f = fixture();
    const key = f.alert("existing-backlog");
    const response = await f.post("enable");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, seeded: 1 });
    expect(f.seen()).toEqual([key]);
    expect(f.selectionCount()).toBe(1);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(loadConfig(f.home).enabled).toBe(true);
  });

  it("keeps enable no-op and disable available when the human registry is missing", async () => {
    const f = fixture({ registerHuman: false });
    saveConfig({ ...loadConfig(f.home), enabled: true }, f.home);
    expect((await f.post("enable")).status).toBe(200);
    expect(f.receipts().at(-1)).toMatchObject({ effect: "no-op" });
    expect(f.restart).not.toHaveBeenCalled();
    expect((await f.post("disable", { reason: "offline maintenance" })).status).toBe(200);
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.selectionCount()).toBe(0);
  });

  it("serializes concurrent enables so a repeat cannot reseed newly pending work", async () => {
    const f = fixture();
    const before = f.alert("before-enable");
    let after: string | undefined;
    f.restart.mockImplementation(() => { after = f.alert("after-enable"); });
    const responses = await Promise.all([f.post("enable"), f.post("enable")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toMatchObject([{ seeded: 1 }, { seeded: 0 }]);
    expect(after).toBeDefined();
    expect(f.seen()).toEqual([before]);
    expect(f.seen()).not.toContain(after);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.selectionCount()).toBe(1);
    expect(f.receipts().filter((row) => row.effect !== "started").map((row) => row.effect)).toEqual(["applied", "no-op"]);
  });
  it("attributes changes, distinguishes repeats, and requires a shutdown reason before changing state", async () => {
    const f = fixture();
    const key = f.alert("attributed-backlog");
    expect((await f.post("enable", { actor: "other@rig", reason: "resume delivery" })).status).toBe(200);
    expect(f.seen()).toEqual([key]);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect((await f.post("enable", { reason: "replay" })).status).toBe(200);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.selectionCount()).toBe(1);
    expect((await f.post("disable")).status).toBe(400);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect((await f.post("disable", { reason: "bounded maintenance" })).status).toBe(200);
    expect((await f.post("disable", { reason: "repeat maintenance" })).status).toBe(200);
    expect(f.restart).toHaveBeenCalledTimes(2);
    const rows = f.receipts().filter((row) => row.effect !== "started");
    expect(rows.map((row) => row.effect)).toEqual(["applied", "no-op", "applied", "no-op"]);
    expect(rows[0]).toMatchObject({ actor: "operator@rig", provenance: "transport:v1", reason: "resume delivery", before: { enabled: false }, after: { enabled: true } });
    expect(rows[2]).toMatchObject({ reason: "bounded maintenance", before: { enabled: true }, after: { enabled: false } });
    expect(JSON.stringify(rows)).not.toMatch(/private-pointer|C-private|other@rig/);
  });

  it("requires a recordable actor without inventing an identity", async () => {
    const f = fixture();
    const response = await f.app.request("/slack/enable", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
  });
});
