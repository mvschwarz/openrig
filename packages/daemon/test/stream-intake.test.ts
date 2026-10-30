import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { streamIntakeQitemId, StreamIntakeCoordinator } from "../src/domain/stream-intake.js";
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
      expect(row.tags).toContain("stream-subscription");
      expect(row.priority).toBe("routine");
      expect(row.body).toContain(item.streamItemId);
      expect(row.body).toContain("First observation from build");
      expect(row.body).toContain("reviewer@starter");
      expect(row.summary).toContain("1 new stream observation(s)");
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
      expect(notes[0]!.transitionNote).toContain("Second observation");
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

  it("marks the intake item priority as urgent when emitted with hintUrgency=critical or interrupt=true", async () => {
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
        body: "Critical alert!",
        hintUrgency: "critical",
      });
      await new Promise((r) => setTimeout(r, 50));

      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.priority).toBe("urgent");
    } finally {
      coordinator.stop();
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

  it("catches up un-intaken stream items stored before start (e.g. crash recovery)", async () => {
    const { db, bus, streamStore, queueRepo } = setup();

    // Emit before coordinator starts (simulating crash/stored before intake started)
    const item1 = streamStore.emit({
      sourceSession: "dev-build@starter",
      body: "Unintaken pre-start item",
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
      await new Promise((r) => setTimeout(r, 50));
      const rows = queueRepo.list({ destinationSession: "queue.worker" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.qitemId).toBe(streamIntakeQitemId(item1.streamSortKey));
    } finally {
      coordinator.stop();
    }
  });
});
