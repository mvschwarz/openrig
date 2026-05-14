// Built-in workflow spec loader tests.
//
// Drives the loader against a temp builtin directory + an in-memory
// workflow_specs cache so the test stays deterministic and parallel-safe.
// Pins the load-bearing behaviors:
//
//   - cold start with N specs: all N seeded
//   - re-run on already-cached spec: SKIPPED (no clobber of operator
//     overrides under workspace-surface reconciliation)
//   - operator override at workspace path: SKIPPED + source_path in
//     cache stays the operator's path
//   - malformed spec file: error collected, not thrown; other specs
//     in the same dir still load
//   - missing builtin dir: empty result, no throw (graceful)
//   - non-yaml files in dir: silently ignored

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { loadStarterWorkflowSpecs, defaultBuiltinSpecsDir } from "../src/domain/workflow/starter-spec-loader.js";
import { projectSpecGraph } from "../src/domain/workflow/slice-workflow-projection.js";

const ALPHA_SPEC = `workflow:
  id: alpha-spec
  version: 1
  objective: alpha test
  roles:
    a:
      preferred_targets: [a@r]
  steps:
    - id: only
      actor_role: a
      allowed_exits: [handoff]
`;

const BETA_SPEC = `workflow:
  id: beta-spec
  version: 1
  objective: beta test
  roles:
    b:
      preferred_targets: [b@r]
  steps:
    - id: only
      actor_role: b
      allowed_exits: [handoff]
`;

describe("built-in workflow spec loader", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let builtinDir: string;
  let cleanupRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    cleanupRoot = mkdtempSync(join(tmpdir(), "starter-loader-"));
    builtinDir = join(cleanupRoot, "workflow-specs");
    require("node:fs").mkdirSync(builtinDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  it("returns empty result with no throw when builtinDir doesn't exist", () => {
    const missing = join(cleanupRoot, "definitely-missing");
    const result = loadStarterWorkflowSpecs({ cache, builtinDir: missing });
    expect(result).toEqual({ loaded: [], skipped: [], errors: [] });
  });

  it("cold start: seeds every .yaml spec in the directory", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "beta.yaml"), BETA_SPEC);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded).toHaveLength(2);
    expect(result.loaded.map((r) => r.name).sort()).toEqual(["alpha-spec", "beta-spec"]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // Confirm the cache actually has them.
    expect(cache.getByNameVersion("alpha-spec", "1")).not.toBeNull();
    expect(cache.getByNameVersion("beta-spec", "1")).not.toBeNull();
  });

  it("idempotent: second call skips already-cached specs (no clobber)", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    const first = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(first.loaded).toHaveLength(1);
    const second = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(second.loaded).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.name).toBe("alpha-spec");
  });

  it("operator override (workspace-surface reconciliation): existing cache row at non-builtin source_path wins; loader does NOT overwrite", () => {
    // Operator authors a spec at a "workspace" path with same (name, version)
    // and reads it through the cache first (simulates operator workflow).
    const operatorPath = join(cleanupRoot, "operator-override-alpha.yaml");
    writeFileSync(operatorPath, ALPHA_SPEC);
    cache.readThrough(operatorPath);
    const beforeRow = cache.getByNameVersion("alpha-spec", "1");
    expect(beforeRow?.sourcePath).toBe(operatorPath);

    // Now the daemon starts and runs the starter loader on the bundled
    // builtin dir, which contains the same (name, version).
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });

    // Loader skipped (operator wins).
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.sourcePathInCache).toBe(operatorPath);

    // Cache row's source_path is STILL the operator's path — not the
    // bundled built-in path (workspace-surface reconciliation preserved).
    const afterRow = cache.getByNameVersion("alpha-spec", "1");
    expect(afterRow?.sourcePath).toBe(operatorPath);
  });

  it("malformed spec file: error collected, other specs in same dir still load", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "broken.yaml"), "this is: not [a valid spec");
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded.map((r) => r.name)).toEqual(["alpha-spec"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourcePath).toContain("broken.yaml");
    // Cache has alpha but NOT broken (which has no name to begin with).
    expect(cache.getByNameVersion("alpha-spec", "1")).not.toBeNull();
  });

  it("non-yaml files in dir are silently ignored (.md, .txt, .json)", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "README.md"), "# notes about the bundled specs");
    writeFileSync(join(builtinDir, "scratch.txt"), "ignore me");
    writeFileSync(join(builtinDir, "metadata.json"), `{"hint":"ignored"}`);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.name).toBe("alpha-spec");
    expect(result.errors).toEqual([]);
  });

  it("supports both .yaml and .yml extensions", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "beta.yml"), BETA_SPEC);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded.map((r) => r.name).sort()).toEqual(["alpha-spec", "beta-spec"]);
  });
});
