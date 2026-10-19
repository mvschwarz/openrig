import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { addHumanFragment, loadHumanRegistry } from "../src/domain/gateway/human-registry.js";
import { buildMatrixGatewayWire } from "../src/domain/gateway/matrix/matrix-subsystem.js";
import type { FetchImpl } from "../src/domain/gateway/matrix/matrix-api.js";
import { ThreadSeatMap } from "../src/domain/gateway/matrix/thread-seat-map.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/domain/gateway/matrix/config.js";
import { saveAccessToken } from "../src/domain/gateway/matrix/secrets.js";
import { matrixHumanReadiness } from "../src/domain/gateway/matrix/readiness.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { buildInProcessWire, combineGatewayWires, type GatewayWire } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { gatewayRoutes } from "../src/routes/gateway.js";

const room = "!room:example.org";
const alias = "#room:example.org";
const human = "alice@external";
const sender = "@alice:example.org";
const question = { id: "colour", question: "Choose a colour", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const isSend = (url: string) => url.includes("/send/m.room.message/");

let home: string;
let db: ReturnType<typeof createDb>;
let repo: QueueRepository;
const wires: GatewayWire[] = [];
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "matrix-subsystem-"));
  expect(addHumanFragment({ entityId: "alice", class: "human", displayName: "Alice", address: human,
    connectorBindings: [{ kind: "matrix", connectorRef: alias, secretsRef: "matrix-config", role: "primary", handle: sender }], prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => loadHumanRegistry(home) });
  saveConfig({ ...DEFAULT_CONFIG, enabled: true, homeserverUrl: "https://matrix.example.org", defaultRoom: room, secretsEnvFile: saveAccessToken("test-secret", home) }, home);
});
afterEach(() => {
  wires.splice(0).forEach((wire) => wire.stop());
  db.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function wire(fetchImpl: FetchImpl) {
  const result = buildMatrixGatewayWire({ home, queueRepo: repo, fetchImpl, intervalMs: 10, resolveHumanReply: makeHumanReplyResolver(repo, { act: async () => { throw Object.assign(new Error("direct ask"), { code: "qitem_not_leg1_parked" }); } }) });
  wires.push(result);
  return result;
}
function fixtureFetch(onSend: FetchImpl = async () => response({ event_id: "$posted" })): FetchImpl {
  let synced = false;
  return async (url, init) => {
    if (isSend(url)) return onSend(url, init);
    if (url.endsWith("whoami")) return response({ user_id: "@bot:example.org" });
    if (url.includes("/join/")) return response({ room_id: room });
    if (url.endsWith("/state")) return response([]);
    if (!synced) { synced = true; return response({ next_batch: "floor" }); }
    return new Promise((_resolve, reject) => {
      init!.signal!.throwIfAborted();
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
}
const ask = (extra: object = {}) => repo.create({ sourceSession: "seat@rig", destinationSession: human, summary: "Decide", body: "Please choose", humanIntent: "decision", humanQuestions: [question], nudge: false, ...extra });

describe("Matrix queue and subsystem integration", () => {
  it("composes without network calls and keeps disabled connectors inert", () => {
    const fetchImpl = vi.fn(fixtureFetch());
    const enabled = wire(fetchImpl);
    expect(enabled.status!()).toMatchObject({ configured: true, outboundReady: true, inboundReady: false });
    saveConfig({ ...loadConfig(home), enabled: false }, home);
    const disabled = wire(fetchImpl);
    disabled.startServices!();
    expect(disabled.dispatcher.dispatch("post_message", human, {})).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("establishes sync before sweeping, posts a structured ask, and records the queue receipt", async () => {
    const item = await ask();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(fixtureFetch(async (_url, init) => { bodies.push(JSON.parse(String(init!.body))); return response({ event_id: `$sent-${bodies.length}` }); }));
    const w = wire(fetchImpl);
    w.startServices!();
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ body: expect.stringContaining("1️⃣ Red"), "m.relates_to": { rel_type: "m.thread", event_id: "$sent-1" } });
    expect(fetchImpl.mock.calls.findIndex(([url]) => isSend(url))).toBeGreaterThan(fetchImpl.mock.calls.findIndex(([url]) => url.includes("/sync?")));
    expect(new DispatchBuffer(home).pending()).toEqual([]);
    expect(w.status!()).toMatchObject({ inboundReady: true, inbound: { state: "connected" } });
  });
  it("retains a failed send and replays after restart without duplicate question posts", async () => {
    const item = await ask();
    const first = wire(fixtureFetch(async () => { throw new Error("offline"); }));
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => loadHumanRegistry(home), connectorKind: "matrix" }).listHumanAlerts({});
    expect(first.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.deliveryOutcome).toBe("transport-failed"));
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    first.stop();
    const posted = vi.fn(async () => response({ event_id: `$sent-${posted.mock.calls.length}` }));
    wire(fixtureFetch(posted)).startServices!();
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(repo.getById(item.qitemId)?.deliveryOutcome).toBe("posted");
    expect(posted).toHaveBeenCalledTimes(2);
  });
  it("keeps a delivered Matrix update in history after closing it", async () => {
    const item = await ask({ humanIntent: "update", humanQuestions: undefined });
    wire(fixtureFetch()).startServices!();
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.state).toBe("done"));
    expect(repo.listDeliveredHumanUpdates()).toEqual([expect.objectContaining({
      qitemId: item.qitemId, deliveryOutcome: "posted", deliveryReceipt: expect.stringContaining("matrix-owner-notification-posted "),
    })]);
    archiveAgedTerminalTransitions(db, { nowIso: "2099-01-02T00:00:00Z", batchSize: 100 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM queue_transitions WHERE qitem_id = ?").get(item.qitemId)).toEqual({ count: 0 });
    expect(repo.listDeliveredHumanUpdates()).toEqual([expect.objectContaining({
      qitemId: item.qitemId, deliveryOutcome: "posted", deliveryReceipt: expect.stringContaining("matrix-owner-notification-posted "),
    })]);
  });
  it("drains a retained closed ask and leaves another connector's pending decisions alone", async () => {
    const item = await ask();
    repo.update({ qitemId: item.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on" });
    const buffer = new DispatchBuffer(home);
    buffer.enqueue({ kind: "outbound_decision", decisionId: "closed", op: "post_message", entityBindingRef: human, payload: { qitemId: item.qitemId } });
    buffer.enqueue({ kind: "outbound_decision", decisionId: "slack", op: "post_message", entityBindingRef: "other@external", payload: {} });
    const posted = vi.fn();
    wire(fixtureFetch(posted)).startServices!();
    await vi.waitFor(() => expect(buffer.pending().map((d) => d.decisionId)).toEqual(["slack"]));
    expect(posted).not.toHaveBeenCalled();
  });
  it("lands a bound alias sender's answer in the real queue and closes the direct ask", async () => {
    const item = await ask();
    let serial = 0;
    let syncCount = 0;
    let releasePage: (value: Response) => void = () => { throw new Error("sync not pending"); };
    const base = fixtureFetch(async () => response({ event_id: `$posted-${++serial}` }));
    const w = wire(async (url, init) => {
      if (url.includes("/sync?") && ++syncCount === 2) return new Promise<Response>((resolve, reject) => {
        releasePage = resolve;
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
      return base(url, init);
    });
    w.startServices!();
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(syncCount).toBe(2);
    releasePage(response({ next_batch: "answer", rooms: { join: { [room]: { timeline: { events: [
      { event_id: "$reaction", sender, type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$posted-2", key: "2️⃣" } } },
    ] } } } } }));
    await vi.waitFor(() => expect(repo.getById(item.qitemId)).toMatchObject({ humanAnswers: { colour: "blue" }, state: "done" }));
    const replies = repo.list({ destinationSession: "seat@rig" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ sourceSession: human, replyTo: item.qitemId, body: "Choose a colour: Blue" });
    expect(new ThreadSeatMap(home).resolveByConversation(human, "seat@rig", item.qitemId, room)?.threadRootEventId).toBe("$posted-1");
  });
  it("refuses encrypted rooms and isolates corrupt Matrix config from Slack", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes("/join/") ? response({ room_id: room }) : response([{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }]));
    const w = wire(fetchImpl);
    w.dispatcher.dispatch("post_message", human, { qitemId: "unknown", summary: "encrypted" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([url]) => isSend(url))).toBe(false);
    writeFileSync(path.join(home, "matrix-connector.json"), "broken JSON");
    const broken = wire(fetchImpl);
    const slackDelivery = vi.fn(async () => ({ ok: true as const }));
    const slack = buildInProcessWire({ home, ops: ["post_message"], acceptsDecision: (ref) => ref === "slack-human", deliver: slackDelivery });
    const combined = combineGatewayWires({ slack, matrix: broken }, (ref) => ref === "slack-human" ? "slack" : "matrix");
    expect(broken.status!()).toMatchObject({ configured: false, inbound: { state: "failed" } });
    expect(combined.dispatcher.dispatch("post_message", "slack-human", {})).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(slackDelivery).toHaveBeenCalledTimes(1));
  });
  it("checks encryption again before posting to a room that was already joined", async () => {
    let encrypted = false;
    const posted = vi.fn(async () => response({ event_id: "$posted" }));
    const base = fixtureFetch(posted);
    const w = wire(async (url, init) => url.endsWith("/state") && encrypted
      ? response([{ type: "m.room.encryption", state_key: "", content: {} }]) : base(url, init));
    w.dispatcher.dispatch("post_message", human, { summary: "first" });
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(posted).toHaveBeenCalledTimes(1);
    encrypted = true;
    w.dispatcher.dispatch("post_message", human, { summary: "second" });
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(1));
    expect(posted).toHaveBeenCalledTimes(1);
  });
});

describe("Matrix channel administration", () => {
  function routes() {
    const restart = vi.fn();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("queueRepo" as never, repo as never);
      c.set("gatewaySubsystem" as never, { restart, status: () => ({ state: "active" }), connectorStatus: () => ({ state: "active", connector: { connectors: { matrix: { inboundReady: true } } } }) } as never);
      await next();
    });
    app.route("/", gatewayRoutes({ home }));
    const post = (op: string, body: object = {}) => app.request(`/matrix/${op}`, { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator@rig" }, body: JSON.stringify(body) });
    return { app, post, restart };
  }
  it("seeds only Matrix backlog on first enable, reloads without seeding, and records disable receipts", async () => {
    const item = await ask();
    expect(addHumanFragment({ entityId: "bob", class: "human", displayName: "Bob", address: "bob@external",
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "slack-config", role: "primary" }], prefs: { deliveryClass: "B" } }, home).ok).toBe(true);
    await ask({ destinationSession: "bob@external" });
    saveConfig({ ...loadConfig(home), enabled: false }, home);
    const f = routes();
    const enabled = await f.post("enable");
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ ok: true, seeded: 1, receipt: { subject: "matrix", effect: "applied" } });
    expect([...new SeenStore(path.join(home, "state", "matrix-outbound-seen.jsonl")).load()]).toEqual([expect.stringContaining(item.qitemId)]);
    expect(loadConfig(home).enabled).toBe(true);
    expect(f.restart).toHaveBeenCalledTimes(1);
    const pending = await ask();
    const reloaded = await f.post("enable");
    expect(reloaded.status).toBe(200);
    expect(await reloaded.json()).toMatchObject({ seeded: 0, receipt: { effect: "applied" } });
    expect([...new SeenStore(path.join(home, "state", "matrix-outbound-seen.jsonl")).load()].some((key) => key.includes(pending.qitemId))).toBe(false);
    expect(f.restart).toHaveBeenCalledTimes(2);
    expect((await f.post("disable")).status).toBe(400);
    expect((await f.post("disable", { reason: "maintenance" })).status).toBe(200);
    expect(loadConfig(home).enabled).toBe(false);
    expect(f.restart).toHaveBeenCalledTimes(3);
    expect(await (await f.post("disable", { reason: "still in maintenance" })).json()).toMatchObject({ receipt: { effect: "no-op" } });
    expect(f.restart).toHaveBeenCalledTimes(3);
    const status = await f.app.request("/matrix/status");
    expect(await status.json()).toMatchObject({ state: "active", connector: { inboundReady: true } });
  });
  it("keeps readiness passive and reports missing configuration or inactive gateway", () => {
    const registry = loadHumanRegistry(home);
    if (!registry.ok) throw new Error(registry.error);
    const h = registry.entities[0]!;
    expect(matrixHumanReadiness(home, h, "active")).toMatchObject({ state: "indeterminate", ready: false, configured: true, active: true });
    expect(matrixHumanReadiness(home, h, "inactive")).toMatchObject({ state: "not-ready", active: false });
    saveConfig({ ...DEFAULT_CONFIG }, home);
    expect(matrixHumanReadiness(home, h, "active")).toMatchObject({ state: "not-ready", configured: false, nextAction: "rig matrix setup --help" });
  });
  it("refuses enable with actionable JSON when the registry is corrupt, preserving disabled state", async () => {
    saveConfig({ ...loadConfig(home), enabled: false }, home);
    writeFileSync(path.join(home, "gateway", "humans.generated.yaml"), "invalid projection");
    const f = routes();
    const result = await f.post("enable");
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: "human_registry_unavailable" });
    expect(loadConfig(home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
  });
  it.each(["config", "secret"])("reports unreadable %s as not-ready through the human route", async (kind) => {
    if (kind === "config") writeFileSync(path.join(home, "matrix-connector.json"), "broken JSON");
    else saveConfig({ ...loadConfig(home), secretsEnvFile: home }, home);
    const result = await routes().app.request("/human/alice/readiness");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, readiness: { state: "not-ready", ready: false,
      configured: false, reason: expect.stringContaining("Matrix configuration unreadable:"), nextAction: "rig matrix status" } });
  });
});
