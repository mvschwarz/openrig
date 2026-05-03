// PL-004 Phase C R1: artifact-pool-ready policy (TypeScript port of
// POC `lib/policies/artifact-pool-ready.mjs`).
//
// POC contract: target.session is required (top-level `target:`).
// Scans context.pools (array). Empty → skip(no_actionable_artifacts).
// Otherwise sends a formatted message ending with the standard POC
// pool-ready instruction line.

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  type ArtifactPoolSpec,
  formatArtifactList,
  scanArtifactPools,
} from "./artifact-pool-helpers.js";

interface ArtifactPoolReadyContext {
  pools?: ArtifactPoolSpec | ArtifactPoolSpec[];
  label?: string;
  max_items?: number;
}

const POC_POOL_READY_TRAILER =
  "Claim and process the next artifact, or terminally classify it with evidence. " +
  "This is a pool-ready wake, not an approval gate, and it should not require orch to bridge the edge.";

export const artifactPoolReadyPolicy: Policy = {
  name: "artifact-pool-ready",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    if (!job.target?.session) {
      throw Object.assign(new Error("artifact-pool-ready: target.session is required"), {
        code: "policy_spec_invalid",
        policy: "artifact-pool-ready",
        field: "target.session",
      });
    }
    const context = job.context as ArtifactPoolReadyContext;
    const artifacts = await scanArtifactPools(context.pools);
    if (artifacts.length === 0) {
      return { action: "skip", reason: "no_actionable_artifacts" };
    }
    const label = context.label ?? "artifact pool";
    const maxItems = Number(context.max_items ?? 5);
    const list = formatArtifactList(artifacts, maxItems);
    const hiddenCount = Math.max(0, artifacts.length - maxItems);
    const suffix = hiddenCount > 0 ? `\n- ... ${hiddenCount} more` : "";
    const message =
      job.message ??
      `Artifact pool ready: ${label} has ${artifacts.length} actionable artifact(s).\n${list}${suffix}\n\n${POC_POOL_READY_TRAILER}`;
    return {
      action: "send",
      target: job.target,
      message,
      notes: { artifact_count: artifacts.length, label },
    };
  },
};
