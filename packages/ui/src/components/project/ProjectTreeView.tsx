// V1 attempt-3 Phase 3 — Project tree per project-tree.md L13–L46 + SC-24.
//
// V1 attempt-3 Phase 5 P5-5 + P5-6: filesystem-based mission discovery via
// useMissionDiscovery (walks workspace.root/missions/ over /api/files/list)
// and live MissionStatusBadge derived from PROGRESS.md frontmatter via
// useMissionProgressStatus (over /api/files/read). When the allowlist
// doesn't expose workspace.root, the tree falls back to the legacy
// railItem-grouped slice listing.

import { useState, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSlices, type SliceListEntry } from "../../hooks/useSlices.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import {
  useMissionDiscovery,
  type DiscoveredMission,
} from "../../hooks/useMissionDiscovery.js";
import { useMissionProgressStatus } from "../../hooks/useMissionProgressStatus.js";
import { MissionStatusBadge, type MissionStatus } from "../MissionStatusBadge.js";

type SliceRow = { name: string; displayName: string; status: string };

type GroupedMission = {
  id: string;
  label: string;
  status: MissionStatus;
  slices: SliceRow[];
  // P5-5: filesystem-discovered missions carry root + path so the live
  // PROGRESS.md status fetcher knows where to read.
  fsRoot?: string;
  fsPath?: string;
};

function deriveStatusFromSlices(slices: Array<{ status: string }>): MissionStatus {
  if (slices.length === 0) return "unknown";
  if (slices.some((s) => s.status === "blocked")) return "blocked";
  if (slices.some((s) => s.status === "active")) return "active";
  if (slices.every((s) => s.status === "done")) return "shipped";
  return "active";
}

/** Live mission-status badge: when the mission was discovered on disk,
 *  fetches PROGRESS.md frontmatter; otherwise falls back to the heuristic
 *  derived from constituent slices' statuses. */
function LiveMissionStatusBadge({ mission }: { mission: GroupedMission }) {
  const live = useMissionProgressStatus(mission.fsRoot ?? null, mission.fsPath ?? null);
  // When filesystem-discovered AND the read succeeded, prefer the live status;
  // otherwise the slice-derived fallback.
  const status =
    mission.fsRoot && !live.unavailable && !live.isLoading ? live.status : mission.status;
  return (
    <MissionStatusBadge
      status={status}
      testId={`project-mission-${mission.id}-badge`}
    />
  );
}

export function ProjectTreeView() {
  const { data: slicesResp } = useSlices("all");
  const workspace = useWorkspaceName();
  const discovery = useMissionDiscovery();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    workspace: true,
  });
  const toggle = (k: string) =>
    setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const sliceList: SliceListEntry[] =
    slicesResp && "slices" in slicesResp ? slicesResp.slices : [];

  // Group slices by railItem (the "mission" label they self-report).
  const slicesByRailItem = useMemo(() => {
    const buckets = new Map<string, SliceRow[]>();
    for (const s of sliceList) {
      const key = s.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({
        name: s.name,
        displayName: s.displayName,
        status: s.status,
      });
    }
    return buckets;
  }, [sliceList]);

  // P5-5: when filesystem mission discovery is available, surface the
  // disk-discovered missions and attach their slices via railItem match.
  // Otherwise fall back to railItem grouping alone.
  const missions = useMemo<GroupedMission[]>(() => {
    if (!discovery.unavailable && discovery.missions.length > 0) {
      const orphanSlices: SliceRow[] = [];
      const consumedKeys = new Set<string>();
      const discovered: GroupedMission[] = discovery.missions.map((m: DiscoveredMission) => {
        const matchedSlices = slicesByRailItem.get(m.name) ?? [];
        if (matchedSlices.length > 0) consumedKeys.add(m.name);
        return {
          id: m.name,
          label: m.name,
          status: deriveStatusFromSlices(matchedSlices), // baseline; live overrides via badge
          slices: matchedSlices,
          fsRoot: m.root,
          fsPath: m.path,
        };
      });
      // Any slice whose railItem doesn't match a disk mission goes into
      // "unsorted" so it's still reachable.
      for (const [railItem, slices] of slicesByRailItem.entries()) {
        if (!consumedKeys.has(railItem)) orphanSlices.push(...slices);
      }
      if (orphanSlices.length > 0) {
        discovered.push({
          id: "unsorted",
          label: "Unsorted",
          status: deriveStatusFromSlices(orphanSlices),
          slices: orphanSlices,
        });
      }
      return discovered;
    }
    // Fallback: railItem grouping only (Phase 3 behavior).
    return Array.from(slicesByRailItem.entries()).map(([k, slices]) => ({
      id: k,
      label: k === "unsorted" ? "Unsorted" : k,
      status: deriveStatusFromSlices(slices),
      slices,
    }));
  }, [discovery.unavailable, discovery.missions, slicesByRailItem]);

  // A5 bounce-fix: replace hardcoded "openrig-work" with live-wired
  // workspace name from ConfigStore. When unset/unreachable: render an
  // honest empty-state node ("No workspace connected" + Link to /settings).
  if (!workspace.isLoading && workspace.name === null) {
    return (
      <div
        data-testid="project-tree-view"
        className="flex-1 overflow-y-auto py-3 px-3"
      >
        <div
          data-testid="project-no-workspace"
          className="border border-outline-variant bg-surface-low px-3 py-3 font-mono text-[10px]"
        >
          <div className="text-stone-900 uppercase tracking-wide font-bold mb-1">
            No workspace connected
          </div>
          <p className="text-on-surface-variant mb-2">
            Configure a workspace root to browse missions and slices.
          </p>
          <Link
            to="/settings"
            data-testid="project-no-workspace-cta"
            className="inline-flex items-center text-stone-900 hover:underline uppercase"
          >
            Open settings →
          </Link>
        </div>
      </div>
    );
  }

  const workspaceLabel = workspace.name ?? "loading…";

  return (
    <div data-testid="project-tree-view" className="flex-1 overflow-y-auto py-2">
      <ul>
        <li data-testid="project-workspace-node">
          <button
            type="button"
            onClick={() => toggle("workspace")}
            className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
            data-testid="project-workspace-toggle"
          >
            {expanded.workspace ? (
              <ChevronDown className="h-3 w-3 text-on-surface-variant" />
            ) : (
              <ChevronRight className="h-3 w-3 text-on-surface-variant" />
            )}
            <span
              data-testid="project-workspace-label"
              className="font-mono text-[11px] uppercase tracking-wide text-stone-900 flex-1"
            >
              {workspaceLabel}
            </span>
            <Link
              to="/project"
              data-testid="project-workspace-link"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant hover:text-stone-900"
            >
              open
            </Link>
          </button>
          {expanded.workspace ? (
            <ul className="ml-4 border-l border-stone-200">
              {discovery.unavailable && discovery.hint ? (
                <li
                  data-testid="project-discovery-degraded"
                  className="px-2 py-1 font-mono text-[9px] text-on-surface-variant italic"
                  title={discovery.hint}
                >
                  Filesystem mission discovery unavailable; showing railItem grouping.
                </li>
              ) : null}
              {missions.length === 0 ? (
                <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
                  No missions yet.
                </li>
              ) : (
                missions.map((m) => (
                  <li key={m.id} data-testid={`project-mission-${m.id}`}>
                    <button
                      type="button"
                      onClick={() => toggle(`mission-${m.id}`)}
                      className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left"
                      data-testid={`project-mission-toggle-${m.id}`}
                    >
                      {expanded[`mission-${m.id}`] ? (
                        <ChevronDown className="h-3 w-3 text-on-surface-variant" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-on-surface-variant" />
                      )}
                      <span className="font-mono text-[11px] text-stone-900 flex-1 truncate">
                        {m.label}
                      </span>
                      <LiveMissionStatusBadge mission={m} />
                    </button>
                    {expanded[`mission-${m.id}`] ? (
                      <ul className="ml-4 border-l border-stone-200">
                        {m.slices.length === 0 ? (
                          <li className="px-2 py-0.5 font-mono text-[10px] text-on-surface-variant italic">
                            No slices.
                          </li>
                        ) : (
                          m.slices.map((s) => (
                            <li key={s.name}>
                              <Link
                                to="/project/slice/$sliceId"
                                params={{ sliceId: s.name }}
                                data-testid={`project-slice-${s.name}`}
                                className="block px-2 py-0.5 font-mono text-xs text-on-surface hover:text-stone-900 hover:bg-surface-low truncate"
                              >
                                {s.displayName}
                              </Link>
                            </li>
                          ))
                        )}
                      </ul>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </li>
      </ul>
    </div>
  );
}
