/**
 * slice-07 R6 — the eval-case FORMAT + VALIDATOR (mirrors scenario-schema's loud, named-error
 * discipline). Eval cases are declarative data (YAML/JSON) so they stay human-legible and carry
 * no cross-package TS import; this pure validator turns a parsed case object into a typed EvalCase
 * or a complete list of distinctly-named errors — never a silent no-op.
 */

import type { EvalCase, EvalCategory } from "./eval-grader.js";

const CATEGORIES: readonly EvalCategory[] = ["selection", "loading"];

export type EvalCaseErrorCode =
  | "EVAL_NOT_OBJECT"
  | "ID_MISSING"
  | "NAME_MISSING"
  | "UNKNOWN_CATEGORY"
  | "PROMPT_MISSING"
  | "EXPECTED_PATTERNS_MISSING"
  | "PATTERN_NOT_REGEX"
  | "FORBIDDEN_NOT_ARRAY"
  | "ORDER_MISSING_FOR_LOADING"
  | "ORDER_ON_SELECTION"
  | "ORDER_PATTERN_INVALID"
  | "RUBRIC_NOT_STRING";

export interface EvalCaseError {
  code: EvalCaseErrorCode;
  message: string;
  path: string;
}

export type ValidateEvalCaseResult =
  | { ok: true; case: EvalCase }
  | { ok: false; errors: EvalCaseError[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCompilableRegex(source: unknown): boolean {
  if (typeof source !== "string") return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a parsed eval-case object. Collects ALL errors (loud, complete). Pure — no I/O.
 */
export function validateEvalCase(doc: unknown): ValidateEvalCaseResult {
  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ code: "EVAL_NOT_OBJECT", message: "eval case must be a mapping/object", path: "" }] };
  }
  const errors: EvalCaseError[] = [];
  const push = (code: EvalCaseErrorCode, message: string, path: string) => errors.push({ code, message, path });

  if (typeof doc.id !== "string" || doc.id.length === 0) push("ID_MISSING", "id: a non-empty string is required", "id");
  if (typeof doc.name !== "string" || doc.name.length === 0) push("NAME_MISSING", "name: a non-empty string is required", "name");

  const category = doc.category;
  const knownCategory = typeof category === "string" && (CATEGORIES as readonly string[]).includes(category);
  if (!knownCategory) push("UNKNOWN_CATEGORY", `category: must be one of ${CATEGORIES.join(", ")}`, "category");

  if (typeof doc.prompt !== "string" || doc.prompt.length === 0) push("PROMPT_MISSING", "prompt: a non-empty natural prompt is required", "prompt");

  if (!Array.isArray(doc.expectedPatterns) || doc.expectedPatterns.length === 0) {
    push("EXPECTED_PATTERNS_MISSING", "expectedPatterns: a non-empty array of regex sources is required", "expectedPatterns");
  } else {
    doc.expectedPatterns.forEach((p, i) => {
      if (!isCompilableRegex(p)) push("PATTERN_NOT_REGEX", `expectedPatterns[${i}]: not a compilable regex source`, `expectedPatterns[${i}]`);
    });
  }

  if (doc.forbiddenPatterns !== undefined) {
    if (!Array.isArray(doc.forbiddenPatterns)) {
      push("FORBIDDEN_NOT_ARRAY", "forbiddenPatterns: must be an array of regex sources when present", "forbiddenPatterns");
    } else {
      doc.forbiddenPatterns.forEach((p, i) => {
        if (!isCompilableRegex(p)) push("PATTERN_NOT_REGEX", `forbiddenPatterns[${i}]: not a compilable regex source`, `forbiddenPatterns[${i}]`);
      });
    }
  }

  const hasOrder = doc.order !== undefined;
  if (knownCategory && category === "loading" && !hasOrder) {
    push("ORDER_MISSING_FOR_LOADING", "order: loading cases require {getPattern, actionPattern} (get must precede the action)", "order");
  }
  if (knownCategory && category === "selection" && hasOrder) {
    push("ORDER_ON_SELECTION", "order: selection cases must not carry an order block — get-before-action is a loading-only concern", "order");
  }
  if (hasOrder) {
    if (!isPlainObject(doc.order)) {
      push("ORDER_PATTERN_INVALID", "order: must be a mapping {getPattern, actionPattern}", "order");
    } else {
      for (const key of ["getPattern", "actionPattern"] as const) {
        if (!isCompilableRegex(doc.order[key])) {
          push("ORDER_PATTERN_INVALID", `order.${key}: a compilable regex source is required`, `order.${key}`);
        }
      }
    }
  }

  if (doc.rubric !== undefined && typeof doc.rubric !== "string") push("RUBRIC_NOT_STRING", "rubric: must be a string when present", "rubric");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, case: doc as unknown as EvalCase };
}
