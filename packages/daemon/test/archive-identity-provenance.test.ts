import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  QueueTransitionLog,
  formatRelayOwnerNotificationAccepted,
  parseRelayOwnerNotificationAccepted,
  parseRelayOwnerNotificationTransportFailed,
} from "../src/domain/queue-transition-log.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { queueRoutes } from "../src/routes/queue.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-11T00:00:00.000Z";
const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function database(previous = false) {
  const db = createDb();
  databases.push(db);
  migrate(db, previous ? ALL_MIGRATIONS.filter((m) => m.name < "082") : ALL_MIGRATIONS);
  return db;
}
function seed(db: ReturnType<typeof createDb>, id: string, state = "done", parent: string | null = null) {
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session,
    destination_session, state, priority, body, handed_off_from)
    VALUES (?, ?, ?, 'sender@rig-a', 'owner@rig-a', ?, 'routine', 'archive test', ?)`).run(id, OLD, OLD, state, parent);
  const log = new QueueTransitionLog(db);
  for (const identityProvenance of ["transport:v1", "claimed:v1", null]) {
    log.append({ qitemId: id, state, actorSession: "owner@rig-a", identityProvenance,
      transitionNote: "slack-owner-notification-posted notification_key=fixture:key",
      closureReason: state === "done" ? "no-follow-on" : undefined,
      ownerNotificationKind: "human-decision-resolved", ownerNotificationLevel: "NOTICE" });
  }
  db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(OLD, id);
  return log;
}

describe("archived audit identity — real migration, writer and history readers", () => {
  it("upgrades the previous schema additively without relabeling old archive rows", () => {
    const db = database(true);
    db.prepare(`INSERT INTO queue_transitions_archive (transition_id, qitem_id, ts, state,
      actor_session, archived_at) VALUES (1, 'legacy', ?, 'done', 'owner@rig-a', ?)`).run(OLD, OLD);
    const before = db.prepare("SELECT * FROM queue_transitions_archive").get() as object;
    migrate(db, ALL_MIGRATIONS);
    const column = (db.prepare("PRAGMA table_info(queue_transitions_archive)").all() as Array<{name: string; notnull: number}>)
      .find((c) => c.name === "identity_provenance");
    expect(column).toMatchObject({ notnull: 0 });
    // 140 adds the principal column too; an old row gets neither value.
    expect(db.prepare("SELECT * FROM queue_transitions_archive").get()).toEqual({ ...before, identity_provenance: null, identity_principal: null });
    migrate(db, ALL_MIGRATIONS);
    expect(new QueueTransitionLog(db).listForQitem("legacy")[0]?.identityProvenance).toBeNull();
  });

  it("retains complete transition values through archival, public history and bounded readers", async () => {
    const db = database();
    const log = seed(db, "archived");
    seed(db, "child", "handed-off", "archived");
    const repo = new QueueRepository(db, new EventBus(db));
    const before = repo.listTransitions("archived");
    const actorBefore = log.listForActor("owner@rig-a");
    const recentBefore = log.listRecent({ kind: "rig", rig: "rig-a" });
    const familyBefore = log.listForHandoffWindow("archived", OLD, NOW, 100);
    expect(before.map((t) => t.identityProvenance)).toEqual(["transport:v1", "claimed:v1", null]);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW })).toEqual({ archivedQitems: 2, archivedRows: 6 });
    expect(repo.listTransitions("archived")).toEqual(before);
    expect(log.listForActor("owner@rig-a")).toEqual(actorBefore);
    expect(log.listRecent({ kind: "rig", rig: "rig-a" })).toEqual(recentBefore);
    expect(log.listForQitemWindow("archived", OLD, NOW, 2)).toEqual(before.slice(0, 2));
    expect(log.listForHandoffWindow("archived", OLD, NOW, 100)).toEqual(familyBefore);
    expect(log.latestOwnerNotificationForQitem("archived")).toEqual(before.at(-1));
    expect(log.hasOwnerNotificationReceipt("archived", "fixture:key")).toBe(true);
    expect(log.hasOwnerNotificationReceipt("archived", "different:key")).toBe(false);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); await next(); });
    app.route("/api/queue", queueRoutes());
    const response = await app.request("/api/queue/archived/transitions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(before);
    // A newer live row and an archived row must share one ordering/limit.
    const newer = log.append({ qitemId: "archived", state: "done", actorSession: "owner@rig-a", identityProvenance: "transport:v1" });
    expect(log.listForQitem("archived")).toEqual([...before, newer]);
    expect(log.listForActor("owner@rig-a", 1)).toEqual([newer]);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedRows).toBe(0);
  });

  it("keeps nonterminal, recent and live-frontier history; normal retention resumes after frontier closure", () => {
    const db = database();
    seed(db, "active", "in-progress");
    seed(db, "recent");
    seed(db, "frontier");
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = 'recent'").run(NOW);
    db.prepare(`INSERT INTO workflow_instances (instance_id, workflow_name, status, current_frontier_json, workflow_version, created_by_session, created_at)
      VALUES ('wi', 'fixture', 'waiting', '["frontier"]', '1', 'owner@rig-a', ?)`).run(OLD);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedRows).toBe(0);
    db.prepare("UPDATE workflow_instances SET status='completed', current_frontier_json='[]'").run();
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW })).toEqual({ archivedQitems: 1, archivedRows: 3 });
    expect(new QueueTransitionLog(db).listForQitem("frontier").map((t) => t.identityProvenance))
      .toEqual(["transport:v1", "claimed:v1", null]);
    expect((db.prepare("SELECT COUNT(*) n FROM queue_transitions").get() as { n: number }).n).toBe(6);
  });

  it("rolls back the archive insert when deletion fails inside the same transaction", () => {
    const db = database();
    seed(db, "rollback");
    const before = db.prepare("SELECT * FROM queue_transitions").all();
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON queue_transitions BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
    expect(() => archiveAgedTerminalTransitions(db, { nowIso: NOW })).toThrow("fixture delete failure");
    expect(db.prepare("SELECT * FROM queue_transitions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions_archive").all()).toEqual([]);
  });

  it("refuses a pre-upgrade archive that cannot carry live provenance", () => {
    const db = database(true);
    seed(db, "old-schema");
    const before = db.prepare("SELECT * FROM queue_transitions").all();
    expect(() => archiveAgedTerminalTransitions(db, { nowIso: NOW })).toThrow(/identity_provenance/);
    expect(db.prepare("SELECT * FROM queue_transitions").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions_archive").all()).toEqual([]);
  });

  it("records and reads relay owner notification acceptance separately from Slack posted receipts across live and archive", async () => {
    const db = database();
    const repo = new QueueRepository(db, new EventBus(db), {
      loadHumanRegistry: () => ({
        ok: true as const,
        entities: [
          {
            entityId: "human-founder",
            class: "human" as const,
            displayName: "Founder",
            address: "human-founder@external",
            connectorBindings: [
              {
                kind: "slack" as const,
                connectorRef: "primary",
                secretsRef: "env:SLACK_BOT_TOKEN",
                role: "primary" as const,
                handle: "UFOUNDER",
              },
            ],
            prefs: { deliveryClass: "A" as const },
          },
        ],
      }),
    } as never);
    const log = new QueueTransitionLog(db);
    const ask = await repo.create({
      sourceSession: "sender@rig-a",
      destinationSession: "human-founder@external",
      body: "Relay ask",
      summary: "Ask?",
      nudge: false,
    });
    const qitemId = ask.qitemId;
    const episode = log.latestOwnerNotificationForQitem(ask.qitemId)!;
    const key = `${ask.qitemId}:${episode.transitionId}`;

    expect(log.activeOwnerNotificationEpisodes(false).some((e) => e.qitemId === qitemId)).toBe(true);

    repo.recordRelayOwnerNotificationAccepted({
      qitemId,
      notificationKey: key,
      deliveryId: "del-1",
      connectorRef: "tg-main",
      replyRef: "tg:msg:99",
      revision: "dr1-abc",
      episodeKey: key,
      level: "ALERT",
      kind: "human-required",
      digest: "sha256:111",
    });

    // Verify full 64-hex sha256 derivation when replyRefHash is not explicitly passed
    const rawReplyRef = "tg:msg:99";
    const expectedFullSha256 = createHash("sha256").update(rawReplyRef).digest("hex");
    expect(expectedFullSha256).toHaveLength(64);

    expect(log.getOwnerNotificationReceipt(qitemId, key)).toBeNull();
    const expectedReceipt = {
      notificationKey: key,
      deliveryId: "del-1",
      connectorRef: "tg-main",
      replyRef: rawReplyRef,
      replyRefHash: expectedFullSha256,
      revision: "dr1-abc",
      episodeKey: key,
      level: "ALERT",
      kind: "human-required",
      digest: "sha256:111",
    };
    expect(log.getRelayOwnerNotificationReceipt(qitemId, key)).toEqual(expectedReceipt);
    expect(repo.getRelayOwnerNotificationReceipt(qitemId, key)).toEqual(expectedReceipt);
    expect(log.findRelayOwnerNotificationReceiptByReplyRef(rawReplyRef)).toEqual({
      qitemId,
      ...expectedReceipt,
    });
    expect(repo.findRelayOwnerNotificationReceiptByReplyRef(rawReplyRef)).toEqual({
      qitemId,
      ...expectedReceipt,
    });
    expect(log.findRelayOwnerNotificationReceiptByReplyRef("tg:msg:unknown")).toBeNull();
    expect(log.hasRelayOwnerNotificationReceipt(qitemId, key)).toBe(true);
    expect(log.hasRelayOwnerNotificationReceipt(qitemId, "other:key")).toBe(false);
    expect(log.hasOwnerNotificationReceipt(qitemId, key)).toBe(true);
    expect(log.activeOwnerNotificationEpisodes(false).some((e) => e.qitemId === qitemId)).toBe(false);
    expect(log.activeOwnerNotificationEpisodes(true).find((e) => e.qitemId === qitemId)).toMatchObject({
      qitemId,
      posted: true,
    });
    const outcome = repo.deliveryOutcomeFor(qitemId);
    expect(outcome).toEqual({
      outcome: "accepted",
      detail: expect.stringContaining("relay-owner-notification-accepted"),
    });
    expect(outcome.outcome).not.toBe("posted");
    expect(outcome.outcome).not.toBe("never-posted");

    // Archive and verify readers still work across archive
    db.prepare("UPDATE queue_items SET state = 'done', ts_updated = ? WHERE qitem_id = ?").run(OLD, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(OLD, qitemId);
    expect(archiveAgedTerminalTransitions(db, { nowIso: NOW }).archivedQitems).toBe(1);
    expect(log.getOwnerNotificationReceipt(qitemId, key)).toBeNull();
    expect(log.getRelayOwnerNotificationReceipt(qitemId, key)).toEqual(expectedReceipt);
    expect(log.findRelayOwnerNotificationReceiptByReplyRef(rawReplyRef)).toEqual({
      qitemId,
      ...expectedReceipt,
    });
    expect(repo.findRelayOwnerNotificationReceiptByReplyRef(rawReplyRef)).toEqual({
      qitemId,
      ...expectedReceipt,
    });
    expect(log.hasRelayOwnerNotificationReceipt(qitemId, key)).toBe(true);
    expect(log.hasOwnerNotificationReceipt(qitemId, key)).toBe(true);

    // Lossless connectorRef round-trip across whitespace, underscore, and delimiter punctuation without altering literal notification_key
    const distinctConnectorRefs = [
      "bridge one",
      "bridge_one",
      "bridge=one:two/three?four#five&six%25seven\teight",
    ];
    for (const [idx, connectorRef] of distinctConnectorRefs.entries()) {
      const distinctKey = `${qitemId}:distinct-${idx}`;
      const distinctReplyRef = `replyRef_${idx}`;
      const distinctFullHash = createHash("sha256").update(distinctReplyRef).digest("hex");
      const formatted = formatRelayOwnerNotificationAccepted({
        notificationKey: distinctKey,
        deliveryId: `del-${idx}`,
        connectorRef,
        replyRef: distinctReplyRef,
        revision: "dr1-abc",
        episodeKey: distinctKey,
        level: "ALERT",
        kind: "human-required",
      });
      // SQL activeOwnerNotificationEpisodes relies on literal ' notification_key=<qitemId>:<transitionId> '
      expect(` ${formatted} `).toContain(` notification_key=${distinctKey} `);
      const parsed = parseRelayOwnerNotificationAccepted(formatted);
      expect(parsed?.connectorRef).toBe(connectorRef);
      expect(parsed?.notificationKey).toBe(distinctKey);
      expect(parsed?.replyRef).toBe(distinctReplyRef);
      expect(parsed?.replyRefHash).toBe(distinctFullHash);
      expect(parsed?.replyRefHash).toHaveLength(64);
    }
    const noteWithSpaces = formatRelayOwnerNotificationAccepted({
      notificationKey: `${qitemId}:space`,
      connectorRef: "bridge one",
    });
    const noteWithUnderscore = formatRelayOwnerNotificationAccepted({
      notificationKey: `${qitemId}:space`,
      connectorRef: "bridge_one",
    });
    expect(noteWithSpaces).not.toBe(noteWithUnderscore);
    expect(parseRelayOwnerNotificationAccepted(noteWithSpaces)?.connectorRef).toBe("bridge one");
    expect(parseRelayOwnerNotificationAccepted(noteWithUnderscore)?.connectorRef).toBe("bridge_one");

    // Relay transport-failed note with connector_ref, dedupe, and queue-repository readers
    const failedAsk = await repo.create({
      sourceSession: "sender@rig-a",
      destinationSession: "human-founder@external",
      body: "Relay ask that fails transport",
      summary: "Fail ask?",
      nudge: false,
    });
    const failedEpisode = log.latestOwnerNotificationForQitem(failedAsk.qitemId)!;
    const failedKey = `${failedAsk.qitemId}:${failedEpisode.transitionId}`;
    repo.recordRelayOwnerNotificationTransportFailed({
      qitemId: failedAsk.qitemId,
      notificationKey: failedKey,
      connectorRef: "tg-main",
      failureClass: "relay-http-503",
      detail: "bridge unavailable",
    });
    const countAfterFirstFailure = repo.listTransitions(failedAsk.qitemId).length;
    // Duplicate failure for the same episode and same connector is deduplicated
    repo.recordRelayOwnerNotificationTransportFailed({
      qitemId: failedAsk.qitemId,
      notificationKey: failedKey,
      connectorRef: "tg-main",
      failureClass: "relay-http-503",
      detail: "bridge unavailable",
    });
    expect(repo.listTransitions(failedAsk.qitemId)).toHaveLength(countAfterFirstFailure);
    expect(repo.deliveryOutcomeFor(failedAsk.qitemId)).toEqual({
      outcome: "transport-failed",
      detail: `relay-owner-notification-transport-failed notification_key=${failedKey} connector_ref=tg-main class=relay-http-503 error=bridge unavailable`,
    });
    expect(repo.getById(failedAsk.qitemId)).toMatchObject({
      deliveryOutcome: "transport-failed",
      deliveryFailureDetail: expect.stringContaining("relay-owner-notification-transport-failed"),
    });
    expect(repo.findUndelivered().find((q) => q.qitemId === failedAsk.qitemId)).toMatchObject({
      qitemId: failedAsk.qitemId,
      deliveryOutcome: "transport-failed",
      deliveryFailureClass: "transport-failed",
      deliveryFailureDetail: expect.stringContaining("connector_ref=tg-main"),
    });

    // Failure under a changed relay connectorRef must record a new note naming the new connector rather than suppressing
    repo.recordRelayOwnerNotificationTransportFailed({
      qitemId: failedAsk.qitemId,
      notificationKey: failedKey,
      connectorRef: "wa-backup",
      failureClass: "relay-http-502",
      detail: "backup bridge bad gateway",
    });
    expect(repo.listTransitions(failedAsk.qitemId)).toHaveLength(countAfterFirstFailure + 1);
    const parsedFailures = repo
      .listTransitions(failedAsk.qitemId)
      .map((t) => parseRelayOwnerNotificationTransportFailed(t.transitionNote))
      .filter((f): f is NonNullable<typeof f> => f !== null);
    expect(parsedFailures.at(-1)).toMatchObject({
      notificationKey: failedKey,
      connectorRef: "wa-backup",
      failureClass: "relay-http-502",
      error: "backup bridge bad gateway",
    });
    expect(repo.deliveryOutcomeFor(failedAsk.qitemId)).toEqual({
      outcome: "transport-failed",
      detail: `relay-owner-notification-transport-failed notification_key=${failedKey} connector_ref=wa-backup class=relay-http-502 error=backup bridge bad gateway`,
    });
  });
});
