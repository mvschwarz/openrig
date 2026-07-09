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

import type { WorkflowSpec, WorkflowStepSpec } from "./workflow-types.js";
import { resolveNextStep } from "./workflow-projector.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";

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

/** OPR.0.4.6.WF2 FR-3: host-registry membership probe. Injected by the
 *  runtime (built on the daemon hosts-registry reader) so the validator
 *  stays pure; absent (bare unit tests) skips the membership check —
 *  the production validate/instantiate path always injects it. */
export interface HostRegistryLookupFn {
  (hostId: string): { registered: boolean; registeredIds: string[] };
}

export class WorkflowValidator {
  validate(
    spec: WorkflowSpec,
    seatLivenessCheck?: SeatLivenessCheckFn,
    hostRegistryLookup?: HostRegistryLookupFn,
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

    // OPR.0.4.6.WF1 (guard blocker 3): steps[0] is THE authoritative
    // entry (the ratified WF-2 grounding: entry.role is cross-checked,
    // not resolved — workflow-runtime.ts instantiates from steps[0]).
    // A declared entry.role that DISAGREES with steps[0].actor_role
    // would make validation/graph surfaces claim entry B while the
    // runtime routes the first packet to A — rejected loud so the
    // contract can never silently fork.
    if (
      spec.entry?.role &&
      spec.steps[0]?.actor_role &&
      spec.entry.role !== spec.steps[0].actor_role
    ) {
      issues.push({
        code: "entry_role_mismatch",
        message: `workflow.entry.role is "${spec.entry.role}" but the authoritative entry is steps[0] ("${spec.steps[0].id}", actor_role "${spec.steps[0].actor_role}") — the runtime instantiates from steps[0], so a differing entry.role would lie on every surface that reports it. Reorder steps so the intended entry step is first, or fix/remove entry.role.`,
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

    // ── OPR.0.4.6.WF1 FR-7 (G7): graph validation over the REAL
    // resolution semantics — the walk below calls the projector's own
    // exported resolveNextStep (suggested_roles edges ∪
    // declaration-order fallback, forbid/require cuts honored), never
    // a parallel re-implementation. ──────────────────────────────────

    // next_hop.suggested_roles target checks: each suggested role must
    // be declared AND resolvable to at least one step (that is how
    // resolveNextStep matches — a suggestion no step satisfies is a
    // dead edge the author almost certainly misspelled).
    spec.steps.forEach((step, idx) => {
      for (const role of step.next_hop?.suggested_roles ?? []) {
        const fieldBase = `workflow.steps[${idx}].next_hop.suggested_roles`;
        if (!declaredRoles.has(role)) {
          issues.push({
            code: "next_hop_role_not_declared",
            message: `step "${step.id}" suggests next-hop role "${role}" which is not declared in workflow.roles. Declare the role or fix the spelling — the edge can never route.`,
            field: fieldBase,
            severity: "error",
          });
        } else if (!spec.steps.some((s) => s.actor_role === role)) {
          issues.push({
            code: "next_hop_role_has_no_step",
            message: `step "${step.id}" suggests next-hop role "${role}" but no step declares actor_role "${role}" — resolveNextStep matches suggestions against step actor_roles, so this edge can never route. Add a step for the role or fix the suggestion.`,
            field: fieldBase,
            severity: "error",
          });
        }
      }
    });

    // OPR.0.4.6.WF2 FR-1: branch-edge checks — every next_hop.on target
    // must be an existing step id (the branch key set itself is closed
    // at parse). A dead branch edge can never route.
    spec.steps.forEach((step, idx) => {
      for (const [exitKey, targetId] of Object.entries(step.next_hop?.on ?? {})) {
        if (targetId && !spec.steps.some((s) => s.id === targetId)) {
          issues.push({
            code: "branch_target_not_found",
            message: `step "${step.id}" branches exit "${exitKey}" to step "${targetId}" which does not exist. Fix the step id or remove the branch — the edge can never route.`,
            field: `workflow.steps[${idx}].next_hop.on.${exitKey}`,
            severity: "error",
          });
        }
      }
    });

    // Reachability + cycle detection over the FULL successor graph:
    // the structural edge (the projector's own exported resolveNextStep
    // — never a parallel re-implementation) UNIONED with the WF-2
    // branch edges (arch composition note: branch edges CREATE cycles —
    // failed → remediate → verify → failed is the canonical remediation
    // loop). A cycle is legitimate ONLY under a declared, enforceable
    // max_hops (FR-6 enforces it at projection; without the guard it
    // would hop unbounded, so validation fails naming the fix).
    if (spec.steps.length > 0 && spec.steps.every((s) => s.id)) {
      const stepById = new Map(spec.steps.map((s) => [s.id, s]));
      const successorsOf = (step: WorkflowStepSpec): string[] => {
        const out: string[] = [];
        const structural = resolveNextStep(spec, step);
        if (structural) out.push(structural.id);
        for (const targetId of Object.values(step.next_hop?.on ?? {})) {
          if (targetId && stepById.has(targetId) && !out.includes(targetId)) {
            out.push(targetId);
          }
        }
        return out;
      };
      // Reachability: BFS from the authoritative entry (steps[0]).
      const reachable = new Set<string>();
      const queue: string[] = [spec.steps[0]!.id];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        const step = stepById.get(id);
        if (step) queue.push(...successorsOf(step));
      }
      // Cycle detection: DFS with an explicit recursion stack over the
      // same successor graph; the first back-edge found names the cycle.
      let cyclePath: string[] | null = null;
      const color = new Map<string, "gray" | "black">();
      const stack: string[] = [];
      const dfs = (id: string): boolean => {
        color.set(id, "gray");
        stack.push(id);
        const step = stepById.get(id);
        for (const succ of step ? successorsOf(step) : []) {
          const c = color.get(succ);
          if (c === "gray") {
            cyclePath = [...stack.slice(stack.indexOf(succ)), succ];
            return true;
          }
          if (c !== "black" && dfs(succ)) return true;
        }
        stack.pop();
        color.set(id, "black");
        return false;
      };
      dfs(spec.steps[0]!.id);
      // Guard blocker 2: only an ENFORCEABLE guard sanctions a cycle —
      // a non-integer/non-positive max_hops (possible in pre-fix cached
      // spec_json blobs; the parser now rejects new ones) can never
      // trip at projection, so it sanctions nothing.
      const enforceableMaxHops =
        typeof spec.loop_guards?.max_hops === "number" &&
        Number.isInteger(spec.loop_guards.max_hops) &&
        spec.loop_guards.max_hops >= 1;
      if (cyclePath && !enforceableMaxHops) {
        issues.push({
          code: "cycle_without_max_hops",
          message: `the routing graph cycles (${(cyclePath as string[]).join(" → ")}) and workflow.loop_guards.max_hops is not declared — the instance would hop unbounded. Loops (including branch-created remediation loops) are legitimate only under an enforced guard: declare loop_guards.max_hops to sanction the cycle.`,
          field: "workflow.loop_guards.max_hops",
          severity: "error",
        });
      }
      for (const step of spec.steps) {
        if (step.id && !reachable.has(step.id)) {
          issues.push({
            code: "step_unreachable",
            message: `step "${step.id}" is unreachable: neither the structural routing walk from the entry step ("${spec.steps[0]!.id}") nor any branch edge reaches it. Fix the next_hop edges/branches or remove the dead step.`,
            field: `workflow.steps`,
            severity: "error",
          });
        }
      }
    }

    // OPR.0.4.6.WF2 FR-3: host-pin membership against the live registry
    // (when the production lookup is injected). "local" and absent are
    // always legal; an unknown id can never route.
    if (hostRegistryLookup) {
      spec.steps.forEach((step, idx) => {
        if (step.host && step.host !== "local") {
          const probe = hostRegistryLookup(step.host);
          if (!probe.registered) {
            issues.push({
              code: "host_not_registered",
              message: `step "${step.id}" pins host "${step.host}" which is not in the hosts registry (~/.openrig/hosts.yaml). Registered ids: ${probe.registeredIds.length > 0 ? `[${probe.registeredIds.join(", ")}]` : "(none)"}. Register the host with rig host add, use "local", or remove the pin.`,
              field: `workflow.steps[${idx}].host`,
              severity: "error",
            });
          }
        }
      });
    }

    // OPR.0.4.6.WF2 FR-5: gate target semantics — a HUMAN-seat target
    // requires summary + evidence_ref (the shipped human-route write
    // path enforces them at create; failing HERE is the fail-at-author-
    // time mini-req); any other target must be a declared role. A
    // handler role with no preferred_targets gets a warning (the gate
    // compile fails loud at trip time if still unresolvable).
    spec.steps.forEach((step, idx) => {
      const gate = step.gate;
      if (!gate) return;
      const fieldBase = `workflow.steps[${idx}].gate`;
      if (isHumanSeatSession(gate.target)) {
        if (!gate.summary || !gate.evidence_ref) {
          issues.push({
            code: "gate_human_fields_missing",
            message: `step "${step.id}" gates on human seat ${gate.target} but is missing ${!gate.summary ? "summary" : "evidence_ref"}. A human-routed gate item must carry a plain-language summary AND a durable evidence pointer (the shipped human-route contract) — add both.`,
            field: fieldBase,
            severity: "error",
          });
        }
      } else if (!declaredRoles.has(gate.target)) {
        issues.push({
          code: "gate_target_unresolved",
          message: `step "${step.id}" gates on "${gate.target}" which is neither a human seat session (human@kernel form) nor a role declared in workflow.roles. Declare the handler role or use a human seat session.`,
          field: `${fieldBase}.target`,
          severity: "error",
        });
      } else if ((spec.roles?.[gate.target]?.preferred_targets ?? []).length === 0) {
        issues.push({
          code: "gate_handler_no_targets",
          message: `step "${step.id}" gates on handler role "${gate.target}" which declares no preferred_targets — the gate item will have no seat to route to when it trips. Add preferred_targets to the role before instantiating.`,
          field: `${fieldBase}.target`,
          severity: "warning",
        });
      }
    });

    // ── OPR.0.4.6.WF1 FR-9 (G8): the inert-config sweep — every
    // declared-but-unenforced key is EXPLICITLY-V2, machine-readably:
    // using one produces a fail-open advisory (warning, exit 0) naming
    // the key as declared-but-not-enforced-in-v1. No key may sit in
    // the silent third state. Consumed keys get no advisory:
    // invariants.allowed_exits (projector exit enforcement),
    // loop_guards.max_hops (FR-6), roles.*.preferred_targets
    // (owner resolution). ──────────────────────────────────────────
    const v2Advisory = (key: string, field: string, extra?: string) => {
      issues.push({
        code: "declared_not_enforced_v1",
        message: `"${key}" is declared but not enforced in v1 — the engine records it without acting on it${extra ? ` (${extra})` : ""}. Keep it for forward-compatibility or remove it; it changes nothing today.`,
        field,
        severity: "warning",
      });
    };
    if (spec.invariants?.continuation_required !== undefined) {
      v2Advisory("invariants.continuation_required", "workflow.invariants.continuation_required");
    }
    if (spec.invariants?.preserve_lineage !== undefined) {
      v2Advisory("invariants.preserve_lineage", "workflow.invariants.preserve_lineage",
        "lineage IS always preserved via chain_of_record; the flag itself gates nothing");
    }
    if (spec.invariants?.closure_required !== undefined) {
      v2Advisory("invariants.closure_required", "workflow.invariants.closure_required",
        "closure IS always required by the hot-potato contract; the flag itself gates nothing");
    }
    if (spec.closure) {
      v2Advisory("closure.{success,degraded,failed}", "workflow.closure",
        "display-only messages; no consumer renders them yet");
    }
    if (spec.loop_guards?.spawn_budget !== undefined) {
      v2Advisory("loop_guards.spawn_budget", "workflow.loop_guards.spawn_budget",
        "it guards a SPAWN mechanism and no spawn/fan-out seam exists in the single-frontier model; enforcement is a NAMED acceptance item of the WF-2/WF-6 parallel-frontier fan-out work (arch ruling 2026-07-06)");
    }
    // OPR.0.4.6.WF2 FR-4: the `gates[]` and `next_hop.mode: prefer`
    // advisories are GONE — both forms are now REMOVED at parse with
    // specific what/why/fix migration errors (spec_gates_removed /
    // spec_prefer_mode_removed), so a spec carrying them can never
    // reach this validator. The inert third state died at the parser.
    for (const [roleName, role] of Object.entries(spec.roles ?? {})) {
      if (role?.skill_refs && role.skill_refs.length > 0) {
        v2Advisory("skill_refs", `workflow.roles.${roleName}.skill_refs`,
          "documentation-only; owner resolution uses preferred_targets");
        break; // one advisory for the whole spec, not per role
      }
    }

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
