// Slice-03 (OPR.0.4.8.3) Seam A — policy-spec parse + validate-by-convention pins.
import { describe, it, expect } from "vitest";
import { parsePolicySpec, validatePolicySpec, serializePolicySpec, type ParsedPolicySpec } from "../src/domain/permission-policy/policy-spec.js";

// Real built-in shapes (frontmatter-contract + body).
const FLAG_YOLO = `---
source: builtin
name: yolo
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Full-bypass posture.
---

# YOLO (built-in policy — flag surface)

The maximum-permissive built-in.
`;

const CONFIG_STANDARD = `---
source: builtin
name: standard
surface: config
policy_schema_version: 1
description: The recommended default.
default_posture: allow
allow: [push_to_remote]
ask: [create_pr, publish_package]
deny: []
destructive_class: [delete_everything]
---

# Standard (built-in policy)

Everyday posture.
`;

function parsed(raw: string): ParsedPolicySpec {
  const r = parsePolicySpec(raw);
  if ("error" in r) throw new Error(`unexpected parse error: ${r.error}`);
  return r;
}

describe("parsePolicySpec — frontmatter contract + preserved body", () => {
  it("parses the WHOLE contract from frontmatter and PRESERVES the body verbatim", () => {
    const p = parsed(FLAG_YOLO);
    expect(p.frontmatter).toMatchObject({ source: "builtin", name: "yolo", surface: "flag", launch_posture: "full_bypass", policy_schema_version: 1 });
    expect(p.body).toContain("# YOLO (built-in policy — flag surface)");
    expect(p.body).toContain("The maximum-permissive built-in.");
  });
  it("config policy carries default_posture + action lists in frontmatter", () => {
    const p = parsed(CONFIG_STANDARD);
    expect(p.frontmatter).toMatchObject({ surface: "config", default_posture: "allow", allow: ["push_to_remote"], destructive_class: ["delete_everything"] });
  });
  it("a spec with no frontmatter block is a parse error (never throws)", () => {
    const r = parsePolicySpec("# just a body\nno frontmatter\n");
    expect("error" in r).toBe(true);
  });
});

describe("validatePolicySpec — advisory, fail-open, surface-appropriate", () => {
  it("valid flag policy → ok", () => { expect(validatePolicySpec(parsed(FLAG_YOLO).frontmatter)).toEqual({ ok: true, errors: [] }); });
  it("valid config policy → ok", () => { expect(validatePolicySpec(parsed(CONFIG_STANDARD).frontmatter)).toEqual({ ok: true, errors: [] }); });

  it("policy_schema_version ≠ 1 → error", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "flag", launch_posture: "floor", policy_schema_version: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("policy_schema_version"))).toBe(true);
  });
  it("surface EXCLUSIVITY: flag policy carrying an action set → error", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "flag", launch_posture: "floor", policy_schema_version: 1, allow: ["push_to_remote"] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("allow"))).toBe(true);
  });
  it("surface EXCLUSIVITY: config policy carrying launch_posture → error", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "config", default_posture: "allow", launch_posture: "floor", policy_schema_version: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("launch_posture"))).toBe(true);
  });
  it("non-list action field → error (shape)", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "config", default_posture: "ask", policy_schema_version: 1, deny: "not-a-list" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("deny"))).toBe(true);
  });
  it("bad enums (source/surface/default_posture) → errors", () => {
    expect(validatePolicySpec({ source: "nope", name: "x", surface: "flag", launch_posture: "floor", policy_schema_version: 1 }).ok).toBe(false);
    expect(validatePolicySpec({ source: "builtin", name: "x", surface: "sideways", policy_schema_version: 1 }).ok).toBe(false);
    expect(validatePolicySpec({ source: "builtin", name: "x", surface: "config", default_posture: "maybe", policy_schema_version: 1 }).ok).toBe(false);
  });

  it("missing description → error (required field)", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "flag", launch_posture: "floor", policy_schema_version: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("description"))).toBe(true);
  });
  it("non-string description → error", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "flag", launch_posture: "floor", policy_schema_version: 1, description: 42 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("description"))).toBe(true);
  });
  it("config policy MISSING an action list (destructive_class) → error (all four required)", () => {
    const r = validatePolicySpec({ source: "builtin", name: "x", surface: "config", description: "d", default_posture: "allow", policy_schema_version: 1, allow: [], ask: [], deny: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("destructive_class"))).toBe(true);
  });
});

describe("round-trip — canonical serialize stability + semantic equality + body preservation", () => {
  it("serialize∘parse is idempotent (canonical stable) and preserves body + semantics", () => {
    const once = serializePolicySpec(parsed(CONFIG_STANDARD));
    const twice = serializePolicySpec(parsed(once));
    expect(twice).toBe(once); // canonical stability
    expect(parsed(once).frontmatter).toEqual(parsed(CONFIG_STANDARD).frontmatter); // semantic equality
    expect(parsed(once).body).toBe(parsed(CONFIG_STANDARD).body); // body preserved
  });
});
