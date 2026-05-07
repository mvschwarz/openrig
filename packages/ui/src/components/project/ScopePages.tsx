// V1 attempt-3 Phase 3 — Project scope pages per project-tree.md L46–L49 + SC-24.
//
// workspace = overview/progress/artifacts/queue/topology (5 tabs)
// mission = same 5 tabs
// slice = +story +tests = 7 tabs
//
// V1 attempt-3 Phase 5 P5-2: SliceScopePage tab content piping.
// Per code-map AFTER tree fold mapping (founder-approved at Phase 5 dispatch):
//   - StoryTab → story tab (preserved; events + phaseDefinitions props)
//   - TestsVerificationTab → tests tab (preserved; tests prop)
//   - TopologyTab → topology tab (preserved; topology prop)
//   - AcceptanceTab → progress tab (FOLDED; canon-7 progress is acceptance + currentStep)
//   - DocsTab + DecisionsTab → artifacts tab (FOLDED vertically; canon-7 artifacts is docs+decisions)
//   - Overview tab → README/IMPLEMENTATION-PRD via DocsTab pre-selected for now
//   - Queue tab → qitemIds list with QueueItemTrigger (P5-1 wiring) per content-drawer.md L26
// Workspace + Mission scope tab piping remains Phase 5 polish (filesystem-walk
// dependent; P5-5 lays the data layer).

import { useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { FilesWorkspace } from "../files/FilesWorkspace.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import { useSliceDetail } from "../../hooks/useSlices.js";
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

function SliceQueueTab({ qitemIds }: { qitemIds: string[] }) {
  // V1 attempt-3 Phase 5 P5-2: slice queue tab. Each qitem id is wrapped in
  // QueueItemTrigger (P5-1 trigger primitive) — clicking opens the
  // QueueItemViewer in the drawer. Full qitem payload (source/dest/state/
  // tags/body) is supplied by QueueItemViewer's empty-state when richer
  // metadata isn't available; richer per-qitem fetch wiring is Phase 5
  // polish if founder feedback requests it.
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
    <ul data-testid="slice-queue-list" className="divide-y divide-outline-variant border border-outline-variant">
      {qitemIds.map((qitemId) => (
        <li key={qitemId}>
          <QueueItemTrigger
            data={{ qitemId }}
            testId={`slice-queue-trigger-${qitemId}`}
            className="block w-full px-3 py-2 text-left hover:bg-stone-100/60 transition-colors font-mono text-xs"
          >
            <span className="text-stone-900 break-all underline decoration-dotted decoration-stone-400">
              {qitemId}
            </span>
          </QueueItemTrigger>
        </li>
      ))}
    </ul>
  );
}

function SliceArtifactsTab({
  sliceName,
  docsTree,
  decisionsRows,
}: {
  sliceName: string;
  docsTree: import("../../hooks/useSlices.js").DocsTreeEntry[];
  decisionsRows: import("../../hooks/useSlices.js").DecisionRow[];
}) {
  // FOLDED per code-map AFTER tree: canonical artifacts tab combines
  // DocsTab (slice docs tree + lazy markdown viewer) + DecisionsTab
  // (operator-driven decision-log timeline). Vertical sections so each
  // sub-tool is fully visible without nested tabs.
  return (
    <div data-testid="slice-artifacts-tab" className="space-y-6">
      <section data-testid="slice-artifacts-docs">
        <SectionHeader tone="muted">Docs</SectionHeader>
        <div className="mt-2 border border-outline-variant">
          <DocsTab sliceName={sliceName} tree={docsTree} />
        </div>
      </section>
      <section data-testid="slice-artifacts-decisions">
        <SectionHeader tone="muted">Decisions</SectionHeader>
        <div className="mt-2 border border-outline-variant">
          <DecisionsTab rows={decisionsRows} />
        </div>
      </section>
    </div>
  );
}

function SliceOverviewTab({
  sliceName,
  docsTree,
}: {
  sliceName: string;
  docsTree: import("../../hooks/useSlices.js").DocsTreeEntry[];
}) {
  // Per project-tree.md L57-L59: slice overview renders README.md /
  // IMPLEMENTATION-PRD.md with steering section. DocsTab already
  // pre-selects README.md (or IMPLEMENTATION-PRD.md as fallback) on
  // mount (StoryTab.tsx-equivalent initial selection). Reuses DocsTab
  // for consistency; bigger overview shape is V2.
  return (
    <div data-testid="slice-overview-tab" className="border border-outline-variant">
      <DocsTab sliceName={sliceName} tree={docsTree} />
    </div>
  );
}

export function SliceScopePage() {
  const { sliceId } = useParams({ from: "/project/slice/$sliceId" });
  const [active, setActive] = useState<SliceTab>("story");
  const detailQuery = useSliceDetail(sliceId);

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
        <StoryTab events={detail.story.events} phaseDefinitions={detail.story.phaseDefinitions} />
      ) : null}
      {active === "overview" ? (
        <SliceOverviewTab sliceName={detail.name} docsTree={detail.docs.tree} />
      ) : null}
      {active === "progress" ? (
        // FOLDED: AcceptanceTab content. Acceptance is the canonical "progress"
        // proof at slice scope per project-tree.md L65 (acceptance items from
        // IMPLEMENTATION-PRD with current state).
        <AcceptanceTab acceptance={detail.acceptance} />
      ) : null}
      {active === "artifacts" ? (
        <SliceArtifactsTab
          sliceName={detail.name}
          docsTree={detail.docs.tree}
          decisionsRows={detail.decisions.rows}
        />
      ) : null}
      {active === "tests" ? (
        <TestsVerificationTab sliceName={detail.name} tests={detail.tests} />
      ) : null}
      {active === "queue" ? <SliceQueueTab qitemIds={detail.qitemIds} /> : null}
      {active === "topology" ? <TopologyTab topology={detail.topology} /> : null}
    </ScopeShell>
  );
}
