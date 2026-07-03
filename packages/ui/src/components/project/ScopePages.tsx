// V1 attempt-3 Phase 3 — Project scope pages per project-tree.md L46–L49 + SC-24.
//
// workspace = overview/progress/artifacts/queue/topology (5 tabs)
// mission = same 5 tabs
// slice = +story +tests = 7 tabs
//
// V1 attempt-3 Phase 5 P5-2: SliceScopePage tab content piping.
// Per code-map AFTER tree fold mapping from Phase 5 dispatch:
//   - StoryGraph → story tab (OPR.0.4.1.19; queue-lineage git-graph, replaces the events TimelineTab)
//   - TestsVerificationTab → tests tab (preserved; tests prop)
//   - TopologyTab → topology tab (preserved; topology prop)
//   - AcceptanceTab → progress tab (FOLDED; canon-7 progress is acceptance + currentStep)
//   - Artifacts tab → ArtifactsNavigator at slice altitude (OPR.0.4.1 AC-4-FF):
//     the slice Artifacts view IS the altitude-scoped file navigator, mirroring the
//     mission-altitude wiring. The prior Files / Commits / Proof / Docs / Decisions
//     sections are dropped — Files+Docs subsumed by the navigator, Proof has its own
//     tab + appears in the tree, Decisions live in the Story DAG (decision-of-record
//     qitems) + decision docs via the navigator, and Commits are FLAGGED 0.4.2 (no
//     qitem->commit linkage; slice-level commitRefs stay in the SliceDetail payload).
//   - Overview tab → README via useScopeMarkdown
//   - Queue tab → qitemIds list with QueueItemTrigger (P5-1 wiring) per content-drawer.md L26
// Workspace + Mission scope tab piping remains Phase 5 polish (filesystem-walk
// dependent; P5-5 lays the data layer).

import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import {
  useQueueItemMap,
  useSliceDetails,
  useSlices,
  useSliceDetail,
  type QueueItemDetail,
  type SliceDetail,
  type SliceListEntry,
} from "../../hooks/useSlices.js";
import {
  deriveMissionStatusFromSlices,
  latestProjectMissionActivity,
  partitionProjectMissions,
  projectSliceFromListEntry,
  projectSliceMeta,
  type ProjectMissionGroup,
} from "../../lib/project-mission-state.js";
import { StoryGraph } from "./StoryGraph.js";
import { buildStoryForest, type StoryQitemInput } from "../../lib/story-graph-model.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { useMission } from "../../hooks/useMission.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { AcceptanceTab } from "../slices/tabs/AcceptanceTab.js";
import { ScopeProofRollup, SliceProofTab } from "./ProofTab.js";
import { TopologyTab } from "../slices/tabs/TopologyTab.js";
import { HostMultiRigGraph } from "../topology/HostMultiRigGraph.js";
import { LiveTerminalProvider, useTerminalCap } from "../terminal/LiveTerminalProvider.js";
import { MissionProgressHeatmap } from "./MissionProgressHeatmap.js";
import { useScopeAudit } from "../../hooks/useScopeAudit.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import {
  DateChip,
  EventBadge,
  FlowChips,
  ProjectPill,
  QueueCountIcon,
  QueueStateBadge,
  sliceStatusTone,
  StatusDot,
  TagPill,
  formatFriendlyDate,
  scopeToken,
  stateTone,
} from "./ProjectMetaPrimitives.js";
import { SteeringTab } from "./SteeringTab.js";
import { ArtifactsNavigator } from "./ArtifactsNavigator.js";
import { WorkspacePortfolioPanel } from "./WorkspacePortfolioPanel.js";

type SharedTab = "overview" | "story" | "progress" | "artifacts" | "proof" | "queue" | "topology" | "steering";
type SliceTab = SharedTab | "story" | "proof";

const SHARED_TABS: { id: SharedTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "story", label: "Story" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
  { id: "proof", label: "Proof" },
  { id: "queue", label: "Queue" },
  { id: "topology", label: "Workflow" },
];

// OPR.0.4.1.17 — mission tab set adds Steering as the LANDING (mission-only; not on the parent
// or slice altitudes). Other taxonomy moves (Workflow add, Queue/Topology drop) = separate slices.
const MISSION_TABS: { id: SharedTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "steering", label: "Steering" },
  { id: "story", label: "Story" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
  { id: "proof", label: "Proof" },
  { id: "queue", label: "Queue" },
  { id: "topology", label: "Workflow" },
];

const SLICE_TABS: { id: SliceTab; label: string }[] = [
  { id: "story", label: "Story" },
  { id: "overview", label: "Overview" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
  { id: "proof", label: "Proof" },
  { id: "queue", label: "Queue" },
  { id: "topology", label: "Workflow" },
];

function TabNav<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    // Internal tablist — div, not <nav>, to keep SC-1 chrome count clean.
    <div
      role="tablist"
      data-testid="project-tab-nav"
      className="flex gap-1 border-b border-outline-variant mb-6 overflow-x-auto"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          data-testid={`project-tab-${t.id}`}
          data-active={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2 -mb-px shrink-0",
            active === t.id
              ? "border-on-surface text-on-surface"
              : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ScopeShell({
  eyebrow,
  title,
  tabs,
  active,
  onSelect,
  children,
}: {
  eyebrow: string;
  title: string;
  tabs: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  // OPR.0.4.0.1 forward-fix (FR-2): mount ONE explicit LiveTerminalProvider for
  // every project scope page so all of the page's progressive terminals (the
  // Topology tab + HostMultiRigGraph etc.) share ONE global live-terminal
  // registry + configured cap, instead of TopologyTab resolving to the separate
  // module-singleton fallback (which would silently UNSHARE the cap). Mirrors the
  // topology/ScopePages provider mount.
  const liveCap = useTerminalCap();
  return (
    <LiveTerminalProvider cap={liveCap}>
    <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">{eyebrow}</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface mt-1">
          {title}
        </h1>
      </header>
      <TabNav tabs={tabs} active={active} onSelect={onSelect} />
      <div role="tabpanel" data-testid="project-tab-panel">
        {children}
      </div>
    </div>
    </LiveTerminalProvider>
  );
}

function PlaceholderTab({ label, description }: { label: string; description?: string }) {
  return (
    <EmptyState
      label={label}
      description={description ?? "Phase 5 polish."}
      variant="card"
      testId={`project-tab-placeholder-${label.toLowerCase()}`}
    />
  );
}

function formatLastActivity(ts: number): string {
  if (ts <= 0) return "no recent activity";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sliceMissionKey(slice: SliceListEntry): string {
  return slice.missionId ?? slice.railItem ?? "unsorted";
}

function rowsForScope(rows: SliceListEntry[], missionId: string | null): SliceListEntry[] {
  if (!missionId) return rows;
  return rows.filter((slice) => sliceMissionKey(slice) === missionId);
}

function useProjectScopeRollup(missionId: string | null, loadDetails: boolean) {
  const list = useSlices("all");
  const rows = useMemo(() => {
    if (!list.data || "unavailable" in list.data) return [];
    return rowsForScope(list.data.slices, missionId);
  }, [list.data, missionId]);
  const details = useSliceDetails(loadDetails ? rows.map((slice) => slice.name) : []);
  const qitemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const detail of details.itemsByName.values()) {
      if (Array.isArray(detail.qitemIds)) {
        detail.qitemIds.forEach((qitemId) => ids.add(qitemId));
      }
    }
    return Array.from(ids).sort();
  }, [details.itemsByName]);
  const queueItems = useQueueItemMap(loadDetails ? qitemIds : []);

  return { list, rows, details, qitemIds, queueItems };
}

function ScopeProgressRollup({
  rows,
  detailsByName,
  isLoading,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  isLoading: boolean;
}) {
  if (isLoading && rows.length === 0) {
    return <PlaceholderTab label="LOADING PROGRESS" description="Reading scoped slice progress." />;
  }
  if (rows.length === 0) {
    return <EmptyState label="NO SCOPED SLICES" description="No slices are indexed for this scope." variant="card" testId="scope-progress-empty" />;
  }
  return (
    <div data-testid="scope-progress-rollup" className="space-y-3">
      {rows.map((row) => {
        const detail = detailsByName.get(row.name);
        return (
          <article key={row.name} className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3 border-b border-outline-variant pb-2">
              <div className="min-w-0">
                <Link
                  to="/project/slice/$sliceId"
                  params={{ sliceId: row.name }}
                  className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface hover:underline"
                >
                  {row.displayName}
                </Link>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ProjectPill token={scopeToken("slice")} compact />
                  <ProjectPill token={{ label: row.status, tone: stateTone(row.status) }} compact />
                  <DateChip value={row.lastActivityAt} />
                </div>
              </div>
            </div>
            <div className="mt-3 grid gap-2 font-mono text-[10px] text-on-surface sm:grid-cols-4">
              <SliceMetric label="Qitems" value={detail?.qitemIds.length ?? row.qitemCount} />
              <SliceMetric label="Proof" value={detail ? detail.tests.proofPackets.length : row.hasProofPacket ? 1 : 0} />
              <SliceMetric label="Progress" value={detail ? `${detail.acceptance.percentage}%` : "unknown"} />
              <SliceMetric label="Last activity" value={formatMaybeDate(row.lastActivityAt)} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ScopeQueueRollup({
  qitemIds,
  queueItemsById,
  isFetching,
}: {
  qitemIds: string[];
  queueItemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
}) {
  // V0.3.1 slice 17 founder-walk-workspace-state-correctness — walk item 10 (slice queue descending order). Latest qitem at top. Prefer
  // tsCreated when the loaded detail is available; fall back to the
  // qitem-id (which encodes a timestamp prefix `qitem-YYYYMMDD...`) so
  // sort works before queueItemsById has finished loading.
  const sortedQitemIds = [...qitemIds].sort((a, b) => {
    const itemA = queueItemsById.get(a);
    const itemB = queueItemsById.get(b);
    const tsA = itemA?.tsCreated ?? a;
    const tsB = itemB?.tsCreated ?? b;
    if (tsA === tsB) return 0;
    return tsA < tsB ? 1 : -1; // DESC
  });
  if (sortedQitemIds.length === 0) {
    return <EmptyState label="NO QITEMS" description="No queue items are indexed for this scope." variant="card" testId="scope-queue-empty" />;
  }
  return (
    <div data-testid="scope-queue-rollup">
      {isFetching ? (
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
          Loading queue bodies...
        </div>
      ) : null}
      <ul className="divide-y divide-outline-variant border border-outline-variant">
        {sortedQitemIds.map((qitemId) => {
          const item = queueItemsById.get(qitemId);
          return (
            <li key={qitemId} className="bg-surface-lowest/35 backdrop-blur-sm">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`scope-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-surface-lowest/55"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {item?.state ? <QueueStateBadge state={item.state} compact /> : <EventBadge kind="queue.item" compact />}
                  <DateChip value={item?.tsCreated} />
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-on-surface">
                  {queueBodyPreview(qitemId, item)}
                </span>
                {item ? (
                  <span className="mt-2 block space-y-2">
                    <FlowChips source={item.sourceSession} destination={item.destinationSession} muted />
                    <span className="flex flex-wrap gap-1.5">
                      {(item.tags ?? []).slice(0, 5).map((tag) => <TagPill key={tag} tag={tag} />)}
                    </span>
                  </span>
                ) : null}
              </QueueItemTrigger>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScopeArtifactsRollup({
  rows,
  detailsByName,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
}) {
  if (rows.length === 0) {
    return <EmptyState label="NO ARTIFACTS" description="No slices are indexed for this scope." variant="card" testId="scope-artifacts-empty" />;
  }
  return (
    <div data-testid="scope-artifacts-rollup" className="space-y-3">
      {rows.map((row) => {
        const detail = detailsByName.get(row.name);
        const proofCount = detail?.tests.proofPackets.length ?? (row.hasProofPacket ? 1 : 0);
        const screenshotCount = detail?.tests.proofPackets.reduce((count, packet) => count + packet.screenshots.length, 0) ?? 0;
        return (
          <article key={row.name} className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
            <Link
              to="/project/slice/$sliceId"
              params={{ sliceId: row.name }}
              className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface hover:underline"
            >
              {row.displayName}
            </Link>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ProjectPill token={scopeToken("slice")} compact />
              <ProjectPill token={{ label: row.status, tone: stateTone(row.status) }} compact />
            </div>
            <div className="mt-3 grid gap-2 font-mono text-[10px] text-on-surface sm:grid-cols-4">
              <SliceMetric label="Files" value={detail?.docs.tree.length ?? "unknown"} />
              <SliceMetric label="Commits" value={detail?.commitRefs.length ?? "unknown"} />
              <SliceMetric label="Proof packets" value={proofCount} />
              <SliceMetric label="Screenshots" value={screenshotCount} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

// Exported for focused unit coverage (OPR.0.4.1.18): the QA-blocking bug was
// this mapper hardcoding summary: null, so the regression guard tests it directly.
export function toStoryInput(item: QueueItemDetail): StoryQitemInput {
  return {
    qitemId: item.qitemId,
    tsCreated: item.tsCreated,
    tsUpdated: item.tsUpdated,
    sourceSession: item.sourceSession,
    destinationSession: item.destinationSession,
    state: item.state,
    closureReason: item.closureReason ?? null,
    closureTarget: item.closureTarget ?? null,
    priority: item.priority ?? null,
    tier: item.tier ?? null,
    blockedOn: item.blockedOn ?? null,
    tags: item.tags ?? [],
    body: item.body,
    // OPR.0.4.1.18: the authored human summary now rides on QueueItemDetail
    // (served by /api/queue/:id). Pass it through; story-graph-model's
    // deriveSummary prefers it and degrades to the first body line when null
    // (pre-18 qitems + any an author omitted). body stays the source of truth
    // for the drawer / drill-in; the handoff child's own summary is used (the
    // model reads each item's summary, never the parent's).
    summary: item.summary ?? null,
    chainOfRecord: item.chainOfRecord ?? null,
    handedOffFrom: item.handedOffFrom ?? null,
    handedOffTo: item.handedOffTo ?? null,
    claimedAt: item.claimedAt ?? null,
    expiresAt: item.expiresAt ?? null,
    closureRequiredAt: item.closureRequiredAt ?? null,
    lastNudgeAttempt: item.lastNudgeAttempt ?? null,
    lastNudgeResult: item.lastNudgeResult ?? null,
    lastHeartbeat: item.lastHeartbeat ?? null,
    resolution: item.resolution ?? null,
    targetRepo: item.targetRepo ?? null,
  };
}

// OPR.0.4.1.19 — the Story tab IS the queue-lineage git-graph (replaces the prior
// events timeline at both mission and slice altitude). The forest reconstructs
// from the scope's queue items (chain_of_record + handoff lineage).
function ScopeStoryRollup({
  queueItemsById,
  isFetching,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  queueItemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
}) {
  const forest = useMemo(
    () => buildStoryForest(Array.from(queueItemsById.values()).map(toStoryInput)),
    [queueItemsById],
  );
  if (isFetching && forest.nodes.length === 0) {
    return <PlaceholderTab label="LOADING STORY" description="Reading queue lineage." />;
  }
  return (
    <div data-testid="scope-story-rollup">
      <StoryGraph forest={forest} />
    </div>
  );
}


function aggregateTopology(detailsByName: Map<string, SliceDetail>): SliceDetail["topology"] {
  const rigs = new Map<string, { rigId: string; rigName: string; sessionNames: Set<string> }>();
  for (const detail of detailsByName.values()) {
    if (!detail.topology || !Array.isArray(detail.topology.affectedRigs)) continue;
    for (const rig of detail.topology.affectedRigs) {
      const key = rig.rigName || rig.rigId;
      if (!rigs.has(key)) {
        rigs.set(key, { rigId: rig.rigId, rigName: rig.rigName, sessionNames: new Set() });
      }
      const aggregate = rigs.get(key)!;
      rig.sessionNames.forEach((session) => aggregate.sessionNames.add(session));
    }
  }
  const affectedRigs = Array.from(rigs.values()).map((rig) => ({
    rigId: rig.rigId,
    rigName: rig.rigName,
    sessionNames: Array.from(rig.sessionNames).sort(),
  }));
  return {
    affectedRigs,
    totalSeats: affectedRigs.reduce((count, rig) => count + rig.sessionNames.length, 0),
    specGraph: null,
  };
}

function ScopeTopologyRollup({ detailsByName }: { detailsByName: Map<string, SliceDetail> }) {
  return (
    <div data-testid="scope-topology-rollup">
      <TopologyTab topology={aggregateTopology(detailsByName)} />
    </div>
  );
}

function WorkspaceOverviewPanel() {
  const { data, isLoading } = useSlices("all");
  const missions = useMemo<ProjectMissionGroup[]>(() => {
    if (!data || "unavailable" in data) return [];
    const buckets = new Map<string, ProjectMissionGroup["slices"]>();
    for (const slice of data.slices) {
      const row = projectSliceFromListEntry(slice);
      const key = row.missionId ?? row.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }
    return Array.from(buckets.entries()).map(([key, slices]) => ({
      id: key,
      label: key === "unsorted" ? "Unsorted" : key,
      status: deriveMissionStatusFromSlices(slices),
      slices,
    }));
  }, [data]);
  const sections = useMemo(() => partitionProjectMissions(missions), [missions]);

  if (isLoading) {
    return (
      <EmptyState
        label="LOADING WORKSPACE"
        description="Reading slice index."
        variant="card"
        testId="workspace-overview-loading"
      />
    );
  }

  if (data && "unavailable" in data) {
    return (
      <EmptyState
        label="WORKSPACE INDEX UNAVAILABLE"
        description={data.hint ?? "Slice index is not available from the configured workspace."}
        variant="card"
        testId="workspace-overview-unavailable"
      />
    );
  }

  const renderMissionCard = (mission: ProjectMissionGroup, bucket: "current" | "archive") => (
    <article
      key={mission.id}
      data-testid={`workspace-overview-mission-${mission.id}`}
      data-mission-bucket={bucket}
      className="border border-outline-variant bg-surface-lowest/20 px-3 py-3"
    >
      <div className="flex items-start justify-between gap-3 border-b border-outline-variant pb-2">
        <div className="min-w-0">
          <h3 className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface truncate">
            {mission.label}
          </h3>
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
            {mission.slices.length} slice{mission.slices.length === 1 ? "" : "s"} ·{" "}
            {formatLastActivity(latestProjectMissionActivity(mission))}
          </p>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          {mission.status}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {mission.slices.map((slice) => {
          const meta = projectSliceMeta(slice);
          return (
            <li key={slice.name}>
              <Link
                to="/project/slice/$sliceId"
                params={{ sliceId: slice.name }}
                data-testid={`workspace-overview-slice-${slice.name}`}
                title={`${slice.displayName} — ${meta}`}
                aria-label={`${slice.displayName} (${meta})`}
                className="flex items-start gap-2 px-2 py-1 font-mono text-[11px] text-on-surface hover:bg-surface-low hover:text-on-surface"
              >
                <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{slice.displayName}</span>
                <span
                  data-testid={`workspace-overview-slice-${slice.name}-meta`}
                  className="flex shrink-0 items-center gap-1.5"
                >
                  <QueueCountIcon count={slice.qitemCount} testId={`workspace-overview-slice-${slice.name}-qitems`} />
                  <StatusDot
                    tone={sliceStatusTone(slice.status)}
                    label={slice.status}
                    testId={`workspace-overview-slice-${slice.name}-status`}
                  />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </article>
  );

  return (
    <div data-testid="workspace-overview-panel" className="grid gap-4 lg:grid-cols-2">
      <section data-testid="workspace-overview-current" className="space-y-3">
        <div className="flex items-center justify-between border-b border-outline-variant pb-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface">
            Current Work
          </h2>
          <span className="font-mono text-[10px] text-on-surface-variant">
            {sections.current.length}
          </span>
        </div>
        {sections.current.length > 0 ? (
          sections.current.map((mission) => renderMissionCard(mission, "current"))
        ) : (
          <EmptyState
            label="NO CURRENT WORK"
            description="No live qitem-backed or recent active slices are indexed."
            variant="card"
            testId="workspace-overview-current-empty"
          />
        )}
      </section>
      <section data-testid="workspace-overview-archive" className="space-y-3">
        <div className="flex items-center justify-between border-b border-outline-variant pb-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface">
            Archive
          </h2>
          <span className="font-mono text-[10px] text-on-surface-variant">
            {sections.archive.length}
          </span>
        </div>
        {sections.archive.length > 0 ? (
          sections.archive.map((mission) => renderMissionCard(mission, "archive"))
        ) : (
          <EmptyState
            label="NO ARCHIVE"
            description="No archived slices are indexed."
            variant="card"
            testId="workspace-overview-archive-empty"
          />
        )}
      </section>
    </div>
  );
}

export function WorkspaceScopePage() {
  const [active, setActive] = useState<SharedTab>("overview");
  const workspace = useWorkspaceName();
  const rollup = useProjectScopeRollup(null, active !== "overview");

  // A5 bounce-fix: live-wired workspace name; honest empty-state when unset.
  if (!workspace.isLoading && workspace.name === null) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-12">
        <EmptyState
          label="NO WORKSPACE CONNECTED"
          description="Configure a workspace root to browse missions and slices in this destination."
          variant="card"
          testId="workspace-scope-no-workspace"
          action={{ label: "Open settings", href: "/settings" }}
        />
      </div>
    );
  }

  return (
    <ScopeShell
      eyebrow="Workspace"
      title={workspace.name ?? "loading…"}
      tabs={SHARED_TABS}
      active={active}
      onSelect={(id) => setActive(id as SharedTab)}
    >
      {active === "overview" ? (
        // OPR.0.4.1.24 — the workspace parent altitude lands on the cross-mission
        // portfolio (collapsed missions, most-recently-modified, expand→steering glance).
        // Supersedes the prior WorkspaceOverviewPanel mission grid.
        <WorkspacePortfolioPanel />
      ) : null}
      {active === "story" ? (
        <ScopeStoryRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "progress" ? (
        <ScopeProgressRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          isLoading={rollup.list.isLoading || rollup.details.isFetching}
        />
      ) : null}
      {active === "artifacts" ? (
        <ScopeArtifactsRollup rows={rollup.rows} detailsByName={rollup.details.itemsByName} />
      ) : null}
      {active === "proof" ? (
        <ScopeProofRollup
          rows={rollup.rows.map((r) => ({
            name: r.name,
            displayName: r.displayName,
            slicePath: r.slicePath ?? null,
          }))}
        />
      ) : null}
      {active === "queue" ? (
        <ScopeQueueRollup
          qitemIds={rollup.qitemIds}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "topology" ? (
        <div
          data-testid="workspace-topology-hostmultirig"
          className="flex-1 min-h-0 relative h-[60vh]"
        >
          <HostMultiRigGraph />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function MissionScopePage() {
  const { missionId } = useParams({ from: "/project/mission/$missionId" });
  // OPR.0.4.1.17 — Steering is the mission LANDING tab.
  const [active, setActive] = useState<SharedTab>("steering");
  // Steering (the landing) + Overview need only the slice LIST, not per-slice
  // details or queue bodies. Gate the detail+queue cascade off BOTH so the
  // two-projection landing never fires hidden slice-detail/queue-body fetches
  // (guard forward-fix: steering !== overview would otherwise load them).
  const rollup = useProjectScopeRollup(missionId, active !== "overview" && active !== "steering");
  // V0.3.1 slice 12 walk-item 1 — fetch aggregated mission metadata
  // (missionPath for README/PROGRESS lookup; slices already covered
  // by rollup). README + PROGRESS render via useScopeMarkdown above
  // the existing slice rail.
  const missionData = useMission(missionId);
  const missionPath =
    missionData.data && "missionPath" in missionData.data ? missionData.data.missionPath : null;
  const missionReadme = useScopeMarkdown(missionPath, "README.md");
  const missionProgress = useScopeMarkdown(missionPath, "PROGRESS.md");
  const scopeAudit = useScopeAudit(missionId);
  return (
    <ScopeShell
      eyebrow="Mission"
      title={missionId}
      tabs={MISSION_TABS}
      active={active}
      onSelect={(id) => setActive(id as SharedTab)}
    >
      {active === "steering" ? <SteeringTab missionId={missionId} /> : null}
      {active === "overview" ? (
        <div data-testid="mission-overview-panel" className="space-y-6">
          {missionReadme.content && (
            <section data-testid="mission-overview-readme" className="border border-outline-variant bg-surface-lowest/20 p-4">
              <MarkdownViewer content={missionReadme.content} hideFrontmatter hideRawToggle />
            </section>
          )}
          <div className="space-y-3">
            {rollup.rows.length > 0 ? (
              rollup.rows.map((slice) => {
                const meta = projectSliceMeta(slice);
                return (
                  <article key={slice.name} className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
                    <div className="flex items-start gap-3">
                      <Link
                        to="/project/slice/$sliceId"
                        params={{ sliceId: slice.name }}
                        data-testid={`mission-overview-slice-${slice.name}`}
                        title={`${slice.displayName} — ${meta}`}
                        aria-label={`${slice.displayName} (${meta})`}
                        className="min-w-0 flex-1 whitespace-normal break-words font-mono text-[12px] uppercase leading-snug tracking-[0.12em] text-on-surface hover:underline"
                      >
                        {slice.displayName}
                      </Link>
                      <span
                        data-testid={`mission-overview-slice-${slice.name}-meta`}
                        className="flex shrink-0 items-center gap-1.5"
                      >
                        <QueueCountIcon count={slice.qitemCount} testId={`mission-overview-slice-${slice.name}-qitems`} />
                        <StatusDot
                          tone={sliceStatusTone(slice.status)}
                          label={slice.status}
                          testId={`mission-overview-slice-${slice.name}-status`}
                        />
                      </span>
                    </div>
                  </article>
                );
              })
            ) : (
              <EmptyState
                label="NO SLICES"
                description="No indexed slices are attached to this mission."
                variant="card"
                testId="mission-overview-empty"
              />
            )}
          </div>
        </div>
      ) : null}
      {active === "story" ? (
        <ScopeStoryRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "progress" ? (
        <div data-testid="mission-progress-panel" className="space-y-6">
          <MissionProgressHeatmap
            rows={rollup.rows}
            detailsByName={rollup.details.itemsByName}
            isLoading={rollup.list.isLoading || rollup.details.isFetching}
          />
          {scopeAudit.data && (scopeAudit.data.mission.railStatus === "missing" || scopeAudit.data.mission.railStatus === "malformed") ? (
            <EmptyState
              label={scopeAudit.data.mission.railStatus === "malformed" ? "PROGRESS RAIL MALFORMED" : "PROGRESS RAIL MISSING"}
              description={
                scopeAudit.data.mission.railStatus === "malformed"
                  ? `Mission progress rail has errors (${scopeAudit.data.mission.frontmatterError ?? "malformed frontmatter"}). Run the audit command to diagnose.`
                  : "This mission has no PROGRESS.md. Scaffold one or run the audit to check scope health."
              }
              variant="card"
              testId="mission-progress-rail-status"
              action={{ label: `rig scope audit --mission ${missionId}` }}
            />
          ) : missionProgress.content ? (
            <section data-testid="mission-progress-readme" className="border border-outline-variant bg-surface-lowest/20 p-4">
              <MarkdownViewer content={missionProgress.content} hideFrontmatter hideRawToggle />
            </section>
          ) : !scopeAudit.isLoading ? (
            <EmptyState
              label="NO PROGRESS YET"
              description="No progress data has been written for this mission."
              variant="card"
              testId="mission-progress-empty"
            />
          ) : null}
          {scopeAudit.data && scopeAudit.data.totalFindings > 0 && (
            <section data-testid="mission-scope-findings" className="border border-outline-variant bg-amber-50/40 p-4">
              <SectionHeader>Scope Audit Findings ({scopeAudit.data.totalFindings})</SectionHeader>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {[...scopeAudit.data.mission.findings, ...scopeAudit.data.slices.flatMap((s) => s.findings)].map((f, i) => (
                  <li key={i} className={cn("px-2 py-1", f.severity === "high" ? "text-red-700" : "text-on-surface-variant")}>
                    [{f.severity}] {f.kind}: {f.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {/* OPR.0.4.1.22 — per-slice rollup CARDS removed from the mission
              Progress tab (founder round-8: remove cards, keep heatmap). The
              MissionProgressHeatmap above is the per-slice acceptance view; the
              redundant ScopeProgressRollup card wall is cut. (rollup.details
              still loads — the heat-map's acceptance cells read it.) */}
        </div>
      ) : null}
      {active === "artifacts" ? (
        // OPR.0.4.1.21 — mission Artifacts is now the altitude-scoped file
        // navigator (rooted at the mission dir = all mission artifacts),
        // replacing the per-slice ScopeArtifactsRollup card wall.
        <ArtifactsNavigator scopePath={missionPath} scopeLabel={missionId} />
      ) : null}
      {active === "proof" ? (
        <ScopeProofRollup
          rows={rollup.rows.map((r) => ({
            name: r.name,
            displayName: r.displayName,
            slicePath: r.slicePath ?? null,
          }))}
        />
      ) : null}
      {active === "queue" ? (
        <ScopeQueueRollup
          qitemIds={rollup.qitemIds}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "topology" ? (
        (() => {
          // V0.3.1 slice 13 walk-item 7 — when the mission declares
          // `workflow_spec: <name>@<version>` in its README frontmatter
          // AND the spec is in the WorkflowSpecCache, the missions
          // route returns a projected spec graph. Render it via
          // TopologyTab (same component the slice scope uses). Fall
          // back to the session-name aggregation when the declaration
          // is absent or the spec isn't cached.
          const missionTopology =
            missionData.data && "topology" in missionData.data
              ? missionData.data.topology
              : null;
          if (missionTopology?.specGraph) {
            return (
              <TopologyTab
                topology={{
                  affectedRigs: [],
                  totalSeats: 0,
                  specGraph: missionTopology.specGraph,
                }}
              />
            );
          }
          return <ScopeTopologyRollup detailsByName={rollup.details.itemsByName} />;
        })()
      ) : null}
    </ScopeShell>
  );
}

function queueItemViewerData(qitemId: string, item: QueueItemDetail | undefined) {
  return {
    qitemId,
    source: item?.sourceSession,
    destination: item?.destinationSession,
    state: item?.state,
    tags: item?.tags ?? undefined,
    createdAt: item?.tsCreated,
    body: item?.body,
  };
}

function queueBodyPreview(qitemId: string, item: QueueItemDetail | undefined): string {
  if (!item?.body) return qitemId;
  const lines = item.body.split("\n");
  if (lines.length <= 8) return item.body;
  return `${lines.slice(0, 8).join("\n")}\n... ${lines.length - 8} more lines`;
}

function SliceQueueTab({
  qitemIds,
  queueItemsById,
  queueItemsFetching,
}: {
  qitemIds: string[];
  queueItemsById: Map<string, QueueItemDetail>;
  queueItemsFetching: boolean;
}) {
  // V1 attempt-3 Phase 5 P5-2: slice queue tab. Each qitem id is wrapped in
  // QueueItemTrigger (P5-1 trigger primitive). Phase B supplies the body and
  // provenance from the existing queue detail endpoint when available.
  if (qitemIds.length === 0) {
    return (
      <EmptyState
        label="NO QITEMS"
        description="No queue items associated with this slice."
        variant="card"
        testId="slice-queue-empty"
      />
    );
  }
  return (
    <div>
      {queueItemsFetching ? (
        <div
          data-testid="slice-queue-fetching"
          className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
        >
          Loading queue bodies...
        </div>
      ) : null}
      <ul
        data-testid="slice-queue-list"
        className="divide-y divide-outline-variant border border-outline-variant"
      >
        {qitemIds.map((qitemId) => {
          const item = queueItemsById.get(qitemId);
          return (
            <li key={qitemId} className="bg-surface-lowest/35 backdrop-blur-sm">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`slice-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left hover:bg-surface-lowest/55 transition-colors font-mono text-xs"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {item?.state ? <QueueStateBadge state={item.state} compact /> : <EventBadge kind="queue.item" compact />}
                  <DateChip value={item?.tsCreated} />
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-on-surface">
                  {queueBodyPreview(qitemId, item)}
                </span>
                {item ? (
                  <span
                    data-testid={`slice-queue-meta-${qitemId}`}
                    className="mt-2 block space-y-2 text-[10px] text-on-surface-variant"
                  >
                    <FlowChips source={item.sourceSession} destination={item.destinationSession} muted />
                    <span className="flex flex-wrap gap-1.5">
                      <TagPill tag={qitemId} />
                      {(item.tags ?? []).slice(0, 5).map((tag) => <TagPill key={tag} tag={tag} />)}
                    </span>
                  </span>
                ) : null}
              </QueueItemTrigger>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatMaybeDate(ts: string | null): string {
  return formatFriendlyDate(ts);
}

function SliceMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold text-on-surface">{value}</div>
    </div>
  );
}

function SliceOverviewTab({ detail }: { detail: SliceDetail }) {
  const currentStep = detail.acceptance.currentStep;
  // V0.3.1 slice 12 walk-item 1 — render slice README via the
  // generalized scope-markdown reader; the Primary Docs filename
  // duplication section is dropped (the README itself + the Docs tab
  // tree are sufficient).
  const readmeMd = useScopeMarkdown(detail.slicePath ?? null, "README.md");

  return (
    <div data-testid="slice-overview-tab" className="space-y-6">
      <section data-testid="slice-overview-summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SliceMetric label="Status" value={detail.status} />
        <SliceMetric label="Progress" value={`${detail.acceptance.percentage}%`} />
        <SliceMetric label="Qitems" value={detail.qitemIds.length} />
        <SliceMetric label="Last Activity" value={formatMaybeDate(detail.lastActivityAt)} />
      </section>

      {readmeMd.content && (
        <section data-testid="slice-overview-readme" className="border border-outline-variant bg-surface-lowest/20 p-4">
          <MarkdownViewer content={readmeMd.content} hideFrontmatter hideRawToggle />
        </section>
      )}

      <section data-testid="slice-overview-current-step" className="border border-outline-variant bg-surface-lowest/20 p-4">
        <SectionHeader tone="muted">Current Step</SectionHeader>
        {currentStep ? (
          <div className="mt-3 grid gap-2 font-mono text-[10px] text-on-surface sm:grid-cols-2">
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">Step</div>
              <div className="font-bold text-on-surface">{currentStep.stepId}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">Role</div>
              <div className="font-bold text-on-surface">{currentStep.role}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">Objective</div>
              <div>{currentStep.objective ?? "No objective declared."}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">Allowed exits</div>
              <div>{currentStep.allowedExits.join(", ") || "-"}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">Hop count</div>
              <div>{currentStep.hopCount}</div>
            </div>
          </div>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-on-surface-variant">No workflow step is currently bound.</div>
        )}
      </section>

      <section data-testid="slice-overview-readiness" className="border border-outline-variant bg-surface-lowest/20 p-4">
        <SectionHeader tone="muted">Readiness</SectionHeader>
        <div className="mt-3 space-y-2 font-mono text-[10px] text-on-surface">
          <div>{detail.acceptance.doneItems} of {detail.acceptance.totalItems} acceptance items complete.</div>
          <div>{detail.tests.aggregate.passCount} proof packets passing / {detail.tests.aggregate.failCount} failing.</div>
          {detail.acceptance.closureCallout && (
            <div className="border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
              {detail.acceptance.closureCallout}
            </div>
          )}
          {detail.workflowBinding && (
            <div className="text-on-surface-variant">
              Workflow: {detail.workflowBinding.workflowName} v{detail.workflowBinding.workflowVersion}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function SliceScopePage() {
  const { sliceId } = useParams({ from: "/project/slice/$sliceId" });
  // V0.3.1 slice 12 walk-item 1 — default tab is Overview (README +
  // current step + readiness) instead of Story; the first thing the
  // operator should see on a slice is its README, not a metric grid.
  const [active, setActive] = useState<SliceTab>("overview");
  const detailQuery = useSliceDetail(sliceId);
  const queueItems = useQueueItemMap(detailQuery.data?.qitemIds ?? []);
  const queueItemsById = useMemo(() => queueItems.itemsById, [queueItems.itemsById]);
  const sliceScopeAudit = useScopeAudit(detailQuery.data?.missionId ?? null);

  if (detailQuery.isLoading) {
    return (
      <ScopeShell
        eyebrow="Slice"
        title={sliceId}
        tabs={SLICE_TABS}
        active={active}
        onSelect={(id) => setActive(id as SliceTab)}
      >
        <EmptyState
          label="LOADING"
          description={`Fetching /api/slices/${sliceId}…`}
          variant="card"
          testId="slice-scope-loading"
        />
      </ScopeShell>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ScopeShell
        eyebrow="Slice"
        title={sliceId}
        tabs={SLICE_TABS}
        active={active}
        onSelect={(id) => setActive(id as SliceTab)}
      >
        <EmptyState
          label="SLICE NOT AVAILABLE"
          description={
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : `Could not load slice "${sliceId}". The slices indexer may not be configured (rig config get workspace.slices_root).`
          }
          variant="card"
          testId="slice-scope-error"
        />
      </ScopeShell>
    );
  }

  const detail = detailQuery.data;
  const sliceAuditEntry = sliceScopeAudit.data?.slices.find((s) => s.name === detail.name) ?? null;

  return (
    <ScopeShell
      eyebrow="Slice"
      title={detail.displayName || detail.name}
      tabs={SLICE_TABS}
      active={active}
      onSelect={(id) => setActive(id as SliceTab)}
    >
      {active === "story" ? (
        <ScopeStoryRollup
          rows={[]}
          detailsByName={new Map<string, SliceDetail>()}
          queueItemsById={queueItemsById}
          isFetching={false}
        />
      ) : null}
      {active === "overview" ? (
        <SliceOverviewTab detail={detail} />
      ) : null}
      {active === "progress" ? (
        <div className="space-y-6">
          {sliceAuditEntry && (sliceAuditEntry.railStatus === "missing" || sliceAuditEntry.railStatus === "malformed") && (
            <EmptyState
              label={sliceAuditEntry.railStatus === "malformed" ? "PROGRESS RAIL MALFORMED" : "PROGRESS RAIL MISSING"}
              description={
                sliceAuditEntry.railStatus === "malformed"
                  ? `Slice progress rail has errors (${sliceAuditEntry.frontmatterError ?? "malformed frontmatter"}). Run the audit command to diagnose.`
                  : "This slice has no PROGRESS.md and no readme-only marker."
              }
              variant="card"
              testId="slice-progress-rail-status"
              action={{ label: `rig scope audit --mission ${detail.missionId}` }}
            />
          )}
          {sliceAuditEntry && sliceAuditEntry.findings.length > 0 && (
            <section data-testid="slice-scope-findings" className="border border-outline-variant bg-amber-50/40 p-4">
              <SectionHeader>Scope Findings ({sliceAuditEntry.findings.length})</SectionHeader>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {sliceAuditEntry.findings.map((f, i) => (
                  <li key={i} className={cn("px-2 py-1", f.severity === "high" ? "text-red-700" : "text-on-surface-variant")}>
                    [{f.severity}] {f.kind}: {f.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <AcceptanceTab acceptance={detail.acceptance} />
        </div>
      ) : null}
      {active === "artifacts" ? (
        // OPR.0.4.1 AC-4-FF — the slice Artifacts view IS the altitude-scoped file
        // navigator (slice 21's pattern at slice altitude), rooted at the slice dir.
        // The prior Files/Commits/Proof/Docs/Decisions card wall is dropped; commits
        // are flagged 0.4.2 (no qitem->commit linkage), decisions live in the Story
        // DAG + decision docs surface in this navigator tree.
        <ArtifactsNavigator scopePath={detail.slicePath} scopeLabel={detail.displayName || detail.name} />
      ) : null}
      {active === "proof" ? (
        <SliceProofTab
          sliceId={detail.displayName}
          title={detail.name}
          slicePath={detail.slicePath}
        />
      ) : null}
      {active === "queue" ? (
        <SliceQueueTab
          qitemIds={detail.qitemIds}
          queueItemsById={queueItemsById}
          queueItemsFetching={queueItems.isFetching}
        />
      ) : null}
      {active === "topology" ? <TopologyTab topology={detail.topology} /> : null}
    </ScopeShell>
  );
}
