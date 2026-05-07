// V1 attempt-3 Phase 4 — QueueItemViewer per content-drawer.md L46–L82.
//
// Renders qitem header (id + close + open-in-center) + metadata (source/
// dest/state/tags/created) + body preview (~30 lines + show-full-body)
// + Related (clickable refs).

import { useState } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { StatusPip } from "../ui/status-pip.js";
import { EmptyState } from "../ui/empty-state.js";

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

function statusFromState(state: string | undefined): React.ComponentProps<typeof StatusPip>["status"] {
  if (!state) return "info";
  if (state === "done" || state === "completed") return "active";
  if (state === "in-progress" || state === "running") return "running";
  if (state === "failed" || state === "error" || state === "denied") return "error";
  if (state === "blocked" || state === "human-gate" || state === "pending-approval") return "warning";
  if (state === "stopped" || state === "canceled") return "stopped";
  return "info";
}

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
      <div className="px-4 py-3 border-b border-outline-variant space-y-1.5 font-mono text-xs">
        {source ? <Row label="Source" value={source} /> : null}
        {destination ? <Row label="Dest" value={destination} /> : null}
        {state ? (
          <div className="flex items-center justify-between">
            <span className="text-on-surface-variant">State</span>
            <StatusPip status={statusFromState(state)} label={state} variant="pill" testId="qitem-state" />
          </div>
        ) : null}
        {tags && tags.length > 0 ? (
          <Row label="Tags" value={tags.join(", ")} />
        ) : null}
        {createdAt ? <Row label="Created" value={createdAt.slice(0, 19).replace("T", " ")} /> : null}
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
                <span className="text-on-surface-variant text-[10px] uppercase tracking-wide w-12 shrink-0">
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-on-surface-variant">{label}</span>
      <span className="text-stone-900 truncate">{value}</span>
    </div>
  );
}
