import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { streamIntakeQitemId, StreamIntakeCoordinator, STREAM_INTAKE_TAG } from "../src/domain/stream-intake.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { RUNNER_PERMIT_TAG } from "../src/domain/runner-permissions.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const streamStore = new StreamStore(db, bus);
  const queueRepo = new QueueRepository(db, bus);
  return { db, bus, streamStore, queueRepo };
}

describe("StreamIntakeCoordinator", () => {
  it("derives deterministic idempotent qitemId from the first stream item", () => {
    const id1 = streamIntakeQitemId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const id2 = streamIntakeQitemId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^qitem-stream-intake-[a-f0-9]{16}$/);
  });

  it("creates an intake queue item for the queue worker on emit when intake is enabled", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const item = streamStore.emit({
        sourceSession: "dev-build@starter",
        body: "First observation from build",
        hintDestination: "reviewer@starter",
      });

      // Allow microtask/turn to process
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.qitemId).toBe(streamIntakeQitemId(item.streamSortKey));
      expect(row.tags).toContain(STREAM_INTAKE_TAG);
      expect(row.priority).toBe("routine");
      expect(row.body).toContain(item.streamItemId);
      expect(row.body).toContain("reviewer@starter");
      expect(row.body).toContain(`rig stream list --after ${item.streamSortKey}`);
      expect(row.summary).toContain("1 new stream observation(s)");
    } finally {
      coordinator.stop();
    }
  });

  it("processes a new emit even when more than 10 stream items are already stored", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    // Store 15 items first
    for (let i = 0; i < 15; i++) {
      streamStore.emit({ sourceSession: "test@s", body: `Old item ${i}` });
    }
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const newItem = streamStore.emit({ sourceSession: "test@s", body: "Brand new item" });
      await new Promise((r) => setTimeout(r, 50));
      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.qitemId).toBe(streamIntakeQitemId(newItem.streamSortKey));
    } finally {
      coordinator.stop();
    }
  });

  it("adds notes to the existing unclaimed intake item if another emit occurs before claim", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const item1 = streamStore.emit({
        sourceSession: "dev-build@starter",
        body: "First observation",
      });
      await new Promise((r) => setTimeout(r, 50));

      const item2 = streamStore.emit({
        sourceSession: "dev-test@starter",
        body: "Second observation",
      });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.qitemId).toBe(streamIntakeQitemId(item1.streamSortKey));

      const transitions = queueRepo.listTransitions(row.qitemId);
      const notes = transitions.filter((t) => t.transitionNote?.startsWith("Stream observation added:"));
      expect(notes).toHaveLength(1);
      expect(notes[0]!.transitionNote).toContain(item2.streamItemId);
    } finally {
      coordinator.stop();
    }
  });

  it("finds the pending intake item using tag filter even when 10 other items are ahead of it", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const item1 = streamStore.emit({ sourceSession: "dev@s", body: "First stream item" });
      await new Promise((r) => setTimeout(r, 50));

      // Insert 12 other non-intake pending queue items ahead of it
      for (let i = 0; i < 12; i++) {
        await queueRepo.create({
          sourceSession: "other@s",
          destinationSession: "queue.worker",
          body: `Unrelated task ${i}`,
        });
      }

      // Second emit should still find the existing intake row rather than opening a second intake item
      const item2 = streamStore.emit({ sourceSession: "dev@s", body: "Second stream item" });
      await new Promise((r) => setTimeout(r, 50));

      const intakeRows = queueRepo.list({ destinationSession: "queue.worker", tag: STREAM_INTAKE_TAG });
      expect(intakeRows).toHaveLength(1);
      const transitions = queueRepo.listTransitions(intakeRows[0]!.qitemId);
      expect(transitions.some((t) => t.transitionNote?.includes(item2.streamItemId))).toBe(true);
    } finally {
      coordinator.stop();
    }
  });

  it("promotes pending routine intake batch to urgent and re-wakes when a subsequent critical item arrives", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const sends: Array<{ target: string; text: string; opts: any }> = [];
    queueRepo.attachTransport({
      send: async (target: string, text: string, opts: any) => {
        sends.push({ target, text, opts });
        return { ok: true, verified: true };
      },
    });

    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      streamStore.emit({ sourceSession: "dev@s", body: "Routine item" });
      await new Promise((r) => setTimeout(r, 50));
      const rowBefore = queueRepo.list({ destinationSession: "queue.worker" })[0]!;
      expect(rowBefore.priority).toBe("routine");
      expect(sends).toHaveLength(1);

      streamStore.emit({ sourceSession: "dev@s", body: "Urgent problem!", hintUrgency: "critical", hintDestination: "reviewer@kernel" });
      await new Promise((r) => setTimeout(r, 50));
      const rowAfter = queueRepo.getById(rowBefore.qitemId)!;
      expect(rowAfter.priority).toBe("urgent");

      // Verify re-wake was triggered with urgent admission
      expect(sends).toHaveLength(2);
      expect(sends[1]!.target).toBe("queue.worker");
      expect(sends[1]!.opts.urgent).toEqual({ by: "OpenRig" });

      // Verify note includes the destination hint
      const transitions = queueRepo.listTransitions(rowBefore.qitemId);
      const lastNote = transitions[transitions.length - 1]?.transitionNote;
      expect(lastNote).toContain("destination=reviewer@kernel");
    } finally {
      coordinator.stop();
    }
  });

  it("promotes pending routine intake batch to urgent and re-wakes when a subsequent interrupt item arrives", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const sends: Array<{ target: string; text: string; opts: any }> = [];
    queueRepo.attachTransport({
      send: async (target: string, text: string, opts: any) => {
        sends.push({ target, text, opts });
        return { ok: true, verified: true };
      },
    });

    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      streamStore.emit({ sourceSession: "dev@s", body: "Routine item" });
      await new Promise((r) => setTimeout(r, 50));
      const rowBefore = queueRepo.list({ destinationSession: "queue.worker" })[0]!;
      expect(rowBefore.priority).toBe("routine");
      expect(sends).toHaveLength(1);

      streamStore.emit({ sourceSession: "dev@s", body: "Interrupt signal!", interrupt: true });
      await new Promise((r) => setTimeout(r, 50));
      const rowAfter = queueRepo.getById(rowBefore.qitemId)!;
      expect(rowAfter.priority).toBe("urgent");

      // Verify re-wake was triggered with urgent admission
      expect(sends).toHaveLength(2);
      expect(sends[1]!.target).toBe("queue.worker");
      expect(sends[1]!.opts.urgent).toEqual({ by: "OpenRig" });
    } finally {
      coordinator.stop();
    }
  });

  it("opens a new intake item after the previous one was claimed", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const item1 = streamStore.emit({
        sourceSession: "dev-build@starter",
        body: "First observation",
      });
      await new Promise((r) => setTimeout(r, 50));

      const row1 = queueRepo.list({ destinationSession: "queue.worker" })[0]!;
      queueRepo.claim({ qitemId: row1.qitemId, destinationSession: "queue.worker" });

      const item2 = streamStore.emit({
        sourceSession: "dev-build@starter",
        body: "Second observation after claim",
      });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.qitemId)).toContain(streamIntakeQitemId(item2.streamSortKey));
    } finally {
      coordinator.stop();
    }
  });

  it("does not crash or create invalid queue item when destination does not resolve (no kernel worker)", async () => {
    const { db, bus, streamStore } = setup();
    // create QueueRepository with strict topology check rejecting non-canonical sessions (requires @):
    const queueRepo = new QueueRepository(db, bus, {
      validateRig: (sessionRef) => sessionRef.includes("@"),
    });
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      streamStore.emit({ sourceSession: "dev@s", body: "Emit without kernel" });
      await new Promise((r) => setTimeout(r, 50));
      expect(queueRepo.list()).toHaveLength(0);
    } finally {
      coordinator.stop();
    }
  });

  it("routes to real session when kernel rig has a queue.worker session", async () => {
    const { db, bus, streamStore, queueRepo } = setup();

    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-kernel', 'kernel')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-qw', 'rig-kernel', 'queue.worker')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('ses-qw', 'node-qw', 'queue.worker@kernel')").run();

    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const item = streamStore.emit({
        sourceSession: "dev-build@starter",
        body: "Real kernel session routing observation",
      });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker@kernel" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.destinationSession).toBe("queue.worker@kernel");
      expect(rows[0]!.qitemId).toBe(streamIntakeQitemId(item.streamSortKey));
    } finally {
      coordinator.stop();
    }
  });

  it("does not crash or unhandled reject when destination callback throws", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: () => {
        throw new Error("SyntaxError: Unexpected token in JSON at position 42");
      },
    });
    coordinator.start();

    try {
      streamStore.emit({ sourceSession: "dev@s", body: "Resilient emit on bad json" });
      await new Promise((r) => setTimeout(r, 50));
      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
    } finally {
      coordinator.stop();
    }
  });

  it("stays up and leaves item pending when queue write fails", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    let throwError = true;
    const origCreate = queueRepo.create.bind(queueRepo);
    queueRepo.create = async (input) => {
      if (throwError) throw new Error("Injected write failure");
      return origCreate(input);
    };
    const origCreateTx = queueRepo.createWithinTransaction.bind(queueRepo);
    queueRepo.createWithinTransaction = (input) => {
      if (throwError) throw new Error("Injected write failure");
      return origCreateTx(input);
    };

    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      streamStore.emit({ sourceSession: "dev@s", body: "Resilient emit" });
      await new Promise((r) => setTimeout(r, 50));
      expect(queueRepo.list()).toHaveLength(0);

      // Now repair write
      throwError = false;
      streamStore.emit({ sourceSession: "dev@s", body: "Trigger drain" });
      await new Promise((r) => setTimeout(r, 50));
      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      coordinator.stop();
    }
  });

  it("first start with stored history records cursor at newest item and adds nothing to queue", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    for (let i = 0; i < 5; i++) {
      streamStore.emit({ sourceSession: "test@s", body: `Historical item ${i}` });
    }
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(queueRepo.list()).toHaveLength(0);
    } finally {
      coordinator.stop();
    }
  });

  it("restart with a pending intake item adds no duplicate note", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coord1 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord1.start();
    streamStore.emit({ sourceSession: "test@s", body: "Item 1" });
    await new Promise((r) => setTimeout(r, 50));
    coord1.stop();

    const rowsBefore = queueRepo.list({ destinationSession: "queue.worker" });
    expect(rowsBefore).toHaveLength(1);
    const transitionsBefore = queueRepo.listTransitions(rowsBefore[0]!.qitemId);

    // Restart coordinator
    const coord2 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord2.start();

    try {
      await new Promise((r) => setTimeout(r, 50));
      const transitionsAfter = queueRepo.listTransitions(rowsBefore[0]!.qitemId);
      expect(transitionsAfter).toHaveLength(transitionsBefore.length);
    } finally {
      coord2.stop();
    }
  });

  it("restart with a closed intake item adds no duplicate note or item", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coord1 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord1.start();
    streamStore.emit({ sourceSession: "test@s", body: "Item 1" });
    await new Promise((r) => setTimeout(r, 50));
    coord1.stop();

    const row = queueRepo.list({ destinationSession: "queue.worker" })[0]!;
    queueRepo.update({
      qitemId: row.qitemId,
      actorSession: "worker@kernel",
      state: "done",
      closureReason: "no-follow-on",
    });

    const coord2 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord2.start();

    try {
      await new Promise((r) => setTimeout(r, 50));
      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("done");
    } finally {
      coord2.stop();
    }
  });

  it("catches up beyond one page (paging past 100 items)", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    // First start to set baseline cursor
    const coord1 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord1.start();
    coord1.stop();

    // Emit 120 items while stopped
    for (let i = 0; i < 120; i++) {
      streamStore.emit({ sourceSession: "batch@s", body: `Batch item ${i}` });
    }

    const coord2 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord2.start();

    try {
      await new Promise((r) => setTimeout(r, 200));
      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      const transitions = queueRepo.listTransitions(rows[0]!.qitemId);
      // 1 created item + 119 transition notes added
      expect(transitions.filter((t) => t.transitionNote?.startsWith("Stream observation added:"))).toHaveLength(119);
    } finally {
      coord2.stop();
    }
  });

  it("does not create intake items when destination is 'off'", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "off",
    });
    coordinator.start();

    try {
      streamStore.emit({
        sourceSession: "dev-build@starter",
        body: "Should not be intaken",
      });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list();
      expect(rows).toHaveLength(0);
    } finally {
      coordinator.stop();
    }
  });

  it("more than one page and a live emit while a notification is held, with and without a restart; each observation appears once and none is skipped", async () => {
    const { db, bus, streamStore, queueRepo } = setup();

    // 1. Establish initial cursor with a baseline item
    const baseItem = streamStore.emit({ sourceSession: "test@s", body: "Base item to establish cursor" });
    const now = new Date().toISOString();
    db.prepare("INSERT INTO stream_intake_cursor (id, last_sort_key, updated_at) VALUES (1, ?, ?)").run(
      baseItem.streamSortKey,
      now,
    );

    // 2. Seed more than one page of backlog items (> 100 items)
    const backlogCount = 110;
    const backlogIds: string[] = [];
    for (let i = 0; i < backlogCount; i++) {
      const item = streamStore.emit({ sourceSession: "test@s", body: `Backlog item ${i}` });
      backlogIds.push(item.streamItemId);
    }

    // Intercept maybeNudge to hold notifications
    let holdNudgeResolve: (() => void) | undefined;
    let holdNudges = true;
    const originalMaybeNudge = queueRepo.maybeNudge.bind(queueRepo);
    vi.spyOn(queueRepo, "maybeNudge").mockImplementation(async (...args) => {
      if (holdNudges) {
        await new Promise<void>((resolve) => {
          holdNudgeResolve = resolve;
        });
      }
      return originalMaybeNudge(...args);
    });

    const coord1 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord1.start();

    // Allow catch-up to start and hit the held notification on the first batch item
    await new Promise((r) => setTimeout(r, 60));

    // While notification is held, emit a live item
    const liveItem = streamStore.emit({ sourceSession: "test@s", body: "Live item emitted while notification held" });

    // Release notification so catch-up and live processing finish (without restart path)
    holdNudges = false;
    holdNudgeResolve?.();

    // Wait for drain to complete
    await new Promise((r) => setTimeout(r, 200));

    coord1.stop();

    // Verify all observations are accounted for: 1 initial intake item created, and 109 backlog items + 1 live item added as notes
    const rows = queueRepo.list({ destinationSession: "queue.worker" });
    expect(rows).toHaveLength(1);
    const qitem = rows[0]!;
    const transitions = queueRepo.listTransitions(qitem.qitemId);

    // Initial batch contains the first backlog item
    expect(qitem.body).toContain(backlogIds[0]);

    // Check all remaining backlog items appear in notes
    for (let i = 1; i < backlogCount; i++) {
      const found = transitions.some((t) => t.transitionNote?.includes(backlogIds[i]!));
      expect(found).toBe(true);
    }

    // Check live item appears in notes
    const liveFound = transitions.some((t) => t.transitionNote?.includes(liveItem.streamItemId));
    expect(liveFound).toBe(true);

    // Verify count: exactly 1 create + (backlogCount - 1) notes + 1 live note = 1 + 109 + 1 = 111 transitions
    expect(transitions).toHaveLength(111);

    // 3. WITH RESTART: test that restarting with closed or pending batches produces no duplicates
    const coord2 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord2.start();
    await new Promise((r) => setTimeout(r, 100));
    coord2.stop();

    // Confirm no duplicate notes were added to the pending batch
    const rowsAfterRestart = queueRepo.list({ destinationSession: "queue.worker" });
    expect(rowsAfterRestart).toHaveLength(1);
    const transAfterRestart = queueRepo.listTransitions(rowsAfterRestart[0]!.qitemId);
    expect(transAfterRestart).toHaveLength(111);

    // Mark batch as closed/claimed
    queueRepo.update({
      qitemId: qitem.qitemId,
      actorSession: "worker@kernel",
      state: "done",
      closureReason: "no-follow-on",
    });

    // Restart coordinator again with closed batch
    const coord3 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord3.start();
    await new Promise((r) => setTimeout(r, 100));
    coord3.stop();

    // Confirm no second intake item was opened
    const allRows = queueRepo.list({ destinationSession: "queue.worker" });
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.state).toBe("done");
  });

  it("with outbox attached, wake intent is staged in the same transaction and survives stopping before delivery", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox);

    // Prevent post-commit delivery by intercepting deliverWakeForSuccessor
    vi.spyOn(queueRepo, "deliverWakeForSuccessor").mockImplementation(async () => {});

    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const item = streamStore.emit({ sourceSession: "test@s", body: "Observation needing durable wake" });
      await new Promise((r) => setTimeout(r, 50));

      // Stop before delivery
      coordinator.stop();

      const qitemId = streamIntakeQitemId(item.streamSortKey);
      const queueRow = queueRepo.getById(qitemId);
      expect(queueRow).not.toBeNull();
      expect(queueRow).toBeDefined();

      // Check that wake intent was committed in the same transaction and is pending in outbox
      const intent = outbox.getById(`${WAKE_INTENT_PREFIX}${qitemId}`);
      expect(intent).not.toBeNull();
      expect(intent).toBeDefined();
      expect(intent?.deliveryState).toBe("pending");
      expect(intent?.destinationSession).toBe("queue.worker");
    } finally {
      coordinator.stop();
    }
  });

  it("rollback on cursor write failure keeps note absent and priority routine until retry", async () => {
    const { db, bus, streamStore, queueRepo } = setup();

    const coord = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord.start();

    // Emit first item to establish pending batch
    streamStore.emit({ sourceSession: "test@s", body: "First batch item" });
    await new Promise((r) => setTimeout(r, 50));

    const rows = queueRepo.list({ destinationSession: "queue.worker" });
    expect(rows).toHaveLength(1);
    const qitem = rows[0]!;
    expect(qitem.priority).toBe("routine");

    const cursorBefore = db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as {
      last_sort_key: string;
    };

    // Temporarily inject a failure in the cursor write during handleStreamItem
    const origPrepare = db.prepare.bind(db);
    let failCursorInsert = true;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (failCursorInsert && sql.includes("INSERT INTO stream_intake_cursor")) {
        throw new Error("Simulated cursor insert failure");
      }
      return origPrepare(sql);
    });

    // Emit critical item
    const item2 = streamStore.emit({ sourceSession: "test@s", body: "Urgent item note", hintUrgency: "critical" });
    await new Promise((r) => setTimeout(r, 50));

    // Verify transaction rolled back: note absent, priority unchanged, cursor unchanged
    const transMid = queueRepo.listTransitions(qitem.qitemId);
    expect(transMid.filter((t) => t.transitionNote?.includes(item2.streamItemId))).toHaveLength(0);
    const qitemMid = queueRepo.getById(qitem.qitemId)!;
    expect(qitemMid.priority).toBe("routine");
    const cursorMid = db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as {
      last_sort_key: string;
    };
    expect(cursorMid.last_sort_key).toBe(cursorBefore.last_sort_key);

    // Allow retry: clear failure and let drain re-run
    failCursorInsert = false;
    // @ts-expect-error accessing private method for controlled retry test
    await coord.drain();

    const transAfter = queueRepo.listTransitions(qitem.qitemId);
    expect(transAfter.filter((t) => t.transitionNote?.includes(item2.streamItemId))).toHaveLength(1);
    const qitemAfter = queueRepo.getById(qitem.qitemId)!;
    expect(qitemAfter.priority).toBe("urgent");

    coord.stop();
  });

  it("preserves checkpoint and does not initialize cursor as fresh install when cursor read fails", async () => {
    const { db, bus, streamStore, queueRepo } = setup();

    // First start to establish a valid cursor
    const coord1 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord1.start();
    const item1 = streamStore.emit({ sourceSession: "test@s", body: "Initial item" });
    await new Promise((r) => setTimeout(r, 50));
    coord1.stop();

    const cursorBefore = db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as {
      last_sort_key: string;
    };
    expect(cursorBefore.last_sort_key).toBe(item1.streamSortKey);

    // Emit more items while stopped
    const item2 = streamStore.emit({ sourceSession: "test@s", body: "Item during stop" });

    // Simulate database error when reading cursor
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes("SELECT last_sort_key FROM stream_intake_cursor")) {
        throw new Error("Simulated disk read error");
      }
      return origPrepare(sql);
    }) as any;

    const coord2 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    // start() calls catchUp() which encounters the read failure
    coord2.start();
    await new Promise((r) => setTimeout(r, 50));
    coord2.stop();

    // Restore prepare
    db.prepare = origPrepare;

    // Check that the cursor row was NOT overwritten or moved to item2's sort key
    const cursorAfter = db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as {
      last_sort_key: string;
    };
    expect(cursorAfter.last_sort_key).toBe(item1.streamSortKey);
  });

  it("bounds long fields with honest ellipsis in intake bodies and notes", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coordinator.start();

    try {
      const longSession = "session-" + "x".repeat(200);
      const longTag = "tag-" + "y".repeat(200);
      const item1 = streamStore.emit({
        sourceSession: longSession,
        body: "First observation",
        hintTags: [longTag],
      });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      const body = rows[0]!.body;
      expect(body).toContain("...");
      expect(rows[0]!.summary).toContain("...");

      // Add a note with long fields
      streamStore.emit({
        sourceSession: longSession,
        body: "Second observation",
        hintType: "longtype-" + "z".repeat(150),
      });
      await new Promise((r) => setTimeout(r, 50));

      const transitions = queueRepo.listTransitions(rows[0]!.qitemId);
      const note = transitions.find((t) => t.transitionNote?.startsWith("Stream observation added:"))?.transitionNote;
      expect(note).toBeDefined();
      expect(note).toContain("...");
    } finally {
      coordinator.stop();
    }
  });

  it("subscribes even when started with intake 'off', and processes emits if destination dynamically becomes active", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    let dynamicDest = "off";

    const coordinator = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: () => dynamicDest,
    });
    coordinator.start();

    try {
      // While off, emits are ignored
      streamStore.emit({ sourceSession: "test@s", body: "While off" });
      await new Promise((r) => setTimeout(r, 50));
      expect(queueRepo.list()).toHaveLength(0);

      // Now switch destination to active without restarting coordinator
      dynamicDest = "queue.worker";
      const activeItem = streamStore.emit({ sourceSession: "test@s", body: "After turning on" });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toContain(activeItem.streamItemId);
    } finally {
      coordinator.stop();
    }
  });

  it("partial catch-up failure keeps held live items behind unfinished backlog, and recovery handles every item in order", async () => {
    const { db, bus, streamStore, queueRepo } = setup();

    // 1. Establish initial cursor with coord1
    const coord1 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
    });
    coord1.start();
    const item0 = streamStore.emit({ sourceSession: "test@s", body: "Initial item 0" });
    await new Promise((r) => setTimeout(r, 50));
    coord1.stop();

    // Close the initial intake queue row so subsequent intake items open fresh rows or notes
    const initialRows = queueRepo.list({ destinationSession: "queue.worker" });
    expect(initialRows).toHaveLength(1);
    queueRepo.update({
      qitemId: initialRows[0]!.qitemId,
      actorSession: "worker@kernel",
      state: "done",
      closureReason: "no-follow-on",
    });

    // 2. Emit backlog items: item 1 (page 1) and item 2 (page 2) with pageSize: 1
    const item1 = streamStore.emit({ sourceSession: "test@s", body: "Backlog item 1 (page 1)" });
    const item2 = streamStore.emit({ sourceSession: "test@s", body: "Backlog item 2 (page 2)" });

    // 3. Inject page 2 query failure
    const origPrepare = db.prepare.bind(db);
    let pageQueries = 0;
    let failPage2 = true;
    db.prepare = ((sql: string) => {
      if (failPage2 && sql.includes("SELECT stream_item_id, stream_sort_key FROM stream_items")) {
        pageQueries++;
        if (pageQueries >= 2) {
          throw new Error("Simulated page 2 read failure");
        }
      }
      return origPrepare(sql);
    }) as any;

    const coord2 = new StreamIntakeCoordinator({
      db,
      eventBus: bus,
      streamStore,
      queueRepo,
      destination: "queue.worker",
      pageSize: 1,
    });
    coord2.start();

    // Wait for page 1 to process and page 2 to fail
    await new Promise((r) => setTimeout(r, 50));

    // Emit live item while catch-up is incomplete
    const liveItem = streamStore.emit({ sourceSession: "test@s", body: "Live item 3 during failure" });
    await new Promise((r) => setTimeout(r, 50));

    // Cursor must NOT have moved to liveItem or past item1
    const cursorMid = db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as {
      last_sort_key: string;
    };
    expect(cursorMid.last_sort_key).toBe(item1.streamSortKey);

    // Close item1 row so item2 opens its own row and can be cleanly inspected
    const midRows = queueRepo.list({ destinationSession: "queue.worker", state: "pending" });
    expect(midRows).toHaveLength(1);
    expect(midRows[0]!.body).toContain(item1.streamItemId);
    expect(midRows[0]!.body).not.toContain(item2.streamItemId);
    expect(midRows[0]!.body).not.toContain(liveItem.streamItemId);
    queueRepo.update({
      qitemId: midRows[0]!.qitemId,
      actorSession: "worker@kernel",
      state: "done",
      closureReason: "no-follow-on",
    });

    // 4. Recover: clear failure and trigger recovery through a live emit
    failPage2 = false;
    const recoverItem = streamStore.emit({ sourceSession: "test@s", body: "Live item 4 triggering recovery" });
    await new Promise((r) => setTimeout(r, 50));

    // After recovery, item 2, held liveItem, and recoverItem must all have been processed, and cursor advanced to recoverItem
    const cursorAfter = db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as {
      last_sort_key: string;
    };
    expect(cursorAfter.last_sort_key).toBe(recoverItem.streamSortKey);

    // Check that item 2 was handled first, then held liveItem, then recoverItem, in order
    const afterRows = queueRepo.list({ destinationSession: "queue.worker", state: "pending" });
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.body).toContain(item2.streamItemId);
    expect(afterRows[0]!.body).not.toContain(liveItem.streamItemId);
    expect(afterRows[0]!.body).not.toContain(recoverItem.streamItemId);

    const transitions = queueRepo.listTransitions(afterRows[0]!.qitemId);
    const observationNotes = transitions
      .filter((t) => t.transitionNote?.startsWith("Stream observation added:"))
      .map((t) => t.transitionNote!);
    expect(observationNotes).toHaveLength(2);
    expect(observationNotes[0]).toContain(liveItem.streamItemId);
    expect(observationNotes[0]).not.toContain(recoverItem.streamItemId);
    expect(observationNotes[1]).toContain(recoverItem.streamItemId);
    expect(observationNotes[1]).not.toContain(liveItem.streamItemId);

    // Verify each observation across the test was handled exactly once in order
    const allRows = queueRepo.list({ destinationSession: "queue.worker" });
    expect(allRows).toHaveLength(3);

    const handledOrder = [
      allRows.find((r) => r.body.includes(item0.streamItemId)) ? item0.streamItemId : null,
      allRows.find((r) => r.body.includes(item1.streamItemId)) ? item1.streamItemId : null,
      afterRows[0]!.body.includes(item2.streamItemId) ? item2.streamItemId : null,
      observationNotes[0]!.includes(liveItem.streamItemId) ? liveItem.streamItemId : null,
      observationNotes[1]!.includes(recoverItem.streamItemId) ? recoverItem.streamItemId : null,
    ];
    expect(handledOrder).toEqual([
      item0.streamItemId,
      item1.streamItemId,
      item2.streamItemId,
      liveItem.streamItemId,
      recoverItem.streamItemId,
    ]);

    // Check that each observation was handled (either opening an intake row or added as a note) exactly once
    const allTransitions = (
      db.prepare("SELECT transition_note FROM queue_transitions WHERE transition_note IS NOT NULL").all() as Array<{
        transition_note: string;
      }>
    ).map((t) => t.transition_note);

    for (const item of [item0, item1, item2, liveItem, recoverItem]) {
      const rowsWithItem = allRows.filter((r) => r.body.includes(item.streamItemId)).length;
      const notesWithItem = allTransitions.filter((n) => n.includes(item.streamItemId)).length;
      expect(rowsWithItem + notesWithItem).toBe(1);
    }

    coord2.stop();
    db.prepare = origPrepare;
  });
});

// #2361's record of a permit OpenRig decided by default is pull-only: it is written as runner-permissions.ts writes it (a low
// observation tagged RUNNER_PERMIT_TAG), and intake must never turn it into a row or a wake.
describe("StreamIntakeCoordinator with default-permit records", () => {
  const permit = (streamStore: StreamStore, streamItemId?: string) => streamStore.emit({ ...(streamItemId ? { streamItemId } : {}),
    sourceSession: "dev-runner@perm-rig", body: "OpenRig permitted a tool call by default", hintType: "observation", hintUrgency: "low",
    hintTags: [RUNNER_PERMIT_TAG, "node:n1"] });
  const cursor = (db: Database.Database) =>
    (db.prepare("SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1").get() as { last_sort_key: string } | undefined)?.last_sort_key;
  const coordinator = (s: ReturnType<typeof setup>) =>
    new StreamIntakeCoordinator({ db: s.db, eventBus: s.bus, streamStore: s.streamStore, queueRepo: s.queueRepo, destination: "queue.worker" });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("live: a permit record makes no intake row and wakes no one, the cursor moves past it, and a later observation is routed", async () => {
    const s = setup();
    const wake = vi.spyOn(s.queueRepo, "deliverWakeForSuccessor");
    const c = coordinator(s);
    c.start();
    try {
      await settle();
      const record = permit(s.streamStore);
      await settle();
      expect(s.queueRepo.list({ destinationSession: "queue.worker" })).toHaveLength(0);
      expect(wake).not.toHaveBeenCalled();
      expect(cursor(s.db)).toBe(record.streamSortKey);
      const ordinary = s.streamStore.emit({ sourceSession: "dev-build@starter", body: "An ordinary observation" });
      await settle();
      expect(s.queueRepo.list({ destinationSession: "queue.worker" }).map((row) => row.qitemId)).toEqual([streamIntakeQitemId(ordinary.streamSortKey)]);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      c.stop();
    }
  });

  it("restart and catch-up: permit records stored while intake was stopped make no row or note, and the cursor moves past them", async () => {
    const s = setup();
    s.db.prepare("INSERT INTO stream_intake_cursor (id, last_sort_key, updated_at) VALUES (1, '', ?)").run(new Date().toISOString());
    permit(s.streamStore);
    const ordinary = s.streamStore.emit({ sourceSession: "dev-build@starter", body: "An ordinary observation" });
    const last = permit(s.streamStore);
    const c = coordinator(s);
    c.start();
    try {
      await settle();
      const rows = s.queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows.map((row) => row.qitemId)).toEqual([streamIntakeQitemId(ordinary.streamSortKey)]);
      expect(s.queueRepo.listTransitions(rows[0]!.qitemId)).toHaveLength(1);
      expect(cursor(s.db)).toBe(last.streamSortKey);
    } finally {
      c.stop();
    }
  });

  it("a repeated permit record stays quiet, live and after a restart", async () => {
    const s = setup();
    const c = coordinator(s);
    c.start();
    await settle();
    permit(s.streamStore, "permit-1");
    permit(s.streamStore, "permit-1");
    await settle();
    c.stop();
    const again = coordinator(s);
    again.start();
    try {
      await settle();
      expect(s.queueRepo.list({ destinationSession: "queue.worker" })).toHaveLength(0);
    } finally {
      again.stop();
    }
  });

  it("ordinary observations still coalesce into the pending intake row around a permit record", async () => {
    const s = setup();
    const c = coordinator(s);
    c.start();
    try {
      await settle();
      s.streamStore.emit({ sourceSession: "dev-build@starter", body: "First observation" });
      await settle();
      const [row] = s.queueRepo.list({ destinationSession: "queue.worker" });
      const notesBefore = s.queueRepo.listTransitions(row!.qitemId).length;
      permit(s.streamStore);
      await settle();
      expect(s.queueRepo.listTransitions(row!.qitemId)).toHaveLength(notesBefore);
      s.streamStore.emit({ sourceSession: "dev-test@starter", body: "Second observation" });
      await settle();
      expect(s.queueRepo.list({ destinationSession: "queue.worker" })).toHaveLength(1);
      expect(s.queueRepo.listTransitions(row!.qitemId)).toHaveLength(notesBefore + 1);
    } finally {
      c.stop();
    }
  });
});
