// Slice-03 (OPR.0.4.8.3) Seam A — the permission-policy SPEC primitive: parse + validate-by-convention.
// A policy spec is a Markdown file with a leading YAML FRONTMATTER contract + an explanatory body.
// This module PARSES the whole contract from frontmatter (preserving the body verbatim) and
// VALIDATES it by convention — ADVISORY + fail-open (mirrors `rig scope audit`), never enforcement.
// It NEVER validates the semantic-action vocabulary (the taxonomy 668bb0d2 owns that) and NEVER
// resolves intent to a harness format (flag surface = deterministic code elsewhere; config surface =
// the skill). Schema authority: ARCH-POLICY-SPEC-SCHEMA sha256-8 92409094.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type PolicySurface = "flag" | "config";
export type PolicySource = "builtin" | "custom";
export type LaunchPosture = "floor" | "full_bypass";
export type DefaultPosture = "allow" | "ask" | "deny";

/** A parsed policy spec: the raw frontmatter object + the preserved Markdown body. */
export interface ParsedPolicySpec {
  frontmatter: Record<string, unknown>;
  /** The Markdown body after the frontmatter block — preserved verbatim (human prose, not contract). */
  body: string;
}

export interface ParseError {
  error: string;
}

// Leading `---\n<yaml>\n---\n<body>` frontmatter block. Non-greedy YAML capture so the FIRST closing
// `---` ends the frontmatter; everything after is the body (preserved exactly).
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse a policy spec into its frontmatter contract + preserved body. Never throws. */
export function parsePolicySpec(raw: string): ParsedPolicySpec | ParseError {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { error: "policy spec must open with a '---' YAML frontmatter block" };
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(m[1]!);
  } catch (e) {
    return { error: `frontmatter is not valid YAML: ${(e as Error).message}` };
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { error: "frontmatter must be a YAML object at the root" };
  }
  return { frontmatter: frontmatter as Record<string, unknown>, body: m[2] ?? "" };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SOURCES = new Set(["builtin", "custom"]);
const SURFACES = new Set(["flag", "config"]);
const LAUNCH_POSTURES = new Set(["floor", "full_bypass"]);
const DEFAULT_POSTURES = new Set(["allow", "ask", "deny"]);
const ACTION_LIST_FIELDS = ["allow", "ask", "deny", "destructive_class"] as const;

function isStringList(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate-by-convention: required scalars, enum membership, surface-appropriate EXCLUSIVITY, and
 * scalar/list SHAPES. ADVISORY + fail-open — returns {ok, errors[]}, never throws, never enforces.
 * Does NOT validate the semantic-action vocabulary (taxonomy 668bb0d2 owns it) nor resolve to any
 * harness format.
 */
export function validatePolicySpec(fm: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  if (fm["policy_schema_version"] !== 1) errors.push("policy_schema_version must be the number 1");
  if (typeof fm["name"] !== "string" || (fm["name"] as string).length === 0) errors.push("name must be a non-empty string");
  if (typeof fm["source"] !== "string" || !SOURCES.has(fm["source"] as string)) errors.push("source must be 'builtin' or 'custom'");

  const surface = fm["surface"];
  if (typeof surface !== "string" || !SURFACES.has(surface)) {
    errors.push("surface must be 'flag' or 'config'");
    return { ok: errors.length === 0, errors }; // can't check surface-appropriate fields without a valid surface
  }

  if (surface === "flag") {
    if (!LAUNCH_POSTURES.has(fm["launch_posture"] as string)) errors.push("flag-surface policy requires launch_posture ('floor' or 'full_bypass')");
    if (fm["default_posture"] !== undefined) errors.push("flag-surface policy must NOT carry default_posture (config-surface field)");
    for (const f of ACTION_LIST_FIELDS) if (fm[f] !== undefined) errors.push(`flag-surface policy must NOT carry '${f}' (config-surface field)`);
  } else {
    // config
    if (fm["launch_posture"] !== undefined) errors.push("config-surface policy must NOT carry launch_posture (flag-surface field)");
    if (!DEFAULT_POSTURES.has(fm["default_posture"] as string)) errors.push("config-surface policy requires default_posture ('allow', 'ask' or 'deny')");
    for (const f of ACTION_LIST_FIELDS) {
      if (fm[f] !== undefined && !isStringList(fm[f])) errors.push(`${f} must be a list of strings`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// Canonical field order for deterministic serialization (unknown keys appended stably after).
const CANONICAL_ORDER = [
  "source", "name", "surface", "launch_posture", "policy_schema_version", "description",
  "default_posture", "allow", "ask", "deny", "destructive_class",
];

/**
 * Deterministic CANONICAL serialization: frontmatter re-emitted in canonical field order (unknown
 * keys preserved, appended stably) + the body verbatim. Round-trip contract = serialize is STABLE
 * (serialize∘parse is idempotent) + SEMANTIC equality (frontmatter deep-equal) + BODY preserved —
 * NOT original-input byte identity.
 */
export function serializePolicySpec(parsed: ParsedPolicySpec): string {
  const fm = parsed.frontmatter;
  const ordered: Record<string, unknown> = {};
  for (const k of CANONICAL_ORDER) if (fm[k] !== undefined) ordered[k] = fm[k];
  for (const k of Object.keys(fm)) if (!(k in ordered)) ordered[k] = fm[k];
  const yamlBlock = stringifyYaml(ordered).replace(/\n+$/, "");
  return `---\n${yamlBlock}\n---\n${parsed.body}`;
}
