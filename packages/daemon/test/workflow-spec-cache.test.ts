import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache, WorkflowSpecError, parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SAMPLE_SPEC = `workflow:
  id: test-three-step
  version: 1
  objective: A 3-step test fixture
  target:
    rig: workflow-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@workflow-fixture
    reviewer:
      preferred_targets:
        - reviewer@workflow-fixture
    finalizer:
      preferred_targets:
        - finalizer@workflow-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft the artifact.
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      objective: Review the artifact.
      allowed_exits:
        - handoff
    - id: finalize
      actor_role: finalizer
      objective: Sign off.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
`;

describe("WorkflowSpecCache (PL-004 Phase D)", () => {
  let db: Database.Database;
  let tmp: string;
  let cache: WorkflowSpecCache;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-spec-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("readThrough creates a cache row from a YAML spec file", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const row = cache.readThrough(path);
    expect(row.specId).toMatch(/^[0-9A-Z]{26}$/);
    expect(row.name).toBe("test-three-step");
    expect(row.version).toBe("1");
    expect(row.spec.steps).toHaveLength(3);
    expect(row.spec.roles.producer).toBeDefined();
    expect(row.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("readThrough returns the same spec_id when content unchanged (hash hit)", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const first = cache.readThrough(path);
    const second = cache.readThrough(path);
    expect(second.specId).toBe(first.specId);
    expect(second.cachedAt).toBe(first.cachedAt);
  });

  it("readThrough re-caches in place when content changes (hash miss; same spec_id; cached_at moves)", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const first = cache.readThrough(path);
    writeFileSync(path, SAMPLE_SPEC + "\n# trailing comment\n");
    const second = cache.readThrough(path);
    // Same name+version → same spec_id (UPDATE in place).
    expect(second.specId).toBe(first.specId);
    // But the row was updated.
    expect(second.sourceHash).not.toBe(first.sourceHash);
  });

  it("readThrough throws spec_file_missing when path doesn't exist", () => {
    try {
      cache.readThrough(join(tmp, "nonexistent.yaml"));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_file_missing");
    }
  });

  it("parseWorkflowSpec throws spec_yaml_invalid on broken YAML", () => {
    try {
      parseWorkflowSpec("workflow:\n  id: x\n  bad: : :", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_yaml_invalid");
    }
  });

  it("parseWorkflowSpec throws spec_field_missing when workflow.id absent", () => {
    try {
      parseWorkflowSpec("workflow:\n  version: 1\n  steps:\n    - id: a\n      actor_role: r\n  roles:\n    r: {}\n", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_field_missing");
    }
  });

  it("parseWorkflowSpec throws spec_field_missing when steps[] empty", () => {
    try {
      parseWorkflowSpec("workflow:\n  id: x\n  version: 1\n  steps: []\n  roles:\n    r: {}\n", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_field_missing");
    }
  });

  it("parseWorkflowSpec throws spec_field_missing when roles missing", () => {
    try {
      parseWorkflowSpec("workflow:\n  id: x\n  version: 1\n  steps:\n    - id: a\n      actor_role: r\n", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_field_missing");
    }
  });

  it("getByNameVersion returns null for unknown spec; returns row for cached spec", () => {
    expect(cache.getByNameVersion("none", "1")).toBeNull();
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const cached = cache.readThrough(path);
    const found = cache.getByNameVersion("test-three-step", "1");
    expect(found?.specId).toBe(cached.specId);
  });
});
