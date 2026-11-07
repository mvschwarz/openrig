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

function fixture(resolveSessionAddresses?: (name: string) => string[]) {
  const db = createDb(); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db), outbox = new OutboxHandler(db);
  let refused = true;
  const send = vi.fn(async () => refused
    ? { ok: false, sent: false, reason: "target_needs_input", error: `Refused: '${destination}' is at an interactive prompt (selection_prompt). No text was sent.` }
    : { ok: true, verified: true });
  const queue = new QueueRepository(db, bus, { transport: { send }, resolveSessionAddresses, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  queue.attachOutbox(outbox);
  const observe = async (state: AgentActivity["state"] | undefined, paneNeedsInput = false) => queue.retryPromptWakesOnClear(destination, state, paneNeedsInput);
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

it("a claimed row is not woken and unknown attention still reaches the existing sweep", async () => {
  const f = fixture(); await f.observe("needs_input"); const claimed = await f.handoff();
  f.queue.claim({ qitemId: claimed, destinationSession: destination }); f.clear();
  await f.observe("idle"); expect(f.send).toHaveBeenCalledTimes(1);
  const stillRefused = fixture(), id = await stillRefused.handoff();
  await stillRefused.observe("unknown");
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


it("a created original recovers after a transport refusal even if no needs_input hook was observed", async () => {
  const f = fixture(); await f.observe("idle");
  const row = await f.queue.create({ sourceSession: "planner@demo", destinationSession: destination, body: "original ask" });
  await vi.waitFor(() => expect(f.outbox.getById(WAKE_INTENT_PREFIX + row.qitemId)?.deliveryState).toBe("failed"));
  const original = f.outbox.getById(WAKE_INTENT_PREFIX + row.qitemId)!;
  expect(row.handedOffFrom).toBeNull();
  f.clear(); await f.observe("idle"); await f.observe("idle");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1][1]).toContain(original.body);
  expect(f.outbox.getById(original.outboxId)?.deliveryState).toBe("delivered");
  expect(f.queue.list({ limit: 100 })).toHaveLength(1);
});

it("a fresh idle hook cannot consume clear recovery while the cached pane still needs input", async () => {
  const f = fixture(); await f.observe("idle"); await f.handoff();
  let content = "Would you like to run the following command?\n  $ pwd\n› 1. Yes, proceed\n  2. No, and tell Codex what to do differently\nPress enter to confirm";
  let hook: AgentActivity | null = { state: "idle", reason: "idle hook", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), evidence: null };
  const capture = vi.fn(async () => content);
  const structural = new SeatStructuralActivityService({ capturePaneContent: capture } as never);
  structural.attachActivityChanged(session => {
    const pane = structural.getStructuralActivity(session);
    void f.observe(hookOrPaneActivity(hook, pane)?.activity.state, pane?.state === "attention");
  });
  await structural.pollSeat(destination);
  expect(f.send).toHaveBeenCalledTimes(1);
  hook = null; // hook expires, unchanged pane emits no change callback
  await structural.pollSeat(destination);
  expect(f.send).toHaveBeenCalledTimes(1);
  f.clear(); content = "⠋ Working… (esc to interrupt)";
  await structural.pollSeat(destination);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  await f.observe("idle"); expect(f.send).toHaveBeenCalledTimes(2);
  expect(capture).toHaveBeenCalledTimes(3);
});

it("the first clear after repository restart uses the durable failed original intent", async () => {
  const f = fixture(); const id = await f.handoff(); f.clear();
  const restarted = new QueueRepository(f.db, f.bus, { transport: { send: f.send }, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  restarted.attachOutbox(f.outbox);
  await restarted.retryPromptWakesOnClear(destination, "unknown");
  expect(f.send).toHaveBeenCalledTimes(1);
  await restarted.retryPromptWakesOnClear(destination, "idle");
  await restarted.retryPromptWakesOnClear(destination, "idle");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.outbox.getById(WAKE_INTENT_PREFIX + id)?.deliveryState).toBe("delivered");
});

it("clear recovery never replays a durable uncertain delivery even if the row still reports a refusal", async () => {
  const f = fixture(); const id = await f.handoff();
  f.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=?").run(WAKE_INTENT_PREFIX + id);
  f.clear(); await f.observe("idle");
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.outbox.getById(WAKE_INTENT_PREFIX + id)?.deliveryState).toBe("indeterminate");
});

it("a refusal recorded against an address alias arms recovery from the physical session callback", async () => {
  const physical = "worker-physical@demo";
  const f = fixture(() => [destination, physical]);
  await f.queue.retryPromptWakesOnClear(physical, "idle");
  const id = await f.handoff(); f.clear();
  await f.queue.retryPromptWakesOnClear(physical, "idle");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.outbox.getById(WAKE_INTENT_PREFIX + id)?.deliveryState).toBe("delivered");
});


it("overlapping clear passes retain reservations until both passes finish", async () => {
  const f = fixture();
  const gates = Array.from({ length: 3 }, () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  });
  let attempts = 0;
  const send = vi.fn(async () => {
    const attempt = ++attempts;
    if (attempt >= 4 && attempt <= 6) await gates[attempt - 4]!.promise;
    return { ok: false, sent: false, reason: "target_needs_input", error: `Refused: '${destination}' is at an interactive prompt (selection_prompt). No text was sent.` };
  });
  // Legacy, non-precommitted wakes still share this clear recovery path. Separate
  // sends let A finish while B still owns a reservation for the same rows.
  const queue = new QueueRepository(f.db, f.bus, { transport: { send }, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  await queue.create({ sourceSession: "planner@demo", destinationSession: destination, body: "first" });
  await queue.create({ sourceSession: "planner@demo", destinationSession: destination, body: "second" });
  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.list({ limit: 100 }).every(row => row.lastNudgeWireResult?.startsWith("failed:"))).toBe(true);
  });
  const first = queue.retryPromptWakesOnClear(destination, "idle");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
  await queue.retryPromptWakesOnClear(destination, "needs_input");
  const second = queue.retryPromptWakesOnClear(destination, "idle");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
  gates[0]!.release(); await first;
  gates[1]!.release();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(6));
  gates[2]!.release(); await second;
  await queue.retryPromptWakesOnClear(destination, "idle");
  expect(send).toHaveBeenCalledTimes(6);
});
