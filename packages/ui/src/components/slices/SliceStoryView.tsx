// Slice Story View v0 — top-level surface.
//
// Two-pane layout:
//   - Left: filter row (All / Active / Done / Blocked) + slice list
//   - Right: six tabs (Story, Acceptance, Decisions, Docs,
//     Tests/Verification, Topology) for the selected slice.
//
// PRD wording uses "left-panel Slices sidebar tab"; the existing AppShell
// has only a single left sidebar (Explorer) with no tab system, so v0
// implements the slice list as the left half of the route's own internal
// layout. AppShell gets a header navigation entry that links here. The
// operator's mental model is the same — click "Slices" in the chrome,
// pick a slice, see all six tabs.

import { useEffect, useState } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useSlices, useSliceDetail, type SliceFilter, type SliceListEntry, type SliceListResponse, type SlicesUnavailable } from "../../hooks/useSlices.js";
import { StoryTab } from "./tabs/StoryTab.js";
import { AcceptanceTab } from "./tabs/AcceptanceTab.js";
import { DecisionsTab } from "./tabs/DecisionsTab.js";
import { DocsTab } from "./tabs/DocsTab.js";
import { TestsVerificationTab } from "./tabs/TestsVerificationTab.js";
import { TopologyTab } from "./tabs/TopologyTab.js";

export const SLICE_TABS = ["story", "acceptance", "decisions", "docs", "tests", "topology"] as const;
export type SliceTabName = typeof SLICE_TABS[number];

const TAB_LABELS: Record<SliceTabName, string> = {
  story: "Story",
  acceptance: "Acceptance",
  decisions: "Decisions",
  docs: "Docs",
  tests: "Tests / Verification",
  topology: "Topology",
};

const FILTERS: SliceFilter[] = ["all", "active", "done", "blocked"];

function isUnavailable(data: SliceListResponse | SlicesUnavailable | undefined): data is SlicesUnavailable {
  return Boolean(data && "unavailable" in data);
}

export function SliceStoryView() {
  // Optional slice name from URL params; null when on bare /slices.
  const params = useParams({ strict: false }) as { name?: string };
  const selectedName = params.name ?? null;
  const [filter, setFilter] = useState<SliceFilter>("active");
  const [activeTab, setActiveTab] = useState<SliceTabName>("story");

  // Reset to story when slice changes.
  useEffect(() => {
    setActiveTab("story");
  }, [selectedName]);

  const list = useSlices(filter);
  const detail = useSliceDetail(selectedName);

  return (
    <div data-testid="slice-story-view" className="flex h-full">
      <aside
        data-testid="slice-list-pane"
        className="w-72 shrink-0 border-r border-stone-200 bg-stone-50 flex flex-col"
      >
        <div className="border-b border-stone-200 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Slices</div>
          <div className="mt-2 flex gap-1" data-testid="slice-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                data-testid={`slice-filter-${f}`}
                data-active={filter === f}
                onClick={() => setFilter(f)}
                className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
                  filter === f
                    ? "border-stone-700 bg-stone-700 text-white"
                    : "border-stone-300 text-stone-700 hover:bg-stone-100"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="slice-list">
          {list.isLoading && <div className="p-3 font-mono text-[10px] text-stone-400">Loading…</div>}
          {list.isError && <div className="p-3 font-mono text-[10px] text-red-600">Error loading slices.</div>}
          {isUnavailable(list.data) && (
            <div className="p-3 font-mono text-[10px] text-stone-500" data-testid="slice-list-unavailable">
              <div>Slices indexer unavailable.</div>
              {list.data.hint && <div className="mt-1 text-stone-400">{list.data.hint}</div>}
            </div>
          )}
          {!isUnavailable(list.data) && list.data && list.data.slices.length === 0 && (
            <div className="p-3 font-mono text-[10px] text-stone-400">No slices match.</div>
          )}
          {!isUnavailable(list.data) && list.data && list.data.slices.map((slice) => (
            <SliceListRow key={slice.name} slice={slice} selected={slice.name === selectedName} />
          ))}
        </div>
      </aside>
      <main data-testid="slice-detail-pane" className="flex-1 min-w-0 flex flex-col">
        {!selectedName && (
          <div className="m-auto font-mono text-[10px] uppercase tracking-[0.18em] text-stone-400" data-testid="slice-no-selection">
            Pick a slice from the list
          </div>
        )}
        {selectedName && detail.isLoading && (
          <div className="m-auto font-mono text-[10px] text-stone-400">Loading slice…</div>
        )}
        {selectedName && detail.isError && (
          <div className="m-auto font-mono text-[10px] text-red-600">Error loading slice.</div>
        )}
        {selectedName && detail.data && (
          <>
            <header className="border-b border-stone-200 bg-stone-50 px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
                {detail.data.railItem ?? "slice"}
                {" · "}
                {detail.data.rawStatus ?? detail.data.status}
              </div>
              <h1 className="font-headline text-xl font-bold tracking-tight text-stone-900">
                {detail.data.displayName}
              </h1>
              <nav data-testid="slice-tab-nav" className="mt-2 flex flex-wrap gap-1">
                {SLICE_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    data-testid={`slice-tab-${tab}`}
                    data-active={activeTab === tab}
                    onClick={() => setActiveTab(tab)}
                    className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
                      activeTab === tab
                        ? "border-stone-700 bg-stone-700 text-white"
                        : "border-stone-300 text-stone-700 hover:bg-stone-100"
                    }`}
                  >
                    {TAB_LABELS[tab]}
                  </button>
                ))}
              </nav>
            </header>
            <section data-testid={`slice-tab-content-${activeTab}`} className="flex-1 min-h-0 overflow-y-auto">
              {activeTab === "story" && <StoryTab events={detail.data.story.events} />}
              {activeTab === "acceptance" && <AcceptanceTab acceptance={detail.data.acceptance} />}
              {activeTab === "decisions" && <DecisionsTab rows={detail.data.decisions.rows} />}
              {activeTab === "docs" && <DocsTab sliceName={detail.data.name} tree={detail.data.docs.tree} />}
              {activeTab === "tests" && <TestsVerificationTab sliceName={detail.data.name} tests={detail.data.tests} />}
              {activeTab === "topology" && <TopologyTab topology={detail.data.topology} />}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SliceListRow({ slice, selected }: { slice: SliceListEntry; selected: boolean }) {
  const statusGlyph = slice.status === "done"
    ? "✓"
    : slice.status === "blocked"
      ? "⚠"
      : slice.status === "draft"
        ? "·"
        : "◯";
  const ageDays = slice.lastActivityAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(slice.lastActivityAt)) / 86_400_000))
    : null;
  return (
    <Link
      to="/slices/$name"
      params={{ name: slice.name }}
      data-testid={`slice-row-${slice.name}`}
      data-selected={selected}
      className={`block border-b border-stone-100 px-3 py-2 text-left transition-colors hover:bg-stone-100 ${selected ? "bg-stone-200/80" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-stone-500" aria-label={`status ${slice.status}`}>{statusGlyph}</span>
        <span className="font-mono text-[10px] font-semibold text-stone-900 truncate flex-1">{slice.name}</span>
        {slice.railItem && (
          <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500">{slice.railItem}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[8px] text-stone-400">
        <span>{slice.qitemCount} qitems</span>
        {slice.hasProofPacket && <span data-testid={`slice-row-${slice.name}-proof`}>· proof</span>}
        {ageDays !== null && <span>· {ageDays}d</span>}
      </div>
    </Link>
  );
}
