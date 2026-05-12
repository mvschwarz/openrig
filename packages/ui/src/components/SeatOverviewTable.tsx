// V0.3.1 slice 25 second follow-on — Overview info table polish.
//
// Column-oriented dense info table at the top of the seat-detail
// Overview tab. The follow-on-2 polish:
//   - Section-header row removed (column headers ARE the first row).
//   - Vertical grid lines (border-r border-outline-variant) between
//     column cells in header + data rows; clearer cell boundaries.
//   - "total tokens" column header label tightened to "tokens" to
//     conserve horizontal width.
//   - cwd + current-work moved OUT of this table into a separate
//     primitive (SeatOverviewSecondary) below; this component renders
//     ONLY the 7-column row of compact fields now.
//
// Mobile (HG-8): the column-header row + data row wrap in an
// `overflow-x-auto` scroll container so a 375px viewport scrolls
// horizontally rather than mash 7 cells together.
//
// Data sources (single source of truth across surfaces):
//   - runtime / model / profile / spec — NodeDetailData directly
//   - activity — getActivityState(data.agentActivity) baseline OR
//     activityVisual when wired via useTopologyActivity; same source
//     the topology graph + table read. State "running" maps to label
//     "active" so the seat page agrees with topology naming.
//   - context% / total tokens — data.contextUsage.usedPercentage +
//     sumTokenCounts(input, output); same helpers TopologyTableView
//     uses for the topology table.
//
// Shimmer: when activity state is "active" (or baseline maps to
// "running") the activity value picks up the slice-14
// .topology-table-active-shimmer CSS class. Honors
// prefers-reduced-motion per DESIGN.md §Motion.

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
import "./topology/topology-table-shimmer.css";

interface SeatOverviewTableProps {
  data: NodeDetailData;
  activityVisual?: TopologyActivityVisual | null;
}

interface ColumnField {
  key: string;
  label: string;
  value: ReactNode | null | undefined;
  mono?: boolean;
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
    { key: "total-tokens", label: "tokens", value: tokenLabel, mono: true },
  ];

  const lastIdx = columnFields.length - 1;

  return (
    <section
      data-testid="seat-overview-table"
      className="border border-outline-variant bg-white/30"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr
              data-testid="seat-overview-header-row"
              className="border-b border-outline-variant/55 bg-stone-50/30"
            >
              {columnFields.map((field, idx) => (
                <th
                  key={field.key}
                  scope="col"
                  data-testid={`seat-overview-header-${field.key}`}
                  className={`px-3 py-1.5 text-left font-mono text-[10px] font-normal lowercase tracking-[0.04em] text-stone-500 ${
                    idx < lastIdx ? "border-r border-outline-variant/55" : ""
                  }`}
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
            >
              {columnFields.map((field, idx) => (
                <td
                  key={field.key}
                  data-testid={`seat-overview-cell-${field.key}`}
                  className={`min-w-0 px-3 py-1.5 align-middle ${
                    field.mono ? "font-mono text-[11px]" : "text-[11px]"
                  } text-stone-900 ${
                    idx < lastIdx ? "border-r border-outline-variant/55" : ""
                  }`}
                >
                  <div className="truncate">{placeholderOrValue(field.value)}</div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
