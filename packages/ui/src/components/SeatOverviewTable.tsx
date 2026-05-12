// V0.3.1 slice 25 node-page Overview/Details consolidation.
//
// Dense 7-field info table at the top of the seat-detail Overview tab.
// Renders the most-asked questions about a seat at a single glance:
// runtime, model, profile, spec (name + version), cwd, context%, and
// total tokens. Density anchor: TopologyTableView (per ui.md §Topology)
// — same compact mono cells, 1px outline-variant cell borders, vellum
// surface chrome.
//
// Reuses the shared token / runtime helpers so the values rendered
// here are the SAME values rendered in topology graph + table +
// terminal views (slice 25 HG-3 — single source of truth across
// surfaces).
//
// Graceful absence rule: when a field is null/undefined/empty the
// cell renders an em-dash placeholder. Model in particular is
// commonly absent (not every RigSpec member declares one); the row
// stays visible with a dash rather than rendering "undefined" or
// being hidden — HG-4 from the slice 25 spec.

import type { ReactNode } from "react";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";
import { RuntimeBadge } from "./graphics/RuntimeMark.js";
import {
  formatCompactTokenCount,
  sumTokenCounts,
} from "../lib/token-format.js";

interface SeatOverviewTableProps {
  data: NodeDetailData;
}

interface Row {
  /** Stable kebab-case key used as testid suffix + render key. */
  key: string;
  /** Display label in the left column. Lowercase mono. */
  label: string;
  /** Cell content. May be string OR a ReactNode (e.g., RuntimeBadge).
   *  null/undefined/empty-string renders as "—" placeholder. */
  value: ReactNode | null | undefined;
  /** Use the body-font (sans) for human-readable values; mono for IDs
   *  + numeric metrics. Per DESIGN.md §Typography. */
  mono?: boolean;
}

function placeholderOrValue(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "string" && value.trim() === "") return <span className="text-stone-400">—</span>;
  return value;
}

export function SeatOverviewTable({ data }: SeatOverviewTableProps) {
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

  const rows: Row[] = [
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
    { key: "cwd", label: "cwd", value: data.cwd, mono: true },
    {
      key: "context-percent",
      label: "context %",
      value: contextPercentage,
      mono: true,
    },
    {
      key: "total-tokens",
      label: "total tokens",
      value: tokenLabel,
      mono: true,
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
          {rows.map((row) => (
            <tr
              key={row.key}
              data-testid={`seat-overview-row-${row.key}`}
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
          ))}
        </tbody>
      </table>
    </section>
  );
}
