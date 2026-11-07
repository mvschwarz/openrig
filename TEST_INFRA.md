# Test Infrastructure & Methodology: OpenRig UI Redesign (PR 2417)

## 1. Test Philosophy: Dual-Track Opaque-Box Verification

The OpenRig UI redesign (PR 2417) transitions the user interface from a legacy drafting rail into an operational control plane featuring a labeled sidebar, Clean theme tokens, Command Palette (⌘K), mobile navigation, Dashboard v2, Agent Properties panel, breadcrumbs, unified toasts, and restyled components.

Per the **Dual Track Principles** established in `PROJECT.md`:
1. **Opaque-Box Specification Conformance**: Tests are written against user-observable behaviors, ARIA contracts, DOM structure semantics, and external interfaces—not private implementation internals or temporary mock state.
2. **Implementation Independence**: Tests remain stable across internal refactoring (e.g. swapping CSS class compilers, replacing internal helper routines, or updating query fetch implementations).
3. **Requirement-Driven Assertions**: Every test case validates a concrete functional requirement, boundary condition, or invariant defined in `ORIGINAL_REQUEST.md` and `PROJECT.md`.
4. **Progressive Testability**: Tests verify observable capabilities without requiring unmerged or out-of-scope milestones, preventing false blockers while enforcing rigorous acceptance criteria.

---

## 2. Test Design Methodologies

The E2E test suite applies four established formal testing methodologies:

### 2.1 Category-Partition Method
Input spaces and system states are systematically partitioned into disjoint equivalence classes:
- **Viewport Dimension Categories**:
  - Desktop Ultra-Wide ($\ge 1920\text{px}$)
  - Desktop Standard ($1024\text{px} - 1440\text{px}$)
  - Tablet ($768\text{px} - 1023\text{px}$)
  - Mobile Standard ($375\text{px} - 430\text{px}$)
  - Mobile Compact ($320\text{px}$)
- **Theme Modes**: `light`, `dark`, `system`
- **Navigation Modes**: Click navigation, Command Palette ⌘K search, Keyboard sequences (`g d`, `g i`, `g r`), Breadcrumbs traversal, Mobile bottom nav tabs
- **Data States**: Zero rigs (first-run onboarding), Single rig active, Multi-rig fleet, Error/degraded states, Rapid SSE updates

### 2.2 Boundary Value Analysis (BVA)
Tests probe extreme edges, discontinuities, and thresholds:
- Minimum mobile width ($320\text{px}$) up to $4\text{K}$ resolution ($3840\text{px}$).
- Zero items in attention queue vs. large batches.
- Rapid successive key presses ($< 50\text{ms}$) testing sequence expiration and debounce guards.
- Empty search queries, special regex character queries (`.*`, `[`, `\`), and strings with extreme length ($1000+$ chars).
- Safe area insets and scroll clearance at zero vs maximum padding.

### 2.3 Pairwise (Combinatorial) Testing
Pairwise orthogonal arrays exercise concurrent interactions across distinct features to catch integration and layering defects:
- `CommandPalette` open $\times$ Active route changes
- Theme switch (`light` $\leftrightarrow$ `dark`) $\times$ Mobile drawer open
- `UndoToast` / `Toaster` notifications $\times$ `MobileBottomNav` fixed anchor
- Modal dialogs (`LaunchRecoveryModal`, `HostConfigCard`) $\times$ Global `g` sequence navigation
- Sidebar folded sections $\times$ Route transitions $\times$ Viewport resizing

### 2.4 Workload & Real-World Operator Scenarios
Full lifecycles modeled after real operator missions:
- Onboarding lifecycle: Fresh daemon $\to$ Getting Started card $\to$ Add spec $\to$ Launch rig $\to$ Verify dashboard cards update.
- Fleet supervision: Inspect running rig $\to$ Drill into Agent Properties panel $\to$ Check context window usage $\to$ Copy tmux attach command $\to$ Local vs Remote host verification.
- Inbox triaging: Attention items queue $\to$ 1-click verb approval $\to$ Undo toast appearance $\to$ Queue clearance.
- Fault recovery: Daemon connection loss $\to$ Error badge display $\to$ Reconnect $\to$ Data refresh.

---

## 3. Feature Inventory Coverage Mapping

| Feature # | Feature Name | Primary Source / Scope | Test Suite Location | Target Tier |
|---|---|---|---|---|
| **F01** | Labeled Sidebar | `Sidebar.tsx`, `SidebarSection.tsx`, `SidebarRigList.tsx` | `test/e2e/tier1-features/sidebar-features.test.tsx` | Tier 1, 2, 3 |
| **F02** | Clean Theme Tokens | `globals.css`, `tailwind.config.ts`, `StatusBadge.tsx` | `test/e2e/tier1-features/clean-theme-tokens.test.tsx` | Tier 1, 2, 3 |
| **F03** | Command Palette (⌘K) | `CommandPalette.tsx`, `cmdk`, `PaletteShortcuts` | `test/e2e/tier1-features/command-palette-features.test.tsx` | Tier 1, 2, 3 |
| **F04** | Mobile Navigation | `MobileBottomNav.tsx`, `AppShell.tsx` (mobile tray) | `test/e2e/tier1-features/mobile-navigation-features.test.tsx` | Tier 1, 2, 3 |
| **F05** | Dashboard v2 | `Dashboard.tsx`, `GettingStarted.tsx`, `MetricTiles.tsx` | `test/e2e/tier1-features/dashboard-v2-features.test.tsx` | Tier 1, 2, 4 |
| **F06** | Agent Properties Panel | `AgentPropertiesPanel.tsx`, `LiveNodeDetails.tsx` | `test/e2e/tier1-features/agent-properties-features.test.tsx` | Tier 1, 2, 4 |
| **F07** | Toasts & Notifications | `notify.ts`, `UndoToast.tsx`, `mutations.ts` | `test/e2e/tier1-features/toasts-notifications-features.test.tsx` | Tier 1, 2, 3 |
| **F08** | Breadcrumbs & Header | `breadcrumbs.ts`, `TopBar.tsx` | `test/e2e/tier1-features/breadcrumbs-header-features.test.tsx` | Tier 1, 2, 3 |
| **F09** | Page Restyling & Primitives | UI primitives (`button`, `badge`, `tabs`, `empty-state`) | `test/e2e/tier1-features/page-restyling-primitives-features.test.tsx` | Tier 1, 2 |
| **F10** | Codebase Hygiene & Wiring | Clean contracts, SPA links, orphan verification | `test/e2e/tier2-boundaries/boundary-corner-cases.test.tsx` | Tier 1, 2 |
| **F11** | Interaction & Concurrency | Debounce guards, modal shortcut scoping | `test/e2e/tier3-combinations/cross-feature-pairwise.test.tsx` | Tier 3, 4 |
| **F12** | Comprehensive E2E Workflows | Operator workflows, multi-rig lifecycle, recovery | `test/e2e/tier4-scenarios/real-world-workflows.test.tsx` | Tier 4 |

---

## 4. Test Suite Architecture & Directory Layout

```
packages/ui/test/
├── e2e/
│   ├── helpers/
│   │   └── e2e-harness.tsx             # Shared test harness (Router + QueryClient + EventSource + Mocks)
│   ├── tier1-features/
│   │   ├── sidebar-features.test.tsx
│   │   ├── clean-theme-tokens.test.tsx
│   │   ├── command-palette-features.test.tsx
│   │   ├── mobile-navigation-features.test.tsx
│   │   ├── dashboard-v2-features.test.tsx
│   │   ├── agent-properties-features.test.tsx
│   │   ├── toasts-notifications-features.test.tsx
│   │   ├── breadcrumbs-header-features.test.tsx
│   │   └── page-restyling-primitives-features.test.tsx
│   ├── tier2-boundaries/
│   │   └── boundary-corner-cases.test.tsx
│   ├── tier3-combinations/
│   │   └── cross-feature-pairwise.test.tsx
│   └── tier4-scenarios/
│       └── real-world-workflows.test.tsx
```

---

## 5. Execution Commands & Runner Requirements

### Environment
- **Test Runner**: Vitest v3 with JSDOM environment.
- **Node.js**: Windows PowerShell / CMD execution using `npm.cmd` or `npx.cmd`.

### Execution Commands
- **Run Entire UI Test Suite (including E2E)**:
  ```powershell
  npm.cmd run test -w packages/ui
  ```
- **Run E2E Test Suite Only**:
  ```powershell
  npx.cmd vitest run test/e2e/ -c packages/ui/vitest.config.ts
  ```
- **Run Targeted Tier**:
  ```powershell
  npx.cmd vitest run test/e2e/tier1-features/ -c packages/ui/vitest.config.ts
  ```
- **Run with Typecheck & Build**:
  ```powershell
  npm.cmd run build -w packages/ui
  ```
