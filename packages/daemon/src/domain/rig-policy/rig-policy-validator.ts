// Slice 09 — runtime validator for OperatorContextModeRecord input.
//
// The type system (rig-policy-types.ts) blocks invalid values at
// compile time when callers go through the typed surface. This
// validator is the defense for inputs that bypass types: JSON file
// reads, HTTP request bodies, env-var-derived configuration, CLI
// argument parsing, and migrations from older record shapes.
//
// HG-2: every record must carry all 10 fields. Reject missing/extra.
// HG-1 / HG-SAFE / HG-8: closed enums; auto-accept rejected; no
// silent-switch value.
//
// Error format follows the 3-part convention from the velocity team:
//   what failed / what's allowed / what to do
// so an operator gets a useful CLI message.

import {
  type AutonomyScope,
  type ConcurrencyLimit,
  type EscalationThreshold,
  type ExpiryOrStaleRule,
  type HeartbeatCadence,
  type InspectionDepth,
  type OperatorContextMode,
  type OperatorContextModeRecord,
  type OperatorContextScope,
  type PermissionPromptPosture,
  type UpdateDetail,
  OPERATOR_CONTEXT_MODES,
  OPERATOR_CONTEXT_SCOPES,
  SAFE_PERMISSION_PROMPT_POSTURES,
  STALE_RULES,
} from "./rig-policy-types.js";

const ALLOWED_AUTONOMY_SCOPES: readonly AutonomyScope[] = [
  "pre_approved_only",
  "bounded_continuation",
  "full_autonomy_within_workstream",
  "full_autonomy",
];

const ALLOWED_HEARTBEAT_CADENCES: readonly HeartbeatCadence[] = ["sparse", "normal", "fast"];

const ALLOWED_INSPECTION_DEPTHS: readonly InspectionDepth[] = ["surface", "normal", "forensic"];

const ALLOWED_UPDATE_DETAILS: readonly UpdateDetail[] = ["compact", "normal", "verbose"];

const ALLOWED_ESCALATION_THRESHOLDS: readonly EscalationThreshold[] = [
  "low",
  "normal",
  "high",
  "blocker_only",
];

const ALLOWED_CONCURRENCY_LIMITS: readonly ConcurrencyLimit[] = ["serial", "2", "4", "unlimited"];

/**
 * The 10 required fields of an OperatorContextModeRecord. Used by
 * validateRecord to enumerate field-set integrity (HG-2) — both
 * presence and exhaustiveness.
 *
 * NOTE: `mode` is NOT in this list. Mode is the binding selector
 * (Component 2 vocabulary), not part of the Component-3 settings
 * record. The store/route validate mode separately at the binding
 * boundary; this validator enforces only the 10 Component-3 fields.
 */
export const REQUIRED_RECORD_FIELDS: readonly (keyof OperatorContextModeRecord)[] = [
  "autonomy_scope",
  "heartbeat_cadence",
  "inspection_depth",
  "update_detail",
  "escalation_threshold",
  "concurrency_limit",
  "permission_prompt_posture",
  "scope",
  "expiry_or_stale_rule",
  "evidence_citation",
];

export interface ValidationOk {
  ok: true;
  record: OperatorContextModeRecord;
}

export interface ValidationError {
  ok: false;
  errors: string[];
}

export type ValidationResult = ValidationOk | ValidationError;

function threePart(failed: string, allowed: string, recovery: string): string {
  return `${failed}. Allowed: ${allowed}. ${recovery}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkEnum<T extends string>(
  fieldName: string,
  value: unknown,
  allowed: readonly T[],
  errors: string[],
): T | null {
  if (typeof value !== "string") {
    errors.push(
      threePart(
        `${fieldName} is not a string (got ${typeof value})`,
        allowed.join(", "),
        `Set ${fieldName} to one of the allowed values.`,
      ),
    );
    return null;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    errors.push(
      threePart(
        `${fieldName}="${value}" is not a recognized value`,
        allowed.join(", "),
        `Set ${fieldName} to one of the allowed values.`,
      ),
    );
    return null;
  }
  return value as T;
}

/**
 * Validate a candidate record against the FROZEN contract. Returns
 * the typed record on success OR a list of 3-part error messages on
 * failure (one per offending field; report all at once so an
 * operator doesn't have to retry per error).
 *
 * Strict: any field outside REQUIRED_RECORD_FIELDS is rejected
 * (HG-2 — field-set integrity; "no merged/dropped fields").
 */
export function validateRecord(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [
        threePart(
          "Record is not an object",
          "an object with the 10 required fields",
          "See conventions/operator-context-mode-system/README.md §Component 3 for the schema.",
        ),
      ],
    };
  }

  // HG-2 — field-set integrity. Reject missing AND extra fields. The
  // convention says "All ten fields MUST be present in any descendant
  // that publishes a current-mode artifact. None may be silently
  // merged or dropped."
  for (const field of REQUIRED_RECORD_FIELDS) {
    if (!(field in raw)) {
      errors.push(
        threePart(
          `Missing required field "${field}"`,
          REQUIRED_RECORD_FIELDS.join(", "),
          `Add the field to the record. See convention §Component 3.`,
        ),
      );
    }
  }
  const requiredSet = new Set<string>(REQUIRED_RECORD_FIELDS);
  for (const key of Object.keys(raw)) {
    if (!requiredSet.has(key)) {
      errors.push(
        threePart(
          `Unknown field "${key}"`,
          REQUIRED_RECORD_FIELDS.join(", "),
          `Drop the unknown field. The schema is closed at v0; an extension requires a Mode 1.5 amendment.`,
        ),
      );
    }
  }
  // If we already failed field-set integrity, return early so the
  // operator sees only the structural error and not cascade per-field
  // noise.
  if (errors.length > 0) return { ok: false, errors };

  const autonomy_scope = checkEnum<AutonomyScope>(
    "autonomy_scope",
    raw["autonomy_scope"],
    ALLOWED_AUTONOMY_SCOPES,
    errors,
  );
  const heartbeat_cadence = checkEnum<HeartbeatCadence>(
    "heartbeat_cadence",
    raw["heartbeat_cadence"],
    ALLOWED_HEARTBEAT_CADENCES,
    errors,
  );
  const inspection_depth = checkEnum<InspectionDepth>(
    "inspection_depth",
    raw["inspection_depth"],
    ALLOWED_INSPECTION_DEPTHS,
    errors,
  );
  const update_detail = checkEnum<UpdateDetail>(
    "update_detail",
    raw["update_detail"],
    ALLOWED_UPDATE_DETAILS,
    errors,
  );
  const escalation_threshold = checkEnum<EscalationThreshold>(
    "escalation_threshold",
    raw["escalation_threshold"],
    ALLOWED_ESCALATION_THRESHOLDS,
    errors,
  );
  const concurrency_limit = checkEnum<ConcurrencyLimit>(
    "concurrency_limit",
    raw["concurrency_limit"],
    ALLOWED_CONCURRENCY_LIMITS,
    errors,
  );

  // HG-SAFE (runtime) — the type system blocks auto-accept at
  // compile time; this branch rejects it at runtime for inputs that
  // bypass typing (JSON / env / HTTP body). The validator does NOT
  // tolerate any "auto*" / "yes_to_all" / etc. value; it accepts
  // EXACTLY the three SAFE values.
  const permission_prompt_posture = checkEnum<PermissionPromptPosture>(
    "permission_prompt_posture",
    raw["permission_prompt_posture"],
    SAFE_PERMISSION_PROMPT_POSTURES,
    errors,
  );

  const scope = checkEnum<OperatorContextScope>(
    "scope",
    raw["scope"],
    OPERATOR_CONTEXT_SCOPES,
    errors,
  );

  const expiry_or_stale_rule = checkEnum<ExpiryOrStaleRule>(
    "expiry_or_stale_rule",
    raw["expiry_or_stale_rule"],
    STALE_RULES,
    errors,
  );

  const evidence_citation_raw = raw["evidence_citation"];
  if (typeof evidence_citation_raw !== "string") {
    errors.push(
      threePart(
        `evidence_citation is not a string (got ${typeof evidence_citation_raw})`,
        "a non-empty source-citation string (e.g., qitem id, file path, chatroom topic)",
        "Provide a brief citation per convention §Citation Rules.",
      ),
    );
  } else if (evidence_citation_raw.trim().length === 0) {
    errors.push(
      threePart(
        "evidence_citation is empty",
        "a non-empty source-citation string",
        "Provide a brief citation per convention §Citation Rules.",
      ),
    );
  }

  if (
    errors.length > 0
    || autonomy_scope === null
    || heartbeat_cadence === null
    || inspection_depth === null
    || update_detail === null
    || escalation_threshold === null
    || concurrency_limit === null
    || permission_prompt_posture === null
    || scope === null
    || expiry_or_stale_rule === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    record: {
      autonomy_scope,
      heartbeat_cadence,
      inspection_depth,
      update_detail,
      escalation_threshold,
      concurrency_limit,
      permission_prompt_posture,
      scope,
      expiry_or_stale_rule,
      evidence_citation: (evidence_citation_raw as string).trim(),
    },
  };
}

/**
 * Validate an operator-supplied mode name. Mode lives outside the
 * 10-field record (Component 2 vocabulary, not Component 3 settings).
 * The route + store call this at the binding boundary; the
 * disambiguator below (for invocation parsing) is separate.
 */
export function validateModeName(raw: unknown): { ok: true; mode: OperatorContextMode } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: threePart(`mode is not a string (got ${typeof raw})`, OPERATOR_CONTEXT_MODES.join(", "), "Provide one of the six reserved mode names.") };
  }
  if (!(OPERATOR_CONTEXT_MODES as readonly string[]).includes(raw)) {
    return { ok: false, error: threePart(`mode="${raw}" is not a recognized mode name`, OPERATOR_CONTEXT_MODES.join(", "), "Provide one of the six reserved mode names. See convention §Component 2.") };
  }
  return { ok: true, mode: raw as OperatorContextMode };
}

/**
 * Disambiguate operator-supplied mode input. Per convention §Component 4
 * "Bare-Word Disambiguation":
 *
 * - A bare word that is one of the six reserved modes → invocation
 * - An explicit `mode:` prefix → invocation
 * - A word embedded in a sentence → NOT invocation (caller treats as topic)
 *
 * Returns the canonical mode name when the input is unambiguously an
 * invocation; null otherwise. Caller emits a clarification question
 * for null+bare-multi-word inputs (per convention "ask once").
 */
export function disambiguateModeInvocation(rawInput: string): OperatorContextMode | null {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) return null;

  // Explicit prefix wins.
  const prefixMatch = trimmed.match(/^mode\s*:\s*(\S+)/i);
  if (prefixMatch) {
    const candidate = prefixMatch[1]!.toLowerCase();
    if ((OPERATOR_CONTEXT_MODES as readonly string[]).includes(candidate)) {
      return candidate as OperatorContextMode;
    }
    return null;
  }

  // Bare-word: exactly one word AND it's a reserved mode.
  if (/^\S+$/.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    if ((OPERATOR_CONTEXT_MODES as readonly string[]).includes(lower)) {
      return lower as OperatorContextMode;
    }
    return null;
  }

  // Embedded — let the caller ask.
  return null;
}
