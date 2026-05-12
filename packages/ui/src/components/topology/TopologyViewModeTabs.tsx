// V1 attempt-3 Phase 3 — Topology view-mode tabs per topology-tree.md L46–L60 + SC-5 + SC-10.
//
// **LOAD-BEARING SC-10:** view-mode tabs at top of center for SINGLE URL.
// Tabs switch IN-PLACE — NOT separate routes. (Attempt-2 violated this
// by using `/topology/host/table` etc; the canon explicitly forbids that.)
//
// State managed via React (useState in scope page); URL stays at the
// scope path (/topology, /topology/rig/$rigId, etc).

import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type TopologyHostScopeTab = "graph" | "table" | "terminal";
export type TopologyRigPodScopeTab = "graph" | "table" | "terminal" | "overview";
export type TopologySeatScopeTab = "detail" | "transcript" | "terminal";
export type AnyTopologyTab =
  | TopologyHostScopeTab
  | TopologyRigPodScopeTab
  | TopologySeatScopeTab;

interface TopologyViewModeTabsProps<T extends string> {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
  testIdPrefix?: string;
  /**
   * Slice 24 — optional trailing slot rendered with ml-auto inside the
   * tab-bar flex container. Used by RigScopePage to render the
   * "Launch in CMUX" button at the tab-bar far right per README §Button
   * placement Option C (persistent across all rig-scope view-mode tabs).
   */
  trailing?: ReactNode;
}

export function TopologyViewModeTabs<T extends string>({
  tabs,
  active,
  onSelect,
  testIdPrefix = "topology-view-mode",
  trailing,
}: TopologyViewModeTabsProps<T>) {
  // Slice 24.D repair (velocity-guard secondary concern):
  // keep tablist children scoped to tabs only — outer flex wrapper
  // hosts both the tablist AND the trailing slot as siblings.
  // Internal tablist — div, not <nav>, so SC-1 left-chrome count
  // (querySelectorAll("nav, aside")) stays at exactly 2. No wrapper
  // line border — only the active tab carries an underline; the rest
  // of the tablist breathes over the canvas.
  const tablist = (
    <div
      role="tablist"
      aria-label="Topology view modes"
      data-testid={`${testIdPrefix}-tabs`}
      className="flex gap-6 items-center"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          data-testid={`${testIdPrefix}-tab-${t.id}`}
          data-active={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "py-3 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2",
            active === t.id
              ? "border-stone-900 text-stone-900"
              : "border-transparent text-on-surface-variant hover:text-stone-900",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  if (!trailing) return tablist;

  return (
    <div
      data-testid={`${testIdPrefix}-tab-bar`}
      className="flex items-center"
    >
      {tablist}
      <div data-testid={`${testIdPrefix}-trailing`} className="ml-auto">
        {trailing}
      </div>
    </div>
  );
}

export const HOST_SCOPE_TABS: { id: TopologyHostScopeTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "table", label: "Table" },
  { id: "terminal", label: "Terminal" },
];

export const RIG_POD_SCOPE_TABS: { id: TopologyRigPodScopeTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "table", label: "Table" },
  { id: "terminal", label: "Terminal" },
  { id: "overview", label: "Overview" },
];

export const SEAT_SCOPE_TABS: { id: TopologySeatScopeTab; label: string }[] = [
  { id: "detail", label: "Detail" },
  { id: "transcript", label: "Transcript" },
  { id: "terminal", label: "Terminal" },
];
