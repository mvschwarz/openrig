---
kind: as-built
title: UI Library/Specs Surfaces + Design-System Pointer
status: active
topics: [specification-and-bundles, observability]
domains: [engineering-advisor, product-advisor]
applies-when: |
  Need to know how the Library (`/specs`) UI is assembled — the spec/skills/
  plugins surfaces, the spec-review + spec-library + live-identity flows that
  feed it — or where the canonical visual/design-system spec lives.
siblings: [shell-and-routing.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI Library/Specs Surfaces + Design-System Pointer

The Library destination keeps `/specs` as the route and presents the product
label "Library": specs, applications, context packs, agent specs, agent
images, plugins, and skills.

> Verified against source at HEAD `7eaf524c`; package version **0.3.1**
> (slice-00 §1.1). Component/primitive names below are reconciled against
> `packages/ui/src/components/` at HEAD — NOT taken on trust from `ui.md`'s
> or `DESIGN.md`'s lists.

## 1. Library / specs surfaces

Components in `packages/ui/src/components/specs/` (re-confirmed at HEAD):

- `SpecsLibraryPage.tsx` — the `/specs` Library page (unified list:
  All / Apps / Rigs / Agents; service-backed entries render as `APP`).
- `SpecsTable.tsx`, `SpecsTreeView.tsx` — list + Explorer tree.
- `SkillsIndexPage.tsx`, `SkillDetailPage.tsx` — folder-based skills.
  The skill tree treats each skill as a folder; clicking a skill opens a
  detail route defaulting to `skill.md` case-insensitively, rendered via the
  shared `FileViewer` in the center workspace (no second in-page file
  browser — file navigation belongs in the Explorer tree).
- `PluginsIndexPage.tsx`, `PluginDetailPage.tsx`, `AgentPluginsList.tsx` —
  the plugin surfaces.

> Drift-note (slice-00 0.3.0-GT seam a): the plugin primitive is a **0.3.1**
> feature (git-ancestry proven; absent at `v0.3.0`, present at `v0.3.1`). Do
> NOT back-attribute the `/specs/plugins`, `/plugins/$pluginId` routes or
> these plugin components to 0.3.0. `ui.md` (which predates 0.3.x) has **no
> narrative for plugins at all** — these surfaces are authored from source +
> the slice-00 0.3.0-GT seam, not migrated.

## 2. Spec review / library / live-identity flows

These daemon-backed flows feed the Library UI (`architecture.md` §6
"Spec review and spec library flow", "Live identity / specs UI flow",
re-confirmed accurate at HEAD):

- **Raw YAML preview:** UI/CLI posts YAML to `/api/specs/review/rig` or
  `/api/specs/review/agent`; `SpecReviewService` parses/validates/returns
  structured review models; UI renders them through `RigSpecDisplay` /
  `AgentSpecDisplay` (the same primitives reused for draft preview, library
  review, and live full-details).
- **Filesystem-backed library:** `SpecLibraryService` scans builtin + user
  roots (`packages/daemon/specs`, `~/.openrig/specs`, legacy fallback
  `~/.rigged/specs`); each YAML is classified via structured review;
  service-backed rigs are marked `hasServices`; `/api/specs/library` serves
  list/get/review/sync.
- **CLI mirror:** `rig specs ls/show/preview/add/sync`; `rig specs add`
  installs a single YAML spec or a full spec directory; `rig up` /
  `rig bootstrap` resolve library names before other source kinds.
- **Live identity:** Explorer/graph selection opens the shared right drawer
  (runtime-first node detail: live identity, peers, directional edges,
  transcript helpers, compact spec summary); `Open Full Details` navigates to
  `/rigs/$rigId/nodes/$logicalId` in the center workspace.

## 3. UI primitive inventory (reconciled against source)

> Drift-fix — `ui.md` "Design Primitives" (L75–107) omits `ProjectPill`.
> `docs/DESIGN.md` L195 lists it; re-confirmed at HEAD it is a real export
> (`packages/ui/src/components/project/ProjectMetaPrimitives.tsx:196`
> `export function ProjectPill`). Reconciled inventory below is from source,
> not from either doc's list.

- **Vellum/base** (`components/ui/`): `VellumCard`, `VellumSheet`,
  `RegistrationMarks`, `StatusPip`, `SectionHeader`, `EmptyState`,
  `Button`, `Tabs`, `Table`, form controls, plus `rig-stamp.tsx`
  (`RigStamp`) — present at HEAD; not in ui.md's list.
- **Graphics** (`components/graphics/RuntimeMark.tsx`, exports re-confirmed):
  `RuntimeMark`, `RuntimeBadge`, `ToolMark`, `ToolBadge`, `ActorMark`,
  `OperatorMoodMark`; normalization in `lib/runtime-brand.ts` +
  `lib/tool-brand.ts`.
- **Project metadata** (`components/project/ProjectMetaPrimitives.tsx`,
  exports re-confirmed): `ProjectPill` (`:196`), `EventBadge` (`:224`),
  `QueueStateBadge` (`:228`), `TagPill` (`:274`), `ActorChip` (`:283`),
  `DateChip` (`:303`), `FlowChips` (`:315`), `ProofThumbnailGrid` (`:334`),
  `ProofPacketHeader` (`:380`) — plus `QueueCountIcon` / `StatusDot` (in
  source, not in ui.md/DESIGN.md primitive lists).
- **Viewers**: `FileViewer` (`components/drawer-viewers/FileViewer.tsx`),
  `MarkdownViewer` (`components/markdown/MarkdownViewer.tsx`),
  `ProofImageViewer`, `SessionPreviewPane` (`components/preview/`).

## 4. Design-system pointer (NOT a copy — Q1)

The canonical OpenRig visual/design system is **`docs/DESIGN.md`** (at the
repo `docs/` root, NOT under `docs/as-built/`). Q1 is ratified: DESIGN.md
stays at root, byte-identical, and this module **points to it rather than
copying it**. DESIGN.md is the source for: Vellum-paper vs Black-glass
surface languages, colour tokens (`packages/ui/src/globals.css` +
`tailwind.config.ts`), typography (`font-body` Inter / `font-headline` Space
Grotesk / `font-mono` JetBrains Mono), layout (48px rail + Explorer + center
+ drawer + preview stack), the core-primitive list, the graphics system, and
the interaction/motion/accessibility/do-and-do-not rules.

> Reconciliation note: DESIGN.md's primitive lists were independently
> verified against `packages/ui/src/components/` at HEAD — every primitive
> DESIGN.md names (Vellum, Graphics, Project-metadata, Topology, Preview)
> resolves to a real export at HEAD. DESIGN.md is accurate and carries no
> slice-00 numeric drift, so it is referenced as-is. Do not duplicate its
> content here; read `docs/DESIGN.md` directly for the visual spec.

## See also

- `docs/DESIGN.md` — the canonical visual/design-system spec (pointer; do
  not copy).
- `shell-and-routing.md` — the `/specs` route family + shell + drawer.
- `../architecture/agent-spec-and-startup.md` — the spec parsing/resolution
  contract behind the review flows.
- `../architecture/plugin-agent-image-context-pack.md` — the 0.3.1 content
  layer behind the plugins/agent-image/context-pack Library surfaces.
- Source roots: `packages/ui/src/components/specs/`,
  `packages/daemon/src/domain/{spec-review-service,spec-library-service}*`.
