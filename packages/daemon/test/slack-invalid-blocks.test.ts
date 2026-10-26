import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { reconcileToken } from "../src/domain/gateway/slack/message.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const request = { humanAlert: true, sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Approve the change?", body: "Please review the evidence.", nudge: false };
const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "d-rejected", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q-rejected" } };
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: request.destinationSession, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };

describe("Slack invalid_blocks is a permanent rejection (#47)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "slack-invalid-blocks-")); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
  // Recreate the stores on every call, as a new gateway process does.
  const stores = () => ({ delivered: new SeenStore(join(home, "delivered")), attempted: new SeenStore(join(home, "attempted")), outboundSeen: new SeenStore(join(home, "seen")) });
  const opts = () => ({ ...stores(), botToken: "synthetic", channel: "C-TEST", sourceLabel: "fixture" });

  it("keeps the rejection across restart without a post, history scan, or delivered mark", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: false, error: "invalid_blocks" }));
    const onTransportFailed = vi.fn();
    const outcome = { ok: false, class: "slack-invalid-blocks", detail: "invalid_blocks" };
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toEqual(outcome);
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toEqual(outcome);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(stores().delivered.load().size).toBe(0);
    expect(stores().outboundSeen.load().size).toBe(0);
    expect(onTransportFailed).toHaveBeenCalledWith(decision.payload, "slack-invalid-blocks", "invalid_blocks");

  });

  it("allows corrected blocks under the same decision id after restart", async () => {
    const posts: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: [] });
      posts.push(JSON.parse(String(init?.body)));
      return posts.length === 1 ? reply({ ok: false, error: "invalid_blocks" }) : reply({ ok: true, ts: "2.1" });
    });
    const rejected = { ...decision, payload: { ...decision.payload as object, evidenceRef: "https://example.com/page.png" } };
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(rejected)).toMatchObject({ class: "slack-invalid-blocks" });
    const corrected = { ...rejected, payload: { ...rejected.payload, evidenceRef: "https://example.com/proof.md" } };
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(corrected)).toEqual({ ok: true });
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[0])).toContain('"type":"image"');
    expect(JSON.stringify(posts[1])).not.toContain('"type":"image"');
    expect(stores().delivered.load().has(decision.decisionId)).toBe(true);
  });

  it("keeps a lost response uncertain and reconciles a landed post without reposting", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("chat.postMessage")) {
        posts++;
        throw new Error("request timed out after Slack accepted it");
      }
      return reply({ ok: true, messages: [{ ts: "1.1", text: reconcileToken(decision.decisionId) }] });
    });
    const onTransportFailed = vi.fn();
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toMatchObject({ class: "transport" });
    expect(onTransportFailed).not.toHaveBeenCalledWith(expect.anything(), "slack-invalid-blocks", expect.anything());
    expect(stores().delivered.load().size).toBe(0);
    expect(stores().outboundSeen.load().size).toBe(0);
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toEqual({ ok: true });
    expect(posts).toBe(1);
    expect(stores().delivered.load().has(decision.decisionId)).toBe(true);
  });

  it.each(["corrected", "reverted", "unrenderable"])("reconciles a corrected attempt's lost response despite an older rejection (replay=%s)", async (rendering) => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("chat.postMessage")) {
        if (++posts === 1) return reply({ ok: false, error: "invalid_blocks" });
        throw new Error("corrected message landed but its response was lost");
      }
      return reply({ ok: true, messages: posts === 2 ? [{ ts: "2.1", text: reconcileToken(decision.decisionId) }] : [] });
    });
    const onTransportFailed = vi.fn();
    const rejected = { ...decision, payload: { ...decision.payload as object, evidenceRef: "https://example.com/page.png" } };
    const corrected = { ...rejected, payload: { ...rejected.payload, evidenceRef: "https://example.com/proof.md" } };
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(rejected)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(corrected)).toMatchObject({ class: "transport" });
    const replay = rendering === "reverted" ? rejected : corrected;
    const replayOpts = () => ({ ...opts(), fetchImpl, onTransportFailed, ...(rendering === "unrenderable" ? { machine: () => "x".repeat(4000) } : {}) });
    onTransportFailed.mockClear();
    expect(await subsystemSlackDeliver(replayOpts())(replay)).toEqual({ ok: true });
    expect(onTransportFailed).not.toHaveBeenCalled();
    expect(posts).toBe(2);
    expect(stores().delivered.load().has(decision.decisionId)).toBe(true);
  });

  it("does not repost rejected blocks after reconciling an absent corrected attempt", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: [] });
      if (++posts === 1) return reply({ ok: false, error: "invalid_blocks" });
      throw new Error("corrected request timed out");
    });
    const corrected = { ...decision, payload: { ...decision.payload as object, body: "Corrected content." } };
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(corrected)).toMatchObject({ class: "transport" });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(posts).toBe(2);
    expect(fetchImpl.mock.calls.filter(([url]) => !url.endsWith("chat.postMessage"))).toHaveLength(2);
    expect(stores().delivered.load().size).toBe(0);
  });

  it("repairs a failed queue receipt after restart without retrying the rejected post", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: false, error: "invalid_blocks" }));
    const onTransportFailed = vi.fn(() => { throw new Error("database unavailable"); });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toMatchObject({ class: "receipt-failed" });
    onTransportFailed.mockImplementation(() => {});
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(decision)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(stores().delivered.load().size).toBe(0);
  });

  it("retains a rejection when the receipt repair marker fails", async () => {
    const attempted = stores().attempted;
    const mark = attempted.mark.bind(attempted);
    vi.spyOn(attempted, "mark").mockImplementation((id, status) => {
      if (status === "transport-failure-receipt-repaired") throw new Error("repair marker unavailable");
      mark(id, status);
    });
    const fetchImpl = vi.fn(async () => reply({ ok: false, error: "invalid_blocks" }));
    expect(await subsystemSlackDeliver({ ...opts(), attempted, fetchImpl })(decision)).toMatchObject({ class: "receipt-failed" });
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(stores().delivered.load().size).toBe(0);
  });

  it("retains the rejection when no receipt hook is installed", async () => {
    const fetchImpl = vi.fn(async () => reply({ ok: false, error: "invalid_blocks" }));
    await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision);
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([0, 429, 503])("still reconciles and retries a transient failure (%s)", async (status) => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: [] });
      if (++posts > 1) return reply({ ok: true, ts: "2.1" });
      if (status === 0) throw new Error("network unavailable");
      return reply({ ok: false, error: "invalid_blocks" }, status);
    });
    expect((await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).ok).toBe(false);
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl })(decision)).toEqual({ ok: true });
    expect(posts).toBe(2);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("conversations.history"))).toBe(true);
  });

  it("reports a rejected later part against the whole ask and preserves the posted primary", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async () => ++posts === 1 ? reply({ ok: true, ts: "1.1" }) : reply({ ok: false, error: "invalid_blocks" }));
    const onTransportFailed = vi.fn();
    const ask = { ...decision, payload: { ...decision.payload as object, humanDetail: "Supplemental evidence." } };
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(ask)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(onTransportFailed).toHaveBeenLastCalledWith(ask.payload, "slack-invalid-blocks", "invalid_blocks", true);
    expect(await subsystemSlackDeliver({ ...opts(), fetchImpl, onTransportFailed })(ask)).toMatchObject({ class: "slack-invalid-blocks" });
    expect(posts).toBe(2);
    expect(stores().delivered.load().has(decision.decisionId)).toBe(false);
    expect(stores().outboundSeen.load().size).toBe(0);
  });

  it.each([false, true])("records the rejection and tells the source once despite an older notice, across wire restarts (partial=%s)", async (multipart) => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);
    const item = await repo.create({ ...request, ...(multipart ? { humanDetail: "Supplemental evidence." } : {}) });
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    const olderNotice = await repo.create({
      qitemId: `${item.qitemId}-undeliverable`, sourceSession: request.sourceSession, destinationSession: request.sourceSession,
      body: "An earlier ask could not be rendered.", tags: ["slack-undeliverable"], nudge: false,
    });
    const noticeId = `${alert!.notificationKey ?? item.qitemId}-invalid-blocks-undeliverable`;
    repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-transport-failed notification_key=${alert!.notificationKey} class=transport error=timeout` });
    let posts = 0;
    const fetchImpl = vi.fn(async () => multipart && ++posts === 1
      ? reply({ ok: true, ts: "1.1" })
      : reply({ ok: false, error: "invalid_blocks" }));
    const logs: string[] = [];
    const makeWire = () => buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl, log: (msg) => logs.push(msg) });
    let wire = makeWire();
    try {
      wire.dispatcher.dispatch("post_message", request.destinationSession, alert);
      await vi.waitFor(() => expect(repo.getById(noticeId)).toBeTruthy());
      expect(repo.getById(item.qitemId)).toMatchObject({ state: "pending", deliveryOutcome: "transport-failed" });
      expect(repo.listTransitions(item.qitemId).some((t) => t.transitionNote?.includes("class=slack-invalid-blocks error=invalid_blocks"))).toBe(true);
      expect(repo.getById(noticeId)).toMatchObject({ destinationSession: request.sourceSession, body: expect.stringContaining("will not retry this payload") });
      expect(repo.getById(noticeId)!.body).toContain(multipart ? "Part of your ask" : "has not seen it");
      expect(repo.getById(olderNotice.qitemId)!.body).toBe(olderNotice.body);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
      wire.stop();
      wire = makeWire();
      wire.startServices?.();
      await vi.waitFor(() => expect(logs.filter((s) => s.includes("slack-invalid-blocks")).length).toBeGreaterThanOrEqual(2));
      expect(fetchImpl).toHaveBeenCalledTimes(multipart ? 2 : 1);
      expect(repo.list({ destinationSession: request.sourceSession }).filter((q) => q.tags.includes("slack-undeliverable"))).toHaveLength(2);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
      const swept = await runStuckSweep({ db, queueRepo: repo, resolveOrchestrator: () => null,
        unclaimedAgeMinutes: 60, isRegisteredHost: () => false });
      expect(swept.outcome).not.toBe("failed");
      expect(swept.findings).toContainEqual(expect.objectContaining({ qitemId: item.qitemId,
        findingQitemId: noticeId, action: "refreshed" }));
      expect(repo.list({ destinationSession: request.sourceSession }).filter((q) => q.tags.includes("stuck-sweep-finding"))).toHaveLength(0);
    } finally { wire.stop(); db.close(); }
  });
});
