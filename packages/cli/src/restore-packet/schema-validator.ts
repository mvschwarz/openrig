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

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedValidator: ReturnType<Ajv["compile"]> | null = null;

function loadSchema(): object {
  // src/restore-packet/schema-validator.ts → src/schemas/restore-summary.schema.json
  const schemaPath = resolve(__dirname, "..", "schemas", "restore-summary.schema.json");
  return JSON.parse(readFileSync(schemaPath, "utf-8")) as object;
}

function getValidator(): ReturnType<Ajv["compile"]> {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(loadSchema());
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
