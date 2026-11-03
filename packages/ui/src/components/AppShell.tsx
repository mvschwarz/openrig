// V1 attempt-3 Phase 2 — AppShell chrome.
//
// Universal shell per universal-shell.md L13–L34 (LAYOUT CONTRACT):
// rail (48px) + explore sidebar (280px) + center workspace (flex) +
// content drawer (~720px when open / 0 closed).
//
// Phase 2 deletes Sidebar.tsx (the load-bearing structural fix attempts
// 1+2 missed) and lays the canonical rail with 6 destination icons +
// 2 chat icons (Advisor, Operator V1 placeholders per
// agent-chat-surface.md L45–L52).
//
// Phase 3 fills tree contents in Explorer; Phase 4 wires drawer viewers
// + chat icon click behavior to the configured advisor/operator seats.
//
// SC-1 satisfied: exactly 2 left chromes on desktop (rail + explore).
// SC-2 satisfied: rail order Dashboard / Topology / For You / Project /
// Library / Settings + Advisor + Operator (no discovery in rail).
// SC-7 satisfied: Settings mounts in CENTER (rail icon → /settings route,
// not a drawer toggle).
// SC-8 satisfied: mobile rail collapses to top-bar menu; explore
// becomes slide-over.

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  createContext,
  useContext,
} from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { MobileBottomNav } from "./shell/MobileBottomNav.js";
import { Folder, Network, PanelLeft, Sparkles } from "lucide-react";
import { TopBar } from "./shell/TopBar.js";
import { Explorer, shouldSuppressExplorerMount, type ExplorerSurface } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import { PreviewStack } from "./preview/PreviewStack.js";
import type { DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { SpecsWorkspaceProvider } from "./SpecsWorkspace.js";
import {
  TopologyOverlayProvider,
  useTopologyOverlay,
} from "./topology/topology-overlay-context.js";
import { ThemeSelector } from "./ThemeSelector.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useClearPlacementOnHostSwitch } from "../hooks/useHosts.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";
import { cn } from "../lib/utils.js";
import { useTheme } from "./ThemeProvider.js";
import { Toaster } from "sonner";
import { Sidebar } from "./shell/Sidebar.js";
import { CommandPalette, PaletteShortcuts } from "./shell/CommandPalette.js";
import { isSidebarCollapsed, readSidebarMode, writeSidebarMode } from "../lib/sidebar-mode.js";

// =====================================================================
// Contexts (preserved per DRIFT P2-B + active consumers in Dashboard, RigGraph)
// =====================================================================

interface DrawerSelectionContextValue {
  selection: DrawerSelection;
  setSelection: (sel: DrawerSelection) => void;
}

interface DiscoveryPlacementContextValue {
  selectedDiscoveredId: string | null;
  setSelectedDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  setPlacementTarget: (target: DiscoveryPlacementTarget) => void;
  clearPlacement: () => void;
}


// Accessible names for the mobile button that opens the Explorer panel.
const MOBILE_EXPLORER_LABEL: Partial<Record<ExplorerSurface, string>> = {
  "for-you": "Show inbox filters",
  project: "Show project tree",
  specs: "Show library",
  settings: "Show settings sections",
  topology: "Show rig tree",
};

export const DrawerSelectionContext = createContext<DrawerSelectionContextValue>({
  selection: null,
  setSelection: () => {},
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

export function useDiscoveryPlacement() {
  return useContext(DiscoveryPlacementContext);
}

// V1 polish slice Phase 5.1 P5.1-1 + DRIFT P5.1-D2: useNodeSelection
// alias FULLY RETIRED. After 'seat-detail' kind retirement, the only
// callsite (RigGraph node click) now uses useNavigate to route to the
// /topology/seat/$rigId/$logicalId center page directly. Verified via
// grep — no remaining production consumer of useNodeSelection or
// NodeSelectionContext outside the legacy AppShell export.
//
// NodeSelectionContext alias retained as a no-op export for any test
// file still importing the symbol (negative-assertion guard); functions
// retired entirely.
export const NodeSelectionContext = DrawerSelectionContext;

// =====================================================================
// Path → Explorer surface mapping
// =====================================================================

function surfaceForPath(pathname: string): ExplorerSurface {
  if (pathname.startsWith("/topology") || pathname.startsWith("/rigs/")) return "topology";
  if (pathname.startsWith("/project")) return "project";
  if (pathname.startsWith("/specs") || pathname.startsWith("/plugins")) return "specs";
  if (pathname.startsWith("/for-you")) return "for-you";
  if (pathname.startsWith("/settings")) return "settings";
  return "none";
}

// =====================================================================
// Sidebar component (ui-redesign C06) lives in shell/Sidebar.tsx.
// =====================================================================

// =====================================================================
// AppShell
// =====================================================================

interface AppShellProps {
  children: ReactNode;
}

const WIDE_LAYOUT_BREAKPOINT = 1024;

export function AppShell({ children }: AppShellProps) {
  return (
    <SpecsWorkspaceProvider>
      <TopologyOverlayProvider>
        <AppShellInner>{children}</AppShellInner>
      </TopologyOverlayProvider>
    </SpecsWorkspaceProvider>
  );
}

function AppShellInner({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const surface = surfaceForPath(pathname);
  const { mode: explorerMode } = useTopologyOverlay();

  const [explorerOpen, setExplorerOpen] = useState(false); // mobile nav tray state
  // Mobile Explorer (Inbox filters, project tree, library, settings
  // sections) has its own state. It used to share explorerOpen with the
  // nav tray, so the hamburger opened both and the Explorer painted over
  // the tray, leaving a nav you could see but not tap.
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(true);
  const [isWideLayout, setIsWideLayout] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= WIDE_LAYOUT_BREAKPOINT;
  });
  const [sidebarMode, setSidebarMode] = useState(readSidebarMode);
  const [selectionState, setSelectionState] = useState<DrawerSelection>(null);
  const [selectedDiscoveredId, setSelectedDiscoveredIdState] = useState<string | null>(null);
  const [placementTarget, setPlacementTargetState] = useState<DiscoveryPlacementTarget>(null);

  const { events } = useActivityFeed();
  const { resolved } = useTheme();

  const setSelection = useCallback(
    (next: DrawerSelection) => {
      setSelectionState(next);
      if (!isWideLayout && next) {
        setExplorerOpen(false);
        setMobileExplorerOpen(false);
      }
    },
    [isWideLayout],
  );

  const clearPlacement = useCallback(() => {
    setSelectedDiscoveredIdState(null);
    setPlacementTargetState(null);
  }, []);

  const setSelectedDiscoveredId = useCallback((id: string | null) => {
    setSelectedDiscoveredIdState(id);
    setPlacementTargetState(null);
  }, []);

  // Window resize → wide-layout flag.
  useEffect(() => {
    const handleResize = () => {
      setIsWideLayout(window.innerWidth >= WIDE_LAYOUT_BREAKPOINT);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Cross-route: clear discovery placement when discovery selection clears.
  useEffect(() => {
    if (selectionState?.type !== "discovery") clearPlacement();
  }, [selectionState, clearPlacement]);

  // OPR.0.4.6.MH2 rev1-r2 re-re-verdict B1: a placement target created while
  // local must not survive a host switch — ANY selected-host change clears
  // the target + discovered-session selection (the panel-side brace
  // additionally suppresses the adopt UI under remote).
  useClearPlacementOnHostSwitch(clearPlacement);

  // SC-3a — drawer content does NOT persist across reload (it's contextual).
  // Mobile-narrow viewports: close drawer + close explorer when route changes
  // unless the route specifically handles the drawer (none in Phase 2).
  useEffect(() => {
    if (!isWideLayout) {
      setSelectionState(null);
      setExplorerOpen(false);
      setMobileExplorerOpen(false);
    }
  }, [isWideLayout, pathname]);

  // Mount global SSE event listener.
  const proofConnection = useGlobalEvents();

  const explorerVisible = surface !== "none";
  // Slice 26.D OPT-D3 Topology mobile mount-suppression: rule lives
  // in shouldSuppressExplorerMount() (Explorer.tsx). Pre-existing
  // renderer-spin in Topology mobile render path pegs the browser
  // when Explorer mounts at 375px; only mount-suppression sidesteps
  // the peg trigger. Other 4 destinations mount normally regardless
  // of viewport. 0.3.2 fixes Topology mobile render path; this
  // suppression reverts at that time.
  const explorerMounted = explorerVisible && !shouldSuppressExplorerMount(surface, isWideLayout);
  const drawerOpen = Boolean(selectionState);
  // C06: auto mode collapses the sidebar when an Explorer column is
  // visible on desktop (and the explorer itself is open).
  const sidebarCollapsed =
    isWideLayout && isSidebarCollapsed(sidebarMode, explorerVisible && desktopExplorerOpen);
  const toggleSidebarCollapsed = () => {
    const next = sidebarCollapsed ? "expanded" : "collapsed";
    setSidebarMode(next);
    writeSidebarMode(next);
  };
  const sidebarWidth = sidebarCollapsed
    ? "var(--sidebar-width-collapsed)"
    : "var(--sidebar-width)";

  // V1 attempt-3 Phase 3 bounce-fix — Class B fixed-anchor + selective overlay.
  // Topology graph mode signals overlay; only meaningful while on /topology
  // (surface === "topology"). Other surfaces ALWAYS use opaque layout.
  const isTopologyOverlay = explorerMode === "overlay" && surface === "topology";

  // Anchor stays the same in BOTH modes — tab bar position never moves.
  // Main padding-left differs:
  //   - opaque: padding = anchor (content starts AFTER explorer)
  //   - overlay: padding = 0 (content extends behind translucent explorer);
  //              tab bar is sticky/positioned at left=anchor independently.
  // C06: the anchor is the sidebar width var + the 18rem explorer column.
  // --sidebar-current-width is set on the flex wrapper below (NOT on
  // workspaceStyle: that object is spread onto <main>, a sibling of the
  // Explorer, so a variable set there would never reach the Explorer).
  // main is a flex sibling AFTER the sidebar, so it already starts at the
  // sidebar's right edge — the rail double-count is gone here: opaque +
  // explorer open keeps only the 18rem explorer column, anything else is 0.
  const explorerAnchorLeft =
    isWideLayout && explorerVisible && desktopExplorerOpen
      ? "calc(var(--sidebar-current-width) + 18rem)"
      : "var(--sidebar-current-width)";
  const workspaceLeftOffset =
    isWideLayout && !isTopologyOverlay && explorerVisible && desktopExplorerOpen ? "18rem" : "0rem";
  // Class B fixed-anchor: header (eyebrow + title + view-mode tabs) ALWAYS
  // sits at the explorer-anchor offset, even in overlay mode where the
  // canvas extends behind the Explorer. This keeps the tab bar at a
  // stable left position across view-mode switches.
  // C06: measured from <main>'s left edge (already past the sidebar), so
  // it carries only the explorer column, not the sidebar width.
  const headerAnchorOffset =
    isWideLayout && isTopologyOverlay && explorerVisible && desktopExplorerOpen ? "18rem" : "0rem";
  // Coupled to VellumSheet wide preset (lg:w-[38rem]) — bounce-fix #3
  // caught the gap that emerged when bounce-fix #2 calibrated the drawer
  // 45rem → 38rem without updating this offset. Keep these two literals
  // in sync; the regression test in app-shell.test.tsx asserts they match.
  const workspaceRightOffset = isWideLayout && drawerOpen ? "38rem" : "0rem";
  const workspaceStyle = {
    "--workspace-left-offset": workspaceLeftOffset,
    "--workspace-right-offset": workspaceRightOffset,
    "--explorer-anchor-left": explorerAnchorLeft,
    "--header-anchor-offset": headerAnchorOffset,
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
          <div className="h-screen flex flex-col">
            {/* Top bar — universal across viewports per universal-shell.md
                L40–L53. Single source of truth: same element renders at
                all sizes. Hamburger button keeps its own lg:hidden so it
                only appears at narrow viewports; brand mark + right-slot
                stay visible everywhere. */}
            <header
              data-testid="app-topbar"
              className="h-12 flex items-center justify-between gap-3 px-4 bg-background border-b shrink-0 relative z-30"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {/* Slice 26.E OPT-E Topology mobile toggle carve-out: at
                    narrow viewports on /topology the menu toggle does
                    not render. Clicking it flips explorerOpen state
                    which re-renders AppShellInner's children; the
                    Topology mobile render path (TopologyTableView +
                    TopologyTreeView) has a pre-existing render-cost
                    that pegs the browser on that cascade — independent
                    of whether the Explorer drawer itself mounts (OPT-D3
                    already suppresses that). Hiding the entry point
                    prevents the state-flip trigger. Pre-existing
                    renderer-spin scheduled for 0.3.2 dedicated render-
                    path slice; 0.3.1 carve-out preserves Topology
                    mobile usability (degraded table still loads +
                    navigable; brand-home-link reachable in topbar).
                    Reuses shouldSuppressExplorerMount predicate — same
                    underlying carve-out scenario. */}
                {!shouldSuppressExplorerMount(surface, isWideLayout) && (
                  <button
                    type="button"
                    data-testid="mobile-menu-toggle"
                    onClick={() => {
                      setMobileExplorerOpen(false);
                      setExplorerOpen((open) => !open);
                    }}
                    aria-label="Toggle navigation"
                    className="flex flex-col gap-[3px] p-2 lg:hidden shrink-0"
                  >
                    <span className="block w-4 h-[1.5px] bg-inverse-surface" />
                    <span className="block w-4 h-[1.5px] bg-inverse-surface" />
                    <span className="block w-3 h-[1.5px] bg-inverse-surface" />
                  </button>
                )}
                <TopBar />
              </div>
              {!isWideLayout && explorerMounted && (
                <button
                  type="button"
                  data-testid="mobile-explorer-toggle"
                  aria-label={MOBILE_EXPLORER_LABEL[surface] ?? "Show side panel"}
                  aria-expanded={mobileExplorerOpen}
                  onClick={() => {
                    setExplorerOpen(false);
                    setMobileExplorerOpen((open) => !open);
                  }}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-low hover:text-on-surface lg:hidden"
                >
                  <PanelLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                </button>
              )}
            </header>

            {/* Main: rail + explore + center + drawer */}
            <div
              className="flex flex-1 min-h-0 relative"
              style={{ "--sidebar-current-width": isWideLayout ? sidebarWidth : "0rem" } as CSSProperties}
            >
              {/* Sidebar — desktop only (lg:flex). Mobile sidebar surfaces inside the slide-over. */}
              <div className="hidden lg:flex">
                <Sidebar
                  pathname={pathname}
                  vertical
                  collapsed={sidebarCollapsed}
                  onToggleCollapsed={toggleSidebarCollapsed}
                />
              </div>

              {/* Mobile slide-over: rail (horizontal) + explore.
                  Conditionally rendered ONLY at narrow viewports so the
                  desktop DOM doesn't carry an offscreen <nav> that
                  fails the SC-1 "exactly 2 left chromes" count check. */}
              {!isWideLayout && (
                <>
                  {(explorerOpen || mobileExplorerOpen) && (
                    <div
                      data-testid="mobile-drawer-backdrop"
                      className="fixed inset-0 bg-black/50 z-20 lg:hidden"
                      onClick={() => {
                        setExplorerOpen(false);
                        setMobileExplorerOpen(false);
                      }}
                    />
                  )}
                  <div
                    data-testid="mobile-rail-tray"
                    className={cn(
                      "fixed top-12 left-0 bottom-0 z-30 bg-background transition-transform duration-200 ease-tactical lg:hidden",
                      "w-72 max-w-[80vw] flex flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))]",
                      explorerOpen ? "translate-x-0" : "-translate-x-full",
                    )}
                  >
                    {/* Slice 20 mobile: mobile slide-over sidebar is
                        vertical (one item per row) — thumb-friendly stack
                        instead of the prior horizontal scroll. */}
                    <Sidebar
                      pathname={pathname}
                      vertical
                      collapsed={false}
                      isMobileTray
                      onMobileClose={() => setExplorerOpen(false)}
                    />
                  </div>
                </>
              )}

              {/* Explorer — desktop column or mobile slide-over.
                  In overlay mode (topology graph): vellum-translucent + z-30
                  so it floats over the canvas. In opaque mode: z-40
                  per slice 26.B OPT-B (above rail-tray on mobile).
                  Slice 26.D OPT-D3: Topology Explorer doesn't mount
                  on mobile (suppressTopologyMobileExplorer above). */}
              {explorerMounted && (
                <Explorer
                  open={mobileExplorerOpen}
                  onClose={() => setMobileExplorerOpen(false)}
                  selection={selectionState}
                  onSelect={setSelection}
                  desktopMode={desktopExplorerOpen ? "full" : "hidden"}
                  surface={surface}
                  onDesktopToggle={() => setDesktopExplorerOpen((open) => !open)}
                  overlayMode={isTopologyOverlay ? "overlay" : "opaque"}
                />
              )}

              {/* Center workspace */}
              <main
                data-testid="content-area"
                data-explorer-mode={isTopologyOverlay ? "overlay" : "opaque"}
                className="flex-1 flex flex-col overflow-auto relative"
                style={{
                  ...workspaceStyle,
                  paddingLeft: `var(--workspace-left-offset, 0px)`,
                }}
              >
                {!proofConnection.connected && <p role="status" className="px-4 py-1 text-sm">Live updates unavailable. Displayed readiness is the last confirmed basis; quiet refresh is active.</p>}
                {/* Reset the workspace offset CSS vars to 0 inside main so that
                    legacy children (e.g., LiveNodeDetails → WorkspacePage which
                    also reads var(--workspace-left-offset) for its own padding)
                    don't double-pad. The padding is already applied at <main>
                    above; child surfaces should treat their own offset as 0. */}
                <div
                  key={pathname}
                  className="relative z-10 route-enter flex-1 flex flex-col pb-14 lg:pb-0"
                  style={{
                    "--workspace-left-offset": "0px",
                    "--workspace-right-offset": "0px",
                  } as CSSProperties}
                >
                  {children}
                </div>
              </main>

              {/* Content drawer — default closed (selection===null returns null inside drawer). */}
              <SharedDetailDrawer
                selection={selectionState}
                onClose={() => setSelection(null)}
                events={events}
                selectedDiscoveredId={selectedDiscoveredId}
                onSelectDiscoveredId={setSelectedDiscoveredId}
                placementTarget={placementTarget}
                onClearPlacement={clearPlacement}
              />

              {/* Preview Terminal v0 (PL-018) — pinned-preview side rail.
                  Self-hides when no pins; positioned right edge under the
                  drawer when drawer mounted. */}
              <PreviewStack />

              {/* C09: toasts for rig actions (sonner). Mounted once here. */}
              <Toaster position="bottom-right" richColors={false} closeButton theme={resolved} />

              {/* C08: command palette + g-then-key shortcuts, mounted once here. */}
              <CommandPalette />
              <PaletteShortcuts />

              {/* ui-redesign C16 — mobile bottom nav lives in
                  components/shell/MobileBottomNav.tsx. "More" opens the
                  same mobile tray as the hamburger. */}
              <MobileBottomNav pathname={pathname} onMore={() => {
                setMobileExplorerOpen(false);
                setExplorerOpen(true);
              }} />
            </div>
          </div>
      </DiscoveryPlacementContext.Provider>
    </DrawerSelectionContext.Provider>
  );
}

/** C16 removed the inline MobileBottomNav (now components/shell/MobileBottomNav.tsx). */
