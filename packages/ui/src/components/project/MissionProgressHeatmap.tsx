// V0.3.1 slice 13.5 mission-progress-artifacts-heatmap.
//
// Mission scope Progress tab differentiation: render a slice ×
// acceptance-cell heat-map ABOVE the existing PROGRESS.md markdown
// + per-slice rollup. Pre-slice 13.5, Mission Progress + Artifacts
// tabs both used the same 4-cell metric-grid primitive shape and
// looked too similar at-a-glance. The heat-map gives Progress its
// own visual gestalt without touching Artifacts.
//
// Cell semantics: one row per slice; one cell per acceptance-item
// in that slice's PROGRESS.md checklist. Filled (success token) =
// done; outline (outline-variant) = not done. Leading column is
// the slice display name + state pill; trailing column is the
// (done/total) tally + percentage.
//
// Why slice × acceptance instead of slice × phase: acceptance items
// are the durable progress unit the operator already authors per
// slice in PROGRESS.md. Phases are workflow_spec-bound and only
// some slices have them. Acceptance items work for every slice.
//
// All colors derive from existing DESIGN.md status tokens via the
// `stateTone` + `cellToneClass` mappings; no new color system.

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "../ui/empty-state.js";
import { ProjectPill } from "./ProjectMetaPrimitives.js";
import {
  type ProjectMetaTone,
  stateTone,
} from "./ProjectMetaPrimitives.js";
import type { SliceDetail } from "../../hooks/useSlices.js";
import type { SliceListEntry } from "../../hooks/useSlices.js";

/** Maps a ProjectMetaTone to a single SOLID-fill cell class. Pairs
 *  with the existing toneClass map in ProjectMetaPrimitives.tsx (which
 *  is private to that module). Heat-map cells need a denser fill than
 *  the muted-bg pill chrome — these classes lift the existing palette
 *  to a "checked checkbox" feel without inventing new tokens. */
const cellToneClass: Record<ProjectMetaTone, string> = {
  neutral: "border-stone-400 bg-stone-300",
  info: "border-sky-400 bg-sky-200",
  success: "border-emerald-500 bg-emerald-400",
  warning: "border-amber-400 bg-amber-300",
  danger: "border-rose-400 bg-rose-300",
};

/** Heat-map-local tone resolution. Wraps the shared `stateTone` but
 *  overrides for `SliceStatus` values whose canonical UI tone differs
 *  from what `stateTone` infers from generic state strings.
 *
 *  Specifically: `stateTone("active")` returns `"neutral"` (no keyword
 *  match), which would make active slices' done cells fall through to
 *  the `success` tone. That collapses the at-a-glance distinction
 *  between an in-flight active slice's done items vs a shipped done
 *  slice's done items. Override `"active"` → `"info"` so the heat-map
 *  shows the canonical SliceStatus differentiation. Other status
 *  strings flow through `stateTone` unchanged. */
function heatmapTone(status: string | undefined): ProjectMetaTone {
  if (status === "active") return "info";
  return stateTone(status);
}

/** Resolution rule used by both the heat-map cells AND the legend so
 *  the legend swatch class is always EXACTLY the same string the cell
 *  would render. Pure function of tone; no side effects. */
function doneCellClass(tone: ProjectMetaTone): string {
  return cellToneClass[tone === "neutral" ? "success" : tone];
}

interface HeatmapRow {
  /** Slice id (used for the drill-in link target). */
  name: string;
  /** Display name shown in the leading column. */
  displayName: string;
  /** Slice state ("active" | "done" | "blocked" | "draft"); drives the
   *  state pill in the leading column + the implied tone of done cells
   *  for blocked/danger slices (so a blocked slice's "done" cells read
   *  warning-tinted rather than success-tinted). */
  status: string;
  /** Acceptance items in PROGRESS.md order. May be empty when the slice
   *  hasn't authored a PROGRESS.md yet. */
  items: { text: string; done: boolean }[];
  /** Pre-computed totals shown in the trailing column. */
  doneItems: number;
  totalItems: number;
  /** Acceptance percentage (0-100), pre-computed by the daemon route. */
  percentage: number;
}

export function MissionProgressHeatmap({
  rows,
  detailsByName,
  isLoading,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  isLoading?: boolean;
}) {
  const heatmapRows: HeatmapRow[] = rows.map((row) => {
    const detail = detailsByName.get(row.name);
    const acceptance = detail?.acceptance;
    return {
      name: row.name,
      displayName: row.displayName,
      status: row.status,
      items: acceptance?.items ?? [],
      doneItems: acceptance?.doneItems ?? 0,
      totalItems: acceptance?.totalItems ?? 0,
      percentage: acceptance?.percentage ?? 0,
    };
  });

  if (isLoading && heatmapRows.length === 0) {
    return (
      <EmptyState
        label="LOADING PROGRESS"
        description="Reading mission slice acceptance."
        variant="card"
        testId="mission-progress-heatmap-loading"
      />
    );
  }

  if (heatmapRows.length === 0) {
    return (
      <EmptyState
        label="NO MISSION SLICES"
        description="Mission has no scoped slices to render a heat-map."
        variant="card"
        testId="mission-progress-heatmap-empty"
      />
    );
  }

  return (
    <section
      data-testid="mission-progress-heatmap"
      className="border border-outline-variant bg-white/35 p-4 backdrop-blur-sm"
    >
      <header className="mb-3 flex items-center justify-between gap-3 border-b border-outline-variant pb-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-900">
          Acceptance heat-map
        </h3>
        <span className="font-mono text-[10px] text-stone-600">
          {heatmapRows.length} slice{heatmapRows.length === 1 ? "" : "s"} ·
          {" "}
          one cell per acceptance item
        </span>
      </header>
      <div className="space-y-2">
        {heatmapRows.map((row) => (
          <HeatmapSliceRow key={row.name} row={row} />
        ))}
      </div>
      <HeatmapLegend />
    </section>
  );
}

function HeatmapSliceRow({ row }: { row: HeatmapRow }) {
  const tone = heatmapTone(row.status);
  return (
    <article
      data-testid={`mission-progress-heatmap-row-${row.name}`}
      data-status={row.status}
      data-tone={tone}
      className="grid grid-cols-[minmax(8rem,16rem)_1fr_auto] items-center gap-3"
    >
      <div className="min-w-0 space-y-1">
        <Link
          to="/project/slice/$sliceId"
          params={{ sliceId: row.name }}
          className="block truncate font-mono text-[11px] uppercase tracking-[0.12em] text-stone-900 hover:underline"
          title={row.displayName}
          aria-label={`${row.displayName} (${row.doneItems}/${row.totalItems} acceptance items)`}
        >
          {row.displayName}
        </Link>
        <ProjectPill token={{ label: row.status, tone }} compact />
      </div>
      <Cells row={row} />
      <div className="font-mono text-[10px] text-stone-700 tabular-nums whitespace-nowrap">
        {row.doneItems}/{row.totalItems || 0}
        {row.totalItems > 0 ? ` (${row.percentage}%)` : ""}
      </div>
    </article>
  );
}

function Cells({ row }: { row: HeatmapRow }) {
  if (row.items.length === 0) {
    return (
      <div
        data-testid={`mission-progress-heatmap-cells-${row.name}`}
        data-cell-state="empty"
        className="font-mono text-[10px] italic text-stone-500"
      >
        No acceptance items declared yet.
      </div>
    );
  }
  const tone = heatmapTone(row.status);
  // Done cells take the slice's status tone (info for active, success
  // for done, danger for blocked, etc.) so the heat-map reads both
  // per-cell + per-row at-a-glance. Not-done cells stay outline-only
  // so the eye finds incomplete work fast.
  const doneClass = doneCellClass(tone);
  return (
    <div
      data-testid={`mission-progress-heatmap-cells-${row.name}`}
      className="flex flex-wrap gap-[3px]"
    >
      {row.items.map((item, idx) => (
        <span
          key={idx}
          data-testid={`mission-progress-heatmap-cell-${row.name}-${idx}`}
          data-done={item.done ? "true" : "false"}
          aria-label={`${item.text} (${item.done ? "done" : "not done"})`}
          title={item.text}
          className={
            item.done
              ? `h-4 w-4 border ${doneClass}`
              : "h-4 w-4 border border-outline-variant bg-white/35"
          }
        />
      ))}
    </div>
  );
}

function HeatmapLegend() {
  // Legend swatches MUST use the same class string the cells would
  // render for the given tone. doneCellClass() is the single source
  // of truth; the legend just feeds it the same tone the heat-map
  // resolves for each status keyword.
  return (
    <footer
      data-testid="mission-progress-heatmap-legend"
      className="mt-3 flex flex-wrap items-center gap-3 border-t border-outline-variant pt-2 font-mono text-[10px] text-stone-600"
    >
      <LegendCell label="done (active)" tone="info" testId="legend-active" />
      <LegendCell label="done (complete)" tone="success" testId="legend-complete" />
      <LegendCell label="done (warning)" tone="warning" testId="legend-warning" />
      <LegendCell label="done (blocked)" tone="danger" testId="legend-blocked" />
      <LegendCell label="not done" notDone testId="legend-not-done" />
    </footer>
  );
}

function LegendCell({
  label,
  tone,
  notDone,
  testId,
}: {
  label: string;
  tone?: ProjectMetaTone;
  notDone?: boolean;
  testId: string;
}): ReactNode {
  const swatchClass = notDone
    ? "border-outline-variant bg-white/35"
    : doneCellClass(tone!);
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        data-testid={`mission-progress-heatmap-${testId}`}
        className={`inline-block h-3 w-3 border ${swatchClass}`}
      />
      <span>{label}</span>
    </span>
  );
}
