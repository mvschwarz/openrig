// Slice 09 — validator (runtime defense + invocation disambiguation).

import { describe, it, expect } from "vitest";
import {
  REQUIRED_RECORD_FIELDS,
  disambiguateModeInvocation,
  validateModeName,
  validateRecord,
} from "../src/domain/rig-policy/rig-policy-validator.js";

// Per guard BLOCKING-1: the record is the FROZEN Component-3 10-field
// settings schema. `mode` (Component 2 vocabulary) lives at the binding
// layer, NOT inside this record. validRecord() therefore has exactly
// 10 fields and no `mode`.
function validRecord(): Record<string, unknown> {
  return {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "qitem-20260518000000-abc",
  };
}

describe("validateRecord — slice 09 frozen contract", () => {
  it("HG-2: accepts a record with all 10 fields populated by valid enum values", () => {
    const result = validateRecord(validRecord());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(REQUIRED_RECORD_FIELDS.every((f) => f in result.record)).toBe(true);
    }
  });

  // BLOCKING-1 discriminator from guard verdict qitem-20260518043346:
  // the record MUST be exactly the 10 Component-3 settings fields.
  // Adding `mode` to the record is rejected as an unknown extra field
  // (mode lives at the binding boundary, not in the record).
  it("HG-2: exactly 10 required fields, none named `mode` (Component 3 contract)", () => {
    expect(REQUIRED_RECORD_FIELDS.length).toBe(10);
    expect(REQUIRED_RECORD_FIELDS as readonly string[]).not.toContain("mode");
    const valid = validRecord();
    expect(Object.keys(valid).length).toBe(10);
    expect(Object.keys(valid)).not.toContain("mode");
  });

  it("HG-2: a record that includes `mode` is rejected as an unknown field (mode is a binding-level field)", () => {
    const result = validateRecord({ ...validRecord(), mode: "debug" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(`Unknown field "mode"`))).toBe(true);
    }
  });

  // HG-2 negative: missing fields are rejected with all-at-once error
  // collection (per 3-part error doctrine — operator sees the full
  // diff in one round, not one-error-per-retry).
  it("HG-2 negative: a record missing any single field is rejected with a 3-part error", () => {
    for (const field of REQUIRED_RECORD_FIELDS) {
      const record = validRecord();
      delete record[field];
      const result = validateRecord(record);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes(`Missing required field "${field}"`))).toBe(true);
      }
    }
  });

  it("HG-2 negative: an unknown field is rejected with a closed-schema message (extension blocked)", () => {
    const record = { ...validRecord(), extra_field: "value" };
    const result = validateRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(`Unknown field "extra_field"`))).toBe(true);
    }
  });

  // HG-1 negative: synonyms / numeric aliases rejected at runtime
  // even though the type system already blocks them at compile time.
  // This is the defense-in-depth for inputs from outside the typed
  // surface — JSON files, env vars, HTTP bodies.
  it("HG-1 runtime negative: synonyms (`dnd`, `ooo`, `bed`) are rejected by validateModeName", () => {
    for (const bad of ["dnd", "ooo", "bed", "office", "commute"]) {
      const result = validateModeName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.includes(`mode="${bad}"`)).toBe(true);
      }
    }
  });

  it("HG-1 runtime negative: numeric / namespaced-numeric aliases are rejected by validateModeName", () => {
    for (const bad of ["L0", "L1", "L2", "L3", "operator:L0", "operator:L2"]) {
      const result = validateModeName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.includes(`mode="${bad}"`)).toBe(true);
      }
    }
  });

  it("HG-1 runtime negative: case variants rejected by validateModeName (lowercase single-word vocabulary)", () => {
    for (const bad of ["Sleep", "DEBUG", "Mobile", "FOCUS"]) {
      const result = validateModeName(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("HG-1 positive: validateModeName accepts each of the six reserved modes", () => {
    for (const m of ["sleep", "desk", "mobile", "away", "focus", "debug"]) {
      const result = validateModeName(m);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.mode).toBe(m);
    }
  });

  // HG-SAFE (runtime) — auto-accept rejected at the validator, not
  // just at the type system. This is the path JSON / env / HTTP-body
  // input takes; the runtime block is load-bearing.
  it("HG-SAFE runtime: permission_prompt_posture='auto_accept' rejected", () => {
    const forbidden = ["auto_accept", "auto", "accept_all", "allow_all", "yes_to_all"];
    for (const bad of forbidden) {
      const result = validateRecord({ ...validRecord(), permission_prompt_posture: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            e.includes(`permission_prompt_posture="${bad}"`)
            && e.includes("normal, batch_for_human, do_not_prompt_unless_blocked"),
          ),
        ).toBe(true);
      }
    }
  });

  // HG-SAFE positive: only the three documented safe values accepted.
  it("HG-SAFE positive: accepts exactly the three safe values", () => {
    for (const safe of ["normal", "batch_for_human", "do_not_prompt_unless_blocked"]) {
      const result = validateRecord({ ...validRecord(), permission_prompt_posture: safe });
      expect(result.ok).toBe(true);
    }
  });

  it("HG-3 negative: unknown scope rejected", () => {
    const result = validateRecord({ ...validRecord(), scope: "all_rigs" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(`scope="all_rigs"`))).toBe(true);
    }
  });

  it("HG-8 negative: silent-switch stale-rule values rejected (`auto_switch`, etc.)", () => {
    for (const bad of ["auto_switch", "switch_on_long_gap", "drift_switch"]) {
      const result = validateRecord({ ...validRecord(), expiry_or_stale_rule: bad });
      expect(result.ok).toBe(false);
    }
  });

  it("evidence_citation rejected when missing or empty", () => {
    const empty = validateRecord({ ...validRecord(), evidence_citation: "" });
    expect(empty.ok).toBe(false);
    const whitespace = validateRecord({ ...validRecord(), evidence_citation: "   " });
    expect(whitespace.ok).toBe(false);
  });

  it("rejects non-object inputs early", () => {
    expect(validateRecord(null).ok).toBe(false);
    expect(validateRecord("hello").ok).toBe(false);
    expect(validateRecord([validRecord()]).ok).toBe(false);
    expect(validateRecord(42).ok).toBe(false);
  });

  it("reports multiple errors in one pass (all-at-once collection)", () => {
    const record = {
      ...validRecord(),
      scope: "BadScope",
      permission_prompt_posture: "auto_accept",
      heartbeat_cadence: "instant",
    };
    const result = validateRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("disambiguateModeInvocation — slice 09 §Component 4 bare-word disambiguation", () => {
  it("bare reserved word → invocation", () => {
    for (const m of ["sleep", "desk", "mobile", "away", "focus", "debug"]) {
      expect(disambiguateModeInvocation(m)).toBe(m);
    }
  });

  it("`mode:` prefix → invocation (case-insensitive)", () => {
    expect(disambiguateModeInvocation("mode: mobile")).toBe("mobile");
    expect(disambiguateModeInvocation("Mode:debug")).toBe("debug");
    expect(disambiguateModeInvocation("MODE : sleep")).toBe("sleep");
  });

  it("word embedded in a sentence → not an invocation (caller treats as topic)", () => {
    expect(disambiguateModeInvocation("I want to debug the auth flow")).toBeNull();
    expect(disambiguateModeInvocation("let me grab my mobile")).toBeNull();
  });

  it("bare word that is NOT a reserved mode → null (caller asks once)", () => {
    expect(disambiguateModeInvocation("dnd")).toBeNull();
    expect(disambiguateModeInvocation("commute")).toBeNull();
    expect(disambiguateModeInvocation("L2")).toBeNull();
  });

  it("empty / whitespace input → null", () => {
    expect(disambiguateModeInvocation("")).toBeNull();
    expect(disambiguateModeInvocation("   ")).toBeNull();
  });

  it("case-insensitive on bare-word reserved modes", () => {
    expect(disambiguateModeInvocation("DEBUG")).toBe("debug");
    expect(disambiguateModeInvocation("Sleep")).toBe("sleep");
  });
});
