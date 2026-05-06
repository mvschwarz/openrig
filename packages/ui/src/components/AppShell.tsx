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
// Specs / Settings + Advisor + Operator (no discovery in rail).
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
  type ComponentType,
} from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Brain,
  Cog,
  FileText,
  Folder,
  LayoutDashboard,
  Network,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Explorer, type ExplorerSurface } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import { PreviewStack } from "./preview/PreviewStack.js";
import type { DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { SpecsWorkspaceProvider } from "./SpecsWorkspace.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";
import { cn } from "../lib/utils.js";

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

// Backward-compat alias for consumers (RigGraph.tsx) that still use the old name.
export const NodeSelectionContext = DrawerSelectionContext;
export function useNodeSelection() {
  const { selection, setSelection } = useDrawerSelection();
  return {
    selectedNode:
      selection?.type === "node"
        ? { rigId: selection.rigId, logicalId: selection.logicalId }
        : null,
    setSelectedNode: (node: { rigId: string; logicalId: string } | null) =>
      setSelection(
        node ? { type: "node", rigId: node.rigId, logicalId: node.logicalId } : null,
      ),
  };
}

// =====================================================================
// Rail icon roster — universal-shell.md L37–L58 + agent-chat-surface.md V1 placeholder
// =====================================================================

interface RailIconSpec {
  id: string;
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  /** Path prefix used for active-state matching. */
  activeWhen: (pathname: string) => boolean;
  testId: string;
  group: "destination" | "chat";
}

// V1 default seats per agent-chat-surface.md L51–L52. Phase 4 swaps in
// ConfigStore-driven resolution (`agents.advisor_session` /
// `agents.operator_session`); Phase 2 mounts the icons with /settings
// links as functional placeholders.
const RAIL_ICONS: RailIconSpec[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    to: "/",
    icon: LayoutDashboard,
    activeWhen: (p) => p === "/",
    testId: "rail-dashboard",
    group: "destination",
  },
  {
    id: "topology",
    label: "Topology",
    to: "/topology",
    icon: Network,
    activeWhen: (p) => p.startsWith("/topology") || p.startsWith("/rigs/"),
    testId: "rail-topology",
    group: "destination",
  },
  {
    id: "for-you",
    label: "For You",
    to: "/for-you",
    icon: Sparkles,
    activeWhen: (p) => p.startsWith("/for-you"),
    testId: "rail-for-you",
    group: "destination",
  },
  {
    id: "project",
    label: "Project",
    to: "/project",
    icon: Folder,
    activeWhen: (p) => p.startsWith("/project"),
    testId: "rail-project",
    group: "destination",
  },
  {
    id: "specs",
    label: "Specs",
    to: "/specs",
    icon: FileText,
    activeWhen: (p) => p.startsWith("/specs"),
    testId: "rail-specs",
    group: "destination",
  },
  {
    id: "settings",
    label: "Settings",
    to: "/settings",
    icon: Cog,
    activeWhen: (p) => p.startsWith("/settings"),
    testId: "rail-settings",
    group: "destination",
  },
  {
    id: "advisor",
    label: "Advisor",
    to: "/settings#agents-advisor-session",
    icon: Brain,
    activeWhen: () => false,
    testId: "rail-advisor",
    group: "chat",
  },
  {
    id: "operator",
    label: "Operator",
    to: "/settings#agents-operator-session",
    icon: Wrench,
    activeWhen: () => false,
    testId: "rail-operator",
    group: "chat",
  },
];

// =====================================================================
// Path → Explorer surface mapping
// =====================================================================

function surfaceForPath(pathname: string): ExplorerSurface {
  if (pathname.startsWith("/topology") || pathname.startsWith("/rigs/")) return "topology";
  if (pathname.startsWith("/project")) return "project";
  if (pathname.startsWith("/specs")) return "specs";
  if (pathname.startsWith("/for-you")) return "for-you";
  return "none";
}

// =====================================================================
// Rail component
// =====================================================================

function Rail({
  pathname,
  onMobileClose,
  vertical,
}: {
  pathname: string;
  onMobileClose?: () => void;
  vertical: boolean;
}) {
  const destinationIcons = RAIL_ICONS.filter((i) => i.group === "destination");
  const chatIcons = RAIL_ICONS.filter((i) => i.group === "chat");

  const renderIcon = (spec: RailIconSpec) => {
    const Icon = spec.icon;
    const active = spec.activeWhen(pathname);
    return (
      <Link
        key={spec.id}
        to={spec.to}
        data-testid={spec.testId}
        data-active={active}
        aria-label={spec.label}
        title={spec.label}
        onClick={onMobileClose}
        className={cn(
          "relative flex h-10 w-10 items-center justify-center transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2",
          active
            ? "bg-stone-900 text-stone-50"
            : "text-stone-700 hover:bg-stone-200 hover:text-stone-900",
        )}
      >
        <Icon className="h-5 w-5" />
        {active && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1 bottom-1 w-[2px] bg-tertiary"
          />
        )}
      </Link>
    );
  };

  return (
    <nav
      data-testid="app-rail"
      aria-label="Primary navigation"
      className={cn(
        "bg-background border-stone-900 flex shrink-0",
        vertical
          ? "w-12 flex-col items-center border-r-2 py-2 gap-1"
          : "w-full flex-row items-center border-b-2 px-2 gap-1 overflow-x-auto",
      )}
    >
      <div
        className={cn(
          "flex",
          vertical ? "flex-col gap-1 items-center" : "flex-row gap-1 items-center",
        )}
      >
        {destinationIcons.map(renderIcon)}
      </div>
      <div className={cn(vertical ? "flex-1" : "flex-1 hidden lg:block")} />
      <div
        className={cn(
          "flex",
          vertical ? "flex-col gap-1 items-center pb-1" : "flex-row gap-1 items-center",
        )}
      >
        {chatIcons.map(renderIcon)}
      </div>
    </nav>
  );
}

// =====================================================================
// AppShell
// =====================================================================

interface AppShellProps {
  children: ReactNode;
}

const WIDE_LAYOUT_BREAKPOINT = 1024;

export function AppShell({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const surface = surfaceForPath(pathname);

  const [explorerOpen, setExplorerOpen] = useState(false); // mobile slide-over state
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(true);
  const [isWideLayout, setIsWideLayout] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= WIDE_LAYOUT_BREAKPOINT;
  });
  const [selectionState, setSelectionState] = useState<DrawerSelection>(null);
  const [selectedDiscoveredId, setSelectedDiscoveredIdState] = useState<string | null>(null);
  const [placementTarget, setPlacementTargetState] = useState<DiscoveryPlacementTarget>(null);

  const { events } = useActivityFeed();

  const setSelection = useCallback(
    (next: DrawerSelection) => {
      setSelectionState(next);
      if (!isWideLayout && next) {
        setExplorerOpen(false);
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

  // SC-3a — drawer content does NOT persist across reload (it's contextual).
  // Mobile-narrow viewports: close drawer + close explorer when route changes
  // unless the route specifically handles the drawer (none in Phase 2).
  useEffect(() => {
    if (!isWideLayout) {
      setSelectionState(null);
      setExplorerOpen(false);
    }
  }, [isWideLayout, pathname]);

  // Mount global SSE event listener.
  useGlobalEvents();

  const explorerVisible = surface !== "none";
  const drawerOpen = Boolean(selectionState);

  // CSS var consumed by surfaces that pad themselves inside center.
  // Rail: 48px (3rem). Explorer: 280px (18rem) when desktop-open, 0 when collapsed/none.
  const workspaceLeftOffset = isWideLayout
    ? `${3 + (explorerVisible && desktopExplorerOpen ? 18 : 0)}rem`
    : "0rem";
  const workspaceRightOffset = isWideLayout && drawerOpen ? "45rem" : "0rem";
  const workspaceStyle = {
    "--workspace-left-offset": workspaceLeftOffset,
    "--workspace-right-offset": workspaceRightOffset,
  } as CSSProperties;

  return (
    <SpecsWorkspaceProvider>
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
              className="h-14 flex items-center justify-between px-4 bg-background border-b-2 border-stone-900 shrink-0 relative z-30"
            >
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="mobile-menu-toggle"
                  onClick={() => setExplorerOpen((open) => !open)}
                  aria-label="Toggle navigation"
                  className="flex flex-col gap-[3px] p-2 lg:hidden"
                >
                  <span className="block w-4 h-[1.5px] bg-stone-900" />
                  <span className="block w-4 h-[1.5px] bg-stone-900" />
                  <span className="block w-3 h-[1.5px] bg-stone-900" />
                </button>
                <Link
                  to="/"
                  data-testid="brand-home-link"
                  className="inline-flex items-center bg-stone-950 px-3 py-1 font-mono text-sm font-bold uppercase tracking-[0.08em] text-stone-50 hover:bg-stone-800"
                >
                  OPENRIG
                </Link>
              </div>
              {/* Right-slot — reserved for V2 global affordances. V1 carries
                  a minimal env indicator. Hidden on narrow viewports to
                  preserve mobile space. */}
              <div
                data-testid="topbar-right-slot"
                className="hidden sm:flex items-center gap-2"
              >
                <span
                  data-testid="topbar-env-indicator"
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant"
                >
                  localhost
                </span>
              </div>
            </header>

            {/* Main: rail + explore + center + drawer */}
            <div className="flex flex-1 min-h-0 relative">
              {/* Rail — desktop only (lg:flex). Mobile rail surfaces inside the slide-over. */}
              <div className="hidden lg:flex">
                <Rail pathname={pathname} vertical />
              </div>

              {/* Mobile slide-over: rail (horizontal) + explore.
                  Conditionally rendered ONLY at narrow viewports so the
                  desktop DOM doesn't carry an offscreen <nav> that
                  fails the SC-1 "exactly 2 left chromes" count check. */}
              {!isWideLayout && (
                <>
                  {explorerOpen && (
                    <div
                      className="fixed inset-0 bg-black/20 z-20 lg:hidden"
                      onClick={() => setExplorerOpen(false)}
                    />
                  )}
                  <div
                    data-testid="mobile-rail-tray"
                    className={cn(
                      "fixed top-14 left-0 bottom-0 z-30 bg-background border-r-2 border-stone-900 transition-transform duration-200 ease-tactical lg:hidden",
                      "w-72 max-w-[85vw] flex flex-col",
                      explorerOpen ? "translate-x-0" : "-translate-x-full",
                    )}
                  >
                    <Rail pathname={pathname} vertical={false} onMobileClose={() => setExplorerOpen(false)} />
                  </div>
                </>
              )}

              {/* Explorer — desktop column or mobile slide-over (Explorer.tsx handles both modes). */}
              {explorerVisible && (
                <Explorer
                  open={explorerOpen}
                  onClose={() => setExplorerOpen(false)}
                  selection={selectionState}
                  onSelect={setSelection}
                  desktopMode={desktopExplorerOpen ? "full" : "hidden"}
                  surface={surface}
                  onDesktopToggle={() => setDesktopExplorerOpen((open) => !open)}
                />
              )}

              {/* Center workspace */}
              <main
                data-testid="content-area"
                className="flex-1 flex flex-col overflow-auto relative"
                style={workspaceStyle}
              >
                <div key={pathname} className="relative z-10 route-enter flex-1 flex flex-col">
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
            </div>
          </div>
        </DiscoveryPlacementContext.Provider>
      </DrawerSelectionContext.Provider>
    </SpecsWorkspaceProvider>
  );
}
