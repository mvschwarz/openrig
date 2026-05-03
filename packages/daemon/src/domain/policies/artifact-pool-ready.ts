// PL-004 Phase C: artifact-pool-ready policy (TypeScript port of
// POC `lib/policies/artifact-pool-ready.mjs`, 29 lines).
//
// Scans context.pools, returns:
//   - skip { reason: "no_actionable_artifacts" } if pool empty
//   - send { message: "Artifact pool ready: <label> has N actionable
//     artifact(s)..." + bullet list capped at max_items (default 5) }

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  type ArtifactPoolSpec,
  formatArtifactList,
  scanArtifactPools,
} from "./artifact-pool-helpers.js";

interface ArtifactPoolReadyContext {
  target?: { session?: string };
  pools?: ArtifactPoolSpec | ArtifactPoolSpec[];
  label?: string;
  max_items?: number;
  message_template?: string;
}

export const artifactPoolReadyPolicy: Policy = {
  name: "artifact-pool-ready",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    const context = job.context as ArtifactPoolReadyContext;
    const targetSession = context.target?.session;
    if (!targetSession) {
      throw Object.assign(new Error("artifact-pool-ready requires context.target.session"), {
        code: "policy_spec_invalid",
        policy: "artifact-pool-ready",
        field: "context.target.session",
      });
    }
    const artifacts = await scanArtifactPools(context.pools);
    if (artifacts.length === 0) {
      return { action: "skip", reason: "no_actionable_artifacts" };
    }
    const label = context.label ?? "artifact pool";
    const maxItems = context.max_items ?? 5;
    const list = formatArtifactList(artifacts, maxItems);
    const message =
      context.message_template ??
      `Artifact pool ready: ${label} has ${artifacts.length} actionable artifact(s).\n\n${list}`;
    return {
      action: "send",
      target: targetSession,
      message,
      notes: { artifact_count: artifacts.length, label },
    };
  },
};
