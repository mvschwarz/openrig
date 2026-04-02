import { type CSSProperties, type ReactNode, useCallback, useEffect, useState, createContext, useContext } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Cog, FileText, SquarePlus } from "lucide-react";
import { Explorer } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import type { DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";
import { useRigSummary } from "../hooks/useRigSummary.js";
import { shortId } from "../lib/display-id.js";

// -- Shared drawer selection context --

interface DrawerSelectionContextValue {
  selection: DrawerSelection;
  setSelection: (sel: DrawerSelection) => void;
}

interface ExplorerVisibilityContextValue {
  openExplorer: () => void;
}

interface DiscoveryPlacementContextValue {
  selectedDiscoveredId: string | null;
  setSelectedDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  setPlacementTarget: (target: DiscoveryPlacementTarget) => void;
  clearPlacement: () => void;
}

export const DrawerSelectionContext = createContext<DrawerSelectionContextValue>({
  selection: null,
  setSelection: () => {},
});

export const ExplorerVisibilityContext = createContext<ExplorerVisibilityContextValue>({
  openExplorer: () => {},
});

export const DiscoveryPlacementContext = createContext<DiscoveryPlacementContextValue>({
  selectedDiscoveredId: null,
  setSelectedDiscoveredId: () => {},
  placementTarget: null,
  setPlacementTarget: () => {},
  clearPlacement: () => {},
});

export function useDrawerSelection() {
  return useContext(DrawerSelectionContext);
}

export function useExplorerVisibility() {
  return useContext(ExplorerVisibilityContext);
}

export function useDiscoveryPlacement() {
  return useContext(DiscoveryPlacementContext);
}

// Backward-compat alias for consumers that still use the old name
export const NodeSelectionContext = DrawerSelectionContext;
export function useNodeSelection() {
  const { selection, setSelection } = useDrawerSelection();
  return {
    selectedNode: selection?.type === "node" ? { rigId: selection.rigId, logicalId: selection.logicalId } : null,
    setSelectedNode: (node: { rigId: string; logicalId: string } | null) =>
      setSelection(node ? { type: "node", rigId: node.rigId, logicalId: node.logicalId } : null),
  };
}

// -- AppShell --

interface AppShellProps {
  children: ReactNode;
}

const WIDE_LAYOUT_BREAKPOINT = 1024;

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function resolveSurfaceTitle(pathname: string, rigId: string | null, rigName: string | null): string | null {
  if (pathname === "/") return null;
  if (rigId) return rigName ?? shortId(rigId, 8);
  if (pathname.startsWith("/discovery")) return "Discovery";
  if (
    pathname === "/specs" ||
    pathname.startsWith("/packages") ||
    pathname === "/import" ||
    pathname === "/bootstrap" ||
    pathname === "/agents/validate"
  ) return "Specs";
  if (pathname.startsWith("/bundles/inspect")) return "Bundle Inspector";
  if (pathname.startsWith("/bundles/install")) return "Bundle Install";
  return null;
}

export function AppShell({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const currentRigId = parseCurrentRigId(pathname);
  const { data: rigs } = useRigSummary();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(true);
  const [isWideLayout, setIsWideLayout] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= WIDE_LAYOUT_BREAKPOINT;
  });
  const { events } = useActivityFeed();
  const [selectionState, setSelectionState] = useState<DrawerSelection>(null);
  const [selectedDiscoveredId, setSelectedDiscoveredIdState] = useState<string | null>(null);
  const [placementTarget, setPlacementTargetState] = useState<DiscoveryPlacementTarget>(null);
  const currentRigName = currentRigId ? (rigs?.find((rig) => rig.id === currentRigId)?.name ?? null) : null;
  const surfaceTitle = resolveSurfaceTitle(pathname, currentRigId, currentRigName);
  const setSelection = useCallback((next: DrawerSelection) => {
    setSelectionState(next);
    if (!isWideLayout && next) {
      setSidebarOpen(false);
    }
  }, [isWideLayout]);
  const openExplorer = useCallback(() => {
    setDesktopExplorerOpen(true);
    if (!isWideLayout) {
      setSelectionState(null);
      setSidebarOpen(true);
      return;
    }
    setSidebarOpen(true);
  }, [isWideLayout]);
  const clearPlacement = useCallback(() => {
    setSelectedDiscoveredIdState(null);
    setPlacementTargetState(null);
  }, []);
  const setSelectedDiscoveredId = useCallback((id: string | null) => {
    setSelectedDiscoveredIdState(id);
    setPlacementTargetState(null);
  }, []);

  useEffect(() => {
    if (selectionState?.type !== "discovery") {
      clearPlacement();
    }
  }, [selectionState, clearPlacement]);

  useEffect(() => {
    if (
      selectionState?.type === "discovery" &&
      placementTarget &&
      currentRigId !== placementTarget.rigId
    ) {
      setPlacementTargetState(null);
    }
  }, [currentRigId, placementTarget, selectionState]);

  useEffect(() => {
    const handleResize = () => {
      setIsWideLayout(window.innerWidth >= WIDE_LAYOUT_BREAKPOINT);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const isDrawerBridgeRoute = pathname === "/specs" || pathname === "/discovery";
    if (!isWideLayout && !isDrawerBridgeRoute) {
      setSelectionState(null);
      setSidebarOpen(false);
    }
  }, [isWideLayout, pathname]);

  // Mount global SSE event listener
  useGlobalEvents();

  const workspaceStyle = {
    "--workspace-left-offset": isWideLayout ? (desktopExplorerOpen ? "18rem" : "3rem") : "0rem",
    "--workspace-right-offset": isWideLayout && selectionState ? "20rem" : "0rem",
  } as CSSProperties;

  return (
    <DrawerSelectionContext.Provider value={{ selection: selectionState, setSelection }}>
      <DiscoveryPlacementContext.Provider
        value={{
          selectedDiscoveredId,
          setSelectedDiscoveredId,
          placementTarget,
          setPlacementTarget: setPlacementTargetState,
          clearPlacement,
        }}
      >
      <ExplorerVisibilityContext.Provider value={{ openExplorer }}>
      <div className="h-screen flex flex-col">
        {/* Header — paper with thick bottom border */}
        <header
          data-testid="app-header"
          className="h-14 flex items-center justify-between px-spacing-6 bg-background border-b-2 border-stone-900 shrink-0 relative z-30"
        >
          {surfaceTitle && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-28">
              <div
                data-testid="header-surface-title"
                className="truncate font-mono text-sm font-semibold uppercase tracking-[0.12em] text-stone-700"
              >
                {surfaceTitle}
              </div>
            </div>
          )}

          <div className="flex items-center gap-spacing-4">
            {/* Hamburger — narrow viewports only */}
            <button
              data-testid="sidebar-toggle"
              onClick={() => {
                if (!sidebarOpen) {
                  setSelectionState(null);
                }
                setSidebarOpen(!sidebarOpen);
              }}
              className="flex flex-col gap-[3px] p-1 lg:hidden"
              aria-label="Toggle navigation"
            >
              <span className="block w-4 h-[1.5px] bg-stone-900" />
              <span className="block w-4 h-[1.5px] bg-stone-900" />
              <span className="block w-3 h-[1.5px] bg-stone-900" />
            </button>

            <Link
              to="/"
              data-testid="brand-home-link"
              className="inline-flex items-center bg-stone-950 px-3 py-1 font-mono text-sm font-bold uppercase tracking-[0.08em] text-stone-50 transition-colors hover:bg-stone-800"
            >
              RIGGED
            </Link>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="discovery-toggle"
              onClick={() => setSelection(selectionState?.type === "discovery" ? null : { type: "discovery" })}
              className={`inline-flex h-8 w-8 items-center justify-center text-stone-700 transition-colors ${
                selectionState?.type === "discovery"
                  ? "text-stone-950"
                  : "hover:text-stone-950"
              }`}
              aria-label={selectionState?.type === "discovery" ? "Close discovery drawer" : "Open discovery drawer"}
              title={selectionState?.type === "discovery" ? "Close discovery drawer" : "Open discovery drawer"}
            >
              <SquarePlus className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid="specs-toggle"
              onClick={() => setSelection(selectionState?.type === "specs" ? null : { type: "specs" })}
              className={`inline-flex h-8 w-8 items-center justify-center text-stone-700 transition-colors ${
                selectionState?.type === "specs"
                  ? "text-stone-950"
                  : "hover:text-stone-950"
              }`}
              aria-label={selectionState?.type === "specs" ? "Close specs drawer" : "Open specs drawer"}
              title={selectionState?.type === "specs" ? "Close specs drawer" : "Open specs drawer"}
            >
              <FileText className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid="system-toggle"
              onClick={() => setSelection(selectionState?.type === "system" ? null : { type: "system", tab: "log" })}
              className={`inline-flex h-8 w-8 items-center justify-center text-stone-700 transition-colors ${
                selectionState?.type === "system"
                  ? "text-stone-950"
                  : "hover:text-stone-950"
              }`}
              aria-label={selectionState?.type === "system" ? "Close system drawer" : "Open system drawer"}
              title={selectionState?.type === "system" ? "Close system drawer" : "Open system drawer"}
            >
              <Cog className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Main: Explorer + Content + Detail Panel */}
        <div className="flex flex-1 min-h-0 relative">
          {/* Explorer overlay backdrop for mobile */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 bg-black/20 z-20 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          <Explorer
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            selection={selectionState}
            onSelect={setSelection}
            desktopMode={desktopExplorerOpen ? "full" : "hidden"}
            onDesktopToggle={() => setDesktopExplorerOpen((open) => !open)}
          />

          <main data-testid="content-area" className="flex-1 flex flex-col overflow-auto relative" style={workspaceStyle}>
            <div key={pathname} className="relative z-10 route-enter flex-1 flex flex-col">{children}</div>
          </main>

          {/* Detail drawer — visible when a rig or node is selected */}
          <SharedDetailDrawer
            selection={selectionState}
            onClose={() => setSelection(null)}
            events={events}
            selectedDiscoveredId={selectedDiscoveredId}
            onSelectDiscoveredId={setSelectedDiscoveredId}
            placementTarget={placementTarget}
            onClearPlacement={clearPlacement}
          />
        </div>
      </div>
      </ExplorerVisibilityContext.Provider>
      </DiscoveryPlacementContext.Provider>
    </DrawerSelectionContext.Provider>
  );
}
