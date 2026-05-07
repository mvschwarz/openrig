import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Terminal, X } from "lucide-react";
import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { cn } from "../../lib/utils.js";

const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";

interface TerminalPreviewEventDetail {
  key: string;
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
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<TerminalPreviewEventDetail>).detail;
      setOpen(detail?.key === key);
    };
    window.addEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
    return () => window.removeEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
  }, [key]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (!sessionName) return null;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent<TerminalPreviewEventDetail>(TERMINAL_PREVIEW_EVENT, { detail: { key } }));
  };

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
      {open ? (
        <div
          data-testid={`${testIdPrefix}-terminal-popover`}
          data-reduced-motion={reducedMotion ? "true" : "false"}
          className={cn(
            "nodrag nopan absolute left-full top-0 z-[80] ml-2 w-80 border border-stone-900 bg-white p-2 hard-shadow",
            "cursor-default select-text",
            popoverClassName,
          )}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="truncate font-mono text-[8px] uppercase tracking-[0.14em] text-stone-500">
              terminal preview
            </div>
            <button
              type="button"
              data-testid={`${testIdPrefix}-terminal-close`}
              aria-label="Close terminal preview"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
              }}
              className="inline-flex h-5 w-5 items-center justify-center border border-outline-variant bg-white text-stone-600 hover:bg-stone-100 hover:text-stone-950 focus:outline-none focus:ring-2 focus:ring-stone-900/20"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
          <SessionPreviewPane sessionName={sessionName} lines={80} testIdPrefix={`${testIdPrefix}-terminal-preview`} />
        </div>
      ) : null}
    </div>
  );
}
