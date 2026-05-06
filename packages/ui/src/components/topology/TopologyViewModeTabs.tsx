// V1 attempt-3 Phase 3 — Topology view-mode tabs per topology-tree.md L46–L60 + SC-5 + SC-10.
//
// **LOAD-BEARING SC-10:** view-mode tabs at top of center for SINGLE URL.
// Tabs switch IN-PLACE — NOT separate routes. (Attempt-2 violated this
// by using `/topology/host/table` etc; the canon explicitly forbids that.)
//
// State managed via React (useState in scope page); URL stays at the
// scope path (/topology, /topology/rig/$rigId, etc).

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
}

export function TopologyViewModeTabs<T extends string>({
  tabs,
  active,
  onSelect,
  testIdPrefix = "topology-view-mode",
}: TopologyViewModeTabsProps<T>) {
  return (
    // Internal tablist — div, not <nav>, so SC-1 left-chrome count
    // (querySelectorAll("nav, aside")) stays at exactly 2.
    <div
      role="tablist"
      aria-label="Topology view modes"
      data-testid={`${testIdPrefix}-tabs`}
      className="flex gap-1 border-b border-outline-variant"
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
            "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2 -mb-px",
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
