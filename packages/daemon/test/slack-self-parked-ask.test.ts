// Test-only: the real queue, Slack alert projection, thread map, thread route resolver, inbound router and reply resolver
// over migrated SQLite, with two registered people. Slack itself isn't involved: a post is recorded the way the
// subsystem records one (its root in the thread map, keyed by the alert's person, seat and row), and messages are handed
// to the router as Slack would deliver them.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { InboundRouter } from "../src/domain/gateway/slack/inbound.js";
import { makeQueuePorts, type QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

// An agent asks a person, then parks the ask on that same person. A colleague who writes in the ask's thread reaches the
// agent that asked, as themselves, exactly as on a pending ask; the park stays on the person asked until they answer;
// and the park's own post goes into the ask's thread rather than opening a second root. A person's Slack message, as it
// arrived, is never posted back to Slack as an ask, so its internal routing lines and a shared channel's policy stay in
// OpenRig; an agent that later parks that message on a person makes a new ask, which posts.

const person = (entityId: string, handle: string): HumanFragment => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "unused", role: "primary", handle }],
  prefs: { deliveryClass: "A" },
});
const ANA = "human-ana@external", MIKE = "human-mike@external", ASKER = "requester@test-rig";
const registry = { ok: true as const, entities: [person("human-ana", "UANA"), person("human-mike", "UMIKE")] };
const sources: Record<string, string> = { UANA: ANA, UMIKE: MIKE };

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "self-parked-ask-"));
  const db = new Database(join(home, "queue.sqlite")); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry, sharedChannels: () => [],
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const threadMap = new ThreadSeatMap(db);
  const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry, sharedChannels: () => [] });
  const router = new InboundRouter({ queue: ports, destination: "operator@test-rig", seen: new SeenStore(join(home, "seen.jsonl")),
    deadLetter: new DeadLetterStore(join(home, "dead.jsonl")),
    resolveSender: (user: string) => (sources[user] ? { admitted: true, source: sources[user]! } : { admitted: false, teaching: "unregistered" }),
    resolveRoute: makeThreadRouteResolver({ map: threadMap, unroutedDestination: "operator@test-rig" }),
    acknowledgeAnswer: async () => {}, recordHumanAnswer: (input) => repo.recordHumanAnswer(input),
    resolveHumanReply: makeHumanReplyResolver(repo, contract) });
  closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const ask = await repo.create({ sourceSession: ASKER, destinationSession: ANA, body: "Synthetic ask", summary: "Which day?",
    humanIntent: "decision", evidenceRef: "/fixture/decision", nudge: false });
  const alerts = async (): Promise<QueueItem[]> => ports.listHumanAlerts({ minimumLevel: "NOTICE" });
  const alertFor = async (qitemId: string) => (await alerts()).find((item) => item.qitemId === qitemId) ?? null;
  // A post, recorded as the subsystem records it: a later episode of the same row reuses its open root for the alert's
  // person and seat, and anything else opens a new top-level root.
  let nextRoot = 1;
  const post = (item: QueueItem): { threadTs: string; newRoot: boolean } => {
    const own = threadMap.resolveOpenForConversation(item.destinationSession ?? "", item.sourceSession ?? "", item.qitemId);
    const threadTs = own?.threadTs ?? `${nextRoot++}.1`;
    if (!own) threadMap.open({ threadTs, channel: "CTEST", human: item.destinationSession ?? "", seat: item.sourceSession ?? "", conversationId: item.qitemId });
    repo.update({ qitemId: item.qitemId, actorSession: "openrig-slack",
      transitionNote: `slack-owner-notification-posted notification_key=${item.notificationKey} kind=${item.ownerNotificationKind} thread_ts=${threadTs} message_ts=${threadTs}` });
    return { threadTs, newRoot: !own };
  };
  const typed = (user: string, text: string, threadTs: string, ts: string) =>
    router.route({ type: "message", user, channel: "CTEST", thread_ts: threadTs, ts, text });
  const state = () => {
    const row = repo.getById(ask.qitemId)!;
    return {
      state: row.state, blockedOn: row.blockedOn ?? null, answers: row.humanAnswers ?? null,
      resolvedBy: repo.listTransitions(ask.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").map((t) => t.actorSession),
    };
  };
  const repliesFrom = (source: string) => repo.list({ limit: 100 })
    .filter((item) => item.sourceSession === source && (item.tags ?? []).includes("inbound"))
    .map((item) => ({ qitemId: item.qitemId, destination: item.destinationSession, humanAnswer: (item.tags ?? []).includes("human-answer") }));
  const openAsks = () => ports.listOpenAsks({ minimumLevel: "NOTICE" });
  return { repo, ask, threadMap, alertFor, alerts, openAsks, post, typed, state, repliesFrom };
}

describe("an ask its asker parked on the person asked", () => {
  it("a colleague's reply reaches the asker as theirs; the park stays on the person asked; its post stays in the ask's thread", async () => {
    const f = await fixture();
    const first = f.post((await f.alertFor(f.ask.qitemId))!);
    expect(first).toEqual({ threadTs: "1.1", newRoot: true });

    // The asker parks its own ask on the person it asked.
    f.repo.update({ qitemId: f.ask.qitemId, actorSession: ASKER, state: "blocked", blockedOn: ANA, transitionNote: "parked on Ana" });
    const park = (await f.alertFor(f.ask.qitemId))!;
    expect(park).toMatchObject({ destinationSession: ANA, sourceSession: ASKER, ownerNotificationKind: "human-required" });
    // Same row, same person and seat: the park's post goes into the ask's thread, not a second top-level root.
    expect(f.post(park)).toEqual({ threadTs: "1.1", newRoot: false });

    // A registered colleague types in that thread.
    await f.typed("UMIKE", "afternoon", "1.1", "3.3");
    expect(f.repliesFrom(MIKE)).toEqual([expect.objectContaining({ destination: ASKER, humanAnswer: false })]);
    expect(f.state()).toEqual({ state: "blocked", blockedOn: ANA, answers: null, resolvedBy: [] });
    // Nothing they wrote is owed a Slack post.
    for (const item of await f.alerts()) expect(item.sourceSession).not.toBe(MIKE);

    // The person asked still answers in the same thread, and the answer is theirs.
    await f.typed("UANA", "morning", "1.1", "4.4");
    expect(f.state()).toMatchObject({ state: "in-progress", resolvedBy: [ANA] });
    // The resolution's notice is the asker's, and posts in the ask's thread.
    const resolved = (await f.alertFor(f.ask.qitemId))!;
    expect(resolved).toMatchObject({ destinationSession: ANA, sourceSession: ASKER, ownerNotificationKind: "human-decision-resolved" });
    expect(f.post(resolved)).toEqual({ threadTs: "1.1", newRoot: false });
  });

  it("control: on a pending ask, the colleague's reply reaches the asker and the ask stays open", async () => {
    const f = await fixture();
    f.post((await f.alertFor(f.ask.qitemId))!);
    await f.typed("UMIKE", "afternoon", "1.1", "3.3");
    expect(f.repliesFrom(MIKE)).toEqual([expect.objectContaining({ destination: ASKER, humanAnswer: false })]);
    expect(f.state()).toEqual({ state: "pending", blockedOn: null, answers: null, resolvedBy: [] });
  });

  it("a person's Slack message that lands on another person (a root stamped with a person as its seat) isn't posted back", async () => {
    const f = await fixture();
    // A root recorded before this fix, with the person as its seat.
    f.threadMap.open({ threadTs: "9.9", channel: "CTEST", human: ANA, seat: ANA, conversationId: f.ask.qitemId });
    await f.typed("UMIKE", "afternoon", "9.9", "5.5");
    const [reply] = f.repliesFrom(MIKE);
    expect(reply).toMatchObject({ destination: ANA });
    // It isn't owed a Slack post (its body carries OpenRig's routing lines); it's on Steering and the TUI.
    expect(await f.alertFor(reply!.qitemId)).toBeNull();
    expect(f.repo.listAttention({ limit: 100 }).map((item) => item.qitemId)).toContain(reply!.qitemId);
    expect(f.state()).toMatchObject({ state: "pending", answers: null, resolvedBy: [] });
  });

  it("control: an agent that later parks a Slack message on a person asks that person, and the park is posted", async () => {
    const f = await fixture();
    f.post((await f.alertFor(f.ask.qitemId))!);
    await f.typed("UMIKE", "can Ana confirm the date?", "1.1", "3.3");
    const [message] = f.repliesFrom(MIKE);
    expect(message).toMatchObject({ destination: ASKER });
    // Only the message as it arrived isn't re-posted: the agent's own park of it on Ana is a new ask, and posts.
    f.repo.update({ qitemId: message!.qitemId, actorSession: ASKER, state: "blocked", blockedOn: ANA, transitionNote: "asking Ana" });
    expect(await f.alertFor(message!.qitemId)).toMatchObject({
      destinationSession: ANA, sourceSession: ASKER, ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT",
    });
    const open = (await f.openAsks()).find((episode) => episode.item.qitemId === message!.qitemId);
    expect(open).toMatchObject({ posted: false, eligible: true });
  });
});
