import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// A reply that comes through the gateway keeps its sender's identity: a different registered person's Slack reply to a
// question parked on someone else reaches the agent as their own message and doesn't resume the question. An action
// at the terminal is the primary user's and keeps its existing authority.

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
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const registry: LoadResult = { ok: true, entities: [person("human-ana"), person("human-mike")] };
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry });
    contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
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

  it("doesn't resume the question: it stays parked on its person and nothing is written to it", async () => {
    const parked = await parkOnAna();
    const before = repo.listTransitions(parked.qitemId).length;
    expect(await slackReply(parked.qitemId, MIKE)).toBe("not-applicable");
    expect(repo.getById(parked.qitemId)).toMatchObject({ state: "blocked", blockedOn: "human-ana@host" });
    expect(repo.listTransitions(parked.qitemId)).toHaveLength(before);
  });

  it("the person it's parked on still resumes it from Slack", async () => {
    const parked = await parkOnAna();
    expect(await slackReply(parked.qitemId, ANA)).toBe("resolved");
    expect(repo.getById(parked.qitemId)?.state).toBe("in-progress");
    expect(repo.listTransitions(parked.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").map((t) => t.actorSession))
      .toEqual([ANA]);
  });

  it("an action at the terminal keeps its existing authority over the same question", async () => {
    const parked = await parkOnAna();
    const result = await contract.act({ verb: "resolve", qitemId: parked.qitemId, actorSession: MIKE, decision: "go ahead", notify: false });
    expect(result).not.toHaveProperty("correspondence");
    expect(repo.getById(parked.qitemId)?.state).toBe("in-progress");
    expect(repo.listTransitions(parked.qitemId).filter((t) => t.ownerNotificationKind === "human-decision-resolved").map((t) => t.actorSession))
      .toEqual([MIKE]);
  });
});
