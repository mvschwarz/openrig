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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

interface SendCall {
  session: string;
  text: string;
}

/** A mock wake transport that records every send and lets a test dictate the
 *  outcome (ok+verified, ok+unverified = the ambiguous face, not-ok, or throw). */
type SendMode = "verified" | "unverified" | "notok" | "timeout" | "throw" | "throw-timeout";
function makeMockTransport(): {
  transport: QueueNudgeTransport;
  calls: SendCall[];
  outcome: { mode: SendMode; error?: string };
} {
  const calls: SendCall[] = [];
  const outcome: { mode: SendMode; error?: string } = {
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
        case "timeout":
          // A timeout is AMBIGUOUS: the send may or may not have landed.
          return { ok: false, reason: "verify timeout waiting for render ack" };
        case "throw":
          throw new Error(outcome.error ?? "transport exploded");
        case "throw-timeout":
          throw new Error("send ETIMEDOUT after 5000ms");
      }
    },
  };
  return { transport, calls, outcome };
}

function makeHarness(opts?: { deferTransport?: boolean; resolveOccupantGeneration?: () => string | null }) {
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
  const repo = new QueueRepository(db, bus, {
    validateRig: () => true,
    resolveOccupantGeneration: opts?.resolveOccupantGeneration,
  });
  // deferTransport leaves the intent PENDING after a real handoff (the immediate
  // post-commit deliver is skipped without a transport) — the crash window a drain
  // recovers from.
  if (!opts?.deferTransport) repo.attachTransport(transport);
  repo.attachOutbox(outbox);
  return {
    db, bus, outbox, repo, calls, outcome, transport,
    attachTransport: () => repo.attachTransport(transport),
  };
}

// MF2 (guard HOLD): the atomic seam must NOT be optional and must NOT span two
// databases. A durable wake intent only commits atomically with the close when it
// is written on the SAME connection inside the same transaction; and a
// nudge-intended terminal act with no intent store cannot make good on W1's
// guarantee, so it must fail closed rather than silently close without an intent.
describe("W1 MF2 — the atomic seam is mandatory and single-DB", () => {
  it("attachOutbox REJECTS an outbox backed by a different DB connection (split-DB)", () => {
    const db1 = createDb();
    migrate(db1, [
      coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
      queueTargetRepoSchema, outboxEntriesSchema,
    ]);
    const db2 = createDb();
    migrate(db2, [outboxEntriesSchema]);
    const repo = new QueueRepository(db1, new EventBus(db1), { validateRig: () => true });
    const foreignOutbox = new OutboxHandler(db2); // different connection
    expect(() => repo.attachOutbox(foreignOutbox)).toThrow(/db|connection|same/i);
    db1.close();
    db2.close();
  });

  it("a nudge-intended terminal handoff with NO outbox attached FAILS CLOSED (no silent close-without-intent)", async () => {
    const db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
      queueTargetRepoSchema, outboxEntriesSchema,
    ]);
    const { transport } = makeMockTransport();
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachTransport(transport);
    // deliberately NO attachOutbox
    const source = await repo.create({
      sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x",
    });
    await expect(
      repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" }),
    ).rejects.toThrow(/intent store|outbox|unavailable/i);
    // the close rolled back — source stays open
    expect(repo.getById(source.qitemId)!.state).toBe("pending");
    db.close();
  });

  it("a nudge:false terminal handoff with NO outbox is allowed (no wake intended ⇒ no store needed)", async () => {
    const db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
      queueTargetRepoSchema, outboxEntriesSchema,
    ]);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const source = await repo.create({
      sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x",
    });
    const { closed } = await repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y", nudge: false,
    });
    expect(closed.state).toBe("handed-off");
    db.close();
  });
});

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

  it("demo1 — a crash-orphaned intent from a REAL handoff drains idempotently: drain twice, delivered ONCE", async () => {
    // Drive the REAL emitter (proof contract): a handoff with NO transport attached
    // commits the durable intent but skips the immediate deliver — exactly a crash
    // after commit / before drain. Then the recovery sweep delivers it, once.
    const g = makeHarness({ deferTransport: true });
    const source = await g.repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await g.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    // committed but PENDING, and never sent — the crash window.
    expect(g.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("pending");
    expect(g.calls).toHaveLength(0);

    g.attachTransport();
    g.outcome.mode = "verified";
    const first = await g.repo.drainPendingWakeIntents();
    expect(first.delivered).toBe(1);
    expect(g.calls).toHaveLength(1);
    expect(g.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("delivered");

    // Second drain finds nothing pending — the compare-and-set makes it a no-op.
    const second = await g.repo.drainPendingWakeIntents();
    expect(second.delivered).toBe(0);
    expect(g.calls).toHaveLength(1); // delivered exactly once
    g.db.close();
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

// MF6 (guard HOLD): the LOCK requires a timeout/ambiguous outcome to record
// `indeterminate`. The prior code classified only ok&&!verified that way; a
// timeout-shaped non-OK became `failed`, and because recovery drains only
// `pending`, a `failed` row is never retried despite the prose. Fix: classify a
// timeout as indeterminate from the typed result; keep the honest retry policy
// (only `pending` is retried; failed/indeterminate are terminal-visible).
describe("W1 MF6 — timeout classifies as indeterminate; retry policy is honest", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.db.close());

  async function doHandoff() {
    const source = await h.repo.create({
      sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x",
    });
    h.calls.length = 0;
    return h.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
  }

  it("a transport TIMEOUT (ok:false, timeout reason) records INDETERMINATE, not failed", async () => {
    h.outcome.mode = "timeout";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("indeterminate");
  });

  it("a THROWN timeout (ETIMEDOUT) also records INDETERMINATE", async () => {
    h.outcome.mode = "throw-timeout";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("indeterminate");
  });

  it("a genuine hard failure (unreachable) still records FAILED", async () => {
    h.outcome.mode = "notok";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("failed");
  });

  it("retry policy is honest: a FAILED intent is NOT re-drained by the recovery sweep", async () => {
    h.outcome.mode = "notok";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("failed");
    h.calls.length = 0;
    h.outcome.mode = "verified";
    const tally = await h.repo.drainPendingWakeIntents();
    // recovery drains only `pending` — a terminal `failed` is left visible, not resent.
    expect(tally).toEqual({ delivered: 0, indeterminate: 0, failed: 0 });
    expect(h.calls).toHaveLength(0);
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("failed");
  });
});

// MF3 (guard HOLD): overlapping drains must send the external wake ONCE, not just
// converge to one final state. The claim-before-send (pending→sending) makes the
// losing drain find nothing to claim.
describe("W1 MF3 — overlapping drains send the external wake exactly once", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.db.close());

  it("two concurrent drains of the same crash-orphaned intent: ONE send, honest tallies", async () => {
    const g = makeHarness({ deferTransport: true });
    const source = await g.repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await g.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    g.attachTransport();
    g.outcome.mode = "verified";
    const [ta, tb] = await Promise.all([
      g.repo.drainPendingWakeIntents(),
      g.repo.drainPendingWakeIntents(),
    ]);
    expect(g.calls).toHaveLength(1); // the external wake happened exactly ONCE
    expect(ta.delivered + tb.delivered).toBe(1); // per-drain tallies sum to one, not two
    expect(g.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("delivered");
    g.db.close();
  });
});

// MF4 (guard HOLD): recovery must not forge the CURRENT occupant's generation onto
// an old intent. The intent freezes the emitting envelope (generation resolved at
// stage time) and delivery replays it verbatim.
describe("W1 MF4 — the intent freezes its emitting generation/envelope", () => {
  const ALL = [
    coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
    queueTargetRepoSchema, outboxEntriesSchema,
  ];

  it("freeze: the staged intent carries the SOURCE generation resolved at STAGE time", async () => {
    const db = createDb();
    migrate(db, ALL);
    const { transport } = makeMockTransport();
    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      resolveOccupantGeneration: () => "11111111-aaaa-bbbb-cccc-dddddddddddd",
    });
    repo.attachTransport(transport);
    const outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    const source = await repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    const intent = outbox.getById(`wake-intent-${created.qitemId}`);
    expect(intent!.body).toContain("gen 11111111"); // frozen at stage
    db.close();
  });

  it("no relabel: recovery delivers the FROZEN envelope verbatim after a tenure swap", async () => {
    const db = createDb();
    migrate(db, ALL);
    const { transport, calls, outcome } = makeMockTransport();
    // A resolver that would relabel to the CURRENT occupant if delivery re-resolved.
    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      resolveOccupantGeneration: () => "22222222-current-occupant-tenure",
    });
    const outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    // A REAL successor qitem so the intent references an existing target (MF5).
    const successor = await repo.create({ sourceSession: "driver@rig", destinationSession: "reviewer@rig", body: "z" });
    // A committed-but-undelivered intent whose frozen envelope carries the ORIGINAL gen.
    const FROZEN =
      `From: driver@rig\nTo: reviewer@rig\nSent: 08-08 19:44Z · gen 11111111\n---\nQueue handoff: ${successor.qitemId} - check your queue.\n---\n↩ Reply: rig send driver@rig \"...\"`;
    outbox.record({ outboxId: `wake-intent-${successor.qitemId}`, senderSession: "driver@rig", destinationSession: "reviewer@rig", body: FROZEN, auditPointer: successor.qitemId });
    repo.attachTransport(transport); // tenure swap: transport now available
    outcome.mode = "verified";
    await repo.drainPendingWakeIntents();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(FROZEN); // verbatim
    expect(calls[0]!.text).not.toContain("22222222"); // did NOT re-resolve to the current occupant
    db.close();
  });
});

// The drain refuses a wake whose target qitem does not exist. The route-side prefix
// refusal was unbuilt (founder ruling), so a caller CAN record an id under the
// executable prefix; this pin is what stops such a row being sent as a real wake
// when it points at nothing.
describe("W1 — the drain never sends a wake for a nonexistent qitem", () => {
  it("a wake-intent pointing at a NONEXISTENT qitem is failed, never sent", async () => {
    const h = makeHarness();
    h.outbox.record({
      outboxId: "wake-intent-ghost",
      senderSession: "attacker@rig",
      destinationSession: "victim@rig",
      body: "forged wake payload",
      auditPointer: "qitem-does-not-exist",
    });
    h.outcome.mode = "verified";
    const tally = await h.repo.drainPendingWakeIntents();
    expect(h.calls).toHaveLength(0); // never sent as a real wake
    expect(tally.failed).toBe(1);
    expect(h.outbox.getById("wake-intent-ghost")!.deliveryState).toBe("failed");
    h.db.close();
  });
});

// Re-seal BLOCKING 1 (guard): an abandoned `sending` claim (a crash after claim,
// before finalize — same persisted state whether the send landed or not) must
// reconcile to `indeterminate` at the recovery boundary, WITHOUT re-sending.
describe("W1 re-seal BLOCKING 1 — abandoned `sending` claims reconcile to indeterminate", () => {
  it("a claimed intent left `sending` by a crash becomes `indeterminate` on recovery, never re-sent", async () => {
    const g = makeHarness({ deferTransport: true });
    const source = await g.repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await g.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    const intentId = `wake-intent-${created.qitemId}`;
    // Simulate the crash window: claim (pending->sending), then die before finalize.
    g.outbox.claimForDelivery(intentId);
    expect(g.outbox.getById(intentId)!.deliveryState).toBe("sending");

    // Reopen: a fresh repo on the SAME db runs the startup recovery sweep.
    const reopened = new QueueRepository(g.db, new EventBus(g.db), { validateRig: () => true });
    reopened.attachOutbox(g.outbox);
    reopened.attachTransport(g.transport);
    g.outcome.mode = "verified";
    const reconciled = reopened.reconcileAbandonedWakeIntents();
    const tally = await reopened.drainPendingWakeIntents();

    expect(reconciled).toBe(1);
    expect(g.calls).toHaveLength(0); // NEVER re-sent
    expect(tally.delivered).toBe(0); // reconciled to indeterminate ⇒ nothing pending to deliver
    expect(g.outbox.getById(intentId)!.deliveryState).toBe("indeterminate");
    g.db.close();
  });
});

// The executable drain selector is EXACT-CASE, so a `WAKE-INTENT-…` variant is never
// selected/executed. NOTE: the public /outbox/record route no longer rejects reserved-prefix
// ids (the W4-era MF5 route guard was unbuilt — founder ruling: its justification required an
// adversary inside this trust domain, where the only caller is the daemon's own localhost
// client). That makes this selector pin MORE load-bearing, not less: it is now the only thing
// keeping a recorded case-variant id out of the executable drain.
describe("W1 — the executable drain selector is exact-case", () => {
  it("a WAKE-INTENT- case variant is NOT selected by the drain (never executed)", async () => {
    const h = makeHarness();
    const q = await h.repo.create({ sourceSession: "driver@rig", destinationSession: "reviewer@rig", body: "z" });
    h.calls.length = 0; // ignore the create-time nudge; count only drain sends
    const variantId = `WAKE-INTENT-${q.qitemId}`; // uppercase variant, real target qitem
    h.outbox.record({ outboxId: variantId, senderSession: "attacker@rig", destinationSession: "victim@rig", body: "variant", auditPointer: q.qitemId });
    h.outcome.mode = "verified";
    const tally = await h.repo.drainPendingWakeIntents();
    expect(h.calls).toHaveLength(0); // the variant was never selected/sent
    expect(tally.delivered).toBe(0);
    expect(h.outbox.getById(variantId)!.deliveryState).toBe("pending"); // untouched
    h.db.close();
  });
});

// Re-seal #3 (guard): a REAL file-backed close/reopen crash boundary. The earlier
// BLOCKING 1 test reused one still-open in-memory Database, so it did not actually
// cross a restart. This one persists to disk, CLOSES the connection (the crash),
// then reopens the SAME file with FRESH objects (a new process) before recovering.
// The before-send and after-send/before-finalize windows share the same persisted
// `sending` state, so one equivalence pin suffices.
describe("W1 re-seal #3 — real file-backed close/reopen crash boundary", () => {
  const ALL = [
    coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
    queueTargetRepoSchema, outboxEntriesSchema,
  ];

  it("a claimed `sending` intent survives a db CLOSE/REOPEN and reconciles to indeterminate, never re-sent", async () => {
    const dbPath = join(tmpdir(), `w1-reopen-${Date.now()}-${process.pid}.sqlite`);
    try {
      // --- process 1: real handoff, claim the intent, then CRASH (close the db) ---
      const db1 = createDb(dbPath);
      migrate(db1, ALL);
      const outbox1 = new OutboxHandler(db1);
      const repo1 = new QueueRepository(db1, new EventBus(db1), { validateRig: () => true });
      repo1.attachOutbox(outbox1); // no transport ⇒ immediate deliver skipped ⇒ intent pending
      const source = await repo1.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
      const { created } = await repo1.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" });
      const intentId = `wake-intent-${created.qitemId}`;
      outbox1.claimForDelivery(intentId); // claim, then die before finalize
      expect(outbox1.getById(intentId)!.deliveryState).toBe("sending");
      db1.close(); // the crash: connection gone; row persisted on disk as `sending`

      // --- process 2: reopen the SAME db file with FRESH objects, then recover ---
      const db2 = createDb(dbPath);
      const outbox2 = new OutboxHandler(db2);
      const { transport, calls } = makeMockTransport();
      const repo2 = new QueueRepository(db2, new EventBus(db2), { validateRig: () => true });
      repo2.attachOutbox(outbox2);
      repo2.attachTransport(transport);
      expect(outbox2.getById(intentId)!.deliveryState).toBe("sending"); // survived the reopen

      const reconciled = repo2.reconcileAbandonedWakeIntents();
      const tally = await repo2.drainPendingWakeIntents();

      expect(reconciled).toBe(1);
      expect(outbox2.getById(intentId)!.deliveryState).toBe("indeterminate");
      expect(calls).toHaveLength(0); // NEVER re-sent across the restart
      expect(tally).toEqual({ delivered: 0, indeterminate: 0, failed: 0 }); // no re-drive
      db2.close();
    } finally {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try { rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* best effort */ }
      }
    }
  });
});
