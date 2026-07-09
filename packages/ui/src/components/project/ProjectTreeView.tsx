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
import { ChevronDown, ChevronRight, Globe, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useSlices, useRefreshSlices, type SliceListEntry } from "../../hooks/useSlices.js";
import { useHosts, useSelectHost, useLocalFilesAllowed } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
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

function ProjectTreeRefreshHeader({ remoteReadonly }: { remoteReadonly: boolean }) {
  const refresh = useRefreshSlices();
  return (
    <div className="flex items-center justify-between px-2 pb-2 border-b border-outline-variant">
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
        Project
      </span>
      {/* OPR.0.4.6.MH2 rev1-r2 re-verdict B1 (same-class, enumerated): the
          refresh POSTs the LOCAL slice/file rescan — a local mutation
          affordance never renders on the remote-labeled tree. */}
      {remoteReadonly ? null : (
        <button
          type="button"
          data-testid="project-tree-refresh"
          title="Refresh slice + file caches"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="flex items-center gap-1 px-1 py-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3 w-3 ${refresh.isPending ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span className="font-mono text-[9px] uppercase tracking-wide">refresh</span>
        </button>
      )}
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
  // OPR.0.4.6.MH2 FR-4 — the selected host + registry drive the project
  // explorer's HOST level (fr4a ruling). Discovery walks LOCAL workspace
  // files, so for a remote selection it is GATED OFF AT THE HOOK
  // (enabled:false ⇒ zero /api/files requests — guard-B1: a post-hoc
  // result wrapper is not a gate) and missions derive from the host-keyed
  // slice list only — local folders are never labeled as the remote
  // host's (the twin's mock-seam rule, kept in the build).
  const { data: hostsData } = useHosts();
  const selectHost = useSelectHost();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  const remoteHosts = hostsData?.hosts ?? [];
  // Discovery waits for the selection to be KNOWN (hosts payload landed):
  // gating on !isRemote alone raced — the first render defaults local and
  // fired /api/files/roots before a remote selection resolved. The ONE
  // shared gate (useLocalFilesAllowed) encodes both conditions.
  const filesAllowed = useLocalFilesAllowed();
  const discovery = useMissionDiscovery({ enabled: filesAllowed });
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
  // MH-2: local-only — the workspace name is LOCAL config; a remote
  // selection renders the remote tree regardless of local workspace state.
  if (!isRemote && !workspace.isLoading && workspace.name === null) {
    return (
      <div
        data-testid="project-tree-view"
        className="flex-1 overflow-y-auto py-3 px-3"
      >
        <div
          data-testid="project-no-workspace"
          className="border border-outline-variant bg-surface-low px-3 py-3 font-mono text-[10px]"
        >
          <div className="text-on-surface uppercase tracking-wide font-bold mb-1">
            No workspace connected
          </div>
          <p className="text-on-surface-variant mb-2">
            Configure a workspace root to browse missions and slices.
          </p>
          <Link
            to="/settings"
            data-testid="project-no-workspace-cta"
            className="inline-flex items-center text-on-surface hover:underline uppercase"
          >
            Open settings →
          </Link>
        </div>
      </div>
    );
  }

  // MH-2 honest label: a remote host's workspace NAME is not readable in
  // v1 (config is not on the read allowlist; /api/hosts carries no remote
  // workspaceName) — the HOST level above names the host, the workspace
  // node stays generic. Recorded as a named twin deviation.
  const workspaceLabel = isRemote ? "workspace" : (workspace.name ?? "loading…");
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
            className="font-mono text-[11px] text-on-surface flex-1 truncate hover:underline"
          >
            {m.label}
          </Link>
          <LiveMissionStatusBadge mission={m} />
        </div>
        {missionExpanded ? (
          <ul className="ml-4 border-l border-outline-variant">
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
                      className="flex items-start gap-2 px-2 py-1 font-mono text-xs text-on-surface hover:text-on-surface hover:bg-surface-low"
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

  const workspaceNode = (
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
              className="font-mono text-[11px] uppercase tracking-wide text-on-surface flex-1"
            >
              {workspaceLabel}
            </span>
            <Link
              to="/project"
              data-testid="project-workspace-link"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
            >
              open
            </Link>
          </button>
          {isExpanded("workspace") ? (
            <ul className="ml-4 border-l border-outline-variant">
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
                    className="px-2 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant"
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
                    className="px-2 pt-3 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant"
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
  );

  // OPR.0.4.6.MH2 FR-4 (fr4a RULED) — HOST → WORKSPACE → MISSION → SLICE.
  // The host level renders only when the registry is non-empty (FR-1's
  // "GIVEN one or more added hosts") — an empty registry keeps today's
  // exact tree (zero-regression). Expand = select, mirroring the topology
  // tree: exactly one host's workspace on screen, indicator + data atomic.
  const showHostLevel = remoteHosts.length > 0 || isRemote;
  const ownName = hostsData?.ownName && hostsData.ownName.trim() !== "" ? hostsData.ownName : "localhost";
  const hostRow = (opts: { hostId: string; label: string; isLocal: boolean }) => {
    const isSelected = selectedHost === opts.hostId;
    const chip = isSelected ? "viewing" : opts.isLocal ? "local" : null;
    return (
      <li
        key={opts.hostId}
        data-testid={`project-host-${opts.isLocal ? "localhost" : opts.hostId}`}
        data-selected={isSelected}
      >
        <button
          type="button"
          onClick={() => {
            if (!isSelected) selectHost.mutate({ hostId: opts.hostId });
          }}
          className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
        >
          {isSelected ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
          <Globe className="h-3 w-3 text-on-surface-variant" />
          <span className="font-mono text-[11px] uppercase tracking-wide text-on-surface flex-1 truncate">{opts.label}</span>
          {chip ? (
            <span
              className={cn(
                "font-mono text-[9px] uppercase tracking-[0.12em]",
                chip === "viewing" ? "bg-inverse-surface px-1 text-background" : "text-on-surface-variant",
              )}
            >
              {chip}
            </span>
          ) : null}
        </button>
        {isSelected ? <ul className="ml-4 border-l border-outline-variant">{workspaceNode}</ul> : null}
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
      <ProjectTreeRefreshHeader remoteReadonly={isRemote} />
      <ul>
        {showHostLevel ? (
          <>
            {hostRow({ hostId: LOCAL_HOST_ID, label: ownName, isLocal: true })}
            {remoteHosts.map((h) => hostRow({ hostId: h.id, label: h.id, isLocal: false }))}
          </>
        ) : (
          workspaceNode
        )}
      </ul>
    </div>
  );
}
