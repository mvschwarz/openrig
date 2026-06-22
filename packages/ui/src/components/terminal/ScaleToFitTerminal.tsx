// OPR.0.4.0.39 - scale-to-fit wrapper for the unified static/live terminal mirror.
//
// Founder spec (spec-dev2-authored-2026-06-22): the static and live terminals are
// THE SAME fixed geometry (the live xterm's 90x27). Rather than pan/clip a fixed
// 90-col block inside a narrow column, we render it at its natural width and CSS-
// transform scale the WHOLE block to fit the available space (the same wrapper
// scales BOTH the static plate and the live xterm identically, so the glass->opaque
// flip on click stays the same size in the same place - the mirror).
//
// Two fit modes (scale is measured via ResizeObserver, not guessed):
//   - "width" (default, the grid/graph/table cells): fit the available WIDTH, never
//     UPSCALE past the native geometry (cap at 1), origin top-left. The block is
//     fixed-width so this is true fit-width (the full terminal width is always
//     visible, never cut off - founder: "prefer too small over cut off"). The outer
//     height is the scaled natural height so surrounding layout flows.
//   - "contain" (the node-detail panel, which gives the terminal a big dedicated
//     area): fit BOTH width and height of the container (so the terminal fills the
//     panel as much as its 90x27 aspect allows), ALLOWING upscale up to a cap so it
//     uses the space, centered, never clipped. The off-axis margin is balanced
//     (letterboxed) instead of a top-left gap with dead space.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Upscale ceiling for "contain" mode: filling a big panel is worth a moderate
// CSS-transform upscale, but past ~2x the xterm text starts to soften, so cap it.
const MAX_CONTAIN_SCALE = 2;

interface ScaleToFitTerminalProps {
  children: ReactNode;
  /** Optional testid for the outer (fit) container. */
  testId?: string;
  className?: string;
  /**
   * "width" (default): fit available width, never upscale, top-left - for the
   * grid/graph/table cells. "contain": fit both axes of the container with upscale
   * (capped) + centered - for the node-detail panel's big dedicated area.
   */
  fit?: "width" | "contain";
}

export function ScaleToFitTerminal({ children, testId, className, fit = "width" }: ScaleToFitTerminalProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxHeight, setBoxHeight] = useState<number | undefined>(undefined);
  const contain = fit === "contain";

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const availableWidth = outer.clientWidth;
      // scrollWidth/Height report the UN-transformed natural size of the fixed
      // 90x27 block, regardless of the scale transform already applied.
      const naturalWidth = inner.scrollWidth;
      const naturalHeight = inner.scrollHeight;
      if (naturalWidth <= 0 || naturalHeight <= 0 || availableWidth <= 0) return;
      if (contain) {
        // Fit BOTH axes of the container, allow upscale (capped), keep aspect.
        const availableHeight = outer.clientHeight;
        if (availableHeight <= 0) return;
        const next = Math.min(
          MAX_CONTAIN_SCALE,
          availableWidth / naturalWidth,
          availableHeight / naturalHeight,
        );
        setScale(next);
        // Outer already fills the panel (h-full); the inner is centered by flex.
        setBoxHeight(undefined);
      } else {
        // Fit width, never upscale; reserve the scaled height so layout flows.
        const next = Math.min(1, availableWidth / naturalWidth);
        setScale(next);
        setBoxHeight(naturalHeight * next);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [contain]);

  if (contain) {
    return (
      <div
        ref={outerRef}
        data-testid={testId}
        className={
          className
            ? `flex h-full w-full items-center justify-center overflow-hidden ${className}`
            : "flex h-full w-full items-center justify-center overflow-hidden"
        }
      >
        <div
          ref={innerRef}
          style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "center center" }}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={outerRef}
      data-testid={testId}
      className={className ? `w-full overflow-hidden ${className}` : "w-full overflow-hidden"}
      style={{ height: boxHeight }}
    >
      <div
        ref={innerRef}
        style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        {children}
      </div>
    </div>
  );
}
