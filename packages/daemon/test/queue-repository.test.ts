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
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const overdue = repo.findOverdue(future);
    expect(overdue.map((q) => q.qitemId)).toContain(item.qitemId);
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

    it("handoff nudges new destination by default", async () => {
      const sends: Array<{ session: string }> = [];
      const stubTransport = {
        send: async (sessionName: string) => {
          sends.push({ session: sessionName });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
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
