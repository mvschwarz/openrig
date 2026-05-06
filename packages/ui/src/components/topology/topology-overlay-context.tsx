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

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export type ExplorerMode = "overlay" | "opaque";

interface TopologyOverlayContextValue {
  mode: ExplorerMode;
  setMode: (mode: ExplorerMode) => void;
}

const TopologyOverlayContext = createContext<TopologyOverlayContextValue>({
  mode: "opaque",
  setMode: () => {},
});

export function TopologyOverlayProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ExplorerMode>("opaque");
  const setMode = useCallback((next: ExplorerMode) => {
    setModeState(next);
  }, []);
  return (
    <TopologyOverlayContext.Provider value={{ mode, setMode }}>
      {children}
    </TopologyOverlayContext.Provider>
  );
}

export function useTopologyOverlay(): TopologyOverlayContextValue {
  return useContext(TopologyOverlayContext);
}
