// Test-only: the real inbound router, queue ports, reply resolver and write contract over migrated SQLite, with two
// registered people. Slack itself isn't involved; events are handed to the router as Slack would deliver them.
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
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

// With several registered people in one trusted workspace, a person who wasn't asked can write in the asked person's
// Slack thread, and their reply settles it as their own: typed or clicked on a pending ask, and typed on a question
// parked on someone else. It settles once: the asked person writing afterwards is words for the agent.

const person = (entityId: string, handle: string): HumanFragment => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "unused", role: "primary", handle }],
  prefs: { deliveryClass: "A" },
});
const ANA = "human-ana@external", MIKE = "human-mike@external", ASKER = "requester@test-rig";
const registry = { ok: true as const, entities: [person("human-ana", "UANA"), person("human-mike", "UMIKE")] };
const sources: Record<string, string> = { UANA: ANA, UMIKE: MIKE };
const questions = [{ id: "choice", question: "Proceed?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }];

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture(kind: "pending" | "parked") {
  const home = mkdtempSync(join(tmpdir(), "wrong-answerer-"));
  const db = new Database(join(home, "queue.sqlite")); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  let ask: { qitemId: string };
  if (kind === "pending") {
    // A direct ask to Ana, waiting for her answer.
    ask = await repo.create({ sourceSession: ASKER, destinationSession: ANA, body: "Synthetic ask", summary: "Proceed?",
      humanIntent: "decision", humanQuestions: questions, evidenceRef: "/fixture/decision", nudge: false });
  } else {
    // Work parked on Ana, and posted to her in Slack, as a real post records it.
    ask = await repo.create({ sourceSession: ASKER, destinationSession: "dev@test-rig", body: "work", nudge: false });
    repo.update({ qitemId: ask.qitemId, actorSession: "dev@test-rig", state: "blocked", blockedOn: "human-ana@host", summary: "Parked",
      evidenceRef: "/proof/parked.md", transitionNote: "parked on Ana" });
    const episode = repo.listTransitions(ask.qitemId).filter((t) => t.ownerNotificationKind === "human-required").at(-1)!;
    repo.update({ qitemId: ask.qitemId, actorSession: "openrig-slack",
      transitionNote: `slack-owner-notification-posted notification_key=${ask.qitemId}:${episode.transitionId} kind=human-required thread_ts=1.1 message_ts=1.5` });
  }
  const router = new InboundRouter({ queue: makeQueuePorts(repo), destination: ASKER, seen: new SeenStore(join(home, "seen.jsonl")),
    deadLetter: new DeadLetterStore(join(home, "dead.jsonl")),
    resolveSender: (user: string) => (sources[user] ? { admitted: true, source: sources[user]! } : { admitted: false, teaching: "unregistered" }),
    resolveRoute: () => ({ destination: ASKER, correlationQitemId: ask.qitemId }),
    acknowledgeAnswer: async () => {}, recordHumanAnswer: (input) => repo.recordHumanAnswer(input),
    resolveHumanReply: makeHumanReplyResolver(repo, contract) });
  closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const typed = (user: string, text: string, ts: string) =>
    router.route({ type: "message", user, channel: "CTEST", thread_ts: "1.1", ts, text });
  const clicked = (user: string, actionTs: string) => router.routeAction({ type: "block_actions", user: { id: user }, channel: { id: "CTEST" },
    container: { type: "message", message_ts: "1.1", channel_id: "CTEST" }, message: { ts: "1.1" },
    actions: [{ type: "button", block_id: "or-q:choice", action_id: "or-opt:yes", value: "yes", action_ts: actionTs }] });
  const state = () => {
    const row = repo.getById(ask.qitemId)!;
    const replies = repo.list({ limit: 100 }).filter((item) => item.replyTo === ask.qitemId);
    return {
      state: row.state, blockedOn: row.blockedOn ?? null, answers: row.humanAnswers ?? null,
      resolvedBy: repo.listTransitions(ask.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").map((t) => t.actorSession),
      replies: replies.map((item) => ({ source: item.sourceSession, destination: item.destinationSession, humanAnswer: (item.tags ?? []).includes("human-answer") })),
    };
  };
  return { repo, ask, typed, clicked, state };
}

describe("a reply from a registered person who wasn't asked", () => {
  it("typed in a pending ask's thread: answers it as their own, and the agent gets their words as the answer", async () => {
    const f = await fixture("pending");
    await f.typed("UMIKE", "I'd say yes", "3.3");
    expect(f.state()).toMatchObject({ state: "done", blockedOn: null, answers: { choice: { kind: "typed-reply", text: "I'd say yes" } },
      resolvedBy: [MIKE], replies: [{ source: MIKE, destination: ASKER, humanAnswer: true }] });
  });

  it("clicked on a pending ask's button: records the answer as theirs, and the asked person's later click records nothing", async () => {
    const f = await fixture("pending");
    await f.clicked("UMIKE", "2.2");
    expect(f.state()).toMatchObject({ state: "done", answers: { choice: "yes" }, resolvedBy: [MIKE] });
    expect(f.state().replies.filter((reply) => reply.humanAnswer)).toEqual([{ source: MIKE, destination: ASKER, humanAnswer: true }]);
    // One answer per ask: the same click from the person asked, afterwards, changes nothing.
    await f.clicked("UANA", "2.3");
    expect(f.state()).toMatchObject({ state: "done", answers: { choice: "yes" }, resolvedBy: [MIKE] });
    expect(f.state().replies.filter((reply) => reply.humanAnswer)).toEqual([{ source: MIKE, destination: ASKER, humanAnswer: true }]);
  });

  it("clicked after the asked person's typed answer committed but before it closed: records nothing, and settles as theirs", async () => {
    const f = await fixture("pending");
    // Ana's typed answer is committed under the ask's answer identity, then execution stops before the close.
    await f.repo.createHumanAnswer({ sourceSession: ANA, destinationSession: ASKER, body: "Do not ship", summary: "Do not ship",
      inboundReplyTo: f.ask.qitemId, nudge: false } as never);
    await f.clicked("UMIKE", "2.2");
    expect(f.state()).toMatchObject({ state: "done", answers: { choice: { kind: "typed-reply", text: "Do not ship" } }, resolvedBy: [ANA] });
    expect(f.state().replies.filter((reply) => reply.humanAnswer)).toEqual([{ source: ANA, destination: ASKER, humanAnswer: true }]);
  });

  it("typed on a question parked on someone else: resumes it as theirs, and reaches the agent", async () => {
    const f = await fixture("parked");
    await f.typed("UMIKE", "go ahead", "3.3");
    expect(f.state()).toMatchObject({ state: "in-progress", blockedOn: null, resolvedBy: [MIKE] });
    expect(f.state().replies).toEqual([{ source: MIKE, destination: ASKER, humanAnswer: false }]);
  });

  it("the asked person writing after the other person answered: their words reach the agent, and the answer stays the other person's", async () => {
    const pending = await fixture("pending");
    await pending.typed("UMIKE", "I'd say yes", "3.3");
    await pending.typed("UANA", "Yes, go ahead", "4.4");
    expect(pending.state()).toMatchObject({ state: "done", resolvedBy: [MIKE] });
    expect(pending.state().replies.filter((reply) => reply.humanAnswer)).toEqual([{ source: MIKE, destination: ASKER, humanAnswer: true }]);
    expect(pending.state().replies).toContainEqual({ source: ANA, destination: ASKER, humanAnswer: false });

    const parked = await fixture("parked");
    await parked.typed("UMIKE", "go ahead", "3.3");
    await parked.typed("UANA", "go ahead", "4.4");
    expect(parked.state()).toMatchObject({ state: "in-progress", resolvedBy: [MIKE] });
  });
});
