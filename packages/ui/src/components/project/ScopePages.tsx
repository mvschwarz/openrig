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
import { FilesWorkspace } from "../files/FilesWorkspace.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import {
  useQueueItemMap,
  useSliceDetail,
  type QueueItemDetail,
  type SliceDetail,
} from "../../hooks/useSlices.js";
import { StoryTab } from "../slices/tabs/StoryTab.js";
import { AcceptanceTab } from "../slices/tabs/AcceptanceTab.js";
import { DocsTab } from "../slices/tabs/DocsTab.js";
import { DecisionsTab } from "../slices/tabs/DecisionsTab.js";
import { TestsVerificationTab } from "../slices/tabs/TestsVerificationTab.js";
import { TopologyTab } from "../slices/tabs/TopologyTab.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";

type SharedTab = "overview" | "progress" | "artifacts" | "queue" | "topology";
type SliceTab = SharedTab | "story" | "tests";

const SHARED_TABS: { id: SharedTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
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

export function WorkspaceScopePage() {
  const [active, setActive] = useState<SharedTab>("overview");
  const workspace = useWorkspaceName();

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
        <PlaceholderTab label="WORKSPACE OVERVIEW" description="Renders STEERING.md (root attractor) + summary of missions in flight." />
      ) : null}
      {active === "progress" ? (
        <PlaceholderTab label="WORKSPACE PROGRESS" description="Cross-mission rollup." />
      ) : null}
      {active === "artifacts" ? <FilesWorkspace /> : null}
      {active === "queue" ? (
        <PlaceholderTab label="WORKSPACE QUEUE" description="All qitems across all rigs in this workspace." />
      ) : null}
      {active === "topology" ? (
        <PlaceholderTab label="WORKSPACE TOPOLOGY" description="Full env topology, scoped to this workspace." />
      ) : null}
    </ScopeShell>
  );
}

export function MissionScopePage() {
  const { missionId } = useParams({ from: "/project/mission/$missionId" });
  const [active, setActive] = useState<SharedTab>("overview");
  return (
    <ScopeShell
      eyebrow="Mission"
      title={missionId}
      tabs={SHARED_TABS}
      active={active}
      onSelect={(id) => setActive(id as SharedTab)}
    >
      <PlaceholderTab label={`MISSION ${active.toUpperCase()}`} description="Mission-scoped view; Phase 5 polish." />
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
            <li key={qitemId} className="bg-white/20">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`slice-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left hover:bg-stone-100/60 transition-colors font-mono text-xs"
              >
                <span className="block whitespace-pre-wrap break-words text-stone-900">
                  {queueBodyPreview(qitemId, item)}
                </span>
                {item ? (
                  <span
                    data-testid={`slice-queue-meta-${qitemId}`}
                    className="mt-1 block text-[10px] text-stone-500"
                  >
                    {qitemId}
                    {" / "}
                    {item.sourceSession} -&gt; {item.destinationSession}
                    {" / "}
                    {item.state}
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
  if (!ts) return "unknown";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function SliceMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-outline-variant bg-white/30 p-3">
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
                <span className="truncate text-stone-900">{entry.relPath}</span>
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
                <div className="font-bold text-stone-900">{packet.dirName}</div>
                <div className="mt-1 uppercase tracking-[0.10em] text-stone-500">{packet.passFailBadge}</div>
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
                {entry.relPath}
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
              : `Could not load slice "${sliceId}". The slices indexer may not be configured (rig config get workspace.slicesRoot).`
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
          events={detail.story.events}
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
