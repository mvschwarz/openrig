import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils.js";
import { ProjectTreeView } from "./project/ProjectTreeView.js";
import { SpecsTreeView } from "./specs/SpecsTreeView.js";
import { SettingsExplorer } from "./system/SettingsExplorer.js";
import { TopologyTreeView } from "./topology/TopologyTreeView.js";
import { SubscriptionToggleList } from "./for-you/SubscriptionToggleList.js";

import type { DrawerSelection } from "./SharedDetailDrawer.js";

export type ExplorerDesktopMode = "full" | "hidden";

// V1 attempt-3 Phase 2 — canon surface union per universal-shell.md L62:
// "Renders the destination's tree (or a feed lens filter chip rail for
// For You; or a flat nav for Settings; or nothing for Dashboard)."
//
// Phase 2 lays the union; Phase 3 fills tree contents + lens chips.
export type ExplorerSurface =
  | "topology"
  | "project"
  | "specs"
  | "for-you"
  | "settings"
  | "none";

/**
 * Slice 26.D OPT-D3 Topology mobile Explorer mount-suppression rule.
 *
 * Returns true when the Explorer for a given surface should NOT MOUNT
 * at the current viewport. The single carve-out: Topology surface at
 * narrow viewports (isWideLayout=false). Pre-existing renderer-spin
 * in the Topology mobile render path (TopologyTableView +
 * TopologyTreeView combined) pegs the browser when Explorer mounts
 * at 375px; mount-suppression sidesteps the peg trigger.
 *
 * 0.3.2 fixes the Topology mobile render path; this carve-out
 * returns false for all surfaces at that time.
 */
export function shouldSuppressExplorerMount(
  surface: ExplorerSurface,
  isWideLayout: boolean,
): boolean {
  return surface === "topology" && !isWideLayout;
}

export interface ExplorerProps {
  open: boolean;
  onClose?: () => void;
  selection?: DrawerSelection;
  onSelect?: (sel: DrawerSelection) => void;
  desktopMode?: ExplorerDesktopMode;
  surface?: ExplorerSurface;
  onDesktopToggle?: () => void;
  /** V1 attempt-3 Phase 3 bounce-fix — Class B selective vellum overlay.
   *  "overlay" = vellum-translucent + position absolute z-30 (topology
   *  graph view-mode signature). "opaque" = default solid background
   *  (every other destination + view-mode). */
  overlayMode?: "overlay" | "opaque";
}

// Surface-routed body. Phase 2 lays placeholders for non-topology
// surfaces; Phase 3 fills tree contents + lens chips. "none" surface
// (Dashboard only — slice 26 promoted Settings to a 4-destination
// Explorer peer with its own SettingsExplorer surface) means Explorer
// is not rendered at all.
function SurfaceBody({ surface }: { surface: ExplorerSurface }) {
  if (surface === "topology") {
    return <TopologyTreeView />;
  }
  if (surface === "project") {
    return <ProjectTreeView />;
  }
  if (surface === "specs") {
    return <SpecsTreeView />;
  }
  if (surface === "settings") {
    return <SettingsExplorer />;
  }
  if (surface === "for-you") {
    // Subscription affordance — settings-shaped surface per for-you-feed.md L134-L140.
    // The PRIMARY UX of /for-you is the FEED in the center; subscriptions live
    // here as a small on-demand list. NOT dominating.
    //
    // OPR.0.4.1.27: the PRIMARY subscription control is the plain-language
    // LevelControl at the TOP OF THE FEED (Feed.tsx) — phone-reachable per the
    // v5 mockup. This Explorer sidebar holds the 5 individual toggles as the
    // ADVANCED view (desktop). action_required is forced ON. Settings
    // unreachable → canonical defaults + CLI hint.
    return (
      <div data-testid="explorer-for-you-subscriptions" className="flex-1 overflow-y-auto py-3 px-3">
        <div className="text-[11px] text-on-surface-variant mb-2">
          Advanced · individual toggles
        </div>
        <SubscriptionToggleList />
      </div>
    );
  }
  return null;
}

export function Explorer({
  open,
  desktopMode = "full",
  surface = "topology",
  onDesktopToggle = () => {},
  overlayMode = "opaque",
}: ExplorerProps) {
  // Surface "none" (Dashboard only — Settings has its own Explorer
  // surface as of slice 26) — Explorer is not rendered.
  if (surface === "none") return null;

  // Class B: overlay vs opaque background grammar.
  // OPAQUE (default; every destination except topology-graph): solid
  //   paper-cream tone (Phase 2 baseline) so the explore tree reads
  //   crisply against the center workspace.
  // OVERLAY (topology graph only): light vellum translucent surface
  //   (.vellum class from globals.css L113-117 — rgba(255,255,255,0.4)
  //   + backdrop-blur(8px)) with elevated z-index so the graph canvas
  //   underneath shows through. Sheets-of-vellum-layered aesthetic per
  //   universal-shell.md L48. Vellum (40%) reads coherent with the
  //   baseline 3.5% opacity Phase 2 had; vellum-heavy (70%) was too dense.
  const isOverlay = overlayMode === "overlay";
  const isCollapsed = desktopMode === "hidden";

  // When collapsed at desktop: render ONLY a floating toggle button
  // at left=rail-edge (no aside container behind it). The Explorer
  // surface tree is unmounted; the canvas + tabs reflow to fill the
  // freed width.
  if (isCollapsed) {
    return (
      <button
        type="button"
        data-testid="explorer-edge-toggle"
        data-explorer-collapsed="true"
        aria-label="Expand explorer"
        onClick={onDesktopToggle}
        className={cn(
          "hidden lg:flex absolute top-8 left-[calc(var(--sidebar-current-width)+0.25rem)] z-30 h-8 w-8 items-center justify-center",
          "rounded-full border border-outline-variant bg-background/90 text-on-surface",
          "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors",
          "hover:bg-surface-low hover:text-on-surface",
        )}
      >
        <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <aside
      data-testid="explorer"
      data-surface={surface}
      data-explorer-mode={overlayMode}
      data-explorer-collapsed="false"
      tabIndex={-1}
      className={cn(
        // V1 border weight doctrine (universal-shell.md L39–L48):
        // 1px outline-variant ghost line for inter-region edges.
        "border-r border-outline-variant flex overflow-hidden",
        // Background grammar by mode:
        //
        // Slice 26.B HG-8 mobile-drawer-layering repair (OPT-B per
        // orch routing): opaque-mode Explorer mobile drawer must
        // layer ABOVE the mobile-rail-tray (AppShell.tsx z-30) so
        // click hits register on Explorer items. Pre-repair value
        // was z-20 (below rail-tray) — pre-existing bug exposed by
        // slice 26 because Settings was the 5th Explorer-bearing
        // destination on mobile. Opaque-mode bumped to z-40 for all
        // surfaces; overlay-mode stays z-30 (Topology graph behavior
        // preserved; rail-tray and overlay-mode Explorer paint at
        // same z, DOM order resolves Explorer above since it renders
        // later in AppShell). Rail-tray remains reachable via backdrop
        // dismissal on mobile.
        //
        // Slice 26.D OPT-D3 carve-out (separate gate in AppShell.tsx,
        // NOT here): Topology mobile Explorer doesn't MOUNT on
        // viewport < lg (avoids pre-existing TopologyTableView
        // renderer-spin that pegs the browser when Explorer mounts
        // at 375px). The mount-gate is in AppShell.tsx ~line 577;
        // this z-index block is reached only when Explorer is
        // actually mounted, so no conditional is needed here. 0.3.2
        // will fix the Topology mobile render path; the AppShell
        // mount-gate reverts at that time.
        isOverlay
          ? "vellum z-30 shadow-[6px_0_14px_rgba(46,52,46,0.06)]"
          : "z-40 bg-[hsl(var(--background)/0.035)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[6px_0_14px_rgba(46,52,46,0.04)]",
        // Mobile: slide-over within the shell content, below the notice and
        // header. Opaque on phones: the desktop glass background let the
        // page underneath bleed through the panel.
        !isOverlay && "max-lg:!bg-background",
        "absolute top-0 bottom-0 left-0 transition-transform duration-200 ease-tactical w-72 max-w-[80vw]",
        open ? "translate-x-0" : "-translate-x-full",
        // Desktop (>=lg): persistent column at 280px (lg:w-72) per
        // universal-shell.md L34. Positioned absolutely after the sidebar
        // (left edge = --sidebar-current-width, set on the flex wrapper
        // in AppShell).
        "lg:absolute lg:top-0 lg:bottom-0 lg:left-[var(--sidebar-current-width)] lg:w-72 lg:max-w-none lg:translate-x-0",
      )}
    >
      {/* F12 (#2417): narrow-viewport bottom padding keeps the last rows
          above the fixed MobileBottomNav (h-14 + safe-area). Desktop (lg:)
          keeps zero bottom padding. */}
      <div className="relative flex h-full w-full flex-col pb-[calc(env(safe-area-inset-bottom)+3.5rem)] lg:pb-0">
        <button
          type="button"
          data-testid="explorer-edge-toggle"
          aria-label="Collapse explorer"
          onClick={onDesktopToggle}
          className={cn(
            "hidden lg:flex absolute z-10 h-8 w-8 items-center justify-center rounded-full border border-outline-variant bg-background/90 text-on-surface",
            "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors hover:bg-surface-low hover:text-on-surface",
            "right-2 top-3",
          )}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </button>

        <SurfaceBody surface={surface} />
      </div>
    </aside>
  );
}
