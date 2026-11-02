import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";

// A reply that comes through the gateway keeps its sender's identity: in one trusted workspace, a different registered
// person's Slack reply to a question parked on someone else resumes it, recorded as them on that person's ask.
// Resolving from a terminal keeps that same registered-person identity.

const person = (entityId: string): HumanFragment => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`,
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: `vault://slack/${entityId}`, role: "primary", handle: `U${entityId.toUpperCase()}` }],
  prefs: { deliveryClass: "B", availability: "available" },
});
const ANA = "human-ana@external";
const MIKE = "human-mike@external";

describe("a Slack reply from someone other than the person a question is parked on", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let contract: MissionControlWriteContract;
  let log: MissionControlActionLog;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const registry: LoadResult = { ok: true, entities: [person("human-ana"), person("human-mike")] };
    const bus = new EventBus(db);
    send = vi.fn(async () => ({ ok: true, verified: true }));
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry, transport: { send } });
    log = new MissionControlActionLog(db);
    contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: log });
  });
  afterEach(() => db.close());

  /** A question parked on Ana and posted to her in Slack: the human-required episode with its posted receipt, as a real
   *  post records it, so a reply after the post is one the resolver would act on. */
  const parkOnAna = async () => {
    const row = await repo.create({ sourceSession: "orch-lead@r", destinationSession: "dev@r", body: "work", nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: "dev@r", state: "blocked", blockedOn: "human-ana@host", summary: "Parked",
      evidenceRef: "/proof/parked.md", transitionNote: "parked on Ana" });
    const episode = repo.listTransitions(row.qitemId).filter((t) => t.ownerNotificationKind === "human-required").at(-1)!;
    repo.update({ qitemId: row.qitemId, actorSession: "openrig-slack",
      transitionNote: `slack-owner-notification-posted notification_key=${row.qitemId}:${episode.transitionId} kind=human-required thread_ts=1.1 message_ts=1.5` });
    return row;
  };
  const slackReply = (qitemId: string, actorSession: string) =>
    makeHumanReplyResolver(repo, contract)({ qitemId, actorSession, decision: "go ahead", messageTs: "2.2" });

  it("resumes the question, recorded as Mike on Ana's ask", async () => {
    const parked = await parkOnAna();
    expect(await slackReply(parked.qitemId, MIKE)).toBe("resolved");
    expect(repo.getById(parked.qitemId)?.state).toBe("in-progress");
    const resolved = repo.listTransitions(parked.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved");
    expect(resolved.map((t) => [t.actorSession, t.transitionNote]))
      .toEqual([[MIKE, `go ahead; by ${MIKE}, a registered person, on ${ANA}'s ask`]]);
  });

  it("recognizes a replay of Mike's uncertain resume, so its timing notice is retried rather than dropped", async () => {
    // Parked on Ana and posted to her in a digest, so a reply's order against the question can't be confirmed.
    const parked = await repo.create({ sourceSession: "asker@r", destinationSession: "dev@r", body: "work", nudge: false });
    repo.update({ qitemId: parked.qitemId, actorSession: "dev@r", state: "blocked", blockedOn: "human-ana@host", summary: "Parked",
      evidenceRef: "/proof/parked.md", transitionNote: "parked on Ana" });
    const episode = repo.listTransitions(parked.qitemId).filter((t) => t.ownerNotificationKind === "human-required").at(-1)!;
    repo.update({ qitemId: parked.qitemId, actorSession: "openrig-slack",
      transitionNote: `slack-owner-notification-posted notification_key=${parked.qitemId}:${episode.transitionId} kind=human-required thread_ts=1.1 message_ts=1.5 digest=d1` });
    expect(await slackReply(parked.qitemId, MIKE)).toBe("resolved-uncertain");
    expect(await slackReply(parked.qitemId, MIKE)).toBe("resolved-uncertain");
    expect(repo.listTransitions(parked.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved")).toHaveLength(1);
  });

  /** An ask to Ana with a question, parked by its asker on Ana and posted to her; Ana's typed answer is committed under
   *  this park's answer identity, then execution stops before the resume. */
  const interruptedPark = async () => {
    const asked = await repo.create({ sourceSession: "asker@r", destinationSession: ANA, body: "Which day?", summary: "Which day?",
      humanIntent: "decision", evidenceRef: "/fixture/day", nudge: false,
      humanQuestions: [{ id: "day", question: "Which day?", options: [{ id: "mon", label: "Monday" }, { id: "tue", label: "Tuesday" }] }] });
    repo.update({ qitemId: asked.qitemId, actorSession: "asker@r", state: "blocked", blockedOn: ANA, transitionNote: "parked on Ana" });
    const episode = repo.listTransitions(asked.qitemId).filter((t) => t.ownerNotificationKind === "human-required").at(-1)!;
    repo.update({ qitemId: asked.qitemId, actorSession: "openrig-slack",
      transitionNote: `slack-owner-notification-posted notification_key=${asked.qitemId}:${episode.transitionId} kind=human-required thread_ts=1.1 message_ts=1.5` });
    await repo.createHumanAnswer({ sourceSession: ANA, destinationSession: "asker@r", body: "Wednesday works", summary: "Wednesday works",
      inboundReplyTo: asked.qitemId, episodeKey: repo.currentHumanRequiredEpisode(asked.qitemId)!.key, nudge: false } as never);
    return asked;
  };
  const resolvedBy = (qitemId: string) => repo.listTransitions(qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").map((t) => t.actorSession);

  it("an interrupted park resumes with the committed answer, as its author's, and stores its typed words", async () => {
    const asked = await interruptedPark();
    expect(await slackReply(asked.qitemId, MIKE)).toBe("not-applicable");
    const resumed = repo.getById(asked.qitemId)!;
    expect(resumed).toMatchObject({ state: "in-progress", blockedOn: null });
    expect(resumed.humanAnswers?.day).toMatchObject({ kind: "typed-reply", text: "Wednesday works" });
    expect(resolvedBy(asked.qitemId)).toEqual([ANA]);
  });

  it("a click on an interrupted park records nothing, and the park resumes with the committed answer, as its author's", async () => {
    const asked = await interruptedPark();
    // Mike clicks a valid option after the question posted: the click path records it, then resumes through the resolver.
    expect(repo.recordHumanAnswer({ qitemId: asked.qitemId, actorSession: MIKE, questionId: "day", optionId: "mon", clickedTs: "2.2" }))
      .toMatchObject({ status: "not-applicable", answeredBy: ANA });
    await makeHumanReplyResolver(repo, contract)({ qitemId: asked.qitemId, actorSession: MIKE, decision: "", messageTs: "2.2" });
    const resumed = repo.getById(asked.qitemId)!;
    expect(resumed).toMatchObject({ state: "in-progress", blockedOn: null });
    expect(resumed.humanAnswers?.day).toMatchObject({ kind: "typed-reply", text: "Wednesday works" });
    expect(resolvedBy(asked.qitemId)).toEqual([ANA]);
    expect(repo.list({ limit: 100 }).filter((item) => item.replyTo === asked.qitemId && (item.tags ?? []).includes("human-answer"))
      .map((item) => item.sourceSession)).toEqual([ANA]);
  });

  it("the person it's parked on still resumes it from Slack", async () => {
    const parked = await parkOnAna();
    expect(await slackReply(parked.qitemId, ANA)).toBe("resolved");
    expect(repo.getById(parked.qitemId)?.state).toBe("in-progress");
    expect(repo.listTransitions(parked.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").map((t) => t.actorSession))
      .toEqual([ANA]);
  });

  it("a different registered person resolves the question from a terminal too, as themselves on Ana's ask", async () => {
    const parked = await parkOnAna();
    await contract.act({ verb: "resolve", qitemId: parked.qitemId, actorSession: MIKE, decision: "go ahead", notify: false });
    expect(repo.getById(parked.qitemId)?.state).toBe("in-progress");
    expect(repo.listTransitions(parked.qitemId).at(-1)).toMatchObject({ actorSession: MIKE,
      transitionNote: `go ahead; by ${MIKE}, a registered person, on ${ANA}'s ask` });
    expect(log.listForQitem(parked.qitemId).at(-1)).toMatchObject({ actorSession: MIKE });
  });
});
