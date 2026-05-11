// 0.3.1 slice 06 — For You storytelling card primitives.
//
// Mobile-first cards for the For You feed: collapsed (~80px) → tap
// for inline-expanded preview → tap "Open" for drill-in to the
// existing center route. Each card type carries its own data shape
// + accent color but shares the CardShell chrome so the feed reads
// as a rhythm of comparable tiles.
//
// Tap target = entire card surface; all actionable elements ≥44px
// touch target per IMPL-PRD §6 + HG-8.

import { useState, type ReactNode } from "react";

// -----------------------------------------------------------------------------
// CardShell — shared chrome (header, accent stripe, collapse toggle)
// -----------------------------------------------------------------------------

export interface CardShellProps {
  testId: string;
  kind: CardKind;
  title: string;
  oneLiner: string;
  accent: CardAccent;
  expanded: ReactNode;
  drillInHref?: string;
  drillInLabel?: string;
  /** Inline action row rendered at the top-right of the collapsed
   *  view (e.g. Approve / Deny on the Approval-needed card). */
  inlineActions?: ReactNode;
  /** Optional accessory rendered to the left of the title — currently
   *  used by IncidentCard to show a status dot on the collapsed view. */
  leadingAccessory?: ReactNode;
}

export type CardKind = "shipped" | "incident" | "progress" | "approval" | "concept";

interface CardAccent {
  stripe: string;
  pill: string;
  ink: string;
  label: string;
}

export const ACCENTS: Record<CardKind, CardAccent> = {
  shipped:  { stripe: "border-l-emerald-600", pill: "bg-emerald-50 border-emerald-300", ink: "text-emerald-800", label: "SHIPPED" },
  incident: { stripe: "border-l-red-600",     pill: "bg-red-50 border-red-300",         ink: "text-red-800",     label: "INCIDENT" },
  progress: { stripe: "border-l-sky-600",     pill: "bg-sky-50 border-sky-300",         ink: "text-sky-800",     label: "PROGRESS" },
  approval: { stripe: "border-l-amber-600",   pill: "bg-amber-50 border-amber-300",     ink: "text-amber-800",   label: "APPROVAL NEEDED" },
  concept:  { stripe: "border-l-violet-600",  pill: "bg-violet-50 border-violet-300",   ink: "text-violet-800",  label: "CONCEPT" },
};

export function CardShell({ testId, kind, title, oneLiner, accent, expanded, drillInHref, drillInLabel, inlineActions, leadingAccessory }: CardShellProps) {
  const [open, setOpen] = useState(false);
  return (
    <article
      data-testid={testId}
      data-card-kind={kind}
      data-expanded={open}
      className={`border border-outline-variant border-l-4 ${accent.stripe} bg-white/85 hard-shadow`}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        className="flex w-full min-h-[80px] cursor-pointer items-start gap-3 px-3 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <div
            data-testid={`${testId}-pill`}
            className={`inline-block border px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] ${accent.pill} ${accent.ink}`}
          >
            {accent.label}
          </div>
          <h3 data-testid={`${testId}-title`} className="mt-1 flex items-center gap-2 text-[13px] font-bold text-stone-900">
            {leadingAccessory}
            <span className="truncate">{title}</span>
          </h3>
          <p data-testid={`${testId}-one-liner`} className="mt-0.5 text-[11px] leading-relaxed text-stone-700 line-clamp-2">
            {oneLiner}
          </p>
        </div>
        {inlineActions && (
          <div data-testid={`${testId}-inline-actions`} className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {inlineActions}
          </div>
        )}
      </div>
      {open && (
        <div data-testid={`${testId}-expanded`} className="border-t border-outline-variant px-3 py-3">
          {expanded}
          {drillInHref && (
            <div className="mt-3 flex justify-end">
              <a
                data-testid={`${testId}-drill-in`}
                href={drillInHref}
                className="inline-block min-h-[44px] border border-stone-700 bg-stone-700 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-white hover:bg-stone-800"
                onClick={(e) => e.stopPropagation()}
              >
                {drillInLabel ?? "Open"} →
              </a>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// -----------------------------------------------------------------------------
// ShippedCard — feature-shipped narrative
// -----------------------------------------------------------------------------

export interface ShippedCardSource {
  sliceId: string;
  title: string;
  oneLiner: string;
  /** Optional numbered sections preview (rendered in inline-expanded). */
  sections?: Array<{ number: number; heading: string; summary: string }>;
}

export function ShippedCard({ source }: { source: ShippedCardSource }) {
  return (
    <CardShell
      testId={`feed-card-shipped-${source.sliceId}`}
      kind="shipped"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.shipped}
      drillInHref={`/project/slice/${source.sliceId}`}
      expanded={
        source.sections && source.sections.length > 0 ? (
          <ol className="space-y-2 text-[11px]">
            {source.sections.slice(0, 3).map((s) => (
              <li key={s.number} data-testid={`feed-card-shipped-${source.sliceId}-section-${s.number}`} className="flex gap-2">
                <span className="font-mono text-[10px] font-bold text-stone-500">{s.number}.</span>
                <div>
                  <div className="font-semibold text-stone-900">{s.heading}</div>
                  <div className="text-stone-700">{s.summary}</div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="text-[11px] text-stone-600">{source.oneLiner}</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// IncidentCard — incident-timeline summary
// -----------------------------------------------------------------------------

export interface IncidentCardSource {
  sliceId: string;
  title: string;
  oneLiner: string;
  status: "success" | "warning" | "danger" | "info" | "muted";
  /** Up to 3 timeline entries to preview in inline-expanded. */
  recentEntries?: Array<{ time: string; title: string; status: "success" | "warning" | "danger" | "info" | "muted" }>;
}

const STATUS_DOT: Record<IncidentCardSource["status"], string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger:  "bg-red-500",
  info:    "bg-sky-500",
  muted:   "bg-stone-400",
};

export function IncidentCard({ source }: { source: IncidentCardSource }) {
  return (
    <CardShell
      testId={`feed-card-incident-${source.sliceId}`}
      kind="incident"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.incident}
      drillInHref={`/project/slice/${source.sliceId}`}
      drillInLabel="Open timeline"
      leadingAccessory={
        <span
          data-testid={`feed-card-incident-${source.sliceId}-dot`}
          className={`inline-block h-3 w-3 rounded-full shrink-0 ${STATUS_DOT[source.status]}`}
          aria-hidden="true"
        />
      }
      expanded={
        source.recentEntries && source.recentEntries.length > 0 ? (
          <ul className="space-y-2 text-[11px]">
            {source.recentEntries.slice(0, 3).map((e, i) => (
              <li key={i} data-testid={`feed-card-incident-${source.sliceId}-entry-${i}`} className="flex items-baseline gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[e.status]} shrink-0`} aria-hidden="true" />
                <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500 shrink-0">{e.time}</span>
                <span className="text-stone-900">{e.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] text-stone-600">No recent entries.</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// ProgressCard — mission/slice progress
// -----------------------------------------------------------------------------

export interface ProgressCardSource {
  missionId: string;
  title: string;
  oneLiner: string;
  /** 0..100 */
  percent: number;
  /** Next-step hint shown on the collapsed view per IMPL-PRD §6
   *  ("Title + progress bar + next-step"). When omitted, the
   *  oneLiner stands in. */
  nextStep?: string;
  /** What's the active sub-slice doing right now (inline-expanded). */
  activeSlice?: { id: string; label: string; status: string };
}

export function ProgressCard({ source }: { source: ProgressCardSource }) {
  const pct = Math.max(0, Math.min(100, Math.round(source.percent)));
  return (
    <CardShell
      testId={`feed-card-progress-${source.missionId}`}
      kind="progress"
      title={source.title}
      oneLiner={source.nextStep ?? source.oneLiner}
      accent={ACCENTS.progress}
      drillInHref={`/project/mission/${source.missionId}`}
      drillInLabel="Open mission"
      leadingAccessory={
        <div
          data-testid={`feed-card-progress-${source.missionId}-bar`}
          data-percent={pct}
          className="h-1.5 w-16 shrink-0 border border-outline-variant bg-stone-100 overflow-hidden"
          aria-label={`Progress ${pct}%`}
        >
          <div
            data-testid={`feed-card-progress-${source.missionId}-bar-fill`}
            className="h-full bg-sky-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      }
      expanded={
        source.activeSlice ? (
          <div data-testid={`feed-card-progress-${source.missionId}-active-slice`} className="border border-outline-variant bg-stone-50 px-2 py-2">
            <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-stone-500">Active slice</div>
            <div className="mt-1 text-[12px] font-semibold text-stone-900">{source.activeSlice.label}</div>
            <div className="mt-0.5 font-mono text-[9px] text-stone-600">status: {source.activeSlice.status}</div>
          </div>
        ) : (
          <div className="text-[11px] text-stone-600">No active slice.</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// ApprovalCard — queue items with tier: human-gate
// -----------------------------------------------------------------------------

export interface ApprovalCardSource {
  qitemId: string;
  title: string;
  oneLiner: string;
  /** Body preview shown when inline-expanded. */
  bodyPreview?: string;
  /** Drill-in destination (queue detail or slice). */
  drillInHref?: string;
  onApprove?: () => void;
  onDeny?: () => void;
}

export function ApprovalCard({ source }: { source: ApprovalCardSource }) {
  return (
    <CardShell
      testId={`feed-card-approval-${source.qitemId}`}
      kind="approval"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.approval}
      drillInHref={source.drillInHref}
      drillInLabel="Open detail"
      inlineActions={
        <>
          {source.onApprove && (
            <button
              type="button"
              data-testid={`feed-card-approval-${source.qitemId}-approve`}
              onClick={source.onApprove}
              className="min-h-[44px] min-w-[44px] border border-emerald-700 bg-emerald-600 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-white"
            >
              Approve
            </button>
          )}
          {source.onDeny && (
            <button
              type="button"
              data-testid={`feed-card-approval-${source.qitemId}-deny`}
              onClick={source.onDeny}
              className="min-h-[44px] min-w-[44px] border border-stone-400 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700"
            >
              Deny
            </button>
          )}
        </>
      }
      expanded={
        source.bodyPreview ? (
          <pre data-testid={`feed-card-approval-${source.qitemId}-body`} className="overflow-x-auto whitespace-pre-wrap break-words bg-stone-50 p-2 font-mono text-[10px] text-stone-800">
            {source.bodyPreview}
          </pre>
        ) : (
          <div className="text-[11px] text-stone-600">No body preview.</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// ConceptCard — kind: concept-explainer
// -----------------------------------------------------------------------------

export interface ConceptCardSource {
  sliceId: string;
  title: string;
  oneLiner: string;
  /** Optional thumbnail URL for the diagram. */
  thumbnailUrl?: string;
  /** Optional comparison preview (just rendered as text rows in v0). */
  comparePreview?: Array<{ label: string; valueOld: string; valueNew: string }>;
}

export function ConceptCard({ source }: { source: ConceptCardSource }) {
  return (
    <CardShell
      testId={`feed-card-concept-${source.sliceId}`}
      kind="concept"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.concept}
      drillInHref={`/project/slice/${source.sliceId}`}
      drillInLabel="Open concept"
      expanded={
        source.comparePreview && source.comparePreview.length > 0 ? (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-stone-50">
                <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[8px] uppercase tracking-[0.12em] text-stone-600"></th>
                <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[8px] uppercase tracking-[0.12em] text-stone-600">Old</th>
                <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[8px] uppercase tracking-[0.12em] text-stone-600">New</th>
              </tr>
            </thead>
            <tbody>
              {source.comparePreview.slice(0, 3).map((row, i) => (
                <tr key={i}>
                  <td className="border border-outline-variant px-2 py-1 font-mono text-[10px] font-semibold text-stone-700">{row.label}</td>
                  <td className="border border-outline-variant px-2 py-1 text-stone-700">{row.valueOld}</td>
                  <td className="border border-outline-variant px-2 py-1 text-stone-900">{row.valueNew}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-[11px] text-stone-600">{source.oneLiner}</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// StorytellingFeed — vertical stack of cards, mobile-first
// -----------------------------------------------------------------------------

export type FeedCardItem =
  | { kind: "shipped"; source: ShippedCardSource }
  | { kind: "incident"; source: IncidentCardSource }
  | { kind: "progress"; source: ProgressCardSource }
  | { kind: "approval"; source: ApprovalCardSource }
  | { kind: "concept"; source: ConceptCardSource };

/** 0.3.1 slice 06 forward-fix #2 — pure adapter that converts the
 *  daemon-driven mission + slice rows into FeedCardItem[]. Exported
 *  for unit-test surface: callers can verify the production wire's
 *  routing (missions → ProgressCard; shipped slices → ShippedCard;
 *  everything else → IncidentCard with derived status) without
 *  mounting the full Feed.tsx surface. */
export interface AdapterMissionRow {
  name: string;
  path: string;
}
export interface AdapterSliceRow {
  name: string;
  displayName?: string;
  status?: string | null;
  lastActivityAt?: string | null;
}
export function buildStorytellingFeedItems(
  missions: AdapterMissionRow[],
  slices: AdapterSliceRow[],
): FeedCardItem[] {
  const items: FeedCardItem[] = [];
  for (const mission of (missions ?? []).slice(0, 2)) {
    items.push({
      kind: "progress",
      source: {
        missionId: mission.name,
        title: mission.name,
        oneLiner: `Mission at ${mission.path}`,
        nextStep: `Open mission for live status + active slices.`,
        percent: 0,
      },
    });
  }
  for (const slice of (slices ?? []).slice(0, 3)) {
    const oneLiner = slice.lastActivityAt
      ? `Last activity ${slice.lastActivityAt}`
      : `Slice in ${slice.status ?? "unknown"} state`;
    const title = slice.displayName || slice.name;
    const sliceId = slice.name;
    const status = (slice.status ?? "").toLowerCase();
    if (status === "shipped" || status === "complete" || status === "done") {
      items.push({ kind: "shipped", source: { sliceId, title, oneLiner } });
    } else if (status === "blocked" || status === "danger" || status === "failed") {
      items.push({
        kind: "incident",
        source: { sliceId, title, oneLiner, status: status === "blocked" ? "warning" : "danger" },
      });
    } else {
      items.push({ kind: "incident", source: { sliceId, title, oneLiner, status: "info" } });
    }
  }
  return items;
}

export function StorytellingFeed({ items }: { items: FeedCardItem[] }) {
  if (items.length === 0) {
    return (
      <div data-testid="storytelling-feed-empty" className="border border-dashed border-outline-variant bg-white/35 p-4 font-mono text-[10px] text-stone-500">
        No items in the feed.
      </div>
    );
  }
  return (
    <div data-testid="storytelling-feed" className="flex flex-col gap-4">
      {items.map((item, i) => {
        if (item.kind === "shipped")  return <ShippedCard key={i}  source={item.source} />;
        if (item.kind === "incident") return <IncidentCard key={i} source={item.source} />;
        if (item.kind === "progress") return <ProgressCard key={i} source={item.source} />;
        if (item.kind === "approval") return <ApprovalCard key={i} source={item.source} />;
        return <ConceptCard key={i} source={item.source} />;
      })}
    </div>
  );
}
