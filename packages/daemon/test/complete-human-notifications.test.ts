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
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildOutboundMessage, escapeSlackText, reconcileToken } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { runDeliveryDigestFlush } from "../src/domain/policies/delivery-digest-flush.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Use the repaired view?", body: "Why: restores readable status. Recommendation: proceed; status briefly pauses. Approve or hold?", evidenceRef: "/private/retained-proof.md", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("complete human notifications", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "complete-human-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  it("keeps the complete action beyond the old excerpt in blocks and accessible fallback", () => {
    const body = "Context. ".repeat(100) + "\nAction: approve or hold.";
    const result = buildOutboundMessage({ qitemId: "q", summary: "Decision", body }, { sourceLabel: "proof", bodyExcerpt: 1, reconcileMarker: reconcileToken("d") });
    expect(result.text).toContain(body);
    expect(JSON.stringify(result.blocks)).toContain("Action: approve or hold.");
    expect(result.text).toContain(reconcileToken("d"));
  });

  it("handles actual escaped section boundaries without cutting Unicode or entities", () => {
    const body = "😀".repeat(1498) + "<&";
    expect(() => buildOutboundMessage({ qitemId: "q", body }, { sourceLabel: "proof" })).toThrow(/maximum 3000/);
    const fits = "😀".repeat(1495) + "<&";
    const result = buildOutboundMessage({ qitemId: "q", body: fits }, { sourceLabel: "proof" });
    expect(result.text).toContain(escapeSlackText(fits));
    expect(result.text).not.toContain("\uFFFD");
  });

  it("refuses subject, fallback and attachment overflow explicitly", () => {
    expect(() => buildOutboundMessage({ qitemId: "q", summary: "x".repeat(3000) }, { sourceLabel: "proof" })).toThrow(/subject/);
    expect(() => buildOutboundMessage({ qitemId: "q", summary: "s".repeat(1000), body: "b".repeat(2900) }, { sourceLabel: "proof" })).toThrow(/complete fallback/);
    expect(() => buildOutboundMessage({ qitemId: "q", body: "safe" }, { sourceLabel: "proof", mediaRefs: [{ imageUrl: "https://example.invalid/a.png", altText: "x".repeat(2001) }] })).toThrow(/image description/);
    const result = buildOutboundMessage({ qitemId: "q", body: "No action needed." }, { sourceLabel: "proof", mediaRefs: [{ imageUrl: "https://example.invalid/a.png", altText: "Capacity graph" }] });
    expect(result.text).toContain("Image: Capacity graph");
  });

  it("preserves legacy decisions and classifies explicit updates without prose/tag inference", async () => {
    const legacy = await repo.create({ ...request, body: "FYI no action needed", tags: ["informational"] });
    const update = await repo.create({ ...request, humanIntent: "update", tags: ["escalation"], humanDetail: "Retained supplemental context." });
    const rows = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(rows.find((q) => q.qitemId === legacy.qitemId)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    expect(rows.find((q) => q.qitemId === update.qitemId)).toMatchObject({ humanIntent: "update", humanDetail: "Retained supplemental context.", ownerNotificationKind: "human-update", ownerNotificationLevel: "NOTICE" });
    expect(repo.listAttention().map((q) => q.qitemId)).toEqual([legacy.qitemId]);
    expect(repo.list({ compact: true }).find((q) => q.qitemId === update.qitemId)?.humanIntent).toBe("update");
    const work = await repo.create({ ...request, destinationSession: "worker@rig" });
    expect(() => repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: update.qitemId, transitionNote: "await update" })).toThrow(/not an approval dependency/);
    await expect(repo.create({ ...request, humanIntent: "urgent" as never })).rejects.toThrow(/decision or update/);
    await expect(repo.create({ ...request, destinationSession: "worker@rig", humanIntent: "update" })).rejects.toThrow(/human destination/);
  });

  it("applies the canonical external/legacy predicate before LIMIT; tier/malformed/nonhuman rows cannot crowd it out", async () => {
    const external = await repo.create(request);
    const legacy = await repo.create({ ...request, destinationSession: "human-founder@kernel" });
    const parked = await repo.create({ ...request, destinationSession: "worker@rig" });
    db.prepare("UPDATE queue_items SET state='blocked', blocked_on='human-founder@external' WHERE qitem_id=?").run(parked.qitemId);
    for (const destinationSession of ["human-@kernel", "@external", "x@external@host", "worker@rig", "human-founder@external.invalid"]) {
      const row = await repo.create({ ...request, destinationSession: "worker@rig" });
      db.prepare("UPDATE queue_items SET destination_session=?, tier='human-gate', ts_created='2099-01-01' WHERE qitem_id=?").run(destinationSession, row.qitemId);
    }
    expect(repo.listAttention({ limit: 3 }).map((q) => q.qitemId).sort()).toEqual([external.qitemId, legacy.qitemId, parked.qitemId].sort());
  });

  it.each([false, true])("resumes only a missing/ambiguous supplemental part across reconstruction (landed=%s)", async (landed) => {
    const posted: Array<{ text: string; ts: string; thread_ts?: string }> = [];
    let calls = 0;
    const fetchImpl: FetchImpl = async (url, init) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: posted });
      const content = JSON.parse(String(init?.body)); calls++;
      const msg = { ...content, ts: `${100 + calls}.1` };
      if (calls !== 2 || landed) posted.push(msg);
      if (calls === 2) throw new Error("synthetic timeout");
      return reply({ ok: true, ts: msg.ts });
    };
    const delivered = new SeenStore(join(home, "delivered"));
    const attempted = new SeenStore(join(home, "attempted"));
    const outboundSeen = new SeenStore(join(home, "seen"));
    const onPosted = vi.fn();
    const opts = { botToken: "synthetic", channel: "C-TEST", sourceLabel: "fixture", fetchImpl, delivered, attempted, outboundSeen, onPosted };
    const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "stable", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q", humanDetail: "Supplemental context only." } };
    expect((await subsystemSlackDeliver(opts)(decision)).ok).toBe(false);
    expect(onPosted).not.toHaveBeenCalled();
    expect(outboundSeen.load().has("q")).toBe(false);
    expect(delivered.load().has("stable")).toBe(false);
    expect((await subsystemSlackDeliver(opts)(decision)).ok).toBe(true);
    expect(calls).toBe(landed ? 2 : 3);
    expect(posted.filter((p) => !p.thread_ts)).toHaveLength(1);
    expect(posted[1]?.thread_ts).toBe("101.1");
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(delivered.load().has("stable")).toBe(true);
    expect((await subsystemSlackDeliver(opts)(decision)).ok).toBe(true);
    expect(calls).toBe(landed ? 2 : 3);
  });

  it("preflights every part: content that can't be posted causes zero posts and a visible correction", async () => {
    // A long detail is now split into thread replies (#897); an oversized subject still can't be posted.
    const fetchImpl = vi.fn(); const failed = vi.fn();
    const deliver = subsystemSlackDeliver({ botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl, delivered: new SeenStore(join(home, "d")), attempted: new SeenStore(join(home, "a")), outboundSeen: new SeenStore(join(home, "s")), onTransportFailed: failed });
    const result = await deliver({ kind: "outbound_decision", decisionId: "d", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q", summary: "x".repeat(3001), humanDetail: "Supplemental context." } });
    expect(result).toMatchObject({ ok: false, class: "human-message-unrenderable" });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
  });

  it("runs queue→wire→complete quiet multipart delivery→done and bounded Feed history without a human decision", async () => {
    const item = await repo.create({ ...request, humanIntent: "update", body: "The release is ready. No action needed.", humanDetail: "Known limit: this is synthetic delivery proof.", tags: ["escalation"] });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    const posts: Array<Record<string, unknown>> = [];
    const wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); } });
    stops.push(() => wire.stop()); wire.startServices?.();
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(wire.dispatcher.dispatch("post_message", request.destinationSession, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.state).toBe("done"));
    expect(posts).toHaveLength(2); expect(JSON.stringify(posts)).not.toContain("<@UFOUNDER>");
    expect(posts[1]?.thread_ts).toBe(posts[0] ? "1.1" : "missing");
    const history = repo.listDeliveredHumanUpdates({ limit: 1 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ qitemId: item.qitemId, state: "done", humanIntent: "update", evidenceRef: request.evidenceRef });
    expect(history[0]?.deliveryReceipt).toContain("kind=human-update");
    expect(repo.listTransitions(item.qitemId).some((t) => t.ownerNotificationKind === "human-decision-resolved")).toBe(false);
    const act = vi.fn();
    expect(await makeHumanReplyResolver(repo, { act } as never)({ qitemId: item.qitemId, actorSession: request.destinationSession, decision: "Thanks" } as never)).toBe("not-applicable");
    expect(act).not.toHaveBeenCalled();
    // Receipt retention remains queryable without keeping terminal transitions hot.
    archiveAgedTerminalTransitions(db, { nowIso: "2099-01-02T00:00:00Z", batchSize: 10 });
    expect(repo.listDeliveredHumanUpdates({ limit: 1 })[0]?.qitemId).toBe(item.qitemId);
  });

  it("repairs the final receipt after all parts landed without repeating any part", async () => {
    let posts = 0;
    const onPosted = vi.fn().mockImplementationOnce(() => { throw new Error("synthetic receipt failure"); });
    const opts = { botToken: "synthetic", channel: "C", sourceLabel: "fixture", delivered: new SeenStore(join(home, "d")), attempted: new SeenStore(join(home, "a")), outboundSeen: new SeenStore(join(home, "s")), onPosted,
      fetchImpl: async () => reply({ ok: true, ts: `${++posts}.1` }) };
    const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "receipt-repair", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q", humanDetail: "Related context." } };
    expect(await subsystemSlackDeliver(opts)(decision)).toMatchObject({ ok: false, class: "receipt-failed" });
    expect(posts).toBe(2); expect(opts.outboundSeen.load().has("q")).toBe(false);
    expect(await subsystemSlackDeliver(opts)(decision)).toEqual({ ok: true });
    expect(posts).toBe(2); expect(onPosted).toHaveBeenCalledTimes(2);
  });

  it("exposes additive intent through HTTP and bounds delivered history with honest truncation", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
    app.route("/api/queue", queueRoutes());
    const create = (value: unknown) => app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": request.sourceSession }, body: JSON.stringify(value) });
    expect((await create({ ...request, humanIntent: "arbitrary" })).status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const response = await create({ ...request, humanIntent: "update", humanDetail: `Supplement ${i}` });
      expect(response.status).toBe(201);
      const item = await response.json(); expect(item.humanIntent).toBe("update");
      expect(item.humanDetail).toBe(`Supplement ${i}`);
      repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", state: "done", closureReason: "no-follow-on", transitionNote: `slack-owner-notification-posted notification_key=${item.qitemId}:fixture level=NOTICE kind=human-update message_ts=${i}.1` });
    }
    const result = await (await app.request("/api/queue/human-updates?limit=1")).json();
    expect(result).toMatchObject({ limit: 1, truncated: true }); expect(result.items).toHaveLength(1);
    expect(result.items[0].deliveryReceipt).toContain("kind=human-update");
    expect((await app.request("/api/queue/human-updates?limit=101")).status).toBe(400);
    expect(await (await app.request("/api/queue/list?attention=1")).json()).toEqual([]);
  });

  it("keeps failed FYIs pending and out of delivered history", async () => {
    const item = await repo.create({ ...request, humanIntent: "update" });
    expect(item.state).toBe("pending"); expect(repo.listDeliveredHumanUpdates()).toEqual([]);
    repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-transport-failed notification_key=x class=transport error=synthetic" });
    expect(repo.getById(item.qitemId)?.state).toBe("pending"); expect(repo.listDeliveredHumanUpdates()).toEqual([]);
  });

  it("keeps digest timing but dispatches each human request/update completely with stable identity", async () => {
    for (const humanIntent of ["decision", "update"] as const) {
      const item = await repo.create({ ...request, humanIntent, humanDetail: "Supplemental detail." });
      const key = `${item.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(item.qitemId)!.transitionId}`;
      repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${key}` });
    }
    const dispatch = vi.fn(() => ({ ok: true }));
    const input = { queueRepo: repo, registry: { loadHumanRegistry: () => registry }, home, dispatch, window: "4h" as const };
    expect(await runDeliveryDigestFlush(input)).toEqual({ dispatched: 2, members: 2 });
    const first = dispatch.mock.calls as unknown as Array<[string, string, Record<string, unknown>, { decisionId: string }]>;
    expect(first.every((call) => call[2].body === request.body && call[2].humanDetail === "Supplemental detail.")).toBe(true);
    const ids = first.map((call) => call[3].decisionId);
    await runDeliveryDigestFlush(input);
    expect((dispatch.mock.calls.slice(2) as unknown as typeof first).map((call) => call[3].decisionId)).toEqual(ids);
  });
});
