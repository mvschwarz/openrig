// V0.3.1 slice 25 node-page Overview/Details — column-oriented variant.
//
// Dense info table at the top of the seat-detail Overview tab.
// Renders the most-asked questions about a seat at a single glance.
// Two row-shape conventions in one visually-cohesive table:
//
//   COLUMN-HEADER + DATA ROW (horizontal compact) — 7 fields:
//     runtime / model / profile / spec / activity / context% / total tokens
//
//   FULL-WIDTH rows (single cell with inline label) — 2 rows below:
//     cwd / current work
//
// The follow-on re-orientation (2026-05-12) flipped the compact-row
// shape from row-oriented (one field per row) to column-oriented
// (one row with column headers + one data row spanning columns).
// Tighter screen real estate; glanceable horizontally. The cwd +
// current-work full-width rows are preserved in the same table
// primitive (not separate cards) below the data row.
//
// Density anchor: TopologyTableView (per ui.md §Topology) — same
// compact mono cells, 1px outline-variant cell borders, vellum
// surface chrome.
//
// Data sources (single source of truth across surfaces):
//   - runtime / model / profile / spec / cwd — NodeDetailData directly
//   - activity — getActivityState(data.agentActivity) baseline OR
//     activityVisual when wired via useTopologyActivity; same source
//     the topology graph + table read. State "running" maps to label
//     "active" so the seat page agrees with topology naming.
//   - context% / total tokens — data.contextUsage.usedPercentage +
//     sumTokenCounts(input, output); same helpers TopologyTableView
//     uses for the topology table.
//   - current work — first entry of data.currentQitems[]; NodeDetailData
//     surfaces this via the /api/rigs/<rigId>/nodes/<logicalId>
//     endpoint. The qitem refreshes when react-query refetches the
//     useNodeDetail query (default refetch interval).
//
// Shimmer: when activity state is "active" (or baseline maps to
// "running") the activity value picks up the slice-14
// .topology-table-active-shimmer CSS class, giving the same subtle
// left-to-right sweep TopologyTableView uses on active-status text.
// Honors prefers-reduced-motion per DESIGN.md §Motion.
//
// Mobile (HG-8): the column-header row + data row wrap in an
// `overflow-x-auto` scroll container so a 375px viewport can scroll
// horizontally rather than mash 7 cells together. The full-width
// rows below stay full-width regardless.

import type { ReactNode } from "react";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";
import { RuntimeBadge } from "./graphics/RuntimeMark.js";
import {
  formatCompactTokenCount,
  sumTokenCounts,
} from "../lib/token-format.js";
import {
  getActivityLabel,
  getActivityState,
  type ActivityState,
} from "../lib/activity-visuals.js";
import type { TopologyActivityVisual } from "../lib/topology-activity.js";
// Slice 14 shimmer CSS — reused on the activity value when state is
// "active" / "running" so the seat-page activity reads with the same
// visual vocabulary as the topology table.
import "./topology/topology-table-shimmer.css";

interface SeatOverviewTableProps {
  data: NodeDetailData;
  activityVisual?: TopologyActivityVisual | null;
}

interface ColumnField {
  /** Stable kebab-case key used as testid suffix + render key. */
  key: string;
  /** Display header. Lowercase mono. */
  label: string;
  /** Cell content. null/undefined/empty renders as em-dash placeholder. */
  value: ReactNode | null | undefined;
  /** Mono for IDs + numeric metrics; non-mono for human-readable
   *  values like the RuntimeBadge. Per DESIGN.md §Typography. */
  mono?: boolean;
}

interface FullWidthField {
  key: string;
  label: string;
  value: ReactNode | null | undefined;
  mono?: boolean;
  /** Carries the full string via `title={titleAttr}` so hovering shows
   *  the unabbreviated value. Used for cwd. */
  titleAttr?: string;
}

function placeholderOrValue(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "string" && value.trim() === "") return <span className="text-stone-400">—</span>;
  return value;
}

function activityLabelFromState(state: ActivityState): string {
  if (state === "running") return "active";
  return getActivityLabel(state);
}

function activityLabelFromVisualState(state: TopologyActivityVisual["state"]): string {
  if (state === "active") return "active";
  if (state === "needs_input") return "needs input";
  return state;
}

export function SeatOverviewTable({ data, activityVisual }: SeatOverviewTableProps) {
  const fallbackActivityState = getActivityState(data.agentActivity);
  const activityState = activityVisual?.state ?? fallbackActivityState;
  const activityLabel = activityVisual
    ? activityLabelFromVisualState(activityVisual.state)
    : activityLabelFromState(fallbackActivityState);
  const activityIsActive = activityVisual
    ? activityVisual.state === "active"
    : fallbackActivityState === "running";

  const contextPercentage =
    data.contextUsage?.availability === "known" &&
    typeof data.contextUsage.usedPercentage === "number"
      ? `${data.contextUsage.usedPercentage}%`
      : null;
  const tokenTotal = sumTokenCounts(
    data.contextUsage?.totalInputTokens,
    data.contextUsage?.totalOutputTokens,
  );
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const specCell =
    data.resolvedSpecName && data.resolvedSpecVersion
      ? `${data.resolvedSpecName}@${data.resolvedSpecVersion}`
      : data.resolvedSpecName ?? null;

  const currentQitem = data.currentQitems?.[0] ?? null;
  const currentWorkValue: ReactNode | null = currentQitem ? (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-[10px] text-stone-500">
        {currentQitem.qitemId}
      </span>
      <span className="min-w-0 truncate text-[11px] text-stone-900">
        {currentQitem.bodyExcerpt}
      </span>
    </span>
  ) : null;

  const activityValue: ReactNode = (
    <span
      data-testid="seat-overview-activity-state"
      data-activity-state={activityState}
      className={
        activityIsActive
          ? "topology-table-active-shimmer text-emerald-600"
          : "text-stone-700"
      }
    >
      {activityLabel}
    </span>
  );

  const columnFields: ColumnField[] = [
    {
      key: "runtime",
      label: "runtime",
      value: data.runtime ? (
        <RuntimeBadge
          runtime={data.runtime}
          model={data.model}
          size="xs"
          compact
          variant="inline"
          className="max-w-full"
        />
      ) : null,
    },
    { key: "model", label: "model", value: data.model, mono: true },
    { key: "profile", label: "profile", value: data.profile, mono: true },
    { key: "spec", label: "spec", value: specCell, mono: true },
    { key: "activity", label: "activity", value: activityValue },
    { key: "context-percent", label: "context %", value: contextPercentage, mono: true },
    { key: "total-tokens", label: "total tokens", value: tokenLabel, mono: true },
  ];

  const fullWidthFields: FullWidthField[] = [
    {
      key: "cwd",
      label: "cwd",
      value: data.cwd,
      mono: true,
      titleAttr: data.cwd ?? undefined,
    },
    {
      key: "current-work",
      label: "current work",
      value: currentWorkValue,
    },
  ];

  return (
    <section
      data-testid="seat-overview-table"
      className="border border-outline-variant bg-white/30"
    >
      <div className="border-b border-outline-variant px-3 py-2 font-mono text-[8px] uppercase tracking-[0.16em] text-stone-400">
        Overview
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr
              data-testid="seat-overview-header-row"
              className="border-b border-outline-variant/55 bg-stone-50/30"
            >
              {columnFields.map((field) => (
                <th
                  key={field.key}
                  scope="col"
                  data-testid={`seat-overview-header-${field.key}`}
                  className="px-3 py-1.5 text-left font-mono text-[10px] font-normal lowercase tracking-[0.04em] text-stone-500"
                >
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr
              data-testid="seat-overview-data-row"
              data-row-shape="data"
              className="border-b border-outline-variant/55"
            >
              {columnFields.map((field) => (
                <td
                  key={field.key}
                  data-testid={`seat-overview-cell-${field.key}`}
                  className={`min-w-0 px-3 py-1.5 align-middle ${
                    field.mono ? "font-mono text-[11px]" : "text-[11px]"
                  } text-stone-900`}
                >
                  <div className="truncate">{placeholderOrValue(field.value)}</div>
                </td>
              ))}
            </tr>
            {fullWidthFields.map((field) => (
              <FullWidthRow
                key={field.key}
                field={field}
                colSpan={columnFields.length}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FullWidthRow({ field, colSpan }: { field: FullWidthField; colSpan: number }) {
  const hasValue =
    field.value !== null &&
    field.value !== undefined &&
    !(typeof field.value === "string" && field.value.trim() === "");
  return (
    <tr
      data-testid={`seat-overview-row-${field.key}`}
      data-row-shape="full-width"
      className="border-b border-outline-variant/55 last:border-b-0"
    >
      <td
        colSpan={colSpan}
        data-testid={`seat-overview-cell-${field.key}`}
        className="bg-white/15 px-3 py-1.5 align-middle"
        title={field.titleAttr}
      >
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="shrink-0 font-mono text-[10px] lowercase tracking-[0.04em] text-stone-500">
            {field.label}
          </span>
          <span
            className={`min-w-0 flex-1 truncate ${
              field.mono ? "font-mono text-[11px]" : "text-[11px]"
            } text-stone-900`}
          >
            {hasValue ? field.value : <span className="text-stone-400">—</span>}
          </span>
        </div>
      </td>
    </tr>
  );
}
