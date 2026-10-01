// #96 — an update qitem may post into an earlier qitem's Slack thread (--reply-to).
// Guard: the thread belongs to the item that started it, so a reply under the update
// resolves THAT item. Reuse is allowed only while no reply there could answer a human
// decision. The thread choice is recorded once, before the first post; a missing/closed
// root posts top-level and the row says so (the verify result reads it).
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
import { QueueRepository, hasLiveHumanGate } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";

const human = "human-founder@external";
const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: human, summary: "Merge the fix?", body: "Approve or hold?", evidenceRef: "/private/proof.md", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("update --reply-to an earlier item's thread (#96)", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let bus: EventBus;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reply-to-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry });
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const resolveDecision = (qitemId: string) =>
    repo.update({ qitemId, actorSession: human, state: "done", closureReason: "no-follow-on", transitionNote: "human approved" });
  // The leg-1 park shape: an agent row blocked on the human seat; resolve returns it to in-progress.
  const park = async () => {
    const work = await repo.create({ sourceSession: "author@rig", destinationSession: "worker@rig", body: "Ship the fix.", nudge: false });
    repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "human-founder@kernel", summary: "Merge the fix?", evidenceRef: "/proof/PR.md", transitionNote: "parked for approval" });
    return work;
  };
  // The real `rig queue resolve` path: Mission Control unparks blocked -> in-progress and keeps blocked_on.
  const resolvePark = (qitemId: string) =>
    new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) })
      .act({ verb: "resolve", qitemId, actorSession: "human-founder@kernel", decision: "approved" });

  describe("create-time guard", () => {
    it("refuses --reply-to on anything but an update, with a named error", async () => {
      const earlier = await repo.create({ ...request, humanIntent: "update" });
      await expect(repo.create({ ...request, replyTo: earlier.qitemId })).rejects.toMatchObject({ code: "reply_to_requires_update" });
      await expect(repo.create({ ...request, humanIntent: "decision", replyTo: earlier.qitemId })).rejects.toMatchObject({ code: "reply_to_requires_update" });
    });

    it("refuses an unknown referenced item", async () => {
      await expect(repo.create({ ...request, humanIntent: "update", replyTo: "no-such-qitem" })).rejects.toMatchObject({ code: "reply_to_not_found" });
    });

    it("accepts a reference still waiting on the human: delivery decides the thread, not create", async () => {
      const decision = await repo.create(request);
      const work = await park();
      const a = await repo.create({ ...request, humanIntent: "update", replyTo: decision.qitemId });
      const b = await repo.create({ ...request, humanIntent: "update", replyTo: work.qitemId });
      expect(repo.getById(a.qitemId)?.replyTo).toBe(decision.qitemId);
      expect(repo.getById(b.qitemId)?.replyTo).toBe(work.qitemId);
    });

    it("treats a parked agent row as a live gate only while it is parked on the human", async () => {
      const work = await park();
      expect(hasLiveHumanGate(repo.getById(work.qitemId)!)).toBe(true);
      await resolvePark(work.qitemId);
      // Resolved: back to in-progress — no longer a gate.
      expect(repo.getById(work.qitemId)?.state).toBe("in-progress");
      expect(hasLiveHumanGate(repo.getById(work.qitemId)!)).toBe(false);
      // Mission Control's resolve documents keeping blocked_on as provenance; that shape is not a gate either.
      expect(hasLiveHumanGate({ humanIntent: null, state: "in-progress", destinationSession: "worker@rig", blockedOn: "human-founder@kernel" })).toBe(false);
      expect(hasLiveHumanGate({ humanIntent: null, state: "blocked", destinationSession: "worker@rig", blockedOn: "human-founder@kernel" })).toBe(true);
    });

    it("accepts an earlier update or an already-made decision and records the reference", async () => {
      const earlierUpdate = await repo.create({ ...request, humanIntent: "update" });
      const decision = await repo.create(request);
      resolveDecision(decision.qitemId);
      const a = await repo.create({ ...request, humanIntent: "update", replyTo: earlierUpdate.qitemId });
      const b = await repo.create({ ...request, humanIntent: "update", replyTo: decision.qitemId });
      expect(repo.getById(a.qitemId)?.replyTo).toBe(earlierUpdate.qitemId);
      expect(repo.getById(b.qitemId)?.replyTo).toBe(decision.qitemId);
      expect(repo.getById(decision.qitemId)?.replyTo).toBeNull();
    });
  });

  describe("delivery through the real wire", () => {
    let posts: Array<Record<string, unknown>>;
    let wire: ReturnType<typeof buildSlackGatewayWire>;
    beforeEach(() => {
      const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
      saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
      posts = [];
      wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); } });
      stops.push(() => wire.stop()); wire.startServices?.();
    });

    async function deliver(qitemId: string): Promise<void> {
      const before = posts.length;
      const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId);
      expect(alert).toBeDefined();
      expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
      await vi.waitFor(() => expect(repo.getById(qitemId)?.deliveryOutcome).toBe("posted"));
    }

    // What the outbound driver would do next: post the item's pending notice, if it has one.
    async function postPendingNotice(qitemId: string): Promise<void> {
      const pending = async () => (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === qitemId);
      const alert = await pending();
      if (!alert) return;
      wire.dispatcher.dispatch("post_message", human, alert);
      await vi.waitFor(async () => expect(await pending()).toBeUndefined()); // receipt written: any root it opened is mapped
    }

    it("posts the update under the resolved decision's root and opens no root of its own", async () => {
      const decision = await repo.create(request);
      await deliver(decision.qitemId);
      expect(posts[0]?.thread_ts).toBeUndefined();
      resolveDecision(decision.qitemId);

      const update = await repo.create({ ...request, humanIntent: "update", summary: "The PR you approved is merged.", body: "Merged.", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      expect(posts[1]?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)).toMatchObject({ state: "done", replyToFallback: null });
      // The root still belongs to the decision: an inbound reply there cannot resolve the update.
      expect(new ThreadSeatMap(db).resolveByThread("1.1")?.conversationId).toBe(decision.qitemId);
    });

    it("posts the update under a resolved park's root — the issue's 'the PR you approved is merged' case", async () => {
      const work = await park();
      await deliver(work.qitemId);
      expect(posts[0]?.thread_ts).toBeUndefined();
      await resolvePark(work.qitemId);

      const update = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", body: "Merged.", replyTo: work.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)).toMatchObject({ state: "done", replyToFallback: null });
    });

    it("a re-park after an update shared the root posts the new decision as a fresh root", async () => {
      const work = await park();
      await deliver(work.qitemId);
      await resolvePark(work.qitemId);
      const update = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", body: "Merged.", replyTo: work.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");

      repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "human-founder@kernel", summary: "Deploy it too?", evidenceRef: "/proof/deploy.md", transitionNote: "parked again" });
      await deliver(work.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(new ThreadSeatMap(db).resolveByThread(`${posts.length}.1`)?.conversationId).toBe(work.qitemId);
    });

    // Rebuild the wire with inbound Socket Mode on a fake socket; returns a human-reply sender.
    async function connectInbound(): Promise<(threadTs: string, ts: string) => Promise<void>> {
      const secrets = join(home, "fake.env");
      writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
      const sockets: WsLike[] = [];
      const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
      wire.stop();
      wire = buildSlackGatewayWire({
        home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
        resolveHumanReply: makeHumanReplyResolver(repo, contract),
        wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
        inboundMaxConnects: 1,
        fetchImpl: async (url, init) => {
          if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
          posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` });
        },
      });
      stops.push(() => wire.stop()); wire.startServices?.();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.onopen?.();
      const humanReply = async (threadTs: string, ts: string) => {
        sockets[0]!.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "thanks", ts, thread_ts: threadTs, channel: "C-TEST" } } }) });
        await new Promise((r) => setTimeout(r, 50));
      };
      return humanReply;
    }

    it("a reply in the old shared root never answers the re-parked decision; a reply in its fresh root does", async () => {
      const humanReply = await connectInbound();

      const work = await park();
      await deliver(work.qitemId);
      await resolvePark(work.qitemId);
      const update = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", body: "Merged.", replyTo: work.qitemId });
      await deliver(update.qitemId);
      repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "human-founder@kernel", summary: "Deploy it too?", evidenceRef: "/proof/deploy.md", transitionNote: "parked again" });
      await deliver(work.qitemId);
      const freshRoot = `${posts.length}.1`;

      await humanReply("1.1", "900.1"); // meant for the FYI update in the shared thread
      expect(repo.getById(work.qitemId)?.state).toBe("blocked");
      await humanReply(freshRoot, "900.2"); // an answer in the new decision's own thread
      await vi.waitFor(() => expect(repo.getById(work.qitemId)?.state).toBe("in-progress"));
    });

    it("without --reply-to: once a conversation has a newer root, a reply in its older root no longer answers the gate", async () => {
      const humanReply = await connectInbound();
      const work = await park();
      await deliver(work.qitemId); // root 1.1
      await resolvePark(work.qitemId);
      new ThreadSeatMap(db).close("1.1"); // the conversation's first root is closed ...
      repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "human-founder@kernel", summary: "Deploy it too?", evidenceRef: "/proof/deploy.md", transitionNote: "parked again" });
      await deliver(work.qitemId); // ... so the re-park opens a second root for the SAME conversation
      const newerRoot = `${posts.length}.1`;
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(new ThreadSeatMap(db).resolveByThread(newerRoot)?.conversationId).toBe(work.qitemId);

      await humanReply("1.1", "901.1"); // a late reply in the older root
      expect(repo.getById(work.qitemId)?.state).toBe("blocked");
      await humanReply(newerRoot, "901.2");
      await vi.waitFor(() => expect(repo.getById(work.qitemId)?.state).toBe("in-progress"));
    });

    it("a decision the human answered by replying in Slack still takes the update in its root", async () => {
      const humanReply = await connectInbound();
      const decision = await repo.create(request);
      await deliver(decision.qitemId);
      await humanReply("1.1", "902.1");
      await vi.waitFor(() => expect(repo.getById(decision.qitemId)?.state).toBe("done"));
      await postPendingNotice(decision.qitemId); // none: a done row's "resolved" notice opens no root of its own

      const update = await repo.create({ ...request, humanIntent: "update", body: "Merged.", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)?.replyToFallback).toBeNull();
    });

    it("a resolved park's 'resolved' notice stays in the park's root, so the worker's update still threads there", async () => {
      const work = await park();
      await deliver(work.qitemId);
      await resolvePark(work.qitemId);
      const before = posts.length;
      await postPendingNotice(work.qitemId);
      expect(posts.length).toBe(before + 1); // the notice did post ...
      expect(posts.at(-1)?.thread_ts).toBe("1.1"); // ... inside the park's root, opening none of its own

      const update = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", body: "Merged.", replyTo: work.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)?.replyToFallback).toBeNull();
    });

    it("follows a chain of threaded updates back to the original root", async () => {
      const first = await repo.create({ ...request, humanIntent: "update", body: "Started." });
      await deliver(first.qitemId);
      const second = await repo.create({ ...request, humanIntent: "update", body: "Reviewed.", replyTo: first.qitemId });
      await deliver(second.qitemId);
      const third = await repo.create({ ...request, humanIntent: "update", body: "Merged.", replyTo: second.qitemId });
      await deliver(third.qitemId);
      expect(posts.map((p) => p.thread_ts)).toEqual([undefined, "1.1", "1.1"]);
    });

    it("falls back to a top-level post when the referenced root is missing, and says so on the row", async () => {
      const unposted = await repo.create({ ...request, humanIntent: "update", body: "Never delivered." });
      const update = await repo.create({ ...request, humanIntent: "update", body: "Follow-up.", replyTo: unposted.qitemId });
      await deliver(update.qitemId);
      expect(posts[0]?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toMatch(/root-missing/);
    });

    it("falls back when the referenced root is closed", async () => {
      const first = await repo.create({ ...request, humanIntent: "update" });
      await deliver(first.qitemId);
      new ThreadSeatMap(db).close("1.1");
      const update = await repo.create({ ...request, humanIntent: "update", replyTo: first.qitemId });
      await deliver(update.qitemId);
      expect(posts[1]?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toMatch(/root-closed/);
    });

    it("posts top-level, not refused, when the referenced decision is still open, and says so on the row", async () => {
      const decision = await repo.create(request);
      await deliver(decision.qitemId);
      const update = await repo.create({ ...request, humanIntent: "update", body: "FYI.", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toMatch(/reference-has-live-gate/);
      expect(repo.getById(decision.qitemId)?.state).toBe("pending");
    });

    it("posts top-level when the referenced row is parked on the human", async () => {
      const work = await park();
      await postPendingNotice(work.qitemId);
      const update = await repo.create({ ...request, sourceSession: "worker@rig", humanIntent: "update", body: "FYI.", replyTo: work.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toMatch(/reference-has-live-gate/);
    });

    it("re-checks at delivery: a decision reopened after the update was queued gets no shared thread", async () => {
      const decision = await repo.create(request);
      await deliver(decision.qitemId);
      resolveDecision(decision.qitemId);
      const update = await repo.create({ ...request, humanIntent: "update", replyTo: decision.qitemId });
      db.prepare("UPDATE queue_items SET state = 'pending' WHERE qitem_id = ?").run(decision.qitemId);
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toMatch(/reference-has-live-gate/);
    });

    it("ignores a choice note an agent wrote: only the daemon's own in-process record steers the post", async () => {
      const first = await repo.create({ ...request, humanIntent: "update" });
      await deliver(first.qitemId);
      const update = await repo.create({ ...request, humanIntent: "update", replyTo: first.qitemId });
      // Both an agent-labelled note and one claiming the daemon's name over HTTP carry an identity provenance.
      repo.update({ qitemId: update.qitemId, actorSession: "author@rig", transitionNote: "slack-reply-to-choice kind=thread thread_ts=9.9", identityProvenance: "transport:v1" });
      repo.update({ qitemId: update.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-reply-to-choice kind=thread thread_ts=9.9", identityProvenance: "transport:v1" });
      expect(repo.replyToChoiceFor(update.qitemId)).toBeNull();
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.replyToChoiceFor(update.qitemId)).toEqual({ kind: "thread", threadTs: "1.1" });
    });

    it("falls back when the referenced root lives in a channel other than the configured one", async () => {
      const first = await repo.create({ ...request, humanIntent: "update" });
      await deliver(first.qitemId);
      wire.stop();
      saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OTHER", secretsEnvFile: join(home, "fake.env"), minimumLevelThatInterrupts: "NOTICE" }, home);
      wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); } });
      stops.push(() => wire.stop()); wire.startServices?.();
      const update = await repo.create({ ...request, humanIntent: "update", replyTo: first.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)).toMatchObject({ channel: "C-OTHER" });
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toBe("root-other-channel (thread 1.1)");
    });

    it("falls back when the referenced root belongs to a different seat: a reply there would reach that seat", async () => {
      const decision = await repo.create(request);
      await deliver(decision.qitemId);
      resolveDecision(decision.qitemId);
      const update = await repo.create({ ...request, sourceSession: "other@rig", humanIntent: "update", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(update.qitemId)?.replyToFallback).toBe("root-other-seat (thread 1.1)");
    });

    it("names a chain past the walk bound as chain-too-long, not a missing root", async () => {
      const chain = [await repo.create({ ...request, humanIntent: "update" })];
      for (let i = 1; i < 34; i++) chain.push(await repo.create({ ...request, humanIntent: "update", replyTo: chain[i - 1]!.qitemId }));
      await deliver(chain[33]!.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(chain[33]!.qitemId)?.replyToFallback).toBe(`chain-too-long (qitem ${chain[0]!.qitemId})`);
    });

    it("posts nothing when the thread choice cannot be recorded, and leaves a receipt that names why", async () => {
      const first = await repo.create({ ...request, humanIntent: "update" });
      await deliver(first.qitemId);
      const update = await repo.create({ ...request, humanIntent: "update", replyTo: first.qitemId });
      const realUpdate = repo.update.bind(repo);
      const spy = vi.spyOn(repo, "update").mockImplementation((input) => {
        if (input.transitionNote?.startsWith("slack-reply-to-choice ")) throw new Error("synthetic disk full");
        return realUpdate(input);
      });
      const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === update.qitemId);
      wire.dispatcher.dispatch("post_message", human, alert);
      await vi.waitFor(() => expect(repo.getById(update.qitemId)?.deliveryOutcome).toBe("transport-failed"));
      spy.mockRestore();
      expect(posts).toHaveLength(1);
      expect(repo.getById(update.qitemId)?.deliveryFailureDetail).toMatch(/class=reply-to-choice-unrecorded .*synthetic disk full/);
    });

    it("records the thread choice once: a retry after an ambiguous post reuses it even if the root closed meanwhile", async () => {
      const first = await repo.create({ ...request, humanIntent: "update" });
      await deliver(first.qitemId);
      const update = await repo.create({ ...request, humanIntent: "update", body: "Follow-up.", replyTo: first.qitemId });
      const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === update.qitemId);

      // The first post times out: its outcome is ambiguous, so the replay must reconcile, not repost blindly.
      const scans: string[] = [];
      let failNext = true;
      const fetchImpl: FetchImpl = async (url, init) => {
        if (!url.endsWith("chat.postMessage")) { scans.push(url); return reply({ ok: true, messages: [] }); }
        if (failNext) { failNext = false; throw new Error("synthetic timeout"); }
        posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` });
      };
      const rebuild = () => {
        wire.stop();
        wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl });
        stops.push(() => wire.stop()); wire.startServices?.();
      };
      rebuild();
      wire.dispatcher.dispatch("post_message", human, alert, { decisionId: "retry-once" });
      await vi.waitFor(() => expect(failNext).toBe(false));
      expect(repo.replyToChoiceFor(update.qitemId)).toEqual({ kind: "thread", threadTs: "1.1" });

      new ThreadSeatMap(db).close("1.1"); // a fresh derivation would now fall back top-level
      rebuild(); // restart: the retained decision replays
      await vi.waitFor(() => expect(repo.getById(update.qitemId)?.deliveryOutcome).toBe("posted"));
      expect(scans.some((u) => u.includes("conversations.replies"))).toBe(true); // searched the thread it chose
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)?.replyToFallback).toBeNull();
    });
  });

  it("carries replyTo through the HTTP create route and maps refusals to 400", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
    app.route("/api/queue", queueRoutes());
    const create = (value: unknown) => app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": request.sourceSession }, body: JSON.stringify(value) });
    const earlier = await (await create({ ...request, humanIntent: "update" })).json();
    const ok = await create({ ...request, humanIntent: "update", replyTo: earlier.qitemId });
    expect(ok.status).toBe(201);
    expect((await ok.json()).replyTo).toBe(earlier.qitemId);
    const refused = await create({ ...request, replyTo: earlier.qitemId });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "reply_to_requires_update" });
  });
});
