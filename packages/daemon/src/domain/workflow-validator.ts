// PL-004 Phase D: workflow validator.
//
// Validates a workflow spec against:
//   - Role resolution: every step's actor_role must reference a role
//     declared in `roles`.
//   - Entry resolution: workflow.entry.role (if present) must reference
//     a declared role.
//   - Exit consistency: every step's allowed_exits[] must be a subset of
//     workflow.invariants.allowed_exits[] (if invariants present).
//   - Step ID uniqueness.
//
// Seat-liveness checks are an optional v1 graduation; PRD § L4 calls
// for them but the v1 minimum can ship without them. The validator
// exposes a `seatLivenessCheck` callback so callers (CLI / route)
// can inject a liveness probe; absence skips the check.
//
// Returns a structured ValidationResult — per PRD § Honest error
// reporting "what failed + why it matters + what to do".

import type { WorkflowSpec } from "./workflow-types.js";

export interface ValidationIssue {
  code: string;
  /** Plain-English what + why + what-to-do. */
  message: string;
  /** Field path (e.g., "workflow.steps[1].actor_role"). */
  field?: string;
  /** Severity: error blocks; warning is informational. */
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  summary: {
    workflowId: string;
    workflowVersion: string;
    targetRig: string | null;
    entryRole: string | null;
    stepCount: number;
  };
}

export interface SeatLivenessCheckFn {
  (sessionRef: string): { alive: boolean; reason?: string };
}

export class WorkflowValidator {
  validate(
    spec: WorkflowSpec,
    seatLivenessCheck?: SeatLivenessCheckFn,
  ): ValidationResult {
    const issues: ValidationIssue[] = [];
    const declaredRoles = new Set(Object.keys(spec.roles ?? {}));

    if (spec.entry?.role && !declaredRoles.has(spec.entry.role)) {
      issues.push({
        code: "entry_role_not_declared",
        message: `entry role "${spec.entry.role}" is not declared in workflow.roles. Add the role to workflow.roles or change the entry to a declared role.`,
        field: "workflow.entry.role",
        severity: "error",
      });
    }

    const seenStepIds = new Set<string>();
    const allowedExitsInvariant = spec.invariants?.allowed_exits;
    spec.steps.forEach((step, idx) => {
      const fieldBase = `workflow.steps[${idx}]`;
      if (!step.id) {
        issues.push({
          code: "step_id_missing",
          message: `step at ${fieldBase} is missing an id. Every step must have a stable id used to reference it from next_hop hints and step trails.`,
          field: `${fieldBase}.id`,
          severity: "error",
        });
        return;
      }
      if (seenStepIds.has(step.id)) {
        issues.push({
          code: "step_id_duplicate",
          message: `duplicate step id "${step.id}" at ${fieldBase}. Step ids must be unique within a workflow.`,
          field: `${fieldBase}.id`,
          severity: "error",
        });
      }
      seenStepIds.add(step.id);

      if (!step.actor_role) {
        issues.push({
          code: "step_actor_role_missing",
          message: `step "${step.id}" is missing actor_role. Declare which role drives this step so the projector can derive the next-step owner.`,
          field: `${fieldBase}.actor_role`,
          severity: "error",
        });
      } else if (!declaredRoles.has(step.actor_role)) {
        issues.push({
          code: "step_actor_role_not_declared",
          message: `step "${step.id}" references role "${step.actor_role}" which is not declared in workflow.roles. Add the role to workflow.roles or change the step.`,
          field: `${fieldBase}.actor_role`,
          severity: "error",
        });
      }

      if (step.allowed_exits && allowedExitsInvariant) {
        for (const exit of step.allowed_exits) {
          if (!allowedExitsInvariant.includes(exit)) {
            issues.push({
              code: "step_exit_not_allowed",
              message: `step "${step.id}" allows exit "${exit}" which is not in workflow.invariants.allowed_exits. Either remove the exit from the step or extend the invariant.`,
              field: `${fieldBase}.allowed_exits`,
              severity: "error",
            });
          }
        }
      }
    });

    if (seatLivenessCheck) {
      // Probe each role's preferred_targets[]. A role with no live
      // preferred target produces a warning (not an error) — agents
      // can still be resolved at runtime via runtime-adapter / claim.
      for (const [roleName, role] of Object.entries(spec.roles ?? {})) {
        const targets = role?.preferred_targets ?? [];
        if (targets.length === 0) continue;
        const liveAny = targets.some((t) => seatLivenessCheck(t).alive);
        if (!liveAny) {
          issues.push({
            code: "role_no_live_preferred_target",
            message: `role "${roleName}" has preferred_targets ${JSON.stringify(targets)} but none are live. The instance may stall at the first step requiring this role; ensure at least one target is up before instantiating, or rely on dynamic resolution at runtime.`,
            field: `workflow.roles.${roleName}.preferred_targets`,
            severity: "warning",
          });
        }
      }
    }

    const errors = issues.filter((i) => i.severity === "error");
    return {
      ok: errors.length === 0,
      issues,
      summary: {
        workflowId: spec.id,
        workflowVersion: spec.version,
        targetRig: spec.target?.rig ?? null,
        entryRole: spec.entry?.role ?? null,
        stepCount: spec.steps.length,
      },
    };
  }
}
