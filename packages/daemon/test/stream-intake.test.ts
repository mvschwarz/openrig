import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { streamIntakeQitemId, StreamIntakeCoordinator, STREAM_INTAKE_TAG } from "../src/domain/stream-intake.js";
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

  it("promotes pending routine intake batch to urgent when a subsequent critical item arrives", async () => {
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
      streamStore.emit({ sourceSession: "dev@s", body: "Routine item" });
      await new Promise((r) => setTimeout(r, 50));
      const rowBefore = queueRepo.list({ destinationSession: "queue.worker" })[0]!;
      expect(rowBefore.priority).toBe("routine");

      streamStore.emit({ sourceSession: "dev@s", body: "Urgent problem!", hintUrgency: "critical" });
      await new Promise((r) => setTimeout(r, 50));
      const rowAfter = queueRepo.getById(rowBefore.qitemId)!;
      expect(rowAfter.priority).toBe("urgent");
    } finally {
      coordinator.stop();
    }
  });

  it("promotes pending routine intake batch to urgent when a subsequent interrupt item arrives", async () => {
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
      streamStore.emit({ sourceSession: "dev@s", body: "Routine item" });
      await new Promise((r) => setTimeout(r, 50));
      const rowBefore = queueRepo.list({ destinationSession: "queue.worker" })[0]!;
      expect(rowBefore.priority).toBe("routine");

      streamStore.emit({ sourceSession: "dev@s", body: "Interrupt signal!", interrupt: true });
      await new Promise((r) => setTimeout(r, 50));
      const rowAfter = queueRepo.getById(rowBefore.qitemId)!;
      expect(rowAfter.priority).toBe("urgent");
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

  it("stays up and leaves item pending when queue write fails", async () => {
    const { db, bus, streamStore, queueRepo } = setup();
    let throwError = true;
    const origCreate = queueRepo.create.bind(queueRepo);
    queueRepo.create = async (input) => {
      if (throwError) throw new Error("Injected write failure");
      return origCreate(input);
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
});
