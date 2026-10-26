// Test-only: the real Slack gateway wire (inbound socket, router, outbound delivery, thread map) over migrated SQLite,
// with a fake Slack transport that records every post. The gateway home holds a person and a registered shared channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { addHumanFragment, loadHumanRegistry, resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { setSharedChannel, sharedChannelAddresses } from "../src/domain/gateway/participants.js";

// A customer writes in a registered shared channel; the support seat's answer, and a later update, go back into that
// customer's thread in that channel. A fresh post to the channel goes to the channel. No customer is registered.

const SUPPORT = "support@test-rig", CHANNEL = "acme-customers@external";
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("a shared channel's conversation, there and back", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  let socket: WsLike;
  const stops: Array<() => void> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "channel-way-back-"));
    expect(addHumanFragment({ entityId: "ana", class: "human", displayName: "Ana", address: "ana@external",
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "vault://slack/ana", role: "primary", handle: "UANA" }],
      prefs: { deliveryClass: "A" } }, home)).toMatchObject({ ok: true });
    expect(setSharedChannel("acme-customers", { displayName: "Acme customers",
      channel: { connector: "slack", connectorRef: "primary", secretsRef: "vault://slack/bot", channelId: "CACME" } }, {}, home).ok).toBe(true);
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const registry = () => loadHumanRegistry(home);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: registry, sharedChannels: () => sharedChannelAddresses(home),
      validateRig: makeTopologyDestinationCheck({ findRigsByName: () => [{}], loadHumanRegistry: registry, sharedChannels: () => sharedChannelAddresses(home) }) });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", inboundDestination: SUPPORT, secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    posts = [];
    const sockets: WsLike[] = [];
    const wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: registry, resolveSlackHandle },
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` });
      } });
    stops.push(() => wire.stop()); wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    socket = sockets[0]!; socket.onopen?.();
    deliverVia = async (qitemId: string) => {
      const before = posts.length;
      const alert = (await makeQueuePorts(repo, { loadHumanRegistry: registry, sharedChannels: () => sharedChannelAddresses(home) }).listHumanAlerts({}))
        .find((item) => item.qitemId === qitemId);
      expect(alert, "the row to the shared channel is selected for delivery").toBeDefined();
      expect(wire.dispatcher.dispatch("post_message", CHANNEL, alert)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
      return posts.at(-1)!;
    };
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  let deliverVia: (qitemId: string) => Promise<Record<string, unknown>>;
  const customerWrites = async (ts: string, text: string, threadTs?: string) => {
    socket.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api",
      payload: { event: { type: "message", user: "UCUSTOMER", channel: "CACME", ts, text, ...(threadTs ? { thread_ts: threadTs } : {}) } } }) });
    await vi.waitFor(() => expect(repo.list({ limit: 100 }).some((row) => row.body.startsWith(text))).toBe(true));
    return repo.list({ limit: 100 }).find((row) => row.body.startsWith(text))!;
  };

  it("the answer and a later update land in the customer's thread, in the channel, without mentioning anyone", async () => {
    const question = await customerWrites("500.1", "Where is my invoice?");
    expect(question).toMatchObject({ sourceSession: CHANNEL, destinationSession: SUPPORT });

    const answer = await repo.create({ sourceSession: SUPPORT, destinationSession: CHANNEL, humanIntent: "update", replyTo: question.qitemId,
      summary: "Your invoice", body: "It's attached to your account page.", nudge: false });
    const posted = await deliverVia(answer.qitemId);
    expect(posted).toMatchObject({ channel: "CACME", thread_ts: "500.1" });
    expect(String(posted.text ?? "")).not.toMatch(/<@U/);

    const later = await repo.create({ sourceSession: SUPPORT, destinationSession: CHANNEL, humanIntent: "update", replyTo: question.qitemId,
      summary: "Refund issued", body: "We've refunded the duplicate charge.", nudge: false });
    expect(await deliverVia(later.qitemId)).toMatchObject({ channel: "CACME", thread_ts: "500.1" });
  });

  it("a fresh post to the shared channel goes to that channel", async () => {
    const notice = await repo.create({ sourceSession: SUPPORT, destinationSession: CHANNEL, humanIntent: "update",
      summary: "Maintenance tonight", body: "Billing is offline 22:00-23:00.", nudge: false });
    const posted = await deliverVia(notice.qitemId);
    expect(posted.channel).toBe("CACME");
    expect(posted.thread_ts).toBeUndefined();
  });

  it("an ask's questions show in the channel as a list without buttons, asking for a reply in the thread", async () => {
    const ask = await repo.create({ sourceSession: SUPPORT, destinationSession: CHANNEL, humanIntent: "decision", summary: "Which plan?",
      body: "Which plan are you on?", evidenceRef: "/fixture/plan", nudge: false,
      humanQuestions: [{ id: "plan", question: "Which plan?", options: [{ id: "basic", label: "Basic" }, { id: "pro", label: "Pro", recommended: true }] }] });
    const posted = await deliverVia(ask.qitemId);
    const blocks = posted.blocks as Array<{ type: string; text?: { text?: string } }>;
    expect(blocks.some((block) => block.type === "actions")).toBe(false);
    expect(blocks.map((block) => block.text?.text ?? "").join("\n")).toContain("• Basic\n• Pro (recommended)");
    expect(String(posted.text)).toContain("Reply in this thread with your answer.");
    expect(String(posted.text)).not.toContain("Or reply in this thread with your own answer.");
  });

  it("the queue accepts a registered shared channel as a destination and refuses an unknown one", async () => {
    await expect(repo.create({ sourceSession: SUPPORT, destinationSession: "nobody-here@external", humanIntent: "update",
      summary: "x", body: "x", nudge: false })).rejects.toBeTruthy();
  });

  it("an ask to a shared channel is accepted with a warning that nothing there will answer it; an update has none", async () => {
    vi.stubEnv("OPENRIG_HOME", home);
    try {
      const app = new Hono();
      app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
      app.route("/api/queue", queueRoutes());
      const create = (value: Record<string, unknown>) => app.request("/api/queue/create", { method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": SUPPORT },
        body: JSON.stringify({ sourceSession: SUPPORT, destinationSession: CHANNEL, summary: "Refund?", body: "Shall we refund?", nudge: false, ...value }) });
      const ask = await create({ humanIntent: "decision", evidenceRef: "/fixture/refund" });
      expect(ask.status).toBe(201);
      expect((await ask.json()).advisories).toEqual([expect.objectContaining({ code: "shared_channel_correspondence", destinationSession: CHANNEL })]);
      const update = await create({ humanIntent: "update" });
      expect(update.status).toBe(201);
      expect(await update.json()).not.toHaveProperty("advisories");
    } finally { vi.unstubAllEnvs(); }
  });
});
