// RSI v2 starter v0 — pin the canonical bundled spec file's shape.
//
// This test reads the actual builtins/workflow-specs/rsi-v2-hot-potato.yaml
// shipped with the daemon and validates it against PL-004 Phase D's
// parser + validator. If the spec drifts (someone edits the YAML in a
// way that breaks Phase D's contract), this test fails loudly. Pin both
// the parse path AND the structural shape (5 roles, 5 steps, hot-potato
// rule, expected role+step ids) so the canonical RSI v2 loop content
// stays canonical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";

const SPEC_PATH = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "src",
  "builtins",
  "workflow-specs",
  "rsi-v2-hot-potato.yaml",
);

const EXPECTED_ROLE_IDS = [
  "discovery-router",
  "product-lab-planner",
  "delivery-driver",
  "lifecycle-router",
  "qa-tester",
];

const EXPECTED_STEP_IDS = ["discovery", "product-lab", "delivery", "lifecycle", "qa"];

describe("RSI v2 starter spec content", () => {
  const raw = readFileSync(SPEC_PATH, "utf-8");
  const spec = parseWorkflowSpec(raw, SPEC_PATH);

  it("parses cleanly via Phase D's parseWorkflowSpec without throwing", () => {
    // The parse already happened above; if it threw, the test setup
    // wouldn't even reach here.
    expect(spec).toBeDefined();
  });

  it("declares the canonical name + version", () => {
    expect(spec.id).toBe("rsi-v2-hot-potato");
    expect(spec.version).toBe("1");
  });

  it("uses hot_potato as the coordination_terminal_turn_rule (per founder default)", () => {
    expect(spec.coordination_terminal_turn_rule).toBe("hot_potato");
  });

  it("declares exactly the five canonical RSI v2 roles", () => {
    const roleIds = Object.keys(spec.roles ?? {}).sort();
    expect(roleIds).toEqual([...EXPECTED_ROLE_IDS].sort());
  });

  it("declares exactly the five canonical RSI v2 steps in loop order", () => {
    const stepIds = spec.steps.map((s) => s.id);
    expect(stepIds).toEqual(EXPECTED_STEP_IDS);
  });

  it("each step's actor_role resolves against a declared role", () => {
    const declared = new Set(Object.keys(spec.roles ?? {}));
    for (const step of spec.steps) {
      expect(declared.has(step.actor_role)).toBe(true);
    }
  });

  it("entry role is discovery-router (matches the founder loop start)", () => {
    expect(spec.entry?.role).toBe("discovery-router");
  });

  it("loop edge: qa step's next_hop suggests routing back to discovery-router", () => {
    const qa = spec.steps.find((s) => s.id === "qa");
    expect(qa?.next_hop?.suggested_roles).toContain("discovery-router");
  });

  it("qa step allows `done` as a terminal exit (no-follow-on case)", () => {
    const qa = spec.steps.find((s) => s.id === "qa");
    expect(qa?.allowed_exits).toContain("done");
  });

  it("non-qa steps do NOT permit `done` (only qa is a valid terminal)", () => {
    for (const step of spec.steps) {
      if (step.id === "qa") continue;
      expect(step.allowed_exits ?? []).not.toContain("done");
    }
  });

  it("invariants permit all four exit kinds (steps subset)", () => {
    expect(spec.invariants?.allowed_exits).toEqual(
      expect.arrayContaining(["handoff", "waiting", "done", "failed"]),
    );
  });

  it("loop_guards.max_hops is set to a finite ceiling", () => {
    expect(spec.loop_guards?.max_hops).toBe(30);
  });

  it("passes Phase D's WorkflowValidator with no errors", () => {
    const validator = new WorkflowValidator();
    const result = validator.validate(spec);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
