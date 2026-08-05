// §6 RECONCILIATION — WARNING EMISSION-ORDER PIN (PM ruling 2026-08-05, fold-wave qitem 79159e6f).
// When ONE preflight emits BOTH proven warning sources — main's managed-activity-hook DELIVERY
// warning (already-folded 0.5.0 content) AND the incoming permission-policy DISCOVERY warning (the
// restacked 4.8 chain) — the emission order is ACTIVITY-HOOK-FIRST, POLICY-APPENDED.
//
// RATIONALE (PM): fold-order = emission-order — main is the restack's fixed base and its
// already-folded activity-hook content is the floor (emitted first); the incoming restacked policy
// content APPENDS after, matching the mechanical grain of the rebase + the gates-first discipline,
// and keeping the 0.5.0 train's existing warning content byte-stable under the restack (the actual
// stability invariant; npm compatibility is NOT implicated — npm carries the POLICY chain cut from
// 0.4.7, activity-hook is unshipped local 0.5.0 work, so neither ordering shipped anywhere before
// this merge; this pin freezes the merged order).
//
// SEMANTIC FENCE: this order is PRESENTATION ONLY. Any consumer that treats the first warning as
// higher-priority is a FINDING, not an ordering input — this pin freezes presentation, never semantics.
import { describe, expect, it } from "vitest";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";

// An agent.yaml that DECLARES + SELECTS the claude_activity_hooks runtime resource — so a claude-code
// member triggers the managed-activity-hook delivery check (which warns when the assets are absent).
const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
  runtime_resources:
    - id: claude-activity-hooks
      path: runtime/claude-activity-hooks.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      skills: []
      runtime_resources: [claude-activity-hooks]`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (p) => p.includes("agents/impl"),
    readFile: (p) => {
      if (p.includes("agents/impl")) return AGENT_YAML;
      throw new Error(`not found: ${p}`);
    },
  };
}

const RIG_YAML = `version: "0.2"
name: order-pin
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        cwd: .
    edges: []
`;

describe("§6 reconciliation — warning emission order (activity-hook-first, policy-appended)", () => {
  it("a preflight emitting BOTH an activity-hook delivery warning AND a policy discovery warning orders activity-hook FIRST, policy APPENDED", async () => {
    const result = await rigPreflight({
      rigSpecYaml: RIG_YAML,
      rigRoot: "/probe/root",
      fsOps: fsOps(),
      // Missing assets → the managed-activity-hook delivery warning fires (nonfatal, READY path).
      claudeActivityAssets: { relayPath: "/missing/relay.cjs", manifestPath: "/missing/claude.json" },
    });
    expect(result.ready).toBe(true); // both warnings are NONFATAL — rig up stays rc0

    const hookIdx = result.warnings.findIndex((w) =>
      w.includes("managed Claude activity hooks cannot be delivered"),
    );
    const policyIdx = result.warnings.findIndex((w) => w.includes("permission_policy"));

    expect(hookIdx).toBeGreaterThanOrEqual(0); // main's activity-hook delivery warning present
    expect(policyIdx).toBeGreaterThanOrEqual(0); // the 4.8 permission-policy discovery warning present
    // THE ORDER PIN: activity-hook-first, policy-appended (PM ruling). A drift in either direction is
    // a deliberate re-rule, never an accident — and per the semantic fence it changes PRESENTATION only.
    expect(hookIdx).toBeLessThan(policyIdx);
  });
});
