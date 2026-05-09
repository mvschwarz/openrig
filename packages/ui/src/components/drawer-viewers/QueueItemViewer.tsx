// V1 attempt-3 Phase 4 — QueueItemViewer per content-drawer.md L46–L82.
//
// Renders qitem header (id + close + open-in-center) + metadata (source/
// dest/state/tags/created) + body preview (~30 lines + show-full-body)
// + Related (clickable refs).

import { useState } from "react";
import { GitBranch, GitCommitHorizontal, Network } from "lucide-react";
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
        <h3 className="mt-1 font-mono text-xs text-stone-900 break-all">{qitemId}</h3>
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
      </div>
      <div className="px-4 py-3 border-b border-outline-variant flex-1 min-h-0 overflow-y-auto">
        <SectionHeader tone="muted">Body</SectionHeader>
        {body ? (
          <pre data-testid="qitem-body" className="mt-2 whitespace-pre-wrap font-mono text-xs text-stone-900">
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
            className="mt-2 font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:text-stone-900 underline"
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
                  <a href={r.href} className="text-stone-900 hover:underline truncate">{r.label}</a>
                ) : (
                  <span className="text-stone-900 truncate">{r.label}</span>
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
  const Icon = kind === "commit" ? GitCommitHorizontal : kind === "slice" ? GitBranch : Network;
  return <Icon className="h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-on-surface-variant">{label}</span>
      <span className="min-w-0 text-stone-900">{children}</span>
    </div>
  );
}
