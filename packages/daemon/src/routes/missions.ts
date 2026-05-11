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

import { Hono } from "hono";
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
    if (slices.length === 0) {
      return c.json({ error: "mission_not_found", missionId }, 404);
    }
    const missionPath = computeMissionPath(slices[0]!);
    const workflowSpec = readMissionWorkflowSpec(missionPath);
    const topology = computeMissionTopology(
      workflowSpec,
      c.get("workflowSpecCache" as never) as WorkflowSpecCache | undefined,
    );
    return c.json({
      missionId,
      missionPath,
      slices,
      workflow_spec: workflowSpec,
      topology,
    });
  });

  return app;
}

/** Derive the mission folder's absolute path from any slice's
 *  `slicePath`. Slices live at
 *  `<missionsRoot>/<missionId>/slices/<sliceName>` per the workspace
 *  contract, so going up two levels yields the mission folder. */
function computeMissionPath(slice: SliceListEntry): string {
  return path.resolve(slice.slicePath, "..", "..");
}

/** V0.3.1 slice 13 walk-item 7 — parse `workflow_spec` from the mission
 *  README's frontmatter. Returns null when the README is missing or the
 *  field is absent / malformed. Uses the same parseWorkflowSpecRef
 *  helper the slice-indexer uses so both surfaces stay in lockstep. */
function readMissionWorkflowSpec(missionPath: string): WorkflowSpecRef | null {
  const readmePath = path.join(missionPath, "README.md");
  if (!fs.existsSync(readmePath)) return null;
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
