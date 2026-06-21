import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { FocusedTerminal } from "../terminal/FocusedTerminal.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { cn } from "../../lib/utils.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;
const FALLBACK_POPOVER_WIDTH = 408;
const FALLBACK_POPOVER_HEIGHT = 240;

interface TerminalPreviewEventDetail {
  key: string;
}

interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PopoverPosition {
  left: number;
  top: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface TerminalPreviewPopoverProps {
  rigId: string | null | undefined;
  logicalId: string;
  sessionName: string | null | undefined;
  reducedMotion?: boolean;
  wrapperClassName?: string;
  buttonClassName?: string;
  popoverClassName?: string;
  testIdPrefix: string;
  /** V0.3.1 slice 14 forward-fix #1 (a11y): when false, the popover
   *  does NOT render its own trigger button. Used by surfaces that
   *  own the trigger externally (e.g., TerminalView cards where the
   *  whole card acts as the trigger) so the popover doesn't add a
   *  duplicate keyboard tab stop. Default true preserves the
   *  existing graph-view + table-view button rendering. */
  renderTrigger?: boolean;
  /** OPR.0.4.0.1: when true, the popover renders the progressive default-static
   *  -> click-to-go-live ProgressiveTerminal (the topology graph/table surfaces).
   *  Default false keeps the always-live FocusedTerminal, preserving the
   *  feed-card live-drill (out of this slice's 3-surface scope). */
  progressive?: boolean;
}

function rectFromElement(el: HTMLElement | null): AnchorRect {
  const rect = el?.getBoundingClientRect();
  return {
    left: rect?.left ?? POPOVER_MARGIN,
    right: rect?.right ?? POPOVER_MARGIN,
    top: rect?.top ?? POPOVER_MARGIN,
    bottom: rect?.bottom ?? POPOVER_MARGIN,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeTerminalPopoverPosition(
  anchor: AnchorRect,
  width: number,
  height: number,
  viewport?: ViewportSize,
): PopoverPosition {
  const viewportWidth = viewport?.width ?? (typeof window === "undefined" ? width + POPOVER_MARGIN * 2 : window.innerWidth);
  const viewportHeight = viewport?.height ?? (typeof window === "undefined" ? height + POPOVER_MARGIN * 2 : window.innerHeight);
  const rightSideLeft = anchor.right + POPOVER_GAP;
  const leftSideLeft = anchor.left - width - POPOVER_GAP;
  const left = rightSideLeft + width <= viewportWidth - POPOVER_MARGIN ? rightSideLeft : leftSideLeft;
  const preferredTop = anchor.top;
  const aboveTop = anchor.top - height - POPOVER_GAP;
  const top = preferredTop + height <= viewportHeight - POPOVER_MARGIN
    ? preferredTop
    : aboveTop >= POPOVER_MARGIN
      ? aboveTop
      : viewportHeight - height - POPOVER_MARGIN;
  return {
    left: clamp(left, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN)),
    top: clamp(top, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportHeight - height - POPOVER_MARGIN)),
  };
}

export function TerminalPreviewPopover({
  rigId,
  logicalId,
  sessionName,
  reducedMotion,
  wrapperClassName,
  buttonClassName,
  popoverClassName,
  testIdPrefix,
  renderTrigger = true,
  progressive = false,
}: TerminalPreviewPopoverProps) {
  const key = `${rigId ?? "unknown"}:${logicalId}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (!open) return;
    const nextAnchor = rectFromElement(rootRef.current);
    const width = popoverRef.current?.offsetWidth || FALLBACK_POPOVER_WIDTH;
    const height = popoverRef.current?.offsetHeight || FALLBACK_POPOVER_HEIGHT;
    setPosition(computeTerminalPopoverPosition(nextAnchor, width, height));
  }, [open]);

  useEffect(() => {
    // OPR.0.4.0.1 (rev1-r2 fix): progressive popovers open via LOCAL state and
    // COEXIST under the global LiveTerminalRegistry cap, so they do NOT take part
    // in the single-open TERMINAL_PREVIEW_EVENT -- which force-closes every
    // sibling popover and would cap the popover surfaces at one live terminal.
    // Only the non-progressive feed-card drill keeps the one-overlay-at-a-time
    // single-open behavior.
    if (progressive) return undefined;
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<TerminalPreviewEventDetail>).detail;
      const nextOpen = detail?.key === key;
      setOpen(nextOpen);
      if (nextOpen) {
        const nextAnchor = rectFromElement(rootRef.current);
        setPosition(computeTerminalPopoverPosition(nextAnchor, FALLBACK_POPOVER_WIDTH, FALLBACK_POPOVER_HEIGHT));
      }
    };
    window.addEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
    return () => window.removeEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
  }, [key, progressive]);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const handleViewportChange = () => updatePosition();
    const observer = typeof ResizeObserver === "undefined" || !popoverRef.current
      ? null
      : new ResizeObserver(handleViewportChange);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      // OPR.0.4.0.1 (rev1-r2 fix): a progressive popover must NOT dismiss when the
      // pointerdown lands inside ANY terminal-preview surface (a sibling popover or
      // trigger) -- otherwise interacting with B would close A, breaking multi-live.
      // Only a click fully outside the terminal-preview system dismisses it.
      if (progressive) {
        const el = target instanceof Element ? target : target.parentElement;
        if (el?.closest("[data-terminal-preview-surface]")) return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (!sessionName) return null;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (progressive) {
      // Toggle THIS popover's own open state; do not touch siblings -- multiple
      // progressive popovers can be open/live at once under the global cap.
      if (open) {
        setOpen(false);
        return;
      }
      const nextAnchor = rectFromElement(rootRef.current);
      setPosition(computeTerminalPopoverPosition(nextAnchor, FALLBACK_POPOVER_WIDTH, FALLBACK_POPOVER_HEIGHT));
      setOpen(true);
      return;
    }
    window.dispatchEvent(new CustomEvent<TerminalPreviewEventDetail>(TERMINAL_PREVIEW_EVENT, { detail: { key } }));
  };

  const popover = open && position ? createPortal(
    <div
      ref={popoverRef}
      data-testid={`${testIdPrefix}-terminal-popover`}
      data-terminal-preview-surface=""
      data-reduced-motion={reducedMotion ? "true" : "false"}
      className={cn(
        "nodrag nopan fixed z-[1000] max-h-[calc(100vh-1rem)] w-[calc(80ch+24px)] max-w-[calc(100vw-1rem)] overflow-hidden bg-stone-950/65 p-1.5 backdrop-blur-sm",
        "cursor-default select-text font-mono text-[8px] text-stone-50",
        popoverClassName,
      )}
      style={{ left: position.left, top: position.top }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* OPR.0.4.0.1: progressive surfaces show default-static -> click-to-go-live;
          a wider optimal terminal width per the styling finding. Non-progressive
          consumers (feed-card live drill) keep the always-live FocusedTerminal. */}
      <div className="h-[440px] w-[820px] max-w-[calc(100vw-2rem)]">
        {progressive ? (
          <ProgressiveTerminal sessionName={sessionName} terminalKey={key} testIdPrefix={testIdPrefix} />
        ) : (
          <FocusedTerminal sessionName={sessionName} />
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} data-terminal-preview-surface="" className={cn("relative inline-flex", wrapperClassName)}>
      {renderTrigger ? (
        <button
          type="button"
          data-testid={`${testIdPrefix}-terminal-open`}
          aria-label={`View ${logicalId} terminal`}
          title="View terminal"
          onClick={openPreview}
          className={buttonClassName}
        >
          <ToolMark tool="terminal" size="sm" />
        </button>
      ) : null}
      {popover}
    </div>
  );
}
