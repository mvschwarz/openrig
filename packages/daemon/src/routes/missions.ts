// V0.3.1 slice 12 walk-item 1 — mission scope data layer.
// V0.3.1 slice 13 walk-item 7 — extended with workflow_spec frontmatter
// + projected topology spec graph.
//
// GET /api/missions/:missionId — returns aggregated mission metadata
// (missionPath + slices + optional workflow_spec declaration + optional
// projected topology). Powers the Mission Overview / Progress / Topology
// tabs in the Project surface; pairs with useScopeMarkdown for README /
// PROGRESS content via the existing /api/files/read route.
//
// Returns:
//   200 {
//     missionId, missionPath, slices,
//     workflow_spec: { name, version } | null,
//     topology: { specGraph: SpecGraphPayload | null } | null
//   }
//   404 { error: "mission_not_found" } when no slices match
//   503 { error: "slices_indexer_unavailable" } when indexer not wired
//   503 { error: "slices_root_not_configured" } when indexer not ready
//
// workflow_spec is parsed lazily from <missionPath>/README.md frontmatter
// using the same parser the slice-indexer uses. topology.specGraph is
// projected via projectSpecGraph(spec, null) when the spec is in the
// WorkflowSpecCache; { specGraph: null } when declared but not cached;
// null when nothing is declared.

import { Hono, type Context } from "hono";
import { servedMissionStatus, writeMissionStatus, type ManifestEditOutcome } from "../domain/scope/manifest-editor.js";
import { createProofPolicyRead, readMissionReadiness, readSliceReadiness } from "../domain/proof/judgments.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SliceIndexer,
  SliceListEntry,
  WorkflowSpecRef,
} from "../domain/slices/slice-indexer.js";
import { parseWorkflowSpecRef } from "../domain/slices/slice-indexer.js";
import type { WorkflowSpecCache } from "../domain/workflow-spec-cache.js";
import { projectSpecGraph } from "../domain/workflow/slice-workflow-projection.js";
import { resolveNodeFile } from "../domain/scope/node-file.js";
import { readParentScope } from "../domain/scope/mission-parent.js";

export function missionsRoutes(): Hono {
  const app = new Hono();

  app.get("/:missionId", (c) => {
    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!indexer) {
      return c.json(
        {
          error: "slices_indexer_unavailable",
          hint: "Mission data layer requires the SliceIndexer to be wired into AppDeps.",
        },
        503,
      );
    }
    if (!indexer.isReady()) {
      return c.json(
        {
          error: "slices_root_not_configured",
          hint: "Run rig config init-workspace, or set workspace.slices_root to workspace/missions. Supported shape: missions/<mission>/slices/<slice>.",
        },
        503,
      );
    }
    const missionId = c.req.param("missionId");
    const allSlices = indexer.list();
    const slices = allSlices.filter((s) => s.missionId === missionId);
    const fallbackPath = path.resolve(indexer.slicesRoot, missionId);
    const parentWarnings: string[] = [];
    let legacyNodes: ReturnType<typeof readParentScope> | undefined;
    const legacyLinked = slices.length === 0 && path.dirname(fallbackPath) === path.resolve(indexer.slicesRoot) && !fs.existsSync(path.join(fallbackPath, "mission.yaml")) && !fs.existsSync(path.join(fallbackPath, "slices")) && (legacyNodes = readParentScope(indexer.slicesRoot, { onInvalid: (message) => parentWarnings.push(message) })).some((node) => node.kind === "mission" && node.path === fallbackPath && node.parent !== null);
    if (slices.length === 0 && (path.dirname(fallbackPath) !== path.resolve(indexer.slicesRoot) || !resolveNodeFile(fallbackPath) || (!fs.existsSync(path.join(fallbackPath, "mission.yaml")) && !fs.existsSync(path.join(fallbackPath, "slices")) && !legacyLinked))) {
      return c.json({ error: "mission_not_found", missionId }, 404);
    }
    const missionPath = slices.length ? computeMissionPath(slices[0]!) : fallbackPath;
    const workflowSpec = readMissionWorkflowSpec(missionPath);
    const topology = computeMissionTopology(
      workflowSpec,
      c.get("workflowSpecCache" as never) as WorkflowSpecCache | undefined,
    );
    // One request-local policy reader: shared proofPolicy manifests are read
    // once for this response and never carried to the next request.
    const readPolicy = createProofPolicyRead();
    const readiness = readMissionReadiness(missionPath, readPolicy);
    const status = readiness.historicalStatus ?? readMissionStatus(missionPath);
    const parentNodes = legacyNodes ?? readParentScope(path.resolve(missionPath, ".."), { onInvalid: (message) => parentWarnings.push(message) });
    const missionNode = parentNodes.find((node) => node.kind === "mission" && node.path === missionPath);
    const parentMatches = missionNode?.parent ? parentNodes.filter((node) => node.id === missionNode.parent) : [];
    return c.json({
      missionId,
      missionPath,
      readiness,
      slices: slices.map(s => ({ ...s, readiness: readSliceReadiness(s.slicePath, undefined, readPolicy) })),
      workflow_spec: workflowSpec,
      topology,
      status,
      parentId: missionNode?.parent ?? null,
      parent: parentMatches.length === 1 ? parentMatches[0] : null,
      parentWarnings,
      childMissions: missionNode?.id && parentNodes.filter((node) => node.id === missionNode.id).length === 1 ? parentNodes.filter((node) => node.kind === "mission" && node.parent === missionNode.id) : [],
    });
  });

  // Slice 18 §3.5 — Mark mission complete (Getting Started complete-and-hide).
  // Writes the authored mission status (manifest, or legacy node frontmatter); the UI
  // storytelling preview gates on this so completed missions disappear from
  // the band. The daemon is the audit-trail surface; the UI maintains
  // an optimistic local mirror via localStorage so the hide is instant.
  app.post("/:missionId/complete", async (c) => setStatus(c, "complete", "mission_complete_write_failed"));

  // #3616 — any authored status word, written by the same writer as complete. `rig scope mission set --status` sends
  // the mission folder it resolved (`missionPath`), so a mission found under a named workspace is the one written.
  app.post("/:missionId/status", async (c) => {
    const body = await c.req.json().catch(() => null) as { status?: unknown } | null;
    const status = typeof body?.status === "string" ? body.status.trim() : "";
    if (!status || /[\r\n]/.test(status)) {
      return c.json({ error: "status_required", message: "status must be one non-empty line" }, 400);
    }
    return setStatus(c, status, "mission_status_write_failed");
  });

  return app;
}

async function setStatus(c: Context, status: string, failure: string): Promise<Response> {
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  if (!indexer) {
    return c.json({ error: "slices_indexer_unavailable" }, 503);
  }
  const missionId = c.req.param("missionId")!;
  // `/complete` takes no body, and a JSON `null` is no body either.
  const named = (await c.req.json().catch(() => null) as { missionPath?: unknown } | null)?.missionPath;
  // Only the folder is needed: a cold list() would rebuild queue membership for
  // every slice before this write could run.
  // A named folder must be that mission's: absolute, a directory, and named for it.
  const missionPath = typeof named === "string"
    ? (path.isAbsolute(named) && path.basename(named) === missionId && fs.statSync(named, { throwIfNoEntry: false })?.isDirectory() ? named : null)
    : indexer.missionPath(missionId);
  if (!missionPath) {
    return c.json({ error: "mission_not_found", missionId, ...(typeof named === "string" ? { missionPath: named } : {}) }, 404);
  }
  let outcome: ManifestEditOutcome;
  try {
    outcome = writeMissionStatus(missionPath, status);
  } catch (err) {
    return c.json({ error: failure, missionId, message: (err as Error).message }, 500);
  }
  // VM-005 B1 (narrow C-vii exception): the write succeeded — drop the
  // authored-status sidecar cache so the very next /api/slices read serves
  // the new word (read-after-write coherence). Every daemon
  // mission-status mutation route calls this same method.
  indexer.invalidateMissionStatusCache();
  return c.json({ missionId, missionPath, status, outcome, served: servedMissionStatus(missionPath) });
}

/** Derive the mission folder's absolute path from any slice's
 *  `slicePath`. Slices live at
 *  `<missionsRoot>/<missionId>/slices/<sliceName>` per the workspace
 *  contract, so going up two levels yields the mission folder. */
function computeMissionPath(slice: SliceListEntry): string {
  return path.resolve(slice.slicePath, "..", "..");
}

/** Slice 18 §3.5 — parse the `status` field from the mission README's
 *  frontmatter. Returns the string when present (no enum validation —
 *  v0 callers care primarily about the "complete" value but other
 *  workflow states may appear), or null when the README is missing /
 *  the field is absent. Powers the durable storytelling-filter for
 *  Getting Started complete-and-hide. */
export function readMissionStatus(missionPath: string): string | null {
  const readmePath = resolveNodeFile(missionPath);
  if (!readmePath) return null;
  const raw = fs.readFileSync(readmePath, "utf-8");
  const fm = parseSimpleFrontmatter(raw);
  const value = fm["status"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** V0.3.1 slice 13 walk-item 7 — parse `workflow_spec` from the mission
 *  README's frontmatter. Returns null when the README is missing or the
 *  field is absent / malformed. Uses the same parseWorkflowSpecRef
 *  helper the slice-indexer uses so both surfaces stay in lockstep. */
function readMissionWorkflowSpec(missionPath: string): WorkflowSpecRef | null {
  const readmePath = resolveNodeFile(missionPath);
  if (!readmePath) return null;
  const raw = fs.readFileSync(readmePath, "utf-8");
  const fm = parseSimpleFrontmatter(raw);
  return parseWorkflowSpecRef(fm["workflow_spec"]);
}

/** Minimal frontmatter parser. The slice-indexer's parseFrontmatter is
 *  private; duplicating the v0 shape here is cheaper than exposing
 *  internal API and keeps the missions route's surface minimal. */
function parseSimpleFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** V0.3.1 slice 13 walk-item 7 — project the spec graph when both the
 *  declaration AND the cached spec are present. Returns the topology
 *  envelope with `specGraph: null` when declared but not yet cached;
 *  returns `null` for the whole envelope when nothing is declared. */
function computeMissionTopology(
  workflowSpec: WorkflowSpecRef | null,
  specCache: WorkflowSpecCache | undefined,
): { specGraph: ReturnType<typeof projectSpecGraph> | null } | null {
  if (!workflowSpec) return null;
  if (!specCache) return { specGraph: null };
  const row = specCache.getByNameVersion(workflowSpec.name, workflowSpec.version);
  if (!row) return { specGraph: null };
  // WorkflowSpecRow.spec is the WorkflowSpec object the projector expects.
  return { specGraph: projectSpecGraph(row.spec, null) };
}
