// V1 attempt-3 Phase 2 — viewport-detection hook (per code-map AFTER tree).
//
// V1 attempt-3 Phase 5 P5-9: extracted as a standalone hook so non-AppShell
// surfaces (TopologyTerminalView, topology ScopePages) can degrade
// gracefully on mobile without prop-drilling isWideLayout from AppShell.
// Same WIDE_LAYOUT_BREAKPOINT (1024px) as AppShell — keeps the breakpoint
// in lockstep across consumers.

import { useEffect, useState } from "react";

const WIDE_LAYOUT_BREAKPOINT = 1024;

export interface ShellViewport {
  /** True when window.innerWidth >= 1024px (Tailwind lg breakpoint). */
  isWideLayout: boolean;
  /** Live innerWidth in px; useful for mid-band decisions (e.g., 768
   *  iPad-portrait breakpoint between mobile and desktop). */
  innerWidth: number;
}

export function useShellViewport(): ShellViewport {
  const [state, setState] = useState<ShellViewport>(() => {
    if (typeof window === "undefined") {
      return { isWideLayout: true, innerWidth: WIDE_LAYOUT_BREAKPOINT };
    }
    return {
      isWideLayout: window.innerWidth >= WIDE_LAYOUT_BREAKPOINT,
      innerWidth: window.innerWidth,
    };
  });

  useEffect(() => {
    const handleResize = () => {
      setState({
        isWideLayout: window.innerWidth >= WIDE_LAYOUT_BREAKPOINT,
        innerWidth: window.innerWidth,
      });
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return state;
}
