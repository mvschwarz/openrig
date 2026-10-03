// Slice 11 (release-0.3.1 workflow-spec-folder-discovery) — TDD for
// scanWorkflowSpecFolder. Walks workspace.specs_root/workflows/, parses
// + validates each YAML, populates the cache. Invalid YAML produces a
// diagnostic row via cache.writeDiagnostic. Deletions remove the cache
// row via cache.removeBySourcePath.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { scanWorkflowSpecFolder } from "../src/domain/spec-library-workflow-scanner.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const VALID_YAML = `workflow:
  id: folder-test
  version: '1'
  objective: A folder-scan fixture
  target:
    rig: folder-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@folder-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

const INVALID_YAML = `workflow:
  id: bad-spec
  # missing required 'version', 'roles', 'steps'
  objective: This will not parse cleanly
`;

const VALID_YAML_TWO = `workflow:
  id: folder-test-2
  version: '1'
  objective: second fixture
  target:
    rig: folder-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@folder-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

describe("scanWorkflowSpecFolder (slice 11)", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let folder: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db);
    folder = mkdtempSync(join(tmpdir(), "wf-folder-"));
  });
  afterEach(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("returns empty array when folder does not exist", () => {
    rmSync(folder, { recursive: true, force: true });
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result).toEqual({ scanned: 0, valid: 0, errors: 0, removed: 0, skipped: 0 });
  });

  it("scans a valid YAML file → row in cache + scan summary 1/1/0/0", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result).toEqual({ scanned: 1, valid: 1, errors: 0, removed: 0, skipped: 0 });
    const all = cache.listAll();
    const row = all.find((r) => r.name === "folder-test");
    expect(row).toBeDefined();
    expect(row?.sourcePath).toBe(join(folder, "wf.yaml"));
  });

  it("scans invalid YAML → diagnostic row + scan summary 1/0/1/0", () => {
    writeFileSync(join(folder, "bad.yaml"), INVALID_YAML);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result).toEqual({ scanned: 1, valid: 0, errors: 1, removed: 0, skipped: 0 });
    const row = db
      .prepare(
        `SELECT name, status, error_message FROM workflow_specs WHERE source_path = ?`,
      )
      .get(join(folder, "bad.yaml")) as {
        name: string;
        status: string;
        error_message: string;
      };
    expect(row.status).toBe("error");
    expect(row.error_message).toBeTruthy();
    expect(row.name).toBe("bad.yaml");
  });

  it("skips unchanged files on second scan via mtime check (OQ-3)", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    // Capture original cached_at then second scan; cached_at should not change.
    const before = db
      .prepare(`SELECT cached_at FROM workflow_specs WHERE name = ?`)
      .get("folder-test") as { cached_at: string };
    // Second scan should be a no-op for unchanged files.
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(1);
    // Skipped files don't count as valid (re-parse) or errors — they're
    // counted via a separate `skipped` field for observability.
    expect(result.skipped).toBe(1);
    expect(result.valid).toBe(0);
    const after = db
      .prepare(`SELECT cached_at FROM workflow_specs WHERE name = ?`)
      .get("folder-test") as { cached_at: string };
    expect(after.cached_at).toBe(before.cached_at);
  });

  it("re-parses when file mtime advances past cached_at", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    // Advance mtime so the file looks newer than the cache.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(folder, "wf.yaml"), future, future);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(1);
    expect(result.valid).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it.each(["valid-edit", "invalid-edit"])("re-reads a %s within the cached timestamp's second", (edit) => {
    const file = join(folder, "wf.yaml");
    writeFileSync(file, VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    const before = db.prepare("SELECT cached_at FROM workflow_specs WHERE source_path = ?").get(file) as {cached_at: string};
    writeFileSync(file, edit === "valid-edit" ? VALID_YAML.replace("A folder-scan fixture", "Updated objective") : INVALID_YAML);
    // Deterministic same-second timing, including a broken edit made
    // before the cached timestamp bucket has advanced.
    const sameSecond = new Date(Math.floor(Date.parse(before.cached_at) / 1000) * 1000 + 999);
    utimesSync(file, sameSecond, sameSecond);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.valid).toBe(edit === "valid-edit" ? 1 : 0);
    expect(result.errors).toBe(edit === "invalid-edit" ? 1 : 0);
    expect(result.skipped).toBe(0);
    // The row this scan wrote. An invalid edit keeps the cached valid version beside it (#503).
    const row = db.prepare("SELECT purpose, status, error_message FROM workflow_specs WHERE source_path = ? ORDER BY cached_at DESC, rowid DESC LIMIT 1").get(file) as {purpose: string; status: string; error_message: string|null};
    expect(row.status).toBe(edit === "valid-edit" ? "valid" : "error");
    if (edit === "valid-edit") expect(row.purpose).toBe("Updated objective");
    else expect(row.error_message).toBeTruthy();
    // Unchanged bytes still remain a skip on a second scan.
    const unchanged = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(unchanged.skipped).toBe(1);
  });

  it("hashes the same-second check the way the cache hashes (UTF-8 text)", () => {
    const file = join(folder, "wf.yaml");
    // A lone 0xFF byte hashes differently as raw bytes vs UTF-8 text; the
    // cache stores the text digest, so the check must compare the text digest.
    writeFileSync(file, Buffer.concat([Buffer.from(VALID_YAML, "utf-8"), Buffer.from([0xff])]));
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    const before = db.prepare("SELECT cached_at FROM workflow_specs WHERE source_path = ?").get(file) as {cached_at: string};
    // Unchanged content, mtime pinned inside the cached second bucket.
    const sameSecond = new Date(Math.floor(Date.parse(before.cached_at) / 1000) * 1000 + 999);
    utimesSync(file, sameSecond, sameSecond);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("keeps scanning the folder when recording one file's parse error fails", () => {
    writeFileSync(join(folder, "a-bad.yaml"), INVALID_YAML);
    writeFileSync(join(folder, "b-good.yaml"), VALID_YAML);
    cache.writeDiagnostic = () => { throw new Error("diagnostic write failed"); };
    let result: ReturnType<typeof scanWorkflowSpecFolder> | undefined;
    expect(() => { result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null }); }).not.toThrow();
    expect(result).toMatchObject({ scanned: 2, valid: 1, errors: 1 });
  });

  it("removes cache row when file disappears (OQ-4)", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    writeFileSync(join(folder, "wf2.yaml"), VALID_YAML_TWO);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(cache.listAll().filter((r) => r.sourcePath.startsWith(folder))).toHaveLength(2);
    // Delete wf.yaml; wf2.yaml stays.
    rmSync(join(folder, "wf.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.removed).toBe(1);
    const remaining = cache.listAll().filter((r) => r.sourcePath.startsWith(folder));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe("folder-test-2");
  });

  it("does NOT remove cache rows whose source_path is outside the scanned folder", () => {
    // Pre-seed a row from a different source root (e.g., built-in starter)
    // to confirm the scanner only acts on its own folder boundary.
    const externalPath = join(tmpdir(), "external-wf.yaml");
    writeFileSync(externalPath, VALID_YAML.replace("folder-test", "external-spec"));
    cache.readThrough(externalPath);
    // Now scan an empty folder — should NOT touch the external row.
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.removed).toBe(0);
    expect(cache.listAll().some((r) => r.name === "external-spec")).toBe(true);
    rmSync(externalPath);
  });

  it.each([
    ["project_a", "projectba"],
    ["project%a", "project-extra-a"],
  ])("only reaps literal folder %s, leaving neighboring %s cached", (ownName, neighborName) => {
    const owned = join(folder, ownName);
    const neighbor = join(folder, neighborName);
    mkdirSync(owned); mkdirSync(neighbor);
    const ownFile = join(owned, "owned.yaml");
    const liveNeighbor = join(neighbor, "external.yaml");
    const missingNeighbor = join(neighbor, "missing.yaml");
    writeFileSync(ownFile, VALID_YAML);
    writeFileSync(liveNeighbor, VALID_YAML.replace("folder-test", "external-workflow"));
    cache.readThrough(liveNeighbor);
    cache.writeDiagnostic({ sourcePath: missingNeighbor, sourceHash: "fixture", errorMessage: "Previously invalid external source" });
    scanWorkflowSpecFolder({ db, cache, folder: owned, builtinDir: null });
    rmSync(ownFile);
    const eventBus = new EventBus(db);
    const result = scanWorkflowSpecFolder({ db, cache, folder: owned, builtinDir: null, eventBus });
    expect(result.removed).toBe(1);
    const remaining = db.prepare("SELECT source_path FROM workflow_specs ORDER BY source_path").all() as {source_path: string}[];
    expect(remaining.map(row => row.source_path)).toEqual([liveNeighbor, missingNeighbor].sort());
    const events = db.prepare("SELECT payload FROM events WHERE type = 'workflow_spec.removed'").all() as {payload: string}[];
    expect(events.map(event => JSON.parse(event.payload).sourcePath)).toEqual([ownFile]);
  });

  it("emits workflow_spec.removed audit event for each deleted file (HG-3)", () => {
    // OQ-4 acceptance criterion: deletion produces BOTH cache row removal
    // AND audit-log entry. Without the event emission, the Library shows a
    // clean state but operators can't trace WHICH spec disappeared WHEN.
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    writeFileSync(join(folder, "wf2.yaml"), VALID_YAML_TWO);
    const eventBus = new EventBus(db);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });

    rmSync(join(folder, "wf.yaml"));
    const removedFilePath = join(folder, "wf.yaml");
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });
    expect(result.removed).toBe(1);

    const events = db
      .prepare(`SELECT type, payload FROM events WHERE type = 'workflow_spec.removed'`)
      .all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { type: string; sourcePath: string; reason: string };
    expect(payload.type).toBe("workflow_spec.removed");
    expect(payload.sourcePath).toBe(removedFilePath);
    expect(payload.reason).toBe("file_disappeared");
  });

  it("emits one workflow_spec.removed event per file when multiple disappear", () => {
    // Drift-discriminator for the emission loop: two distinct deletions must
    // produce two distinct events with distinct sourcePaths (not one batched
    // event nor one repeated).
    writeFileSync(join(folder, "a.yaml"), VALID_YAML);
    writeFileSync(join(folder, "b.yaml"), VALID_YAML_TWO);
    const eventBus = new EventBus(db);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });

    rmSync(join(folder, "a.yaml"));
    rmSync(join(folder, "b.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });
    expect(result.removed).toBe(2);

    const events = db
      .prepare(`SELECT payload FROM events WHERE type = 'workflow_spec.removed' ORDER BY seq`)
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    const paths = events.map((e) => (JSON.parse(e.payload) as { sourcePath: string }).sourcePath).sort();
    expect(paths).toEqual([join(folder, "a.yaml"), join(folder, "b.yaml")]);
  });

  it("does NOT emit workflow_spec.removed when eventBus is omitted (back-compat)", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    rmSync(join(folder, "wf.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.removed).toBe(1);
    const events = db
      .prepare(`SELECT COUNT(*) as n FROM events WHERE type = 'workflow_spec.removed'`)
      .get() as { n: number };
    expect(events.n).toBe(0);
  });

  it("drift-discriminator: same scan emits 3 distinct outcomes for 3 distinct files", () => {
    // Per banked feedback_poc_regression_must_discriminate — fixtures
    // distinct enough that the scanner's per-file decision branches are
    // observable.
    writeFileSync(join(folder, "valid.yaml"), VALID_YAML);
    writeFileSync(join(folder, "bad.yaml"), INVALID_YAML);
    // Pre-cache one row with a different name (simulates "previously
    // scanned but now removed") so the removal branch fires too.
    cache.writeDiagnostic({
      sourcePath: join(folder, "previously-here.yaml"),
      sourceHash: "h",
      errorMessage: "stale",
    });
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(2);
    expect(result.valid).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.removed).toBe(1);
  });
});

// A spec file whose cached versions include one still pinned by running work, then a parse
// error, then a repair (#503). Each write gets a later mtime and each scan caches one second after
// it, so the scanner's mtime check sees changed and unchanged files as it would on disk.
describe("scanWorkflowSpecFolder: parse error and repair with several cached versions", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let folder: string;
  let file: string;
  let tick: number;
  const base = Math.floor(Date.now() / 1000) - 1000;

  const versioned = (version: string) => VALID_YAML.replace("version: '1'", `version: '${version}'`);
  const BROKEN = "workflow:\n  id: folder-test\n  version: [unterminated\n";
  const scanAfterWriting = (content?: string) => {
    if (content !== undefined) {
      writeFileSync(file, content);
      tick += 10;
      utimesSync(file, base + tick, base + tick);
    }
    return scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
  };
  const rowsForFile = () => db
    .prepare(`SELECT spec_id, version, status FROM workflow_specs WHERE source_path = ? ORDER BY rowid`)
    .all(file) as Array<{ spec_id: string; version: string; status: string }>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db, () => new Date((base + tick + 1) * 1000));
    folder = mkdtempSync(join(tmpdir(), "wf-folder-versions-"));
    file = join(folder, "wf.yaml");
    tick = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("leaves no error row behind once the file parses again", () => {
    scanAfterWriting(versioned("1"));
    scanAfterWriting(versioned("2"));
    expect(scanAfterWriting(BROKEN).errors).toBe(1);
    expect(rowsForFile().some((row) => row.status === "error")).toBe(true);

    expect(scanAfterWriting(versioned("2")).valid).toBe(1);
    expect(rowsForFile().filter((row) => row.status === "error")).toEqual([]);
  });

  it("keeps every cached version, with its row and content, through the error and the repair", () => {
    scanAfterWriting(versioned("1"));
    scanAfterWriting(versioned("2"));
    // Row id and step count per cached version; null when that version can no longer be read.
    const versions = () => ["1", "2"].map((version) => {
      const row = cache.getByNameVersion("folder-test", version);
      return row ? { specId: row.specId, steps: row.spec.steps.length } : null;
    });
    const cached = versions();
    expect(cached.every(Boolean)).toBe(true);

    scanAfterWriting(BROKEN);
    expect(versions()).toEqual(cached);

    scanAfterWriting(versioned("2"));
    expect(versions()).toEqual(cached);
  });

  it("recovers a single cached version in place", () => {
    scanAfterWriting(versioned("1"));
    const [original] = rowsForFile();
    scanAfterWriting(BROKEN);
    scanAfterWriting(versioned("1"));
    expect(rowsForFile()).toEqual([{ spec_id: original!.spec_id, version: "1", status: "valid" }]);
  });

  it("skips a file restored to its cached bytes on the scan after the repair", () => {
    scanAfterWriting(versioned("1"));
    scanAfterWriting(BROKEN);
    expect(scanAfterWriting(versioned("1")).valid).toBe(1);
    expect(scanAfterWriting()).toMatchObject({ skipped: 1, valid: 0 });
  });

  it("still skips an unchanged broken file on the next scan", () => {
    scanAfterWriting(versioned("1"));
    scanAfterWriting(versioned("2"));
    scanAfterWriting(BROKEN);
    expect(scanAfterWriting()).toMatchObject({ skipped: 1, errors: 0 });
  });
});

// Installs upgraded from a release whose diagnostic writer blanked a cached version's columns
// but kept its spec_json. That row is the only surviving copy of the older version (#503).
describe("scanWorkflowSpecFolder: an older version damaged by the previous diagnostic writer", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let folder: string;
  let file: string;
  let tick: number;
  const base = Math.floor(Date.now() / 1000) - 1000;
  const v1 = VALID_YAML.replace("A folder-scan fixture", "version one");
  const v2 = VALID_YAML.replace("version: '1'", "version: '2'").replace("A folder-scan fixture", "version two");
  const scanAfterWriting = (content: string) => {
    writeFileSync(file, content);
    tick += 10;
    utimesSync(file, base + tick, base + tick);
    return scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
  };

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tick = 0;
    cache = new WorkflowSpecCache(db, () => new Date((base + tick + 1) * 1000));
    folder = mkdtempSync(join(tmpdir(), "wf-folder-legacy-"));
    file = join(folder, "wf.yaml");
  });
  afterEach(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("keeps the damaged row, its spec ID and its full stored spec through a repair", () => {
    scanAfterWriting(v1);
    scanAfterWriting(v2);
    const original = cache.getByNameVersion("folder-test", "1")!;
    const storedSpec = () => (db.prepare("SELECT spec_json FROM workflow_specs WHERE spec_id = ?").get(original.specId) as { spec_json: string } | undefined)?.spec_json;
    const storedBefore = storedSpec();
    expect(storedBefore).toBeTruthy();
    // The previous writer's in-place rewrite of the oldest row for the path (spec_json untouched).
    db.prepare(
      `UPDATE workflow_specs SET status = 'error', error_message = 'old parse error', name = 'wf.yaml', version = '',
         purpose = NULL, target_rig = NULL, roles_json = '{}', steps_json = '[]', coordination_terminal_turn_rule = 'hot_potato'
       WHERE spec_id = ?`,
    ).run(original.specId);

    expect(scanAfterWriting(v2).valid).toBe(1);

    expect(storedSpec()).toBe(storedBefore);
    expect(cache.getByIdOrThrow(original.specId).spec.objective).toBe("version one");
    expect(cache.getByNameVersion("folder-test", "2")?.spec.objective).toBe("version two");
  });
});
