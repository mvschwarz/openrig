// OPR.0.4.6.WF5 FR-2: the maturity dial — resolution-chain tests, THE TIER
// SPLIT (human-gate ONLY on human-routed positions), the never-lost
// fallback, never-retroactive semantics, and the dial grammar strictness
// at the spec parse seam.

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EXCEPTION_HUMAN_TIER,
  WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER,
  resolveExceptionRoute,
  type ExceptionRouteInput,
} from "../src/domain/workflow-exception-router.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const base = (over: Partial<ExceptionRouteInput> = {}): ExceptionRouteInput => ({
  exceptionClass: "unmapped_failed",
  spec: {
    roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
    exception_routing: { orchestrator_role: "orch" },
  },
  hostDialDefault: null,
  resolveRoleTarget: (role) => (role === "orch" ? "orch-lead@wf5-proof" : null),
  humanFallbackSeat: "human@host",
  ...over,
});

describe("WF-5 FR-2 dial resolution", () => {
  it("engine default (chain link 4): orchestrator-first, ordinary tier — the inversion at the wire", () => {
    const r = resolveExceptionRoute(base());
    expect(r.position).toBe("orchestrator");
    expect(r.destinationSession).toBe("orch-lead@wf5-proof");
    expect(r.tier).toBe(WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER);
    expect(r.humanRouted).toBe(false);
    expect(r.resolvedVia).toBe("engine-default");
  });

  it("THE TIER-SPLIT NEGATIVE: an orchestrator-routed item NEVER carries human-gate tier", () => {
    const r = resolveExceptionRoute(base());
    expect(r.tier).not.toBe(WORKFLOW_EXCEPTION_HUMAN_TIER);
  });

  it("human-only (workflow-declared, chain link 2): human seat FIRST, human-gate tier", () => {
    const r = resolveExceptionRoute(
      base({
        spec: {
          roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
          exception_routing: { default: "human_only", orchestrator_role: "orch" },
        },
      }),
    );
    expect(r.position).toBe("human_only");
    expect(r.destinationSession).toBe("human@host");
    expect(r.tier).toBe(WORKFLOW_EXCEPTION_HUMAN_TIER);
    expect(r.humanRouted).toBe(true);
    expect(r.resolvedVia).toBe("workflow-declared");
  });

  it("per-class override (chain link 1) beats the workflow default", () => {
    const r = resolveExceptionRoute(
      base({
        exceptionClass: "stuck_overdue",
        spec: {
          roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
          exception_routing: {
            default: "orchestrator",
            orchestrator_role: "orch",
            classes: { stuck_overdue: "human_only" },
          },
        },
      }),
    );
    expect(r.position).toBe("human_only");
    expect(r.resolvedVia).toBe("class-declared");
  });

  it("host dial default (chain link 3) applies when the spec declares nothing", () => {
    const r = resolveExceptionRoute(
      base({ spec: { roles: {} }, hostDialDefault: "human_only" }),
    );
    expect(r.position).toBe("human_only");
    expect(r.resolvedVia).toBe("host-default");
  });

  it("THE NEVER-LOST FALLBACK: orchestrator position with no resolvable role target routes human@host with human-gate tier", () => {
    const r = resolveExceptionRoute(base({ spec: { roles: {} } }));
    expect(r.position).toBe("fallback");
    expect(r.destinationSession).toBe("human@host");
    expect(r.tier).toBe(WORKFLOW_EXCEPTION_HUMAN_TIER);
    expect(r.humanRouted).toBe(true);
  });

  it("class (c) is intrinsically human-only — the dial cannot re-point it", () => {
    const r = resolveExceptionRoute(
      base({
        exceptionClass: "human_gate_trip",
        spec: {
          roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
          exception_routing: { default: "orchestrator", orchestrator_role: "orch" },
        },
      }),
    );
    expect(r.position).toBe("human_only");
    expect(r.resolvedVia).toBe("class-intrinsic");
  });

  it("never-retroactive by construction: resolution is pure — a dial flip changes only the NEXT call", () => {
    const before = resolveExceptionRoute(base({ hostDialDefault: null, spec: { roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } }, exception_routing: { orchestrator_role: "orch" } } }));
    const after = resolveExceptionRoute(base({ hostDialDefault: "human_only", spec: { roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } }, exception_routing: { orchestrator_role: "orch" } } }));
    expect(before.position).toBe("orchestrator");
    expect(after.position).toBe("human_only");
    // determinism: same input, same output, N times
    for (let i = 0; i < 3; i++) {
      expect(resolveExceptionRoute(base())).toEqual(before);
    }
  });
});

const specYaml = (routing: string) => `
workflow:
  id: dial-spec
  version: "1"
  roles:
    worker: { preferred_targets: ["crew-worker@wf5-proof"] }
    orch: { preferred_targets: ["orch-lead@wf5-proof"] }
  steps:
    - id: work
      actor_role: worker
${routing}
`;

describe("WF-5 FR-2 dial grammar strictness (WF-2 rail)", () => {
  it("a valid exception_routing block parses", () => {
    const spec = parseWorkflowSpec(
      specYaml(
        "  exception_routing:\n    default: orchestrator\n    orchestrator_role: orch\n    classes:\n      stuck_overdue: human_only\n",
      ),
      "test://dial-ok.yaml",
    );
    expect(spec.exception_routing?.default).toBe("orchestrator");
    expect(spec.exception_routing?.orchestrator_role).toBe("orch");
    expect(spec.exception_routing?.classes?.stuck_overdue).toBe("human_only");
  });

  it("unknown keys inside exception_routing reject naming the allowed set", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    escalation_ladder: pagerduty\n"),
        "test://dial-unknown.yaml",
      ),
    ).toThrowError(/exception_routing/);
  });

  it("an invalid dial position rejects loud", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    default: founder-first\n"),
        "test://dial-badpos.yaml",
      ),
    ).toThrowError(/orchestrator.*human_only|human_only.*orchestrator/);
  });

  it("classes.human_gate_trip is not configurable — rejects with the intrinsic-human explanation", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    classes:\n      human_gate_trip: orchestrator\n"),
        "test://dial-gatetrip.yaml",
      ),
    ).toThrowError(/intrinsically human-only/);
  });

  it("an unknown class key rejects naming the allowed classes", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    classes:\n      disk_full: human_only\n"),
        "test://dial-badclass.yaml",
      ),
    ).toThrowError(/unmapped_failed, stuck_overdue/);
  });

  it("a spec WITHOUT exception_routing still parses (the zero-regression negative)", () => {
    const spec = parseWorkflowSpec(specYaml(""), "test://dial-absent.yaml");
    expect(spec.exception_routing).toBeUndefined();
  });
});
