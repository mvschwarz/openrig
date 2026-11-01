import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";

describe("stuck-sweep resolution uses source evidence", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let registryAvailable: boolean;
  const person: HumanFragment = {
    entityId: "human-owner", class: "human", displayName: "Owner", address: "human-owner@external",
    connectorBindings: [{ kind: "slack", connectorRef: "slack:fixture", secretsRef: "vault:fixture", role: "primary" }],
    prefs: { deliveryClass: "A" },
  };
  const otherPerson: HumanFragment = { ...person, entityId: "other-person", displayName: "Other person", address: "other-person@external" };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));
    vi.stubEnv("OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES", "3");
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    registryAvailable = true;
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => registryAvailable
        ? { ok: true, entities: [person, otherPerson] }
        : { ok: false, error: "fixture registry unavailable" },
    });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function advance(minutes: number): void {
    vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
  }

  const work = () => repo.create({
    sourceSession: "sender@r", destinationSession: "worker@r", body: "work", nudge: false,
  });

  async function sweep(unclaimedAgeMinutes = 60) {
    const { runStuckSweep } = await import("../src/domain/queue-stuck-sweep.js");
    return runStuckSweep({
      db, queueRepo: repo, now: new Date(), unclaimedAgeMinutes, ladderSuppressionMinutes: 30,
      resolveOrchestrator: () => null, sessionConfirmedMissing: () => false,
      resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null,
      isRegisteredHost: () => false, log: () => {},
    });
  }

  function findings(row: QueueItem): QueueItem[] {
    return repo.list({ limit: 100 }).filter((item) => item.tags?.includes(`recovery-for:${row.qitemId}`));
  }

  async function failedWake() {
    const row = await work();
    repo.recordNudgeAttempt(row.qitemId, "failed:transport unavailable");
    expect((await sweep()).outcome).toBe("findings");
    const [finding] = findings(row);
    expect(finding).toMatchObject({ state: "pending" });
    return { row, finding: finding! };
  }

  it.each(["delivered-ack-pending", "indeterminate:transport timeout", "retained:draft_aware"])(
    "keeps the existing failed-wake finding when the next attempt is %s, without sending again",
    async (result) => {
      const { row, finding } = await failedWake();
      repo.recordNudgeAttempt(row.qitemId, result);
      const send = vi.fn(async () => ({ ok: true, verified: false }));
      repo.attachTransport({ send });
      const before = repo.transitionLog.listForQitem(finding.qitemId);
      expect(repo.findUndelivered().some((item) => item.qitemId === row.qitemId)).toBe(false);
      for (let pass = 0; pass < 2; pass++) {
        expect((await sweep()).findings).not.toContainEqual(expect.objectContaining({ action: "closed" }));
        expect(repo.getById(finding.qitemId)?.state).toBe("pending");
      }
      expect(findings(row)).toHaveLength(1);
      expect(repo.transitionLog.listForQitem(finding.qitemId)).toEqual(before);
      expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", claimedAt: null, lastNudgeResult: result });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed-wake finding when its source no longer has a delivery result", async () => {
    const { row, finding } = await failedWake();
    db.prepare("UPDATE queue_items SET last_nudge_result = NULL WHERE qitem_id = ?").run(row.qitemId);
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("pending");
  });

  it("does not resolve an agent's failed wake from a legacy, unrelated human receipt", async () => {
    const { row, finding } = await failedWake();
    await repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${row.qitemId}:0 level=ALERT message_ts=1.2` });
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("posted");
    expect(repo.humanNotificationPostedThisEpisode(row.qitemId)).toBe(false);
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("pending");
  });

  it.each(["verified", "wake-accepted:webhook fixture answered 202", "claim", "claim-returned-to-pending", "done", "canceled"])("closes a failed-wake finding once the source has %s evidence", async (evidence) => {
    const { row, finding } = await failedWake();
    if (evidence === "verified" || evidence.startsWith("wake-accepted:")) repo.recordNudgeAttempt(row.qitemId, evidence);
    else if (evidence === "claim" || evidence === "claim-returned-to-pending") {
      repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
      if (evidence === "claim-returned-to-pending") {
        await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "pending", transitionNote: "returned to pending" });
      }
    }
    else await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: evidence as "done" | "canceled",
      ...(evidence === "done" ? { closureReason: "no-follow-on" as const } : {}), transitionNote: "work resolved" });
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding.qitemId, action: "closed" }));
    expect(repo.getById(finding.qitemId)).toMatchObject({ state: "done", sourceSession: finding.sourceSession,
      destinationSession: finding.destinationSession, closureReason: "no-follow-on" });
    expect(repo.transitionLog.listForQitem(finding.qitemId).at(-1)).toMatchObject({ actorSession: "stuck-sweep@system",
      transitionNote: expect.stringMatching(/source (wake verified|wake accepted|claimed at|closed)/) });
    expect((await sweep()).findings).not.toContainEqual(expect.objectContaining({ action: "closed" }));
  });

  it("leaves an explicitly held wake with its typing guard without sending or claiming it", async () => {
    const { row, finding } = await failedWake();
    const send = vi.fn(async () => ({ ok: true, verified: false }));
    repo.attachTransport({ send });
    repo.recordNudgeAttempt(row.qitemId, "retained:typing_guard");
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("done");
    expect(repo.transitionLog.listForQitem(finding.qitemId).at(-1)?.transitionNote).toContain("held by the seat typing guard");
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", claimedAt: null, lastNudgeResult: "retained:typing_guard" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not mistake a larger reporting age for pickup of an already-reported obligation", async () => {
    const row = await work();
    advance(61);
    await sweep();
    const [finding] = findings(row);
    expect(finding?.tags).toContain(`stuck-sweep:unclaimed-obligation:${row.qitemId}`);
    await sweep(120);
    expect(repo.getById(finding!.qitemId)?.state).toBe("pending");
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    await sweep(120);
    expect(repo.getById(finding!.qitemId)?.state).toBe("done");
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("detects a stalled claim retained on a pending row (existing finding: %s; retained failed wake: %s)", async (existing, failed) => {
    const row = await work();
    if (failed) repo.recordNudgeAttempt(row.qitemId, "failed:transport unavailable");
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    advance(5);
    if (existing) await sweep();
    const before = findings(row);
    await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "pending", transitionNote: "returned to pending" });
    advance(5);
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", claimedAt: expect.any(String), pickup: { state: "stalled-after-claim" } });
    await sweep();
    const after = findings(row);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ state: "pending", tags: expect.arrayContaining([`stuck-sweep:stalled-after-claim:${row.qitemId}`]) });
    if (existing) expect(after[0]!.qitemId).toBe(before[0]!.qitemId);
    await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", transitionNote: "continued the work" });
    await sweep();
    expect(repo.getById(after[0]!.qitemId)?.state).toBe("done");
  });

  async function humanNotice() {
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: "human-owner@external",
      body: "Choose A or B", summary: "A or B?", evidenceRef: "rig queue show qitem-fixture", humanIntent: "decision", humanAlert: true });
    const key = `${row.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)!.transitionId}`;
    await receipt(row.qitemId, key, "transport-failed");
    await sweep();
    const [finding] = findings(row);
    expect(finding?.tags).toContain(`stuck-sweep:undelivered-human-notice:${row.qitemId}`);
    return { row, finding: finding!, key };
  }

  function receipt(qitemId: string, key: string, outcome: "posted" | "transport-failed") {
    return repo.update({ qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-${outcome} notification_key=${key} level=ALERT ${outcome === "posted" ? "message_ts=1.2" : "detail=fixture-failure"}` });
  }

  it.each([false, true].flatMap((parked) => [person.address, "other-person@r"].map((recipient) => ({ parked, recipient }))))(
    "closes a delivered legacy human notice without owner history ($recipient; parked: $parked)", async ({ parked, recipient }) => {
    const row = parked ? await work() : await repo.create({ sourceSession: "sender@r", destinationSession: recipient,
      body: "Choose A or B", summary: "A or B?", evidenceRef: "rig queue show qitem-fixture", nudge: false });
    if (parked) {
      repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
      await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: recipient,
        summary: "Choose A or B", evidenceRef: "rig queue show qitem-fixture" });
    }
    // Migration 076 adds these columns without backfilling historical notices.
    db.prepare("UPDATE queue_transitions SET owner_notification_kind = NULL, owner_notification_level = NULL WHERE qitem_id = ?").run(row.qitemId);
    const key = `${row.qitemId}:0`;
    await receipt(row.qitemId, key, "transport-failed");
    await sweep();
    const [finding] = findings(row);
    expect(finding?.tags).toContain(`stuck-sweep:undelivered-human-notice:${row.qitemId}`);
    await receipt(row.qitemId, key, "posted");
    expect(repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)).toBeNull();
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("posted");
    expect(repo.humanNotificationPostedThisEpisode(row.qitemId)).toBe(false);
    registryAvailable = false;
    await sweep();
    // Reserved human references remain known; an alias needs its registry.
    expect(repo.getById(finding!.qitemId)?.state).toBe(recipient === person.address ? "done" : "pending");
    registryAvailable = true;
    await sweep();
    expect(repo.getById(finding!.qitemId)?.state).toBe("done");
    expect(repo.transitionLog.listForQitem(finding!.qitemId).at(-1)?.transitionNote).toContain("legacy human notification posted");
    expect(repo.getById(row.qitemId)?.state).toBe(parked ? "blocked" : "pending");
  });

  it("keeps a claimed agent's separate human notification until its receipt arrives", async () => {
    const row = await work();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: person.address,
      summary: "Choose A or B", evidenceRef: "rig queue show qitem-fixture" });
    const key = `${row.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)!.transitionId}`;
    await receipt(row.qitemId, key, "transport-failed");
    expect(repo.getById(row.qitemId)?.claimedAt).toEqual(expect.any(String));
    await sweep();
    const [finding] = findings(row);
    expect(finding).toMatchObject({ state: "pending", destinationSession: "worker@r",
      tags: expect.arrayContaining([`stuck-sweep:undelivered-human-notice:${row.qitemId}`]) });
    registryAvailable = false;
    await sweep();
    expect(repo.getById(finding!.qitemId)?.state).toBe("pending");
    registryAvailable = true;
    await receipt(row.qitemId, key, "posted");
    await sweep();
    expect(repo.getById(finding!.qitemId)?.state).toBe("done");
  });

  it("keeps a human-delivery finding during a registry outage, then closes it on the current receipt", async () => {
    const { row, finding, key } = await humanNotice();
    registryAvailable = false;
    expect(repo.deliveryOutcomeFor(row.qitemId)).toBeNull();
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("pending");
    registryAvailable = true;
    await receipt(row.qitemId, key, "posted");
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("done");
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
  });

  it("requires a receipt for the new human episode even before its post window expires", async () => {
    const { row, finding, key } = await humanNotice();
    await receipt(row.qitemId, key, "posted");
    await repo.update({ qitemId: row.qitemId, actorSession: "sender@r", state: "blocked", blockedOn: "human-owner@external",
      summary: "Another decision", evidenceRef: "rig queue show qitem-fixture" });
    const nextKey = `${row.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)!.transitionId}`;
    expect(nextKey).not.toBe(key);
    expect(repo.deliveryOutcomeFor(row.qitemId)).toBeNull();
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("pending");
    await receipt(row.qitemId, nextKey, "posted");
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("done");
  });

  it("does not use the old person's receipt to resolve a rerouted human notice", async () => {
    const { row, finding, key } = await humanNotice();
    await receipt(row.qitemId, key, "posted");
    repo.routeToFallback(row.qitemId, "other-person@external", "ask the other person instead");
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("posted");
    expect(repo.humanNotificationPostedThisEpisode(row.qitemId)).toBe(false);
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("pending");
  });

  it.each([false, true])("does not rebind a legacy receipt after changing the human recipient (late receipt: %s)", async (lateReceipt) => {
    const { row, finding, key } = await humanNotice();
    db.prepare("UPDATE queue_transitions SET owner_notification_kind = NULL, owner_notification_level = NULL WHERE qitem_id = ?").run(row.qitemId);
    if (!lateReceipt) await receipt(row.qitemId, key, "posted");
    repo.routeToFallback(row.qitemId, otherPerson.address, "ask the other person instead");
    if (lateReceipt) await receipt(row.qitemId, key, "posted");
    expect(repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)).toBeNull();
    expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("posted");
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("pending");
    // A new episode gives the new recipient its own receipt, unlike the legacy note.
    await repo.update({ qitemId: row.qitemId, actorSession: "sender@r", state: "blocked", blockedOn: otherPerson.address,
      summary: "The other person's decision", evidenceRef: "rig queue show qitem-fixture" });
    const nextKey = `${row.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)!.transitionId}`;
    expect(nextKey).not.toBe(key);
    await receipt(row.qitemId, nextKey, "posted");
    await sweep();
    expect(repo.getById(finding.qitemId)?.state).toBe("done");
  });

  it.each([false, true].flatMap((parked) => [false, true].map((lateReceipt) => ({ parked, lateReceipt }))))(
    "does not use a former recipient's legacy receipt after a park during a registry outage (already parked: $parked; late receipt: $lateReceipt)",
    async ({ parked, lateReceipt }) => {
      const row = parked ? await work() : (await humanNotice()).row;
      if (parked) {
        repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
        await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: person.address,
          summary: "Choose A or B", evidenceRef: "rig queue show qitem-fixture" });
      }
      db.prepare("UPDATE queue_transitions SET owner_notification_kind = NULL, owner_notification_level = NULL WHERE qitem_id = ?").run(row.qitemId);
      const key = `${row.qitemId}:0`;
      await receipt(row.qitemId, key, "transport-failed");
      await sweep();
      const [finding] = findings(row);
      expect(finding?.tags).toContain(`stuck-sweep:undelivered-human-notice:${row.qitemId}`);
      if (!lateReceipt) await receipt(row.qitemId, key, "posted");
      if (!parked) repo.routeToFallback(row.qitemId, otherPerson.address, "ask the other person instead");
      registryAvailable = false;
      await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: otherPerson.address });
      expect(repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)).toBeNull();
      if (lateReceipt) await receipt(row.qitemId, key, "posted");
      registryAvailable = true;
      expect(repo.deliveryOutcomeFor(row.qitemId)?.outcome).toBe("posted");
      await sweep();
      expect(repo.getById(finding!.qitemId)?.state).toBe("pending");
      await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "pending" });
      await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: otherPerson.address });
      const current = repo.transitionLog.latestOwnerNotificationForQitem(row.qitemId)!;
      await receipt(row.qitemId, `${row.qitemId}:${current.transitionId}`, "posted");
      await sweep();
      expect(repo.getById(finding!.qitemId)?.state).toBe("done");
    },
  );

  it("keeps the legacy park's human recipient when only the asking agent is rerouted", async () => {
    const row = await work();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: person.address,
      summary: "Choose A or B", evidenceRef: "rig queue show qitem-fixture" });
    db.prepare("UPDATE queue_transitions SET owner_notification_kind = NULL, owner_notification_level = NULL WHERE qitem_id = ?").run(row.qitemId);
    const key = `${row.qitemId}:0`;
    await receipt(row.qitemId, key, "transport-failed");
    await sweep();
    const [finding] = findings(row);
    expect(finding?.tags).toContain(`stuck-sweep:undelivered-human-notice:${row.qitemId}`);
    repo.routeToFallback(row.qitemId, "other-worker@r", "another agent will follow up");
    await receipt(row.qitemId, key, "posted");
    await sweep();
    expect(repo.getById(finding!.qitemId)?.state).toBe("done");
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "blocked", blockedOn: person.address, destinationSession: "other-worker@r" });
  });
});
