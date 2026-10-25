import { afterEach, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { hookOrPaneActivity } from "../src/domain/node-inventory.js";
import { runStuckSweep } from "../src/domain/queue-stuck-sweep.js";
import type { AgentActivity } from "../src/domain/types.js";

const destination = "worker@demo";
const databases: ReturnType<typeof createDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db), outbox = new OutboxHandler(db);
  let refused = true;
  const send = vi.fn(async () => refused
    ? { ok: false, sent: false, reason: "target_needs_input", error: `Refused: '${destination}' is at an interactive prompt (selection_prompt). No text was sent.` }
    : { ok: true, verified: true });
  const queue = new QueueRepository(db, bus, { transport: { send }, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  queue.attachOutbox(outbox);
  const observe = async (state: AgentActivity["state"] | undefined) => queue.retryPromptWakesOnClear(destination, state);
  const handoff = async () => {
    const source = await queue.create({ sourceSession: "planner@demo", destinationSession: "builder@demo", body: "build", nudge: false });
    const { created } = await queue.handoff({ qitemId: source.qitemId, fromSession: "builder@demo", toSession: destination, body: "review" });
    await vi.waitFor(() => expect(outbox.getById(WAKE_INTENT_PREFIX + created.qitemId)?.deliveryState).toBe("failed"));
    return created.qitemId;
  };
  return { db, bus, outbox, queue, observe, handoff, send, clear: () => { refused = false; } };
}

it("a refused handoff retries once on a clear, reusing its committed wake and frozen body", async () => {
  const f = fixture(); await f.observe("needs_input"); const id = await f.handoff();
  await f.observe("needs_input"); await f.observe("unknown");
  expect(f.send).toHaveBeenCalledTimes(1);
  const original = f.outbox.getById(WAKE_INTENT_PREFIX + id)!;
  f.clear(); await Promise.all([f.observe("running"), f.observe("idle")]);
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1][1]).toContain(original.body);
  expect(f.outbox.getById(original.outboxId)?.deliveryState).toBe("delivered");
  await f.observe("running"); await f.observe("idle");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.queue.list({ limit: 100 })).toHaveLength(2);
});

it("a retry refused by a returning prompt stops after that one attempt", async () => {
  const f = fixture(); await f.observe("needs_input"); const id = await f.handoff();
  await f.observe("idle"); await f.observe("idle"); await f.observe("running");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.outbox.getById(WAKE_INTENT_PREFIX + id)?.deliveryState).toBe("failed");
});

it("a pane-only approval clearing to work triggers the same recovery without another capture", async () => {
  const f = fixture();
  let content = "Would you like to run the following command?\n  $ pwd\n› 1. Yes, proceed\n  2. No, and tell Codex what to do differently\nPress enter to confirm";
  const capture = vi.fn(async () => content);
  const structural = new SeatStructuralActivityService({ capturePaneContent: capture } as never);
  structural.attachActivityChanged((session: string) => {
    void f.observe(hookOrPaneActivity(null, structural.getStructuralActivity(session))?.activity.state);
  });
  expect((await structural.pollSeat(destination))?.state).toBe("attention");
  await f.handoff(); f.clear(); content = "⠋ Working… (esc to interrupt)";
  await structural.pollSeat(destination);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(capture).toHaveBeenCalledTimes(2);
});

it("a claimed row is not woken and a never-observed clear still reaches the existing sweep", async () => {
  const f = fixture(); await f.observe("needs_input"); const claimed = await f.handoff();
  f.queue.claim({ qitemId: claimed, destinationSession: destination }); f.clear();
  await f.observe("idle"); expect(f.send).toHaveBeenCalledTimes(1);
  const stillRefused = fixture(), id = await stillRefused.handoff();
  await stillRefused.observe("unknown"); await stillRefused.observe("idle");
  expect(stillRefused.send).toHaveBeenCalledTimes(1);
  const result = await runStuckSweep({ db: stillRefused.db, queueRepo: stillRefused.queue,
    resolveOrchestrator: () => null, unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false });
  expect(result.findings).toContainEqual(expect.objectContaining({ kind: "undelivered-wake", qitemId: id, action: "created" }));
});

it("a prompt-clear retry leaves an uncertain correlated return unsent, while general recovery can still deliver it", async () => {
  const f = fixture();
  // Stage a result and its waiter's unpark before attaching their actual transport.
  const queue = new QueueRepository(f.db, f.bus, { loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  queue.attachOutbox(f.outbox);
  const blocker = await queue.create({ sourceSession: "owner@demo", destinationSession: "worker@demo", body: "work", nudge: false });
  const waiter = await queue.create({ sourceSession: "owner@demo", destinationSession: "owner@demo", body: "wait", nudge: false });
  queue.update({ qitemId: waiter.qitemId, actorSession: "owner@demo", state: "blocked", blockedOn: blocker.qitemId });
  const returned = await queue.handoff({ qitemId: blocker.qitemId, fromSession: "worker@demo", toSession: "owner@demo", body: "result" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const resultId = WAKE_INTENT_PREFIX + returned.created.qitemId;
  const peer = (f.db.prepare("SELECT outbox_id FROM outbox_entries WHERE audit_pointer=?").get(waiter.qitemId) as { outbox_id: string }).outbox_id;
  let initial = true;
  const attempts: string[][] = [];
  queue.attachTransport({ send: async (_target, _text, opts) => {
    if (initial && opts?.recheckMembers) {
      const split = opts.recheckMembers(input => input.source === "openrig", false);
      attempts.push(split.outboxIds);
      return { ok: false, sent: false, reason: "target_needs_input", error: "Refused: 'owner@demo' is at an interactive prompt (selection_prompt). No text was sent." };
    }
    attempts.push(opts?.committedOutboxIds ?? []);
    return { ok: true, verified: !initial };
  } });
  await queue.drainPendingWakeIntents();
  expect(attempts).toEqual([[resultId], [peer]]);
  expect(f.outbox.getById(resultId)?.deliveryState).toBe("failed");
  expect(f.outbox.getById(peer)?.deliveryState).toBe("indeterminate");
  initial = false;
  await queue.retryPromptWakesOnClear("owner@demo", "needs_input");
  await queue.retryPromptWakesOnClear("owner@demo", "idle");
  expect(attempts.slice(2)).toEqual([[resultId]]);
  expect(f.outbox.getById(peer)?.deliveryState).toBe("indeterminate");
  await queue.drainPendingWakeIntents();
  expect(attempts.slice(3)).toEqual([[peer]]);
  expect(f.outbox.getById(peer)?.deliveryState).toBe("delivered");
});
