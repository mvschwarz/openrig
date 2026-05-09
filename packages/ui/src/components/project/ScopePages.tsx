// V1 attempt-3 Phase 3 — Project scope pages per project-tree.md L46–L49 + SC-24.
//
// workspace = overview/progress/artifacts/queue/topology (5 tabs)
// mission = same 5 tabs
// slice = +story +tests = 7 tabs
//
// V1 attempt-3 Phase 5 P5-2: SliceScopePage tab content piping.
// Per code-map AFTER tree fold mapping from Phase 5 dispatch:
//   - StoryTab → story tab (preserved; events + phaseDefinitions props)
//   - TestsVerificationTab → tests tab (preserved; tests prop)
//   - TopologyTab → topology tab (preserved; topology prop)
//   - AcceptanceTab → progress tab (FOLDED; canon-7 progress is acceptance + currentStep)
//   - DocsTab + DecisionsTab → artifacts tab (FOLDED vertically; canon-7 artifacts is docs+decisions)
//   - Overview tab → README/IMPLEMENTATION-PRD via DocsTab pre-selected for now
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
import { StoryTab } from "../slices/tabs/StoryTab.js";
import { AcceptanceTab } from "../slices/tabs/AcceptanceTab.js";
import { DocsTab } from "../slices/tabs/DocsTab.js";
import { DecisionsTab } from "../slices/tabs/DecisionsTab.js";
import { TestsVerificationTab } from "../slices/tabs/TestsVerificationTab.js";
import { TopologyTab } from "../slices/tabs/TopologyTab.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import {
  DateChip,
  EventBadge,
  FlowChips,
  ProjectPill,
  ProofPacketHeader,
  ProofThumbnailGrid,
  QueueStateBadge,
  TagPill,
  formatFriendlyDate,
  scopeToken,
  stateTone,
} from "./ProjectMetaPrimitives.js";
import { ProofImageViewer } from "./ProofImageViewer.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

type SharedTab = "overview" | "story" | "progress" | "artifacts" | "tests" | "queue" | "topology";
type SliceTab = SharedTab | "story" | "tests";

const SHARED_TABS: { id: SharedTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "story", label: "Story" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
  { id: "tests", label: "Tests" },
  { id: "queue", label: "Queue" },
  { id: "topology", label: "Topology" },
];

const SLICE_TABS: { id: SliceTab; label: string }[] = [
  { id: "story", label: "Story" },
  { id: "overview", label: "Overview" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
  { id: "tests", label: "Tests" },
  { id: "queue", label: "Queue" },
  { id: "topology", label: "Topology" },
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
              ? "border-stone-900 text-stone-900"
              : "border-transparent text-on-surface-variant hover:text-stone-900",
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
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">{eyebrow}</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          {title}
        </h1>
      </header>
      <TabNav tabs={tabs} active={active} onSelect={onSelect} />
      <div role="tabpanel" data-testid="project-tab-panel">
        {children}
      </div>
    </div>
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
          <article key={row.name} className="border border-outline-variant bg-white/35 p-3 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3 border-b border-outline-variant pb-2">
              <div className="min-w-0">
                <Link
                  to="/project/slice/$sliceId"
                  params={{ sliceId: row.name }}
                  className="font-mono text-[12px] uppercase tracking-[0.12em] text-stone-900 hover:underline"
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
            <div className="mt-3 grid gap-2 font-mono text-[10px] text-stone-700 sm:grid-cols-4">
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
  if (qitemIds.length === 0) {
    return <EmptyState label="NO QITEMS" description="No queue items are indexed for this scope." variant="card" testId="scope-queue-empty" />;
  }
  return (
    <div data-testid="scope-queue-rollup">
      {isFetching ? (
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">
          Loading queue bodies...
        </div>
      ) : null}
      <ul className="divide-y divide-outline-variant border border-outline-variant">
        {qitemIds.map((qitemId) => {
          const item = queueItemsById.get(qitemId);
          return (
            <li key={qitemId} className="bg-white/35 backdrop-blur-sm">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`scope-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-white/55"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {item?.state ? <QueueStateBadge state={item.state} compact /> : <EventBadge kind="queue.item" compact />}
                  <DateChip value={item?.tsCreated} />
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-stone-900">
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
          <article key={row.name} className="border border-outline-variant bg-white/35 p-3 backdrop-blur-sm">
            <Link
              to="/project/slice/$sliceId"
              params={{ sliceId: row.name }}
              className="font-mono text-[12px] uppercase tracking-[0.12em] text-stone-900 hover:underline"
            >
              {row.displayName}
            </Link>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ProjectPill token={scopeToken("slice")} compact />
              <ProjectPill token={{ label: row.status, tone: stateTone(row.status) }} compact />
            </div>
            <div className="mt-3 grid gap-2 font-mono text-[10px] text-stone-700 sm:grid-cols-4">
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

function ScopeStoryRollup({
  rows,
  detailsByName,
  queueItemsById,
  isFetching,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  queueItemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
}) {
  const rowByName = useMemo(() => new Map(rows.map((row) => [row.name, row])), [rows]);
  const events = useMemo(() => {
    return Array.from(detailsByName.values()).flatMap((detail) => {
      const row = rowByName.get(detail.name);
      const sliceLabel = row?.displayName ?? detail.displayName ?? detail.name;
      return storyEventsForDetail(detail).map((event) => ({
        ...event,
        detail: {
          ...(event.detail ?? {}),
          sliceLabel,
          sliceName: detail.name,
        },
      }));
    });
  }, [detailsByName, rowByName]);

  if (isFetching && events.length === 0) {
    return <PlaceholderTab label="LOADING STORY" description="Reading scoped story events." />;
  }
  if (events.length === 0) {
    return <EmptyState label="NO STORY EVENTS" description="No story events are indexed for this scope." variant="card" testId="scope-story-empty" />;
  }
  return (
    <div data-testid="scope-story-rollup">
      <StoryTab events={events} phaseDefinitions={null} queueItemsById={queueItemsById} />
    </div>
  );
}

function storyEventsForDetail(detail: SliceDetail) {
  const qitemIds = new Set(detail.qitemIds);
  return detail.story.events.filter((event) => !event.qitemId || qitemIds.has(event.qitemId));
}

function ScopeTestsRollup({
  rows,
  detailsByName,
  isFetching,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  isFetching: boolean;
}) {
  const [selected, setSelected] = useState<{ sliceName: string; relPath: string } | null>(null);
  const rowsWithDetails = rows.map((row) => ({ row, detail: detailsByName.get(row.name) }));
  const proofRows = rowsWithDetails.filter(({ detail }) => detail && detail.tests.proofPackets.length > 0);

  if (isFetching && detailsByName.size === 0) {
    return <PlaceholderTab label="LOADING TESTS" description="Reading scoped proof packets." />;
  }
  if (proofRows.length === 0) {
    return <EmptyState label="NO PROOF PACKETS" description="No proof evidence is indexed for this scope." variant="card" testId="scope-tests-empty" />;
  }

  return (
    <div data-testid="scope-tests-rollup" className="space-y-3">
      {proofRows.map(({ row, detail }) => {
        if (!detail) return null;
        const screenshotCount = detail.tests.proofPackets.reduce((count, packet) => count + packet.screenshots.length, 0);
        return (
          <article key={row.name} className="border border-outline-variant bg-white/35 p-3 backdrop-blur-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-outline-variant pb-2">
              <div className="min-w-0">
                <Link
                  to="/project/slice/$sliceId"
                  params={{ sliceId: row.name }}
                  className="font-mono text-[12px] uppercase tracking-[0.12em] text-stone-900 hover:underline"
                >
                  {row.displayName}
                </Link>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ProjectPill token={scopeToken("slice")} compact />
                  <ProjectPill token={{ label: `${detail.tests.proofPackets.length} packets`, tone: "info" }} compact />
                  <ProjectPill token={{ label: `${screenshotCount} screenshots`, tone: "success" }} compact />
                </div>
              </div>
              <DateChip value={row.lastActivityAt} />
            </div>
            <div className="mt-3 space-y-3">
              {detail.tests.proofPackets.map((packet) => (
                <div key={packet.dirName} className="border border-outline-variant bg-white/30 p-2 backdrop-blur-sm">
                  <ProofPacketHeader title={packet.dirName} badge={packet.passFailBadge} />
                  {packet.primaryMarkdown?.content ? (
                    <p className="mt-2 line-clamp-3 font-mono text-[10px] leading-relaxed text-stone-700">
                      {packet.primaryMarkdown.content}
                    </p>
                  ) : null}
                  {packet.screenshots.length > 0 ? (
                    <div className="mt-2">
                      <ProofThumbnailGrid
                        sliceName={detail.name}
                        screenshots={packet.screenshots}
                        onSelect={(relPath) => setSelected({ sliceName: detail.name, relPath })}
                        testIdPrefix={`scope-proof-screenshot-${detail.name}`}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </article>
        );
      })}
      <ProofImageViewer
        sliceName={selected?.sliceName ?? ""}
        relPath={selected?.relPath ?? null}
        onClose={() => setSelected(null)}
      />
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
      className="border border-outline-variant bg-white/20 px-3 py-3"
    >
      <div className="flex items-start justify-between gap-3 border-b border-outline-variant pb-2">
        <div className="min-w-0">
          <h3 className="font-mono text-[12px] uppercase tracking-[0.12em] text-stone-900 truncate">
            {mission.label}
          </h3>
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
            {mission.slices.length} slice{mission.slices.length === 1 ? "" : "s"} ·{" "}
            {formatLastActivity(latestProjectMissionActivity(mission))}
          </p>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-stone-500">
          {mission.status}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {mission.slices.map((slice) => (
          <li key={slice.name}>
            <Link
              to="/project/slice/$sliceId"
              params={{ sliceId: slice.name }}
              data-testid={`workspace-overview-slice-${slice.name}`}
              className="block px-2 py-1 font-mono text-[11px] text-on-surface hover:bg-surface-low hover:text-stone-900"
            >
              <span className="block truncate">{slice.displayName}</span>
              <span className="block truncate text-[9px] uppercase tracking-[0.12em] text-stone-500">
                {projectSliceMeta(slice)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );

  return (
    <div data-testid="workspace-overview-panel" className="grid gap-4 lg:grid-cols-2">
      <section data-testid="workspace-overview-current" className="space-y-3">
        <div className="flex items-center justify-between border-b border-outline-variant pb-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-900">
            Current Work
          </h2>
          <span className="font-mono text-[10px] text-stone-500">
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
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-900">
            Archive
          </h2>
          <span className="font-mono text-[10px] text-stone-500">
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
        <WorkspaceOverviewPanel />
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
      {active === "tests" ? (
        <ScopeTestsRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          isFetching={rollup.details.isFetching}
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
        <ScopeTopologyRollup detailsByName={rollup.details.itemsByName} />
      ) : null}
    </ScopeShell>
  );
}

export function MissionScopePage() {
  const { missionId } = useParams({ from: "/project/mission/$missionId" });
  const [active, setActive] = useState<SharedTab>("overview");
  const rollup = useProjectScopeRollup(missionId, active !== "overview");
  return (
    <ScopeShell
      eyebrow="Mission"
      title={missionId}
      tabs={SHARED_TABS}
      active={active}
      onSelect={(id) => setActive(id as SharedTab)}
    >
      {active === "overview" ? (
        <div data-testid="mission-overview-panel" className="space-y-3">
          {rollup.rows.length > 0 ? (
            rollup.rows.map((slice) => (
              <article key={slice.name} className="border border-outline-variant bg-white/35 p-3 backdrop-blur-sm">
                <Link
                  to="/project/slice/$sliceId"
                  params={{ sliceId: slice.name }}
                  className="font-mono text-[12px] uppercase tracking-[0.12em] text-stone-900 hover:underline"
                >
                  {slice.displayName}
                </Link>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ProjectPill token={scopeToken("slice")} compact />
                  <ProjectPill token={{ label: slice.status, tone: stateTone(slice.status) }} compact />
                  <DateChip value={slice.lastActivityAt} />
                </div>
                <div className="mt-2 grid gap-2 font-mono text-[10px] text-stone-700 sm:grid-cols-4">
                  <SliceMetric label="Status" value={slice.status} />
                  <SliceMetric label="Qitems" value={slice.qitemCount} />
                  <SliceMetric label="Proof" value={slice.hasProofPacket ? "yes" : "no"} />
                  <SliceMetric label="Last activity" value={formatMaybeDate(slice.lastActivityAt)} />
                </div>
              </article>
            ))
          ) : (
            <EmptyState
              label="NO SLICES"
              description="No indexed slices are attached to this mission."
              variant="card"
              testId="mission-overview-empty"
            />
          )}
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
        <ScopeProgressRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          isLoading={rollup.list.isLoading || rollup.details.isFetching}
        />
      ) : null}
      {active === "artifacts" ? (
        <ScopeArtifactsRollup rows={rollup.rows} detailsByName={rollup.details.itemsByName} />
      ) : null}
      {active === "tests" ? (
        <ScopeTestsRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          isFetching={rollup.details.isFetching}
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
        <ScopeTopologyRollup detailsByName={rollup.details.itemsByName} />
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
          className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400"
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
            <li key={qitemId} className="bg-white/35 backdrop-blur-sm">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`slice-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left hover:bg-white/55 transition-colors font-mono text-xs"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {item?.state ? <QueueStateBadge state={item.state} compact /> : <EventBadge kind="queue.item" compact />}
                  <DateChip value={item?.tsCreated} />
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-stone-900">
                  {queueBodyPreview(qitemId, item)}
                </span>
                {item ? (
                  <span
                    data-testid={`slice-queue-meta-${qitemId}`}
                    className="mt-2 block space-y-2 text-[10px] text-stone-500"
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
    <div className="border border-outline-variant bg-white/35 p-3 backdrop-blur-sm">
      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold text-stone-900">{value}</div>
    </div>
  );
}

function SliceArtifactsTab({ detail }: { detail: SliceDetail }) {
  const docsTree = detail.docs.tree;
  const proofPackets = detail.tests.proofPackets;
  return (
    <div data-testid="slice-artifacts-tab" className="space-y-6">
      <section data-testid="slice-artifacts-files" className="border border-outline-variant bg-white/20 p-4">
        <SectionHeader tone="muted">Files</SectionHeader>
        {docsTree.length > 0 ? (
          <ul className="mt-3 divide-y divide-outline-variant border border-outline-variant bg-white/30">
            {docsTree.map((entry) => (
              <li key={entry.relPath} className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 font-mono text-[10px]">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-stone-900">
                  <ToolMark tool={entry.relPath} size="xs" />
                  <span className="truncate">{entry.relPath}</span>
                </span>
                <span className="uppercase tracking-[0.10em] text-stone-500">{entry.type}</span>
                <span className="text-stone-400">{entry.size == null ? "-" : `${entry.size}b`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-stone-400">No slice files indexed.</div>
        )}
      </section>

      <section data-testid="slice-artifacts-commits" className="border border-outline-variant bg-white/20 p-4">
        <SectionHeader tone="muted">Commits</SectionHeader>
        {detail.commitRefs.length > 0 ? (
          <ul className="mt-3 divide-y divide-outline-variant border border-outline-variant bg-white/30">
            {detail.commitRefs.map((commitRef) => (
              <li key={commitRef} className="px-3 py-2 font-mono text-[10px] text-stone-900">
                {commitRef}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-stone-400">No commit refs indexed for this slice.</div>
        )}
      </section>

      <section data-testid="slice-artifacts-proof" className="border border-outline-variant bg-white/20 p-4">
        <SectionHeader tone="muted">Proof Packets</SectionHeader>
        {proofPackets.length > 0 ? (
          <ul className="mt-3 divide-y divide-outline-variant border border-outline-variant bg-white/30">
            {proofPackets.map((packet) => (
              <li key={packet.dirName} className="px-3 py-2 font-mono text-[10px] text-stone-700">
                <ProofPacketHeader title={packet.dirName} badge={packet.passFailBadge} />
                <div className="mt-1 text-stone-400">
                  {packet.screenshots.length} screenshots / {packet.videos.length} videos / {packet.traces.length} traces
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-stone-400">No proof packets indexed.</div>
        )}
      </section>

      <section data-testid="slice-artifacts-docs">
        <SectionHeader tone="muted">Docs Browser</SectionHeader>
        <div className="mt-2 border border-outline-variant">
          <DocsTab sliceName={detail.name} tree={docsTree} />
        </div>
      </section>

      <section data-testid="slice-artifacts-decisions">
        <SectionHeader tone="muted">Decisions</SectionHeader>
        <div className="mt-2 border border-outline-variant">
          <DecisionsTab rows={detail.decisions.rows} />
        </div>
      </section>
    </div>
  );
}

function SliceOverviewTab({ detail }: { detail: SliceDetail }) {
  const currentStep = detail.acceptance.currentStep;
  const primaryDocs = detail.docs.tree.filter((entry) =>
    entry.type === "file" && /(^|\/)(README|IMPLEMENTATION-PRD|PROGRESS)\.md$/i.test(entry.relPath),
  );

  return (
    <div data-testid="slice-overview-tab" className="space-y-6">
      <section data-testid="slice-overview-summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SliceMetric label="Status" value={detail.status} />
        <SliceMetric label="Progress" value={`${detail.acceptance.percentage}%`} />
        <SliceMetric label="Qitems" value={detail.qitemIds.length} />
        <SliceMetric label="Last Activity" value={formatMaybeDate(detail.lastActivityAt)} />
      </section>

      <section data-testid="slice-overview-current-step" className="border border-outline-variant bg-white/20 p-4">
        <SectionHeader tone="muted">Current Step</SectionHeader>
        {currentStep ? (
          <div className="mt-3 grid gap-2 font-mono text-[10px] text-stone-700 sm:grid-cols-2">
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-stone-400">Step</div>
              <div className="font-bold text-stone-900">{currentStep.stepId}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-stone-400">Role</div>
              <div className="font-bold text-stone-900">{currentStep.role}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-[8px] uppercase tracking-[0.14em] text-stone-400">Objective</div>
              <div>{currentStep.objective ?? "No objective declared."}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-stone-400">Allowed exits</div>
              <div>{currentStep.allowedExits.join(", ") || "-"}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-stone-400">Hop count</div>
              <div>{currentStep.hopCount}</div>
            </div>
          </div>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-stone-400">No workflow step is currently bound.</div>
        )}
      </section>

      <section data-testid="slice-overview-readiness" className="border border-outline-variant bg-white/20 p-4">
        <SectionHeader tone="muted">Readiness</SectionHeader>
        <div className="mt-3 space-y-2 font-mono text-[10px] text-stone-700">
          <div>{detail.acceptance.doneItems} of {detail.acceptance.totalItems} acceptance items complete.</div>
          <div>{detail.tests.aggregate.passCount} proof packets passing / {detail.tests.aggregate.failCount} failing.</div>
          {detail.acceptance.closureCallout && (
            <div className="border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
              {detail.acceptance.closureCallout}
            </div>
          )}
          {detail.workflowBinding && (
            <div className="text-stone-500">
              Workflow: {detail.workflowBinding.workflowName} v{detail.workflowBinding.workflowVersion}
            </div>
          )}
        </div>
      </section>

      <section data-testid="slice-overview-docs" className="border border-outline-variant bg-white/20 p-4">
        <SectionHeader tone="muted">Primary Docs</SectionHeader>
        {primaryDocs.length > 0 ? (
          <ul className="mt-3 divide-y divide-outline-variant border border-outline-variant bg-white/30">
            {primaryDocs.map((entry) => (
              <li key={entry.relPath} className="px-3 py-2 font-mono text-[10px] text-stone-900">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <ToolMark tool={entry.relPath} size="xs" />
                  <span className="truncate">{entry.relPath}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-stone-400">No README, implementation PRD, or progress file indexed.</div>
        )}
      </section>
    </div>
  );
}

export function SliceScopePage() {
  const { sliceId } = useParams({ from: "/project/slice/$sliceId" });
  const [active, setActive] = useState<SliceTab>("story");
  const detailQuery = useSliceDetail(sliceId);
  const queueItems = useQueueItemMap(detailQuery.data?.qitemIds ?? []);
  const queueItemsById = useMemo(() => queueItems.itemsById, [queueItems.itemsById]);

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

  return (
    <ScopeShell
      eyebrow="Slice"
      title={detail.displayName || detail.name}
      tabs={SLICE_TABS}
      active={active}
      onSelect={(id) => setActive(id as SliceTab)}
    >
      {active === "story" ? (
        <StoryTab
          events={storyEventsForDetail(detail)}
          phaseDefinitions={detail.story.phaseDefinitions}
          queueItemsById={queueItemsById}
        />
      ) : null}
      {active === "overview" ? (
        <SliceOverviewTab detail={detail} />
      ) : null}
      {active === "progress" ? (
        // FOLDED: AcceptanceTab content. Acceptance is the canonical "progress"
        // proof at slice scope per project-tree.md L65 (acceptance items from
        // IMPLEMENTATION-PRD with current state).
        <AcceptanceTab acceptance={detail.acceptance} />
      ) : null}
      {active === "artifacts" ? (
        <SliceArtifactsTab detail={detail} />
      ) : null}
      {active === "tests" ? (
        <TestsVerificationTab
          sliceName={detail.name}
          tests={detail.tests}
          qitemCount={detail.qitemIds.length}
          docsCount={detail.docs.tree.length}
          lastActivityAt={detail.lastActivityAt}
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
