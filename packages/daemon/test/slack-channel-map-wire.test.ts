// #192 — the channel map through the REAL Slack wire: queue rows → buildSlackGatewayWire →
// injected fetch (no network) and a fake socket. Made-up channel IDs and rig names only.
// The map changes where items POST; inbound routing and history recovery stay as on main.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig, type SlackConnectorConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { ThreadSeatMap, parsePostedStamp } from "../src/domain/gateway/slack/thread-seat-map.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import type { ChannelMapEntry } from "../src/domain/gateway/slack/channel-map.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const MAP: ChannelMapEntry[] = [
  { match: "my-rig", channel: "C0EXAMPLE1" },
  { match: "pr@my-rig", channel: "C0EXAMPLE2" },
];

describe("#192 channel map through the real Slack wire", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let posts: Array<Record<string, unknown>>;
  // Fake Slack failure modes for the next chat.postMessage: "failed" = refused, nothing landed;
  // "landed" = the message landed but the response was lost (an ambiguous attempt).
  let nextPost: "ok" | "failed" | "landed" = "ok";
  let landed: Array<{ channel: string; ts: string; text: string }>;
  let historyChannels: string[];
  let sockets: WsLike[];
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  const stops: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "channel-map-wire-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    posts = []; historyChannels = []; sockets = []; landed = []; nextPost = "ok";
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  function rewire(channelMap: ChannelMapEntry[] | undefined, inbound = false, defaultChannel = "C0DEFAULT"): void {
    wire?.stop();
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, `SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n${inbound ? "SLACK_APP_TOKEN=xapp-EXAMPLE-fake\n" : ""}`);
    const cfg: SlackConnectorConfig = { ...DEFAULT_CONFIG, enabled: true, channel: defaultChannel, secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE", ...(channelMap ? { channelMap } : {}) };
    saveConfig(cfg, home);
    wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      fetchImpl: async (url, init) => {
        if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
        if (url.includes("conversations.history") || url.includes("conversations.replies")) {
          const raw = String(init?.body ?? "");
          const params = raw.startsWith("{") ? JSON.parse(raw) as Record<string, string> : Object.fromEntries(new URLSearchParams(raw));
          const channel = new URL(url).searchParams.get("channel") ?? params.channel ?? "";
          historyChannels.push(channel);
          return reply({ ok: true, messages: landed.filter((m) => m.channel === channel).map(({ ts, text }) => ({ ts, text })), has_more: false });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posts.push(body);
        const ts = `${posts.length}.1`;
        const mode = nextPost; nextPost = "ok";
        if (mode === "failed") return reply({ ok: false, error: "ratelimited" });
        landed.push({ channel: String(body.channel), ts, text: String(body.text ?? "") });
        if (mode === "landed") return reply({ ok: false, error: "fake_lost_response" });
        return reply({ ok: true, ts });
      },
    });
    stops.push(() => wire.stop()); wire.startServices?.();
  }

  const alerts = new Map<string, unknown>();
  async function deliver(qitemId: string): Promise<Record<string, unknown>> {
    const before = posts.length;
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId);
    expect(alert).toBeDefined();
    alerts.set(qitemId, alert);
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(repo.getById(qitemId)?.deliveryOutcome).toBe("posted"));
    return posts.at(-1)!;
  }
  // Another notification episode of an already-posted item (what a later owner notification on
  // the same row dispatches): same payload, a new notification key.
  async function deliverEpisode(qitemId: string, episode: string): Promise<Record<string, unknown>> {
    const before = posts.length;
    const alert = { ...(alerts.get(qitemId) as object), notificationKey: `${qitemId}:${episode}` };
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    return posts.at(-1)!;
  }
  const ask = (sourceSession: string, extra: Record<string, unknown> = {}) =>
    repo.create({ sourceSession, destinationSession: human, summary: "Merge it?", body: "Approve or hold?", nudge: false, ...extra });

  it("a seat entry posts to its channel, a rig entry covers the rig's other seats, everything else uses the default", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig");
    const lead = await ask("lead@my-rig");
    const other = await ask("impl@other-rig");
    expect((await deliver(pr.qitemId)).channel).toBe("C0EXAMPLE2");
    expect((await deliver(lead.qitemId)).channel).toBe("C0EXAMPLE1");
    expect((await deliver(other.qitemId)).channel).toBe("C0DEFAULT");
  });

  it("a new root records the channel it was posted in, on the thread map and on the rebuild stamp", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig");
    await deliver(pr.qitemId);
    expect(new ThreadSeatMap(db).resolveByThread("1.1")).toMatchObject({ channel: "C0EXAMPLE2", seat: "pr@my-rig" });
    const stamp = repo.transitionLog.listForQitem(pr.qitemId).map((t) => t.transitionNote ?? "").map(parsePostedStamp).find(Boolean);
    expect(stamp).toMatchObject({ channel: "C0EXAMPLE2", threadTs: "1.1" });
  });

  it("without a map every seat posts to the default channel (today's behaviour)", async () => {
    rewire(undefined);
    const pr = await ask("pr@my-rig");
    expect((await deliver(pr.qitemId)).channel).toBe("C0DEFAULT");
    expect(new ThreadSeatMap(db).resolveByThread("1.1")?.channel).toBe("C0DEFAULT");
  });

  it("another episode of the same item threads under its root, in the root's channel", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig");
    await deliver(pr.qitemId);
    const again = await deliverEpisode(pr.qitemId, "episode-2");
    expect(again).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: "1.1" });
  });

  it("--reply-to threads under a root in the seat's mapped channel (the guard compares the resolved channel)", async () => {
    rewire(MAP);
    const decision = await ask("pr@my-rig");
    await deliver(decision.qitemId);
    repo.update({ qitemId: decision.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
    const update = await ask("pr@my-rig", { humanIntent: "update", summary: "Merged.", body: "Merged.", replyTo: decision.qitemId });
    const posted = await deliver(update.qitemId);
    expect(posted).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: "1.1" });
    expect(repo.getById(update.qitemId)?.replyToFallback).toBeNull();
  });

  // #192 policy (rev1.r2 HIGH): with a map, a post's channel is decided once, at its first attempt,
  // and recorded; every retry or replay of that post reuses it with its thread. A remap applies to
  // posts whose first attempt comes after it.
  async function retainFailedPost(qitemId: string, mode: "failed" | "landed"): Promise<Record<string, unknown>> {
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId)!;
    nextPost = mode;
    const before = posts.length;
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(repo.getById(qitemId)?.deliveryOutcome).toBe("transport-failed"));
    return posts.at(-1)!;
  }

  it("R2: a retained reply-to retry after a remap posts to the ORIGINAL channel with its root, and reconciles there", async () => {
    rewire(MAP);
    const decision = await ask("pr@my-rig");
    await deliver(decision.qitemId); // root 1.1 in C0EXAMPLE2
    repo.update({ qitemId: decision.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
    const update = await ask("pr@my-rig", { humanIntent: "update", summary: "Merged.", body: "Merged.", replyTo: decision.qitemId });
    expect(await retainFailedPost(update.qitemId, "failed")).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: "1.1" });
    const before = posts.length;
    historyChannels = [];
    rewire([{ match: "pr@my-rig", channel: "C0EXAMPLE3" }]); // the replay of the retained decision runs here
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.at(-1)).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: "1.1" });
    expect(historyChannels).toEqual(["C0EXAMPLE2"]); // the reconcile scan targets the original channel
    await vi.waitFor(() => expect(repo.getById(update.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(posts.slice(before).some((p) => p.channel === "C0EXAMPLE3")).toBe(false);
  });

  it("the reply-to choice records its channel only when a map is configured", async () => {
    const choiceNote = (qitemId: string) => repo.transitionLog.listForQitem(qitemId).map((t) => t.transitionNote ?? "").find((n) => n.startsWith("slack-reply-to-choice"));
    for (const [map, channelField] of [[MAP, " channel=C0EXAMPLE2"], [undefined, ""]] as const) {
      rewire(map ? [...map] : undefined);
      const decision = await ask("pr@my-rig");
      await deliver(decision.qitemId);
      const expected = `slack-reply-to-choice kind=thread thread_ts=${posts.length}.1${channelField}`;
      repo.update({ qitemId: decision.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
      const update = await ask("pr@my-rig", { humanIntent: "update", summary: "Merged.", body: "Merged.", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      expect(choiceNote(update.qitemId)).toBe(expected);
    }
  });

  // rev1.r2: the channel= suffix must not hide a shared root from isReplyToThread.
  it("isReplyToThread finds a thread choice recorded with or without the channel suffix, and only that exact thread", async () => {
    const item = await ask("pr@my-rig", { humanIntent: "update" });
    const note = (text: string, actorSession = "daemon@kernel") => repo.update({ qitemId: item.qitemId, actorSession, transitionNote: text });
    note("slack-reply-to-choice kind=thread thread_ts=1.1");
    note("slack-reply-to-choice kind=thread thread_ts=2.2 channel=C0EXAMPLE2");
    note("slack-reply-to-choice kind=thread thread_ts=3.3 channel=C0EXAMPLE2", "author@my-rig"); // not the daemon: never trusted
    expect(repo.isReplyToThread("1.1")).toBe(true);
    expect(repo.isReplyToThread("2.2")).toBe(true);
    expect(repo.isReplyToThread("3.3")).toBe(false);
    expect(repo.isReplyToThread("1.10")).toBe(false); // exact thread, not a prefix
    expect(repo.isReplyToThread("2.20")).toBe(false);
    expect(repo.isReplyToThread("2")).toBe(false);
  });

  it("with a map, once an update shares a root, the owner's next decision opens a fresh root (the reply-to note carries channel=)", async () => {
    rewire(MAP);
    const decision = await ask("pr@my-rig");
    await deliver(decision.qitemId); // root 1.1 in C0EXAMPLE2
    repo.update({ qitemId: decision.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
    const update = await ask("pr@my-rig", { humanIntent: "update", summary: "Merged.", body: "Merged.", replyTo: decision.qitemId });
    expect(await deliver(update.qitemId)).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: "1.1" }); // the root is now shared
    expect(repo.isReplyToThread("1.1")).toBe(true);
    const again = await deliverEpisode(decision.qitemId, "re-park");
    expect(again.channel).toBe("C0EXAMPLE2");
    expect(again.thread_ts).toBeUndefined(); // a fresh root, never the shared FYI thread
  });

  it("an ambiguous fresh-root attempt that landed is reconciled in its original channel after a remap; nothing posts to the new one", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig");
    expect(await retainFailedPost(pr.qitemId, "landed")).toMatchObject({ channel: "C0EXAMPLE2" });
    const before = posts.length;
    historyChannels = [];
    rewire([{ match: "pr@my-rig", channel: "C0EXAMPLE3" }]);
    await vi.waitFor(() => expect(repo.getById(pr.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(historyChannels).toEqual(["C0EXAMPLE2"]);
    expect(posts.length).toBe(before); // reconciled by marker: no repost, no duplicate in C0EXAMPLE3
    expect(new ThreadSeatMap(db).resolveByThread("1.1")).toMatchObject({ channel: "C0EXAMPLE2", conversationId: pr.qitemId });
  });

  it("an ambiguous own-thread attempt that landed is reconciled in its root's channel after a remap", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig");
    await deliver(pr.qitemId); // root 1.1 in C0EXAMPLE2
    const alert = { ...(alerts.get(pr.qitemId) as object), notificationKey: `${pr.qitemId}:episode-2` };
    nextPost = "landed";
    const before = posts.length;
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.at(-1)).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: "1.1" });
    const afterAttempt = posts.length;
    historyChannels = [];
    rewire([{ match: "pr@my-rig", channel: "C0EXAMPLE3" }]);
    await vi.waitFor(() => expect(historyChannels).toContain("C0EXAMPLE2"));
    await vi.waitFor(() => expect(repo.transitionLog.hasOwnerNotificationReceipt(pr.qitemId, `${pr.qitemId}:episode-2`)).toBe(true));
    expect(historyChannels).toEqual(["C0EXAMPLE2"]);
    expect(posts.length).toBe(afterAttempt); // no repost anywhere
  });

  it("once the retained post completes, the seat's next new post goes to the newly mapped channel", async () => {
    rewire(MAP);
    const first = await ask("pr@my-rig");
    await retainFailedPost(first.qitemId, "failed");
    rewire([{ match: "pr@my-rig", channel: "C0EXAMPLE3" }]);
    await vi.waitFor(() => expect(repo.getById(first.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(posts.at(-1)).toMatchObject({ channel: "C0EXAMPLE2" }); // the retained post finished where it started
    const next = await ask("pr@my-rig");
    expect((await deliver(next.qitemId)).channel).toBe("C0EXAMPLE3");
  });

  it("a supplemental part retried after a remap follows its primary into the original channel and thread", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig", { humanDetail: "Longer detail for the thread." });
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === pr.qitemId)!;
    const before = posts.length;
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before)); // primary posted as root
    nextPost = "failed"; // ...but the supplemental part fails
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before + 1));
    const primary = posts[before]!;
    expect(primary).toMatchObject({ channel: "C0EXAMPLE2" });
    const primaryTs = `${before + 1}.1`;
    const afterFail = posts.length;
    rewire([{ match: "pr@my-rig", channel: "C0EXAMPLE3" }]);
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(afterFail));
    expect(posts.at(-1)).toMatchObject({ channel: "C0EXAMPLE2", thread_ts: primaryTs });
  });

  // rev1.r1 S2: the FIRST map added while a post is in flight. A post first attempted with no map
  // went to the default channel, so its retries stay there once a map exists.
  it("first map added: an ambiguous root that landed in the default channel is reconciled there, not duplicated into the mapped channel", async () => {
    rewire(undefined);
    const pr = await ask("pr@my-rig");
    expect(await retainFailedPost(pr.qitemId, "landed")).toMatchObject({ channel: "C0DEFAULT" });
    const before = posts.length;
    historyChannels = [];
    rewire(MAP);
    await vi.waitFor(() => expect(repo.getById(pr.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(historyChannels).toEqual(["C0DEFAULT"]);
    expect(posts.length).toBe(before); // no repost, nothing in C0EXAMPLE2
  });

  it("first map added: a retained reply-to posts to the default channel with its root, not the mapped channel", async () => {
    rewire(undefined);
    const decision = await ask("pr@my-rig");
    await deliver(decision.qitemId); // root 1.1 in C0DEFAULT
    repo.update({ qitemId: decision.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
    const update = await ask("pr@my-rig", { humanIntent: "update", summary: "Merged.", body: "Merged.", replyTo: decision.qitemId });
    expect(await retainFailedPost(update.qitemId, "failed")).toMatchObject({ channel: "C0DEFAULT", thread_ts: "1.1" });
    const before = posts.length;
    historyChannels = [];
    rewire(MAP);
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.at(-1)).toMatchObject({ channel: "C0DEFAULT", thread_ts: "1.1" });
    expect(historyChannels).toEqual(["C0DEFAULT"]);
    await vi.waitFor(() => expect(repo.getById(update.qitemId)?.deliveryOutcome).toBe("posted"));
  });

  it("first map added: a supplemental part retried after the map is added follows its primary in the default channel", async () => {
    rewire(undefined);
    const pr = await ask("pr@my-rig", { humanDetail: "Longer detail for the thread." });
    const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === pr.qitemId)!;
    const before = posts.length;
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    nextPost = "failed";
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before + 1));
    expect(posts[before]).toMatchObject({ channel: "C0DEFAULT" });
    const primaryTs = `${before + 1}.1`;
    const afterFail = posts.length;
    rewire(MAP);
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(afterFail));
    expect(posts.at(-1)).toMatchObject({ channel: "C0DEFAULT", thread_ts: primaryTs });
  });

  it("first map added: the seat's next NEW post goes to its mapped channel", async () => {
    rewire(undefined);
    const first = await ask("pr@my-rig");
    await retainFailedPost(first.qitemId, "failed");
    rewire(MAP);
    await vi.waitFor(() => expect(repo.getById(first.qitemId)?.deliveryOutcome).toBe("posted"));
    expect(posts.at(-1)).toMatchObject({ channel: "C0DEFAULT" });
    const next = await ask("pr@my-rig");
    expect((await deliver(next.qitemId)).channel).toBe("C0EXAMPLE2");
  });

  it("no map: a retained retry after the default channel changes resolves the channel as before (the current default)", async () => {
    rewire(undefined, false, "C0OLDDEFAULT");
    const pr = await ask("pr@my-rig");
    expect(await retainFailedPost(pr.qitemId, "failed")).toMatchObject({ channel: "C0OLDDEFAULT" });
    const before = posts.length;
    rewire(undefined, false, "C0NEWDEFAULT");
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.at(-1)).toMatchObject({ channel: "C0NEWDEFAULT" });
  });

  it("no map: after the default channel changes, an item's next notification still threads under its root, exactly as before the map existed", async () => {
    // Pins upstream behaviour for map-less installs: the open root is reused whatever channel it
    // was posted in, and the post goes to the current default channel with that root's thread_ts.
    rewire(undefined, false, "C0OLDDEFAULT");
    const pr = await ask("pr@my-rig");
    expect((await deliver(pr.qitemId)).channel).toBe("C0OLDDEFAULT");
    rewire(undefined, false, "C0NEWDEFAULT");
    const again = await deliverEpisode(pr.qitemId, "episode-2");
    expect(again).toMatchObject({ channel: "C0NEWDEFAULT", thread_ts: "1.1" });
  });

  it("after a remap, a root left in the old channel is not reused: the post opens a fresh root in the new channel", async () => {
    rewire(MAP);
    const pr = await ask("pr@my-rig");
    await deliver(pr.qitemId);
    rewire([{ match: "pr@my-rig", channel: "C0EXAMPLE3" }]);
    const again = await deliverEpisode(pr.qitemId, "episode-2");
    expect(again.channel).toBe("C0EXAMPLE3");
    expect(again.thread_ts).toBeUndefined();

    const decision = await ask("lead@my-rig");
    rewire(MAP);
    await deliver(decision.qitemId); // root in C0EXAMPLE1
    repo.update({ qitemId: decision.qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
    rewire(undefined);
    const update = await ask("lead@my-rig", { humanIntent: "update", summary: "Merged.", body: "Merged.", replyTo: decision.qitemId });
    const posted = await deliver(update.qitemId);
    expect(posted.channel).toBe("C0DEFAULT");
    expect(posted.thread_ts).toBeUndefined();
    expect(repo.getById(update.qitemId)?.replyToFallback).toMatch(/^root-other-channel/);
  });

  it("a mapped long ask records its reply parts in the mapped channel, so a reaction there finds the ask", async () => {
    rewire(MAP);
    const longBody = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: the plan needs a yes. `.repeat(20)).join("\n\n");
    const pr = await ask("pr@my-rig", { body: longBody });
    await deliver(pr.qitemId);
    expect(posts.length).toBeGreaterThan(2);
    expect(new Set(posts.map((p) => p.channel))).toEqual(new Set(["C0EXAMPLE2"]));
    const map = new ThreadSeatMap(db);
    for (let n = 2; n <= posts.length; n++) {
      expect(map.partOf(`${n}.1`, "C0EXAMPLE2")).toMatchObject({ threadTs: "1.1", seat: "pr@my-rig", conversationId: pr.qitemId });
      expect(map.partOf(`${n}.1`, "C0DEFAULT")).toBeNull();
    }
    const stamps = repo.transitionLog.listForQitem(pr.qitemId).map((t) => t.transitionNote ?? "").map(parsePostedStamp).filter(Boolean);
    expect(stamps.every((st) => st!.channel === "C0EXAMPLE2")).toBe(true);
  });

  it("an aggregate digest has no seat and posts to the default channel", async () => {
    rewire(MAP);
    const member = await ask("pr@my-rig");
    const before = posts.length;
    expect(wire.dispatcher.dispatch("post_message", human, {
      deliveryDigestPost: true, digestId: "d1", qitemId: member.qitemId, destinationSession: human,
      summary: "Delivery digest (4h) — 1 item(s)", body: "• Merge it?", memberReceipts: [],
    }, { decisionId: "digest:d1" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.at(-1)?.channel).toBe("C0DEFAULT");
  });

  it("inbound is unchanged: top-level messages in any channel land at inboundDestination; a reply in a mapped channel's thread reaches its seat", async () => {
    rewire(MAP, true);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
    const pr = await ask("pr@my-rig");
    await deliver(pr.qitemId); // root 1.1 in C0EXAMPLE2
    const send = async (channel: string, ts: string, thread_ts?: string) => {
      sockets[0]!.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "hello", ts, channel, ...(thread_ts ? { thread_ts } : {}) } } }) });
      await new Promise((r) => setTimeout(r, 50));
    };
    const inbound = () => repo.list({ limit: 100 }).filter((q) => q.tags?.includes("inbound"));
    await send("C0EXAMPLE1", "900.1");
    await send("C0EXAMPLE2", "900.2");
    await send("C0DEFAULT", "900.3");
    await send("C0EXAMPLE2", "900.4", "1.1");
    await vi.waitFor(() => expect(inbound()).toHaveLength(4));
    const byDest = inbound().map((q) => [q.destinationSession, q.tags?.includes("unrouted-signal") ? "unrouted" : "thread"]).sort();
    expect(byDest).toEqual([
      ["operator-agent@kernel", "unrouted"],
      ["operator-agent@kernel", "unrouted"],
      ["operator-agent@kernel", "unrouted"],
      ["pr@my-rig", "thread"],
    ]);
  });

  it("history recovery is unchanged: only the default channel is scanned, with today's status shape", async () => {
    const seen = new SeenStore(join(home, "state", "slack-inbound-seen.jsonl"));
    for (const channel of ["C0DEFAULT", "C0EXAMPLE1", "C0EXAMPLE2"]) seen.mark(`${channel}:1000.000001`, "landed");
    rewire(MAP, true);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
    await vi.waitFor(() => expect(historyChannels).toContain("C0DEFAULT"), { timeout: 15_000 });
    expect(new Set(historyChannels)).toEqual(new Set(["C0DEFAULT"]));
    const status = wire.status?.() as { recovery: { channel: string; channels?: unknown } };
    expect(status.recovery.channel).toBe("C0DEFAULT");
    expect(status.recovery).not.toHaveProperty("channels");
  });

  it("logs, and keeps posting through, a map entry field written by a newer OpenRig", async () => {
    const logs: string[] = [];
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ ...DEFAULT_CONFIG, enabled: true, channel: "C0DEFAULT", secretsEnvFile: secrets,
      channelMap: [{ match: "pr@my-rig", channel: "C0EXAMPLE2", inbound: "lead@my-rig" }] }));
    wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, log: (m) => logs.push(m),
      fetchImpl: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); } });
    stops.push(() => wire.stop()); wire.startServices?.();
    expect(logs.some((l) => l.includes("IGNORING unsupported field(s) channelMap[0].inbound"))).toBe(true);
    const pr = await ask("pr@my-rig");
    expect((await deliver(pr.qitemId)).channel).toBe("C0EXAMPLE2");
  });
});
