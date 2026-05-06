// V1 attempt-3 Phase 3 — Project scope pages per project-tree.md L46–L49 + SC-24.
//
// workspace = overview/progress/artifacts/queue/topology (5 tabs)
// mission = same 5 tabs
// slice = +story +tests = 7 tabs
//
// Phase 3 V1 implements the tab nav structure; tab content uses existing
// pages where mountable + EmptyState placeholders for Phase 5 polish.

import { useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { FilesWorkspace } from "../files/FilesWorkspace.js";

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
  return (
    <ScopeShell
      eyebrow="Workspace"
      title="openrig-work"
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

export function SliceScopePage() {
  const { sliceId } = useParams({ from: "/project/slice/$sliceId" });
  const [active, setActive] = useState<SliceTab>("story");
  return (
    <ScopeShell
      eyebrow="Slice"
      title={sliceId}
      tabs={SLICE_TABS}
      active={active}
      onSelect={(id) => setActive(id as SliceTab)}
    >
      {/* Slice tabs from prior shell take rich slice-detail data as props
          (StoryTab needs events+phaseDefinitions, TestsVerificationTab
          needs tests, TopologyTab needs topology) — re-mount with data
          piping is Phase 5 polish. Phase 3 V1 renders a placeholder per
          tab. */}
      <PlaceholderTab
        label={`SLICE ${active.toUpperCase()}`}
        description={`${active === "story" ? "Slice timeline narrative" : active === "tests" ? "Test/verification proof packets" : active === "topology" ? "Tabular agents on slice" : "Slice scope tab"} — Phase 5 wires existing tab component with slice-detail data piping.`}
      />
    </ScopeShell>
  );
}
