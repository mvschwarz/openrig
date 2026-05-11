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
import {
  TopologyOverlayProvider,
  useTopologyOverlay,
} from "./topology/topology-overlay-context.js";
import { useSettings } from "../hooks/useSettings.js";
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
// Rail icon roster — universal-shell.md L37–L58 + agent-chat-surface.md V1 placeholder
// =====================================================================

interface RailIconSpec {
  id: string;
  label: string;
  to: string;
  // lucide-react icons accept SVG props (strokeWidth, color, size, etc).
  icon: ComponentType<{ className?: string; strokeWidth?: number | string }>;
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
    label: "Library",
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

// V1 Phase 4 P4-4 helpers — config-driven Advisor / Operator click resolution.

function readSettingString(
  data: { settings?: Record<string, { value?: unknown }> } | undefined,
  key: string,
): string {
  if (!data || !data.settings) return "";
  const v = data.settings[key]?.value;
  return typeof v === "string" ? v : "";
}

/** Map a ConfigStore session-string ("logicalId@rigId") to a navigation
 *  target. When configured: `/topology/seat/$rigId/$logicalId`. When
 *  unset: `/settings#agents-{role}-session`. Per universal-shell.md L80
 *  (one-click navigation; not popup-then-CTA two-click). */
function resolveChatTo(session: string, role: "advisor" | "operator"): string {
  if (!session) return `/settings#agents-${role}-session`;
  const at = session.indexOf("@");
  if (at === -1) {
    // Malformed; fall back to /settings.
    return `/settings#agents-${role}-session`;
  }
  const logicalId = session.slice(0, at);
  const rigId = session.slice(at + 1);
  if (!rigId || !logicalId) return `/settings#agents-${role}-session`;
  return `/topology/seat/${encodeURIComponent(rigId)}/${encodeURIComponent(logicalId)}`;
}

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
  // V1 attempt-3 Phase 4 P4-4 — Advisor / Operator click handlers
  // resolve `agents.advisor_session` / `agents.operator_session` from
  // ConfigStore (via useSettings). When configured: navigate to seat
  // detail. When unset: navigate to /settings#agents-{role}-session
  // CTA. Defaults from universal-shell.md L83-L84 (advisor =
  // advisor-lead@openrig-velocity; operator = empty/not configured).
  const { data: settingsData } = useSettings();
  const advisorSession = readSettingString(settingsData, "agents.advisor_session");
  const operatorSession = readSettingString(settingsData, "agents.operator_session");
  const chatIcons: RailIconSpec[] = RAIL_ICONS.filter((i) => i.group === "chat").map((spec) => {
    if (spec.id === "advisor") {
      return { ...spec, to: resolveChatTo(advisorSession, "advisor") };
    }
    if (spec.id === "operator") {
      return { ...spec, to: resolveChatTo(operatorSession, "operator") };
    }
    return spec;
  });

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
          // Slice 20 mobile: tap-target meets iOS HIG minimum (44px)
          // on mobile (default `h-11 w-11`) and restores the original
          // 40px hitbox at `lg:` (desktop) where mouse precision is
          // the input model, not thumbs.
          "relative flex h-11 w-11 items-center justify-center transition-colors lg:h-10 lg:w-10",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2",
          active
            ? "bg-stone-900 text-stone-50"
            : "text-stone-700 hover:bg-stone-200/60 hover:text-stone-900",
        )}
      >
        {/* Lighter icon line weight: stroke-width 1.25 (default lucide is 2)
            for an architectural drafting feel that matches the 1px ghost
            border doctrine. */}
        <Icon className="h-5 w-5" strokeWidth={1.25} />
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
        // V1 border weight doctrine (universal-shell.md L39–L48):
        // 1px outline-variant ghost line for inter-region edges.
        // Vellum surface: same translucent treatment as the topology-graph
        // Explorer overlay, so the rail reads as a paper sheet layered over
        // the canvas (sheets-of-vellum aesthetic per universal-shell.md L48).
        "vellum border-outline-variant flex shrink-0",
        vertical
          ? "w-12 flex-col items-center border-r py-2 gap-1"
          : "w-full flex-row items-center border-b px-2 gap-1 overflow-x-auto",
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

  // V1 attempt-3 Phase 3 bounce-fix — Class B fixed-anchor + selective overlay.
  // Topology graph mode signals overlay; only meaningful while on /topology
  // (surface === "topology"). Other surfaces ALWAYS use opaque layout.
  const isTopologyOverlay = explorerMode === "overlay" && surface === "topology";

  // Anchor stays the same in BOTH modes — tab bar position never moves.
  // Main padding-left differs:
  //   - opaque: padding = anchor (content starts AFTER explorer)
  //   - overlay: padding = 0 (content extends behind translucent explorer);
  //              tab bar is sticky/positioned at left=anchor independently.
  // 21rem = rail (3rem) + explorer (18rem).
  // 21rem (rail 3 + explorer 18) when explorer fully open. When
  // collapsed: 3rem (rail only) — the floating chevron toggle floats
  // over the canvas and doesn't claim layout space. When no explorer
  // for the destination: 3rem (rail only).
  const explorerAnchorLeft = isWideLayout && explorerVisible && desktopExplorerOpen
    ? "21rem"
    : "3rem";
  const workspaceLeftOffset = isWideLayout
    ? isTopologyOverlay
      ? "0rem"
      : explorerAnchorLeft
    : "0rem";
  // Class B fixed-anchor: header (eyebrow + title + view-mode tabs) ALWAYS
  // sits at the explorer-anchor offset, even in overlay mode where the
  // canvas extends behind the Explorer. This keeps the tab bar at a
  // stable left position across view-mode switches.
  const headerAnchorOffset = isWideLayout && isTopologyOverlay ? explorerAnchorLeft : "0rem";
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
              className="h-14 flex items-center justify-between px-4 bg-background border-b border-outline-variant shrink-0 relative z-30"
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
                      "fixed top-14 left-0 bottom-0 z-30 bg-background border-r border-outline-variant transition-transform duration-200 ease-tactical lg:hidden",
                      "w-72 max-w-[85vw] flex flex-col",
                      explorerOpen ? "translate-x-0" : "-translate-x-full",
                    )}
                  >
                    {/* Slice 20 mobile: mobile slide-over rail is
                        vertical (one item per row) — thumb-friendly stack
                        instead of the prior horizontal scroll. */}
                    <Rail pathname={pathname} vertical onMobileClose={() => setExplorerOpen(false)} />
                  </div>
                </>
              )}

              {/* Explorer — desktop column or mobile slide-over.
                  In overlay mode (topology graph): vellum-translucent + z-30
                  so it floats over the canvas. In opaque mode: default
                  Phase 2 behavior (z-20, opaque background). */}
              {explorerVisible && (
                <Explorer
                  open={explorerOpen}
                  onClose={() => setExplorerOpen(false)}
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

              {/* V1 attempt-3 Phase 5 P5-9 — Mobile bottom nav per
                  universal-shell.md L135 + L144: For You / Project /
                  Topology only (NOT Talk; Talk slots are V2 when web
                  terminal ships). lg:hidden so desktop never sees it. */}
              <MobileBottomNav pathname={pathname} />
            </div>
          </div>
      </DiscoveryPlacementContext.Provider>
    </DrawerSelectionContext.Provider>
  );
}

/** V1 mobile bottom nav per universal-shell.md L135 + L144 — 3 slots
 *  (For You / Project / Topology). Talk slots are V2 deferred (when web
 *  terminal ships). Rendered at lg:hidden so desktop never shows it. */
function MobileBottomNav({ pathname }: { pathname: string }) {
  const slots: Array<{
    id: "for-you" | "project" | "topology";
    label: string;
    to: string;
    activeWhen: (p: string) => boolean;
    icon: ComponentType<{ className?: string; strokeWidth?: number | string }>;
  }> = [
    { id: "for-you", label: "For You", to: "/for-you", activeWhen: (p) => p.startsWith("/for-you"), icon: Sparkles },
    { id: "project", label: "Project", to: "/project", activeWhen: (p) => p.startsWith("/project"), icon: Folder },
    { id: "topology", label: "Topology", to: "/topology", activeWhen: (p) => p.startsWith("/topology") || p.startsWith("/rigs/"), icon: Network },
  ];
  return (
    <nav
      data-testid="mobile-bottom-nav"
      aria-label="Mobile bottom navigation"
      className="fixed bottom-0 left-0 right-0 z-40 lg:hidden vellum border-t border-outline-variant flex"
    >
      {slots.map((slot) => {
        const active = slot.activeWhen(pathname);
        return (
          <Link
            key={slot.id}
            to={slot.to}
            data-testid={`mobile-nav-${slot.id}`}
            data-active={active}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-0.5 py-2 font-mono text-[9px] uppercase tracking-wide",
              active
                ? "text-stone-900"
                : "text-on-surface-variant hover:text-stone-900",
            )}
          >
            <slot.icon className="h-5 w-5" strokeWidth={1.25} aria-hidden="true" />
            <span>{slot.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
