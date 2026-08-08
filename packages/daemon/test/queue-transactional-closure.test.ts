// W1 — TRANSACTIONAL CLOSURE (mission release-0.5.1, 51-06).
//
// Atom origin: workspace/missions/release-0.5.1/WAVE-CONVERSION-state-vs-truth-2026-08-07-pm-openrig.md
//   § "W1 — TRANSACTIONAL CLOSURE", sha-16 5c899ee14a693fdb.
// Plan: workspace/artifacts/PLAN-W1-transactional-closure-dev50-planner.md sha-16 0738722b87e9e38b.
//
// The atom: a qitem terminal act (close + transition) and its WAKE INTENT commit
// as ONE act or NONE, so an executed-but-unclosed item becomes impossible to WRITE
// rather than merely detectable. The wake nudge is a pane write and CANNOT join a db
// transaction (a pane write inside a txn would make the txn lie in the other
// direction — queue-repository.ts post-commit contract, reversed-never). So what
// joins the txn is the DURABLE INTENT ROW (an outbox_entries row); the external
// delivery drains from that committed intent afterward.
//
// Proof discipline (PM amendment): a green-path run cannot demonstrate atomicity —
// one-act-or-none is only observable by watching the act fail midway. The demos
// below are effect-reads on the queue emitter, each naming its pin:
//   demo2 → W1-a  (fail INSIDE txn ⇒ NOTHING persists — the NONE side)
//   demo1 → W1-b  (drain idempotence — drain twice, delivered once)
//   demo3 → W1-c  (guard shown FIRING at the seam)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import type { QueueNudgeTransport } from "../src/domain/queue-repository.js";

interface SendCall {
  session: string;
  text: string;
}

/** A mock wake transport that records every send and lets a test dictate the
 *  outcome (ok+verified, ok+unverified = the ambiguous face, not-ok, or throw). */
function makeMockTransport(): {
  transport: QueueNudgeTransport;
  calls: SendCall[];
  outcome: { mode: "verified" | "unverified" | "notok" | "throw"; error?: string };
} {
  const calls: SendCall[] = [];
  const outcome: { mode: "verified" | "unverified" | "notok" | "throw"; error?: string } = {
    mode: "verified",
  };
  const transport: QueueNudgeTransport = {
    async send(session: string, text: string) {
      calls.push({ session, text });
      switch (outcome.mode) {
        case "verified":
          return { ok: true, verified: true };
        case "unverified":
          return { ok: true, verified: false };
        case "notok":
          return { ok: false, error: outcome.error ?? "unreachable" };
        case "throw":
          throw new Error(outcome.error ?? "transport exploded");
      }
    },
  };
  return { transport, calls, outcome };
}

function makeHarness() {
  const db = createDb();
  migrate(db, [
    coreSchema,
    eventsSchema,
    queueItemsSchema,
    queueTransitionsSchema,
    queueTargetRepoSchema,
    outboxEntriesSchema,
  ]);
  const bus = new EventBus(db);
  const outbox = new OutboxHandler(db);
  const { transport, calls, outcome } = makeMockTransport();
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  repo.attachTransport(transport);
  repo.attachOutbox(outbox);
  return { db, bus, outbox, repo, calls, outcome };
}

describe("W1 transactional closure — W1-a: the durable intent row joins the terminal txn", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  it("a handoff commits close + successor + wake intent atomically (intent row present, pending)", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    const { closed, created } = await h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
    });

    expect(closed.state).toBe("handed-off");
    expect(created.destinationSession).toBe("reviewer@rig");

    // The wake intent for the successor is durably committed — a row exists whose
    // destination is the successor's owner. (Its delivery OUTCOME is W1-b's concern;
    // W1-a's property is that the intent EXISTS, coupled atomically to the close.)
    const intents = h.outbox.listForSender("driver@rig");
    const wake = intents.find((e) => e.destinationSession === "reviewer@rig");
    expect(wake).toBeTruthy();
    expect(wake!.auditPointer).toBe(created.qitemId);
  });

  it("handoffAndComplete also stages the durable wake intent (symmetric)", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    const { closed } = await h.repo.handoffAndComplete({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
    });

    expect(closed.state).toBe("done");
    const intents = h.outbox.listForSender("driver@rig");
    expect(intents.some((e) => e.destinationSession === "reviewer@rig")).toBe(true);
  });

  // demo2 → W1-a: the NONE side. A failure INSIDE the terminal txn (here: the
  // intent-stage throws) must roll back EVERYTHING — no close, no successor, no
  // intent. This is what distinguishes an atom from "three writes in a row": the
  // close is not observable without its intent.
  it("demo2 — failure INSIDE the txn persists NOTHING (no close, no successor, no intent)", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    // Force the in-txn intent stage to throw — simulating a mid-transaction fault.
    const spy = vi.spyOn(h.outbox, "record").mockImplementationOnce(() => {
      throw new Error("intent-stage fault mid-transaction");
    });

    await expect(
      h.repo.handoff({
        qitemId: source.qitemId,
        fromSession: "driver@rig",
        toSession: "reviewer@rig",
        body: "review the thing",
      }),
    ).rejects.toThrow();

    spy.mockRestore();

    // Source did NOT close.
    const reloaded = h.repo.getById(source.qitemId);
    expect(reloaded!.state).toBe("pending");
    // No successor was created (only the original item exists for the seat).
    const successors = h.db
      .prepare("SELECT COUNT(*) AS n FROM queue_items WHERE handed_off_from = ?")
      .get(source.qitemId) as { n: number };
    expect(successors.n).toBe(0);
    // No intent row survived the rollback.
    expect(h.outbox.listForSender("driver@rig")).toHaveLength(0);
  });

  it("nudge:false stages NO wake intent (no wake intended ⇒ no durable intent, nothing to drain)", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });
    await h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
      nudge: false,
    });
    expect(h.outbox.listForSender("driver@rig")).toHaveLength(0);
  });
});

describe("W1 transactional closure — W1-b: the drain, with indeterminate-outcome discipline", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  async function doHandoff() {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });
    // The create() above fires its own nudge to driver@rig — clear so the counts
    // below measure ONLY the handoff's wake delivery to the successor.
    h.calls.length = 0;
    return h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
    });
  }

  it("immediate post-commit delivery marks the intent DELIVERED on a verified nudge", async () => {
    h.outcome.mode = "verified";
    const { created } = await doHandoff();
    const row = h.outbox.getById(`wake-intent-${created.qitemId}`);
    expect(row!.deliveryState).toBe("delivered");
    expect(h.calls).toHaveLength(1);
  });

  it("an AMBIGUOUS nudge (res.ok, NOT verified) records INDETERMINATE — never delivered, never failed", async () => {
    // The live specimen: rendered-unconfirmed sends (landed, pane re-render not
    // confirmed) are res.ok && !verified in production today.
    h.outcome.mode = "unverified";
    const { created } = await doHandoff();
    const row = h.outbox.getById(`wake-intent-${created.qitemId}`);
    expect(row!.deliveryState).toBe("indeterminate");
  });

  it("a HARD delivery failure records FAILED and the item stays CLOSED (close is not conditional on delivery)", async () => {
    h.outcome.mode = "notok";
    const { closed, created } = await doHandoff();
    // The close committed in the transaction regardless of the later delivery.
    expect(closed.state).toBe("handed-off");
    // Q1 residue: a live-daemon transient failure lands in a VISIBLE state, not
    // lingering `pending` (a periodic retry is the named follow-on, out of scope).
    const row = h.outbox.getById(`wake-intent-${created.qitemId}`);
    expect(row!.deliveryState).toBe("failed");
  });

  it("demo1 — drain a crash-orphaned pending intent, IDEMPOTENTLY: drain twice, delivered ONCE", async () => {
    // A committed-but-undelivered wake intent models the crash window: the
    // terminal txn committed (intent durable) but the process died before the
    // post-commit deliver. The startup-recovery sweep is the retry.
    h.outbox.record({
      outboxId: "wake-intent-qX",
      senderSession: "driver@rig",
      destinationSession: "reviewer@rig",
      body: "Queue handoff: qX - check your queue.",
      auditPointer: "qX",
    });
    h.outcome.mode = "verified";

    const first = await h.repo.drainPendingWakeIntents();
    expect(first.delivered).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.outbox.getById("wake-intent-qX")!.deliveryState).toBe("delivered");

    // Second drain finds nothing pending — the compare-and-set makes it a no-op.
    const second = await h.repo.drainPendingWakeIntents();
    expect(second.delivered).toBe(0);
    expect(h.calls).toHaveLength(1); // delivered exactly once
  });
});

describe("W1 transactional closure — W1-c: the seam guard (a terminal close cannot commit without its intent)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  // demo3 → W1-c: the guard shown FIRING. We drive the REAL handoff chokepoint —
  // the same path production traverses — but neuter the in-txn intent stage,
  // simulating a future refactor that writes the close and drops the intent.
  // The guard must fail that at the SEAM (throw, inside the txn), not defer it to
  // review. A guard merely present but never demonstrated firing is the
  // assert-the-effect-not-the-indicator class.
  it("demo3 — a terminal close that SKIPS intent staging FAILS AT THE SEAM (guard throws, txn rolls back)", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    // Synthetic close-without-intent: the close is still written, but no wake
    // intent is staged — the exact class the guard forbids.
    const spy = vi
      .spyOn(h.repo as unknown as { stageWakeIntent: () => void }, "stageWakeIntent")
      .mockImplementation(() => {});

    await expect(
      h.repo.handoff({
        qitemId: source.qitemId,
        fromSession: "driver@rig",
        toSession: "reviewer@rig",
        body: "review the thing",
      }),
    ).rejects.toThrow(/terminal_close_without_wake_intent|one act or none/i);

    spy.mockRestore();

    // The guard fired INSIDE the transaction, so the close rolled back — the
    // source is still open. An executed-but-unwoken close was made UNWRITABLE.
    expect(h.repo.getById(source.qitemId)!.state).toBe("pending");
  });

  it("nudge:false does NOT trip the guard (no wake intended ⇒ no intent required)", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    // Intent staging skipped AND nudge:false — the guard must recognize that no
    // wake was intended and let the close commit.
    const spy = vi
      .spyOn(h.repo as unknown as { stageWakeIntent: () => void }, "stageWakeIntent")
      .mockImplementation(() => {});

    const { closed } = await h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
      nudge: false,
    });

    expect(closed.state).toBe("handed-off");
    spy.mockRestore();
  });
});
