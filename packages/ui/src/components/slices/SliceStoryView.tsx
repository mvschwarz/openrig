// Slice Story View v0 — top-level surface.
//
// The AppShell explorer column owns slice filtering and selection while this
// route owns the six detail tabs for the selected slice.

import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useSliceDetail } from "../../hooks/useSlices.js";
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

export function SliceStoryView() {
  // Optional slice name from URL params; null when on bare /slices.
  const params = useParams({ strict: false }) as { name?: string };
  const selectedName = params.name ?? null;
  const [activeTab, setActiveTab] = useState<SliceTabName>("story");

  // Reset to story when slice changes.
  useEffect(() => {
    setActiveTab("story");
  }, [selectedName]);

  const detail = useSliceDetail(selectedName);

  return (
    <div
      data-testid="slice-story-view"
      className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <main data-testid="slice-detail-pane" className="flex-1 min-w-0 flex flex-col">
        {!selectedName && (
          <div className="m-auto font-mono text-[10px] uppercase tracking-[0.18em] text-stone-400" data-testid="slice-no-selection">
            Pick a slice from the explorer
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
