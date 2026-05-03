// PL-004 Phase C R1: edge-artifact-required policy (TypeScript port of
// POC `lib/policies/edge-artifact-required.mjs`).
//
// R1 fix (guard blocker 2): preserves the POC contract.
//   - Spec uses `context.source` (singular) and `context.target`
//     (singular) pool specs. Each may have `path` or `paths`.
//   - Edge-satisfaction: a downstream target artifact satisfies a
//     source iff target.raw CONTAINS the source key. NOT a frontmatter
//     match — body reference suffices.
//   - Target scan overrides include_statuses to [] so any downstream
//     state counts as "exists".
//   - Delivery target is `job.target.session` (top-level).
//   - Label key is `context.edge_label` (matches POC).

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  type ArtifactPoolSpec,
  type ScannedArtifact,
  scanArtifactPools,
  sourceKeyFor,
} from "./artifact-pool-helpers.js";

interface EdgeArtifactRequiredContext {
  source?: ArtifactPoolSpec & { paths?: string[] };
  target?: ArtifactPoolSpec & { paths?: string[] };
  edge_label?: string;
  max_items?: number;
}

function targetContainsKey(targets: ScannedArtifact[], key: string): boolean {
  return targets.some((t) => t.raw.includes(key));
}

function expandPoolSides(
  spec: (ArtifactPoolSpec & { paths?: string[] }) | undefined,
): ArtifactPoolSpec[] {
  if (!spec) return [];
  if (Array.isArray(spec.paths)) {
    return spec.paths.map((p) => ({ ...spec, path: p, paths: undefined }));
  }
  return [spec];
}

export const edgeArtifactRequiredPolicy: Policy = {
  name: "edge-artifact-required",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    if (!job.target?.session) {
      throw Object.assign(new Error("edge-artifact-required: target.session is required"), {
        code: "policy_spec_invalid",
        policy: "edge-artifact-required",
        field: "target.session",
      });
    }
    const context = job.context as EdgeArtifactRequiredContext;
    const source = context.source;
    const target = context.target;
    if (!source?.path && !Array.isArray(source?.paths)) {
      throw Object.assign(
        new Error("edge-artifact-required: context.source.path is required"),
        {
          code: "policy_spec_invalid",
          policy: "edge-artifact-required",
          field: "context.source.path",
        },
      );
    }
    if (!target?.path && !Array.isArray(target?.paths)) {
      throw Object.assign(
        new Error("edge-artifact-required: context.target.path is required"),
        {
          code: "policy_spec_invalid",
          policy: "edge-artifact-required",
          field: "context.target.path",
        },
      );
    }
    const sourcePools = expandPoolSides(source);
    const targetPools = expandPoolSides(target).map((p) => ({
      ...p,
      include_statuses: [] as string[],
    }));
    const keyField = source?.key_field ?? "entry";

    const sources = await scanArtifactPools(sourcePools);
    const targets = await scanArtifactPools(targetPools);
    const missing: ScannedArtifact[] = [];
    for (const s of sources) {
      const key = sourceKeyFor(s, keyField);
      if (!targetContainsKey(targets, key)) missing.push(s);
    }
    if (missing.length === 0) {
      return { action: "skip", reason: "no_missing_edge_artifacts" };
    }
    const label = context.edge_label ?? "artifact edge";
    const maxItems = Number(context.max_items ?? 5);
    const list = missing
      .slice(0, maxItems)
      .map((a) => `- ${sourceKeyFor(a, keyField)} (${a.path})`)
      .join("\n");
    const hiddenCount = Math.max(0, missing.length - maxItems);
    const suffix = hiddenCount > 0 ? `\n- ... ${hiddenCount} more` : "";
    const message =
      job.message ??
      `Artifact edge repair needed: ${label} has ${missing.length} upstream artifact(s) with no matching downstream artifact.\n${list}${suffix}\n\n` +
        "Producer loop owns creating the missing downstream artifact. " +
        "Do not wait for orch to bridge this manually; repair the edge or record the blocker with evidence.";
    return {
      action: "send",
      target: job.target,
      message,
      notes: { missing_count: missing.length, label },
    };
  },
};
