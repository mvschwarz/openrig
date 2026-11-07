# Project: OpenRig UI Redesign (PR 2417) Audit, Remediation & Verification

## Architecture
- **Package**: `@openrig/ui` located at `packages/ui`.
- **Target Lineage**: PR 2417 (`ui-redesign-upstream` merged into `main`).
- **Application Model**: Client-side Single Page Application (SPA) using React 18, Vite 6, TanStack Router (`packages/ui/src/routes.tsx`), Tailwind CSS with semantic Clean theme tokens (`globals.css` and `tailwind.config.ts`), and TanStack Query (`@tanstack/react-query`).
- **Monorepo Integration**: `@openrig/ui` builds static assets to `packages/ui/dist/`, copied to `packages/cli/ui/dist/` via `scripts/build-package.sh`, served by `packages/daemon/src/server.ts` with SPA deep-link fallback to `index.html`. Zero direct TypeScript cross-package dependencies.
- **Subsystems**:
  1. **Shell & Layout**: `AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `MobileBottomNav.tsx`, `VellumSheet.tsx`.
  2. **Navigation & Shortcuts**: `nav.ts`, `CommandPalette.tsx` (cmdk), keyboard sequence navigation.
  3. **Theme & Design Primitives**: `globals.css` (semantic tokens, radius math), `status-vocabulary.ts`, `StatusBadge.tsx`, UI components (`separator.tsx`, `tooltip.tsx`, `tabs.tsx`, `badge.tsx`, `input.tsx`, `textarea.tsx`, `kbd.tsx`).
  4. **Operational Views**: `Dashboard.tsx` v2 (`GettingStarted`, `NeedsYou`, `MetricTiles`, `RigsTable`, `RecentActivity`, `HostConfigCard`), `LiveNodeDetails.tsx` (`AgentPropertiesPanel`), `SpecsLibraryPage.tsx`.
  5. **Notifications**: `notify.ts` (Sonner wrapper), `mutations.ts`, `UndoToast.tsx`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Labeled Sidebar | Collapsible 15rem/3.5rem navigation sidebar with active route highlighting and badge counters | M2 | PR 2417 / Survey |
| 2 | Clean Theme Tokens | Light and dark mode semantic tokens, dynamic radius math, and WCAG AA contrast conformance | M1 | PR 2417 / Survey |
| 3 | Command Palette (⌘K) | cmdk-based modal palette, route search, rig search by ID and name, keyboard shortcuts popup | M2 | PR 2417 / Survey |
| 4 | Mobile Navigation | Mobile drawer/tray, backdrop dismiss, and fixed bottom navigation bar (`MobileBottomNav`) | M3 | PR 2417 / Survey |
| 5 | Dashboard v2 | GettingStarted checklist, NeedsYou priority queue, MetricTiles, RigsTable, and RecentActivity SSE feed | M1, M2 | PR 2417 / Survey |
| 6 | Agent Properties Panel | Metadata inspector panel (runtime, parent rig, session copy, context bar, error display) with responsive access | M3 | PR 2417 / Survey |
| 7 | Toasts & Notifications | Sonner toaster wrapper across rig lifecycle mutations and mobile toast placement (`UndoToast`) | M1, M3 | PR 2417 / Survey |
| 8 | Breadcrumbs & Header | Dynamic route crumb generation, hierarchy preservation for deep paths, and TopBar action layout | M2, M3 | PR 2417 / Survey |
| 9 | Page Restyling & Primitives | Standardized buttons, inputs, tabs, separators, tooltips, badges, empty states, and SPA navigation links | M1, M2 | PR 2417 / Survey |
| 10 | Codebase Hygiene & Dead Code | Removal of orphaned hook `useAllAgents`, unused functions in `Explorer.tsx`, and redundant query polling | M1 | PR 2417 / Survey |
| 11 | Interaction & Concurrency Guards | Dialog keyboard shortcut scoping, button mutation pending state guards, and error handling | M2, M3 | PR 2417 / Survey |
| 12 | Comprehensive E2E Test Suite | Automated opaque-box test suite across Tiers 1–4 and adversarial Tier 5 hardening | M4, E2E-Track | ORIGINAL_REQUEST |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Dead Code Removal, Primitives & Clean Theme Tokens | Remove orphaned `useAllAgents` and dead code in `Explorer.tsx`. Fix phantom classes in UI primitives (`separator`, `tooltip`, `tabs`, `badge`), add `rounded-md` to input/textarea, fix WCAG AA contrast for light mode status tokens, and tokenize hardcoded color escapes. | None | DONE (All tests pass: 233 test files, 2,048 tests, 0 errors, build clean, Gate: PASS) |
| M2 | Navigation, Shell, Wiring & SPA Routing | Fix Sidebar chat active highlighting, add `NAV_CHAT` and `rig.id` search to Command Palette, style keyboard shortcuts dialog, replace native `<a>` tags with TanStack Router `<Link>` in empty states/subpages, fix breadcrumbs hierarchy, and guard shortcuts during modal dialogs. | M1 | DONE (All tests pass: 236 test files, 2,143 tests passed, build clean, Gate: PASS) |
| M3 | Responsive Scaling, Mobile/Tablet Layouts & Concurrency | Fix mobile `UndoToast` overlap above `MobileBottomNav`, add bottom clearance to `VellumSheet`/`SharedDetailDrawer`, fix mobile TopBar breadcrumb overflow, provide tablet/mobile access to `AgentPropertiesPanel`, guard host multi-clicks, and add missing mutation toasts. | M1, M2 | DONE (All tests pass: 238 test files, 2,222 tests passed, 0 errors, build clean, Gate: PASS) |
| M4 | Final Milestone: Pass 100% E2E Tests & Hardening | Phase 1: Pass 100% of opaque-box E2E test suite (Tiers 1-4). Phase 2: Adversarial coverage hardening (Tier 5) with Challenger stress testing. | M1, M2, M3, E2E-Track | DONE (All Tiers 1-5 tests pass: 71 E2E tests + 61 Tier 5 adversarial tests, 240/240 test files, 2,283+ tests, 0 errors, build clean, Gate: PASS) |
| E2E | E2E Testing Track | Design test runner and test infra (`TEST_INFRA.md`), author Tiers 1-4 opaque-box tests covering all 12 features, and publish `TEST_READY.md`. | None (Parallel Track) | DONE (`TEST_INFRA.md` & `TEST_READY.md` published, 71 tests passing) |

## Interface Contracts

### Primitives ↔ Consumers (`M1` ↔ `M2`, `M3`)
- `separator.tsx`: Must provide a visible hairline divider using `bg-outline-variant` (or valid semantic token), maintaining existing `orientation` and `decorative` Radix props.
- `tooltip.tsx`: Must use valid theme border `border-outline-variant` on content popover.
- `tabs.tsx`: Active tab styling must use `data-[state=active]:bg-surface-mid` or `data-[state=active]:bg-surface-container-high` and `data-[state=active]:text-on-surface`.
- `badge.tsx`: `secondary` variant must reference valid token `text-on-surface-variant` or defined `text-secondary-foreground`.
- `globals.css`: Status tokens `--success` and `--warning` must maintain $\ge 4.5:1$ contrast against light background `#ffffff`.

### Navigation ↔ Shell (`M2` ↔ `M3`)
- `nav.ts`: `allNavItems()` must include `NAV_CHAT` entries with valid titles and icons so `CommandPalette` can filter and execute them.
- `CommandPalette.tsx`: `Command.Item` for rigs must include `value={`${rig.name} ${rig.id}`}` for searchable ID lookup.
- `Sidebar.tsx`: Chat item active state must evaluate `activeWhen: (path) => path.startsWith(`/topology/seat/`) && isCurrentSeat(c.role)`.
- `breadcrumbs.ts`: `buildBreadcrumbs(pathname)` must not drop middle segments into an empty void; deep paths must retain navigable parent crumbs.

### Layout ↔ Mobile Viewport (`M3` ↔ Shell)
- `MobileBottomNav.tsx`: Height is 56px (`h-14`) + `env(safe-area-inset-bottom)`. `z-index: 40`.
- `UndoToast.tsx`: Must anchor at `bottom-20` on mobile viewports (`< 1024px`) to clear the 56px bottom nav.
- `VellumSheet.tsx` / `SharedDetailDrawer.tsx`: Must incorporate `pb-16` on mobile screens to ensure drawer actions remain clickable above `MobileBottomNav`.
- `Toaster` in `AppShell.tsx`: Mobile positioning must avoid overlapping bottom navigation buttons.

## Code Layout
- `packages/ui/src/components/shell/`: Shell layouts (`AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `MobileBottomNav.tsx`, `CommandPalette.tsx`). Owned by M2/M3.
- `packages/ui/src/components/ui/`: UI primitives (`separator.tsx`, `tooltip.tsx`, `tabs.tsx`, `badge.tsx`, `input.tsx`, `textarea.tsx`, `empty-state.tsx`, `vellum-sheet.tsx`). Owned by M1/M2/M3 per file.
- `packages/ui/src/components/dashboard/`: Dashboard v2 cards and widgets (`Dashboard.tsx`, `GettingStarted.tsx`, `HostConfigCard.tsx`). Owned by M1/M3.
- `packages/ui/src/components/`: Root components (`AgentPropertiesPanel.tsx`, `LiveNodeDetails.tsx`, `Explorer.tsx`). Owned by M1/M3.
- `packages/ui/src/lib/`: Utilities (`nav.ts`, `breadcrumbs.ts`, `notify.ts`, `status-vocabulary.ts`). Owned by M1/M2.
- `packages/ui/src/hooks/`: Hooks (`mutations.ts`, `useAllAgents.ts`). Owned by M1/M3.
- `packages/ui/src/globals.css`, `tailwind.config.ts`: Stylesheet and token configuration. Owned by M1.
- `packages/ui/test/`: Test suites. Owned by E2E Testing Track and Milestones.
