// PL-004 Phase D: workflow spec cache (read-through from markdown/YAML
// to SQLite workflow_specs).
//
// Workflow specs are workspace-surface (markdown/YAML files on disk;
// human-authored). Daemon reads them lazily and caches in
// workflow_specs for fast lookup. Cache invalidation: source_hash on
// the spec file content; on next read, if the hash differs, re-cache.
//
// Workspace-surface reconciliation contract (per PRD § Workspace-
// surface reconciliation): valid operator edits to spec files win
// at next read; the cache is never the source of truth.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { parse as parseYaml } from "yaml";
import type { WorkflowSpec, WorkflowSpecRow } from "./workflow-types.js";

interface SpecRow {
  spec_id: string;
  name: string;
  version: string;
  purpose: string | null;
  target_rig: string | null;
  roles_json: string;
  steps_json: string;
  coordination_terminal_turn_rule: string;
  source_path: string;
  source_hash: string;
  cached_at: string;
}

export class WorkflowSpecError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowSpecError";
  }
}

/**
 * Parse a workflow spec from raw YAML content. The POC fixture shape
 * wraps everything under a top-level `workflow:` key:
 *
 *   workflow:
 *     id: ...
 *     version: ...
 *     roles: { ... }
 *     steps: [ ... ]
 *
 * Returns the parsed spec or throws WorkflowSpecError on malformed
 * YAML / missing required fields.
 */
export function parseWorkflowSpec(rawYaml: string, sourcePath: string): WorkflowSpec {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new WorkflowSpecError(
      "spec_yaml_invalid",
      `workflow spec at ${sourcePath} could not be parsed as YAML: ${err instanceof Error ? err.message : err}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowSpecError(
      "spec_shape_invalid",
      `workflow spec at ${sourcePath} must be a YAML mapping with a top-level 'workflow:' key`,
      { sourcePath },
    );
  }
  const root = parsed as Record<string, unknown>;
  const wf = root.workflow as Record<string, unknown> | undefined;
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
    throw new WorkflowSpecError(
      "spec_shape_invalid",
      `workflow spec at ${sourcePath} is missing the top-level 'workflow:' key`,
      { sourcePath },
    );
  }
  if (typeof wf.id !== "string" || wf.id.length === 0) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `workflow spec at ${sourcePath} is missing required field workflow.id`,
      { sourcePath, field: "workflow.id" },
    );
  }
  if (wf.version === undefined || wf.version === null) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `workflow spec at ${sourcePath} is missing required field workflow.version`,
      { sourcePath, field: "workflow.version" },
    );
  }
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `workflow spec at ${sourcePath} requires at least one step in workflow.steps[]`,
      { sourcePath, field: "workflow.steps" },
    );
  }
  if (!wf.roles || typeof wf.roles !== "object" || Array.isArray(wf.roles)) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `workflow spec at ${sourcePath} requires a workflow.roles mapping`,
      { sourcePath, field: "workflow.roles" },
    );
  }
  return {
    id: wf.id,
    version: String(wf.version),
    objective: typeof wf.objective === "string" ? wf.objective : undefined,
    target: wf.target as WorkflowSpec["target"],
    entry: wf.entry as WorkflowSpec["entry"],
    roles: wf.roles as WorkflowSpec["roles"],
    steps: wf.steps as WorkflowSpec["steps"],
    invariants: wf.invariants as WorkflowSpec["invariants"],
    closure: wf.closure as WorkflowSpec["closure"],
    loop_guards: wf.loop_guards as WorkflowSpec["loop_guards"],
    coordination_terminal_turn_rule:
      typeof wf.coordination_terminal_turn_rule === "string"
        ? wf.coordination_terminal_turn_rule
        : undefined,
  };
}

export class WorkflowSpecCache {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Read a workflow spec from disk through the cache. Returns the
   * cached row (re-caching if source_hash differs OR if the spec was
   * not previously cached).
   */
  readThrough(sourcePath: string): WorkflowSpecRow {
    if (!existsSync(sourcePath)) {
      throw new WorkflowSpecError(
        "spec_file_missing",
        `workflow spec file not found at ${sourcePath}`,
        { sourcePath },
      );
    }
    const raw = readFileSync(sourcePath, "utf-8");
    const sourceHash = createHash("sha256").update(raw).digest("hex");
    const spec = parseWorkflowSpec(raw, sourcePath);
    const existing = this.db
      .prepare(
        `SELECT * FROM workflow_specs WHERE name = ? AND version = ?`,
      )
      .get(spec.id, spec.version) as SpecRow | undefined;
    if (existing && existing.source_hash === sourceHash) {
      // readThrough is file-authoritative: return the freshly parsed
      // file spec so validation sees non-column metadata such as
      // workflow.entry and workflow.invariants.
      return rowToWorkflowSpec(existing, spec);
    }
    const cachedAt = this.now().toISOString();
    const purpose = spec.objective ?? null;
    const targetRig = spec.target?.rig ?? null;
    const rolesJson = JSON.stringify(spec.roles);
    const stepsJson = JSON.stringify(spec.steps);
    const coordinationTerminalTurnRule = spec.coordination_terminal_turn_rule ?? "hot_potato";
    if (existing) {
      // Update in place (same name+version, content changed).
      this.db
        .prepare(
          `UPDATE workflow_specs SET
             purpose = ?, target_rig = ?, roles_json = ?, steps_json = ?,
             coordination_terminal_turn_rule = ?, source_path = ?,
             source_hash = ?, cached_at = ?
           WHERE spec_id = ?`,
        )
        .run(
          purpose,
          targetRig,
          rolesJson,
          stepsJson,
          coordinationTerminalTurnRule,
          sourcePath,
          sourceHash,
          cachedAt,
          existing.spec_id,
        );
      return rowToWorkflowSpec({
        ...existing,
        purpose,
        target_rig: targetRig,
        roles_json: rolesJson,
        steps_json: stepsJson,
        coordination_terminal_turn_rule: coordinationTerminalTurnRule,
        source_path: sourcePath,
        source_hash: sourceHash,
        cached_at: cachedAt,
      }, spec);
    }
    const specId = ulid();
    this.db
      .prepare(
        `INSERT INTO workflow_specs (
           spec_id, name, version, purpose, target_rig,
           roles_json, steps_json, coordination_terminal_turn_rule,
           source_path, source_hash, cached_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        specId,
        spec.id,
        spec.version,
        purpose,
        targetRig,
        rolesJson,
        stepsJson,
        coordinationTerminalTurnRule,
        sourcePath,
        sourceHash,
        cachedAt,
      );
    return rowToWorkflowSpec({
      spec_id: specId,
      name: spec.id,
      version: spec.version,
      purpose,
      target_rig: targetRig,
      roles_json: rolesJson,
      steps_json: stepsJson,
      coordination_terminal_turn_rule: coordinationTerminalTurnRule,
      source_path: sourcePath,
      source_hash: sourceHash,
      cached_at: cachedAt,
    }, spec);
  }

  getByNameVersion(name: string, version: string): WorkflowSpecRow | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_specs WHERE name = ? AND version = ?`)
      .get(name, version) as SpecRow | undefined;
    return row ? rowToWorkflowSpec(row) : null;
  }

  /**
   * Lists every cached spec, ordered by name then version. Used by the
   * `GET /api/workflow/specs` endpoint. Cheap —
   * the workflow_specs table is bounded by the number of operator-
   * authored + built-in starter specs (single-host MVP).
   */
  listAll(): WorkflowSpecRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_specs ORDER BY name, version`)
      .all() as SpecRow[];
    return rows.map((row) => rowToWorkflowSpec(row));
  }

  /**
   * Slice 11 (workflow-spec-folder-discovery) — diagnostic row writer.
   * Used by scanWorkflowSpecFolder when YAML parse / validation fails
   * so the Library UI can render an error row at the same path the
   * user dropped a malformed workflow YAML into. The row's name field
   * falls back to the source file basename so the Library has a
   * stable label even when the YAML couldn't be parsed.
   *
   * Single-row-per-source_path semantics: writeDiagnostic on a path
   * that already has a row (valid or diagnostic) UPDATES the row's
   * status to 'error', error_message, source_hash, cached_at, and
   * resets the parsed payload fields to empty (the prior YAML is no
   * longer trusted). Round-trip between 'valid' and 'error' is
   * supported via the same path: a passing readThrough flips the
   * row back to 'valid' with parsed payload restored.
   */
  writeDiagnostic(opts: {
    sourcePath: string;
    sourceHash: string;
    errorMessage: string;
  }): void {
    const cachedAt = this.now().toISOString();
    const fallbackName = opts.sourcePath.split("/").pop() ?? opts.sourcePath;
    const existing = this.db
      .prepare(`SELECT spec_id FROM workflow_specs WHERE source_path = ?`)
      .get(opts.sourcePath) as { spec_id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE workflow_specs SET
             status = 'error',
             error_message = ?,
             name = ?,
             version = '',
             purpose = NULL,
             target_rig = NULL,
             roles_json = '{}',
             steps_json = '[]',
             coordination_terminal_turn_rule = 'hot_potato',
             source_hash = ?,
             cached_at = ?
           WHERE spec_id = ?`,
        )
        .run(opts.errorMessage, fallbackName, opts.sourceHash, cachedAt, existing.spec_id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO workflow_specs (
           spec_id, name, version, purpose, target_rig,
           roles_json, steps_json, coordination_terminal_turn_rule,
           source_path, source_hash, cached_at, status, error_message
         ) VALUES (?, ?, '', NULL, NULL, '{}', '[]', 'hot_potato', ?, ?, ?, 'error', ?)`,
      )
      .run(ulid(), fallbackName, opts.sourcePath, opts.sourceHash, cachedAt, opts.errorMessage);
  }

  /**
   * Slice 11 — remove cache row by source_path (used when scanner
   * detects a workflow YAML was deleted from disk). Returns the
   * number of rows removed (0 when no row exists for that path).
   */
  removeBySourcePath(sourcePath: string): number {
    const result = this.db
      .prepare(`DELETE FROM workflow_specs WHERE source_path = ?`)
      .run(sourcePath);
    return result.changes;
  }

  getByIdOrThrow(specId: string): WorkflowSpecRow {
    const row = this.db
      .prepare(`SELECT * FROM workflow_specs WHERE spec_id = ?`)
      .get(specId) as SpecRow | undefined;
    if (!row) {
      throw new WorkflowSpecError(
        "spec_not_found",
        `workflow spec ${specId} not found in cache`,
        { specId },
      );
    }
    return rowToWorkflowSpec(row);
  }
}

function rowToWorkflowSpec(row: SpecRow, parsedSpec?: WorkflowSpec): WorkflowSpecRow {
  const roles = JSON.parse(row.roles_json) as WorkflowSpec["roles"];
  const steps = JSON.parse(row.steps_json) as WorkflowSpec["steps"];
  const spec: WorkflowSpec = parsedSpec
    ? {
        ...parsedSpec,
        coordination_terminal_turn_rule:
          parsedSpec.coordination_terminal_turn_rule ?? row.coordination_terminal_turn_rule,
      }
    : {
        id: row.name,
        version: row.version,
        objective: row.purpose ?? undefined,
        target: row.target_rig ? { rig: row.target_rig } : undefined,
        roles,
        steps,
        coordination_terminal_turn_rule: row.coordination_terminal_turn_rule,
      };
  return {
    specId: row.spec_id,
    name: row.name,
    version: row.version,
    purpose: row.purpose,
    targetRig: row.target_rig,
    spec,
    coordinationTerminalTurnRule: row.coordination_terminal_turn_rule,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    cachedAt: row.cached_at,
  };
}
