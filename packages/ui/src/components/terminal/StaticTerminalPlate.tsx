// OPR.0.4.0.39 - the ONE shared static-terminal component.
//
// Backs EVERY static polling-preview terminal (the topology grid card and
// ProgressiveTerminal's static mode) with the SAME borderless smoked-glass plate
// (SMOKED_STATIC_PLATE_CLASS = bg-stone-950/60 backdrop-blur) wrapping the compact
// SessionPreviewPane. The static content is translucent GLASS (bg-transparent;
// the plate shows through) - the INACTIVE state. Founder spec-correction: the
// LIVE xterm is opaque #0c0a09, and the glass->opaque flip on click-to-live is the
// intentional static-vs-live activation affordance (glass = inactive, opaque =
// live), NOT "mirror the live look". Consolidates the duplicated plate+preview
// pattern so every static terminal is consistent and upgrades to live in place.

import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { cn } from "../../lib/utils.js";

/** The borderless smoked-glass plate every static-terminal preview carries so it
 *  reads as floating glass on the truly-bare surfaces (topology tab / grid),
 *  matching the live look. Defined here as the shared static-terminal home;
 *  ProgressiveTerminal re-exports it for existing importers. */
// OPR.0.4.0.39 (founder spec-correction): the static plate reads as smoked-black
// GLASS over the LIGHT topology page. At 60% the stone-950 tint over the cream paper
// rendered a washed-out light gray (the founder's "way too washed out"); 85% reads as
// rich smoked black (matching the dialed-in graph-popover look) while keeping the glass
// translucency + backdrop-blur. The LIVE xterm is fully opaque #0c0a09, so the
// glass->opaque flip stays a visible activation affordance.
export const SMOKED_STATIC_PLATE_CLASS = "bg-stone-950/85 backdrop-blur-sm";

interface StaticTerminalPlateProps {
  sessionName: string;
  lines?: number;
  /** data-testid for the plate element (button when onClick, div otherwise). */
  plateTestId?: string;
  /** testIdPrefix passed through to the inner SessionPreviewPane. */
  previewTestIdPrefix?: string;
  className?: string;
  /** When provided, the plate is itself the click-to-live target (a button). */
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}

/**
 * The shared static-terminal plate. With `onClick` it renders as the
 * click-to-live button (ProgressiveTerminal's static mode); without it, a plain
 * plate (the topology grid thumbnail, whose click-to-live is the separate
 * TerminalPreviewPopover trigger).
 */
export function StaticTerminalPlate({
  sessionName,
  lines,
  plateTestId,
  previewTestIdPrefix,
  className,
  onClick,
  ariaLabel,
  title,
}: StaticTerminalPlateProps) {
  const preview = (
    <SessionPreviewPane
      sessionName={sessionName}
      lines={lines}
      variant="compact-terminal"
      testIdPrefix={previewTestIdPrefix}
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={plateTestId}
        aria-label={ariaLabel}
        title={title}
        onClick={onClick}
        // OPR.0.4.0.39: w-max - the plate sizes to its fixed 120-col content (not
        // fill), so the shared ScaleToFitTerminal can measure the natural width and
        // scale the whole block to the column (the static<->live geometry mirror).
        className={cn("block w-max cursor-pointer text-left", SMOKED_STATIC_PLATE_CLASS, className)}
      >
        {preview}
      </button>
    );
  }

  return (
    <div data-testid={plateTestId} className={cn("w-max", SMOKED_STATIC_PLATE_CLASS, className)}>
      {preview}
    </div>
  );
}
