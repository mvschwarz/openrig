# OpenRig UI As-Built

This document describes the current UI architecture and component system. The
brand/design rules live in `DESIGN.md`; this file focuses on how the shipped UI
is assembled.

## Package Shape

UI package: `packages/ui`

Primary implementation areas:

- `src/routes.tsx` - TanStack Router route tree
- `src/components/AppShell.tsx` - global shell, rail, Explorer, drawer, preview stack
- `src/components/ui/` - reusable vellum and base UI primitives
- `src/components/graphics/` - runtime, tool, and actor marks
- `src/components/topology/` - host/rig/pod/seat graph, table, terminal, activity
- `src/components/project/` - workspace/mission/slice observability and project metadata primitives
- `src/components/for-you/` - attention feed and actionable queue cards
- `src/components/specs/` - Library and skill file viewing
- `src/components/preview/` - terminal/session preview panes
- `src/hooks/` - route data hooks and event consumption
- `src/lib/` - classifiers, formatters, layout helpers, brand helpers, activity logic

## Shell Model

`AppShell` wraps every route with:

- Desktop rail
- Route-aware Explorer sidebar
- Center workspace
- Shared detail drawer
- Preview stack
- Topology overlay state provider
- Shared drawer selection context
- Shared discovery placement context

The rail destinations are:

- Dashboard: `/`
- Topology: `/topology`
- For You: `/for-you`
- Project: `/project`
- Library: `/specs`
- Settings: `/settings`
- Advisor and Operator placeholders/settings links

The Explorer is contextual. It changes its tree based on the current destination
rather than behaving as a generic file browser.

## Route Model

Main routes:

- `/` - Dashboard
- `/topology` - host topology scope
- `/topology/rig/$rigId` - rig scope
- `/topology/pod/$rigId/$podName` - pod scope
- `/topology/seat/$rigId/$logicalId` - seat scope with live node details
- `/for-you` - attention feed
- `/project` - workspace project scope
- `/project/mission/$missionId` - mission scope
- `/project/slice/$sliceId` - slice scope
- `/specs` - Library
- `/specs/applications` - application section
- `/specs/skills/$skillToken` - skill viewer defaulting to `skill.md`
- `/specs/skills/$skillToken/file/$fileToken` - specific skill file viewer
- `/settings` - settings center
- `/search` - audit/history view
- `/lab/project-graphics-preview` - graphics preview lab route

Legacy routes remain for compatibility where needed, including package flows,
bootstrap flows, validation flows, and `/rigs/$rigId`.

## Design Primitives

The UI moved from route-specific one-off panels toward reusable primitives.

Base primitives:

- `VellumCard` - paper card with optional dark header, hard shadow, registration marks
- `VellumSheet` - side sheet/drawer with vellum-heavy surface and registration marks
- `RegistrationMarks` - corner registration marks
- `StatusPip` - semantic status only
- `SectionHeader`, `EmptyState`, `Button`, `Tabs`, `Table`, and form controls

Graphics primitives:

- `RuntimeMark` and `RuntimeBadge`
- `ToolMark` and `ToolBadge`
- `ActorMark` and `OperatorMoodMark`
- Runtime and tool normalization in `runtime-brand.ts` and `tool-brand.ts`

Project metadata primitives:

- `EventBadge`
- `QueueStateBadge`
- `TagPill`
- `ActorChip`
- `DateChip`
- `FlowChips`
- `ProofThumbnailGrid`
- `ProofPacketHeader`

These primitives centralize visual language for runtime identity, queue state,
actor flow, event labels, dates, tags, and proof images.

## Topology

Topology is a scoped workspace with graph, table, and terminal views.

Current topology pieces:

- `HostMultiRigGraph` renders the host-level hybrid React Flow graph.
- `HybridAgentNode` renders compact agent cards with runtime badges, context
  percentage, token totals, activity state, terminal preview, and CMUX actions.
- `HybridPodGroupNode` renders soft dashed pod frames.
- `RigGroupNode` renders soft rig frames with registration marks and aggregate
  activity.
- `ActivityRing` and card activity classes show active, needs-input, and blocked
  states.
- `HotPotatoEdge` visualizes directional queue movement through the graph.
- `TopologyTableView` mirrors topology data in a dense table.
- `TopologyTerminalView` shows terminal-oriented topology state.
- `TerminalPreviewPopover` provides black-glass quick terminal preview above the
  graph via a portal.

Important topology contracts:

- Graph/table/tree navigation resolves to seat URLs.
- Host-level graph uses cross-rig node ID prefixing.
- Expanded rig state is managed by `TopologyOverlayProvider`.
- Graph data is lazy-fetched for expanded rigs.
- Terminal preview actions are hover/focus visible.
- The terminal popover must escape React Flow stacking contexts and stay within
  the viewport.

## Project Observability

Project is organized as a hierarchy:

- Workspace
- Mission
- Slice

The current route scope acts as a filter. Higher scopes show broader rollups;
lower scopes show more specific story, queue, proof, artifact, test, and topology
data.

Current project tabs:

- Story - narrative progress and queue body content
- Progress - status and activity rollup
- Artifacts - files, commits, proof, and outputs
- Tests - proof material, screenshots, and verification detail
- Queue - operational qitems with actions and drawer detail
- Topology - workflow/agent diagram where available

Project primitives translate raw queue and event data into readable badges,
chips, dates, flows, proof thumbnails, and action outcome panels.

## For You

For You is the attention-routing surface. It uses live event feed data plus queue
details to classify cards into:

- Action Required
- Approval
- Shipped
- Progress
- Observation

The card renderer prioritizes readable body content, proof thumbnails, actor
flow, friendly dates, and action affordances. Queue actions reuse existing
mission-control action endpoints.

## Library And Skills

`/specs` is the Library route. It contains specs, applications, context packs,
agent specs, agent images, and skills.

Skills are folder-based. The skill tree in Explorer treats each skill as a
folder. Clicking a skill opens a skill detail route that defaults to `skill.md`
case-insensitively. The skill detail page uses the existing `FileViewer` and
does not add a second in-page file browser; file navigation belongs in the
Explorer tree.

## Drawer And Viewer System

The shared detail drawer is used for transient focused detail:

- Queue item viewer
- File viewer
- Subspec preview
- Other detail selections

Drawer triggers carry root/path provenance so the viewer can fetch and render the
correct content. The drawer supports outside-click dismissal.

Image proof viewing is handled by `ProofImageViewer`, which respects the shell
layout and uses black-glass styling.

## Event And Activity Consumption

UI event consumption is centralized through shared event hooks so the app avoids
spawning duplicate SSE connections for related surfaces.

Current activity consumers include:

- For You feed hydration
- Topology activity rings and hot-potato movement
- Activity feed/system surfaces
- Rig event surfaces where appropriate

Reduced-motion preference is honored for pulse and packet animations.

## Graphics Layer

The graphics package is intentionally centralized:

- Runtime identity: Claude, Codex, Terminal, Unknown
- Tool identity: CMUX, tmux, VS Code, Terminal, file, markdown, config, code,
  screenshot, proof, transcript, commit, folder, skill, video, trace
- Actor identity: human/operator, runtime agents, terminal fallback

The goal is to make dense operator surfaces scannable without adding more raw
metadata text.

## Current Design Constraints

- Use the shared primitives before creating new card styles.
- Keep vellum and black-glass separate.
- Keep status semantics separate from activity animation.
- Do not duplicate runtime/tool brand detection outside the central helpers.
- Do not add new daemon shape for UI polish unless the slice explicitly declares
  and verifies that boundary.
- Do not make page-level content look like a raw terminal log unless the content
  is actually terminal output.
