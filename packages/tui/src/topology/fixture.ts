// SPIKE fixture — mirrors REAL `/api/rigs/:id/graph` output (same field set
// and id discipline as spike/real-graph-v-openrig-build.json) while exercising
// the FULL spike vocabulary the live rig happens not to show today:
//   · all 3 edge kinds (delegates_to / collaborates_with / escalates_to)
//   · all 4 status glyphs, including a GENUINE ○ honest-unknown (no session,
//     no activity — the projection has no value) and a ◐ with ctx% overlay
// Gated like demo-data: imported ONLY by the spike shell/tests, never by the
// live render path (the --demo gate rule applies unchanged).
import type { RigGraph } from "./graph-types.js";

export const FIXTURE_RIG_NAME = "openrig-build";

export function spikeFixtureGraph(): RigGraph {
  return {
    nodes: [
      { id: "pod-01SPIKEORCH000000000000000", type: "podGroup", data: { logicalId: "orch", podNamespace: "orch", podLabel: "orch", runtime: null, model: null, status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null } },
      { id: "pod-01SPIKEDEV0000000000000000", type: "podGroup", data: { logicalId: "dev", podNamespace: "dev", podLabel: "dev", runtime: null, model: null, status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null } },
      { id: "pod-01SPIKEREVIEW00000000000000", type: "podGroup", data: { logicalId: "review", podNamespace: "review", podLabel: "review", runtime: null, model: null, status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null } },
      {
        id: "01SPIKENODELEAD00000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEORCH000000000000000",
        data: {
          logicalId: "orch.lead", podNamespace: "orch", runtime: "claude-code", model: "claude",
          status: "running", nodeKind: "agent", startupStatus: "ready", contextUsedPercentage: 18,
          agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: "orch-lead@openrig-build",
        },
      },
      {
        id: "01SPIKENODEDRIVER000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEDEV0000000000000000",
        data: {
          logicalId: "dev.driver", podNamespace: "dev", runtime: "claude-code", model: "claude",
          status: "running", nodeKind: "agent", startupStatus: "ready", contextUsedPercentage: 24,
          agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: "dev-driver@openrig-build",
        },
      },
      {
        id: "01SPIKENODEQA0000000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEDEV0000000000000000",
        data: {
          // ◐ partial/% — the EXISTING amber-attention state with a served ctx%
          logicalId: "dev.qa", podNamespace: "dev", runtime: "codex", model: "gpt",
          status: "running", nodeKind: "agent", startupStatus: "attention_required", contextUsedPercentage: 63,
          agentActivity: { state: "needs_input" }, terminalActive: false, canonicalSessionName: "dev-qa@openrig-build",
        },
      },
      {
        id: "01SPIKENODER1000000000000Z",
        type: "rigNode",
        parentId: "pod-01SPIKEREVIEW00000000000000",
        data: {
          // ○ honest-unknown — NO session, NO activity, NO ctx: the projection
          // has no value, so the render must say so (never fabricate ●)
          logicalId: "review.r1", podNamespace: "review", runtime: "codex", model: null,
          status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null,
          agentActivity: null, terminalActive: null, canonicalSessionName: null,
        },
      },
      {
        id: "01SPIKENODEVALID0000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEREVIEW00000000000000",
        data: {
          // ✕ failed
          logicalId: "review.validator", podNamespace: "review", runtime: "codex", model: "gpt",
          status: "running", nodeKind: "agent", startupStatus: "failed", contextUsedPercentage: null,
          agentActivity: null, terminalActive: false, canonicalSessionName: "review-validator@openrig-build",
        },
      },
    ],
    edges: [
      { id: "01SPIKEEDGE1", source: "01SPIKENODELEAD00000000000", target: "01SPIKENODEDRIVER000000000", label: "delegates_to" },
      { id: "01SPIKEEDGE2", source: "01SPIKENODELEAD00000000000", target: "01SPIKENODER1000000000000Z", label: "delegates_to" },
      { id: "01SPIKEEDGE3", source: "01SPIKENODEDRIVER000000000", target: "01SPIKENODEQA0000000000000", label: "collaborates_with" },
      { id: "01SPIKEEDGE4", source: "01SPIKENODER1000000000000Z", target: "01SPIKENODELEAD00000000000", label: "escalates_to" },
    ],
  };
}
