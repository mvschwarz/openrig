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
