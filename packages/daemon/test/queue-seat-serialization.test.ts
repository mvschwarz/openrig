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
//     that was handed a wake: a CONFIRMED delivered wake holds the slot until the
//     row's own state changes (an item that was delivered is not "finished"
//     because time passed — the #1210 opt-in ruling), while an UNCONFIRMED
//     `sending` wake (claim race) expires after the same
//     queue.pickup_stall_threshold_minutes grace the stalled-after-claim sweep
//     uses — a dropped wake degrades to today's visible-pending behavior
//     instead of holding the seat forever.
//
// Per-team opt-in: the hold applies only to rigs named in
// queue.seat_serialization_rigs (here: "rig", via the env twin). The default —
// no rig named — keeps today's delivery. Auto-unpark return wakes bypass the
// hold: a result other work depends on must reach an agent even when that agent
// is busy with something else. (Non-queue replies/results travel outside the
// wake-intent gate entirely.)

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
  // Opt this harness's rig into serialization (the test sessions are
  // `worker@rig` / `orch@rig`). afterEach clears the env twin.
  process.env["OPENRIG_QUEUE_SEAT_SERIALIZATION_RIGS"] = "rig";
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
  const create = (body: string, destinationSession = "worker@rig", extra?: Parameters<typeof repo.create>[0]) =>
    repo.create({ sourceSession: "orch@rig", destinationSession, body, ...extra });
  return { db, outbox, repo, calls, create };
}

describe("seat serialization (issue #1210)", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => {
    delete process.env["OPENRIG_QUEUE_SEAT_SERIALIZATION_RIGS"];
    h.db.close();
  });

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

  it("keeps holding the seat for a delivered wake even after the pickup-stall grace", async () => {
    h = makeHarness();
    const stale = await h.create("stale");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${stale.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    // The wake was CONFIRMED delivered: an item that reached the seat is not
    // "finished" because time has passed. Even far past the stall grace, the
    // delivered wake holds the slot until the row's own state changes.
    h.db
      .prepare("UPDATE outbox_entries SET delivered_at = ? WHERE outbox_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), `wake-intent-${stale.qitemId}`);

    const next = await h.create("next");
    await vi.waitFor(() => expect(h.repo.getById(next.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));
    expect(h.outbox.getById(`wake-intent-${next.qitemId}`)?.deliveryState).toBe("pending");
    expect(h.calls).toHaveLength(1);

    // Only the row's own closure frees the slot.
    h.repo.update({ qitemId: stale.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${next.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
  });

  it("stops gating an unconfirmed sending wake after the pickup-stall grace", async () => {
    h = makeHarness();
    const stale = await h.create("stale");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${stale.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    // Claim race: the wake is claimed for sending (ambiguous — it may have
    // landed) but the seat never picked the item up. Past the stall grace the
    // unconfirmed wake must not hold the seat forever — the next item's wake
    // fires (the visible-pending recovery the stalled-after-claim sweep
    // idiom already names).
    h.db
      .prepare("UPDATE outbox_entries SET delivery_state = 'sending', delivered_at = ? WHERE outbox_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), `wake-intent-${stale.qitemId}`);

    const next = await h.create("next");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${next.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
  });

  it("keeps today's delivery for rigs that did not opt in", async () => {
    h = makeHarness();
    delete process.env["OPENRIG_QUEUE_SEAT_SERIALIZATION_RIGS"];
    const first = await h.create("first");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${first.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    h.repo.claim({ qitemId: first.qitemId, destinationSession: "worker@rig" });
    expect(h.repo.getById(first.qitemId)?.state).toBe("in-progress");

    // No opt-in for `rig`: the busy seat still receives the later wake —
    // exactly the pre-serialization behavior.
    const second = await h.create("second");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${second.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    expect(h.calls).toHaveLength(2);
    expect(h.repo.getById(second.qitemId)?.lastNudgeResult).not.toBe("held:seat-busy");
  });

  it("delivers an auto-unpark return wake to a seat that is busy with something else", async () => {
    h = makeHarness();
    // The occupier: worker@rig is mid-qitem.
    const occupier = await h.create("occupier");
    await vi.waitFor(() =>
      expect(h.outbox.getById(`wake-intent-${occupier.qitemId}`)?.deliveryState).toBe("delivered"),
    );
    h.repo.claim({ qitemId: occupier.qitemId, destinationSession: "worker@rig" });

    // A parked item waiting on a blocker that lives on another seat.
    const blocker = await h.create("blocker", "orch2@rig");
    const parked = await h.create("parked");
    await vi.waitFor(() => expect(h.repo.getById(parked.qitemId)?.lastNudgeResult).toBe("held:seat-busy"));
    h.repo.update({
      qitemId: parked.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: blocker.qitemId,
    });

    // The blocker resolves elsewhere. The return wake ("blocker resolved;
    // resume") is a result other work depends on — it must reach the busy
    // worker@rig even though the occupier still holds the seat's slot.
    h.repo.update({ qitemId: blocker.qitemId, actorSession: "orch2@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() => {
      const ret = h.db
        .prepare(
          "SELECT delivery_state FROM outbox_entries WHERE audit_pointer = ? AND tags LIKE '%queue:auto-unpark:blocker%'",
        )
        .get(parked.qitemId) as { delivery_state: string } | undefined;
      expect(ret?.delivery_state).toBe("delivered");
    });
    // The parked row's original wake never reached the seat (it was superseded
    // when the row parked) — the dependent return is what delivered.
    expect(h.outbox.getById(`wake-intent-${parked.qitemId}`)?.deliveryState).not.toBe("delivered");
    // Sends so far: the occupier's wake, the blocker's own wake (orch2@rig),
    // and the bypassing return — nothing else leaked past the gate.
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.session).toBe("worker@rig");
    expect(h.calls[2]!.text).toContain("Resume the recorded continuation");
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
