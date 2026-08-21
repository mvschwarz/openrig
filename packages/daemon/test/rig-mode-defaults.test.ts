// Slice 09 — recommended defaults (Component 3 6×7 + Component 4 scope).

import { describe, it, expect } from "vitest";
import {
  DEFAULT_STALE_RULE,
  RECOMMENDED_DEFAULT_SCOPE,
  RECOMMENDED_MODE_DEFAULTS,
} from "../src/domain/rig-policy/rig-policy-defaults.js";
import {
  OPERATOR_CONTEXT_MODES,
  SAFE_PERMISSION_PROMPT_POSTURES,
} from "../src/domain/rig-policy/rig-policy-types.js";
import { validateRecord } from "../src/domain/rig-policy/rig-policy-validator.js";

describe("rig-policy defaults — slice 09 §Component 3 + §Component 4", () => {
  // HG-6 — every mode has a default row in the 6×7 matrix.
  it("HG-6: every mode has a recommended-defaults row", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      expect(RECOMMENDED_MODE_DEFAULTS[mode]).toBeDefined();
    }
    expect(Object.keys(RECOMMENDED_MODE_DEFAULTS).sort()).toEqual([...OPERATOR_CONTEXT_MODES].sort());
  });

  // HG-6 — every mode has a default scope.
  it("HG-6: every mode has a recommended-default scope", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      expect(RECOMMENDED_DEFAULT_SCOPE[mode]).toBeDefined();
    }
    expect(Object.keys(RECOMMENDED_DEFAULT_SCOPE).sort()).toEqual([...OPERATOR_CONTEXT_MODES].sort());
  });

  // HG-SAFE — every default permission_prompt_posture is one of the
  // three SAFE values. Defense even at the defaults layer: it should
  // be impossible to ship a default that violates the no-auto-accept
  // rule.
  it("HG-SAFE: every per-mode default permission_prompt_posture is in SAFE_PERMISSION_PROMPT_POSTURES", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      const def = RECOMMENDED_MODE_DEFAULTS[mode];
      expect(SAFE_PERMISSION_PROMPT_POSTURES).toContain(def.permission_prompt_posture);
    }
  });

  // Spot-check the convention's specific table values to catch silent
  // drift between the source-of-truth doc and the ship'd defaults.
  it("matches the convention §Component 3 table for sleep / debug / mobile (load-bearing rows)", () => {
    expect(RECOMMENDED_MODE_DEFAULTS.sleep).toMatchObject({
      autonomy_scope: "pre_approved_only",
      heartbeat_cadence: "sparse",
      escalation_threshold: "blocker_only",
      concurrency_limit: "serial",
      permission_prompt_posture: "batch_for_human",
    });
    expect(RECOMMENDED_MODE_DEFAULTS.debug).toMatchObject({
      autonomy_scope: "bounded_continuation",
      heartbeat_cadence: "fast",
      inspection_depth: "forensic",
      update_detail: "verbose",
      concurrency_limit: "serial",
      // Per convention Component 6 + applied proof: debug does NOT
      // widen permission defaults. Posture stays `normal`.
      permission_prompt_posture: "normal",
    });
    expect(RECOMMENDED_MODE_DEFAULTS.mobile).toMatchObject({
      autonomy_scope: "bounded_continuation",
      inspection_depth: "surface",
      escalation_threshold: "low",
      permission_prompt_posture: "batch_for_human",
    });
  });

  it("matches the convention §Component 4 default-scope table", () => {
    expect(RECOMMENDED_DEFAULT_SCOPE).toEqual({
      sleep: "global_host",
      away: "global_host",
      desk: "global_host",
      mobile: "global_host",
      focus: "workstream",
      debug: "qitem",
    });
  });

  // Per convention Q3, the numeric threshold is deferred; the rule
  // KIND `re_confirm_on_long_gap` is the conservative default
  // selected at v0.
  it("DEFAULT_STALE_RULE is the convention's conservative re-confirmation rule kind", () => {
    expect(DEFAULT_STALE_RULE).toBe("re_confirm_on_long_gap");
  });

  // End-to-end: a complete record assembled from defaults + the
  // default scope + the default stale rule passes the validator.
  // This is the executable proof that the defaults compose into a
  // valid v0 record (no silent dropped/extra fields).
  it("HG-6 executable proof: defaults + default scope + DEFAULT_STALE_RULE compose into a validator-valid record for every mode (10-field record; mode lives at the binding, NOT in the record)", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      const defaults = RECOMMENDED_MODE_DEFAULTS[mode];
      const scope = RECOMMENDED_DEFAULT_SCOPE[mode];
      const record = {
        ...defaults,
        scope,
        expiry_or_stale_rule: DEFAULT_STALE_RULE,
        evidence_citation: `operator confirmed ${mode}`,
      };
      // The record itself must be exactly 10 fields (Component-3 frozen
      // contract). Verify count to anchor field-set integrity here too.
      expect(Object.keys(record).length).toBe(10);
      const result = validateRecord(record);
      expect(result.ok).toBe(true);
    }
  });
});
