// Slice Story View v0 - explorer-column slice picker.
//
// The AppShell already owns the left explorer column. This component supplies
// the Slices-specific explorer content so the route detail pane does not create
// a second sidebar under the topology explorer.

import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSlices, type SliceFilter, type SliceListEntry, type SliceListResponse, type SlicesUnavailable } from "../../hooks/useSlices.js";
import { useActiveLens, clearActiveLens } from "../../hooks/useSpecLibrary.js";

const FILTERS: SliceFilter[] = ["all", "active", "done", "blocked"];

function isUnavailable(data: SliceListResponse | SlicesUnavailable | undefined): data is SlicesUnavailable {
  return Boolean(data && "unavailable" in data);
}

export function SliceExplorerPanel({ onNavigate = () => {} }: { onNavigate?: () => void }) {
  const params = useParams({ strict: false }) as { name?: string };
  const selectedName = params.name ?? null;
  const [filter, setFilter] = useState<SliceFilter>("active");
  const [showAll, setShowAll] = useState(false);
  const queryClient = useQueryClient();
  const { data: activeLens } = useActiveLens();
  const lensActive = !!activeLens && !showAll;
  const list = useSlices(
    filter,
    lensActive ? { specName: activeLens!.specName, specVersion: activeLens!.specVersion } : null,
  );

  const onClearLens = async () => {
    await clearActiveLens();
    await queryClient.invalidateQueries({ queryKey: ["spec-library", "active-lens"] });
    await queryClient.invalidateQueries({ queryKey: ["slices"] });
  };

  return (
    <div data-testid="slice-list-pane" className="flex h-full flex-col">
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
        {activeLens && (
          <div
            data-testid="slice-lens-indicator"
            className="mt-2 border border-stone-300 bg-stone-50 px-2 py-1 font-mono text-[9px] text-stone-700 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="truncate">
                Lens: {activeLens.specName} v{activeLens.specVersion}
              </span>
              <button
                type="button"
                data-testid="slice-lens-clear"
                onClick={() => void onClearLens()}
                className="ml-2 shrink-0 border border-stone-300 px-1 py-0.5 text-[8px] uppercase tracking-[0.10em] text-stone-600 hover:bg-stone-200"
              >
                Clear
              </button>
            </div>
            <button
              type="button"
              data-testid="slice-lens-show-all-toggle"
              onClick={() => setShowAll((v) => !v)}
              className="w-full border border-stone-300 px-1 py-0.5 text-[8px] uppercase tracking-[0.10em] text-stone-600 hover:bg-stone-200"
            >
              {showAll ? "Apply Lens Filter" : "Show All Slices"}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" data-testid="slice-list">
        {list.isLoading && <div className="p-3 font-mono text-[10px] text-stone-400">Loading...</div>}
        {list.isError && <div className="p-3 font-mono text-[10px] text-red-600">Error loading slices.</div>}
        {isUnavailable(list.data) && (
          <div className="p-3 font-mono text-[10px] text-stone-500" data-testid="slice-list-unavailable">
            <div>Slices indexer unavailable.</div>
            {list.data.hint && <div className="mt-1 text-stone-400">{list.data.hint}</div>}
          </div>
        )}
        {!isUnavailable(list.data) && list.data && list.data.slices.length === 0 && (
          <div className="p-3 font-mono text-[10px] text-stone-400" data-testid="slice-list-empty">
            {lensActive
              ? `No slices bound to ${activeLens?.specName} v${activeLens?.specVersion}.`
              : "No slices match."}
          </div>
        )}
        {!isUnavailable(list.data) && list.data && list.data.slices.map((slice) => (
          <SliceListRow
            key={slice.name}
            slice={slice}
            selected={slice.name === selectedName}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

function SliceListRow({
  slice,
  selected,
  onNavigate,
}: {
  slice: SliceListEntry;
  selected: boolean;
  onNavigate: () => void;
}) {
  const statusGlyph = slice.status === "done"
    ? "D"
    : slice.status === "blocked"
      ? "!"
      : slice.status === "draft"
        ? "."
        : "o";
  const ageDays = slice.lastActivityAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(slice.lastActivityAt)) / 86_400_000))
    : null;

  return (
    <Link
      to="/slices/$name"
      params={{ name: slice.name }}
      onClick={onNavigate}
      data-testid={`slice-row-${slice.name}`}
      data-selected={selected}
      className={`block border-b border-stone-100 px-3 py-2 text-left transition-colors hover:bg-stone-100 ${selected ? "bg-stone-200/80" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-stone-500" aria-label={`status ${slice.status}`}>{statusGlyph}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold text-stone-900">{slice.name}</span>
        {slice.railItem && (
          <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-stone-500">{slice.railItem}</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[8px] text-stone-400">
        <span>{slice.qitemCount} qitems</span>
        {slice.hasProofPacket && <span data-testid={`slice-row-${slice.name}-proof`}>- proof</span>}
        {ageDays !== null && <span>- {ageDays}d</span>}
      </div>
    </Link>
  );
}
