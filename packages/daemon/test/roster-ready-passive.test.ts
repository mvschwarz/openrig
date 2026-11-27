import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { noticeRosterReady, rosterReadyNoticeId } from "../src/domain/roster-ready-notice.js";
import { OPENRIG_SENDER } from "../src/lib/pane-envelope.js";
import { readAssignedWorkBySession } from "../src/domain/node-inventory.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor } from "../src/domain/policies/parked-owner-consumer.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const seat = "worker@team";
function fixture(delivery = false) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  const send = vi.fn().mockResolvedValue({ ok: true, verified: true });
  if (delivery) { repo.attachTransport({ send }); repo.attachOutbox(new OutboxHandler(db)); }
  return { db, repo, send };
}

function idle(): ArbitratedSeatState {
  return { seatNodeId: "worker-node", activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, needsInputEvidence: null,
    decidedBy: "window-sampling", seq: 1, changedAt: "2026-11-20T00:00:00.000Z", rungs: [], lastSwap: null };
}

describe("passive roster-ready information", () => {
  it("retains the exact information without a wake intent, even across later drains; ordinary work still wakes", async () => {
    const { db, repo, send } = fixture(true);
    try {
      expect(await noticeRosterReady(repo, "team-id", [seat])).toEqual([]);
      await repo.drainPendingWakeIntents();
      const notice = repo.getById(rosterReadyNoticeId("team-id", seat))!;
      expect(notice.body).toContain("Your team's seats and edges are now recorded");
      expect(notice.state).toBe("pending");
      expect(notice.lastNudgeAttempt).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_entries").get()).toEqual({ n: 0 });
      expect(send).not.toHaveBeenCalled();
      await repo.create({ sourceSession: "person@team", destinationSession: seat, body: "A natural next turn" });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await repo.drainPendingWakeIntents();
      expect(repo.getById(notice.qitemId)!.body).toBe(notice.body);
      expect(readAssignedWorkBySession(db).get(seat)?.assignedWorkCount).toBe(1);
    } finally { await new Promise<void>(resolve => setImmediate(resolve)); db.close(); }
  });

  it.each(["pending", "in-progress", "blocked"])("does not count a known %s notice as assigned work", async state => {
    const { db, repo } = fixture();
    try {
      await noticeRosterReady(repo, "team-id", [seat]);
      db.prepare("UPDATE queue_items SET state = ? WHERE qitem_id = ?").run(state, rosterReadyNoticeId("team-id", seat));
      expect(readAssignedWorkBySession(db).get(seat)?.assignedWorkCount ?? 0).toBe(0);
      expect(repo.listOpenObligations(seat, 10)).toEqual([]);
    } finally { await new Promise<void>(resolve => setImmediate(resolve)); db.close(); }
  });

  it("filters information before the obligation page limit, preserving older real work and held rows", async () => {
    const { db, repo } = fixture();
    try {
      const work = await repo.create({ sourceSession: "person@team", destinationSession: seat, body: "Older real work", nudge: false });
      db.prepare("UPDATE queue_items SET ts_created = '2020-01-01T00:00:00Z' WHERE qitem_id = ?").run(work.qitemId);
      for (let i = 0; i < 5; i++) await noticeRosterReady(repo, `team-${i}`, [seat]);
      expect(repo.listOpenObligations(seat, 1).map(r => r.qitemId)).toEqual([work.qitemId]);
      db.prepare("UPDATE queue_items SET state = 'blocked', blocked_on = 'external:gate' WHERE qitem_id = ?").run(work.qitemId);
      expect(repo.listOpenObligations(seat, 1)[0]).toMatchObject({ qitemId: work.qitemId, state: "blocked", blockedOn: "external:gate" });
      expect(repo.listOpenObligations(seat, 0)).toEqual([]);
      expect(repo.listOpenObligations(seat, -1).map(r => r.qitemId)).toEqual([work.qitemId]);
    } finally { await new Promise<void>(resolve => setImmediate(resolve)); db.close(); }
  });

  it("leaves the real parked-owner diagnosis and consumer quiet for an idle seat holding only information", async () => {
    const { db, repo } = fixture();
    try {
      await noticeRosterReady(repo, "team-id", [seat]);
      const diagnosis = diagnoseSeatParked({ getSeatState: idle, listOpenObligations: (s, limit) => ({ rows: repo.listOpenObligations(s, limit), limit }) },
        { seatNodeId: "worker-node", sessionName: seat });
      expect(diagnosis.parked).toBe(false);
      expect(diagnosis.obligations.openCount).toBe(0);
      const appendNote = vi.fn().mockReturnValue({ ok: true });
      const policy = makeParkedOwnerConsumerPolicy({ diagnoseRig: () => ({ seats: [diagnosis] }),
        history: { listForJob: () => [], countForJob: () => 0 }, rows: { listTransitions: () => [], appendNote,
          recordNudgeResult: vi.fn(), listOpenIds: (s) => repo.listOpenObligations(s, 100).map(r => r.qitemId) } });
      const result = await policy.evaluate({ jobId: "parked-worker", target: { session: makeRigAnchor("team") } } as PolicyJob);
      expect(result.action).toBe("skip");
      expect(appendNote).not.toHaveBeenCalled();
    } finally { await new Promise<void>(resolve => setImmediate(resolve)); db.close(); }
  });

  it.each([
    [rosterReadyNoticeId("team-id", seat), "peer@team"],
    ["qitem-roster-ready-unrecognized", OPENRIG_SENDER],
  ])("keeps an unrecognized row (%s, %s) as real work and delivers it", async (id, source) => {
    const { db, repo, send } = fixture(true);
    try {
      await repo.create({ qitemId: id, sourceSession: source, destinationSession: seat, body: "Unknown is not information-only" });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(readAssignedWorkBySession(db).get(seat)?.assignedWorkCount).toBe(1);
      expect(repo.listOpenObligations(seat, 1)[0]?.qitemId).toBe(id);
    } finally { await new Promise<void>(resolve => setImmediate(resolve)); db.close(); }
  });
});
