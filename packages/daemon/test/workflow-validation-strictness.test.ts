// OPR.0.4.6.WF1 FR-7 (G7): parse strictness + graph validation.
//
//   - unknown keys at EVERY level fail loud at parse (what/why/fix)
//     against the exported closed keysets (WF-2 extends them);
//   - next_hop.suggested_roles naming an undeclared role or a role no
//     step satisfies fails loud;
//   - unreachable steps fail loud (the deterministic single-successor
//     walk from the entry, run over the projector's OWN exported
//     resolveNextStep — never a parallel re-implementation);
//   - a cycle WITHOUT max_hops fails naming the fix; WITH max_hops it
//     validates (FR-6 sanctions it);
//   - the no-false-rejection negative: BOTH shipped builtin starter
//     specs still parse AND validate clean.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWorkflowSpec,
  WorkflowSpecError,
  WORKFLOW_TOP_LEVEL_KEYS,
  WORKFLOW_STEP_KEYS,
} from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";

const BASE = `workflow:
  id: strictness
  version: 1
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: work
      actor_role: worker
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - next
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

function validateYaml(yaml: string) {
  const spec = parseWorkflowSpec(yaml, "test://strictness.yaml");
  return new WorkflowValidator().validate(spec);
}

describe("FR-7 parse strictness: unknown keys fail loud at every level", () => {
  const CASES: Array<{ label: string; yaml: string; key: string; path: string }> = [
    {
      label: "top-level",
      yaml: BASE.replace("  roles:", "  retry_policy: aggressive\n  roles:"),
      key: "retry_policy",
      path: "workflow",
    },
    {
      label: "step-level",
      // OPR.0.4.6.WF2: `harness` became a LEGAL step key — the unknown-key
      // example is now a misspelling of it.
      yaml: BASE.replace("      actor_role: worker", "      actor_role: worker\n      harnesss: codex"),
      key: "harnesss",
      path: "workflow.steps[0]",
    },
    {
      label: "role-level",
      yaml: BASE.replace(
        "      preferred_targets:\n        - worker@rig",
        "      fallback: none\n      preferred_targets:\n        - worker@rig",
      ),
      key: "fallback",
      path: "workflow.roles.worker",
    },
    {
      label: "next_hop-level",
      yaml: BASE.replace(
        "      next_hop:\n        suggested_roles:",
        "      next_hop:\n        on_failure: retry\n        suggested_roles:",
      ),
      key: "on_failure",
      path: "workflow.steps[0].next_hop",
    },
    {
      label: "entry-level",
      yaml: BASE.replace("    role: worker", "    role: worker\n    fallback_role: next"),
      key: "fallback_role",
      path: "workflow.entry",
    },
  ];

  for (const c of CASES) {
    it(`${c.label}: unknown key "${c.key}" rejected naming key, path, and the allowed set`, () => {
      let thrown: unknown;
      try {
        parseWorkflowSpec(c.yaml, "test://strictness.yaml");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkflowSpecError);
      const e = thrown as WorkflowSpecError;
      expect(e.code).toBe("spec_unknown_key");
      expect(e.message).toContain(`"${c.key}"`);
      expect(e.message).toContain(c.path);
      expect(e.message).toContain("Allowed keys");
    });
  }

  it("the closed keysets are exported named constants (the WF-2 extension seam)", () => {
    expect(WORKFLOW_TOP_LEVEL_KEYS).toContain("loop_guards");
    expect(WORKFLOW_STEP_KEYS).toContain("next_hop");
    // WF-2 extends these arrays; a frozen-in-place literal elsewhere
    // would break that contract.
  });

  it("a fully known-key spec parses clean", () => {
    expect(() => parseWorkflowSpec(BASE, "test://ok.yaml")).not.toThrow();
  });
});

describe("FR-7 graph validation over the REAL resolution semantics", () => {
  it("suggested role not declared → error; declared but no step carries it → error", () => {
    const undeclared = validateYaml(
      BASE.replace("          - next", "          - phantom-role"),
    );
    expect(undeclared.ok).toBe(false);
    expect(
      undeclared.issues.some((i) => i.code === "next_hop_role_not_declared"),
    ).toBe(true);

    const noStep = validateYaml(
      BASE.replace(
        "    next:\n      preferred_targets:\n        - next@rig",
        "    next:\n      preferred_targets:\n        - next@rig\n    ghost:\n      preferred_targets:\n        - ghost@rig",
      ).replace("          - next", "          - ghost"),
    );
    expect(noStep.ok).toBe(false);
    expect(noStep.issues.some((i) => i.code === "next_hop_role_has_no_step")).toBe(true);
  });

  it("an unreachable step fails loud naming the walk", () => {
    // `work` routes to `follow` via suggested_roles; `orphan` sits
    // after a forbid terminal — the walk never reaches it.
    const yaml = `workflow:
  id: unreachable
  version: 1
  roles:
    worker:
      preferred_targets:
        - worker@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: work
      actor_role: worker
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - next
    - id: follow
      actor_role: next
      allowed_exits:
        - done
      next_hop:
        mode: forbid
    - id: orphan
      actor_role: worker
      allowed_exits:
        - done
`;
    const result = validateYaml(yaml);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "step_unreachable")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain('"orphan"');
    // OPR.0.4.6.WF2: reachability is a graph walk (structural ∪ branch
    // edges); the message names the entry step instead of a linear walk.
    expect(issue.message).toContain('"work"');
    expect(issue.message).toContain("branch edge");
  });

  it("a cycle WITHOUT max_hops fails naming the cycle and the fix; WITH max_hops it validates (the FR-6 sanction)", () => {
    const cyclic = `workflow:
  id: cyclic
  version: 1
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: ping-step
      actor_role: ping
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - pong
    - id: pong-step
      actor_role: pong
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - ping
`;
    const unguarded = validateYaml(cyclic);
    expect(unguarded.ok).toBe(false);
    const issue = unguarded.issues.find((i) => i.code === "cycle_without_max_hops")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain("ping-step → pong-step → ping-step");
    expect(issue.message).toContain("loop_guards.max_hops");

    const guarded = validateYaml(
      cyclic + "  loop_guards:\n    max_hops: 5\n",
    );
    expect(guarded.issues.some((i) => i.code === "cycle_without_max_hops")).toBe(false);
    expect(guarded.ok).toBe(true);
  });

  it("declaration-order fallback edges count for reachability (a linear spec with no next_hop at all validates)", () => {
    const plain = `workflow:
  id: plain-linear
  version: 1
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: a
      actor_role: worker
    - id: b
      actor_role: worker
    - id: c
      actor_role: worker
`;
    const result = validateYaml(plain);
    expect(result.ok).toBe(true);
  });
});

describe("FR-7 no-false-rejection negative: every shipped builtin starter spec still parses AND validates", () => {
  const BUILTIN_DIR = join(
    __dirname,
    "..",
    "src",
    "builtins",
    "workflow-specs",
  );
  for (const name of ["basic-loop.yaml", "conveyor.yaml"]) {
    it(`${name} parses + validates clean under the new strictness`, () => {
      const raw = readFileSync(join(BUILTIN_DIR, name), "utf-8");
      const spec = parseWorkflowSpec(raw, `builtin://${name}`);
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});

// ── OPR.0.4.6.WF1 guard blockers 2 + 3 regressions ───────────────────

describe("guard blocker 2: loop_guards SHAPE validation — an unenforceable guard can never sanction a cycle", () => {
  const CYCLIC_WITH = (maxHopsYaml: string) => `workflow:
  id: shape-cycle
  version: 1
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: ping-step
      actor_role: ping
      next_hop:
        suggested_roles:
          - pong
    - id: pong-step
      actor_role: pong
      next_hop:
        suggested_roles:
          - ping
  loop_guards:
    max_hops: ${maxHopsYaml}
`;

  for (const bad of ['nope', '"3"', "3.5", "0", "-2"]) {
    it(`max_hops: ${bad} rejects loud at parse (spec_field_invalid) — never a NaN guard sanctioning an unbounded loop`, () => {
      let thrown: unknown;
      try {
        parseWorkflowSpec(CYCLIC_WITH(bad), "test://shape.yaml");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkflowSpecError);
      const e = thrown as WorkflowSpecError;
      expect(e.code).toBe("spec_field_invalid");
      expect(e.message).toContain("max_hops");
    });
  }

  it("max_hops: null is treated as ABSENT at parse — the cycle rule then fails validation (no null loophole)", () => {
    const spec = parseWorkflowSpec(CYCLIC_WITH("null"), "test://null.yaml");
    const result = new WorkflowValidator().validate(spec);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "cycle_without_max_hops")).toBe(true);
  });

  it("spawn_budget shape: negative/non-integer rejects; 0 stays legal (the shipped builtins use 0)", () => {
    expect(() =>
      parseWorkflowSpec(CYCLIC_WITH("3").replace("max_hops: 3", "max_hops: 3\n    spawn_budget: -1"), "t://x"),
    ).toThrow(/spawn_budget/);
    expect(() =>
      parseWorkflowSpec(CYCLIC_WITH("3").replace("max_hops: 3", "max_hops: 3\n    spawn_budget: 0"), "t://x"),
    ).not.toThrow();
  });

  it("document-root strictness: a stray sibling of `workflow:` at the YAML root rejects loud", () => {
    const yaml = BASE + "extra_root_key: true\n";
    let thrown: unknown;
    try {
      parseWorkflowSpec(yaml, "test://root.yaml");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowSpecError);
    expect((thrown as WorkflowSpecError).code).toBe("spec_unknown_key");
    expect((thrown as WorkflowSpecError).message).toContain("(document root)");
  });

  it("validator second layer: a cached-blob spec with a string max_hops does NOT sanction a cycle (pre-fix spec_json defense)", () => {
    // Bypass the parser deliberately — this is the stale-cached-blob shape.
    const spec = parseWorkflowSpec(CYCLIC_WITH("5"), "test://ok.yaml");
    (spec.loop_guards as Record<string, unknown>).max_hops = "5";
    const result = new WorkflowValidator().validate(spec);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "cycle_without_max_hops")).toBe(true);
  });
});

describe("guard blocker 3: steps[0] is THE entry authority — a disagreeing entry.role rejects loud", () => {
  it("entry.role != steps[0].actor_role → entry_role_mismatch error naming the fix", () => {
    const yaml = BASE.replace("    role: worker", "    role: next");
    const result = validateYaml(yaml);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "entry_role_mismatch")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain('steps[0]');
    expect(issue.message).toContain('"next"');
  });

  it("entry.role matching steps[0].actor_role validates clean (both shipped builtins keep passing — pinned above)", () => {
    expect(validateYaml(BASE).ok).toBe(true);
  });
});
