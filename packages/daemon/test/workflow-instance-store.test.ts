import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import {
  WorkflowInstanceError,
  WorkflowInstanceStore,
} from "../src/domain/workflow-instance-store.js";

describe("WorkflowInstanceStore (PL-004 Phase D)", () => {
  let db: Database.Database;
  let store: WorkflowInstanceStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowInstancesSchema]);
    store = new WorkflowInstanceStore(db);
  });

  afterEach(() => db.close());

  it("create stores a new instance with status=active + empty frontier + ULID id", () => {
    const inst = store.create({
      workflowName: "test",
      workflowVersion: "1",
      createdBySession: "alice@rig",
    });
    expect(inst.instanceId).toMatch(/^[0-9A-Z]{26}$/);
    expect(inst.status).toBe("active");
    expect(inst.currentFrontier).toEqual([]);
    expect(inst.hopCount).toBe(0);
  });

  it("getByIdOrThrow throws instance_not_found for unknown id", () => {
    try {
      store.getByIdOrThrow("nope");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowInstanceError);
      expect((err as WorkflowInstanceError).code).toBe("instance_not_found");
    }
  });

  it("updateFrontier mutates the JSON array AND status", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, ["q-1", "q-2"], "active");
    const after = store.getByIdOrThrow(inst.instanceId);
    expect(after.currentFrontier).toEqual(["q-1", "q-2"]);
    expect(after.status).toBe("active");
  });

  it("updateFrontier with bumpHopCount=true increments hop_count atomically", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, ["q-1"], "active", { bumpHopCount: true });
    store.updateFrontier(inst.instanceId, ["q-2"], "active", { bumpHopCount: true });
    expect(store.getByIdOrThrow(inst.instanceId).hopCount).toBe(2);
  });

  it("updateFrontier records lastContinuationDecision JSON-serialized", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, [], "completed", {
      lastContinuationDecision: { exit: "done", actor: "a@r" },
      completedAt: "2026-05-03T08:00:00.000Z",
    });
    const after = store.getByIdOrThrow(inst.instanceId);
    expect(after.lastContinuationDecision).toEqual({ exit: "done", actor: "a@r" });
    expect(after.completedAt).toBe("2026-05-03T08:00:00.000Z");
  });

  it("listByStatus filters; listAll returns all", () => {
    const a = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    const b = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "b@r" });
    store.updateFrontier(b.instanceId, [], "completed");
    expect(store.listByStatus("active").map((i) => i.instanceId)).toEqual([a.instanceId]);
    expect(store.listByStatus("completed").map((i) => i.instanceId)).toEqual([b.instanceId]);
    expect(store.listAll()).toHaveLength(2);
  });

  it("survives restart via SQLite (new store instance reads same data)", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, ["q-x"], "active");
    const store2 = new WorkflowInstanceStore(db);
    const restored = store2.getByIdOrThrow(inst.instanceId);
    expect(restored.currentFrontier).toEqual(["q-x"]);
    expect(restored.status).toBe("active");
  });
});
