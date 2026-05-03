// PL-004 Phase C: edge-artifact-required policy (TypeScript port of
// POC `lib/policies/edge-artifact-required.mjs`, 70 lines).
//
// Scans both source pools and target pools. For each source artifact,
// computes its source-key (frontmatter[key_field] OR basename-sans-md).
// If targets array contains no artifact with matching source-key,
// the source is "missing a downstream edge artifact." Emits a send
// only when one or more sources are missing edges; otherwise skip with
// reason "no_missing_edge_artifacts".

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  type ArtifactPoolSpec,
  type ScannedArtifact,
  formatArtifactList,
  scanArtifactPools,
  sourceKeyFor,
} from "./artifact-pool-helpers.js";

interface EdgeArtifactRequiredContext {
  target?: { session?: string };
  source_pools?: ArtifactPoolSpec | ArtifactPoolSpec[];
  target_pools?: ArtifactPoolSpec | ArtifactPoolSpec[];
  source_key_field?: string;
  target_key_field?: string;
  label?: string;
  max_items?: number;
  message_template?: string;
}

function targetContainsKey(
  targets: ScannedArtifact[],
  key: string,
  targetKeyField: string,
): boolean {
  for (const t of targets) {
    if (sourceKeyFor(t, targetKeyField) === key) return true;
  }
  return false;
}

export const edgeArtifactRequiredPolicy: Policy = {
  name: "edge-artifact-required",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    const context = job.context as EdgeArtifactRequiredContext;
    const targetSession = context.target?.session;
    if (!targetSession) {
      throw Object.assign(new Error("edge-artifact-required requires context.target.session"), {
        code: "policy_spec_invalid",
        policy: "edge-artifact-required",
        field: "context.target.session",
      });
    }
    const sourceKeyField = context.source_key_field ?? "entry";
    const targetKeyField = context.target_key_field ?? "entry";
    const sources = await scanArtifactPools(context.source_pools);
    // POC override: target scan ignores include_statuses (so we can detect
    // any matching downstream artifact regardless of its lifecycle state).
    const targetPoolsRaw = context.target_pools;
    const targetPoolsList = targetPoolsRaw
      ? Array.isArray(targetPoolsRaw)
        ? targetPoolsRaw
        : [targetPoolsRaw]
      : [];
    const targets = await scanArtifactPools(
      targetPoolsList.map((p) => ({ ...p, include_statuses: [] })),
    );
    const missing: ScannedArtifact[] = [];
    for (const s of sources) {
      const key = sourceKeyFor(s, sourceKeyField);
      if (!targetContainsKey(targets, key, targetKeyField)) missing.push(s);
    }
    if (missing.length === 0) {
      return { action: "skip", reason: "no_missing_edge_artifacts" };
    }
    const label = context.label ?? "edge";
    const maxItems = context.max_items ?? 5;
    const list = formatArtifactList(missing, maxItems);
    const message =
      context.message_template ??
      `Artifact edge repair needed: ${label} has ${missing.length} upstream artifact(s) with no matching downstream artifact.\n\n${list}`;
    return {
      action: "send",
      target: targetSession,
      message,
      notes: { missing_count: missing.length, label },
    };
  },
};
