import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { workflowBoundPodSchema } from "../src/db/migrations/177_workflow_bound_pod.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

it("adds a nullable workflow pod binding using migration 177", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE workflow_instances (id TEXT PRIMARY KEY)");
    db.exec(workflowBoundPodSchema.sql);
    db.prepare("INSERT INTO workflow_instances (id) VALUES (?)").run("unbound");
    db.prepare("INSERT INTO workflow_instances (id, bound_pod) VALUES (?, ?)").run("bound", "ops");
    expect(db.prepare("SELECT bound_pod FROM workflow_instances ORDER BY id").all()).toEqual([{ bound_pod: "ops" }, { bound_pod: null }]);
    expect(workflowBoundPodSchema.name).toBe("177_workflow_bound_pod.sql");
    expect(ALL_MIGRATIONS.map((migration) => migration.name)).toContain(workflowBoundPodSchema.name);
  } finally { db.close(); }
});
