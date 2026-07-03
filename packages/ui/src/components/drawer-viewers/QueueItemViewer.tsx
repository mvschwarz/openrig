// V1 attempt-3 Phase 4 — QueueItemViewer per content-drawer.md L46–L82.
//
// Renders qitem header (id + close + open-in-center) + metadata (source/
// dest/state/tags/created) + body preview (~30 lines + show-full-body)
// + Related (clickable refs).

import { useState } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { ActorChip, DateChip, FlowChips, QueueStateBadge, TagPill } from "../project/ProjectMetaPrimitives.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

export interface QueueItemViewerData {
  qitemId: string;
  source?: string;
  destination?: string;
  state?: string;
  tags?: string[];
  createdAt?: string;
  body?: string;
  related?: Array<{ kind: "file" | "commit" | "slice" | "seat"; label: string; href?: string }>;
  // OPR.0.4.1.19 — Tier-3 drawer = the full queue-item detail: all fields + the
  // full chain. Optional + render-when-present so existing callsites are unaffected.
  updatedAt?: string | null;
  priority?: string | null;
  tier?: string | null;
  closureReason?: string | null;
  closureTarget?: string | null;
  handedOffFrom?: string | null;
  handedOffTo?: string | null;
  blockedOn?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
  closureRequiredAt?: string | null;
  lastNudgeAttempt?: string | null;
  lastNudgeResult?: string | null;
  lastHeartbeat?: string | null;
  resolution?: string | null;
  targetRepo?: string | null;
  chain?: string[] | null;
  /** Tier-3 full source-of-truth view: render EVERY field labeled, nulls shown as
   *  "—" (not hidden). Default false keeps other callsites compact. */
  fullDetail?: boolean;
}

const PREVIEW_LINES = 30;

export function QueueItemViewer({
  qitemId,
  source,
  destination,
  state,
  tags,
  createdAt,
  body,
  related,
  updatedAt,
  priority,
  tier,
  closureReason,
  closureTarget,
  handedOffFrom,
  handedOffTo,
  blockedOn,
  claimedAt,
  expiresAt,
  closureRequiredAt,
  lastNudgeAttempt,
  lastNudgeResult,
  lastHeartbeat,
  resolution,
  targetRepo,
  chain,
  fullDetail = false,
}: QueueItemViewerData) {
  const [showFull, setShowFull] = useState(false);
  const bodyLines = body ? body.split("\n") : [];
  const visibleLines = showFull ? bodyLines : bodyLines.slice(0, PREVIEW_LINES);

  if (!qitemId) {
    return (
      <EmptyState
        label="NO QITEM"
        description="No queue item selected."
        variant="card"
        testId="queue-item-viewer-empty"
      />
    );
  }

  return (
    <div data-testid="queue-item-viewer" className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-outline-variant">
        <SectionHeader tone="muted">Queue item</SectionHeader>
        <h3 className="mt-1 font-mono text-xs text-on-surface break-all">{qitemId}</h3>
      </header>
      <div className="px-4 py-3 border-b border-outline-variant space-y-2 font-mono text-xs">
        {source || destination ? (
          <MetaRow label="Route">
            <FlowChips source={source} destination={destination} muted />
          </MetaRow>
        ) : null}
        {source ? (
          <MetaRow label="Source">
            <ActorChip session={source} muted />
          </MetaRow>
        ) : null}
        {destination ? (
          <MetaRow label="Dest">
            <ActorChip session={destination} muted />
          </MetaRow>
        ) : null}
        {state ? (
          <MetaRow label="State">
            <QueueStateBadge state={state} testId="qitem-state" />
          </MetaRow>
        ) : null}
        {tags && tags.length > 0 ? (
          <MetaRow label="Tags">
            <span className="flex min-w-0 flex-wrap justify-end gap-1">
              {tags.map((tag) => (
                <TagPill key={tag} tag={tag} />
              ))}
            </span>
          </MetaRow>
        ) : null}
        {createdAt ? (
          <MetaRow label="Created">
            <DateChip value={createdAt} />
          </MetaRow>
        ) : null}
        {updatedAt ? (
          <MetaRow label="Updated">
            <DateChip value={updatedAt} />
          </MetaRow>
        ) : null}
        {/* OPR.0.4.1.19 Tier-3 (fullDetail): every field labeled; nulls show as "—". */}
        <FieldRow label="Priority" value={priority} show={fullDetail} testId="qitem-priority" />
        <FieldRow label="Tier" value={tier} show={fullDetail} />
        {closureReason || fullDetail ? (
          <MetaRow label="Closure">
            <span data-testid="qitem-closure" className={closureReason ? "break-all text-on-surface" : "text-on-surface-variant"}>
              {closureReason ? `${closureReason}${closureTarget ? ` → ${closureTarget}` : ""}` : "—"}
            </span>
          </MetaRow>
        ) : null}
        <FieldRow label="From qitem" value={handedOffFrom} show={fullDetail} mono />
        <FieldRow label="To" value={handedOffTo} show={fullDetail} mono />
        <FieldRow label="Blocked on" value={blockedOn} show={fullDetail} mono />
        <FieldRow label="Claimed" value={claimedAt} show={fullDetail} testId="qitem-claimed" />
        <FieldRow label="Expires" value={expiresAt} show={fullDetail} />
        <FieldRow label="Closure due" value={closureRequiredAt} show={fullDetail} />
        <FieldRow label="Last nudge" value={lastNudgeAttempt} show={fullDetail} />
        <FieldRow label="Nudge result" value={lastNudgeResult} show={fullDetail} />
        <FieldRow label="Heartbeat" value={lastHeartbeat} show={fullDetail} />
        <FieldRow label="Resolution" value={resolution} show={fullDetail} />
        <FieldRow label="Target repo" value={targetRepo} show={fullDetail} testId="qitem-targetrepo" mono />
        {(chain && chain.length > 0) || fullDetail ? (
          <MetaRow label="Chain">
            {chain && chain.length > 0 ? (
              <span data-testid="qitem-chain" className="flex min-w-0 flex-col items-end gap-0.5 text-right">
                {chain.map((id, i) => (
                  <span key={`${id}-${i}`} className="break-all text-on-surface">
                    {i === 0 ? id : `↳ ${id}`}
                  </span>
                ))}
              </span>
            ) : (
              <span data-testid="qitem-chain" className="text-on-surface-variant">—</span>
            )}
          </MetaRow>
        ) : null}
      </div>
      <div className="px-4 py-3 border-b border-outline-variant flex-1 min-h-0 overflow-y-auto">
        <SectionHeader tone="muted">Body</SectionHeader>
        {body ? (
          <pre data-testid="qitem-body" className="mt-2 whitespace-pre-wrap font-mono text-xs text-on-surface">
            {visibleLines.join("\n")}
          </pre>
        ) : (
          <p className="mt-2 font-mono text-xs text-on-surface-variant italic">No body.</p>
        )}
        {body && bodyLines.length > PREVIEW_LINES ? (
          <button
            type="button"
            onClick={() => setShowFull((s) => !s)}
            data-testid="qitem-body-toggle"
            className="mt-2 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:text-on-surface underline"
          >
            {showFull ? "Show less" : `Show full body (${bodyLines.length} lines)`}
          </button>
        ) : null}
      </div>
      {related && related.length > 0 ? (
        <div className="px-4 py-3">
          <SectionHeader tone="muted">Related</SectionHeader>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {related.map((r, i) => (
              <li key={`${r.kind}-${i}`} className="flex items-baseline gap-2">
                <span className="inline-flex w-12 shrink-0 items-center gap-1 text-on-surface-variant text-[10px] uppercase tracking-wide">
                  <RelatedKindIcon kind={r.kind} label={r.label} />
                  {r.kind}
                </span>
                {r.href ? (
                  <a href={r.href} className="text-on-surface hover:underline truncate">{r.label}</a>
                ) : (
                  <span className="text-on-surface truncate">{r.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RelatedKindIcon({ kind, label }: { kind: NonNullable<QueueItemViewerData["related"]>[number]["kind"]; label: string }) {
  if (kind === "file") return <ToolMark tool={label} size="xs" />;
  if (kind === "commit") return <ToolMark tool="commit" size="xs" decorative />;
  if (kind === "slice") return <ToolMark tool="folder" size="xs" decorative />;
  return <ToolMark tool="terminal" size="xs" decorative />;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-on-surface-variant">{label}</span>
      <span className="min-w-0 text-on-surface">{children}</span>
    </div>
  );
}

// OPR.0.4.1.19 — a single scalar field. Renders when the value is present OR when
// `show` (Tier-3 fullDetail) forces the full-item view; a null value shows as "—"
// so the drawer is a faithful complete view rather than silently hiding fields.
function FieldRow({
  label,
  value,
  show,
  testId,
  mono,
}: {
  label: string;
  value?: string | null;
  show: boolean;
  testId?: string;
  mono?: boolean;
}) {
  if (!value && !show) return null;
  return (
    <MetaRow label={label}>
      <span
        data-testid={testId}
        className={value ? (mono ? "break-all text-on-surface" : "text-on-surface") : "text-on-surface-variant"}
      >
        {value ?? "—"}
      </span>
    </MetaRow>
  );
}
