// Issue #1210 — SERIALIZE QITEM PROCESSING PER SEAT.
//
// The guarantee: at most ONE runnable qitem is delivered to a seat at a time,
// FIFO. While a qitem is in-progress, later qitems for the same seat keep their
// wake intents `pending` — never injected into the seat's active context — and
// the held intent releases when the occupying qitem reaches a terminal state or
// parks as `blocked` (the post-commit pumps), oldest intent first.
//
// Two facts pin the design (queue-repository.ts):
//   • the gate lives inside deliverWakeIntent's CLAIM transaction, so the
//     synchronous SQLite txn serializes concurrent pumps: the first intent
//     claims the seat, the rest hold;
//   • occupancy counts not just `in-progress` but also a still-`pending` qitem
//     whose wake is unexpired-sent (claim race), expiring after the same
//     queue.pickup_stall_threshold_minutes grace the stalled-after-claim sweep
//     uses — a dropped wake degrades to today's visible-pending behavior
//     instead of holding the seat forever.

import { describe, it, expect, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

interface SendCall {
  session: string;
  text: string;
}

function makeHarness() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const outbox = new OutboxHandler(db);
  const calls: SendCall[] = [];
  const transport: QueueNudgeTransport = {
    async send(session: string, text: string) {
      calls.push({ session, text });
      return { ok: true, verified: true };
    },
  };
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  repo.attachTransport(transport);
  repo.attachOutbox(outbox);
  const create = (body: string, destinationSession = "worker@rig") =>
    repo.create({ sourceSession: "orch@rig", destinationSession, body });
  return { db, outbox, repo, calls, create };
}

describe("seat serialization (issue #1210)", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => h.db.close());

  it("holds a later qitem's wake while the seat works an earlier one, releasing FIFO at closure", async () => {
    h = makeHarness();
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(1);
    h.repo.claim({ qitemId: first.qitemId, destinationSession: "worker@rig" });
    expect(h.repo.getById(first.qitemId)?.state).toBe("in-progress");

    // The seat is mid-qitem: the second item's wake must hold, not inject.
    const second = await h.create("second");
    await vi.waitFor(() => expect(h.repo.getById(second.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));
    expect(h.outbox.getById(`wake-intent-${second.qitemId}`)?.deliveryState).toBe("pending");
    expect(h.calls).toHaveLength(1);

    // Closure frees the seat: the held intent releases — same pane, FIFO.
    h.repo.update({ qitemId: first.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${second.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.text).toContain(second.qitemId);
  });

  it("releases the held wake when a never-claimed occupying item parks as blocked", async () => {
    h = makeHarness();
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    // Never claimed: the seat stays occupied by the unexpired delivered wake.
    const second = await h.create("second");
    await vi.waitFor(() => expect(h.repo.getById(second.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));

    // The occupier parks as blocked — the issue names parked as a release point.
    h.repo.update({ qitemId: first.qitemId, actorSession: "orch@rig", state: "blocked", blockedOn: "gate@rig" });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${second.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
  });

  it("releases held wakes strictly oldest-first across successive closures", async () => {
    h = makeHarness();
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    h.repo.claim({ qitemId: first.qitemId, destinationSession: "worker@rig" });
    const second = await h.create("second");
    const third = await h.create("third");
    await vi.waitFor(() => expect(h.repo.getById(third.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));
    expect(h.repo.getById(second.qitemId)?.lastNudgeResult).toBe("held:seat-busy");

    h.repo.update({ qitemId: first.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${second.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.outbox.getById(`wake-intent-${third.qitemId}`)?.deliveryState).toBe("pending");
    expect(h.calls).toHaveLength(2);

    h.repo.claim({ qitemId: second.qitemId, destinationSession: "worker@rig" });
    h.repo.update({ qitemId: second.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${third.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.text).toContain(third.qitemId);
  });

  it("reports held intents through the drain tally without spinning, still pending", async () => {
    h = makeHarness();
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    h.repo.claim({ qitemId: first.qitemId, destinationSession: "worker@rig" });
    const second = await h.create("second");

    const tally = await h.repo.drainPendingWakeIntents();
    expect(tally.retained).toBeGreaterThanOrEqual(1);
    expect(h.outbox.getById(`wake-intent-${second.qitemId}`)?.deliveryState).toBe("pending");
    expect(h.calls).toHaveLength(1);
  });

  it("stops gating an unclaimed delivered wake after the pickup-stall grace", async () => {
    h = makeHarness();
    const stale = await h.create("stale");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${stale.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    // The seat never claims it. Past the stall grace a dropped wake must not
    // hold the seat forever — the next item's wake fires (the visible-pending
    // recovery the stalled-after-claim sweep idiom already names).
    h.db
      .prepare("UPDATE outbox_entries SET delivered_at = ? WHERE outbox_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), `wake-intent-${stale.qitemId}`);

    const next = await h.create("next");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${next.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
  });

  it("serializes a same-seat handoff-and-complete successor behind the older held wake", async () => {
    h = makeHarness();
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    h.repo.claim({ qitemId: first.qitemId, destinationSession: "worker@rig" });
    const held = await h.create("held");
    await vi.waitFor(() => expect(h.repo.getById(held.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));

    // Self-handoff: the successor lands on the SAME seat in the same commit that
    // frees it. FIFO: the older held wake goes first; the successor holds behind it.
    const { created } = await h.repo.handoffAndComplete({
      qitemId: first.qitemId,
      fromSession: "worker@rig",
      toSession: "worker@rig",
      body: "successor",
    });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${held.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)?.deliveryState).toBe("pending");

    h.repo.claim({ qitemId: held.qitemId, destinationSession: "worker@rig" });
    h.repo.update({ qitemId: held.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${created.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(3);
  });

  it("releases the source seat's held wake on a cross-seat handoff", async () => {
    h = makeHarness();
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    h.repo.claim({ qitemId: first.qitemId, destinationSession: "worker@rig" });
    const held = await h.create("held");
    await vi.waitFor(() => expect(h.repo.getById(held.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));

    const { created } = await h.repo.handoff({
      qitemId: first.qitemId,
      fromSession: "worker@rig",
      toSession: "reviewer@rig",
      body: "successor",
    });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${held.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    // worker@rig freed → held wake released there; reviewer@rig is a different
    // seat and receives its own successor wake unblocked.
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${created.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1]!.session).toBe("worker@rig");
    expect(h.calls[2]!.session).toBe("reviewer@rig");
  });
});
