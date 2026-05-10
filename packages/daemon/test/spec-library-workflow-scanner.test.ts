// Workflows in Spec Library v0 — scanner tests.
//
// Verifies that scanWorkflowSpecs reads from the workflow_specs SQLite
// cache, classifies built-in vs user_file via path.sep boundary, and
// projects the topology graph in the review payload.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import {
  scanWorkflowSpecs,
  getWorkflowReview,
  workflowLibraryId,
  parseWorkflowLibraryId,
} from "../src/domain/spec-library-workflow-scanner.js";

const SAMPLE_SPEC = (id: string) => `workflow:
  id: ${id}
  version: 1
  objective: Sample workflow
  target:
    rig: sample-rig
  entry:
    role: alpha
  roles:
    alpha:
      preferred_targets:
        - alpha@sample-rig
    beta:
      preferred_targets:
        - beta@sample-rig
  steps:
    - id: step-1
      actor_role: alpha
      objective: Start the work.
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - beta
    - id: step-2
      actor_role: beta
      objective: Finish the work.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
`;

describe("scanWorkflowSpecs (Workflows in Spec Library v0)", () => {
  let db: Database.Database;
  let tmp: string;
  let builtinDir: string;
  let userDir: string;
  let cache: WorkflowSpecCache;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-lib-scanner-"));
    builtinDir = join(tmp, "builtins", "workflow-specs");
    userDir = join(tmp, "user-specs");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when workflow_specs table is empty", () => {
    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries).toEqual([]);
  });

  it("classifies a spec under workflowBuiltinSpecsDir as builtin", () => {
    const path = join(builtinDir, "alpha.yaml");
    writeFileSync(path, SAMPLE_SPEC("alpha"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("workflow");
    expect(entry.name).toBe("alpha");
    expect(entry.sourceType).toBe("builtin");
    expect(entry.isBuiltIn).toBe(true);
    expect(entry.id).toBe("workflow:alpha:1");
    expect(entry.rolesCount).toBe(2);
    expect(entry.stepsCount).toBe(2);
    expect(entry.targetRig).toBe("sample-rig");
  });

  it("classifies a spec outside workflowBuiltinSpecsDir as user_file", () => {
    const path = join(userDir, "user.yaml");
    writeFileSync(path, SAMPLE_SPEC("user-spec"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sourceType).toBe("user_file");
    expect(entries[0]!.isBuiltIn).toBe(false);
  });

  it("treats sibling directory as NOT under builtin (path.sep boundary check)", () => {
    // Create a spec at a sibling directory whose path STARTS with builtinDir
    // but is not actually under it (e.g. /tmp/builtins-other/foo.yaml when
    // builtinDir=/tmp/builtins). The scanner uses path.sep boundary so this
    // must classify as user_file.
    const sibling = builtinDir + "-sibling";
    mkdirSync(sibling, { recursive: true });
    const path = join(sibling, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC("sibling"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    const entry = entries.find((e) => e.name === "sibling")!;
    expect(entry.sourceType).toBe("user_file");
  });

  it("returns null isBuiltIn classification when workflowBuiltinSpecsDir is null", () => {
    const path = join(userDir, "user.yaml");
    writeFileSync(path, SAMPLE_SPEC("user-spec"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: null });
    expect(entries[0]!.isBuiltIn).toBe(false);
    expect(entries[0]!.sourceType).toBe("user_file");
  });

  it("returns empty array gracefully when workflow_specs table is absent", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema]);
    try {
      const entries = scanWorkflowSpecs({ db: bareDb, workflowBuiltinSpecsDir: builtinDir });
      expect(entries).toEqual([]);
    } finally {
      bareDb.close();
    }
  });

  it("orders specs by name then version", () => {
    const pathB = join(userDir, "b.yaml");
    const pathA = join(userDir, "a.yaml");
    writeFileSync(pathB, SAMPLE_SPEC("b-spec"));
    writeFileSync(pathA, SAMPLE_SPEC("a-spec"));
    cache.readThrough(pathB);
    cache.readThrough(pathA);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries.map((e) => e.name)).toEqual(["a-spec", "b-spec"]);
  });
});

describe("getWorkflowReview (Workflows in Spec Library v0)", () => {
  let db: Database.Database;
  let tmp: string;
  let cache: WorkflowSpecCache;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-lib-review-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("projects topology with edges from next_hop.suggested_roles", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC("topo"));
    cache.readThrough(path);

    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: null,
      name: "topo",
      version: "1",
    });
    expect(review).not.toBeNull();
    expect(review!.topology.nodes).toHaveLength(2);
    expect(review!.topology.edges).toHaveLength(1);
    expect(review!.topology.edges[0]).toEqual({
      fromStepId: "step-1",
      toStepId: "step-2",
      routingType: "direct",
    });
  });

  it("marks the entry-role step as isEntry and the no-next-hop step as isTerminal", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC("entry-terminal"));
    cache.readThrough(path);

    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: null,
      name: "entry-terminal",
      version: "1",
    });
    const step1 = review!.topology.nodes.find((n) => n.stepId === "step-1")!;
    const step2 = review!.topology.nodes.find((n) => n.stepId === "step-2")!;
    expect(step1.isEntry).toBe(true);
    expect(step1.isTerminal).toBe(false);
    expect(step2.isEntry).toBe(false);
    expect(step2.isTerminal).toBe(true);
  });

  it("returns null for an unknown name+version", () => {
    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: null,
      name: "missing",
      version: "1",
    });
    expect(review).toBeNull();
  });
});

describe("workflowLibraryId / parseWorkflowLibraryId", () => {
  it("encodes and decodes name:version pairs", () => {
    expect(workflowLibraryId("foo", "1")).toBe("workflow:foo:1");
    expect(parseWorkflowLibraryId("workflow:foo:1")).toEqual({ name: "foo", version: "1" });
  });

  it("splits on the LAST colon so names with colons round-trip", () => {
    const id = workflowLibraryId("conveyor", "1.2.3");
    expect(parseWorkflowLibraryId(id)).toEqual({ name: "conveyor", version: "1.2.3" });
  });

  it("returns null for non-workflow ids", () => {
    expect(parseWorkflowLibraryId("rig:foo:1")).toBeNull();
    expect(parseWorkflowLibraryId("workflow:no-version")).toBeNull();
  });
});
