// OPR.0.4.4.19 FR-4/FR-5 — human-route enforcement (conventions C6 + C3).
//
// The §5 scoping predicate is the COMPLETE trigger list (BR-1): tier
// human-gate OR human-seat destination (the park leg is validated at the
// blocked-transition path, FR-6). Everything off the predicate is untouched.

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
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import {
  isHumanSeatSession,
  validateHumanRoute,
} from "../src/domain/human-route-enforcer.js";

describe("human-route-enforcer (pure validator)", () => {
  it("§5 predicate leg 1: tier=human-gate is human-routed", () => {
    const r = validateHumanRoute({ tier: "human-gate", destinationSession: "b@rig", summary: "s", evidenceRef: "e" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.humanRouted).toBe(true);
  });

  it("§5 predicate leg 2: human-seat destination is human-routed (strict regex)", () => {
    expect(isHumanSeatSession("human@kernel")).toBe(true);
    expect(isHumanSeatSession("human@host")).toBe(true);
    expect(isHumanSeatSession("human-review@kernel")).toBe(true);
    // malformed / near-miss sessions are NOT human seats (no LIKE superset):
    expect(isHumanSeatSession("human-@kernel")).toBe(false);
    expect(isHumanSeatSession("human-ish@other-rig")).toBe(false);
    expect(isHumanSeatSession("superhuman@kernel")).toBe(false);
    expect(isHumanSeatSession(null)).toBe(false);
  });

  it("human-routed with both fields missing → error naming BOTH fields + why", () => {
    const r = validateHumanRoute({ tier: "human-gate", destinationSession: "b@rig", summary: null, evidenceRef: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("human_route_fields_required");
      expect(r.missingFields).toEqual(["summary", "evidence_ref"]);
      expect(r.message).toContain("plain language");
      expect(r.message).toContain("judge");
    }
  });

  it("whitespace-only values count as missing", () => {
    const r = validateHumanRoute({ tier: null, destinationSession: "human@kernel", summary: "   ", evidenceRef: "\t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toEqual(["summary", "evidence_ref"]);
  });

  it("BR-1: non-human-routed request validates NOTHING (ok regardless of fields)", () => {
    const r = validateHumanRoute({ tier: "critical", destinationSession: "guard@rig", summary: null, evidenceRef: null });
    expect(r).toEqual({ ok: true, humanRouted: false });
  });
});

describe("QueueRepository human-route enforcement wiring (FR-4/FR-5)", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  const ordinary = { sourceSession: "a@rig", destinationSession: "b@rig", body: "work", nudge: false as const };

  it("create to a human seat without summary/evidence_ref is REJECTED with the structured error", async () => {
    await expect(
      repo.create({ sourceSession: "pm@rig", destinationSession: "human-review@kernel", body: "judge", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  it("create with tier=human-gate without the fields is REJECTED", async () => {
    await expect(
      repo.create({ ...ordinary, tier: "human-gate" })
    ).rejects.toThrow(QueueRepositoryError);
  });

  it("human-routed create WITH both fields is accepted and persists them", async () => {
    const item = await repo.create({
      sourceSession: "pm@rig",
      destinationSession: "human-review@kernel",
      body: "judge",
      summary: "Approve the 0.4.4 cut",
      evidenceRef: "missions/x/PROOF.md",
      nudge: false,
    });
    expect(item.summary).toBe("Approve the 0.4.4 cut");
    expect(item.evidenceRef).toBe("missions/x/PROOF.md");
  });

  it("handoff to a human seat requires the NEW item's own fields (never inherited)", async () => {
    const src = await repo.create({
      ...ordinary,
      summary: "source summary",
      evidenceRef: "proof/source.md",
    });
    // Source HAS both fields; the handoff omits them → still rejected.
    await expect(
      repo.handoff({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "human-review@kernel", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
    // Providing them on the handoff itself succeeds.
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@rig",
      toSession: "human-review@kernel",
      summary: "Please ratify",
      evidenceRef: "proof/final.md",
      nudge: false,
    });
    expect(result.created.summary).toBe("Please ratify");
    expect(result.created.evidenceRef).toBe("proof/final.md");
  });

  it("handoff inheriting human-gate TIER from the source also triggers enforcement", async () => {
    const src = await repo.create({
      ...ordinary,
      tier: "human-gate",
      summary: "s",
      evidenceRef: "e.md",
    });
    // No tier override on the handoff → new item inherits human-gate → enforcement.
    await expect(
      repo.handoff({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "c@rig", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  it("handoffAndComplete to a human seat is enforced identically", async () => {
    const src = await repo.create(ordinary);
    await expect(
      repo.handoffAndComplete({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "human@kernel", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  // ——— BR-1 zero-friction negatives (the guard's verification targets) ———

  it("NEGATIVE: ordinary create without summary/evidence_ref is accepted exactly as before", async () => {
    const item = await repo.create(ordinary);
    expect(item.state).toBe("pending");
    expect(item.summary).toBeNull();
    expect(item.evidenceRef).toBeNull();
  });

  it("NEGATIVE: ordinary handoff without the fields is accepted; no new rejection path", async () => {
    const src = await repo.create(ordinary);
    const result = await repo.handoff({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "c@rig", nudge: false });
    expect(result.created.state).toBe("pending");
    expect(result.created.summary).toBeNull();
    expect(result.created.evidenceRef).toBeNull();
  });

  it("NEGATIVE: ordinary update/close paths gain no new requirement (closure contract unchanged)", async () => {
    const item = await repo.create(ordinary);
    repo.claim({ qitemId: item.qitemId, destinationSession: "b@rig" });
    const done = repo.update({
      qitemId: item.qitemId,
      actorSession: "b@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(done.state).toBe("done");
  });

  it("NEGATIVE: near-miss destinations (regex non-matches) are NOT enforced", async () => {
    const item = await repo.create({ ...ordinary, destinationSession: "human-ish@other-rig" });
    expect(item.state).toBe("pending");
    const item2 = await repo.create({ ...ordinary, destinationSession: "human-@kernel" });
    expect(item2.state).toBe("pending");
  });
});

describe("FR-6 park-on-human (leg-1) — enforcement + persistence + attention", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  async function inProgressItem() {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "driver@rig",
      body: "build the thing",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "driver@rig" });
    return item;
  }

  it("park on a human seat WITH park-time summary + evidence_ref succeeds, keeps ownership, requires no closure_reason, and PERSISTS both fields", async () => {
    const item = await inProgressItem();
    const parked = repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "Which hook-trust timing rule should ship?",
      evidenceRef: "missions/x/slices/y/OPTIONS.md",
    });
    expect(parked.state).toBe("blocked");
    expect(parked.destinationSession).toBe("driver@rig"); // owner keeps the potato
    expect(parked.closureReason).toBeNull();              // non-terminal
    const read = repo.getById(item.qitemId)!;
    expect(read.summary).toBe("Which hook-trust timing rule should ship?");
    expect(read.evidenceRef).toBe("missions/x/slices/y/OPTIONS.md");
  });

  it("park on a human seat WITHOUT summary/evidence_ref is rejected naming both fields", async () => {
    const item = await inProgressItem();
    expect(() =>
      repo.update({
        qitemId: item.qitemId,
        actorSession: "driver@rig",
        state: "blocked",
        blockedOn: "human-review@kernel",
      })
    ).toThrow(/summary \+ evidence_ref|summary/);
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "driver@rig", state: "blocked", blockedOn: "human-review@kernel" });
    } catch (err) {
      expect((err as QueueRepositoryError).code).toBe("human_route_fields_required");
      expect((err as QueueRepositoryError).meta?.missingFields).toEqual(["summary", "evidence_ref"]);
    }
  });

  it("an item already carrying both fields parks without re-entry (effective-value rule)", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "driver@rig",
      body: "b",
      summary: "carried from create",
      evidenceRef: "proof/carried.md",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "driver@rig" });
    const parked = repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human@kernel",
    });
    expect(parked.state).toBe("blocked");
  });

  it("parked-on-human items are returned by the attention query (3rd predicate leg)", async () => {
    const item = await inProgressItem();
    repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "decision owed",
      evidenceRef: "proof/x.md",
    });
    const attention = repo.listAttention();
    expect(attention.map((q) => q.qitemId)).toContain(item.qitemId);
  });

  it("NEGATIVE: blocked on another QITEM requires nothing new and does NOT appear in attention", async () => {
    const blocker = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "blocker", nudge: false });
    const item = await inProgressItem();
    const parked = repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
    });
    expect(parked.state).toBe("blocked");
    const attention = repo.listAttention();
    expect(attention.map((q) => q.qitemId)).not.toContain(item.qitemId);
  });

  it("queue.updated event carries the park-time summary (FR-1 x FR-6, the P2 refresh contract)", async () => {
    const bus = new EventBus(db);
    const repo2 = new QueueRepository(db, bus);
    const captured: Array<Record<string, unknown>> = [];
    bus.subscribe((e) => captured.push(e as unknown as Record<string, unknown>));
    const item = await repo2.create({ sourceSession: "a@rig", destinationSession: "d@rig", body: "b", nudge: false });
    repo2.update({
      qitemId: item.qitemId,
      actorSession: "d@rig",
      state: "blocked",
      blockedOn: "human@kernel",
      summary: "park-time summary",
      evidenceRef: "proof/p.md",
    });
    const ev = captured.find((e) => e.type === "queue.updated");
    expect(ev).toBeDefined();
    expect(ev!.summary).toBe("park-time summary");
    expect(ev!.toState).toBe("blocked");
  });

  // OPR.0.5.1 slice-51-06 D2: non-park summary/evidence used to be SILENTLY dropped (a data-loss
  // trap); it is now a HARD REJECT before any mutation. The surface still stays tight (nothing
  // persists on a non-park item) — now enforced loudly instead of silently.
  it("NEGATIVE: non-park updates REJECT summary/evidence_ref inputs (surface stays tight, loudly)", async () => {
    const item = await inProgressItem();
    let err: unknown;
    try {
      repo.update({
        qitemId: item.qitemId,
        actorSession: "driver@rig",
        state: "in-progress",
        summary: "should NOT persist",
        evidenceRef: "should-not-persist.md",
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("summary_evidence_not_persistable");
    expect((err as QueueRepositoryError).meta?.invalidFields).toEqual(["summary", "evidenceRef"]);
    const read = repo.getById(item.qitemId)!;
    expect(read.summary).toBeNull(); // nothing persisted (reject was before any write)
    expect(read.evidenceRef).toBeNull();
  });
});
