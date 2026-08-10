import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("W2b exact-set notify envelope", () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    bus = new EventBus(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function persisted(label: string) {
    return bus.persistWithinTransaction({
      type: "view.changed",
      viewName: label,
      cause: "w2b-test",
    });
  }

  it("registers inertly while the transaction is open, then delivers after commit in seq order", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => {
      expect(db.inTransaction).toBe(false);
      received.push(event);
    });

    bus.withNotifyEnvelope((register) => {
      const first = persisted("first");
      register(first);
      expect(received).toEqual([]);
      const second = persisted("second");
      register(second);
      expect(received).toEqual([]);
    });

    expect(received.map((event) => event.seq)).toEqual([
      received[0]!.seq,
      received[1]!.seq,
    ]);
    expect(received[0]!.seq).toBeLessThan(received[1]!.seq);
    expect(received.map((event) => event.type)).toEqual(["view.changed", "view.changed"]);
  });

  it.each([
    [
      "overwritten result",
      () => {
        let token = persisted("overwritten-a");
        token = persisted("overwritten-b");
        return [token];
      },
    ],
    [
      "switch-gated collection",
      () => {
        const token = persisted("switch");
        const registered: ReturnType<typeof persisted>[] = [];
        switch ("other") {
          case "register":
            registered.push(token);
            break;
        }
        return registered;
      },
    ],
    [
      "loop continue bypass",
      () => {
        const registered: ReturnType<typeof persisted>[] = [];
        for (const label of ["skip", "keep"]) {
          const token = persisted(label);
          if (label === "skip") continue;
          registered.push(token);
        }
        return registered;
      },
    ],
    [
      "wider initializer transform",
      () => {
        const registered = [persisted("initializer-a"), persisted("initializer-b")]
          .filter((token) => token.type === "view.changed")
          .slice(1);
        return registered;
      },
    ],
  ])("rejects the %s discriminator by effect", (_name, build) => {
    expect(() =>
      bus.withNotifyEnvelope((register) => {
        for (const token of build()) register(token);
      }),
    ).toThrow(/notify envelope.*persisted.*registered/i);

    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("compares exact token identity, not cardinality", () => {
    expect(() =>
      bus.withNotifyEnvelope((register) => {
        const dropped = persisted("dropped");
        const duplicated = persisted("duplicated");
        void dropped;
        register(duplicated);
        register(duplicated);
      }),
    ).toThrow(/notify envelope.*persisted.*registered/i);

    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("preserves the current miss as a rollback-producing validation failure", async () => {
    const queueRepo = new QueueRepository(db, bus);
    const item = await queueRepo.create({
      sourceSession: "source@w2b-rig",
      destinationSession: "owner@w2b-rig",
      body: "current miss",
      nudge: false,
    });

    expect(() =>
      bus.withNotifyEnvelope(() => {
        queueRepo.updateWithinTransaction({
          qitemId: item.qitemId,
          actorSession: "owner@w2b-rig",
          state: "in-progress",
          transitionNote: "intentionally omitted registration",
        });
      }),
    ).toThrow(/notify envelope.*persisted.*registered/i);

    expect(queueRepo.getById(item.qitemId)?.state).toBe("pending");
  });

  it("accepts a canonical registration loop and a zero-event transaction", () => {
    expect(() => bus.withNotifyEnvelope(() => undefined)).not.toThrow();

    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.withNotifyEnvelope((register) => {
      const tokens = [persisted("a"), persisted("b")];
      for (const token of tokens) register(token);
    });

    expect(received.map((event) => (event as { viewName?: string }).viewName)).toEqual(["a", "b"]);
  });

  it("fails a validation that examined zero envelope transactions", () => {
    expect(() => bus.assertNotifyEnvelopeExercised()).toThrow(/zero notify envelope transactions/i);
    bus.withNotifyEnvelope(() => undefined);
    expect(() => bus.assertNotifyEnvelopeExercised()).not.toThrow();
  });

  it("records malformed rows durably, advances the watermark, and reports unparseable", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    let malformedSeq = 0;

    bus.withNotifyEnvelope(() => {
      malformedSeq = Number(
        db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
          .run(null, null, "malformed.fixture", "{not-json")
          .lastInsertRowid,
      );
    });

    const status = bus.getNotifyDrainStatus();
    expect(status.state).toBe("unparseable");
    expect(status.watermark).toBeGreaterThanOrEqual(malformedSeq);
    expect(status.lastPoison).toMatchObject({ seq: malformedSeq });
    expect(status.lastPoison?.payloadSha).toMatch(/^[a-f0-9]{64}$/);
    expect(status.lastPoison?.error).toBe("invalid event payload JSON");
    expect(received.some((event) => event.type === "malformed.fixture")).toBe(false);
    expect(received.filter((event) => event.type === "event.delivery_poisoned")).toHaveLength(1);

    const poison = db.prepare("SELECT payload FROM events WHERE type = 'event.delivery_poisoned'").get() as {
      payload: string;
    };
    expect(JSON.parse(poison.payload)).toMatchObject({
      type: "event.delivery_poisoned",
      poisonedSeq: malformedSeq,
      payloadSha: status.lastPoison?.payloadSha,
    });
  });

  it("retries a malformed row when its first poison write fails", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    const initialStatus = bus.getNotifyDrainStatus();
    const persist = bus.persistWithinTransaction.bind(bus);
    let rejectFirstPoison = true;
    vi.spyOn(bus, "persistWithinTransaction").mockImplementation((event) => {
      if (event.type === "event.delivery_poisoned" && rejectFirstPoison) {
        rejectFirstPoison = false;
        throw new Error("simulated poison write failure");
      }
      return persist(event);
    });

    let malformedSeq = 0;
    let laterSeq = 0;
    expect(() =>
      bus.withNotifyEnvelope(() => {
        malformedSeq = Number(
          db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
            .run(null, null, "malformed.fixture", "{not-json")
            .lastInsertRowid,
        );
        laterSeq = Number(
          db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
            .run(
              null,
              null,
              "view.changed",
              JSON.stringify({ type: "view.changed", viewName: "later", cause: "poison-retry" }),
            )
            .lastInsertRowid,
        );
      }),
    ).toThrow("simulated poison write failure");

    expect(bus.getNotifyDrainStatus()).toEqual(initialStatus);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'event.delivery_poisoned'").get())
      .toEqual({ count: 0 });
    expect(received).toEqual([]);

    bus.withNotifyEnvelope(() => undefined);

    const poisonRows = db.prepare(
      "SELECT seq, payload FROM events WHERE type = 'event.delivery_poisoned' ORDER BY seq",
    ).all() as Array<{ seq: number; payload: string }>;
    expect(poisonRows).toHaveLength(1);
    expect(JSON.parse(poisonRows[0]!.payload)).toMatchObject({
      type: "event.delivery_poisoned",
      poisonedSeq: malformedSeq,
    });
    expect(received.map((event) => event.seq)).toEqual([laterSeq, poisonRows[0]!.seq]);
    expect(received.map((event) => event.type)).toEqual(["view.changed", "event.delivery_poisoned"]);
    expect(bus.getNotifyDrainStatus()).toMatchObject({
      state: "unparseable",
      lastPoison: { seq: malformedSeq },
    });
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["missing type", "{}"],
    ["non-string type", '{"type":17}'],
  ])("treats parseable-but-malformed %s payload as the unparseable third state", (_label, payload) => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope(() => {
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
        .run(null, null, "malformed.fixture", payload);
    });

    expect(bus.getNotifyDrainStatus()).toMatchObject({
      state: "unparseable",
      lastPoison: { error: "invalid event payload shape" },
    });
    expect(received.filter((event) => event.type === "event.delivery_poisoned")).toHaveLength(1);
    expect(received.some((event) => (event as { type?: unknown }).type === 17)).toBe(false);
  });

  it("starts at MAX(seq) so legacy malformed rows remain replay-only", () => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
      .run(null, null, "legacy.malformed", "{not-json");
    const freshBus = new EventBus(db);
    const received: PersistedEvent[] = [];
    freshBus.subscribe((event) => received.push(event));

    freshBus.withNotifyEnvelope((register) => {
      register(freshBus.persistWithinTransaction({
        type: "view.changed",
        viewName: "fresh",
        cause: "post-boot",
      }));
    });

    expect(freshBus.getNotifyDrainStatus().state).toBe("healthy");
    expect(received.map((event) => event.type)).toEqual(["view.changed"]);
  });

  it("delivers the row-derived value so live and replay payloads are identical", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope((register) => {
      register(bus.persistWithinTransaction({
        type: "view.changed",
        viewName: "parity",
        cause: "row-derived",
        transient: undefined,
      } as Parameters<EventBus["persistWithinTransaction"]>[0]));
    });

    expect(received).toEqual(bus.replayAll(0));
    expect(received[0]).not.toHaveProperty("transient");
  });

  it("delivers an orphan row normally without consulting live topology", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope((register) => {
      register(
        bus.persistWithinTransaction({
          type: "rig.deleted",
          rigId: "rig-that-does-not-exist",
        }),
      );
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "rig.deleted", rigId: "rig-that-does-not-exist" });
  });
});
