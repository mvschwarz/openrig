---
kind: as-built
title: UI Topology — Graph/Table/Terminal, HotPotato, ActivityRing
status: active
topics: [observability, coordination]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the topology surface is built — the host hybrid graph,
  the table/terminal views, the activity-ring / hot-potato visual language,
  terminal-preview popovers, and the topology navigation/overlay contracts.
siblings: [shell-and-routing.md, project-and-for-you.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI Topology — Graph/Table/Terminal, HotPotato, ActivityRing

Topology is a scoped workspace with graph, table, and terminal views at the
`/topology` route family (`shell-and-routing.md` §3). It is the operator's
live picture of host → rig → pod → seat.

> Verified against source at HEAD `7eaf524c`; package version **0.3.1**
> (slice-00 §1.1). All component names below are re-confirmed against
> `packages/ui/src/components/topology/` at HEAD — `ui.md` and `DESIGN.md`
> name *exported symbols*; the source file that defines the hybrid nodes is
> `HybridTopologyNodes.tsx` (DESIGN.md L344 implementation reference).

## 1. Topology pieces

> Drift-fix — `ui.md` "Topology" (L108–137) lists `HybridAgentNode` /
> `HybridPodGroupNode` as if top-level files. Re-confirmed at HEAD: both are
> exports inside `packages/ui/src/components/topology/HybridTopologyNodes.tsx`
> (`HybridPodGroupNode` is `memo(...)` at `HybridTopologyNodes.tsx:94`;
> `HybridAgentNode` is `memo(HybridAgentNodeInner, ...)` at `:272`). The
> component names are accurate; their file location is consolidated.

Components in `packages/ui/src/components/topology/` (re-confirmed at HEAD):

- `HostMultiRigGraph.tsx` — host-level hybrid React Flow graph (multi-rig
  single canvas).
- `HybridTopologyNodes.tsx` — exports `HybridAgentNode` (compact agent cards:
  runtime badges, context %, token totals, activity state, terminal preview,
  CMUX actions) and `HybridPodGroupNode` (soft dashed pod frames).
- `RigGroupNode.tsx` — soft rig frames with registration marks + aggregate
  activity.
- `ActivityRing.tsx` — active / needs-input / blocked activity ring; card
  activity classes in `activity-card-visuals.ts`.
- `HotPotatoEdge.tsx` — directional queue-movement edge animation.
- `TopologyTableView.tsx` — dense table mirror of topology data.
- `TopologyTerminalView.tsx` — terminal-oriented topology state.
- `TopologyTreeView.tsx` — tree navigation view.
- `TopologyViewModeTabs.tsx` — graph/table/terminal/tree mode switch.
- `TerminalPreviewPopover.tsx` — black-glass quick terminal preview, portaled
  above the graph.
- `LaunchCmuxButton.tsx` — hover/focus CMUX launch action.
- `ScopePages.tsx` — host/rig/pod/seat scope page wrappers.
- `topology-overlay-context.tsx` — `TopologyOverlayProvider` (expanded-rig
  state).

> Note (vs `DESIGN.md` "Topology" L205–216): DESIGN.md lists the same
> exported primitives (`HostMultiRigGraph`, `HybridAgentNode`,
> `HybridPodGroupNode`, `RigGroupNode`, `ActivityRing`, `HotPotatoEdge`,
> `TerminalPreviewPopover`, `TopologyTableView`, `TopologyTerminalView`) —
> reconciled against source: all present at HEAD. `TopologyTreeView` /
> `TopologyViewModeTabs` / `LaunchCmuxButton` exist in source but are not in
> DESIGN.md's primitive list (DESIGN.md is the brand primitive list, not an
> exhaustive component inventory; not a drift, a scope difference). DESIGN.md
> stays byte-identical (Q1).

## 2. Topology contracts

From `architecture.md` §2 "Current topology UI" + `ui.md` "Important
topology contracts", re-confirmed against source behaviour at HEAD:

- Graph / table / tree navigation all resolve to seat detail URLs
  (`/topology/seat/$rigId/$logicalId`).
- The host-level graph uses cross-rig node-ID prefixing for multi-rig single
  canvas.
- Expanded-rig state is owned by `TopologyOverlayProvider`
  (`topology-overlay-context.tsx`); graph data is lazy-fetched for expanded
  rigs only.
- Compact agent cards show context percentage, token totals, and activity
  card tint; `ActivityRing` + activity classes surface active / needs-input /
  blocked.
- `HotPotatoEdge` animates directional queue movement at graph zoom levels;
  reduced-motion preference removes pulse/travel animation and keeps static
  state signals.
- Terminal-preview actions are hover/focus-visible; the
  `TerminalPreviewPopover` must escape React Flow stacking contexts (portaled
  above the canvas) and stay within the viewport.

## 3. Layout helpers

Topology layout is computed by `src/lib/` helpers (re-confirmed at HEAD):
`graph-layout.ts`, `hybrid-layout.ts`, `multi-rig-layout.ts`,
`topology-activity.ts`, `activity-visuals.ts`. Runtime/tool identity on the
cards comes from the central `runtime-brand.ts` / `tool-brand.ts` +
`RuntimeMark.tsx` (do not duplicate brand logic — DESIGN.md "Do not";
restated here as the topology-card brand-source contract).

## See also

- `shell-and-routing.md` — the `/topology` route family and shell.
- `project-and-for-you.md` — sibling observability surface.
- `../architecture/coordination-primitive.md` — the queue movement the
  hot-potato edge visualizes.
- Source root: `packages/ui/src/components/topology/`,
  `packages/ui/src/lib/{graph,hybrid,multi-rig}-layout.ts`.
