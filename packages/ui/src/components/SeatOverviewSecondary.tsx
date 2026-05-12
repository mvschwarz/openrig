// V0.3.1 slice 25 second follow-on — cwd + current-work section.
//
// Visually separated from the SeatOverviewTable above. Renders the
// two "wide" fields as labeled key-value rows in their own section
// primitive so the eye reads them as distinct from the dense column
// table.
//
// Data sources (same NodeDetailData fields as the original
// full-width rows):
//   - cwd — data.cwd
//   - current work — data.currentQitems[0]; rendered as qitemId +
//     body excerpt; em-dash when no in-progress qitem
//
// CWD value carries `title={cwd}` so hovering reveals the full path
// when the value cell truncates.

import type { ReactNode } from "react";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";

interface SeatOverviewSecondaryProps {
  data: NodeDetailData;
}

function placeholderOrValue(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "string" && value.trim() === "") return <span className="text-stone-400">—</span>;
  return value;
}

export function SeatOverviewSecondary({ data }: SeatOverviewSecondaryProps) {
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

  return (
    <section
      data-testid="seat-overview-secondary"
      className="border border-outline-variant bg-white/30"
    >
      <dl className="divide-y divide-outline-variant/55">
        <Row
          fieldKey="cwd"
          label="cwd"
          value={data.cwd}
          mono
          titleAttr={data.cwd ?? undefined}
        />
        <Row
          fieldKey="current-work"
          label="current work"
          value={currentWorkValue}
        />
      </dl>
    </section>
  );
}

function Row({
  fieldKey,
  label,
  value,
  mono,
  titleAttr,
}: {
  fieldKey: string;
  label: string;
  value: ReactNode | null | undefined;
  mono?: boolean;
  titleAttr?: string;
}) {
  return (
    <div
      data-testid={`seat-overview-secondary-row-${fieldKey}`}
      className="flex min-w-0 items-baseline gap-3 px-3 py-1.5"
      title={titleAttr}
    >
      <dt className="shrink-0 font-mono text-[10px] lowercase tracking-[0.04em] text-stone-500">
        {label}
      </dt>
      <dd
        data-testid={`seat-overview-secondary-cell-${fieldKey}`}
        className={`min-w-0 flex-1 truncate ${
          mono ? "font-mono text-[11px]" : "text-[11px]"
        } text-stone-900`}
      >
        {placeholderOrValue(value)}
      </dd>
    </div>
  );
}
