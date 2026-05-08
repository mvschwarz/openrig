import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { Terminal } from "lucide-react";
import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { cn } from "../../lib/utils.js";

const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;
const FALLBACK_POPOVER_WIDTH = 560;
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

function computePopoverPosition(anchor: AnchorRect, width: number, height: number): PopoverPosition {
  const viewportWidth = window.innerWidth || width + POPOVER_MARGIN * 2;
  const viewportHeight = window.innerHeight || height + POPOVER_MARGIN * 2;
  const rightSideLeft = anchor.right + POPOVER_GAP;
  const leftSideLeft = anchor.left - width - POPOVER_GAP;
  const left = rightSideLeft + width <= viewportWidth - POPOVER_MARGIN ? rightSideLeft : leftSideLeft;
  return {
    left: clamp(left, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN)),
    top: clamp(anchor.top, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportHeight - height - POPOVER_MARGIN)),
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
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<TerminalPreviewEventDetail>).detail;
      const nextOpen = detail?.key === key;
      setOpen(nextOpen);
      if (nextOpen) {
        const nextAnchor = rectFromElement(rootRef.current);
        setAnchorRect(nextAnchor);
        setPosition(computePopoverPosition(nextAnchor, FALLBACK_POPOVER_WIDTH, FALLBACK_POPOVER_HEIGHT));
      }
    };
    window.addEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
    return () => window.removeEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
  }, [key]);

  useLayoutEffect(() => {
    if (!open || !anchorRect || !popoverRef.current) return;
    setPosition(computePopoverPosition(anchorRect, popoverRef.current.offsetWidth, popoverRef.current.offsetHeight));
  }, [anchorRect, open]);

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
        "nodrag nopan fixed z-[1000] w-[112ch] max-w-[calc(100vw-1rem)] bg-stone-950/65 p-1.5 backdrop-blur-sm",
        "cursor-default select-text text-stone-50",
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
