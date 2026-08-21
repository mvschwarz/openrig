// Slice 09 — type-level discriminators (OPR.0.3.2.9).
//
// These tests anchor the FROZEN convention's vocabulary + the
// HG-SAFE structural block on auto-accept. They are runtime-thin
// (most coverage is type-level by virtue of the closed unions), but
// they assert the constant arrays match the type unions so a future
// drift between the value list and the type alias surfaces here.

import { describe, it, expect } from "vitest";
import {
  OPERATOR_CONTEXT_MODES,
  OPERATOR_CONTEXT_SCOPES,
  SAFE_PERMISSION_PROMPT_POSTURES,
  SCOPE_SPECIFICITY,
  STALE_RULES,
} from "../src/domain/rig-policy/rig-policy-types.js";

describe("rig-policy types — slice 09 frozen contract", () => {
  // HG-1 — six modes, exact, reserved, closed.
  it("HG-1: exposes exactly the six reserved mode names (lowercase single words)", () => {
    expect([...OPERATOR_CONTEXT_MODES]).toEqual([
      "sleep",
      "desk",
      "mobile",
      "away",
      "focus",
      "debug",
    ]);
    for (const m of OPERATOR_CONTEXT_MODES) {
      expect(m).toMatch(/^[a-z]+$/);
    }
  });

  // HG-1 negative — synonyms and numeric aliases are NOT in the list.
  // The L0–L3 collision warning is load-bearing; namespaced numeric
  // forms (e.g., `operator:L2`) are equally forbidden.
  it("HG-1 negative: forbidden synonyms / aliases are not present", () => {
    const forbidden = [
      "dnd",
      "ooo",
      "commute",
      "bed",
      "office",
      "L0",
      "L1",
      "L2",
      "L3",
      "operator:L0",
      "operator:L2",
      "Sleep",
      "DEBUG",
    ];
    for (const f of forbidden) {
      expect(OPERATOR_CONTEXT_MODES as readonly string[]).not.toContain(f);
    }
  });

  // HG-3 — four scopes, exact, reserved.
  it("HG-3: exposes exactly the four reserved scope names", () => {
    expect([...OPERATOR_CONTEXT_SCOPES]).toEqual([
      "global_host",
      "rig",
      "workstream",
      "qitem",
    ]);
  });

  // HG-3 — scope specificity ranks support "more-specific wins"
  // resolution (qitem > workstream > rig > global_host).
  it("HG-3: scope specificity ranks support more-specific-wins resolution", () => {
    expect(SCOPE_SPECIFICITY.qitem).toBeGreaterThan(SCOPE_SPECIFICITY.workstream);
    expect(SCOPE_SPECIFICITY.workstream).toBeGreaterThan(SCOPE_SPECIFICITY.rig);
    expect(SCOPE_SPECIFICITY.rig).toBeGreaterThan(SCOPE_SPECIFICITY.global_host);
  });

  // HG-SAFE — permission_prompt_posture STRUCTURALLY excludes auto-accept.
  // The constant list mirrors the union; the union has no auto-accept
  // literal; therefore no caller can express auto-accept through the
  // type system. The runtime validator enforces the same for inputs
  // that bypass types (JSON, env, etc.) — see rig-policy-validator tests.
  it("HG-SAFE (type-level): SAFE_PERMISSION_PROMPT_POSTURES enumerates the only three safe values; auto-accept is absent", () => {
    expect([...SAFE_PERMISSION_PROMPT_POSTURES]).toEqual([
      "normal",
      "batch_for_human",
      "do_not_prompt_unless_blocked",
    ]);
    const forbidden = [
      "auto_accept",
      "autoaccept",
      "auto",
      "accept_all",
      "allow_all",
      "yes_to_all",
    ];
    for (const f of forbidden) {
      expect(SAFE_PERMISSION_PROMPT_POSTURES as readonly string[]).not.toContain(f);
    }
  });

  // HG-8 — drift rules enumerated; NO silent-switch value exists.
  // The rule values cause re-confirmation (a question); none of them
  // ever auto-applies a mode change.
  it("HG-8: stale rules enumerate re-confirmation triggers; no silent-switch value", () => {
    expect([...STALE_RULES]).toEqual([
      "none",
      "re_confirm_on_long_gap",
      "re_confirm_on_day_boundary",
      "re_confirm_on_observed_conflict",
    ]);
    const forbidden = [
      "auto_switch",
      "switch_on_long_gap",
      "switch_on_day_boundary",
      "drift_switch",
    ];
    for (const f of forbidden) {
      expect(STALE_RULES as readonly string[]).not.toContain(f);
    }
  });
});
