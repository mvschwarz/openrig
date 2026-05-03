import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { EventBus } from "../src/domain/event-bus.js";
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
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("create stamps qitem_id + transition + queue.created event", () => {
    const item = repo.create({
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

  it("create rejects unknown rig when validateRig denies", () => {
    const strictRepo = new QueueRepository(db, bus, {
      validateRig: (s) => s.endsWith("@known-rig"),
    });
    expect(() =>
      strictRepo.create({
        sourceSession: "alice@known-rig",
        destinationSession: "bob@phantom-rig",
        body: "x",
      })
    ).toThrow(/unknown rig/);
  });

  it("claim transitions pending → in-progress and computes closure_required_at from tier", () => {
    const item = repo.create({
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

  it("claim rejects mismatched destination", () => {
    const item = repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    expect(() => repo.claim({ qitemId: item.qitemId, destinationSession: "carol@rig" })).toThrow(
      /destination/
    );
  });

  it("update state=done WITHOUT closure_reason rejected with missing_closure_reason", () => {
    const item = repo.create({
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

  it("update accepts each of the 6 valid closure reasons", () => {
    for (const reason of CLOSURE_REASONS) {
      const item = repo.create({
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

  it("handoff is transactional: closes source as handed-off + creates new qitem", () => {
    const item = repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "do it",
    });
    const result = repo.handoff({
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

  it("handoff refuses on already-terminal qitem", () => {
    const item = repo.create({
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
    expect(() =>
      repo.handoff({
        qitemId: item.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
      })
    ).toThrow(/terminal/);
  });

  it("transitions are append-only — every state change adds a row", () => {
    const item = repo.create({
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

  it("findOverdue surfaces in-progress qitems past closure_required_at", () => {
    const item = repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
      tier: "fast",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const overdue = repo.findOverdue(future);
    expect(overdue.map((q) => q.qitemId)).toContain(item.qitemId);
  });

  it("routeToFallback emits qitem.fallback_routed and rewrites destination", () => {
    const item = repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const rerouted = repo.routeToFallback(item.qitemId, "pod-fallback@rig", "seat-unreachable");
    expect(rerouted.destinationSession).toBe("pod-fallback@rig");
    expect(rerouted.chainOfRecord).toEqual(["fallback-from:bob@rig"]);
    expect(captured.some((e) => e.type === "qitem.fallback_routed")).toBe(true);
  });

  it("list filters by destination + state", () => {
    const a = repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
    repo.create({ sourceSession: "x@r", destinationSession: "carol@r", body: "2" });
    repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "3" });
    repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });

    expect(repo.list({ destinationSession: "bob@r" })).toHaveLength(2);
    expect(repo.list({ destinationSession: "bob@r", state: "in-progress" })).toHaveLength(1);
    expect(repo.list({ destinationSession: "bob@r", state: ["pending", "in-progress"] })).toHaveLength(2);
  });
});
