// V0.3.1 slice 25 node-page Overview/Details consolidation.
//
// Dense 9-row info table at the top of the seat-detail Overview tab.
// Renders the most-asked questions about a seat at a single glance.
// Two row-shape conventions in one visually-cohesive table:
//
//   COMPACT (2-col key/value) — 7 rows:
//     runtime / model / profile / spec / activity / context% / total tokens
//
//   FULL-WIDTH (single cell with inline label) — 2 rows:
//     cwd / current work
//
// Density anchor: TopologyTableView (per ui.md §Topology) — same
// compact mono cells, 1px outline-variant cell borders, vellum
// surface chrome.
//
// Data sources (single source of truth across surfaces):
//   - runtime / model / profile / spec / cwd — NodeDetailData directly
//   - activity — getActivityState(data.agentActivity); same helper
//     LiveNodeCurrentState uses, same source the topology table
//     baseline reads. State "running" maps to label "active" so the
//     seat page agrees with the topology graph/table naming.
//   - context% / total tokens — data.contextUsage.usedPercentage +
//     sumTokenCounts(input, output); same helpers TopologyTableView
//     uses for the topology table.
//   - current work — first entry of data.currentQitems[]; NodeDetailData
//     surfaces this via the /api/rigs/<rigId>/nodes/<logicalId>
//     endpoint. The qitem refreshes when react-query refetches the
//     useNodeDetail query (default refetch interval).
//
// Shimmer (slice 25 HG-3c): when activity state is "running" the
// activity value picks up the slice-14 .topology-table-active-shimmer
// CSS class, giving the same subtle left-to-right sweep TopologyTableView
// uses on active-status text. The class honors prefers-reduced-motion
// (suppressed under reduce per DESIGN.md §Motion).
//
// Graceful absence: any null/undefined/empty cell renders an em-dash
// placeholder. Model + current-work in particular are commonly absent;
// the row stays visible with a dash rather than being hidden or
// rendering "undefined" — HG-4 from the slice 25 spec.

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
// "running" so the seat-page activity reads with the same visual
// vocabulary as the topology table.
import "./topology/topology-table-shimmer.css";

interface SeatOverviewTableProps {
  data: NodeDetailData;
  activityVisual?: TopologyActivityVisual | null;
}

type RowShape = "compact" | "full-width";

interface Row {
  /** Stable kebab-case key used as testid suffix + render key. */
  key: string;
  /** Display label. Lowercase mono. */
  label: string;
  /** Cell content. May be string OR a ReactNode (e.g., RuntimeBadge).
   *  null/undefined/empty-string renders as "—" placeholder. */
  value: ReactNode | null | undefined;
  shape: RowShape;
  /** Use the body-font (sans) for human-readable values; mono for IDs
   *  + numeric metrics. Per DESIGN.md §Typography. Compact rows
   *  default to mono; full-width rows default to mono too. */
  mono?: boolean;
  /** When present, the truncated value cell gets `title={titleAttr}`
   *  so hovering shows the full string. Used for cwd. */
  titleAttr?: string;
}

function placeholderOrValue(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "string" && value.trim() === "") return <span className="text-stone-400">—</span>;
  return value;
}

function activityLabelFromState(state: ActivityState): string {
  // The seat page uses the topology-naming convention: "running" reads
  // as "active" so the cell text agrees with the topology graph/table
  // (where the "active" label is the one that catches the eye + carries
  // the shimmer). Other states pass through the canonical label.
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
    <span className="inline-flex items-baseline gap-2">
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
    </span>
  );

  const rows: Row[] = [
    {
      key: "runtime",
      label: "runtime",
      shape: "compact",
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
    { key: "model", label: "model", shape: "compact", value: data.model, mono: true },
    { key: "profile", label: "profile", shape: "compact", value: data.profile, mono: true },
    { key: "spec", label: "spec", shape: "compact", value: specCell, mono: true },
    { key: "activity", label: "activity", shape: "compact", value: activityValue },
    {
      key: "context-percent",
      label: "context %",
      shape: "compact",
      value: contextPercentage,
      mono: true,
    },
    {
      key: "total-tokens",
      label: "total tokens",
      shape: "compact",
      value: tokenLabel,
      mono: true,
    },
    {
      key: "cwd",
      label: "cwd",
      shape: "full-width",
      value: data.cwd,
      mono: true,
      titleAttr: data.cwd ?? undefined,
    },
    {
      key: "current-work",
      label: "current work",
      shape: "full-width",
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
      <table className="w-full text-left">
        <tbody>
          {rows.map((row) =>
            row.shape === "compact" ? (
              <CompactRow key={row.key} row={row} />
            ) : (
              <FullWidthRow key={row.key} row={row} />
            ),
          )}
        </tbody>
      </table>
    </section>
  );
}

function CompactRow({ row }: { row: Row }) {
  return (
    <tr
      data-testid={`seat-overview-row-${row.key}`}
      data-row-shape="compact"
      className="border-b border-outline-variant/55 last:border-b-0"
    >
      <th
        scope="row"
        className="w-32 shrink-0 bg-stone-50/30 px-3 py-1.5 text-left align-top font-mono text-[10px] font-normal lowercase tracking-[0.04em] text-stone-500"
      >
        {row.label}
      </th>
      <td
        data-testid={`seat-overview-cell-${row.key}`}
        className={`min-w-0 px-3 py-1.5 align-middle ${
          row.mono ? "font-mono text-[11px]" : "text-[11px]"
        } text-stone-900`}
      >
        <div className="truncate">{placeholderOrValue(row.value)}</div>
      </td>
    </tr>
  );
}

function FullWidthRow({ row }: { row: Row }) {
  const hasValue =
    row.value !== null &&
    row.value !== undefined &&
    !(typeof row.value === "string" && row.value.trim() === "");
  return (
    <tr
      data-testid={`seat-overview-row-${row.key}`}
      data-row-shape="full-width"
      className="border-b border-outline-variant/55 last:border-b-0"
    >
      <td
        colSpan={2}
        data-testid={`seat-overview-cell-${row.key}`}
        className="bg-white/15 px-3 py-1.5 align-middle"
        title={row.titleAttr}
      >
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="shrink-0 font-mono text-[10px] lowercase tracking-[0.04em] text-stone-500">
            {row.label}
          </span>
          <span
            className={`min-w-0 flex-1 truncate ${
              row.mono ? "font-mono text-[11px]" : "text-[11px]"
            } text-stone-900`}
          >
            {hasValue ? row.value : <span className="text-stone-400">—</span>}
          </span>
        </div>
      </td>
    </tr>
  );
}
