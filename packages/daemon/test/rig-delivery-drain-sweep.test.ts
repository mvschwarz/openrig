import { describe, it, expect, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runStuckSweep, createStuckSweepStatus, STUCK_SWEEP_YIELD_EVERY_ROWS, findingDedupTag, unclaimedBacklogTag } from "../src/domain/queue-stuck-sweep.js";

function fixture() {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const rigs = new RigRepository(db);
  const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  const jobs = new WatchdogJobsRepository(db);
  const held = rigs.createRig("held-one"), other = rigs.createRig("other-two");
  const begin = () => queue.deliveryDrains.begin(held.id, { drainId: "window", owner: "owner@held-one", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
  const sweep = () => runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60,
    log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });
  const work = (destinationSession = "worker@held-one") => queue.create({ sourceSession: "sender@other-two", destinationSession, body: "retained work", nudge: false });
  const overdue = async (destinationSession = "worker@held-one") => {
    const row = await work(destinationSession);
    queue.claim({ qitemId: row.qitemId, destinationSession });
    db.prepare("UPDATE queue_items SET closure_required_at=? WHERE qitem_id=?").run(new Date(Date.now() - 60_000).toISOString(), row.qitemId);
    return row;
  };
  const withTag = (tag: string) => (db.prepare("SELECT qitem_id FROM queue_items WHERE tags LIKE ?").all('%"' + tag + '"%') as { qitem_id: string }[]).map(x => queue.getById(x.qitem_id)!);
  return { db, rigs, queue, jobs, held, other, begin, sweep, work, overdue, withTag };
}

describe("delivery drain and standing stuck sweep", () => {
  it("defers overdue accounting/findings for this rig while unrelated findings continue", async () => {
    const f = fixture();
    try {
      const held = await f.overdue(), other = await f.overdue("worker@other-two");
      const accounting = vi.spyOn(f.queue, "recordClosureOverdue");
      f.begin();
      const result = await f.sweep();
      expect(result.outcome).not.toBe("failed");
      expect(f.withTag(findingDedupTag("overdue-claim", held.qitemId))).toHaveLength(0);
      expect(f.withTag(findingDedupTag("overdue-claim", other.qitemId))).toHaveLength(1);
      expect(accounting.mock.calls.some(([id]) => id === held.qitemId)).toBe(false);
      expect(accounting.mock.calls.some(([id]) => id === other.qitemId)).toBe(true);
    } finally { f.db.close(); }
  });

  it("a held condition stays open, and positive completed work still reconciles", async () => {
    const f = fixture();
    try {
      const work = await f.overdue();
      await f.sweep();
      const [finding] = f.withTag(findingDedupTag("overdue-claim", work.qitemId));
      expect(finding?.state).toBe("pending");
      f.begin();
      await f.sweep();
      expect(f.queue.getById(finding!.qitemId)?.state).toBe("pending");
      f.queue.update({ qitemId: work.qitemId, actorSession: "worker@held-one", state: "done", closureReason: "no-follow-on" });
      await f.sweep();
      expect(f.queue.getById(finding!.qitemId)?.state).toBe("done");
    } finally { f.db.close(); }
  });

  it("preserves a held standing backlog notice rather than silently closing or rewriting it", async () => {
    const f = fixture();
    try {
      const node = f.rigs.addNode(f.held.id, "door.root", { runtime: "claude-code" });
      f.db.prepare("INSERT INTO sessions(id,node_id,session_name,status) VALUES(?,?,?,?)").run("session-drain-fixture", node.id, "root@held-one", "running");
      const work = await f.work("root@held-one");
      f.db.prepare("UPDATE queue_items SET ts_created=? WHERE qitem_id=?").run(new Date(Date.now() - 120 * 60_000).toISOString(), work.qitemId);
      await f.sweep();
      const [notice] = f.withTag(unclaimedBacklogTag("root@held-one"));
      expect(notice?.state).toBe("pending");
      f.begin();
      await f.sweep();
      expect(f.queue.getById(notice!.qitemId)?.state).toBe("pending");
      expect(f.queue.getById(notice!.qitemId)?.body).toBe(notice!.body);
      f.queue.update({ qitemId: work.qitemId, actorSession: "root@held-one", state: "done", closureReason: "no-follow-on" });
      await f.sweep();
      expect(f.queue.getById(notice!.qitemId)?.state).toBe("done");
    } finally { f.db.close(); }
  });

  it("a drain beginning at an event-loop yield stops later accounting and prelisted findings", async () => {
    const f = fixture();
    const realImmediate = globalThis.setImmediate;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 2; i++) await f.overdue();
      const accounting = vi.spyOn(f.queue, "recordClosureOverdue");
      let began = false, callsAtBegin = 0;
      spy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => realImmediate(() => {
        if (!began && accounting.mock.calls.length > 0) { callsAtBegin = accounting.mock.calls.length; f.begin(); began = true; }
        callback(...args);
      })) as typeof setImmediate);
      const result = await f.sweep();
      expect(began).toBe(true);
      expect(result.outcome).not.toBe("failed");
      expect(accounting).toHaveBeenCalledTimes(callsAtBegin);
      expect(result.findings.filter(x => x.action === "created")).toEqual([]);
    } finally { spy?.mockRestore(); f.db.close(); }
  });
  it("a BEGIN after collection preserves an existing overdue finding, but completion still closes it", async () => {
    const f = fixture();
    const realImmediate = globalThis.setImmediate;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const row = await f.overdue();
      await f.sweep();
      const [finding] = f.withTag(findingDedupTag("overdue-claim", row.qitemId));
      expect(finding?.state).toBe("pending");
      for (let i = 0; i < STUCK_SWEEP_YIELD_EVERY_ROWS + 2; i++) await f.overdue();
      const accounting = vi.spyOn(f.queue, "recordClosureOverdue");
      let began = false;
      spy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => realImmediate(() => {
        if (!began && accounting.mock.calls.length > 0) { f.begin(); began = true; }
        callback(...args);
      })) as typeof setImmediate);
      expect((await f.sweep()).outcome).not.toBe("failed");
      expect(began).toBe(true);
      expect(f.queue.getById(finding!.qitemId)?.state).toBe("pending");
      f.queue.update({ qitemId: row.qitemId, actorSession: row.destinationSession, state: "done", closureReason: "no-follow-on" });
      expect((await f.sweep()).outcome).not.toBe("failed");
      expect(f.queue.getById(finding!.qitemId)?.state).toBe("done");
    } finally { spy?.mockRestore(); f.db.close(); }
  });

  it("checks a held notice's closed sources without an unbounded turn of rich row reads", async () => {
    const f = fixture();
    const realImmediate = globalThis.setImmediate;
    let reads = 0, maxReads = 0;
    let get: ReturnType<typeof vi.spyOn> | undefined;
    let yieldSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const node = f.rigs.addNode(f.held.id, "door.root", { runtime: "claude-code" });
      f.db.prepare("INSERT INTO sessions(id,node_id,session_name,status) VALUES(?,?,?,?)")
        .run("session-source-batch", node.id, "root@held-one", "running");
      const ids = new Set<string>();
      for (let i = 0; i < 2 * STUCK_SWEEP_YIELD_EVERY_ROWS + 1; i++) {
        ids.add((await f.work("root@held-one")).qitemId);
      }
      f.db.prepare("UPDATE queue_items SET ts_created=? WHERE destination_session=?")
        .run(new Date(Date.now() - 120 * 60_000).toISOString(), "root@held-one");
      await f.sweep();
      const [notice] = f.withTag(unclaimedBacklogTag("root@held-one"));
      expect(notice?.state).toBe("pending");
      f.begin();
      const missing = [...ids].at(-1)!;
      f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify([...ids]));
      f.db.prepare("DELETE FROM queue_items WHERE qitem_id=?").run(missing);
      await f.sweep();
      expect(f.queue.getById(notice!.qitemId)?.state).toBe("pending"); // absence is not positive completion
      await f.queue.create({ qitemId: missing, sourceSession: "sender@other-two", destinationSession: "root@held-one", body: "retained work", nudge: false });
      f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(missing);
      const getById = f.queue.getById.bind(f.queue);
      get = vi.spyOn(f.queue, "getById").mockImplementation((id, options) => {
        if (ids.has(id)) { reads++; maxReads = Math.max(maxReads, reads); }
        return getById(id, options);
      });
      yieldSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) =>
        realImmediate(() => { reads = 0; callback(...args); })) as typeof setImmediate);
      expect((await f.sweep()).outcome).not.toBe("failed");
      expect(f.queue.getById(notice!.qitemId)?.state).toBe("done");
      // The existing yielded reconciliation reads the row and its delivery-resolution evidence: two reads per row.
      expect(maxReads).toBeLessThanOrEqual(2 * STUCK_SWEEP_YIELD_EVERY_ROWS);
    } finally { yieldSpy?.mockRestore(); get?.mockRestore(); f.db.close(); }
  });

});
