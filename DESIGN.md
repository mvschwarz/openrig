# OpenRig Design

This document captures the current OpenRig visual system so the product can be
recreated, extended, or translated into other media without reverse-engineering
the UI from code.

## Essence

OpenRig is a local control plane for multi-agent work. The interface should feel
like an operator's tactical dossier: precise, technical, calm, and legible under
pressure. It is not a consumer SaaS dashboard and not a decorative terminal skin.
It is a paper-and-glass workspace for watching work move through rigs, agents,
queues, projects, files, and proof packets.

The brand should communicate:

- Operator confidence: the human can see what is happening and what needs action.
- Composable systems: workspace, mission, slice, rig, pod, seat, queue, file, and
  proof surfaces share primitives instead of bespoke one-off cards.
- Live work: activity, flow, context usage, proofs, and terminal state are visible
  without turning the UI into a log dump.
- Local-first control: the app looks like a serious local cockpit, not a cloud
  marketing product.

## Design Language

OpenRig currently uses two deliberate surface languages.

### Vellum Paper

Vellum is the default light surface language. It appears on navigation chrome,
dashboard cards, topology cards, project cards, drawers, file viewers, and
metadata containers.

Use vellum for persistent product surfaces:

- Explorer sidebars
- Dashboard cards
- Topology rig, pod, and agent cards
- Project and For You cards
- Drawer sheets and document viewers
- File and markdown surfaces

Core vellum traits:

- Paper-grid background visible behind and sometimes through surfaces
- White translucent fills, usually `bg-white/25` to `bg-white/40`
- `backdrop-blur-[8px]` for layered paper
- 1px outline or ghost border
- Hard shadow only on paper cards, not on floating glass
- Registration marks for framed tactical sheets
- Square corners everywhere except tiny status dots

Vellum should never become fully transparent. If the paper-grid makes text hard
to read, increase opacity before adding heavy borders.

### Black Glass

Black glass is the floating dark surface language. It is currently used for the
topology terminal preview and screenshot/proof overlays.

Use black glass for temporary preview surfaces:

- Terminal popovers
- Image proof viewers
- Other quick-look overlays where the content should float above the canvas

Core black-glass traits:

- Transparent dark fill, currently around `bg-stone-950/65`
- Light text, usually `text-stone-50`
- Optional subtle backdrop blur
- No hard shadow
- No 1px vellum border
- Chrome stripped to the minimum needed for comprehension

Black glass should feel like a smoked sheet above the canvas, not a framed
terminal emulator.

## Color Tokens

The canonical tokens live in `packages/ui/src/globals.css` and are surfaced to
Tailwind in `packages/ui/tailwind.config.ts`.

Paper:

- `--background: 47 20% 97%` - base paper, `#faf9f5`
- `--surface-container-lowest: 0 0% 100%` - card body white
- `--surface-container-low: 80 10% 95%`
- `--surface-container: 80 10% 92%`
- `--surface-container-high: 100 10% 89%`
- `--surface-container-highest: 100 10% 87%`

Ink:

- `--on-surface: 120 8% 19%` - primary text, `#2e342e`
- `--on-surface-variant: 108 5% 36%` - secondary text, `#5b615a`
- `--inverse-surface: 120 10% 4%` - dark strip fills, near black

Technical linework:

- `--secondary: 213 15% 39%` - connectors, handles, registration marks
- `--secondary-container: 220 39% 91%`

Status:

- `--success: 145 63% 35%`
- `--warning: 40 90% 50%`
- `--tertiary: 1 63% 42%` - stamped red / critical
- `--error: 0 43% 44%`

Borders:

- `--outline: 108 4% 47%`
- `--outline-variant: 108 4% 68%`

Usage rules:

- Use `outline-variant` for most structural borders.
- Reserve stone-900 borders for important card edges, active tabs, and hard
  tactical emphasis.
- Do not create one-off color systems for each feature. Classify the state first,
  then map to the shared neutral, info, success, warning, or danger tones.

## Typography

Tailwind font families:

- `font-body`: Inter for readable body text
- `font-headline`: Space Grotesk for display and stamped headings
- `font-mono`: JetBrains Mono for labels, IDs, queue state, technical metadata,
  terminal previews, tabs, chips, and counters

General typography rules:

- Product labels use uppercase mono with letter spacing around `tracking-[0.10em]`.
- Body copy should be sentence case when it is meant for humans to read.
- Code identifiers should be transformed into human-readable labels where
  possible, not displayed raw.
- Terminal and transcript content stays mono but should not force the rest of the
  product to read like a log.

## Layout

The shell is route-first and explorer-first:

- 48px icon rail on desktop
- Explorer sidebar for route-specific tree context
- Center workspace for destination content
- Right drawer for transient detail and file views
- Preview stack for pinned quick-look panes

Primary destinations:

- `/` Dashboard
- `/topology` host topology
- `/for-you` For You feed
- `/project` workspace/project observability
- `/specs` Library
- `/settings` Settings

Topology and project both use hierarchical scopes:

- Topology: host -> rig -> pod -> seat
- Project: workspace -> mission -> slice

Each lower scope narrows the filter. Each higher scope widens the context.

## Core Primitives

Use these primitives before adding new component styles.

Vellum:

- `VellumCard`
- `VellumSheet`
- `RegistrationMarks`
- `StatusPip`
- `SectionHeader`
- `EmptyState`

Graphics:

- `RuntimeMark`
- `RuntimeBadge`
- `ToolMark`
- `ToolBadge`
- `ActorMark`
- `OperatorMoodMark`
- `runtime-brand.ts`
- `tool-brand.ts`

Project metadata:

- `ProjectPill`
- `EventBadge`
- `QueueStateBadge`
- `TagPill`
- `ActorChip`
- `DateChip`
- `FlowChips`
- `ProofThumbnailGrid`
- `ProofPacketHeader`

Topology:

- `HostMultiRigGraph`
- `HybridAgentNode`
- `HybridPodGroupNode`
- `RigGroupNode`
- `ActivityRing`
- `HotPotatoEdge`
- `TerminalPreviewPopover`
- `TopologyTableView`
- `TopologyTerminalView`

Preview and documents:

- `SessionPreviewPane`
- `ProofImageViewer`
- `FileViewer`
- `MarkdownViewer`

## Graphics System

OpenRig uses a shared graphics package rather than scattering literal icon logic
through product surfaces.

Runtime marks:

- Claude: pixel-style Claude mark, label `Claude`
- Codex: Codex CLI terminal-circle mark, label `Codex`
- Terminal: compact terminal glyph, label `TTY` or `Terminal`
- Unknown: neutral fallback

Tool marks:

- CMUX: blue chevron mark
- tmux: pane-grid mark with green base
- VS Code: blue code mark
- Terminal, file, markdown, config, code, screenshot, proof, transcript, commit,
  folder, skill, video, and trace each have a central brand entry

Actor marks:

- Human/operator uses the monochrome climber mask
- Agent/runtime actors reuse runtime marks

Graphics placement rules:

- Use runtime marks where the runtime is the important scan dimension.
- Do not duplicate the same runtime mark in adjacent columns on the same row.
- Use tool marks for actions, not runtime marks.
- Prefer inline marks and open metadata rows over stacking more rectangular pill
  badges when a card is already visually dense.
- Keep marks small enough to support scanning. They are landmarks, not mascots.

## Interaction Patterns

Hover-only actions:

- Dense topology cards show CMUX and terminal actions on hover/focus.
- Keyboard focus must reveal the same actions as mouse hover.
- Action clicks must stop propagation so row or node navigation does not also
  fire.

Drawers and overlays:

- Drawers close with their close button and by clicking outside the sheet.
- Image viewers and terminal popovers are quick-look surfaces.
- Topology terminal popovers are portaled above React Flow node stacking contexts.

Queue and project:

- Queue is operational: what is pending, actionable, routed, or closed.
- Story is narrative: what happened over time, with body text primary and
  metadata secondary.
- For You is attention routing: your turn, approvals, shipped proof, progress,
  and observations.

## Motion

Motion should explain state, not decorate.

Current motion vocabulary:

- Activity card pulse for active, needs-input, and blocked states
- Source and target flash for handoff events
- Hot-potato packet animation on topology graph edges
- Rig frame pulse for aggregate activity
- Subtle route and node enter fades

Rules:

- Prefer slow pulses to blinking.
- Make directional work movement obvious enough to see at graph zoom levels.
- Honor `prefers-reduced-motion`: remove pulse/travel animation and keep static
  state signals.

## Accessibility

- Icon-only actions need labels or tooltips.
- Decorative marks should use `aria-hidden`.
- Semantic status should use `StatusPip`, not activity animation classes.
- Keyboard focus must expose hover-only controls.
- Do not rely on color alone for action outcomes.
- Keep dense cards readable at the expected topology zoom range.

## Do And Do Not

Do:

- Use vellum and black-glass as distinct surface paradigms.
- Keep square geometry, 1px lines, and hard paper shadows.
- Centralize graphics through brand helpers.
- Translate raw event/state codes into human-readable labels.
- Make proof and terminal previews available where thumbnails or terminal marks
  appear.
- Keep hierarchy visible: workspace -> mission -> slice, host -> rig -> pod ->
  seat.

Do not:

- Add new one-off card styles when a primitive can do the job.
- Use emojis as product graphics.
- Turn metadata into a wall of rectangular pills.
- Make terminal/log aesthetics dominate human decision surfaces.
- Add decorative gradient blobs or generic SaaS hero styling.
- Add black borders or hard shadows to black-glass popovers.
- Duplicate runtime/tool brand logic outside `runtime-brand.ts`,
  `tool-brand.ts`, and `RuntimeMark.tsx`.

## Implementation References

- Tokens: `packages/ui/src/globals.css`
- Tailwind theme: `packages/ui/tailwind.config.ts`
- Shell: `packages/ui/src/components/AppShell.tsx`
- Routes: `packages/ui/src/routes.tsx`
- Vellum primitives: `packages/ui/src/components/ui/`
- Graphics primitives: `packages/ui/src/components/graphics/RuntimeMark.tsx`
- Runtime brands: `packages/ui/src/lib/runtime-brand.ts`
- Tool brands: `packages/ui/src/lib/tool-brand.ts`
- Project metadata primitives: `packages/ui/src/components/project/ProjectMetaPrimitives.tsx`
- Topology graph nodes: `packages/ui/src/components/topology/HybridTopologyNodes.tsx`
- Terminal popover: `packages/ui/src/components/topology/TerminalPreviewPopover.tsx`
- Session preview: `packages/ui/src/components/preview/SessionPreviewPane.tsx`
