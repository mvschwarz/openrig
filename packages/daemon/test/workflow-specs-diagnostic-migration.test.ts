// Slice 11 (workflow-spec-folder-discovery) — migration 040
// adds status + error_message columns to workflow_specs. WorkflowSpecCache
// gains writeDiagnostic / removeBySourcePath / queryDiagnostics methods
// so the scanner can record invalid YAML as diagnostic rows.
//
// SC-29 #10 (verbatim, declared in commit body):
// "Slice 11 (workflow-spec-folder-discovery) requires schema migration
// 040_workflow_specs_diagnostic.ts adding status TEXT DEFAULT 'valid' +
// error_message TEXT columns to the workflow_specs cache. No new table,
// no constraint changes beyond default; ALTER TABLE ADD COLUMN preserves
// existing rows (default 'valid' fills retroactively for already-cached
// rows). Read-only diagnostic surface — the cache stores parser/validator
// errors so the Library UI can render them; daemon does not act on the
// diagnostic state. Per IMPL-PRD §HG-8 'unless provenance / status
// columns require migration — declare upfront if so': declared upfront
// in this slice's ACK + commit body."

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe("migration 040 — workflow_specs diagnostic columns", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });
  afterEach(() => {
    db.close();
  });

  it("adds status TEXT DEFAULT 'valid' column to workflow_specs", () => {
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    const cols = db.prepare("PRAGMA table_info(workflow_specs)").all() as ColumnRow[];
    const status = cols.find((c) => c.name === "status");
    expect(status).toBeDefined();
    expect(status?.type.toUpperCase()).toBe("TEXT");
    // SQLite default value escaping: 'valid' is stored as the string literal
    expect(status?.dflt_value).toMatch(/'valid'|valid/);
  });

  it("adds error_message TEXT (nullable) column to workflow_specs", () => {
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    const cols = db.prepare("PRAGMA table_info(workflow_specs)").all() as ColumnRow[];
    const errorMessage = cols.find((c) => c.name === "error_message");
    expect(errorMessage).toBeDefined();
    expect(errorMessage?.type.toUpperCase()).toBe("TEXT");
    expect(errorMessage?.notnull).toBe(0);
  });

  it("existing rows retain valid status by default after migration applies", () => {
    // Apply pre-040 schema, insert a row, then apply 040; the row's
    // status should default to 'valid' since the existing read-through
    // path never set it.
    migrate(db, [coreSchema, workflowSpecsSchema]);
    db.prepare(
      `INSERT INTO workflow_specs (spec_id, name, version, purpose, target_rig, roles_json, steps_json, coordination_terminal_turn_rule, source_path, source_hash, cached_at)
       VALUES ('s1', 'pre-040', '1.0', null, null, '{}', '[]', 'hot_potato', '/x.yaml', 'h', '2026-05-11T00:00:00Z')`,
    ).run();
    migrate(db, [workflowSpecsDiagnosticSchema]);
    const row = db
      .prepare("SELECT status, error_message FROM workflow_specs WHERE spec_id = ?")
      .get("s1") as { status: string; error_message: string | null };
    expect(row.status).toBe("valid");
    expect(row.error_message).toBeNull();
  });

  it("migration is idempotent (re-applying does not error)", () => {
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    // Re-applying should be a no-op (ALTER TABLE ADD COLUMN IF NOT EXISTS).
    expect(() => {
      migrate(db, [workflowSpecsDiagnosticSchema]);
    }).not.toThrow();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";

const VALID_DIAG_SAMPLE = `workflow:
  id: valid-spec
  version: '1'
  objective: test fixture
  target:
    rig: rig-fix
  entry:
    role: a
  roles:
    a:
      preferred_targets:
        - a@rig-fix
  steps:
    - id: s1
      actor_role: a
      objective: x
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

describe("WorkflowSpecCache diagnostic methods (slice 11)", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(joinPath(tmpdir(), "wf-diag-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeDiagnostic stores an error row keyed by source_path", () => {
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h1",
      errorMessage: "YAML parse error at line 3",
    });
    const row = db
      .prepare(
        `SELECT name, status, error_message, source_path
         FROM workflow_specs WHERE source_path = ?`,
      )
      .get("/x/broken.yaml") as {
        name: string;
        status: string;
        error_message: string;
        source_path: string;
      };
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("YAML parse error at line 3");
    expect(row.source_path).toBe("/x/broken.yaml");
    // Name uses the file basename as a fallback so the Library can render
    // a row identifier even when YAML couldn't be parsed.
    expect(row.name).toBe("broken.yaml");
  });

  it("writeDiagnostic updates an existing diagnostic row in-place by source_path", () => {
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h1",
      errorMessage: "first error",
    });
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h2",
      errorMessage: "second error after edit",
    });
    const rows = db
      .prepare(`SELECT * FROM workflow_specs WHERE source_path = ?`)
      .all("/x/broken.yaml") as Array<{ error_message: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error_message).toBe("second error after edit");
  });

  it("removeBySourcePath removes both valid and diagnostic rows", () => {
    cache.writeDiagnostic({
      sourcePath: "/x/gone.yaml",
      sourceHash: "h",
      errorMessage: "err",
    });
    const removed = cache.removeBySourcePath("/x/gone.yaml");
    expect(removed).toBe(1);
    const remaining = db
      .prepare(`SELECT COUNT(*) as n FROM workflow_specs WHERE source_path = ?`)
      .get("/x/gone.yaml") as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("removeBySourcePath returns 0 when no row exists", () => {
    expect(cache.removeBySourcePath("/never/exists.yaml")).toBe(0);
  });

  it("listAll surfaces both valid and diagnostic rows", () => {
    const validPath = joinPath(tmp, "valid.yaml");
    writeFileSync(validPath, VALID_DIAG_SAMPLE);
    cache.readThrough(validPath);
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h",
      errorMessage: "err",
    });
    const all = cache.listAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((r) => r.name === "valid-spec")).toBe(true);
    expect(all.some((r) => r.name === "broken.yaml")).toBe(true);
  });
});
