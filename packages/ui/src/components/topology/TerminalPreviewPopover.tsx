import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { Terminal } from "lucide-react";
import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { cn } from "../../lib/utils.js";

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
  }, [key]);

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
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (!sessionName) return null;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent<TerminalPreviewEventDetail>(TERMINAL_PREVIEW_EVENT, { detail: { key } }));
  };

  const popover = open && position ? createPortal(
    <div
      ref={popoverRef}
      data-testid={`${testIdPrefix}-terminal-popover`}
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
      <SessionPreviewPane
        sessionName={sessionName}
        lines={80}
        testIdPrefix={`${testIdPrefix}-terminal-preview`}
        variant="compact-terminal"
      />
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} className={cn("relative inline-flex", wrapperClassName)}>
      <button
        type="button"
        data-testid={`${testIdPrefix}-terminal-open`}
        aria-label={`View ${logicalId} terminal`}
        title="View terminal"
        onClick={openPreview}
        className={buttonClassName}
      >
        <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {popover}
    </div>
  );
}
