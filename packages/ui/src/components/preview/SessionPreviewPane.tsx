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

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useSessionPreview, isNodePreviewUnavailable } from "../../hooks/useNodePreview.js";
import { cn } from "../../lib/utils.js";
import {
  LIVE_TERMINAL_COLS,
  LIVE_TERMINAL_FONT_FAMILY,
  LIVE_TERMINAL_FONT_SIZE,
  LIVE_TERMINAL_LINE_HEIGHT,
} from "../terminal/terminal-geometry.js";

// OPR.0.4.0.39: the compact static terminal mirrors the LIVE xterm geometry exactly
// (same font + 90-col width) so static and live are the SAME shape under the shared
// ScaleToFitTerminal scaler - only glass (static) vs opaque (live) differs. Width is a
// fixed 90ch (the live 90-col grid), so the box is always the terminal width
// regardless of how short the captured lines are - just like a real 90-col terminal.
const STATIC_TERMINAL_GEOMETRY: CSSProperties = {
  fontFamily: LIVE_TERMINAL_FONT_FAMILY,
  fontSize: `${LIVE_TERMINAL_FONT_SIZE}px`,
  lineHeight: LIVE_TERMINAL_LINE_HEIGHT,
  width: `${LIVE_TERMINAL_COLS}ch`,
};

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
        // OPR.0.4.0.39 FR-1 (founder spec-correction): the compact STATIC content is
        // translucent smoked-GLASS - it lets the caller's SMOKED_STATIC_PLATE_CLASS
        // (bg-stone-950/85 backdrop-blur) show through (bg-transparent), NOT opaque.
        // The static <pre> is not an xterm, so it has no cursor-safety reason to be
        // opaque; opaque #0c0a09 is the LIVE xterm only, and the glass->opaque flip
        // on click-to-live is the intentional static-vs-live activation affordance.
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
            style={compactTerminal ? STATIC_TERMINAL_GEOMETRY : undefined}
            className={cn(
              "font-mono",
              // OPR.0.4.0.39 FR-1/FR-4/FR-5 (founder spec): the compact static renders
              // at the LIVE xterm geometry (STATIC_TERMINAL_GEOMETRY: same font, fixed
              // 100-col width) so static and live are the SAME shape - the shared
              // ScaleToFitTerminal scales the whole fixed block to the column (fit-
              // width, never clip; no overflow-x pan/cut-off). whitespace-pre renders
              // the captured lines as-is (no re-wrap = correct line returns; FR-5).
              // bg-transparent = the smoked GLASS plate shows through (FR-2); opaque
              // #0c0a09 is the LIVE xterm only - the glass->opaque flip is the affordance.
              compactTerminal
                ? "scrollbar-none max-h-[420px] overflow-y-auto whitespace-pre bg-transparent text-stone-50"
                : "max-h-32 overflow-y-auto whitespace-pre-wrap break-all bg-stone-50 px-2 py-1 text-[9px] text-stone-800",
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
