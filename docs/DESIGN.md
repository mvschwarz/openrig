# OpenRig Design (Clean theme)

This document is the visual and interaction spec for the OpenRig web UI in
`packages/ui`. It describes the Clean theme: a calm, neutral, light-and-dark
operator console built on design tokens, one status vocabulary, and a small set
of shared primitives.

The web UI is **experimental**, in **maintenance mode**, supported
**best-effort**; **the CLI is primary**. There is no scheduled removal and PRs
are welcome.

## Essence

OpenRig is a local control plane for multi-agent work. The screen answers, in
order: what is happening, does it need me, what do I do. "Needs you" items sit
above everything else on the Dashboard and in the Inbox.

The interface feels like a serious local cockpit, not a consumer SaaS
dashboard and not a decorative terminal skin. It is calm, legible, and plain in
its words: sentence-case labels a first-time operator can read without a
glossary.

## Design principles

Decided; do not re-litigate.

1. **The screen answers, in order: what is happening, does it need me, what
   do I do.** Put "needs you" items above everything else on Dashboard and
   Inbox.
2. **Plain words, sentence case.** Labels and headings are sentence case
   ("Needs you", not "NEEDS YOU"). No `uppercase` + `tracking-widest` on
   anything a human reads as prose.
3. **Machine values look machine-made.** IDs, session names
   (`coordinator@acme-build`), token counts, timestamps, commands: `font-mono`.
   Everything else: the body font (Inter).
4. **One status vocabulary.** Every state renders through `StatusBadge` /
   `StatusDot` with the same tone and label everywhere.
5. **Hierarchy through structure, not decoration.** No paper grid, no
   registration marks, no hard offset shadows, no translucent blur sheets.
   Cards: `rounded-lg border bg-surface-lowest` and at most `shadow-sm`.
6. **Every empty state says what to do first** and offers one button that does
   it.
7. **Show local action results in place; toast only for actions** (start, stop,
   snapshot, restore, import, approve). Never toast state that is already
   visible on the current screen.
8. **Everything reachable in two clicks from the sidebar, or one ⌘K.**

## Names

Labels changed; URLs did not. Route paths in `packages/ui/src/routes.tsx` work
exactly as before.

| Label | URL (unchanged) |
|---|---|
| Dashboard | `/` |
| Inbox | `/for-you` |
| Rigs | `/topology` |
| Agents | `/agents` |
| Hosts | `/fleet` |
| Projects | `/project` |
| Workflows | `/workflows` |
| Files | `/files` |
| Library | `/specs` |
| Settings | `/settings` |
| Advisor | resolved at render time (`resolveChatTo`) |
| Operator | resolved at render time |

The sidebar keeps the long-standing `rail-*` testids (`rail-dashboard`,
`rail-topology`, `rail-for-you`, `rail-project`, `rail-specs`, `rail-settings`,
`rail-advisor`, `rail-operator`, plus `rail-agents`, `rail-fleet`,
`rail-workflows`, `rail-files`) so existing contract tests keep passing.

In new or rewritten UI copy, say "agent" where the old copy said "seat"; "rig"
stays "rig". URLs that contain the old words are unchanged.

## Design language

One surface language for product surfaces and one treatment for temporary
overlays.

Product surfaces are flat and neutral: `bg-surface-lowest` cards with
`rounded-lg`, a 1px `outline-variant` border, and at most `shadow-sm`
(`--shadow-card`). Sections inside a card use the same recipe at a smaller
scale. Hierarchy comes from spacing, section labels, and structure — never
from grids, corner marks, shadows, or blur.

Temporary previews (terminal popovers, image viewers, quick-look overlays)
float above the canvas with minimal chrome and only the content needed for
comprehension.

Both a light and a dark theme ship. The selector offers light, dark, and system
(`packages/ui/src/lib/theme.ts`); with no stored choice the UI follows the
operating system's color scheme, stored under the `openrig.theme`
local-storage key.

## Color tokens

The canonical tokens live in `packages/ui/src/globals.css` and are surfaced to
Tailwind in `packages/ui/tailwind.config.ts`. Every token *name* is unchanged
from the previous theme; the Clean theme block appended last in `globals.css`
only changes the *values*, so all existing Tailwind classes keep working.

Light (`:root`):

| Token | Value |
|---|---|
| `--background` | `0 0% 100%` |
| `--surface-container-lowest` | `0 0% 100%` |
| `--surface-container-low` | `240 5% 97%` |
| `--surface-container` | `240 5% 95%` |
| `--surface-container-high` | `240 5% 92%` |
| `--surface-container-highest` | `240 4% 89%` |
| `--on-surface` | `240 10% 10%` |
| `--on-surface-variant` | `240 4% 42%` |
| `--secondary` | `240 4% 46%` (neutral slate on purpose — see usage rules) |
| `--secondary-container` | `240 5% 94%` |
| `--brand` | `221 83% 53%` |
| `--brand-foreground` | `0 0% 100%` |
| `--tertiary` / `--error` | `0 72% 51%` |
| `--primary` / `--inverse-surface` | `240 6% 10%` |
| `--outline` | `240 5% 65%` |
| `--outline-variant` | `240 6% 88%` |
| `--success` | `142 71% 36%` |
| `--warning` | `38 92% 50%` |
| `--ring` | `var(--brand)` |
| `--radius` | `0.5rem` |
| `--shadow-card` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` |

Dark (`.dark`): `--background 240 6% 6%`, surfaces from `240 6% 8%`
(lowest) through `240 4% 20%` (highest), `--on-surface 0 0% 95%`,
`--on-surface-variant 240 5% 65%`, `--secondary 240 5% 65%`,
`--secondary-container 240 4% 16%`, `--brand 217 91% 60%`,
`--tertiary` / `--error 0 84% 60%`, `--primary` / `--inverse-surface
0 0% 95%`, `--outline 240 4% 46%`, `--outline-variant 240 4% 20%`,
`--success 142 69% 45%`, `--warning 38 92% 55%`, `--shadow-card
0 1px 2px 0 rgb(0 0 0 / 0.4)`. `--brand-foreground` stays white and `--ring`
stays `var(--brand)`.

Usage rules:

- `--secondary` stays a neutral slate: many components use `text-secondary`
  for small labels. Links, focus rings, and the Inbox badge use the new
  `--brand` / `text-brand`.
- `outline-variant` is the default structural border. Reserve strong borders
  for card edges that need hard tactical emphasis.
- Do not create one-off color systems per feature. Classify the state first,
  then map to the shared neutral, info, success, warning, or danger tones.

## Radius scale

`--radius` is `0.5rem`. Tailwind radii derive from it
(`packages/ui/tailwind.config.ts`):

| Token | Value |
|---|---|
| `none` | `0px` |
| `sm` | `calc(var(--radius) - 4px)` |
| `DEFAULT`, `md` | `calc(var(--radius) - 2px)` |
| `lg` | `var(--radius)` |
| `xl` | `calc(var(--radius) + 4px)` |
| `2xl` | `calc(var(--radius) + 8px)` |
| `3xl` | `calc(var(--radius) + 12px)` |
| `full` | `9999px` |

## Typography

- Prose uses Inter (`font-body`), the default for everything a human reads.
- Machine values use JetBrains Mono (`font-mono`): IDs, session names, token
  counts, timestamps, commands, paths, versions, terminal and transcript
  content.
- Human-readable labels and headings are sentence case. Uppercase with letter
  spacing never applies to prose; sidebar section labels are small
  (`text-xs font-medium text-on-surface-variant`) sentence-case text.
- Translate raw codes into human-readable labels where possible instead of
  showing them raw. Terminal and transcript content stays mono but must not
  force the rest of the product to read like a log.

## Status vocabulary

Every state renders through `StatusBadge` / `StatusDot`
(`packages/ui/src/components/ui/status-badge.tsx`), driven by
`packages/ui/src/lib/status-vocabulary.ts`. Raw strings map to one tone and
one sentence-case label; unknown strings fall back to tone `neutral` with the
raw text humanized (`_`/`-` to spaces, first letter uppercased).

| Raw key | Tone | Label |
|---|---|---|
| `running` | running | Running |
| `active` | running | Active |
| `ready` | success | Ready |
| `done` | success | Done |
| `shipped` | success | Shipped |
| `clean` | success | Healthy |
| `partial` | warning | Partly running |
| `degraded` | warning | Degraded |
| `recoverable` | warning | Recoverable |
| `pending` | info | Starting |
| `draft` | neutral | Draft |
| `idle` | neutral | Idle |
| `stopped` | neutral | Stopped |
| `blocked` | danger | Blocked |
| `failed` | danger | Failed |
| `error` | danger | Error |
| `attention_required` | danger | Needs attention |
| `needs-input`, `needs_input` | danger | Needs input |
| `unknown` (or empty) | neutral | Unknown |

Tones render as `bg-success`, pulsing `bg-success` (running, disabled under
`motion-reduce`), `bg-warning`, `bg-destructive`, `bg-brand`, and `bg-outline`
dots, with matching tinted badge backgrounds. The running dot honors
`prefers-reduced-motion`.

## Components inventory

Shared primitives in `packages/ui/src/components/ui/` — reuse these before
adding new component styles:

- `PageHeader` — page title (`text-xl font-semibold`), optional description,
  actions row, and meta row. Every page opens with one.
- `MetricTile` — big tabular-nums value plus label, sublabel, and optional
  icon and link target. Used for the Dashboard's four tiles.
- `StatusBadge` / `StatusDot` — the status vocabulary rendered as a pill or a
  dot; badge carries `data-tone`, dot carries an accessible label.
- `EmptyState` — centered icon, title, one sentence, and one primary action
  (link or button). Every empty state offers the next step.
- `DropdownMenu` — thin styled wrappers over Radix dropdown (Root, Trigger,
  Content, Item with `destructive` support, Separator).
- `Kbd` — `<kbd>` chip for shortcuts (e.g. ⌘K).
- `Skeleton` — `animate-pulse` loading placeholder rows.
- `Sidebar` — labeled primary navigation with collapsible sections (Fleet,
  Work, Build, Chat), New-rig action, search entry, live rig list, and Inbox
  badge; auto-collapses when an Explorer column is open.
- `TopBar` — breadcrumbs plus host indicator and theme selector.
- `CommandPalette` — ⌘K palette over pages (old names still match), rigs, and
  actions, plus `g d` / `g i` / `g r` shortcuts.

Supporting shell pieces: `MobileBottomNav` (opaque bottom nav on small
screens), toasts for user-initiated rig mutations only (`notifySuccess` /
`notifyError`), and the `Explorer` per-destination tree column.

Runtime and tool brand marks (`RuntimeMark`, `runtime-brand.ts`,
`tool-brand.ts`) are product logos, not design tokens — their hex colors stay
as they are.

## Layout

The shell is route-first: Sidebar for primary navigation, Explorer for
route-specific tree context, center workspace for destination content, right
drawer for transient detail and file views, preview stack for pinned
quick-look panes. Breadcrumbs in the top bar show where the current page sits;
⌘K reaches anything in one keystroke.

Primary destinations: `/` Dashboard, `/for-you` Inbox, `/topology` Rigs,
`/agents` Agents, `/fleet` Hosts, `/project` Projects, `/workflows` Workflows,
`/files` Files, `/specs` Library, `/settings` Settings. Advisor and Operator
chat targets resolve at render time.

Rigs and Projects both use hierarchical scopes — host → rig → pod → agent, and
workspace → mission → slice. Each lower scope narrows the filter; each higher
scope widens the context.

## Motion

Motion explains state; it does not decorate. The vocabulary is small: activity
pulse for active/needs-input states, source/target flash for handoffs,
directional travel on graph edges, subtle route enter fades. Prefer slow
pulses to blinking, and honor `prefers-reduced-motion` by keeping static state
signals and removing travel animation.

## Accessibility

- Icon-only actions need labels or tooltips.
- Decorative marks use `aria-hidden`; semantic status uses `StatusBadge` /
  `StatusDot`, never color alone.
- Keyboard focus exposes hover-only controls; action clicks stop propagation
  so row navigation does not also fire.
- Drawers close with their close button and by clicking outside.

## Vellum (retired)

The previous Vellum paper / Black Glass surface languages are retired. The
`.vellum`, `.hard-shadow`, and `.reg-*` classes remain in `globals.css` only
as neutralized compatibility shims — flat `surface-lowest` backgrounds, the
standard card shadow, and hidden registration marks — so older markup keeps
rendering without the old look. Do not use them in new UI.

## Implementation references

- Tokens: `packages/ui/src/globals.css` (the Clean theme block is last and
  must stay last so it wins the cascade)
- Tailwind theme: `packages/ui/tailwind.config.ts`
- Status vocabulary: `packages/ui/src/lib/status-vocabulary.ts`
- Navigation model: `packages/ui/src/lib/nav.ts`
- Shell: `packages/ui/src/components/AppShell.tsx`,
  `packages/ui/src/components/shell/`
- Routes: `packages/ui/src/routes.tsx`
- Primitives: `packages/ui/src/components/ui/`
