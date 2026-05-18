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
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI Shell, Routing, Drawer System

The `@openrig/ui` package is the shell-first, route-first, primitive-driven
operator surface. Brand/visual rules live in `docs/DESIGN.md` (pointer from
`library-specs-and-design-system.md`); this module is how the shell is
assembled and what routes it mounts.

> Verified against source at HEAD `7eaf524c`; package version **0.3.1**
> (slice-00 §1.1). UI footprint is **235** source files
> (`packages/ui/src`, `.ts`+`.tsx`, non-test; slice-00 §1.6 / D6).

## 1. Package shape

UI package: `packages/ui`. Primary implementation areas:

- `src/routes.tsx` — TanStack Router route tree.
- `src/components/AppShell.tsx` — global shell: rail, Explorer, drawer,
  preview stack.
- `src/components/ui/` — reusable vellum + base UI primitives.
- `src/components/graphics/RuntimeMark.tsx` — runtime/tool/actor marks.
- `src/components/topology/` — graph/table/terminal topology surfaces.
- `src/components/project/`, `for-you/`, `dashboard/`, `feed/` —
  observability surfaces.
- `src/components/specs/` — Library / skills / plugins surfaces.
- `src/components/{preview,markdown,drawer-viewers}/` — viewers.
- `src/hooks/`, `src/lib/` — route data hooks, classifiers, formatters,
  layout/brand helpers.

## 2. Shell model

`AppShell` wraps every route. `AppShell.tsx` lays a 48px icon rail + a
route-aware Explorer sidebar + center workspace + shared right drawer +
preview stack + topology overlay provider + shared drawer-selection /
discovery-placement contexts.

The rail destinations (`AppShell.tsx` `RAIL_ICONS`, re-confirmed at HEAD)
are exactly six destination icons plus Advisor/Operator entries:

- Dashboard `/` (`rail-dashboard`)
- Topology `/topology` (`rail-topology`)
- For You `/for-you` (`rail-for-you`)
- Project `/project` (`rail-project`)
- Library `/specs` (`rail-specs`)
- Settings `/settings` (`rail-settings`)

The Explorer is contextual: its tree changes with the current destination
rather than acting as a generic file browser.

## 3. Route model

> Drift-fix D16 — `ui.md` "Route Model" (the L52–73 list) and
> `architecture.md` §2 "UI architecture" predate 0.3.x. The route table
> below is **re-derived from `packages/ui/src/routes.tsx` at HEAD** (542
> lines). The route tree is assembled at `routes.tsx:480`
> (`rootRoute.addChildren([...])`).
>
> Correction to the D16 expectation itself (source-verified at HEAD): the
> survey expected `/mission-control`, `/progress`, `/markdown` as net-new
> *real* routes. At HEAD `/mission-control` and `/progress` are **redirect
> stubs**, not destination routes, and there is **no `/markdown` route**.
> There IS a real `/files` route (markdown is rendered by the `MarkdownViewer`
> component inside file/drawer surfaces, not via a `/markdown` route). The
> route table is reported as source says, not as the survey predicted.

### Primary destination routes

| Path | Component | Notes |
|---|---|---|
| `/` | Dashboard (`indexRoute` `routes.tsx:88`) | rail destination |
| `/topology` | host topology (`:98`) | + rig/pod/seat scopes (see `topology.md`) |
| `/topology/rig/$rigId` | rig scope (`:104`) | |
| `/topology/pod/$rigId/$podName` | pod scope (`:110`) | |
| `/topology/seat/$rigId/$logicalId` | seat scope (`:116`) | live node details |
| `/for-you` | attention feed (`:122`) | rail destination |
| `/project` | workspace project scope (`:128`) | rail destination |
| `/project/mission/$missionId` | mission scope (`:134`) | |
| `/project/slice/$sliceId` | slice scope (`:140`) | |
| `/specs` | Library (`:146`) | rail destination |
| `/specs/applications` | applications section (`:152`) | |
| `/specs/skills` | skills index (`:160`) | |
| `/specs/skills/$skillToken` | skill viewer (`:166`) | defaults to `skill.md` |
| `/specs/skills/$skillToken/file/$fileToken` | skill file viewer (`:175`) | |
| `/specs/plugins` | plugins index (`:186`) | 0.3.1 (see `library-specs…`) |
| `/plugins/$pluginId` | plugin detail (`:201`) | 0.3.1 |
| `/specs/$specKind/$specName` | generic spec → library redirect (`:213`) | |
| `/files` | Files workspace (`:192`) | net-new vs ui.md/D16 |
| `/settings` | settings center (`:222`) | rail destination |
| `/settings/policies` | Policies (`:232`) | slice 27 Claude-compaction form |
| `/settings/log` | Log (`:237`) | slice 26 4-item Settings explorer |
| `/settings/status` | Status (`:242`) | |
| `/search` | audit/history view (`:248`) | |

### Lab routes (design experiments)

`/lab/project-graphics-preview` (`:254`), `/lab/card-previews` (`:262`),
`/lab/vellum-lab` (`:272`), `/lab/vellum-bg/{a-large,b-small,c-allover}`
(`:283`–`:293`). The vellum-lab + vellum-bg routes are the 0.3.1 vellum
brand-system experiment surface (slice-00 0.3.0-GT seam b: vellum brand
identity matured in 0.3.1; the `dashboard/vellum/*` system is 0.3.1).

### Legacy / compatibility routes

`/rigs/$rigId` (`:318`), `/rigs/$rigId/nodes/$logicalId` (`:324`),
`/import` (`:333`), `/packages`, `/packages/install`, `/packages/$packageId`
(`:339`–`:351`), `/bootstrap` (`:357`), `/agents/validate` (`:363`),
`/specs/rig` + `/specs/agent` review (`:372`/`:378`),
`/specs/library/$entryId` (`:384`), `/discovery` + `/discovery/inventory`
(`:395`/`:410`), `/bundles/inspect` + `/bundles/install` (`:416`/`:422`).

### Redirect stubs (deleted routes)

`routes.tsx:432`–`:474` mount `<Navigate>` redirects for removed routes —
NOT destination pages: `/context` → `/topology`; `/mission-control` →
`/for-you` (SC-18: `/mission-control` deleted, For-You replaces it);
`/slices` + `/slices/$name` → `/project`; `/progress` → `/project`;
`/steering` → `/project`. The Mission Control *system* still exists at the
daemon/PL-005 layer (`../architecture/mission-control.md`); only the old UI
*route* was retired in favour of For-You.

## 4. Drawer and viewer system

`SharedDetailDrawer` is the shared transient detail surface for queue-item
viewer, file viewer, subspec preview, and other detail selections. Drawer
triggers carry root/path provenance so the viewer fetches/render the correct
content; the drawer supports outside-click dismissal. Image proof viewing is
handled by `ProofImageViewer` with black-glass styling honouring the shell
layout. Skill detail uses Library Explorer navigation + `FileViewer`
(`components/drawer-viewers/FileViewer.tsx`) in the center workspace, not a
nested three-column browser.

## 5. Event and activity consumption

UI event consumption is centralized through shared event hooks so the app
avoids duplicate SSE connections for related surfaces. Current consumers: For
You feed hydration, topology activity rings + hot-potato movement, the
activity feed/system surfaces, and rig event surfaces. Reduced-motion
preference is honoured for pulse/packet animation. (Daemon SSE surfaces:
`/api/events`, `/api/stream/watch`, `/api/queue/watch` —
`architecture-rules-and-event-system.md` §2.4.)

## See also

- `topology.md` — graph/table/terminal topology surface.
- `project-and-for-you.md` — project observability + For-You feed.
- `library-specs-and-design-system.md` — Library/specs + DESIGN.md pointer.
- Source roots: `packages/ui/src/routes.tsx`,
  `packages/ui/src/components/AppShell.tsx`.
