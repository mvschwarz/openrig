// OPR.0.4.0.1 — the ONE reusable progressive-live terminal (AC-3).
//
// Default-static -> click-inside-to-go-live (founder directive): on open it shows
// the cheap static polling preview (SessionPreviewPane); a click anywhere inside
// upgrades THAT terminal to a live, typeable FocusedTerminal. Going live consults
// the global LiveTerminalProvider cap: if over MAX_LIVE_TERMINALS the OLDEST live
// terminal is evicted back to static (its revert callback runs, closing its WS).
// Static previews are uncapped (cheap polling). Used by all three surfaces.

import { useCallback, useEffect, useRef, useState } from "react";
import { FocusedTerminal } from "./FocusedTerminal.js";
import { StaticTerminalPlate } from "./StaticTerminalPlate.js";
import { ScaleToFitTerminal } from "./ScaleToFitTerminal.js";
import { useLiveTerminal } from "./LiveTerminalProvider.js";

// OPR.0.4.0.39: the static fetches a deeper history than the visible landscape window
// so you can SCROLL BACK through it (the compact <pre> caps the visible height with
// max-h + overflow-y); the live xterm scrolls its own buffer.
const STATIC_HISTORY_LINES = 100;

// OPR.0.4.0.39 FR-1: the shared static-terminal plate now owns
// SMOKED_STATIC_PLATE_CLASS; re-export here for existing importers.
export { SMOKED_STATIC_PLATE_CLASS } from "./StaticTerminalPlate.js";

interface ProgressiveTerminalProps {
  sessionName: string;
  /** Stable global key for the cap registry (e.g. `${rigId}:${logicalId}`). */
  terminalKey: string;
  lines?: number;
  testIdPrefix?: string;
  className?: string;
  /** OPR.0.4.0.1: notified when this terminal flips static<->live, so a host
   *  (e.g. the popover) can size its shell to the wide live plate when live and
   *  stay compact when static. */
  onLiveChange?: (isLive: boolean) => void;
  /** OPR.0.4.0.39: scale-to-fit mode. "width" (default) fits the column width and
   *  never upscales (grid/graph/table cells). "contain" fills a big dedicated
   *  container on both axes (capped upscale, centered) - the node-detail panel. */
  fit?: "width" | "contain";
}

export function ProgressiveTerminal({
  sessionName,
  terminalKey,
  // OPR.0.4.0.39: fetch deeper history so the static landscape window can scroll back.
  lines = STATIC_HISTORY_LINES,
  testIdPrefix = "progressive-terminal",
  className,
  onLiveChange,
  fit = "width",
}: ProgressiveTerminalProps) {
  const [mode, setMode] = useState<"static" | "live">("static");
  const live = useLiveTerminal();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const goStatic = useCallback(() => setMode("static"), []);

  // OPR.0.4.0.1: surface the live/static mode to the host so a popover can widen
  // its shell to the full live plate when live and stay compact when static.
  useEffect(() => {
    onLiveChange?.(mode === "live");
  }, [mode, onLiveChange]);

  const goLive = useCallback(() => {
    if (modeRef.current === "live") return;
    // requestLive may evict the OLDEST live terminal (reverting it to static).
    live.requestLive(terminalKey, goStatic);
    setMode("live");
  }, [live, terminalKey, goStatic]);

  // Free the registry slot whenever we leave live (unmount or revert-to-static).
  // release() is idempotent, so an eviction (which already removed the key) is safe.
  useEffect(() => {
    if (mode !== "live") return undefined;
    return () => live.release(terminalKey);
  }, [mode, live, terminalKey]);

  // OPR.0.4.0.39 (founder spec): static and live are the SAME 120x40 geometry, both
  // wrapped in the shared ScaleToFitTerminal so they scale identically to the column
  // (fit-width, never clip). The glass->opaque flip on click is the only change - the
  // live xterm appears at the same size in the same place (the mirror).
  if (mode === "live") {
    return (
      <ScaleToFitTerminal testId={`${testIdPrefix}-fit`} className={className} fit={fit}>
        {/* The live div sizes to the xterm's natural 90x40 geometry (FocusedTerminal
            is w-max); ScaleToFitTerminal scales it to the cell, matching the static
            plate exactly - the glass->opaque flip stays the same size in place. */}
        <div data-testid={`${testIdPrefix}-live`}>
          <FocusedTerminal sessionName={sessionName} />
        </div>
      </ScaleToFitTerminal>
    );
  }

  // Static default: the whole preview is the click target to go live. The shared
  // StaticTerminalPlate carries the translucent smoked-GLASS plate + transparent
  // compact content at the 120-col geometry (FR-1/FR-2); clicking flips it to the
  // OPAQUE #0c0a09 live xterm in place - the glass->opaque activation affordance.
  return (
    <ScaleToFitTerminal testId={`${testIdPrefix}-fit`} className={className} fit={fit}>
      <StaticTerminalPlate
        sessionName={sessionName}
        lines={lines}
        plateTestId={`${testIdPrefix}-static`}
        previewTestIdPrefix={`${testIdPrefix}-preview`}
        onClick={goLive}
        ariaLabel={`Make ${sessionName} terminal live (typeable)`}
        title="Click to go live (typeable)"
      />
    </ScaleToFitTerminal>
  );
}
