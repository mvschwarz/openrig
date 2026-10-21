// Migration 110 on a long-lived install: workflow instances created before it hold no
// scope, read back unscoped, and keep projecting packets with the tags they always had.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

const SPEC = `workflow:
  id: pre-scope
  version: 1
  entry: { role: producer }
  roles:
    producer: { preferred_targets: [producer@rig] }
    reviewer: { preferred_targets: [reviewer@rig] }
  steps:
    - { id: produce, actor_role: producer, allowed_exits: [handoff, done, failed] }
    - { id: review, actor_role: reviewer, depends_on: [produce], allowed_exits: [handoff, done, failed] }
    - { id: ship, actor_role: reviewer, depends_on: [review], allowed_exits: [done, failed] }
`;

describe("migration 110 (workflow instance scope) on an install that already holds instances", () => {
  let db: Database.Database;
  let tmp: string;

  const runtimeOver = () => {
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    return new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  };
  const tagsOf = (qitemId: string): string[] =>
    JSON.parse((db.prepare(`SELECT tags FROM queue_items WHERE qitem_id = ?`).get(qitemId) as { tags: string }).tags);

  beforeEach(() => {
    db = createDb();
    tmp = mkdtempSync(join(tmpdir(), "wf-scope-mig-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads pre-existing instances back unscoped and keeps projecting their old tags", async () => {
    // an install at upstream's head before this change: 109_mode_posture_coexist applied, 110 not yet
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "110_workflow_instance_scope.sql"));
    const applied = () => (db.prepare(`SELECT name FROM schema_migrations`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied()).toContain("109_mode_posture_coexist.sql");
    expect(applied()).not.toContain("110_workflow_instance_scope.sql");
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    const before = runtimeOver();
    const old = await before.instantiate({ specPath, rootObjective: "pre-migration", createdBySession: "ops@rig" });
    const hop1 = await before.project({
      instanceId: old.instance.instanceId, currentPacketId: old.entryQitemId, exit: "handoff", actorSession: "producer@rig",
    });
    expect(db.prepare(`PRAGMA table_info(workflow_instances)`).all().some((c) => (c as { name: string }).name === "scope_json")).toBe(false);

    // the upgrade: the daemon restarts on a new build and applies 110 to the existing database
    migrate(db, ALL_MIGRATIONS);
    expect(applied()).toEqual(expect.arrayContaining(["109_mode_posture_coexist.sql", "110_workflow_instance_scope.sql"]));
    const after = runtimeOver();

    const row = db.prepare(`SELECT scope_json FROM workflow_instances WHERE instance_id = ?`).get(old.instance.instanceId) as { scope_json: string | null };
    expect(row.scope_json).toBeNull();
    expect(after.instanceStore.getByIdOrThrow(old.instance.instanceId).scope).toBeNull();

    // the old instance keeps projecting with exactly the tags it always had
    const hop2 = await after.project({
      instanceId: old.instance.instanceId, currentPacketId: hop1.nextQitemId!, exit: "handoff", actorSession: "reviewer@rig",
    });
    expect(tagsOf(hop1.nextQitemId!)).toEqual(["workflow", "handoff", "workflow:pre-scope", `instance:${old.instance.instanceId}`, "step:review"]);
    expect(tagsOf(hop2.nextQitemId!)).toEqual(["workflow", "handoff", "workflow:pre-scope", `instance:${old.instance.instanceId}`, "step:ship"]);

    // and a new instance on the upgraded database can be scoped
    const fresh = await after.instantiate({ specPath, rootObjective: "post", createdBySession: "ops@rig", scope: { project: "p1", slice: "s1" } });
    expect(tagsOf(fresh.entryQitemId).slice(-2)).toEqual(["project:p1", "slice:s1"]);
  });
});
