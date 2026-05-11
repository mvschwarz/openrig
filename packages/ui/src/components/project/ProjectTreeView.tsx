// V1 attempt-3 Phase 3 — Project tree per project-tree.md L13–L46 + SC-24.
//
// V1 attempt-3 Phase 5 P5-5 + P5-6: filesystem-based mission discovery via
// useMissionDiscovery (walks workspace.root/missions/ over /api/files/list)
// and live MissionStatusBadge derived from PROGRESS.md frontmatter via
// useMissionProgressStatus (over /api/files/read). When the allowlist
// doesn't expose workspace.root, the tree falls back to the legacy
// railItem/missionId-grouped slice listing.

import { useState, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useSlices, useRefreshSlices, type SliceListEntry } from "../../hooks/useSlices.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import {
  useMissionDiscovery,
  type DiscoveredMission,
} from "../../hooks/useMissionDiscovery.js";
import { useMissionProgressStatus } from "../../hooks/useMissionProgressStatus.js";
import { MissionStatusBadge, type MissionStatus } from "../MissionStatusBadge.js";
import { QueueCountIcon, StatusDot, sliceStatusTone } from "./ProjectMetaPrimitives.js";
import {
  deriveMissionStatusFromSlices,
  isCurrentProjectSlice,
  partitionProjectMissions,
  projectSliceFromListEntry,
  projectSliceMeta,
  type ProjectMissionBucket,
  type ProjectSliceRow,
} from "../../lib/project-mission-state.js";

function ProjectTreeRefreshHeader() {
  const refresh = useRefreshSlices();
  return (
    <div className="flex items-center justify-between px-2 pb-2 border-b border-stone-200">
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-stone-500">
        Project
      </span>
      <button
        type="button"
        data-testid="project-tree-refresh"
        title="Refresh slice + file caches"
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
        className="flex items-center gap-1 px-1 py-0.5 text-on-surface-variant hover:text-stone-900 disabled:opacity-50"
      >
        <RefreshCw
          className={`h-3 w-3 ${refresh.isPending ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        <span className="font-mono text-[9px] uppercase tracking-wide">refresh</span>
      </button>
    </div>
  );
}

type GroupedMission = {
  id: string;
  label: string;
  status: MissionStatus;
  slices: ProjectSliceRow[];
  // P5-5: filesystem-discovered missions carry root + path so the live
  // PROGRESS.md status fetcher knows where to read.
  fsRoot?: string;
  fsPath?: string;
};

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

  // Group slices by missionId first, then railItem for legacy flat roots.
  const slicesByMissionKey = useMemo(() => {
    const buckets = new Map<string, ProjectSliceRow[]>();
    for (const s of sliceList) {
      const key = s.missionId ?? s.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(projectSliceFromListEntry(s));
    }
    return buckets;
  }, [sliceList]);

  // P5-5: when filesystem mission discovery is available, surface the
  // disk-discovered missions and attach their slices via missionId match.
  // Otherwise fall back to missionId/railItem grouping alone.
  const missions = useMemo<GroupedMission[]>(() => {
    if (!discovery.unavailable && discovery.missions.length > 0) {
      const consumedKeys = new Set<string>();
      const discovered: GroupedMission[] = discovery.missions.map((m: DiscoveredMission) => {
        const matchedSlices = slicesByMissionKey.get(m.name) ?? [];
        if (matchedSlices.length > 0) consumedKeys.add(m.name);
        return {
          id: m.name,
          label: m.name,
          status: deriveMissionStatusFromSlices(matchedSlices), // baseline; live overrides via badge
          slices: matchedSlices,
          fsRoot: m.root,
          fsPath: m.path,
        };
      });
      // Any slice whose mission key doesn't match a disk mission goes into
      // its own indexed group so legacy railItem missions do not get
      // collapsed into one mixed current/archive bucket.
      for (const [missionKey, slices] of slicesByMissionKey.entries()) {
        if (consumedKeys.has(missionKey)) continue;
        discovered.push({
          id: missionKey,
          label: missionKey === "unsorted" ? "Unsorted" : missionKey,
          status: deriveMissionStatusFromSlices(slices),
          slices,
        });
      }
      return discovered;
    }
    // Fallback: missionId/railItem grouping only.
    return Array.from(slicesByMissionKey.entries()).map(([k, slices]) => ({
      id: k,
      label: k === "unsorted" ? "Unsorted" : k,
      status: deriveMissionStatusFromSlices(slices),
      slices,
    }));
  }, [discovery.unavailable, discovery.missions, slicesByMissionKey]);

  const missionSections = useMemo(() => {
    return partitionProjectMissions(missions);
  }, [missions]);

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
  const isExpanded = (key: string, defaultValue = false) => expanded[key] ?? defaultValue;

  const renderMission = (m: GroupedMission, bucket: ProjectMissionBucket) => {
    const defaultExpanded = bucket === "current";
    const missionExpanded = isExpanded(`mission-${m.id}`, defaultExpanded);
    return (
      <li
        key={m.id}
        data-testid={`project-mission-${m.id}`}
        data-mission-bucket={bucket}
      >
        <div className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left">
          <button
            type="button"
            aria-label={`${missionExpanded ? "Collapse" : "Expand"} ${m.label}`}
            onClick={() =>
              setExpanded((p) => ({
                ...p,
                [`mission-${m.id}`]: !missionExpanded,
              }))
            }
            className="flex h-4 w-4 items-center justify-center"
            data-testid={`project-mission-toggle-${m.id}`}
          >
            {missionExpanded ? (
              <ChevronDown className="h-3 w-3 text-on-surface-variant" />
            ) : (
              <ChevronRight className="h-3 w-3 text-on-surface-variant" />
            )}
          </button>
          <Link
            to="/project/mission/$missionId"
            params={{ missionId: m.id }}
            data-testid={`project-mission-link-${m.id}`}
            className="font-mono text-[11px] text-stone-900 flex-1 truncate hover:underline"
          >
            {m.label}
          </Link>
          <LiveMissionStatusBadge mission={m} />
        </div>
        {missionExpanded ? (
          <ul className="ml-4 border-l border-stone-200">
            {m.slices.length === 0 ? (
              <li className="px-2 py-0.5 font-mono text-[10px] text-on-surface-variant italic">
                No slices.
              </li>
            ) : (
              m.slices.map((s) => {
                const sliceBucket = isCurrentProjectSlice(s) ? "current" : "archive";
                const meta = projectSliceMeta(s);
                return (
                  <li key={s.name} data-slice-bucket={sliceBucket}>
                    <Link
                      to="/project/slice/$sliceId"
                      params={{ sliceId: s.name }}
                      data-testid={`project-slice-${s.name}`}
                      title={`${s.displayName} — ${meta}`}
                      aria-label={`${s.displayName} (${meta})`}
                      className="flex items-start gap-2 px-2 py-1 font-mono text-xs text-on-surface hover:text-stone-900 hover:bg-surface-low"
                    >
                      <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{s.displayName}</span>
                      <span
                        data-testid={`project-slice-${s.name}-meta`}
                        className="flex shrink-0 items-center gap-1.5"
                      >
                        <QueueCountIcon count={s.qitemCount} testId={`project-slice-${s.name}-qitems`} />
                        <StatusDot
                          tone={sliceStatusTone(s.status)}
                          label={s.status}
                          testId={`project-slice-${s.name}-status`}
                        />
                      </span>
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div data-testid="project-tree-view" className="flex-1 overflow-y-auto py-2">
      {/*
        V0.3.1 slice 17 founder-walk-workspace-state-correctness — walk item 8 (Explorer auto-show). Manual refresh button drops the
        daemon-side indexer cache and react-query slice/file caches so
        newly-created slice / mission folders appear without restarting
        the daemon. Window-focus refetch in useSlices / useFilesList
        handles the common "switched away to mkdir + came back" case;
        this button is the explicit fallback when window-focus doesn't
        fire (e.g., a fast operator who never blurs the tab).
      */}
      <ProjectTreeRefreshHeader />
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
          {isExpanded("workspace") ? (
            <ul className="ml-4 border-l border-stone-200">
              {discovery.unavailable && discovery.hint ? (
                <li
                  data-testid="project-discovery-degraded"
                  className="px-2 py-1 font-mono text-[9px] text-on-surface-variant italic"
                  title={discovery.hint}
                >
                  Workspace missions folder unavailable; showing indexed slice grouping. Expected workspace/missions/&lt;mission&gt;/slices/&lt;slice&gt;.
                </li>
              ) : null}
              {missions.length === 0 ? (
                <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
                  No missions yet.
                </li>
              ) : (
                <>
                  <li
                    data-testid="project-mission-section-current"
                    className="px-2 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-500"
                  >
                    Current Work · {missionSections.current.length}
                  </li>
                  {missionSections.current.length > 0 ? (
                    missionSections.current.map((m) => renderMission(m, "current"))
                  ) : (
                    <li
                      data-testid="project-mission-section-current-empty"
                      className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic"
                    >
                      No current work.
                    </li>
                  )}
                  <li
                    data-testid="project-mission-section-archive"
                    className="px-2 pt-3 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-500"
                  >
                    Archive · {missionSections.archive.length}
                  </li>
                  {missionSections.archive.length > 0 ? (
                    missionSections.archive.map((m) => renderMission(m, "archive"))
                  ) : (
                    <li
                      data-testid="project-mission-section-archive-empty"
                      className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic"
                    >
                      No archived work.
                    </li>
                  )}
                </>
              )}
            </ul>
          ) : null}
        </li>
      </ul>
    </div>
  );
}
