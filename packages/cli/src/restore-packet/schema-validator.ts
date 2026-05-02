// schema-validator.ts — validates restore-summary.json against the v0 JSON
// Schema (packages/cli/src/schemas/restore-summary.schema.json).
//
// Per M1 contract § 8 + IMPL § M2 line 167:
// - generator-side: emit-time self-check against the schema before atomic
//   rename of the packet directory.
// - operator-side: M3 `rig restore-packet validate <packet-dir>` runs this
//   validator and surfaces per-field violations.
//
// Validator returns a ValidationResult with `valid` and a per-field error
// list. Each error names: field path, value (truncated/escaped), rule, and
// severity. Required-field violations are severity `error`; optional-field
// malformations are severity `warning` per § 8.
//
// M2a R2 packaging fix: the schema is embedded directly in this module as
// a typed TS const (RESTORE_SUMMARY_SCHEMA) rather than read from the
// sibling .json file at runtime. tsc emits the const into the compiled
// validator JS, so the validator works after `tsc` emit without any extra
// build-script copy step. The canonical JSON Schema file at
// `packages/cli/src/schemas/restore-summary.schema.json` remains the
// source of truth for downstream IDE / tooling consumption; a drift-catcher
// test in `test/restore-packet.test.ts` asserts the two stay byte-equivalent.

import Ajv from "ajv";
import addFormats from "ajv-formats";

export interface ValidationError {
  field: string;
  value: string;
  rule: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// RESTORE_SUMMARY_SCHEMA — verbatim mirror of
// `packages/cli/src/schemas/restore-summary.schema.json`. Keep these in
// lockstep; the drift-catcher test enforces equivalence.
export const RESTORE_SUMMARY_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://openrig.dev/schemas/restore-summary.schema.json",
  title: "Restore Packet Summary",
  description:
    "Machine-readable metadata for a cross-runtime restore packet per the v0 paper standard.",
  type: "object",
  required: [
    "source_session_id",
    "source_rig",
    "source_runtime",
    "source_cwd",
    "target_rig",
    "target_runtime",
    "target_workspace_root",
    "default_target_repo",
    "role_pointer",
    "bounded_latest_transcript",
    "touched_files",
    "durable_pointers",
    "current_work_summary",
    "next_owner",
    "caveats",
    "authority_boundaries",
    "omitted_classes",
    "redaction_policy_id",
    "source_trust_ranking",
    "generator_version",
    "generated_at",
  ],
  properties: {
    source_session_id: { type: "string", minLength: 1 },
    source_rig: { type: "string", minLength: 1 },
    source_runtime: {
      type: "string",
      enum: ["claude-code", "codex", "terminal", "external"],
    },
    source_cwd: { type: "string", pattern: "^/" },
    target_rig: { type: "string", minLength: 1 },
    target_runtime: {
      type: "string",
      enum: ["claude-code", "codex", "terminal", "external"],
    },
    target_workspace_root: { type: "string", pattern: "^/" },
    default_target_repo: { type: ["string", "null"] },
    role_pointer: {
      type: "string",
      minLength: 1,
      description:
        "Path or URI pointing to the role guidance file the restored seat should consume. REQUIRED per v0 standard field #9; resolves at restore time.",
    },
    bounded_latest_transcript: {
      type: "object",
      required: ["path", "message_count", "bound"],
      properties: {
        path: { type: "string" },
        message_count: {
          type: "integer",
          minimum: 0,
          description: "Actual count of extracted messages in transcript-latest.md.",
        },
        bound: {
          type: "integer",
          const: 120,
          description:
            "v0 bound is fixed at 120 messages to match Velocity prior art (per contract § 7). v1+ may make configurable; v0 schema requires const 120 so packets with the wrong bound cannot pass.",
        },
      },
    },
    full_transcript: {
      type: "object",
      properties: {
        path: { type: "string" },
        line_count: { type: "integer", minimum: 0 },
      },
      description:
        "Optional per v0 standard field #11. Generator emits when full transcript material is available (e.g., from --source-jsonl or full-read --source-session); omitted otherwise.",
    },
    touched_files: {
      type: "object",
      required: ["path", "top_paths"],
      properties: {
        path: { type: "string" },
        top_paths: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "count"],
            properties: {
              path: { type: "string" },
              count: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    durable_pointers: {
      type: "object",
      required: [
        "queue_pointers",
        "progress_pointers",
        "field_note_pointers",
        "artifact_pointers",
      ],
      properties: {
        queue_pointers: {
          type: "array",
          items: { type: "string" },
          description: "References to durable queue items (qitem ids or queue-file paths).",
        },
        progress_pointers: {
          type: "array",
          items: { type: "string" },
          description: "References to PROGRESS.md cursors the source seat was operating against.",
        },
        field_note_pointers: {
          type: "array",
          items: { type: "string" },
          description: "References to field-notes folders or files.",
        },
        artifact_pointers: {
          type: "array",
          items: { type: "string" },
          description: "Other durable artifacts (proof packets, slice packets, candidate dossiers).",
        },
      },
      description:
        "REQUIRED per v0 standard field #13. Pointers to durable work the source seat was operating against; restored seat reads to recover work-context.",
    },
    current_work_summary: { type: "string", minLength: 1 },
    next_owner: { type: "string", minLength: 1 },
    caveats: { type: "array", items: { type: "string" } },
    authority_boundaries: { type: "string", minLength: 1 },
    omitted_classes: {
      type: "array",
      items: {
        type: "string",
        enum: ["reasoning_records", "raw_tool_outputs", "function_call_output", "redacted_secrets"],
      },
    },
    redaction_policy_id: { type: "string", enum: ["velocity-v1", "openrig-v0"] },
    source_trust_ranking: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "rig_whoami",
          "target_rigspec",
          "bounded_latest_transcript",
          "full_transcript",
          "touched_files",
          "restore_summary",
        ],
      },
      minItems: 1,
    },
    generator_version: { type: "string", minLength: 1 },
    generated_at: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};

let cachedValidator: ReturnType<Ajv["compile"]> | null = null;

function getValidator(): ReturnType<Ajv["compile"]> {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(RESTORE_SUMMARY_SCHEMA);
  return cachedValidator;
}

function truncateValue(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (value === null) return "null";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length > 80) return s.slice(0, 77) + "...";
  return s;
}

export function validateRestoreSummary(summary: unknown): ValidationResult {
  const validator = getValidator();
  const ok = validator(summary);
  if (ok) {
    return { valid: true, errors: [] };
  }
  const errors: ValidationError[] = (validator.errors ?? []).map((err) => {
    const instancePath = err.instancePath || "";
    const missing = err.params && (err.params as { missingProperty?: string }).missingProperty;
    const additional = err.params && (err.params as { additionalProperty?: string }).additionalProperty;
    let field = instancePath.replace(/^\//, "").replace(/\//g, ".");
    if (missing) field = field ? `${field}.${missing}` : missing;
    if (additional) field = additional;
    return {
      field: field || "<root>",
      value: truncateValue(err.data),
      rule: `${err.keyword}: ${err.message ?? ""}`.trim(),
      severity: "error",
    };
  });
  return { valid: false, errors };
}
