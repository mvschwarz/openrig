import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createWakeRecovery } from "../src/domain/wake-recovery.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** Pending rows whose notifications an earlier process left unconfirmed, and a transport whose deliveries the test
 *  completes one at a time. */
async function backlog(rows: number) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  const outbox = new OutboxHandler(db);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  repo.attachOutbox(outbox);
  const ids: string[] = [];
  for (let i = 0; i < rows; i++) {
    const created = await repo.create({ sourceSession: "lead@test", destinationSession: `worker-${i}@test`, body: `work ${i}` });
    const id = `${WAKE_INTENT_PREFIX}${created.qitemId}`;
    expect(outbox.claimForDelivery(id)).toBe(true);
    outbox.finalizeDelivery(id, "indeterminate");
    ids.push(id);
  }
  const deliveries: Array<() => void> = [];
  const send = vi.fn(() => new Promise<{ ok: boolean; verified: boolean }>((resolve) => { deliveries.push(() => resolve({ ok: true, verified: true })); }));
  repo.attachTransport({ send });
  const state = (id: string) => (db.prepare("SELECT delivery_state FROM outbox_entries WHERE outbox_id = ?").get(id) as { delivery_state: string }).delivery_state;
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { db, repo, ids, send, deliveries, state, settle };
}

describe("startup wake recovery after the daemon listens", () => {
  it("starts without waiting for any delivery, then delivers the whole backlog in order", async () => {
    const b = await backlog(3);
    const log = { log: vi.fn(), warn: vi.fn() };
    const recovery = createWakeRecovery(b.repo, 0, log);
    // start() returns at once: readiness no longer depends on how long the seats take.
    expect(recovery.start()).toBeUndefined();
    await b.settle();
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.state(b.ids[0]!)).toBe("sending");
    for (let i = 0; i < 3; i++) { await vi.waitFor(() => expect(b.deliveries.length).toBe(i + 1)); b.deliveries[i]!(); }
    await recovery.stop();
    expect(b.ids.map(b.state)).toEqual(["delivered", "delivered", "delivered"]);
    expect(log.log).toHaveBeenCalledWith("wake-intent recovery sweep: delivered=3 indeterminate=0 failed=0 reconciled=0");
  });

  it("stops after the delivery in flight; notifications it has not attempted wait, untouched, for the next start", async () => {
    const b = await backlog(3);
    const log = { log: vi.fn(), warn: vi.fn() };
    const recovery = createWakeRecovery(b.repo, 0, log);
    recovery.start(); await b.settle();
    expect(b.send).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = recovery.stop().then(() => { stopped = true; });
    await b.settle();
    expect(stopped).toBe(false); // Shutdown waits for the send already typing, not for the rest.
    b.deliveries[0]!();
    await stopping;
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.ids.map(b.state)).toEqual(["delivered", "indeterminate", "indeterminate"]);
    expect(log.log).toHaveBeenCalledWith("wake-intent recovery sweep: delivered=1 indeterminate=0 failed=0 reconciled=0 (stopped before the rest)");
    // A stopped pass is never resumed in this process.
    recovery.start(); await b.settle();
    expect(b.send).toHaveBeenCalledTimes(1);
    // The next start's pass recovers what was left.
    const next = createWakeRecovery(b.repo, 0, log);
    next.start();
    for (let i = 1; i < 3; i++) { await vi.waitFor(() => expect(b.deliveries.length).toBe(i + 1)); b.deliveries[i]!(); }
    await next.stop();
    expect(b.ids.map(b.state)).toEqual(["delivered", "delivered", "delivered"]);
  });

  it("does not deliver a member released from a combined wake once stop was requested", async () => {
    const b = await backlog(2);
    // Two notifications for one seat, correlated into one combined wake.
    for (const id of b.ids) b.db.prepare("UPDATE outbox_entries SET destination_session = 'worker-0@test', tags = ? WHERE outbox_id = ?").run(JSON.stringify(["queue:return:qitem-prior"]), id);
    b.db.prepare("UPDATE queue_items SET destination_session = 'worker-0@test'").run();
    // The seat's lease decides the second member is not for this send: it is released for a send of its own.
    b.send.mockImplementationOnce((_s: string, _t: string, opts?: { recheckMembers?: (holds: () => boolean, held: boolean) => unknown }) => {
      opts?.recheckMembers?.(() => false, true);
      return new Promise((resolve) => { b.deliveries.push(() => resolve({ ok: true, verified: true })); });
    });
    const log = { log: vi.fn(), warn: vi.fn() };
    const recovery = createWakeRecovery(b.repo, 0, log);
    recovery.start(); await b.settle();
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.ids.map(b.state)).toEqual(["sending", "indeterminate"]); // released back to its own state
    const stopping = recovery.stop();
    b.deliveries[0]!(); await stopping; await b.settle();
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(b.ids.map(b.state)).toEqual(["delivered", "indeterminate"]);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining("(stopped before the rest)"));
  });

  it("stops at once before it was started, and keeps a failed pass non-fatal", async () => {
    const idle = createWakeRecovery({ drainPendingWakeIntents: vi.fn() }, 0);
    await expect(idle.stop()).resolves.toBeUndefined();
    const log = { log: vi.fn(), warn: vi.fn() };
    const failing = createWakeRecovery({ drainPendingWakeIntents: vi.fn(async () => { throw new Error("database is locked"); }) }, 2, log);
    failing.start();
    await expect(failing.stop()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("wake-intent recovery sweep: failed (non-fatal): database is locked");
    // Reconciled claims are reported even when nothing else changed.
    const reconciledOnly = createWakeRecovery({ drainPendingWakeIntents: vi.fn(async () => ({ delivered: 0, indeterminate: 0, failed: 0, retained: 0 })) }, 2, log);
    reconciledOnly.start(); await reconciledOnly.stop();
    expect(log.log).toHaveBeenCalledWith("wake-intent recovery sweep: delivered=0 indeterminate=0 failed=0 reconciled=2");
  });
});
