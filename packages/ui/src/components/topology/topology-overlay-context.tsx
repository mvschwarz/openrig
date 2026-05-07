// V1 attempt-3 Phase 3 bounce-fix — Class B TopologyOverlayContext.
//
// Topology destination signature: when the active view-mode is GRAPH,
// the Explorer renders as a vellum-translucent overlay floating over
// the canvas (sheets-of-vellum-layered aesthetic per universal-shell.md
// L48). Center workspace canvas extends to the viewport-left edge
// underneath the Explorer overlay.
//
// When the active view-mode is TABLE / TERMINAL (or any non-topology
// destination), the Explorer is opaque (default behavior); center
// workspace starts at the Explorer's right edge.
//
// View-mode tab bar anchors at fixed left = rail (48px) + explorer
// (280px) = 328px = var(--explorer-anchor-left). Independent of mode,
// so tabs never jump position between graph / table / terminal switches.
//
// V1 polish slice Phase 5.2 bounce-fix — rig-collapse state persistence.
// Phase 5.2 Item 6 auto-expand was dead code: HostMultiRigGraph held
// `expanded` as local useState, and the activeRigId useEffect only
// fired when HostMultiRigGraph itself was mounted. But topology routes
// are SIBLING (not nested), so /topology/rig/$id renders RigScopePage,
// NOT HostMultiRigGraph — the effect never ran for direct-URL entry.
// Navigating back to /topology re-mounted HostMultiRigGraph fresh with
// an empty Map. Fix: lift the expanded Map into this provider so the
// state survives HostScopePage unmount/remount cycles, and run the
// auto-expand useEffect at provider scope (always mounted under
// AppShell) so URL-driven expansion fires regardless of which scope
// page is currently in the center.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";

export type ExplorerMode = "overlay" | "opaque";

interface TopologyOverlayContextValue {
  mode: ExplorerMode;
  setMode: (mode: ExplorerMode) => void;
  /** V1 polish slice Phase 5.2 — rig-expanded state persisted at provider
   *  scope so HostMultiRigGraph mount/unmount cycles don't reset the
   *  collapse map. Default empty → all rigs collapsed. */
  expandedRigs: ReadonlyMap<string, boolean>;
  /** Idempotent setter: explicitly mark a rig expanded or collapsed.
   *  Used by the URL-driven auto-expand effect (always sets true) and
   *  by direct programmatic control. */
  setRigExpanded: (rigId: string, expanded: boolean) => void;
  /** Click-toggle: flip a rig's expanded state. Used by RigGroupNode
   *  body click. */
  toggleRig: (rigId: string) => void;
}

const TopologyOverlayContext = createContext<TopologyOverlayContextValue>({
  mode: "opaque",
  setMode: () => {},
  expandedRigs: new Map(),
  setRigExpanded: () => {},
  toggleRig: () => {},
});

/** Parse an active-rig identifier from the topology pathname. Used by
 *  the provider's auto-expand effect AND by consumers that need to
 *  know which rig the URL is currently scoped to (e.g., for active-row
 *  highlighting). Returns null when the pathname isn't on a rig-scoped
 *  route. */
export function parseActiveRigId(pathname: string): string | null {
  const seat = pathname.match(/^\/topology\/seat\/([^/]+)\//);
  if (seat) return decodeURIComponent(seat[1]!);
  const pod = pathname.match(/^\/topology\/pod\/([^/]+)\//);
  if (pod) return decodeURIComponent(pod[1]!);
  const rig = pathname.match(/^\/topology\/rig\/([^/]+)$/);
  if (rig) return decodeURIComponent(rig[1]!);
  return null;
}

export function TopologyOverlayProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ExplorerMode>("opaque");
  const setMode = useCallback((next: ExplorerMode) => {
    setModeState(next);
  }, []);

  // V1 polish slice Phase 5.2 bounce-fix — rig-expanded state lifted to
  // provider scope so direct-URL navigation (where HostMultiRigGraph
  // isn't mounted because routes are SIBLING) still updates the state
  // that HostMultiRigGraph reads when the user returns to /topology.
  const [expandedRigs, setExpandedRigs] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const setRigExpanded = useCallback((rigId: string, expanded: boolean) => {
    setExpandedRigs((prev) => {
      if (prev.has(rigId) && prev.get(rigId) === expanded) return prev;
      const next = new Map(prev);
      next.set(rigId, expanded);
      return next;
    });
  }, []);
  const toggleRig = useCallback((rigId: string) => {
    setExpandedRigs((prev) => {
      const next = new Map(prev);
      next.set(rigId, !(prev.get(rigId) ?? false));
      return next;
    });
  }, []);

  // Auto-expand effect at provider scope. Reads pathname via
  // useRouterState (provider sits inside RouterProvider tree under
  // AppShell). Whenever the route is on a rig-scoped topology URL,
  // mark the matching rig expanded. Fires regardless of which center
  // scope page is currently mounted — solves the dead-code bug from
  // the prior in-component auto-expand.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const rigId = parseActiveRigId(pathname);
    if (rigId) setRigExpanded(rigId, true);
  }, [pathname, setRigExpanded]);

  const value = useMemo<TopologyOverlayContextValue>(
    () => ({ mode, setMode, expandedRigs, setRigExpanded, toggleRig }),
    [mode, setMode, expandedRigs, setRigExpanded, toggleRig],
  );

  return (
    <TopologyOverlayContext.Provider value={value}>
      {children}
    </TopologyOverlayContext.Provider>
  );
}

export function useTopologyOverlay(): TopologyOverlayContextValue {
  return useContext(TopologyOverlayContext);
}
