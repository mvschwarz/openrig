---
kind: as-built
title: UI Library/Specs Surfaces + Design-System Pointer
status: active
topics: [specification-and-bundles, observability]
domains: [engineering-advisor, product-advisor]
applies-when: |
  Need to know how the Library (`/specs`) UI is assembled — the spec/skills/
  plugins surfaces, the spec-review + spec-library flows that feed it, and
  how seat details open — or where the canonical visual/design-system spec
  lives.
siblings: [shell-and-routing.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 2caac7dd1bb16585138a6f7c1dd8b1f0752c49f7
last-updated: 2026-10-05
---

# UI Library/Specs Surfaces + Design-System Pointer

The Library destination keeps `/specs` as the route and presents the product
label "Library": specs, applications, context packs, agent specs, agent
images, plugins, and skills.

> Verified against source at `2caac7dd`; package version 0.6.7. Component and
> primitive names below are reconciled against `packages/ui/src/components/`,
> not taken on trust from `DESIGN.md`'s lists. The web UI is in maintenance
> mode (`docs/reference/developing.md`).

## 1. Library / specs surfaces

Components in `packages/ui/src/components/specs/`:

- `SpecsLibraryPage.tsx` — the `/specs` Library page (also mounted at
  `/specs/applications`): a sectioned grid of Rig Specs, Workspace Specs
  (placeholder), Workflow Specs, Context Packs, Agent Specs, Agent Images
  and Applications, then full-width Plugins and Skills sections.
  Service-backed rigs (`hasServices`) appear under Applications, not Rig
  Specs.
- `SpecsTreeView.tsx` — the Explorer tree. (`SpecsTable.tsx` is still in
  the folder but nothing imports it.)
- `SkillsIndexPage.tsx`, `SkillDetailPage.tsx` — skills. The Explorer
  groups skills into category folders; each skill is a single row, not
  expandable into files. Opening a skill goes to a detail route that
  defaults to `SKILL.md` (case-insensitive) and renders its own docs
  browser: a file tree with breadcrumbs beside a viewer, `MarkdownViewer`
  for `.md`/`.mdx`, `SyntaxHighlight` for other text, preformatted text
  otherwise. Files come from `/api/skills/:id/files/list` and `/files/read`
  (`hooks/useSkillFiles.ts`).
- `PluginsIndexPage.tsx`, `PluginDetailPage.tsx`, `AgentPluginsList.tsx` —
  the plugin surfaces.

Library routes: `/specs`, `/specs/applications`, `/specs/skills`,
`/specs/skills/$skillToken`, `/specs/skills/$skillToken/file/$fileToken`,
`/specs/plugins`, `/plugins/$pluginId`, `/specs/library/$entryId` (see
[`shell-and-routing.md`](shell-and-routing.md) §3).

> The plugin primitive is a **0.3.1** feature (absent at `v0.3.0`, present
> at `v0.3.1`). Do NOT back-attribute the `/specs/plugins`,
> `/plugins/$pluginId` routes or these plugin components to 0.3.0.

## 2. Spec review / library flows and seat details

These daemon-backed flows feed the Library UI:

- **Raw YAML preview:** UI/CLI posts YAML to `/api/specs/review/rig` or
  `/api/specs/review/agent`; `SpecReviewService` parses/validates/returns
  structured review models; UI renders them through `RigSpecDisplay` /
  `AgentSpecDisplay` (the same primitives reused for draft preview, library
  review, and live details).
- **Filesystem-backed library:** `SpecLibraryService` scans builtin + user
  roots (`packages/daemon/specs`, `~/.openrig/specs`, legacy fallback
  `~/.rigged/specs`); each YAML is classified via structured review;
  service-backed rigs are marked `hasServices`. Each list request also
  merges workflow entries from the workflow-spec cache.
  `/api/specs/library` serves list, get, review and sync, plus
  `DELETE /:id`, `POST /:id/rename` and GET/POST/DELETE `/active-lens`.
  On a non-local host, list and review reads carry `?host=<id>`; the
  active lens stays local.
- **CLI mirror:** `rig specs ls/show/preview/add/sync/remove/rename`;
  `rig specs add` installs a single YAML spec or a full spec directory;
  `rig up` / `rig bootstrap` resolve name-shaped sources through the
  library.
- **Seat details:** graph, tree and table clicks navigate to
  `/topology/seat/$rigId/$logicalId`, which renders `LiveNodeDetails`
  (Overview and Details tabs). The shared drawer no longer has a
  seat-detail kind; its kinds are system, log, status, discovery, qitem,
  file and sub-spec. The legacy `/rigs/$rigId/nodes/$logicalId` route also
  renders `LiveNodeDetails`, but nothing in the UI links to it.

> Source: `packages/daemon/src/routes/spec-library.ts`;
> `packages/ui/src/hooks/useSpecLibrary.ts`; `packages/cli/src/commands/specs.ts`
> (`remove`, `rename`); `packages/ui/src/components/SharedDetailDrawer.tsx`
> (viewer kinds; seat-detail retired).

## 3. UI primitive inventory (reconciled against source)

- **Vellum/base** (`components/ui/`): `VellumCard`, `VellumSheet`,
  `RegistrationMarks`, `StatusPip`, `SectionHeader`, `EmptyState`,
  `Button`, `Tabs`, `Table`, form controls, plus `rig-stamp.tsx`
  (`RigStamp`).
- **Graphics** (`components/graphics/RuntimeMark.tsx`): `RuntimeMark`,
  `RuntimeBadge`, `ToolMark`, `ToolBadge`, `ActorMark`,
  `OperatorMoodMark`; normalization in `lib/runtime-brand.ts` +
  `lib/tool-brand.ts`. Runtime brands are Claude Code, Codex, Pi ("Pi"),
  OMP ("Oh My Pi", short "OMP"), terminal and unknown; `ActorMark` reuses
  the runtime marks for recognized runtimes.
- **Project metadata** (`components/project/ProjectMetaPrimitives.tsx`):
  `ProjectPill` (`:199`), `EventBadge` (`:227`), `QueueStateBadge` (`:231`),
  `TagPill` (`:277`), `ActorChip` (`:286`), `DateChip` (`:306`),
  `FlowChips` (`:318`), `ProofThumbnailGrid` (`:337`), `ProofPacketHeader`
  (`:383`) — plus `QueueCountIcon` / `StatusDot`.
- **Viewers**: `FileViewer` (`components/drawer-viewers/FileViewer.tsx`),
  `MarkdownViewer` (`components/markdown/MarkdownViewer.tsx`),
  `ProofImageViewer` and `Lightbox` (`components/project/`),
  `SessionPreviewPane` (`components/preview/`).
- **Themes** (`lib/theme.ts`): Vellum Light, Vellum Dark and System
  (default `system`, following the OS colour scheme), stored under the
  `openrig.theme` localStorage key. `applyTheme` toggles a `.dark` class
  on `<html>`, which switches to the `.dark` token block in `globals.css`.
  `ThemeProvider` is mounted in `main.tsx`, `ThemeSelector` in the
  AppShell top bar, and a pre-paint script in `index.html` mirrors the
  storage key.

## 4. Design-system pointer (NOT a copy — Q1)

The canonical OpenRig visual/design system is **`docs/DESIGN.md`** (at the
repo `docs/` root, NOT under `docs/as-built/`). Q1 is ratified: DESIGN.md
stays at root (the as-built reorganization left it byte-identical), and this
module **points to it rather than copying it**. DESIGN.md is the source for: Vellum-paper vs
Black-glass surface languages, colour tokens (`packages/ui/src/globals.css`
+ `tailwind.config.ts`), typography (`font-body` Inter / `font-headline`
Space Grotesk / `font-mono` JetBrains Mono), layout (48px rail + Explorer +
center + drawer + preview stack), the core-primitive list, the graphics
system, and the interaction/motion/accessibility/do-and-do-not rules.

> Reconciliation note: every primitive DESIGN.md names (Vellum, Graphics,
> Project-metadata, Topology, Preview) resolves to a real export at the
> stamped commit. Do not duplicate its content here; read `docs/DESIGN.md`
> directly for the visual spec.

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
