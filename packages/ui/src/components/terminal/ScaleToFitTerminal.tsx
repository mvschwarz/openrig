// OPR.0.4.0.39 - scale-to-fit wrapper for the unified static/live terminal mirror.
//
// Founder spec (spec-dev2-authored-2026-06-22): the static and live terminals are
// THE SAME fixed geometry (the live xterm's 120x40). Rather than pan/clip a fixed
// 120-col block inside a narrow column, we render it at its natural width and CSS-
// transform scale the WHOLE block down to fit the available width (origin top-left).
// Because the block is fixed-width, this is true fit-width: the full terminal width
// is always visible, never cut off (founder: "prefer too small over cut off"). The
// same wrapper scales BOTH the static plate and the live xterm identically, so the
// glass->opaque flip on click stays the same size in the same place (the mirror).
//
// Scale is measured (ResizeObserver), not guessed per-breakpoint, so it fits any
// column width (grid cell / graph node / table cell) cleanly. Capped at 1 (never
// upscale past the native geometry).

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface ScaleToFitTerminalProps {
  children: ReactNode;
  /** Optional testid for the outer (fit) container. */
  testId?: string;
  className?: string;
}

export function ScaleToFitTerminal({ children, testId, className }: ScaleToFitTerminalProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxHeight, setBoxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const available = outer.clientWidth;
      // scrollWidth/Height report the UN-transformed natural size of the fixed
      // 120-col block, regardless of the scale transform already applied.
      const naturalWidth = inner.scrollWidth;
      const naturalHeight = inner.scrollHeight;
      if (naturalWidth <= 0 || available <= 0) return;
      const next = Math.min(1, available / naturalWidth);
      setScale(next);
      // Reserve the scaled height so surrounding layout flows (transforms do not
      // affect layout box).
      setBoxHeight(naturalHeight * next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

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
