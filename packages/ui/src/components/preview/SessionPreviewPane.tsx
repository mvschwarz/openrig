// Preview Terminal v0 (PL-018) — session-keyed preview pane.
//
// Same shape as PreviewPane but addressed by sessionName. Used by
// surfaces that hold a sessionName but not a (rigId, logicalId) pair
// — Steering Loop State panel, Slice Story View Topology tab.
//
// No Pin button at v0 for the session-keyed variant: pinning belongs
// in the topology drawer flow where the operator can navigate to the
// node-detail context. Operator dogfood reports needing pin from
// Loop State / Topology tab → NAMED v0+1 trigger.

import { useLayoutEffect, useRef } from "react";
import { useSessionPreview, isNodePreviewUnavailable } from "../../hooks/useNodePreview.js";

interface SessionPreviewPaneProps {
  sessionName: string;
  lines?: number;
  paused?: boolean;
  testIdPrefix?: string;
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
}

export function SessionPreviewPane({ sessionName, lines, paused, testIdPrefix = "session-preview" }: SessionPreviewPaneProps) {
  const preview = useSessionPreview({ sessionName, lines, paused });
  const contentRef = useRef<HTMLPreElement | null>(null);
  const shouldFollowTailRef = useRef(true);
  const content = !isNodePreviewUnavailable(preview.data) ? preview.data?.content : undefined;

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || !preview.data || isNodePreviewUnavailable(preview.data)) return;
    if (shouldFollowTailRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content, preview.data]);

  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    shouldFollowTailRef.current = isNearBottom(el);
  };

  return (
    <div
      data-testid={`${testIdPrefix}-pane`}
      data-session-name={sessionName}
      className="border border-stone-300/40 bg-white/8 px-3 py-2 space-y-1"
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500 truncate">
        live preview · {sessionName}
      </div>
      {preview.isLoading && (
        <div data-testid={`${testIdPrefix}-loading`} className="font-mono text-[9px] text-stone-400">Loading…</div>
      )}
      {preview.isError && (
        <div data-testid={`${testIdPrefix}-error`} className="font-mono text-[9px] text-red-600">
          {(preview.error as Error)?.message ?? "Preview failed."}
        </div>
      )}
      {isNodePreviewUnavailable(preview.data) && (
        <div data-testid={`${testIdPrefix}-unavailable`} className="font-mono text-[9px] text-stone-500 space-y-0.5">
          <div>Preview unavailable: {preview.data.reason}.</div>
          {preview.data.hint && <div className="text-stone-400">{preview.data.hint}</div>}
          <div className="text-stone-400">Use <code>rig capture {sessionName}</code> from terminal as a fallback.</div>
        </div>
      )}
      {!isNodePreviewUnavailable(preview.data) && preview.data && (
        <>
          <pre
            ref={contentRef}
            data-testid={`${testIdPrefix}-content`}
            onScroll={handleScroll}
            className="font-mono text-[9px] text-stone-800 bg-stone-50 px-2 py-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {preview.data.content || "(empty pane)"}
          </pre>
          <div className="font-mono text-[8px] text-stone-400 flex justify-between">
            <span>captured {new Date(preview.data.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span>{preview.data.lines} lines</span>
          </div>
        </>
      )}
    </div>
  );
}
