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
import { cn } from "../../lib/utils.js";

interface SessionPreviewPaneProps {
  sessionName: string;
  lines?: number;
  paused?: boolean;
  testIdPrefix?: string;
  variant?: "default" | "compact-terminal";
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
}

export function SessionPreviewPane({
  sessionName,
  lines,
  paused,
  testIdPrefix = "session-preview",
  variant = "default",
}: SessionPreviewPaneProps) {
  const preview = useSessionPreview({ sessionName, lines, paused });
  const contentRef = useRef<HTMLPreElement | null>(null);
  const shouldFollowTailRef = useRef(true);
  const content = !isNodePreviewUnavailable(preview.data) ? preview.data?.content : undefined;
  const compactTerminal = variant === "compact-terminal";

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
      data-variant={variant}
      className={cn(
        "space-y-1",
        compactTerminal
          ? "border-0 bg-transparent p-0 text-stone-50"
          : "border border-stone-300/40 bg-white/8 px-3 py-2",
      )}
    >
      {!compactTerminal && (
        <div className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-500 truncate">
          live preview · {sessionName}
        </div>
      )}
      {preview.isLoading && (
        <div data-testid={`${testIdPrefix}-loading`} className="font-mono text-[9px] text-stone-400">Loading…</div>
      )}
      {preview.isError && (
        <div
          data-testid={`${testIdPrefix}-error`}
          className={cn("font-mono text-[9px]", compactTerminal ? "text-red-200" : "text-red-600")}
        >
          {(preview.error as Error)?.message ?? "Preview failed."}
        </div>
      )}
      {isNodePreviewUnavailable(preview.data) && (
        <div
          data-testid={`${testIdPrefix}-unavailable`}
          className={cn(
            "font-mono space-y-0.5",
            compactTerminal ? "text-[10px] text-stone-50" : "text-[9px] text-stone-500",
          )}
        >
          {compactTerminal ? (
            <>
              <div>Preview unavailable.</div>
              <div className="text-stone-400">$ waiting for terminal output</div>
            </>
          ) : (
            <>
              <div>Preview unavailable: {preview.data.reason}.</div>
              {preview.data.hint && (
                <div className="text-stone-400">{preview.data.hint}</div>
              )}
              <div className="text-stone-400">
                Use <code>rig capture {sessionName}</code> from terminal as a fallback.
              </div>
            </>
          )}
        </div>
      )}
      {!isNodePreviewUnavailable(preview.data) && preview.data && (
        <>
          <pre
            ref={contentRef}
            data-testid={`${testIdPrefix}-content`}
            onScroll={handleScroll}
            className={cn(
            "font-mono overflow-y-auto whitespace-pre-wrap break-all",
            compactTerminal
                ? "max-h-72 bg-transparent px-1 py-0.5 text-[8px] leading-[1.2] text-stone-50"
                : "max-h-32 bg-stone-50 px-2 py-1 text-[9px] text-stone-800",
            )}
          >
            {preview.data.content || "(empty pane)"}
          </pre>
          {!compactTerminal && (
            <div className="font-mono text-[8px] text-stone-400 flex justify-between">
              <span>
                captured{" "}
                {new Date(preview.data.capturedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span>{preview.data.lines} lines</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
