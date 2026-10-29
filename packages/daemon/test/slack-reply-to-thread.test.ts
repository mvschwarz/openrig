// #96 — an update qitem may post into an earlier qitem's Slack thread (--reply-to).
// Guard: the thread belongs to the item that started it, so a reply under the update
// resolves THAT item. Reuse is allowed only while no reply there could answer a human
// decision. The thread choice is recorded once, before the first post; a missing/closed
// root posts top-level and the row says so (the verify result reads it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
import { CLICK_REPLIES } from "../src/domain/gateway/slack/inbound.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { ThreadSeatMap, parsePostedStamp } from "../src/domain/gateway/slack/thread-seat-map.js";
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
      const decision = await repo.create({ ...request, humanAlert: true });
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

    it("#822: an inbound reply's thread item is recorded only when it exists; the public replyTo rule is unchanged", async () => {
      const decision = await repo.create({ ...request, humanAlert: true });
      const inbound = { sourceSession: human, destinationSession: "author@rig", body: "thanks", nudge: false };
      const a = await repo.create({ ...inbound, inboundReplyTo: decision.qitemId });
      const b = await repo.create({ ...inbound, inboundReplyTo: "no-such-qitem" });
      expect(repo.getById(a.qitemId)?.replyTo).toBe(decision.qitemId);
      expect(repo.getById(b.qitemId)?.replyTo).toBeNull();
      await expect(repo.create({ ...inbound, replyTo: decision.qitemId })).rejects.toMatchObject({ code: "reply_to_requires_update" });
    });

    it("accepts an earlier update or an already-made decision and records the reference", async () => {
      const earlierUpdate = await repo.create({ ...request, humanIntent: "update" });
      const decision = await repo.create({ ...request, humanAlert: true });
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
    let inboundSocket: WsLike;
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
      const decision = await repo.create({ ...request, humanAlert: true });
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
    // `respond` adds to Slack's answer for a post, such as the posted `message` for a reply that Slack put elsewhere.
    async function connectInbound(respond?: (body: Record<string, unknown>, ts: string) => Record<string, unknown>):
      Promise<(threadTs: string | undefined, ts: string, channel?: string) => Promise<void>> {
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
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          posts.push(body);
          const ts = `${posts.length}.1`;
          return reply({ ok: true, ts, ...respond?.(body, ts) });
        },
      });
      stops.push(() => wire.stop()); wire.startServices?.();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      inboundSocket = sockets[0]!;
      inboundSocket.onopen?.();
      const humanReply = async (threadTs: string | undefined, ts: string, channel = "C-TEST") => {
        sockets[0]!.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user: "UFOUNDER", text: "thanks", ts, thread_ts: threadTs, channel } } }) });
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
      const decision = await repo.create({ ...request, humanAlert: true });
      await deliver(decision.qitemId);
      await humanReply("1.1", "902.1");
      await vi.waitFor(() => expect(repo.getById(decision.qitemId)?.state).toBe("done"));
      await postPendingNotice(decision.qitemId); // none: a done row's "resolved" notice opens no root of its own

      const update = await repo.create({ ...request, humanIntent: "update", body: "Merged.", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)?.replyToFallback).toBeNull();
    });

    // The row a person's Slack message lands as (inbound.ts names it by channel and ts).
    const inboundRow = (ts: string, channel = "C-TEST") =>
      repo.getById(`qitem-slack-inbound-${createHash("sha256").update(`${channel}:${ts}`).digest("hex").slice(0, 20)}`);

    it("#822: an answer to a reply the person typed in an OpenRig thread posts in that thread", async () => {
      const humanReply = await connectInbound();
      const decision = await repo.create({ ...request, humanAlert: true });
      await deliver(decision.qitemId);
      await humanReply("1.1", "903.1");
      await vi.waitFor(() => expect(repo.getById(decision.qitemId)?.state).toBe("done"));
      await postPendingNotice(decision.qitemId);
      const inbound = repo.getHumanAnswer(decision.qitemId, decision.destinationSession)!;
      expect(inbound).toMatchObject({ destinationSession: "author@rig", replyTo: decision.qitemId });

      const answer = await repo.create({ ...request, humanIntent: "update", body: "On it.", replyTo: inbound.qitemId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
      // The thread still belongs to the decision; the answer opened no root of its own.
      expect(new ThreadSeatMap(db).resolveByThread("1.1")?.conversationId).toBe(decision.qitemId);
    });

    it("#2234: an update Slack posted top-level because its thread's root was gone verifies unthreaded, and the seat's answer to a reply threads under it", async () => {
      // Slack answers a post into the deleted root 1.1 as a new top-level message.
      const humanReply = await connectInbound((body, ts) => body.thread_ts === "1.1" ? { message: { ts, text: "posted" } } : {});
      const decision = await repo.create({ ...request, humanAlert: true });
      await deliver(decision.qitemId);
      resolveDecision(decision.qitemId);
      const update = await repo.create({ ...request, humanIntent: "update", body: "Merged.", replyTo: decision.qitemId });
      await deliver(update.qitemId);
      const promoted = `${posts.length}.1`;
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(update.qitemId)?.replyToFallback).toBe("thread-missing (thread 1.1)");

      // The person replies under the update Slack promoted, and the seat answers that reply.
      await humanReply(promoted, "920.1");
      await vi.waitFor(() => expect(inboundRow("920.1")).toMatchObject({ destinationSession: "author@rig" }));
      const answer = await repo.create({ ...request, humanIntent: "update", body: "On it.", replyTo: inboundRow("920.1")!.qitemId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe(promoted);
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
    });

    it("interaction provenance: a completed button answer keeps its ask's thread for the seat's follow-up", async () => {
      await connectInbound();
      const decision = await repo.create({ ...request, humanAlert: true, humanIntent: "decision", humanQuestions: [
        { id: "q1", question: "Ship the fix?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      ] });
      await deliver(decision.qitemId);
      inboundSocket.onmessage?.({ data: JSON.stringify({
        envelope_id: "interaction-button", type: "interactive", payload: {
          type: "block_actions", user: { id: "UFOUNDER" }, channel: { id: "C-TEST" },
          container: { type: "message", message_ts: "1.1", channel_id: "C-TEST" }, message: { ts: "1.1" },
          actions: [{ type: "button", block_id: "or-q:q1", action_id: "or-opt:yes", value: "yes", action_ts: "910.1" }],
        },
      }) });
      const answerId = `qitem-human-answer-${createHash("sha256").update(decision.qitemId).digest("hex").slice(0, 20)}`;
      await vi.waitFor(() => expect(repo.getById(answerId)).not.toBeNull());
      await vi.waitFor(() => expect(repo.getById(decision.qitemId)?.state).toBe("done"));
      const inbound = repo.getById(answerId)!;
      expect(inbound).toMatchObject({ destinationSession: "author@rig", replyTo: decision.qitemId });
      expect(repo.getById(decision.qitemId)?.humanAnswers).toEqual({ q1: "yes" });
      const answer = await repo.create({ ...request, humanIntent: "update", body: "Shipping.", replyTo: answerId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
      expect(new ThreadSeatMap(db).resolveByThread("1.1")?.conversationId).toBe(decision.qitemId);
    });

    describe("an ask parked on the person it asked (P4)", () => {
      const questions = [
        { id: "q1", question: "Ship the fix?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
        { id: "q2", question: "Tell the users?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      ];
      const click = (questionId: string, optionId: string, actionTs: string) => inboundSocket.onmessage?.({ data: JSON.stringify({
        envelope_id: `interaction-${questionId}-${actionTs}`, type: "interactive", payload: {
          type: "block_actions", user: { id: registry.entities[0]!.connectorBindings[0]!.handle }, channel: { id: "C-TEST" },
          container: { type: "message", message_ts: "1.1", channel_id: "C-TEST" }, message: { ts: "1.1" },
          actions: [{ type: "button", block_id: `or-q:${questionId}`, action_id: `or-opt:${optionId}`, value: optionId, action_ts: actionTs }],
        },
      }) });
      const answerRowId = (qitemId: string) => `qitem-human-answer-${createHash("sha256").update(qitemId).digest("hex").slice(0, 20)}`;
      const resolvedCount = (qitemId: string) => repo.transitionLog.listForQitem(qitemId)
        .filter((t) => t.ownerNotificationKind === "human-decision-resolved").length;
      // The ask posts as root 1.1; its agent then parks it on the person it asked, and that question posts too.
      async function parkedAsk(blockedOn: string = human) {
        await connectInbound();
        const ask = await repo.create({ ...request, humanAlert: true, humanIntent: "decision", humanQuestions: questions });
        await deliver(ask.qitemId);
        repo.update({ qitemId: ask.qitemId, actorSession: "author@rig", state: "blocked", blockedOn, summary: "Still need your call",
          evidenceRef: "/private/proof.md", transitionNote: "parked on its person" });
        await postPendingNotice(ask.qitemId);
        return ask;
      }

      it("records each click, then resumes the ask once and hands the answers back once, even when Slack redelivers", async () => {
        const ask = await parkedAsk();
        click("q1", "yes", "990.1");
        await vi.waitFor(() => expect(repo.getById(ask.qitemId)?.humanAnswers).toEqual({ q1: "yes" }));
        expect(repo.getById(ask.qitemId)?.state).toBe("blocked");
        click("q2", "no", "991.1");
        await vi.waitFor(() => expect(repo.getById(ask.qitemId)?.state).toBe("in-progress"));
        expect(repo.getById(ask.qitemId)?.humanAnswers).toEqual({ q1: "yes", q2: "no" });
        expect(repo.getById(answerRowId(ask.qitemId))).toMatchObject({ destinationSession: "author@rig" });
        expect(resolvedCount(ask.qitemId)).toBe(1);
        click("q2", "no", "991.1");
        await new Promise((r) => setTimeout(r, 50));
        expect(resolvedCount(ask.qitemId)).toBe(1);
        expect(repo.getById(ask.qitemId)?.state).toBe("in-progress");
      });

      it("refuses a click from before its current question posted, and says the decision is parked", async () => {
        const ask = await parkedAsk();
        const before = posts.length;
        click("q1", "yes", "1.5");
        await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
        expect(posts.at(-1)?.text).toBe(CLICK_REPLIES.parked);
        expect(repo.getById(ask.qitemId)?.state).toBe("blocked");
        expect(Object.keys(repo.getById(ask.qitemId)?.humanAnswers ?? {})).toEqual([]);
      });

      it("still refuses a click on an ask parked on something other than its person", async () => {
        const other = await repo.create({ sourceSession: "author@rig", destinationSession: "worker@rig", body: "Ship the fix.", nudge: false });
        await connectInbound();
        const ask = await repo.create({ ...request, humanAlert: true, humanIntent: "decision", humanQuestions: questions });
        await deliver(ask.qitemId);
        repo.update({ qitemId: ask.qitemId, actorSession: "author@rig", state: "blocked", blockedOn: other.qitemId, transitionNote: "waits on the work" });
        const before = posts.length;
        click("q1", "yes", "990.1");
        await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
        expect(posts.at(-1)?.text).toBe(CLICK_REPLIES.parked);
        expect(repo.getById(ask.qitemId)?.state).toBe("blocked");
        expect(Object.keys(repo.getById(ask.qitemId)?.humanAnswers ?? {})).toEqual([]);
      });
    });

    /** With `routed` false, the reaction must make no row: a routed one lands well within the wait (#2233). */
    async function reactToAsk(decisionId: string, eventTs: string, routed = true): Promise<string> {
      const eventId = `reaction:C-TEST:1.1:UFOUNDER:eyes:${eventTs}`;
      const qitemId = `qitem-slack-reaction-${createHash("sha256").update(eventId).digest("hex").slice(0, 20)}`;
      inboundSocket.onmessage?.({ data: JSON.stringify({
        envelope_id: `interaction-reaction-${eventTs}`, type: "events_api", payload: { event: {
          type: "reaction_added", user: "UFOUNDER", reaction: "eyes", event_ts: eventTs,
          item: { type: "message", channel: "C-TEST", ts: "1.1" },
        } },
      }) });
      if (!routed) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(repo.getById(qitemId)).toBeNull();
        return qitemId;
      }
      await vi.waitFor(() => expect(repo.getById(qitemId)).not.toBeNull());
      expect(repo.getById(qitemId)?.body).toContain(`In reply to: ${decisionId}`);
      return qitemId;
    }

    it("#2233: with reactions off, a person's emoji on an ask makes no row, so it costs the asking seat no turn", async () => {
      saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: join(home, "fake.env"), minimumLevelThatInterrupts: "NOTICE", reactions: "off" }, home);
      await connectInbound();
      const decision = await repo.create({ ...request, humanAlert: true });
      await deliver(decision.qitemId);
      await reactToAsk(decision.qitemId, "913.1", false);
      expect(repo.getById(decision.qitemId)).toMatchObject({ humanAnswers: null });
    });

    it("#2233: reactions accepts only route or off", () => {
      expect(() => saveConfig({ ...DEFAULT_CONFIG, reactions: "sometimes" } as never, home)).toThrow(/reactions must be one of route, off/);
    });

    it("interaction provenance: a reaction row keeps its resolved ask's thread for the seat's follow-up", async () => {
      await connectInbound();
      const decision = await repo.create({ ...request, humanAlert: true });
      await deliver(decision.qitemId);
      resolveDecision(decision.qitemId);
      const reactionId = await reactToAsk(decision.qitemId, "911.1");
      expect(repo.getById(reactionId)).toMatchObject({ destinationSession: "author@rig", replyTo: decision.qitemId });
      const answer = await repo.create({ ...request, humanIntent: "update", body: "Acknowledged.", replyTo: reactionId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("1.1");
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
      expect(new ThreadSeatMap(db).resolveByThread("1.1")?.conversationId).toBe(decision.qitemId);
    });

    it("interaction provenance: a reaction still neither answers nor closes a live human gate", async () => {
      await connectInbound();
      const decision = await repo.create({ ...request, humanAlert: true, humanIntent: "decision", humanQuestions: [
        { id: "q1", question: "Ship the fix?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      ] });
      await deliver(decision.qitemId);
      const reactionId = await reactToAsk(decision.qitemId, "912.1");
      expect(repo.getById(decision.qitemId)).toMatchObject({ state: "pending", humanAnswers: null });
      const answer = await repo.create({ ...request, humanIntent: "update", body: "I saw your reaction.", replyTo: reactionId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(answer.qitemId)?.replyToFallback).toMatch(/reference-has-live-gate/);
      expect(repo.getById(decision.qitemId)?.state).toBe("pending");
    });

    it("a top-level message is its own answer's root: the seat it reached answers under it", async () => {
      const humanReply = await connectInbound();
      await humanReply(undefined, "904.1");
      const inbound = inboundRow("904.1")!;
      expect(inbound.replyTo).toBeNull();
      expect(inbound.destinationSession).toBe("operator-agent@kernel");
      const answer = await repo.create({ ...request, sourceSession: "operator-agent@kernel", humanIntent: "update", body: "On it.", replyTo: inbound.qitemId });
      await deliver(answer.qitemId);
      expect(posts.at(-1)?.thread_ts).toBe("904.1");
      expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
      // Another seat's answer isn't that root's: it posts top-level and says why, as before.
      const other = await repo.create({ ...request, humanIntent: "update", body: "Me too.", replyTo: inbound.qitemId });
      await deliver(other.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(other.qitemId)?.replyToFallback).toMatch(/root-other-seat/);
    });

    it("#899: a reaction on the person's own top-level message isn't a reaction to an ask, though the message is its answer's root", async () => {
      const humanReply = await connectInbound();
      await humanReply(undefined, "906.1");
      expect(new ThreadSeatMap(db).resolveByThread("906.1")).not.toBeNull();
      const eventId = "reaction:C-TEST:906.1:UFOUNDER:eyes:906.2";
      const qitemId = `qitem-slack-reaction-${createHash("sha256").update(eventId).digest("hex").slice(0, 20)}`;
      inboundSocket.onmessage?.({ data: JSON.stringify({
        envelope_id: "own-message-reaction", type: "events_api", payload: { event: {
          type: "reaction_added", user: "UFOUNDER", reaction: "eyes", event_ts: "906.2",
          item: { type: "message", channel: "C-TEST", ts: "906.1" },
        } },
      }) });
      await new Promise((r) => setTimeout(r, 50));
      expect(repo.getById(qitemId)).toBeNull();
    });

    it("a person's minted root is stamped on their row, as theirs, so a rebuild can restore it", async () => {
      const humanReply = await connectInbound();
      await humanReply(undefined, "908.1");
      const inbound = inboundRow("908.1")!;
      const notes = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(inbound.qitemId) as Array<{ transition_note: string | null }>)
        .map((r) => r.transition_note ?? "");
      const stamp = notes.map((n) => parsePostedStamp(n)).find(Boolean);
      expect(stamp).toMatchObject({ threadTs: "908.1", messageTs: "908.1", channel: "C-TEST", seat: "operator-agent@kernel", conversationId: inbound.qitemId, origin: "person" });
    });

    it("two people's messages with the same ts in different channels are two roots: each reply and answer stays in its own channel", async () => {
      const humanReply = await connectInbound();
      await humanReply(undefined, "907.1", "C-TEST");
      await humanReply(undefined, "907.1", "C-OTHER");
      const here = inboundRow("907.1", "C-TEST")!;
      const there = inboundRow("907.1", "C-OTHER")!;
      expect(here.qitemId).not.toBe(there.qitemId);
      // The person's reply in the other channel's thread belongs to that channel's root.
      await humanReply("907.1", "907.2", "C-OTHER");
      expect(inboundRow("907.2", "C-OTHER")?.replyTo).toBe(there.qitemId);
      // The seat's answer to each root posts in that root's own channel and thread.
      for (const [row, channel] of [[there, "C-OTHER"], [here, "C-TEST"]] as const) {
        const answer = await repo.create({ ...request, sourceSession: "operator-agent@kernel", humanIntent: "update", body: "On it.", replyTo: row.qitemId });
        await deliver(answer.qitemId);
        expect(posts.at(-1)).toMatchObject({ channel, thread_ts: "907.1" });
        expect(repo.getById(answer.qitemId)?.replyToFallback).toBeNull();
      }
    });

    it("a person's message in another channel: its seat answers there, and another seat's fallback posts in that seat's own channel", async () => {
      const humanReply = await connectInbound();
      await humanReply(undefined, "905.1", "C-OTHER");
      const inbound = inboundRow("905.1", "C-OTHER")!;
      const own = await repo.create({ ...request, sourceSession: "operator-agent@kernel", humanIntent: "update", body: "On it.", replyTo: inbound.qitemId });
      await deliver(own.qitemId);
      expect(posts.at(-1)).toMatchObject({ channel: "C-OTHER", thread_ts: "905.1" });
      // A reference that fails its checks gives no thread, so the post keeps the replying seat's own channel.
      const other = await repo.create({ ...request, humanIntent: "update", body: "Me too.", replyTo: inbound.qitemId });
      await deliver(other.qitemId);
      expect(posts.at(-1)).toMatchObject({ channel: "C-TEST" });
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      expect(repo.getById(other.qitemId)?.replyToFallback).toMatch(/^root-other-seat/);
    });

    it("#822: a reply's seat parking it on the person still asks in a fresh root, and the answer there resolves the park", async () => {
      const humanReply = await connectInbound();
      const decision = await repo.create({ ...request, humanAlert: true });
      await deliver(decision.qitemId);
      await humanReply("1.1", "905.1");
      await vi.waitFor(() => expect(repo.getById(decision.qitemId)?.state).toBe("done"));
      await postPendingNotice(decision.qitemId);
      const inbound = repo.getHumanAnswer(decision.qitemId, decision.destinationSession)!;
      expect(inbound.replyTo).toBe(decision.qitemId);

      repo.update({ qitemId: inbound.qitemId, actorSession: "author@rig", state: "blocked", blockedOn: "human-founder@kernel", summary: "Which branch?", evidenceRef: "/proof/branches.md", transitionNote: "parked for a question" });
      await deliver(inbound.qitemId);
      expect(posts.at(-1)?.thread_ts).toBeUndefined();
      const parkRoot = `${posts.length}.1`;
      expect(new ThreadSeatMap(db).resolveByThread(parkRoot)?.conversationId).toBe(inbound.qitemId);
      await humanReply(parkRoot, "905.2");
      await vi.waitFor(() => expect(repo.getById(inbound.qitemId)?.state).toBe("in-progress"));
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
      const decision = await repo.create({ ...request, humanAlert: true });
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
      const decision = await repo.create({ ...request, humanAlert: true });
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
      const decision = await repo.create({ ...request, humanAlert: true });
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
