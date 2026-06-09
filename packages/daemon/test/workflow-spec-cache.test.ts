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

  // OPR.0.3.3.04.1 (AC-3): resolve a discovered built-in BY NAME to its stored,
  // already-resolved sourcePath - the seam that lets `workflow instantiate
  // <name>` work without a hidden file path.
  it("resolveSourcePathByName returns the cached spec's stored sourcePath; null for an unknown name", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC); // caches `test-three-step` with source_path=path
    cache.readThrough(path);
    expect(cache.resolveSourcePathByName("test-three-step")).toBe(path);
    expect(cache.resolveSourcePathByName("no-such-spec")).toBeNull();
  });

  it("resolveSourcePathByName excludes empty-version rows (slice-11 diagnostic shape)", () => {
    // Slice-11 diagnostic rows are keyed by file basename with an EMPTY version.
    // Inserted directly here (base workflow_specs schema, no status column) so
    // the test proves the `version != ''` guard without needing the slice-11
    // diagnostic migration. Name-resolution must NOT return such a row's path.
    db.prepare(
      `INSERT INTO workflow_specs
         (spec_id, name, version, purpose, target_rig, roles_json, steps_json,
          coordination_terminal_turn_rule, source_path, source_hash, cached_at)
       VALUES (?, ?, '', NULL, NULL, '{}', '[]', 'hot_potato', ?, ?, ?)`,
    ).run("diag-1", "broken.yaml", join(tmp, "broken.yaml"), "deadbeef", new Date().toISOString());
    expect(cache.resolveSourcePathByName("broken.yaml")).toBeNull();
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

  // OPR.0.3.2.22 Bug 4 — startup prune removes legacy cache rows whose
  // source_path lives in noise directories that walkYamlFiles' new
  // SKIP_DIRS guard now refuses to scan. Without this prune, stale
  // rows from before SKIP_DIRS shipped would survive forever and keep
  // showing up in `rig specs show` / `rig specs preview` candidates.
  it("pruneNoiseDirRows removes cache rows from .worktrees/node_modules paths and preserves canonical-path rows", () => {
    const fixtures: Array<{ path: string; specName: string; noise: boolean }> = [
      { path: join(tmp, "workflows", "canon.yaml"), specName: "canonical-spec", noise: false },
      { path: join(tmp, ".worktrees", "feature-branch", "workflows", "stale.yaml"), specName: "stale-worktree-spec", noise: true },
      { path: join(tmp, "node_modules", "@vendor", "spec", "stale.yaml"), specName: "stale-node-modules-spec", noise: true },
      { path: join(tmp, "dist", "stale.yaml"), specName: "stale-dist-spec", noise: true },
    ];
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    for (const f of fixtures) {
      mkdirSync(join(f.path, ".."), { recursive: true });
      writeFileSync(f.path, SAMPLE_SPEC.replace("test-three-step", f.specName));
      cache.readThrough(f.path);
    }

    expect(cache.listAll()).toHaveLength(4);

    const removed = cache.pruneNoiseDirRows();
    expect(removed, "expected 3 noise rows removed (.worktrees + node_modules + dist)").toBe(3);

    const remaining = cache.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sourcePath).toBe(fixtures[0]!.path);
  });

  it("pruneNoiseDirRows returns 0 when there are no noise rows", () => {
    const canonicalPath = join(tmp, "workflows", "canon.yaml");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(canonicalPath, ".."), { recursive: true });
    writeFileSync(canonicalPath, SAMPLE_SPEC);
    cache.readThrough(canonicalPath);

    expect(cache.pruneNoiseDirRows()).toBe(0);
    expect(cache.listAll()).toHaveLength(1);
  });

  // OPR.0.3.2.22 Bug 4 follow-up (guard BLOCKING on 79d06f8d) —
  // shipped built-in workflow specs live at
  // `<pkg>/dist/builtins/workflow-specs/` in production
  // npm-published daemons. The unscoped prune from the prior commit
  // matched `%/dist/%` and would have nuked every built-in on every
  // boot. The installRoot guard preserves rows whose source_path
  // starts with the install root.
  it("pruneNoiseDirRows with installRoot preserves built-in rows under <installRoot>/dist while removing user noise", () => {
    const installRoot = join(tmp, "install", "@openrig", "daemon");
    const builtinPath = join(installRoot, "dist", "builtins", "workflow-specs", "shipped.yaml");
    const userNoisePath = join(tmp, "user-workspace", "some-project", "dist", "stale.yaml");

    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    for (const p of [builtinPath, userNoisePath]) {
      mkdirSync(join(p, ".."), { recursive: true });
    }
    writeFileSync(builtinPath, SAMPLE_SPEC.replace("test-three-step", "shipped-builtin-spec"));
    writeFileSync(userNoisePath, SAMPLE_SPEC.replace("test-three-step", "user-noise-spec"));
    cache.readThrough(builtinPath);
    cache.readThrough(userNoisePath);

    expect(cache.listAll()).toHaveLength(2);

    const removed = cache.pruneNoiseDirRows(installRoot);
    expect(removed, "expected only the user-noise row removed; built-in must survive").toBe(1);

    const remaining = cache.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sourcePath).toBe(builtinPath);
  });
});
