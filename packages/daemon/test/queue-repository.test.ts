import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { occupantGenerationStampsSchema } from "../src/db/migrations/063_occupant_generation_stamps.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import {
  QueueRepository,
  QueueRepositoryError,
} from "../src/domain/queue-repository.js";
import { CLOSURE_REASONS } from "../src/domain/hot-potato-enforcer.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("QueueRepository", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    // W1 MF2: a nudge-intended terminal handoff now requires an attached wake-intent
    // store (production always wires one at startup) — mirror that in the harness.
    repo.attachOutbox(new OutboxHandler(db));
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("create stamps qitem_id + transition + queue.created event", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig-a",
      destinationSession: "bob@rig-b",
      body: "do the thing",
    });
    expect(item.qitemId).toMatch(/^qitem-\d{14}-[a-f0-9]{8}$/);
    expect(item.state).toBe("pending");
    expect(item.priority).toBe("routine");
    expect(captured.some((e) => e.type === "queue.created")).toBe(true);
    const transitions = repo.transitionLog.listForQitem(item.qitemId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.state).toBe("pending");
  });

  // 0.5.1-54 DR-1 — surface create-path failed-nudge strands. last_nudge_result is written but never
  // queried, so a create whose nudge FAILED (`failed:<msg>`) is invisible (the sender believes delivery
  // succeeded; the destination was never woken). findUndelivered surfaces exactly that class:
  // state='pending' AND last_nudge_result LIKE 'failed:%'. V1-ONLY, no false-positive mode — a delivered
  // row and a never-attempted (NULL) cold-park are both excluded; the never-attempted class stays deferred
  // behind a forward create-time intent bit (FP-dominated). DR-1 only READS (no retry, no unwind).
  it("DR-1 findUndelivered: surfaces pending failed:% strands, excludes delivered + never-attempted", async () => {
    const failed = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "failed nudge" });
    repo.recordNudgeAttempt(failed.qitemId, "failed:Session 'b@rig' not found");
    const delivered = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "delivered" });
    repo.recordNudgeAttempt(delivered.qitemId, "verified");
    // never-attempted: this harness has no transport → maybeNudge no-ops → last_nudge_result stays NULL.
    const neverAttempted = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "cold park" });
    const ids = repo.findUndelivered().map((s) => s.qitemId);
    expect(ids, "(a) the failed-nudge strand is surfaced").toContain(failed.qitemId);
    expect(ids, "(b) V1-only: a delivered row is NOT surfaced").not.toContain(delivered.qitemId);
    expect(ids, "(b) never-attempted (NULL) cold-park is NOT surfaced").not.toContain(neverAttempted.qitemId);
    // (c) the nudge-does-NOT-unwind invariant: DR-1 only READS — surfacing a strand must not mutate it.
    const after = repo.getById(failed.qitemId)!;
    expect(after.state, "(c) surfacing does not unwind/close the durable row").toBe("pending");
    expect(after.lastNudgeResult, "(c) the failure record is untouched by the read").toContain("failed:");
  });

  it("create rejects unknown rig when validateRig denies", async () => {
    const strictRepo = new QueueRepository(db, bus, {
      validateRig: (s) => s.endsWith("@known-rig"),
    });
    await expect(
      strictRepo.create({
        sourceSession: "alice@known-rig",
        destinationSession: "bob@phantom-rig",
        body: "x",
      })
    ).rejects.toThrow(/unknown rig/);
  });

  it("claim transitions pending → in-progress and computes closure_required_at from tier", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
      tier: "fast",
    });
    const claimed = repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(claimed.state).toBe("in-progress");
    expect(claimed.claimedAt).toBeTruthy();
    expect(claimed.closureRequiredAt).toBeTruthy();
    expect(captured.some((e) => e.type === "queue.claimed")).toBe(true);
  });

  it("claim rejects mismatched destination", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    expect(() => repo.claim({ qitemId: item.qitemId, destinationSession: "carol@rig" })).toThrow(
      /destination/
    );
  });

  it("R2: update emits queue.updated event with fromState + toState + closure metadata", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    captured.length = 0;
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "wrapping up",
    });
    const updateEvents = captured.filter((e) => e.type === "queue.updated");
    expect(updateEvents).toHaveLength(1);
    const evt = updateEvents[0]! as {
      qitemId: string;
      fromState: string;
      toState: string;
      closureReason: string | null;
      closureTarget: string | null;
      actorSession: string;
    };
    expect(evt.qitemId).toBe(item.qitemId);
    expect(evt.fromState).toBe("in-progress");
    expect(evt.toState).toBe("done");
    expect(evt.closureReason).toBe("no-follow-on");
    expect(evt.actorSession).toBe("bob@rig");
  });

  it("R2: update emits queue.updated for blocked transition (fromState=pending, toState=blocked)", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    captured.length = 0;
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "blocked",
      transitionNote: "blocked on dep",
    });
    const evt = captured.find((e) => e.type === "queue.updated") as { fromState: string; toState: string } | undefined;
    expect(evt).toBeDefined();
    expect(evt!.fromState).toBe("pending");
    expect(evt!.toState).toBe("blocked");
  });

  // 0.5.1-53 Atom 1b(i) — clear-on-exit. ROOT CAUSE: the update SET writes
  // `blocked_on = COALESCE(?, blocked_on)`, so exiting `blocked` (input.blockedOn=null)
  // PRESERVES the old blocker. A non-blocked row must NEVER carry a blocker — a stale
  // blocked_on is a dead-blocker strand (nothing audits it; the desk sat on one for hours).
  it("Atom 1b(i): exiting blocked CLEARS blocked_on (no stale dead-blocker)", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    // Park it on the blocker qitem.
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(item.qitemId)!.blockedOn).toBe(blocker.qitemId);
    // Exit blocked (unpark). RED at base: blocked_on still reads the blocker (COALESCE preserved it).
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "in-progress" });
    expect(repo.getById(item.qitemId)!.blockedOn, "a non-blocked row must not carry a blocker").toBeNull();
  });

  // 0.5.1-53 Atom 1b(ii) — validate-at-park. A park on a QITEM-reference blocker must name a real,
  // LIVE blocker; a nonexistent or terminal blocker is a dead-blocker park that can never self-clear
  // (the exact 21-22 day strands). Scoped to qitem-refs ("qitem-…"): human-seat blockers (member@rig)
  // and bare gate-names ("external-gate", handled by Atom 1a) are NOT validated here.
  it("Atom 1b(ii): parking on a NONEXISTENT qitem blocker is refused loud", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "qitem-19990101000000-deadbeef" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("blocker_not_found");
    }
  });

  it("Atom 1b(ii): parking on a TERMINAL (done) qitem blocker is refused loud", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    repo.claim({ qitemId: blocker.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: blocker.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("blocker_not_live");
    }
  });

  // 0.5.1-53 Atom 1b(iii) — propagate-completion. blocked_on PROMISES "A waits until B completes";
  // that promise never fired (the desk sat on a done blocker for hours). When B reaches a terminal
  // state, the rows blocked ON it must auto-unpark — the semantic blocked_on always owed.
  it("Atom 1b(iii): terminalizing a blocker auto-unparks the rows blocked on it", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(item.qitemId)!.state).toBe("blocked");
    // Complete the blocker.
    repo.claim({ qitemId: blocker.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: blocker.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    // RED at 1b(ii): the blocked row stays blocked forever (completion never propagated).
    const after = repo.getById(item.qitemId)!;
    expect(after.state, "a row blocked on a now-terminal blocker must auto-unpark").toBe("pending");
    expect(after.blockedOn, "auto-unpark clears the (now-resolved) blocker").toBeNull();
  });

  // 0.5.1-53 Atom 1a — typed non-qitem blocker contract. A park gated on a fold/auth/external
  // condition (not a qitem, not a human seat) is a first-class blocker: `fold:<what>` etc. It is
  // compact-visible (blocked_on is carried in the compact projection), settable at the PARK moment,
  // and the ruling detail rides a transition. A well-formed typed blocker is ACCEPTED; a malformed
  // one (a bare prefix with no gate body) is refused loud so a typo cannot masquerade as a gate.
  it("Atom 1a: a well-formed typed non-qitem blocker (fold:) is accepted and legible", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "gated work" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "fold:one-home+attestation" });
    const row = repo.getById(item.qitemId)!;
    expect(row.state).toBe("blocked");
    expect(row.blockedOn, "the typed gate is legible on the row (compact-carried)").toBe("fold:one-home+attestation");
  });

  it("Atom 1a: a malformed typed blocker (bare prefix, empty body) is refused loud", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "gated work" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "fold:" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("blocker_malformed");
    }
  });

  // 0.5.1-53 Atom 2a — supersession-cancel is an ADMITTED FORM. A row corrected by cancel-and-replace
  // must record that it was SUPERSEDED (reason=superseded + target=successor), not read as abandoned.
  // Today the closure-coherence whitelist admits reason/target only on done / park-record / handoff-close,
  // so state=canceled + a reason is refused (closure_fields_not_admitted) — which is exactly why a
  // superseded row is indistinguishable from an abandoned one (both closureReason=null).
  it("Atom 2a: a supersession-cancel (canceled + reason=superseded + target) is admitted and recorded", async () => {
    const successor = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "successor" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original" });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({
      qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled",
      closureReason: "superseded", closureTarget: successor.qitemId,
    });
    const row = repo.getById(item.qitemId)!;
    expect(row.state).toBe("canceled");
    expect(row.closureReason, "a superseded row records it (not null = distinguishable from abandoned)").toBe("superseded");
    expect(row.closureTarget).toBe(successor.qitemId);
  });

  it("Atom 2a: a plain cancel (no reason) stays abandoned — closureReason null", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "abandon me" });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled" });
    expect(repo.getById(item.qitemId)!.closureReason, "abandoned = no supersession reason").toBeNull();
  });

  it("Atom 2a: superseded WITHOUT a successor target is refused loud (no silent no-op)", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "orig" });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled", closureReason: "superseded" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("missing_closure_target");
    }
    // the loud rejection must NOT have half-applied: the row stays as it was (in-progress), not canceled.
    expect(repo.getById(item.qitemId)!.state, "a rejected close must not silently mutate the row").toBe("in-progress");
  });

  // 0.5.1-53 Atom 2b — the supersession back-link. A cancel-and-replace must NOT produce an unlinked
  // orphan pair: the successor records handedOffFrom = the original, so a reader can traverse from the
  // successor back to what it replaced (proof e). Combined with 2a's forward link (original.closureTarget
  // = successor), a supersession is fully traversable in both directions and never reads as abandonment.
  it("Atom 2b: a supersession successor records handedOffFrom = the original (both links present)", async () => {
    const original = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original (metadata wrong)" });
    const successor = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "corrected", handedOffFrom: original.qitemId });
    expect(successor.handedOffFrom, "successor -> original back-link").toBe(original.qitemId);
    // supersede the original toward the successor (2a forward link).
    repo.claim({ qitemId: original.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: original.qitemId, actorSession: "bob@rig", state: "canceled", closureReason: "superseded", closureTarget: successor.qitemId });
    const orig = repo.getById(original.qitemId)!;
    expect(orig.closureReason, "superseded, not abandoned").toBe("superseded");
    expect(orig.closureTarget, "original -> successor forward link").toBe(successor.qitemId);
    expect(repo.getById(successor.qitemId)!.handedOffFrom, "successor -> original back link").toBe(original.qitemId);
  });

  it("update state=done WITHOUT closure_reason rejected with missing_closure_reason", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "done" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      const e = err as QueueRepositoryError;
      expect(e.code).toBe("missing_closure_reason");
      expect((e.meta?.validReasons as readonly string[])).toEqual(CLOSURE_REASONS);
    }
  });

  it("update accepts each of the 6 valid closure reasons", async () => {
    for (const reason of CLOSURE_REASONS) {
      const item = await repo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: `for ${reason}`,
      });
      repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
      const requiresTarget = reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation";
      const closed = repo.update({
        qitemId: item.qitemId,
        actorSession: "bob@rig",
        state: "done",
        closureReason: reason,
        closureTarget: requiresTarget ? "downstream-target" : undefined,
      });
      expect(closed.state).toBe("done");
      expect(closed.closureReason).toBe(reason);
    }
  });

  it("handoff is transactional: closes source as handed-off + creates new qitem", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "do it",
    });
    const result = await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      transitionNote: "specialty needed",
    });
    expect(result.closed.state).toBe("handed-off");
    expect(result.closed.closureReason).toBe("handed_off_to");
    expect(result.closed.handedOffTo).toBe("carol@rig");
    expect(result.created.state).toBe("pending");
    expect(result.created.handedOffFrom).toBe(item.qitemId);
    expect(result.created.destinationSession).toBe("carol@rig");
    expect(result.created.chainOfRecord).toEqual([item.qitemId]);

    expect(captured.filter((e) => e.type === "queue.handed_off")).toHaveLength(1);
    expect(captured.filter((e) => e.type === "queue.created")).toHaveLength(2); // create + handoff-create
  });

  it("handoff refuses on already-terminal qitem", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    await expect(
      repo.handoff({
        qitemId: item.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
      })
    ).rejects.toThrow(/terminal/);
  });

  it("transitions are append-only — every state change adds a row", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.unclaim(item.qitemId, "bob@rig", "lunch");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    const transitions = repo.transitionLog.listForQitem(item.qitemId);
    expect(transitions.map((t) => t.state)).toEqual([
      "pending",
      "in-progress",
      "pending",
      "in-progress",
      "done",
    ]);
  });

  it("findOverdue surfaces in-progress qitems past closure_required_at", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
      tier: "fast",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    // Slice-15 contract: findOverdue takes an OPTIONS OBJECT (the shape the
    // runtime caller routes/queue.ts uses) — the old positional timestamp is
    // not a supported API (broad-suite-residue atom 1).
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const overdue = repo.findOverdue({ now: future });
    expect(overdue.map((q) => q.qitemId)).toContain(item.qitemId);
    // scoped/bounded discriminator: a rig scope that matches nothing returns
    // empty, and limit bounds the result — the options are honored, not ignored
    expect(repo.findOverdue({ now: future, rig: "no-such-rig" })).toEqual([]);
    expect(repo.findOverdue({ now: future, limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it("routeToFallback emits qitem.fallback_routed and rewrites destination", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const rerouted = repo.routeToFallback(item.qitemId, "pod-fallback@rig", "seat-unreachable");
    expect(rerouted.destinationSession).toBe("pod-fallback@rig");
    expect(rerouted.chainOfRecord).toEqual(["fallback-from:bob@rig"]);
    expect(captured.some((e) => e.type === "qitem.fallback_routed")).toBe(true);
  });

  it("list filters by destination + state", async () => {
    const a = await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
    await repo.create({ sourceSession: "x@r", destinationSession: "carol@r", body: "2" });
    await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "3" });
    repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });

    expect(repo.list({ destinationSession: "bob@r" })).toHaveLength(2);
    expect(repo.list({ destinationSession: "bob@r", state: "in-progress" })).toHaveLength(1);
    expect(repo.list({ destinationSession: "bob@r", state: ["pending", "in-progress"] })).toHaveLength(2);
  });

  // ---- PL-004 Phase A revision (R1) tests ----

  describe("R1 default-nudge wiring", () => {
    it("create nudges destination by default and persists last_nudge_attempt + last_nudge_result", async () => {
      const sends: Array<{ session: string; text: string }> = [];
      const stubTransport = {
        send: async (sessionName: string, text: string) => {
          sends.push({ session: sessionName, text });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "ping me",
      });
      expect(sends).toHaveLength(1);
      expect(sends[0]!.session).toBe("bob@rig");
      expect(sends[0]!.text).toContain(item.qitemId);
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeAttempt).not.toBeNull();
      expect(fresh.lastNudgeResult).toBe("verified");
    });

    it("(h) HG-5 baseline: the handoff nudge now carries a Sent: stamp + the source's gen suffix, and threads stampISO to send", async () => {
      const sends: Array<{ session: string; text: string; opts?: { verify?: boolean; stampISO?: string } }> = [];
      const stubTransport = {
        send: async (session: string, text: string, opts?: { verify?: boolean; stampISO?: string }) => {
          sends.push({ session, text, opts });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, {
        transport: stubTransport,
        resolveOccupantGeneration: (s) => (s === "alice@rig" ? "a1b2c3d4-e5f6-7890-abcd-ef0123456789" : null),
      });
      await nudgingRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "ping" });
      expect(sends).toHaveLength(1);
      const { text, opts } = sends[0]!;
      expect(text).toContain("\nSent: "); // now stamped (was absent — the deferred HG-5 change lands here)
      expect(text).toContain(" · gen a1b2c3d4"); // the source seat's generation rides g's render
      expect(opts?.stampISO).toBeDefined(); // threaded so the transport's delivered-latency flag works
    });

    it("(h) absent resolver ⇒ the nudge stamps but OMITS the gen suffix (UNKNOWN, never forged)", async () => {
      const sends: string[] = [];
      const stubTransport = {
        send: async (_s: string, text: string) => { sends.push(text); return { ok: true, verified: true }; },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport }); // no resolver wired
      await nudgingRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "ping" });
      expect(sends[0]).toContain("\nSent: ");
      expect(sends[0]).not.toContain(" · gen ");
    });

    it("create with nudge:false does NOT call transport (cold-queue opt-out)", async () => {
      const sends: Array<{ session: string; text: string }> = [];
      const stubTransport = {
        send: async (sessionName: string, text: string) => {
          sends.push({ session: sessionName, text });
          return { ok: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "cold",
        nudge: false,
      });
      expect(sends).toHaveLength(0);
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeAttempt).toBeNull();
      expect(fresh.lastNudgeResult).toBeNull();
    });

    it("nudge failure is recorded as failed:<reason>; create still succeeds", async () => {
      const stubTransport = {
        send: async () => ({ ok: false, error: "tmux pane not found" }),
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "x",
      });
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeResult).toMatch(/^failed:/);
      // Item itself created normally — nudge failures don't unwind the create.
      expect(fresh.state).toBe("pending");
    });

    // OPR.0.3.2.21.FR-4(c) — wording rename for the delivered-but-ack-expired
    // case. Prior literal "sent-unverified" read as a partial-failure even
    // when the underlying delivery was fine; "delivered-ack-pending" reads
    // as the healthy-and-expected case (codex seats mid-task commonly miss
    // the synchronous ack window).
    it("ok-but-unverified nudge records lastNudgeResult as 'delivered-ack-pending' (was 'sent-unverified')", async () => {
      const stubTransport = {
        send: async () => ({ ok: true, verified: false }),
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "delivered but ack window expired",
      });
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeResult).toBe("delivered-ack-pending");
      // Discriminator: the old wording must NOT appear anywhere on
      // the freshly-read row (proves the literal was renamed end-to-end,
      // not just shadowed).
      expect(fresh.lastNudgeResult).not.toBe("sent-unverified");
    });

    it("handoff nudges new destination by default", async () => {
      const sends: Array<{ session: string }> = [];
      const stubTransport = {
        send: async (sessionName: string) => {
          sends.push({ session: sessionName });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      nudgingRepo.attachOutbox(new OutboxHandler(db)); // W1 MF2: handoff needs a wake-intent store
      const original = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "x",
        nudge: false, // suppress create-time nudge so we count only handoff
      });
      const result = await nudgingRepo.handoff({
        qitemId: original.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
      });
      expect(sends).toHaveLength(1);
      expect(sends[0]!.session).toBe("carol@rig");
      const fresh = nudgingRepo.getById(result.created.qitemId)!;
      expect(fresh.lastNudgeResult).toBe("verified");
    });

    it("attachTransport() works after construction (post-hoc wiring path)", async () => {
      const repoNoTransport = new QueueRepository(db, bus);
      const sends: Array<{ session: string }> = [];
      const stubTransport = {
        send: async (s: string) => { sends.push({ session: s }); return { ok: true, verified: true }; },
      };
      // First create: no transport, no nudge
      await repoNoTransport.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "before",
      });
      expect(sends).toHaveLength(0);
      // Attach + create again
      repoNoTransport.attachTransport(stubTransport);
      await repoNoTransport.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "after",
      });
      expect(sends).toHaveLength(1);
    });
  });

  describe("R1 handoff-and-complete", () => {
    it("closes source as state=done with closure_reason=handed_off_to (terminal) and creates new qitem", async () => {
      const original = await repo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "review then route",
      });
      const result = await repo.handoffAndComplete({
        qitemId: original.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
        body: "carol's follow-on",
      });
      expect(result.closed.state).toBe("done"); // not "handed-off"
      expect(result.closed.closureReason).toBe("handed_off_to");
      expect(result.closed.handedOffTo).toBe("carol@rig");
      expect(result.created.state).toBe("pending");
      expect(result.created.handedOffFrom).toBe(original.qitemId);
      expect(result.created.destinationSession).toBe("carol@rig");
      expect(result.created.body).toBe("carol's follow-on");
      expect(result.created.chainOfRecord).toEqual([original.qitemId]);
    });

    it("refuses on already-terminal qitem", async () => {
      const item = await repo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "x",
      });
      repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
      repo.update({
        qitemId: item.qitemId,
        actorSession: "bob@rig",
        state: "done",
        closureReason: "no-follow-on",
      });
      await expect(
        repo.handoffAndComplete({
          qitemId: item.qitemId,
          fromSession: "bob@rig",
          toSession: "carol@rig",
        })
      ).rejects.toThrow(/terminal/);
    });

    it("respects validateRig (rejects unknown destination rig)", async () => {
      const strictRepo = new QueueRepository(db, bus, {
        validateRig: (s) => s.endsWith("@known-rig"),
      });
      const original = await strictRepo.create({
        sourceSession: "alice@known-rig",
        destinationSession: "bob@known-rig",
        body: "x",
      });
      await expect(
        strictRepo.handoffAndComplete({
          qitemId: original.qitemId,
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        })
      ).rejects.toThrow(/unknown rig/);
    });
  });

  describe("R1 whoami", () => {
    it("returns counts + recent active qitems for the destination session", async () => {
      const a = await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
      await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "2" });
      await repo.create({ sourceSession: "x@r", destinationSession: "carol@r", body: "3" });
      repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });
      const whoami = repo.whoami("bob@r");
      expect(whoami.session).toBe("bob@r");
      expect(whoami.asDestination.pending).toBe(1);
      expect(whoami.asDestination.inProgress).toBe(1);
      expect(whoami.asDestination.recent).toHaveLength(2);
    });

    it("recent excludes terminal-state qitems", async () => {
      const a = await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
      repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });
      repo.update({ qitemId: a.qitemId, actorSession: "bob@r", state: "done", closureReason: "no-follow-on" });
      const whoami = repo.whoami("bob@r");
      expect(whoami.asDestination.pending).toBe(0);
      expect(whoami.asDestination.inProgress).toBe(0);
      expect(whoami.asDestination.recent).toHaveLength(0);
    });

    it("asSource.total counts all source-side qitems regardless of state", async () => {
      await repo.create({ sourceSession: "alice@r", destinationSession: "bob@r", body: "1" });
      await repo.create({ sourceSession: "alice@r", destinationSession: "carol@r", body: "2" });
      const item = await repo.create({ sourceSession: "alice@r", destinationSession: "dan@r", body: "3" });
      repo.claim({ qitemId: item.qitemId, destinationSession: "dan@r" });
      repo.update({ qitemId: item.qitemId, actorSession: "dan@r", state: "done", closureReason: "no-follow-on" });
      const whoami = repo.whoami("alice@r");
      expect(whoami.asSource.total).toBe(3);
    });
  });
});

describe("QueueRepository summary column (OPR.0.4.1.18)", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    // Includes migration 044 so the summary column exists. (The main suite
    // deliberately omits it, proving the pre-044 degrade path via the guard.)
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  it("persists --summary on create and round-trips it through getById", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "agent-speak body that is long and detailed",
      summary: "Wire the dashboard version row to the real daemon version.",
      nudge: false,
    });
    expect(item.summary).toBe("Wire the dashboard version row to the real daemon version.");
    expect(repo.getById(item.qitemId)?.summary).toBe(
      "Wire the dashboard version row to the real daemon version."
    );
  });

  it("summary is null when --summary is omitted (degrade contract)", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "no summary here",
      nudge: false,
    });
    expect(item.summary).toBeNull();
    expect(repo.getById(item.qitemId)?.summary).toBeNull();
  });

  it("handoff persists the new qitem's own summary, not inherited from source", async () => {
    const src = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "source body",
      summary: "Source summary.",
      nudge: false,
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      summary: "Handoff summary for the new owner.",
      nudge: false,
    });
    expect(result.created.summary).toBe("Handoff summary for the new owner.");
    // Omitted on the next handoff → null (degrade), NOT inherited from source.
    const result2 = await repo.handoff({
      qitemId: result.created.qitemId,
      fromSession: "carol@rig",
      toSession: "dan@rig",
      nudge: false,
    });
    expect(result2.created.summary).toBeNull();
  });
});

describe("queue.* event payloads carry summary (OPR.0.4.4.19 FR-1)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  const eventOf = (type: string) =>
    captured.find((e) => e.type === type) as Record<string, unknown> | undefined;

  it("queue.created carries the provided summary", async () => {
    await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "body",
      summary: "Approve the 0.4.4 cut",
      nudge: false,
    });
    const ev = eventOf("queue.created");
    expect(ev).toBeDefined();
    expect(ev!.summary).toBe("Approve the 0.4.4 cut");
  });

  it("every queue.* event carries summary: null when omitted — present, never absent", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "no summary",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.unclaim(item.qitemId, "bob@rig", "requeue");
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "in-progress",
    });
    await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      nudge: false,
    });
    for (const type of [
      "queue.created",
      "queue.claimed",
      "queue.unclaimed",
      "queue.updated",
      "queue.handed_off",
    ]) {
      const ev = eventOf(type);
      expect(ev, `${type} emitted`).toBeDefined();
      expect("summary" in ev!, `${type} payload has summary key`).toBe(true);
      expect(ev!.summary, `${type} summary is null`).toBeNull();
    }
  });

  it("claim/unclaim/updated events carry the row's persisted summary; handed_off carries the SOURCE summary and the handoff's queue.created carries the NEW summary", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "body",
      summary: "Source summary.",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(eventOf("queue.claimed")!.summary).toBe("Source summary.");
    repo.unclaim(item.qitemId, "bob@rig", "requeue");
    expect(eventOf("queue.unclaimed")!.summary).toBe("Source summary.");
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "in-progress" });
    expect(eventOf("queue.updated")!.summary).toBe("Source summary.");
    captured.length = 0;
    await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      summary: "New owner summary.",
      nudge: false,
    });
    expect(eventOf("queue.handed_off")!.summary).toBe("Source summary.");
    expect(eventOf("queue.created")!.summary).toBe("New owner summary.");
  });

  it("legacy pre-044 schema (no summary column): events still carry summary key with null", async () => {
    const legacyDb = createDb();
    migrate(legacyDb, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    const legacyBus = new EventBus(legacyDb);
    const legacyRepo = new QueueRepository(legacyDb, legacyBus);
    const legacyCaptured: PersistedEvent[] = [];
    legacyBus.subscribe((e) => legacyCaptured.push(e));
    await legacyRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "legacy",
      nudge: false,
    });
    const ev = legacyCaptured.find((e) => e.type === "queue.created") as Record<string, unknown>;
    expect("summary" in ev).toBe(true);
    expect(ev.summary).toBeNull();
    legacyDb.close();
  });
});

describe("queue_items.evidence_ref column (OPR.0.4.4.19 FR-5 storage)", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  it("persists --evidence-ref on create and round-trips it through getById", async () => {
    const item = await repo.create({
      sourceSession: "pm@rig",
      destinationSession: "human-review@kernel",
      body: "please judge",
      summary: "Approve the 0.4.4 cut",
      evidenceRef: "missions/release-0.4.4/slices/19/PROOF.md",
      nudge: false,
    });
    expect(item.evidenceRef).toBe("missions/release-0.4.4/slices/19/PROOF.md");
    expect(repo.getById(item.qitemId)?.evidenceRef).toBe("missions/release-0.4.4/slices/19/PROOF.md");
  });

  it("evidence_ref is null when omitted (BR-1: ordinary items never require it)", async () => {
    const item = await repo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "ordinary agent-to-agent work",
      nudge: false,
    });
    expect(item.evidenceRef).toBeNull();
  });

  it("handoff authors its OWN evidence_ref; not inherited from source (summary semantics)", async () => {
    const src = await repo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "src",
      evidenceRef: "proof/source.md",
      nudge: false,
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@rig",
      toSession: "c@rig",
      nudge: false,
    });
    expect(result.created.evidenceRef).toBeNull();
    const result2 = await repo.handoff({
      qitemId: result.created.qitemId,
      fromSession: "c@rig",
      toSession: "d@rig",
      evidenceRef: "proof/new.md",
      nudge: false,
    });
    expect(result2.created.evidenceRef).toBe("proof/new.md");
  });

  it("listAttention JSON carries evidence_ref for human-routed items (FR-5 read-path AC)", async () => {
    await repo.create({
      sourceSession: "pm@rig",
      destinationSession: "human-review@kernel",
      body: "judge me",
      summary: "s",
      evidenceRef: "proof/PROOF.md",
      nudge: false,
    });
    const attention = repo.listAttention();
    expect(attention).toHaveLength(1);
    expect(attention[0]!.evidenceRef).toBe("proof/PROOF.md");
  });

  it("legacy pre-048 schema: evidenceRef input degrades silently; reads are null", async () => {
    const legacyDb = createDb();
    migrate(legacyDb, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    const legacyRepo = new QueueRepository(legacyDb, new EventBus(legacyDb));
    const item = await legacyRepo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "legacy",
      evidenceRef: "proof/x.md",
      nudge: false,
    });
    expect(item.evidenceRef).toBeNull();
    legacyDb.close();
  });
});

// ── GHOST-STAGE (e/Class-B): queue_items generation stamps + release-to-pending at swap ──
describe("QueueRepository — generation stamps (Class-B)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let genBySession: Map<string, string | null>;

  beforeEach(() => {
    db = createDb();
    // 063 ALTERs BOTH queue_items + watchdog_jobs (one migration), so watchdog_jobs must exist too.
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, watchdogJobsSchema, occupantGenerationStampsSchema]);
    bus = new EventBus(db);
    genBySession = new Map();
    repo = new QueueRepository(db, bus, { resolveOccupantGeneration: (s) => genBySession.get(s) ?? null });
  });
  afterEach(() => db.close());

  const col = (qitemId: string, name: string): string | null =>
    (db.prepare(`SELECT ${name} AS v FROM queue_items WHERE qitem_id = ?`).get(qitemId) as { v: string | null }).v;

  it("stamps minting_generation_uuid from the SOURCE occupant at create", async () => {
    genBySession.set("alice@rig", "gen-src");
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    expect(col(item.qitemId, "minting_generation_uuid")).toBe("gen-src");
  });

  it("stamps claimed_by_generation_uuid from the CLAIMANT at claim, and clears it on unclaim", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-claimant");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(col(item.qitemId, "claimed_by_generation_uuid")).toBe("gen-claimant");
    repo.unclaim(item.qitemId, "bob@rig", "stepping away");
    expect(col(item.qitemId, "claimed_by_generation_uuid")).toBeNull();
  });

  it("RELEASES retired-gen in-progress items to pending (never drops), clears the claim, and audits", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-retired");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });

    const released = repo.releaseClaimsByGeneration("gen-retired");
    expect(released).toBe(1);
    const after = repo.getById(item.qitemId)!;
    expect(after.state).toBe("pending"); // RELEASED, not dropped — the item survives
    expect(col(item.qitemId, "claimed_by_generation_uuid")).toBeNull();
    const notes = repo.transitionLog.listForQitem(item.qitemId).map((t) => t.transitionNote ?? "");
    expect(notes.some((n) => /claimant generation retired/.test(n))).toBe(true);
  });

  it("does NOT release the SUCCESSOR's own claim (same seat name, live gen) — gen-scoped, not name-scoped", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-live"); // the successor claims under the SAME name, a new generation
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(repo.releaseClaimsByGeneration("gen-retired")).toBe(0);
    expect(repo.getById(item.qitemId)!.state).toBe("in-progress"); // untouched
  });

  it("an empty generation is a no-op (never a catch-all release)", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-1");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(repo.releaseClaimsByGeneration("")).toBe(0);
    expect(repo.getById(item.qitemId)!.state).toBe("in-progress");
  });

  it("a PENDING (never-claimed) item is never released — claimed_by is NULL (UNKNOWN != retired)", async () => {
    const pending = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "y" });
    genBySession.set("bob@rig", "gen-retired");
    expect(repo.releaseClaimsByGeneration("gen-retired")).toBe(0);
    expect(repo.getById(pending.qitemId)!.state).toBe("pending");
  });
});
