import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWebApi } from "../src/domain/gateway/slack/slack-api.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { reconcileToken } from "../src/domain/gateway/slack/message.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

// Slack answered 200, and the body read then failed: the shape a stalled daemon gives when its
// 15 s abort fires after the headers arrive.
const unreadable200 = () => new Response(new ReadableStream({ start(c) { c.error(new Error("timeout after 15000ms")); } }), { status: 200 });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const request = { humanAlert: true, sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Approve the change?", body: "Please review the evidence.", nudge: false };
const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "d-unreadable", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q-unreadable" } };
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: request.destinationSession, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };

describe("a Slack 200 whose body can't be read", () => {
  it("keeps the reason instead of 'http 200' and says the response was unreadable", async () => {
    const r = await callWebApi("chat.postMessage", "synthetic", { channel: "C" }, async () => unreadable200());
    expect(r).toMatchObject({ ok: false, status: 200, responseUnreadable: true, error: "response unreadable after HTTP 200: timeout after 15000ms" });
  });

  it("keeps Slack's own error for a readable ok:false, and the status for a non-2xx", async () => {
    expect(await callWebApi("chat.postMessage", "synthetic", {}, async () => reply({ ok: false, error: "msg_blocks_too_long" })))
      .toMatchObject({ ok: false, status: 200, error: "msg_blocks_too_long" });
    expect((await callWebApi("chat.postMessage", "synthetic", {}, async () => reply({ ok: false, error: "msg_blocks_too_long" }))).responseUnreadable).toBeUndefined();
    expect(await callWebApi("chat.postMessage", "synthetic", {}, async () => new Response("<html>bad gateway</html>", { status: 502 })))
      .toMatchObject({ ok: false, status: 502, error: "http 502" });
  });
});

describe("delivery of an ask whose post may have landed", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "slack-unreadable-200-")); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
  // Recreate the stores on every call, as a new gateway process does.
  const stores = () => ({ delivered: new SeenStore(join(home, "delivered")), attempted: new SeenStore(join(home, "attempted")), outboundSeen: new SeenStore(join(home, "seen")) });
  const opts = () => ({ ...stores(), botToken: "synthetic", channel: "C-TEST", sourceLabel: "fixture" });

  it("is recorded as possibly posted, then reconciled by its marker without a repost", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("chat.postMessage")) { posts++; return unreadable200(); }
      return reply({ ok: true, messages: [{ ts: "1.1", text: reconcileToken(decision.decisionId) }] });
    });
    const onTransportFailed = vi.fn();
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision))
      .toEqual({ ok: false, class: "possibly-posted", detail: "response unreadable after HTTP 200: timeout after 15000ms" });
    expect(onTransportFailed).toHaveBeenCalledWith(decision.payload, "possibly-posted", "response unreadable after HTTP 200: timeout after 15000ms");
    expect(stores().delivered.load().size).toBe(0);
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toEqual({ ok: true });
    expect(posts).toBe(1);
    expect(stores().delivered.load().has(decision.decisionId)).toBe(true);
  });

  it("posts once when the marker isn't there", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("chat.postMessage")) return ++posts === 1 ? unreadable200() : reply({ ok: true, ts: "2.1" });
      return reply({ ok: true, messages: [] });
    });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toMatchObject({ class: "possibly-posted" });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toEqual({ ok: true });
    expect(posts).toBe(2);
  });

  it("keeps today's class for a named Slack error", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: false, error: "msg_blocks_too_long" }));
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toEqual({ ok: false, class: "http-200", detail: "msg_blocks_too_long" });
  });
});

describe("the receipt the gateway records on the ask's row", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "slack-unreadable-200-wire-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("records a change into possibly-posted after a named failure, and out of it again, but not a repeat", async () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);
    const item = await repo.create(request);
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    const key = alert!.notificationKey ?? item.qitemId;
    // An earlier attempt that Slack refused by name.
    repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-transport-failed notification_key=${key} class=http-200 error=channel_not_found` });
    let answer: () => Response = unreadable200;
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("chat.postMessage") ? answer() : reply({ ok: true, messages: [] }));
    const receipts = (failureClass: string) => repo.listTransitions(item.qitemId).filter((t) =>
      t.transitionNote?.startsWith(`slack-owner-notification-transport-failed notification_key=${key} class=${failureClass} `)).length;
    // Each failed post the production callback handled leaves one repaired-receipt line in the attempted store.
    const handled = () => readFileSync(join(home, "state", "slack-attempted-decisions.jsonl"), "utf8").split("\n")
      .filter((line) => line.includes("transport-failure-receipt-repaired")).length;
    const makeWire = () => buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl, log: () => {} });
    let wire = makeWire();
    try {
      wire.dispatcher.dispatch("post_message", request.destinationSession, alert);
      await vi.waitFor(() => expect(handled()).toBe(1));
      expect(receipts("possibly-posted"), "the change into possibly-posted is on the row").toBe(1);
      // The gateway starts again; no marker in the channel, so it posts once more and the reply is unreadable again.
      wire.stop(); wire = makeWire(); wire.startServices?.();
      await vi.waitFor(() => expect(handled()).toBe(2));
      expect(receipts("possibly-posted"), "an equivalent receipt isn't recorded twice").toBe(1);
      // And again, with Slack refusing it by name: the change out of possibly-posted is on the row too.
      answer = () => reply({ ok: false, error: "channel_not_found" });
      wire.stop(); wire = makeWire(); wire.startServices?.();
      await vi.waitFor(() => expect(handled()).toBe(3));
      expect(receipts("http-200")).toBe(2);
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("chat.postMessage"))).toHaveLength(3);
    } finally { wire.stop(); db.close(); }
  });
});

describe("the stuck sweep on a possibly-posted ask", () => {
  it("says it may have posted and that the marker is checked before any resend", async () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    try {
      const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
      const item = await repo.create(request);
      repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel",
        transitionNote: `slack-owner-notification-transport-failed notification_key=${item.qitemId}:1 class=possibly-posted error=response unreadable after HTTP 200: timeout after 15000ms` });
      await runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null, unclaimedAgeMinutes: 60, isRegisteredHost: () => false });
      const [finding] = repo.list({ destinationSession: request.sourceSession }).filter((q) => q.tags.includes("stuck-sweep-finding"));
      expect(finding?.body).toContain("may have posted");
      expect(finding?.body).toContain("checks Slack for its marker before any resend");
      expect(finding?.body).not.toContain("transport-failed to");
    } finally { db.close(); }
  });
});

describe("an alert on an update", () => {
  it("is refused with the route that does reach the person", async () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    try {
      const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
      await expect(repo.create({ ...request, humanIntent: "update" })).rejects.toThrow(
        "humanAlert marks an ask to a person as alert-worthy, and an update isn't an ask: send it without --alert; updates are notices; delivery depends on the person's connector and settings.");
    } finally { db.close(); }
  });
});
