---
kind: as-built
title: UI Shell, Routing, Drawer System
status: active
topics: [observability]
domains: [engineering-advisor, product-advisor]
applies-when: |
  Need to know how the UI shell (AppShell rail / Explorer / center workspace /
  drawer / preview stack) is assembled, the actual route tree the shipped UI
  mounts, or how the shared detail drawer and event consumption work.
siblings: [topology.md, project-and-for-you.md, library-specs-and-design-system.md]
prerequisite-reads: [../README.md]
last-verified-against-source: 2caac7dd1bb16585138a6f7c1dd8b1f0752c49f7
last-updated: 2026-10-05
---

# UI Shell, Routing, Drawer System

The `@openrig/ui` package is the shell-first, route-first, primitive-driven
operator surface. Brand/visual rules live in `docs/DESIGN.md` (pointer from
`library-specs-and-design-system.md`); this module is how the shell is
assembled and what routes it mounts.

> Verified against source at `2caac7dd`; package version 0.6.7. UI
> footprint is **304** source files (`packages/ui/src`, `.ts`+`.tsx`,
> non-test; 235 at the previous stamp `7eaf524c`). The web UI is in
> maintenance mode (`docs/reference/developing.md`).

## 1. Package shape

UI package: `packages/ui`. Primary implementation areas:

- `src/routes.tsx` — TanStack Router route tree.
- `src/App.tsx`, `src/main.tsx` — app root (`ThemeProvider`, the
  maintenance notice, the router).
- `src/components/AppShell.tsx` — global shell: rail, Explorer, drawer,
  preview stack.
- `src/components/ui/` — reusable vellum + base UI primitives.
- `src/components/graphics/RuntimeMark.tsx` — runtime/tool/actor marks.
- `src/components/topology/` — graph/table/terminal topology surfaces.
- `src/components/project/`, `for-you/`, `dashboard/`, `feed/` —
  observability surfaces.
- `src/components/review/`, `workflow/` — review altitudes (`/agents`,
  `/fleet`) and workflow pages.
- `src/components/specs/` — Library / skills / plugins surfaces.
- `src/components/{preview,markdown,drawer-viewers}/` — viewers.
- `src/hooks/`, `src/lib/` — route data hooks, classifiers, formatters,
  layout/brand helpers.

## 2. Shell model

The root route wraps `AppShell` in `QueryClientProvider` and
`DaemonHealthProvider` (`routes.tsx:80-90`). Above the router, `App.tsx`
renders a dismissible `UiMaintenanceNotice` (localStorage key
`openrig.uiMaintenanceNoticeDismissed`); `main.tsx` mounts `ThemeProvider`.

`AppShell.tsx` lays a 48px icon rail + a route-aware Explorer sidebar +
center workspace + shared right drawer + preview stack + topology overlay
provider + shared drawer-selection / discovery-placement / specs-workspace
contexts. The top bar's right slot holds `HostIndicator` and
`ThemeSelector`. When the shared event connection is down, a "Live updates
unavailable…" status line shows. Switching the selected host clears the
discovery placement (`useClearPlacementOnHostSwitch`). Below the `lg`
breakpoint a 3-slot `MobileBottomNav` (For You / Project / Topology) also
shows.

The rail destinations (`AppShell.tsx` `RAIL_ICONS`) are exactly six
destination icons plus Advisor/Operator entries:

- Dashboard `/` (`rail-dashboard`)
- Topology `/topology` (`rail-topology`)
- For You `/for-you` (`rail-for-you`)
- Project `/project` (`rail-project`)
- Library `/specs` (`rail-specs`)
- Settings `/settings` (`rail-settings`)

The Explorer is contextual: its tree changes with the current destination
rather than acting as a generic file browser.

## 3. Route model

> The route table below is derived from `packages/ui/src/routes.tsx` at
> `2caac7dd` (605 lines). Each line number is the route's
> `createRoute(` line. The exported route tree is assembled at
> `routes.tsx:539` (`export const routeTree = rootRoute.addChildren([`);
> it holds 54 routes.
>
> `/mission-control` and `/progress` are **redirect stubs**, not
> destination routes, and there is **no `/markdown` route** (markdown is
> rendered by the `MarkdownViewer` component). There is a real `/files`
> route.

### Primary destination routes

| Path | Component | Notes |
|---|---|---|
| `/` | Dashboard (`indexRoute` `routes.tsx:96`) | rail destination |
| `/topology` | host topology (`:106`) | + rig/pod/seat scopes (see `topology.md`) |
| `/topology/rig/$rigId` | rig scope (`:112`) | |
| `/topology/pod/$rigId/$podName` | pod scope (`:118`) | |
| `/topology/seat/$rigId/$logicalId` | seat scope (`:124`) | live node details |
| `/for-you` | attention feed (`:130`) | rail destination |
| `/project` | workspace project scope (`:136`) | rail destination |
| `/project/mission/$missionId` | mission scope (`:142`) | |
| `/project/slice/$sliceId` | slice scope (`:148`) | |
| `/specs` | Library (`:202`) | rail destination |
| `/specs/applications` | applications section (`:208`) | |
| `/specs/skills` | skills index (`:216`) | |
| `/specs/skills/$skillToken` | skill viewer (`:222`) | defaults to `SKILL.md` |
| `/specs/skills/$skillToken/file/$fileToken` | skill file viewer (`:231`) | |
| `/specs/plugins` | plugins index (`:242`) | 0.3.1 (see `library-specs…`) |
| `/plugins/$pluginId` | plugin detail (`:257`) | 0.3.1 |
| `/specs/$specKind/$specName` | generic spec → library redirect (`:269`) | |
| `/files` | Files workspace (`:248`) | |
| `/settings` | settings center (`:278`) | rail destination |
| `/settings/policies` | Policies (`:288`) | Claude-compaction form |
| `/settings/log` | Log (`:293`) | 4-item Settings explorer |
| `/settings/status` | Status (`:298`) | |
| `/search` | audit/history view (`:304`) | |

### Zoom-addressed routes (no rail entry)

Reached from other views and deep links, deliberately not on the rail:

| Path | Component | Notes |
|---|---|---|
| `/agents` | `RigAgentsPage` (`:159`) | rig review altitude; separate from legacy `/agents/validate` |
| `/fleet` | `FleetPage` (`:171`) | fleet attention altitude above host |
| `/workflows` | `WorkflowsPage` (`:181`) | |
| `/workflow/instance/$instanceId` | `WorkflowInstancePage` (`:187`) | optional `?step=<id>` anchor |

### Lab routes (design experiments)

`/lab/project-graphics-preview` (`:310`), `/lab/card-previews` (`:318`),
`/lab/vellum-lab` (`:328`), `/lab/vellum-bg/{a-large,b-small,c-allover}`
(`:339`–`:349`). The vellum-lab + vellum-bg routes are the 0.3.1 vellum
brand-system experiment surface (the `dashboard/vellum/*` system is 0.3.1).

### Legacy / compatibility routes

`/rigs/$rigId` (`:374`), `/rigs/$rigId/nodes/$logicalId` (`:380`),
`/import` (`:389`), `/packages`, `/packages/install`, `/packages/$packageId`
(`:395`–`:407`), `/bootstrap` (`:413`), `/agents/validate` (`:419`),
`/specs/rig` + `/specs/agent` review (`:428`/`:434`),
`/specs/library/$entryId` (`:440`), `/discovery` + `/discovery/inventory`
(`:451`/`:466`), `/bundles/inspect` + `/bundles/install` (`:472`/`:478`).

### Redirect stubs (deleted routes)

`routes.tsx:488`–`:530` mount `<Navigate>` redirects for removed routes —
NOT destination pages: `/context` → `/topology`; `/mission-control` →
`/for-you` (For-You replaces it); `/slices` → `/project`; `/slices/$name` →
`/project/slice/$sliceId` (with `sliceId` set to the name); `/progress` →
`/project`; `/steering` → `/project`. The Mission Control *system* still
exists in the daemon (`../architecture/mission-control.md`); only the old
UI *route* was retired in favour of For-You.

## 4. Drawer and viewer system

`SharedDetailDrawer` is the shared transient detail surface for queue-item
viewer, file viewer (`FileViewer`), subspec preview, and other detail
selections. Drawer triggers carry root/path provenance so the viewer
fetches and renders the correct content; the drawer supports outside-click
dismissal.

Image proof viewing: For-You cards use `ProofImageViewer`
(`components/project/ProofImageViewer.tsx`), which stays inside the shell
layout. The Project Proof tab and the Review surfaces use the full-viewport
`Lightbox` (`components/project/Lightbox.tsx`; mounted in
`project/ProofTab.tsx`, `review/EvidenceOpener.tsx`,
`review/SliceReviewTab.tsx`).

Skill detail (`components/specs/SkillDetailPage.tsx`) renders its own
two-pane docs browser — a file tree beside a viewer — and draws content
with `MarkdownViewer` (`.md`/`.mdx`) or `SyntaxHighlight` (other text). It
does not use `FileViewer`, which only the shared drawer renders.

## 5. Event and activity consumption

UI event consumption is centralized through one shared `/api/events`
connection (`lib/topology-events.ts`) so related surfaces avoid duplicate
SSE connections. Current consumers: For You feed hydration, topology
activity rings + hot-potato movement, the activity feed/system surfaces,
and rig event surfaces. `useGlobalEvents` reports whether that connection
is up and refetches review, slice and mission data on reconnect and on
`proof.*` events. Reduced-motion preference is honoured for pulse/packet
animation. (Daemon SSE surfaces: `/api/events`, `/api/stream/watch`,
`/api/queue/watch` —
[`../architecture/architecture-rules-and-event-system.md`](../architecture/architecture-rules-and-event-system.md)
§2, "Emission and delivery".)

## See also

- `topology.md` — graph/table/terminal topology surface.
- `project-and-for-you.md` — project observability + For-You feed.
- `library-specs-and-design-system.md` — Library/specs + DESIGN.md pointer.
- Source roots: `packages/ui/src/routes.tsx`,
  `packages/ui/src/components/AppShell.tsx`.
