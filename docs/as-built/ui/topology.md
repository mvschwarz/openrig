---
kind: as-built
title: UI Topology — Graph/Table/Terminal, HotPotato, ActivityRing
status: active
topics: [observability, coordination]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the topology surface is built — the host hybrid graph,
  the rig/pod graphs, the table/terminal views, the activity-ring /
  hot-potato visual language, terminal-preview popovers and launchers, and
  the topology navigation/overlay contracts.
siblings: [shell-and-routing.md, project-and-for-you.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 104b78ee
last-updated: 2026-10-05
---

# UI Topology — Graph/Table/Terminal, HotPotato, ActivityRing

Topology is a scoped workspace with graph, table, and terminal views at the
`/topology` route family (`shell-and-routing.md` §3). It is the operator's
live picture of host → rig → pod → seat.

> Verified against source at `104b78ee` (package version 0.6.6). The web UI
> is in maintenance mode (`docs/reference/developing.md`). The source file
> that defines the hybrid nodes is `HybridTopologyNodes.tsx` (DESIGN.md's
> implementation reference).

## 1. Topology pieces

> `HybridAgentNode` and `HybridPodGroupNode` are exports inside
> `packages/ui/src/components/topology/HybridTopologyNodes.tsx`, not
> top-level files (`HybridPodGroupNode = memo(...)` at
> `HybridTopologyNodes.tsx:101`; `HybridAgentNode = memo(HybridAgentNodeInner,
> ...)` at `:321`).

Components in `packages/ui/src/components/topology/`:

- `HostMultiRigGraph.tsx` — host-level hybrid React Flow graph (multi-rig
  single canvas). Also mounted on the `/project` workspace Workflow tab.
- `HybridTopologyNodes.tsx` — exports `HybridAgentNode` (compact agent cards:
  runtime badges, context %, token totals, activity state, terminal preview,
  per-card CMUX open via `useCmuxLaunch`) and `HybridPodGroupNode` (soft
  dashed pod frames).
- `RigGroupNode.tsx` — soft rig frames with registration marks + aggregate
  activity.
- `ActivityRing.tsx` — active / needs-input / blocked activity ring; card
  activity classes in `activity-card-visuals.ts`.
- `HotPotatoEdge.tsx` — directional queue-movement edge animation.
- `TopologyTableView.tsx` — dense table mirror of topology data (with
  `topology-table-shimmer.css`).
- `TopologyTerminalView.tsx` — pinned-card terminal grid for host, rig or
  pod scope; host scope shows 12 cards by default (`SAFE_N`) with a "show
  all" toggle.
- `TopologyTreeView.tsx` — the topology tree, rendered in the Explorer
  sidebar (`components/Explorer.tsx`), not as a center view mode.
- `TopologyViewModeTabs.tsx` — host tabs Graph / Table / Terminal; rig and
  pod tabs add Overview. Tabs switch in place (React state), not separate
  routes. (`SEAT_SCOPE_TABS` is defined but unused; the seat scope renders
  `LiveNodeDetails`.)
- `TerminalPreviewPopover.tsx` — smoked-glass terminal preview, portaled
  above the graph. On the graph and table it is `progressive`: a static
  mirror first, click to go live, under a page-wide live-terminal cap.
- `TerminalLauncher.tsx` — the rig-scope tab-bar launcher: choose a
  provider (herdr or cmux) and a view (this rig, a pod, a mission's or
  slice's agents, a saved view), then open it via
  `POST /api/terminal/open`. Shown only when the selected host is local.
- `LaunchCmuxButton.tsx` — the older rig-scope "Launch in CMUX" button.
  `TerminalLauncher` replaced it in the tab bar, and no production
  component imports it now (tests still do).
- `ScopePages.tsx` — host/rig/pod/seat scope page wrappers.
- `topology-overlay-context.tsx` — `TopologyOverlayProvider`: expanded-rig
  state, the rig named in the URL auto-expanded, and the Explorer mode
  (`overlay` on the graph tab, `opaque` on the others).

The rig and pod graphs are not the hybrid graph: rig and pod scopes render
`components/RigGraph.tsx` (`RigNode` cards, `graph-layout.ts` layout),
sharing `HotPotatoEdge` and `useTopologyActivity`. Rig scope's Overview tab
renders `RigOverviewTab` (`RigSpecDisplay`); pod scope's is a placeholder.
On narrow viewports the graph tab falls back to the table.

> Source: `topology/TopologyViewModeTabs.tsx` (`HOST_SCOPE_TABS`,
> `RIG_POD_SCOPE_TABS`, `SEAT_SCOPE_TABS`); `topology/ScopePages.tsx`
> (`TerminalLauncher` `:270`, `RigGraph` `:322`/`:437`, `RigOverviewTab`
> `:342`, `useOverlayForActiveTab`); `topology/TerminalPreviewPopover.tsx`
> (`progressive`); `topology/TopologyTerminalView.tsx` (`SAFE_N` `:35`).

> Note (vs `DESIGN.md` "Topology"): DESIGN.md lists the exported brand
> primitives (`HostMultiRigGraph`, `HybridAgentNode`, `HybridPodGroupNode`,
> `RigGroupNode`, `ActivityRing`, `HotPotatoEdge`, `TerminalPreviewPopover`,
> `TopologyTableView`, `TopologyTerminalView`); all are present in source.
> `TopologyTreeView`, `TopologyViewModeTabs`, `TerminalLauncher` and
> `LaunchCmuxButton` exist in source but are not in DESIGN.md's primitive
> list (a scope difference, not drift).

## 2. Topology contracts

Re-confirmed against source:

- Graph / table / tree navigation all resolve to seat detail URLs
  (`/topology/seat/$rigId/$logicalId`).
- The host-level graph prefixes node IDs per rig for the multi-rig single
  canvas (`lib/hybrid-layout.ts`: `PREFIX_DELIMITER = "::"`,
  `prefixedHybridNodeId`).
- Expanded-rig state is owned by `TopologyOverlayProvider`. Rigs default to
  **expanded** (`DEFAULT_RIG_EXPANDED = true` in `HostMultiRigGraph.tsx`),
  with "Expand all" / "Collapse all" controls; graph data is fetched for
  expanded rigs only.
- Compact agent cards show context percentage, token totals, and activity
  card tint; `ActivityRing` + activity classes surface active / needs-input /
  blocked.
- `HotPotatoEdge` animates directional queue movement with non-scaling
  strokes; reduced-motion preference removes pulse/travel animation and
  keeps static state signals.
- Terminal-preview actions are hover/focus-visible; the
  `TerminalPreviewPopover` escapes React Flow stacking contexts (portaled
  to `document.body`) and stays within the viewport.
- With a non-local host selected, the host graph fetch carries the host
  parameter; terminal-preview and CMUX buttons are hidden on cards and in
  the table; and the rig page shows a read-only marker instead of the
  launcher.

## 3. Layout and activity helpers

In `src/lib/`: `hybrid-layout.ts` lays out the host graph
(`HostMultiRigGraph`); `graph-layout.ts` (`applyTreeLayout`) lays out the
rig/pod graph (`RigGraph`); `multi-rig-layout.ts` has no production
importer (tests only). `topology-activity.ts` computes ring states and
hot-potato edges, and `activity-visuals.ts` the rollups and activity dots.
Runtime/tool identity on the cards comes from the central
`lib/runtime-brand.ts` / `lib/tool-brand.ts` and
`components/graphics/RuntimeMark.tsx` (runtimes: Claude Code, Codex, Pi,
OMP, terminal, unknown). Do not duplicate brand logic (DESIGN.md "Do
not").

## See also

- `shell-and-routing.md` — the `/topology` route family and shell.
- `project-and-for-you.md` — sibling observability surface.
- `../architecture/coordination-primitive.md` — the queue movement the
  hot-potato edge visualizes.
- Source root: `packages/ui/src/components/topology/`,
  `packages/ui/src/components/RigGraph.tsx`,
  `packages/ui/src/lib/{hybrid,graph}-layout.ts`.
