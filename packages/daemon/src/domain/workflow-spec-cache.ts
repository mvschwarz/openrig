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
import { WORKFLOW_AGENT_HARNESSES, WORKFLOW_EXIT_KINDS } from "./workflow-types.js";

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
  /**
   * OPR.0.4.6.WF1 (migration 050): the FULL parsed spec. NULL on
   * legacy rows (pre-050 cache writes) — those degrade to the
   * column-only reconstruction and self-heal on next readThrough.
   */
  spec_json?: string | null;
}

/** Defensive column probe (the detectQueueColumn house pattern) —
 *  older test fixtures bypass the canonical migration list, so
 *  spec_json (migration 050) may be absent. */
function detectSpecColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db
      .prepare("PRAGMA table_info(workflow_specs)")
      .all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
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
 * OPR.0.4.6.WF1 FR-7 — THE closed keysets, EXPORTED as named
 * constants: parseWorkflowSpec is the ONLY seam that sees raw keys
 * (the validator operates on the typed spec and can never see dropped
 * keys), so unknown-key rejection lands here — and WF-2's new fields
 * (next_hop.on / harness / host / gate) EXTEND these constants rather
 * than re-plumbing the parser.
 */
export const WORKFLOW_TOP_LEVEL_KEYS = [
  "id",
  "version",
  "objective",
  "target",
  "entry",
  "roles",
  "steps",
  "invariants",
  "closure",
  "loop_guards",
  // OPR.0.4.6.WF5 FR-2: the maturity dial's spec-declared routing surface.
  "exception_routing",
  "coordination_terminal_turn_rule",
] as const;
export const WORKFLOW_STEP_KEYS = [
  "id",
  "actor_role",
  "objective",
  "allowed_exits",
  "next_hop",
  // OPR.0.4.6.WF2: `gates` is deliberately NOT in this list — it is
  // REMOVED with a specific migration error (checked before the
  // unknown-key sweep so authors get the what/why/fix, not a generic
  // unknown-key rejection).
  "harness",
  "host",
  "gate",
] as const;
export const WORKFLOW_ROLE_KEYS = ["skill_refs", "preferred_targets"] as const;
export const WORKFLOW_NEXT_HOP_KEYS = ["mode", "suggested_roles", "on"] as const;
export const WORKFLOW_GATE_KEYS = ["target", "summary", "evidence_ref"] as const;
export const WORKFLOW_TARGET_KEYS = ["rig"] as const;
export const WORKFLOW_ENTRY_KEYS = ["role"] as const;
export const WORKFLOW_INVARIANTS_KEYS = [
  "continuation_required",
  "allowed_exits",
  "preserve_lineage",
  "closure_required",
] as const;
export const WORKFLOW_CLOSURE_KEYS = ["success", "degraded", "failed"] as const;
export const WORKFLOW_LOOP_GUARDS_KEYS = ["max_hops", "spawn_budget"] as const;
/** OPR.0.4.6.WF5 FR-2: the dial grammar keyset (WF-2 strictness rail —
 *  unknown keys reject loud naming this set). */
export const WORKFLOW_EXCEPTION_ROUTING_KEYS = [
  "default",
  "orchestrator_role",
  "classes",
] as const;

/** FR-7: reject unknown keys loud (what/why/fix) instead of the
 *  pre-0.4.6 silent drop. Applied only to object-shaped nodes; shape
 *  errors on non-objects stay the concern of the existing checks. */
function rejectUnknownKeys(
  node: unknown,
  allowed: readonly string[],
  path: string,
  sourcePath: string,
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw new WorkflowSpecError(
        "spec_unknown_key",
        `workflow spec at ${sourcePath}: unknown key "${key}" at ${path}. Allowed keys: [${allowed.join(", ")}]. Unknown keys were silently DROPPED before 0.4.6 (the spec looked accepted while the field did nothing); they now fail loud — remove the key or fix its spelling.`,
        { sourcePath, path, key, allowed: [...allowed] },
      );
    }
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
 * YAML / missing required fields. FR-7: unknown keys at every level
 * are rejected loud against the exported closed keysets above.
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

  // FR-7: strict unknown-key rejection at every level — INCLUDING the
  // document root (guard blocker 2 recipe): only `workflow:` may sit
  // at the YAML root; a stray root sibling was silently ignored.
  rejectUnknownKeys(root, ["workflow"], "(document root)", sourcePath);
  rejectUnknownKeys(wf, WORKFLOW_TOP_LEVEL_KEYS, "workflow", sourcePath);

  // FR-6/FR-7 (guard blocker 2): loop_guards SHAPE validation at the
  // raw seam. A nonnumeric max_hops would sanction a cycle at
  // validation while the runtime comparison coerces to NaN and never
  // trips — reopening the unbounded-loop class. Reject loud here, the
  // only place that sees the raw value.
  if (wf.loop_guards && typeof wf.loop_guards === "object" && !Array.isArray(wf.loop_guards)) {
    const lg = wf.loop_guards as Record<string, unknown>;
    // Normalize YAML `key: null` to ABSENT — a null that survived into
    // the typed spec would coerce to 0 in the projection comparison
    // and trip every first handoff.
    if (lg.max_hops === null) delete lg.max_hops;
    if (lg.spawn_budget === null) delete lg.spawn_budget;
    if (lg.max_hops !== undefined) {
      if (typeof lg.max_hops !== "number" || !Number.isInteger(lg.max_hops) || lg.max_hops < 1) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `workflow spec at ${sourcePath}: workflow.loop_guards.max_hops must be an integer >= 1 (got ${JSON.stringify(lg.max_hops)}). A non-numeric or non-positive guard can never trip at projection, so it cannot sanction a cycle — fix the value or remove the key.`,
          { sourcePath, field: "workflow.loop_guards.max_hops", value: lg.max_hops },
        );
      }
    }
    if (lg.spawn_budget !== undefined) {
      if (typeof lg.spawn_budget !== "number" || !Number.isInteger(lg.spawn_budget) || lg.spawn_budget < 0) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `workflow spec at ${sourcePath}: workflow.loop_guards.spawn_budget must be an integer >= 0 (got ${JSON.stringify(lg.spawn_budget)}).`,
          { sourcePath, field: "workflow.loop_guards.spawn_budget", value: lg.spawn_budget },
        );
      }
    }
  }
  // OPR.0.4.6.WF5 FR-2: the dial grammar at the raw seam. Positions are
  // the closed value space; classes keys are the closed FR-1 class set
  // MINUS human_gate_trip (intrinsically human-only — a config line
  // claiming otherwise would silently lie, so it rejects loud).
  if (wf.exception_routing !== undefined) {
    const er = wf.exception_routing;
    if (!er || typeof er !== "object" || Array.isArray(er)) {
      throw new WorkflowSpecError(
        "spec_field_invalid",
        `workflow spec at ${sourcePath}: workflow.exception_routing must be a mapping (got ${JSON.stringify(er)}). Declare default / orchestrator_role / classes, or remove the key for the host-default → orchestrator-first chain.`,
        { sourcePath, field: "workflow.exception_routing" },
      );
    }
    rejectUnknownKeys(er, WORKFLOW_EXCEPTION_ROUTING_KEYS, "workflow.exception_routing", sourcePath);
    const erm = er as Record<string, unknown>;
    const validPosition = (v: unknown): boolean => v === "orchestrator" || v === "human_only";
    if (erm.default !== undefined && !validPosition(erm.default)) {
      throw new WorkflowSpecError(
        "spec_field_invalid",
        `workflow spec at ${sourcePath}: workflow.exception_routing.default must be "orchestrator" or "human_only" (got ${JSON.stringify(erm.default)}).`,
        { sourcePath, field: "workflow.exception_routing.default", value: erm.default },
      );
    }
    if (erm.orchestrator_role !== undefined && (typeof erm.orchestrator_role !== "string" || erm.orchestrator_role.length === 0)) {
      throw new WorkflowSpecError(
        "spec_field_invalid",
        `workflow spec at ${sourcePath}: workflow.exception_routing.orchestrator_role must be a non-empty declared role name (got ${JSON.stringify(erm.orchestrator_role)}). Role EXISTENCE is the validator's graph check.`,
        { sourcePath, field: "workflow.exception_routing.orchestrator_role", value: erm.orchestrator_role },
      );
    }
    if (erm.classes !== undefined) {
      const cls = erm.classes;
      if (!cls || typeof cls !== "object" || Array.isArray(cls)) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `workflow spec at ${sourcePath}: workflow.exception_routing.classes must be a mapping of exception class → position (got ${JSON.stringify(cls)}).`,
          { sourcePath, field: "workflow.exception_routing.classes" },
        );
      }
      for (const [k, v] of Object.entries(cls as Record<string, unknown>)) {
        if (k === "human_gate_trip") {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `workflow spec at ${sourcePath}: workflow.exception_routing.classes.human_gate_trip is not configurable — a human gate is intrinsically human-only (the human decision IS the exception); the dial cannot re-point it. Remove the line.`,
            { sourcePath, field: "workflow.exception_routing.classes.human_gate_trip" },
          );
        }
        if (k !== "unmapped_failed" && k !== "stuck_overdue") {
          throw new WorkflowSpecError(
            "spec_unknown_key",
            `workflow spec at ${sourcePath}: workflow.exception_routing.classes.${k} is not a known exception class. Allowed: unmapped_failed, stuck_overdue.`,
            { sourcePath, field: `workflow.exception_routing.classes.${k}` },
          );
        }
        if (!validPosition(v)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `workflow spec at ${sourcePath}: workflow.exception_routing.classes.${k} must be "orchestrator" or "human_only" (got ${JSON.stringify(v)}).`,
            { sourcePath, field: `workflow.exception_routing.classes.${k}`, value: v },
          );
        }
      }
    }
  }
  rejectUnknownKeys(wf.target, WORKFLOW_TARGET_KEYS, "workflow.target", sourcePath);
  rejectUnknownKeys(wf.entry, WORKFLOW_ENTRY_KEYS, "workflow.entry", sourcePath);
  rejectUnknownKeys(
    wf.invariants,
    WORKFLOW_INVARIANTS_KEYS,
    "workflow.invariants",
    sourcePath,
  );
  rejectUnknownKeys(wf.closure, WORKFLOW_CLOSURE_KEYS, "workflow.closure", sourcePath);
  rejectUnknownKeys(
    wf.loop_guards,
    WORKFLOW_LOOP_GUARDS_KEYS,
    "workflow.loop_guards",
    sourcePath,
  );
  for (const [roleName, role] of Object.entries(
    wf.roles as Record<string, unknown>,
  )) {
    rejectUnknownKeys(role, WORKFLOW_ROLE_KEYS, `workflow.roles.${roleName}`, sourcePath);
  }
  (wf.steps as unknown[]).forEach((step, idx) => {
    if (step && typeof step === "object" && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      // OPR.0.4.6.WF2 FR-5: the legacy `gates: [...]` string list is
      // REMOVED at parse — checked BEFORE the unknown-key sweep so the
      // author gets the specific migration recipe, not a generic
      // rejection. Safe for pinned in-flight instances by FR-6
      // versioning honesty (they complete un-failed; re-validation of
      // the FILE teaches the new shape).
      if (s.gates !== undefined) {
        throw new WorkflowSpecError(
          "spec_gates_removed",
          `workflow spec at ${sourcePath}: workflow.steps[${idx}].gates is removed in 0.4.6. The string list could not carry a target/summary/evidence without becoming a magic-string mini-grammar, and it was never enforced. Declare the structured step-level gate instead:\n  gate:\n    target: <human seat session or declared role name>\n    summary: <plain-language ask>          # required for a human target\n    evidence_ref: <durable artifact path>  # required for a human target`,
          { sourcePath, path: `workflow.steps[${idx}].gates` },
        );
      }
      // OPR.0.4.6.WF2 FR-4: `next_hop.mode: prefer` is REMOVED — it
      // never had distinct behavior (identical to omitting mode), the
      // inert third state dies. Specific migration error before the
      // shape checks below.
      const nh = s.next_hop as Record<string, unknown> | undefined;
      if (nh && typeof nh === "object" && !Array.isArray(nh) && nh.mode === "prefer") {
        throw new WorkflowSpecError(
          "spec_prefer_mode_removed",
          `workflow spec at ${sourcePath}: workflow.steps[${idx}].next_hop.mode "prefer" is removed in 0.4.6. It never had distinct behavior — routing treated it identically to omitting mode. Delete the mode line (same routing), or use "require" (route ONLY via suggested_roles; no declaration-order fallback) / "forbid" (terminal step).`,
          { sourcePath, path: `workflow.steps[${idx}].next_hop.mode` },
        );
      }
    }
    rejectUnknownKeys(step, WORKFLOW_STEP_KEYS, `workflow.steps[${idx}]`, sourcePath);
    if (step && typeof step === "object" && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      rejectUnknownKeys(
        s.next_hop,
        WORKFLOW_NEXT_HOP_KEYS,
        `workflow.steps[${idx}].next_hop`,
        sourcePath,
      );
      // OPR.0.4.6.WF2 FR-1: branch-key shape at the raw seam — keys of
      // next_hop.on are the closed exit enum ONLY (BR-1); values are
      // non-empty step-id strings (target EXISTENCE is the validator's
      // graph check).
      const nh = s.next_hop as Record<string, unknown> | undefined;
      const on = nh?.on;
      if (on !== undefined) {
        if (!on || typeof on !== "object" || Array.isArray(on)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `workflow spec at ${sourcePath}: workflow.steps[${idx}].next_hop.on must be a mapping of recorded exit → step id (got ${JSON.stringify(on)}).`,
            { sourcePath, path: `workflow.steps[${idx}].next_hop.on` },
          );
        }
        for (const [exitKey, target] of Object.entries(on as Record<string, unknown>)) {
          if (!(WORKFLOW_EXIT_KINDS as readonly string[]).includes(exitKey)) {
            throw new WorkflowSpecError(
              "spec_branch_key_invalid",
              `workflow spec at ${sourcePath}: workflow.steps[${idx}].next_hop.on key "${exitKey}" is not a recorded exit. Branch keys are the closed exit enum ONLY: [${WORKFLOW_EXIT_KINDS.join(", ")}] — branching on anything else (free text, identity, evidence JSON) is deliberately unsupported (branch purity).`,
              { sourcePath, path: `workflow.steps[${idx}].next_hop.on.${exitKey}`, allowed: [...WORKFLOW_EXIT_KINDS] },
            );
          }
          if (typeof target !== "string" || target.length === 0) {
            throw new WorkflowSpecError(
              "spec_field_invalid",
              `workflow spec at ${sourcePath}: workflow.steps[${idx}].next_hop.on.${exitKey} must be a step id string (got ${JSON.stringify(target)}).`,
              { sourcePath, path: `workflow.steps[${idx}].next_hop.on.${exitKey}` },
            );
          }
        }
      }
      // OPR.0.4.6.WF2 FR-2: harness value space at the raw seam —
      // agent harnesses only; `terminal` gets the specific teaching
      // error (it is a real runtime value but not a pinnable one).
      if (s.harness !== undefined) {
        if (
          typeof s.harness !== "string" ||
          !(WORKFLOW_AGENT_HARNESSES as readonly string[]).includes(s.harness)
        ) {
          throw new WorkflowSpecError(
            "spec_harness_invalid",
            `workflow spec at ${sourcePath}: workflow.steps[${idx}].harness must be one of the AGENT harnesses [${WORKFLOW_AGENT_HARNESSES.join(", ")}] (got ${JSON.stringify(s.harness)}).${s.harness === "terminal" ? " A terminal node is not an agent harness — a workflow step cannot be pinned to it." : ""} Pi Agent joins the value space in 0.4.7 when its adapter lands.`,
            { sourcePath, path: `workflow.steps[${idx}].harness`, allowed: [...WORKFLOW_AGENT_HARNESSES] },
          );
        }
      }
      // OPR.0.4.6.WF2 FR-3: host pin shape — non-empty string. Registry
      // membership is the validator's check (it sees the registry);
      // the parser only pins the shape.
      if (s.host !== undefined && (typeof s.host !== "string" || s.host.length === 0)) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `workflow spec at ${sourcePath}: workflow.steps[${idx}].host must be "local" or a registered host id string (got ${JSON.stringify(s.host)}).`,
          { sourcePath, path: `workflow.steps[${idx}].host` },
        );
      }
      // OPR.0.4.6.WF2 FR-5: gate object shape — closed keyset, singular,
      // target required. Target-kind resolution (human seat vs declared
      // role) is the validator's semantic check.
      if (s.gate !== undefined) {
        if (!s.gate || typeof s.gate !== "object" || Array.isArray(s.gate)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `workflow spec at ${sourcePath}: workflow.steps[${idx}].gate must be a mapping with a target (and summary/evidence_ref for human targets). The legacy gates: [...] string list is removed.`,
            { sourcePath, path: `workflow.steps[${idx}].gate` },
          );
        }
        rejectUnknownKeys(s.gate, WORKFLOW_GATE_KEYS, `workflow.steps[${idx}].gate`, sourcePath);
        const g = s.gate as Record<string, unknown>;
        if (typeof g.target !== "string" || g.target.length === 0) {
          throw new WorkflowSpecError(
            "spec_field_missing",
            `workflow spec at ${sourcePath}: workflow.steps[${idx}].gate.target is required — a human seat session or a declared role name.`,
            { sourcePath, field: `workflow.steps[${idx}].gate.target` },
          );
        }
        for (const optional of ["summary", "evidence_ref"] as const) {
          if (g[optional] !== undefined && (typeof g[optional] !== "string" || (g[optional] as string).length === 0)) {
            throw new WorkflowSpecError(
              "spec_field_invalid",
              `workflow spec at ${sourcePath}: workflow.steps[${idx}].gate.${optional} must be a non-empty string when present (got ${JSON.stringify(g[optional])}).`,
              { sourcePath, path: `workflow.steps[${idx}].gate.${optional}` },
            );
          }
        }
      }
    }
  });

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
    // OPR.0.4.6.WF5 FR-2: validated above — and COPIED here (the exact
    // WF-1 migration-050 lesson: a validated key dropped at assembly is
    // silently inert; the VM caught this one at first execution).
    exception_routing: wf.exception_routing as WorkflowSpec["exception_routing"],
    coordination_terminal_turn_rule:
      typeof wf.coordination_terminal_turn_rule === "string"
        ? wf.coordination_terminal_turn_rule
        : undefined,
  };
}

export class WorkflowSpecCache {
  private readonly hasSpecJsonColumn: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hasSpecJsonColumn = detectSpecColumn(db, "spec_json");
  }

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
      // OPR.0.4.6.WF1: self-heal legacy rows — backfill spec_json so
      // PROJECTION-time consumers (getByNameVersion) also see the full
      // spec (loop_guards/invariants/closure/entry were dropped by the
      // column-only reconstruction before migration 050).
      if (this.hasSpecJsonColumn && !existing.spec_json) {
        this.db
          .prepare(`UPDATE workflow_specs SET spec_json = ? WHERE spec_id = ?`)
          .run(JSON.stringify(spec), existing.spec_id);
      }
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
      const specJsonSet = this.hasSpecJsonColumn ? ", spec_json = ?" : "";
      const updateParams: unknown[] = [
        purpose,
        targetRig,
        rolesJson,
        stepsJson,
        coordinationTerminalTurnRule,
        sourcePath,
        sourceHash,
        cachedAt,
      ];
      if (this.hasSpecJsonColumn) updateParams.push(JSON.stringify(spec));
      updateParams.push(existing.spec_id);
      this.db
        .prepare(
          `UPDATE workflow_specs SET
             purpose = ?, target_rig = ?, roles_json = ?, steps_json = ?,
             coordination_terminal_turn_rule = ?, source_path = ?,
             source_hash = ?, cached_at = ?${specJsonSet}
           WHERE spec_id = ?`,
        )
        .run(...(updateParams as never[]));
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
    const insertCols = this.hasSpecJsonColumn ? ", spec_json" : "";
    const insertPlaceholder = this.hasSpecJsonColumn ? ", ?" : "";
    const insertParams: unknown[] = [
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
    ];
    if (this.hasSpecJsonColumn) insertParams.push(JSON.stringify(spec));
    this.db
      .prepare(
        `INSERT INTO workflow_specs (
           spec_id, name, version, purpose, target_rig,
           roles_json, steps_json, coordination_terminal_turn_rule,
           source_path, source_hash, cached_at${insertCols}
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${insertPlaceholder})`,
      )
      .run(...(insertParams as never[]));
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
   * OPR.0.3.3.04.1: resolve a passed identifier to a cached spec's STORED
   * (already-resolved) sourcePath by NAME / cache-key. Returns the source_path
   * of the named valid spec (latest version when several exist), or null when no
   * cached spec carries that name.
   *
   * Used so `workflow instantiate <discovered-name>` works for a fresh operator
   * without a hidden file path: the seeded built-ins are cached by name with the
   * sourcePath the starter-spec-loader already resolved at seed time (e.g.
   * `dist/builtins/workflow-specs/...` in a shipped install). Resolution returns
   * that STORED path verbatim - it does NOT re-derive a path from source-tree
   * assumptions, so it stays production-layout safe (cf. the slice-16
   * source-tree-vs-dist lesson). The `version != ''` guard excludes slice-11
   * diagnostic rows (keyed by file basename with an empty version); valid specs
   * always carry a version (parseWorkflowSpec requires workflow.version). We
   * filter on `version` rather than the slice-11 `status` column so resolution
   * does not depend on a later migration being present.
   */
  resolveSourcePathByName(name: string): string | null {
    const row = this.db
      .prepare(
        `SELECT source_path FROM workflow_specs
           WHERE name = ? AND version != ''
           ORDER BY version DESC LIMIT 1`,
      )
      .get(name) as { source_path: string } | undefined;
    return row?.source_path ?? null;
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

  /**
   * OPR.0.3.2.22 Bug 4 — prune cached rows whose source_path lives in
   * noise directories that the post-Bug-4 walkYamlFiles SKIP_DIRS
   * guard now refuses to scan. Without this prune, rows that were
   * inserted before the SKIP_DIRS guard landed would survive forever
   * (the scanner cleanup at spec-library-workflow-scanner.ts only
   * fires for paths starting with the workspace `workflows/` folder
   * prefix). Called once at startup. Returns the number of rows
   * removed.
   *
   * installRoot guard (Bug 4 follow-up): when supplied, rows whose
   * source_path starts with the install root are PRESERVED even if
   * they match a noise pattern. This is the load-bearing safety for
   * shipped built-in workflow specs that live at
   * `<pkg>/dist/builtins/workflow-specs/` in production npm-published
   * daemons — without this guard the unscoped DELETE would nuke
   * every shipped built-in on every boot. Pass
   * `getOpenRigInstallRoot()` from cwd-resolution at the call site.
   * When omitted, no install-root preservation is applied (test-only
   * convenience for tests that operate fully outside any install).
   */
  pruneNoiseDirRows(installRoot?: string): number {
    const guardClause = installRoot ? ` AND source_path NOT LIKE ? || '%'` : "";
    const params: string[] = installRoot ? [installRoot] : [];
    const result = this.db
      .prepare(
        `DELETE FROM workflow_specs WHERE (
           source_path LIKE '%/.worktrees/%'
           OR source_path LIKE '%/node_modules/%'
           OR source_path LIKE '%/.git/%'
           OR source_path LIKE '%/dist/%'
           OR source_path LIKE '%/build/%'
           OR source_path LIKE '%/.turbo/%'
           OR source_path LIKE '%/.next/%'
         )${guardClause}`,
      )
      .run(...params);
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

const warnedLegacyRehydrations = new Set<string>();

/** Exported for the named honest-degrade test only. */
export function resetLegacyRehydrationWarnings(): void {
  warnedLegacyRehydrations.clear();
}

function warnLegacyRehydrationOnce(name: string, version: string): void {
  const key = `${name}@${version}`;
  if (warnedLegacyRehydrations.has(key)) return;
  warnedLegacyRehydrations.add(key);
  console.warn(
    `workflow spec ${key} rehydrated WITHOUT full fidelity (pre-050 cache row: loop_guards/invariants/closure/entry unavailable at projection). Re-validate the spec file (rig workflow validate <path>) to heal the cache row.`,
  );
}

function rowToWorkflowSpec(row: SpecRow, parsedSpec?: WorkflowSpec): WorkflowSpecRow {
  // OPR.0.4.6.WF1: prefer, in order — the freshly file-parsed spec
  // (readThrough's file-authoritative override), then the STORED full
  // spec (migration 050 spec_json — what makes loop_guards/invariants/
  // closure/entry visible at PROJECTION time via getByNameVersion),
  // then the legacy column-only reconstruction (pre-050 rows; those
  // fields are honestly absent until the row self-heals on next
  // readThrough).
  const storedSpec: WorkflowSpec | undefined =
    !parsedSpec && row.spec_json
      ? (JSON.parse(row.spec_json) as WorkflowSpec)
      : undefined;
  const hydrated = parsedSpec ?? storedSpec;
  if (!hydrated) {
    // The residual worst case (arch fold, mid-build contract): a
    // legacy pre-050 row whose source file may be gone, resolved at
    // projection time — the reconstruction below has NO
    // loop_guards/invariants/closure/entry. The degrade must be
    // VISIBLE, never a silent no-guards run. Once per spec per
    // process (bounded noise; the condition holds until healed).
    warnLegacyRehydrationOnce(row.name, row.version);
  }
  const spec: WorkflowSpec = hydrated
    ? {
        ...hydrated,
        coordination_terminal_turn_rule:
          hydrated.coordination_terminal_turn_rule ?? row.coordination_terminal_turn_rule,
      }
    : {
        id: row.name,
        version: row.version,
        objective: row.purpose ?? undefined,
        target: row.target_rig ? { rig: row.target_rig } : undefined,
        roles: JSON.parse(row.roles_json) as WorkflowSpec["roles"],
        steps: JSON.parse(row.steps_json) as WorkflowSpec["steps"],
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
