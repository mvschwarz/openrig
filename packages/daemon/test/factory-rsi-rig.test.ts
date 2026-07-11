// OPR.0.4.6.FAC2 C2 — the factory-rsi single-rig RSI factory starter (artifact B).
//
// Proves the rig spec + its two new agents validate, and — the load-bearing
// cross-check — that every `factory-rsi` workflow role pins 1:1 to a seat
// this rig declares (no orphan role, no unused seat). VM-only: authored here,
// the deep preflight/scan legs run at the coherent lease.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SPECS_ROOT = resolve(import.meta.dirname, "../specs");
const RIG_SPEC = join(SPECS_ROOT, "rigs/launch/factory-rsi/rig.yaml");
const WORKFLOW_SPEC = resolve(
  import.meta.dirname,
  "../src/builtins/workflow-specs/factory-rsi.yaml",
);
const NEW_AGENTS = [
  "agents/factory-rsi/dogfood/agent.yaml",
  "agents/factory-rsi/release-manager/agent.yaml",
];

interface RigMember {
  id: string;
  agent_ref: string;
  runtime: string;
  profile: string;
  cwd: string;
  model?: string;
}
interface RigPod {
  id: string;
  members: RigMember[];
}

function loadRig(): { name: string; pods: RigPod[] } {
  return parseYaml(readFileSync(RIG_SPEC, "utf-8")) as { name: string; pods: RigPod[] };
}

describe("OPR.0.4.6.FAC2 factory-rsi rig starter", () => {
  it("validates against the rig-spec schema", () => {
    const raw = parseYaml(readFileSync(RIG_SPEC, "utf-8"));
    const result = RigSpecSchema.validate(raw);
    expect(result.errors).toEqual([]);
  });

  it("declares exactly the seven RSI seats, one member per pod", () => {
    const rig = loadRig();
    expect(rig.name).toBe("factory-rsi");
    const seats = rig.pods.map((p) => {
      expect(p.members).toHaveLength(1);
      return `${p.id}-${p.members[0]!.id}`;
    });
    expect(seats.sort()).toEqual(
      [
        "build-implementer",
        "check-qa",
        "dogfood-tester",
        "orch-lead",
        "plan-planner",
        "release-manager",
        "review-reviewer",
      ].sort(),
    );
  });

  it("per-seat runtime follows the 0.4.6 FAC2 design (builder on claude-code; qa/review/dogfood on the alternate runtime; every seat inherits the runtime default model)", () => {
    // DRIFT VERDICT: STALE ASSERTION (intentional 0.4.6 change), not a
    // regression. The prior assertion pinned "Sonnet Claude seats; Codex
    // builder+checker" with model: sonnet. Release 0.4.6 (commit 8250d702)
    // shipped `specs/rigs/launch/factory-rsi/rig.yaml` + CULTURE.md with a
    // deliberately different design, documented verbatim in the rig.yaml
    // summary: "Seats inherit their runtime's default model; qa, review, and
    // dogfood run on the alternate runtime for cross-runtime diversity against
    // the builder." (also CULTURE.md:34 `review-reviewer | codex` and :41).
    // The builder therefore runs claude-code, qa/review/dogfood run codex, and
    // NO seat carries a model pin. This test now tracks the shipped spec.
    const bySeat = new Map<string, RigMember>();
    for (const pod of loadRig().pods) bySeat.set(`${pod.id}-${pod.members[0]!.id}`, pod.members[0]!);

    // The builder + planner/release/orch seats run claude-code.
    for (const seat of ["plan-planner", "build-implementer", "release-manager", "orch-lead"]) {
      expect(bySeat.get(seat)!.runtime).toBe("claude-code");
    }
    // qa, review, and dogfood run on the alternate runtime (codex) for
    // cross-runtime diversity against the builder.
    for (const seat of ["check-qa", "review-reviewer", "dogfood-tester"]) {
      expect(bySeat.get(seat)!.runtime).toBe("codex");
    }
    // Every seat inherits its runtime's default model — no per-seat model pin.
    for (const seat of bySeat.keys()) {
      expect(bySeat.get(seat)!.model).toBeUndefined();
    }
  });

  it("the two new factory-rsi agents validate", () => {
    for (const file of NEW_AGENTS) {
      const raw = parseAgentSpec(readFileSync(join(SPECS_ROOT, file), "utf-8"));
      const result = validateAgentSpec(raw);
      expect(result.valid).toBe(true);
    }
  });

  it("every factory-rsi workflow role pins 1:1 to a factory-rsi seat (no orphan role, no unused seat)", () => {
    const rig = loadRig();
    const seatRefs = new Set(rig.pods.map((p) => `${p.id}-${p.members[0]!.id}@factory-rsi`));

    const spec = parseWorkflowSpec(readFileSync(WORKFLOW_SPEC, "utf-8"), WORKFLOW_SPEC);
    const roleTargets = Object.values(spec.roles).map((r) => r.preferred_targets?.[0]);

    // Every role resolves to a declared seat.
    for (const target of roleTargets) {
      expect(target).toBeDefined();
      expect(seatRefs.has(target!)).toBe(true);
    }
    // The mapping is a bijection: 7 roles ↔ 7 seats, each seat used exactly once.
    expect(new Set(roleTargets).size).toBe(seatRefs.size);
    expect(roleTargets.length).toBe(seatRefs.size);
  });
});
