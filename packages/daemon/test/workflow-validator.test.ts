import { describe, it, expect } from "vitest";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import type { WorkflowSpec } from "../src/domain/workflow-types.js";

function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: "test",
    version: "1",
    objective: "Test workflow",
    target: { rig: "test-rig" },
    entry: { role: "producer" },
    roles: {
      producer: { preferred_targets: ["producer@rig"] },
      reviewer: { preferred_targets: ["reviewer@rig"] },
    },
    steps: [
      { id: "produce", actor_role: "producer", allowed_exits: ["handoff"] },
      { id: "review", actor_role: "reviewer", allowed_exits: ["done"] },
    ],
    invariants: { allowed_exits: ["handoff", "waiting", "done"] },
    ...overrides,
  };
}

describe("WorkflowValidator (PL-004 Phase D)", () => {
  const validator = new WorkflowValidator();

  it("ok=true on valid spec", () => {
    const result = validator.validate(spec());
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.summary.workflowId).toBe("test");
    expect(result.summary.stepCount).toBe(2);
    expect(result.summary.entryRole).toBe("producer");
  });

  it.each([undefined, 100])("rejects a prerequisite cycle even with max_hops=%s", (maxHops) => {
    const result = validator.validate(spec({
      steps: [
        { id: "produce", actor_role: "producer", depends_on: [] },
        { id: "review", actor_role: "reviewer", depends_on: ["produce", "ship"] },
        { id: "ship", actor_role: "producer", depends_on: ["review"] },
      ],
      loop_guards: maxHops === undefined ? undefined : { max_hops: maxHops },
    }));
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.code === "dependency_cycle")).toMatchObject({
      severity: "error", field: "workflow.steps",
      message: expect.stringContaining("review → ship → review"),
    });
    expect(result.issues.some((issue) => issue.code === "cycle_without_max_hops")).toBe(false);
  });

  it("finds prerequisite cycles outside the entry's reachable component", () => {
    const result = validator.validate(spec({
      steps: [
        { id: "produce", actor_role: "producer", depends_on: [] },
        { id: "review", actor_role: "reviewer", depends_on: ["ship"] },
        { id: "ship", actor_role: "producer", depends_on: ["review"] },
      ],
      loop_guards: { max_hops: 100 },
    }));
    expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(true);
  });

  it.each([undefined, 100])("keeps routing-loop guard semantics with acyclic prerequisites, max_hops=%s", (maxHops) => {
    const result = validator.validate(spec({
      steps: [
        { id: "produce", actor_role: "producer", depends_on: [] },
        { id: "review", actor_role: "reviewer", depends_on: ["produce"], next_hop: { on: { failed: "produce" } } },
      ],
      loop_guards: maxHops === undefined ? undefined : { max_hops: maxHops },
    }));
    expect(result.ok).toBe(maxHops !== undefined);
    expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(false);
    expect(result.issues.some((issue) => issue.code === "cycle_without_max_hops")).toBe(maxHops === undefined);
  });

  it("does not mislabel a missing prerequisite as a cycle", () => {
    const result = validator.validate(spec({
      steps: [{ id: "produce", actor_role: "producer", depends_on: ["missing"] }],
    }));
    expect(result.issues.some((issue) => issue.code === "dependency_step_not_found")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(false);
  });

  it("entry_role_not_declared when entry.role not in roles", () => {
    const result = validator.validate(spec({ entry: { role: "ghost" } }));
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "entry_role_not_declared")).toBeDefined();
  });

  it("step_actor_role_not_declared when step references undeclared role", () => {
    const result = validator.validate(
      spec({
        steps: [{ id: "produce", actor_role: "ghost", allowed_exits: ["handoff"] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_actor_role_not_declared")).toBeDefined();
  });

  it("step_id_duplicate when two steps share an id", () => {
    const result = validator.validate(
      spec({
        steps: [
          { id: "x", actor_role: "producer", allowed_exits: ["handoff"] },
          { id: "x", actor_role: "reviewer", allowed_exits: ["done"] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_id_duplicate")).toBeDefined();
  });

  it("step_exit_not_allowed when step exit outside invariants.allowed_exits", () => {
    const result = validator.validate(
      spec({
        invariants: { allowed_exits: ["done"] },
        steps: [{ id: "produce", actor_role: "producer", allowed_exits: ["handoff"] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_exit_not_allowed")).toBeDefined();
  });

  // A last step that allows only handoff/waiting/failed can never finish: handoff has no
  // next step (the projector refuses with no_next_step) and done is refused by allowed_exits.
  it("step_cannot_finish when a terminal step allows neither done nor a routable exit", () => {
    const result = validator.validate(
      spec({
        invariants: { allowed_exits: ["handoff", "waiting", "done", "failed"] },
        steps: [
          { id: "produce", actor_role: "producer", allowed_exits: ["handoff"] },
          { id: "review", actor_role: "reviewer", allowed_exits: ["handoff", "waiting", "failed"] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.filter((i) => i.code === "step_cannot_finish")).toEqual([
      expect.objectContaining({
        severity: "error",
        field: "workflow.steps[1].allowed_exits",
        message: expect.stringContaining('step "review"'),
      }),
    ]);
  });

  it.each([
    ["done is allowed", { allowed_exits: ["handoff", "waiting", "done"] }],
    ["allowed_exits is omitted", {}],
    ["an allowed exit is branch-mapped", { allowed_exits: ["handoff", "failed"], next_hop: { on: { failed: "produce" } } }],
  ] as const)("no step_cannot_finish on the last step when %s", (_label, last) => {
    const result = validator.validate(
      spec({
        steps: [
          { id: "produce", actor_role: "producer", allowed_exits: ["handoff", "done"] },
          { id: "review", actor_role: "reviewer", ...last },
        ],
        invariants: { allowed_exits: ["handoff", "waiting", "done", "failed"] },
        loop_guards: { max_hops: 10 },
      }),
    );
    expect(result.issues.filter((i) => i.code === "step_cannot_finish")).toEqual([]);
  });

  it("no step_cannot_finish when handoff has a next step", () => {
    const result = validator.validate(spec());
    expect(result.issues.filter((i) => i.code === "step_cannot_finish")).toEqual([]);
  });

  it("no step_cannot_finish for a handoff-only sink in a dependency graph (handoff completes it)", () => {
    const result = validator.validate(
      spec({
        steps: [
          { id: "produce", actor_role: "producer", depends_on: [], allowed_exits: ["handoff"] },
          { id: "review", actor_role: "reviewer", depends_on: ["produce"], allowed_exits: ["handoff", "failed"] },
        ],
      }),
    );
    expect(result.issues.filter((i) => i.code === "step_cannot_finish")).toEqual([]);
  });

  it("step_cannot_finish in a dependency graph when no allowed exit completes the step", () => {
    const result = validator.validate(
      spec({
        steps: [
          { id: "produce", actor_role: "producer", depends_on: [], allowed_exits: ["handoff"] },
          { id: "review", actor_role: "reviewer", depends_on: ["produce"], allowed_exits: ["waiting", "failed"] },
        ],
      }),
    );
    expect(result.issues.find((i) => i.code === "step_cannot_finish")).toMatchObject({
      field: "workflow.steps[1].allowed_exits",
    });
  });

  it("step_id_missing when step has no id", () => {
    const result = validator.validate(
      spec({
        steps: [{ id: "", actor_role: "producer" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_id_missing")).toBeDefined();
  });

  it("step_actor_role_missing when step has no actor_role", () => {
    const result = validator.validate(
      spec({
        steps: [{ id: "x", actor_role: "" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_actor_role_missing")).toBeDefined();
  });

  it("seat liveness warning when role's preferred_targets are all dead", () => {
    const result = validator.validate(spec(), () => ({ alive: false, reason: "no session" }));
    expect(result.ok).toBe(true); // warnings don't fail
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.find((w) => w.code === "role_no_live_preferred_target")).toBeDefined();
  });

  it("seat liveness no warning when at least one preferred_target alive", () => {
    const result = validator.validate(spec(), () => ({ alive: true }));
    expect(result.issues.filter((i) => i.code === "role_no_live_preferred_target")).toEqual([]);
  });
});
