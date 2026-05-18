---
kind: as-built
title: UI Project Observability, For You, Dashboard
status: active
topics: [observability, coordination]
domains: [engineering-advisor, product-advisor, operating-advisor]
applies-when: |
  Need to know how the operator-facing destination surfaces are built —
  the For-You attention feed (5-card classifier + verb actions), the
  Project workspace/mission/slice scope pages (tabbed rollups), and the
  Dashboard landing surface on the vellum brand system. Author-mode
  module — ui.md prose for these surfaces predates 0.3.x; every claim is
  sourced to file:line at HEAD.
siblings: [shell-and-routing.md, ../architecture/mission-control.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI Project Observability, For You, Dashboard

The three operator-facing destination surfaces: **For You** (`/for-you`,
the attention feed), **Project** (`/project*`, the workspace/mission/slice
scope pages), and the **Dashboard** (`/`, the landing surface on the
vellum brand system). All read live daemon state; none adds UI-local
persistence beyond per-event soft-dismiss.

> **AUTHOR-HEAVY module.** `ui.md`'s Project Observability / For You /
> Graphics-Layer sections are thin and predate the 0.3.1 dashboard/vellum
> brand refresh. Every load-bearing claim carries `> Source: <file:line>
> @HEAD`; ambiguity is declared as an OPEN item, never smoothed. Paths
> are relative to `packages/ui/src/` unless prefixed `docs/`.
>
> Verified at HEAD `7eaf524c` (`git describe` → `v0.3.1-6-g7eaf524c`).
> Package version **0.3.1**; HEAD carries 6 unreleased release-0.3.2
> commits; no `v0.3.2` tag (daemon-core.md; slice-00 §1.1).

## 0. Release attribution (forensic seam — read first)

Re-verified at HEAD via `git cat-file -e <tag>:<path>`:

| Layer | Release | Forensic proof @HEAD |
|---|---|---|
| Project-observability foundation (For-You feed, feed-classifier, project scope pages, the Mission Control 7-verb vocabulary) | **0.3.0** | `v0.3.0:components/for-you/Feed.tsx`, `v0.3.0:lib/feed-classifier.ts`, `v0.3.0:components/project/ScopePages.tsx`, `v0.3.0:components/mission-control/components/VerbActions.tsx` all resolve at `v0.3.0` (slice-00 0.3.0-GT §1.5/§1.6/§1.7) |
| Vellum **brand-identity system** the Dashboard/For-You now render on (`dashboard/vellum/*`: CornerBracket, VellumDestinationCard, marks, graphics, single-source-of-truth barrel) | **0.3.1, NOT 0.3.0** | `git cat-file -e v0.3.0:components/dashboard/vellum/index.ts` → **ABSENT** ("exists on disk, but not in 'v0.3.0'"); `v0.3.1:` → present (slice-00 0.3.0-GT seam (b); §2 rows 1/2) |

> Source: re-run at HEAD `7eaf524c` —
> `git cat-file -e v0.3.0:packages/ui/src/components/dashboard/vellum/index.ts`
> fails; `v0.3.0:.../for-you/Feed.tsx`, `.../lib/feed-classifier.ts`,
> `.../project/ScopePages.tsx`, `.../mission-control/components/VerbActions.tsx`
> all resolve at `v0.3.0`. Vellum surface *primitives*
> (`components/ui/vellum-*.tsx`) shipped 0.3.0; the coherent vellum
> *brand system* under `dashboard/vellum/` is 0.3.1 — slice-00 0.3.0-GT
> seam (b) is the exact split. **Do not back-attribute the vellum brand
> system to 0.3.0.**

## 1. Route reality (source-verified at `routes.tsx`@HEAD — BINDING)

Before narrating any surface, each route was verified at
`packages/ui/src/routes.tsx`@HEAD (542 lines). The Phase-8.1 survey's
"missing route" expectations are grep-derived and partially wrong; this
table is authored from `routes.tsx` reality, not the survey:

| Path | Reality @HEAD | Component | Source |
|---|---|---|---|
| `/for-you` | **REAL destination route** | `Feed` | `routes.tsx:122-126` |
| `/project` | **REAL destination route** | `WorkspaceScopePage` | `routes.tsx:128-132` |
| `/project/mission/$missionId` | **REAL destination route** | `MissionScopePage` | `routes.tsx:134-138` |
| `/project/slice/$sliceId` | **REAL destination route** | `SliceScopePage` | `routes.tsx:140-144` |
| `/` (index) | **REAL destination route** | `Dashboard` | `routes.tsx:88-92` |
| `/mission-control` | **DELETED `<Navigate to="/for-you">` redirect-stub** | `() => <Navigate to="/for-you">` | `routes.tsx:440-444` |
| `/progress` | **`<Navigate to="/project">` redirect-stub** (folds into Project tabs) | `() => <Navigate to="/project">` | `routes.tsx:463-467` |
| `/slices` | **DELETED `<Navigate to="/project">` redirect-stub** | `() => <Navigate to="/project">` | `routes.tsx:447-451` |
| `/slices/$name` | **`<Navigate to="/project/slice/$sliceId">` redirect-stub** | `useParams` → `<Navigate>` | `routes.tsx:453-460` |
| `/steering` | **`<Navigate to="/project">` redirect-stub** | `() => <Navigate to="/project">` | `routes.tsx:470-474` |
| `/markdown` | **NOT a route** — `MarkdownViewer` is a component used inside `MissionScopePage` | (no route) | grep `routes.tsx`@HEAD: zero `path: "/markdown"` |

> Source: `routes.tsx:88-92`,`:122-144`,`:440-474` @HEAD; component
> imports `routes.tsx:40-41` (`Dashboard`, `Feed`), `:60-63`
> (`WorkspaceScopePage`/`MissionScopePage`/`SliceScopePage` from
> `components/project/ScopePages.js`) @HEAD.

> **Route-reality contract (slice-08 §10.7):** the **Mission Control
> *system*** lives at daemon/PL-005 (see `../architecture/mission-control.md`)
> — `/mission-control` is **NOT a UI destination**; it is a deleted
> redirect-stub (SC-18). The 7-verb *action vocabulary* surfaces in this
> module via `VerbActions` embedded in For-You cards, but the system
> itself is not this module's subject. `/progress`, `/slices`,
> `/steering` all fold into `/project` tabs — they are redirect-stubs,
> not surfaces to narrate.

## 2. For You — the attention feed (`/for-you` → `Feed`)

`Feed` is the operator's attention surface: a chronologically-sorted,
subscription-filtered, soft-dismissable card stream over the live
activity feed. Header reads `Attention` / `For You`; max width 720px.

> Source: `components/for-you/Feed.tsx:364-369` (`data-testid="for-you-feed"`,
> max-w-720 + `For You` header), feed-centerpiece design note `:3-12`
> (PRIMARY UX = the feed; subscriptions NOT dominating — LOAD-BEARING
> SC-16) @HEAD.

### 2.1 The 5-card classifier (0.3.0 spine)

`classifyFeed(events)` maps every `ActivityEvent` to exactly one of five
`FeedCardKind` values — `action-required`, `approval`, `shipped`,
`progress`, `observation` — then sorts by `receivedAt` descending.
**Nothing is silently dropped**: any unmatched event type falls through
to `observation`. Queue-visibility events are sub-classified by
`queueKind(type, state)` (e.g. `*.closed` → shipped; `human-gate` /
`pending-approval` → action-required; `closeout-pending-ratify` →
approval); a human-seat destination forces `action-required`.

> Source: `lib/feed-classifier.ts:9-14` (`FeedCardKind` union),
> `classifyEvent` `:145-218` (default-observation fallthrough L216-217),
> `queueKind` `:93-110`, `classifyFeed` `:220-223` (receivedAt-desc sort),
> `isHumanSeat` `:141-144` @HEAD.

The feed pipeline (`Feed.tsx`): `classifyFeed` → cap at
`HISTORY_LIMIT = 50` → hydrate each card's kind from the live queue-item
map + action-audit (`hydratedCardKind`: a recorded outcome on an
action/approval card → `approval`; a `done|closed|completed` qitem →
`shipped`) → **subscription filter** (`isCardKindSubscribed` against the
5 `feed.subscriptions.*` config keys; `action-required` is always
visible, `observation` only when the audit subscription is on) → the
transient **lens-chip** filter (All / Action req / Approvals / Shipped /
Progress / Audit; not persisted) → per-event-seq soft-dismiss filter.

> Source: `components/for-you/Feed.tsx:63` (`HISTORY_LIMIT = 50`),
> `:238` (`classifyFeed(events).slice(0, HISTORY_LIMIT)`),
> `hydratedCardKind` `:156-180`, subscription+lens+dismiss pipeline
> `:269-285` (subscription FIRST L280-282; lens L283; dismiss L284),
> `LENS_CHIPS` `:54-61` @HEAD;
> subscription forced/default rules `Feed.tsx:3-12` (action_required
> forced ON L9; observation gated on audit_log L10) @HEAD.

### 2.2 Queue-item hydration + proof previews

For cards carrying a `qitemId` payload, `useQueueItemMap` hydrates the
full queue-item body; for `shipped` cards `sliceForCard` matches a slice
by tag/text and `proofPreviewForSlice` pulls the first proof packet with
screenshots so the card renders an inline `ProofThumbnailGrid` →
`ProofImageViewer`. This is the slice-00 §1.5 "queue cards hydrate qitem
bodies + proof previews" foundation, live-wired.

> Source: `components/for-you/Feed.tsx:263` (`useQueueItemMap`),
> `sliceForCard` `:182-201`, `proofPreviewForSlice` `:203-213`,
> per-card proof wiring `:421-427`; `FeedCard.tsx` proof block
> `:453-471` (`ProofPacketHeader`+`ProofThumbnailGrid`),
> `ProofImageViewer` `:521` @HEAD.

### 2.3 Verb actions on action/approval cards (the 7-verb system; OPEN-3)

An actionable card (`action-required` or `approval`, no recorded
outcome, non-terminal qitem) embeds `VerbActions`. The **canonical
Mission Control action vocabulary is the 7-verb system** —
`MISSION_CONTROL_VERBS = [approve, deny, route, annotate, hold, drop,
handoff]` — defined at the Mission Control system level (slice-00
0.3.0-GT §1.6/seam (c): the vocabulary *originates in 0.3.0 source*).

> Source: `components/mission-control/hooks/useMissionControlAction.ts:5-15`
> (`MISSION_CONTROL_VERBS` 7-element const `:5-13` + `MissionControlVerb`
> type `:15`), `components/mission-control/components/VerbActions.tsx:82`
> (defaults to all 7 via `enabledVerbs = [...MISSION_CONTROL_VERBS]`),
> per-verb input needs `:97-99` (route/handoff→destination L97;
> annotate→annotation L98; hold/drop→reason L99) @HEAD; slice-00
> 0.3.0-GT §1.6 + seam (c).

> **OPEN — For-You verb-subset (slice-00 0.3.0-GT OPEN-3; NOT smoothed).**
> `VerbActions` accepts an `enabledVerbs` prop to restrict the offered
> verbs (`VerbActions.tsx:21-22`). The For-You `FeedCard` currently
> passes `enabledVerbs={["approve", "deny", "route"]}`
> (`FeedCard.tsx:492`). **The exact shipped For-You-surface verb subset
> is an unresolved velocity slice-01 ruling** (slice-00 0.3.0-GT OPEN-3:
> CHANGELOG `[0.3.1]` enumerates the full 7 on `FeedCard`, while
> source-material §6 frames it as a "subset" — the discrepancy is OPEN).
> Per the slice-08 contract this module describes the **7-verb
> system-level vocabulary only** and does NOT assert a definitive
> For-You verb subset. The `enabledVerbs` prop value above is reported
> as the literal current source state, explicitly NOT as a resolution
> of OPEN-3.

On mutation success `VerbActions` fires `onOptimisticOutcome`; `Feed`
keeps an optimistic-outcome map keyed by `qitemId` so the
`ActionOutcomePanel` receipt renders instantly without waiting for the
audit-log re-fetch (the audit re-fetch eventually surfaces the same
shape). A terminal qitem with no recorded outcome derives a fallback
receipt from its closure reason.

> Source: `components/for-you/Feed.tsx:224-236` (optimistic-outcome
> map + `setOptimisticOutcome`), `:426-428` (optimistic-first, audit
> fallback: `optimisticOutcomes.get ?? actionOutcomes.get ?? null`);
> `FeedCard.tsx:473-500` (`isActionableCard` gate L473 + `VerbActions`
> wiring L489-499), `isActionableCard` `:166-175`,
> `fallbackOutcomeFromQueueItem` `:177-198`, `ActionOutcomePanel`
> `:271-310`; `VerbActions.tsx:138-145` (`onOptimisticOutcome` on
> mutation `onSuccess`) @HEAD.

### 2.4 Card surface — vellum-coherent (0.3.1 brand layer)

`FeedCard` renders on the **0.3.1 vellum brand system**: a
`bg-stone-100/45 backdrop-blur` surface with a 3-stop ambient box-shadow
(no border), four `CornerBracket` marks registering the bounds through
the vellum, a mono-uppercase kind tag + colored dot, and runtime
graphics marks (`ActorMark` for sessions) — the slice-00 §1.7 "shared
graphics marks across drawers / proof rows / queue refs / story rows"
foundation, now expressed in the matured vellum vocabulary. Cards are
keyboard-dismissable (Backspace/Delete) and swipe-dismissable, with an
`UndoToast`.

> Source: `components/for-you/FeedCard.tsx:72-73` (`CARD_SURFACE_CLASS`),
> `:74-80` (`CARD_SHADOW_STYLE` 3-stop box-shadow), corner brackets
> `:401-404` (4× `<CornerBracket position=…>`), `KIND_DOT` `:33-39`,
> kind tag span `:410-414`, `ActorMark` import `:25` + usage `:229`;
> `CornerBracket` from the 0.3.1 brand barrel
> `dashboard/vellum/index.ts:17`; slice-00 0.3.0-GT seam (b) + §1.7 @HEAD.

### 2.5 Storytelling preview band

Above the legacy card list `Feed` renders a `StorytellingFeed` preview
built by `buildStorytellingFeedItems` from discovered missions
(`useMissionDiscovery` → `ProgressCard`, first 2) + slices
(`useSlices` → `ShippedCard` for shipped/done, `IncidentCard`
otherwise, capped at 3). Mission rows carry a daemon-derived
`status` so the "Getting Started"-style complete-and-hide filters
durably (`status === "complete"`), with an optimistic local hide +
best-effort `POST /api/missions/:id/complete` audit write that swallows
network errors so a partial-air-gapped daemon does not block the hide.

> Source: `components/for-you/Feed.tsx:319-343` (mission/slice adapters:
> `useMissionDiscovery` L319, `missionsWithStatus` L329-335,
> `buildStorytellingFeedItems` L336-343; adapter comment L305-318),
> `handleMarkMissionComplete` `:351-361` (best-effort `void fetch` L354,
> error-swallowed L357), preview render `:399-409`;
> `components/feed/cards/storytelling-cards.tsx:36` (`CardKind`),
> `ShippedCard` `:184`, `IncidentCard` `:235`, `ProgressCard` `:289`
> @HEAD.

## 3. Project — workspace / mission / slice scope pages (0.3.0 spine)

`/project*` mounts three scope pages, all built on a shared
`ScopeShell` + tabbed-rollup pattern (slice-00 §1.5 project
observability foundation). A `SHARED_TABS` set —
`overview / story / progress / artifacts / tests / queue / topology` —
drives `WorkspaceScopePage` and `MissionScopePage`; `SLICE_TABS`
reorders `story` first for `SliceScopePage` but `SliceScopePage`'s
`useState` default is `overview` (README + readiness first, not a
metric grid).

> Source: `components/project/ScopePages.tsx:75-76` (`SharedTab` /
> `SliceTab` types), `SHARED_TABS` `:78-86`, `SLICE_TABS` `:88-96`,
> `ScopeShell` `:137-166`, `TabNav` `:98-135` @HEAD.

### 3.1 WorkspaceScopePage (`/project`)

Reads the live workspace name (`useWorkspaceName`); honest empty-state
(`NO WORKSPACE CONNECTED` with an Open-settings action) when unset. The
`overview` tab renders `WorkspaceOverviewPanel`: slices grouped into
missions, then `partitionProjectMissions` splits them into a
two-column **Current Work / Archive** layout (slice-00 §1.5
"current/archive grouping"). Each mission card lists its slices as
`Link`s to `/project/slice/$sliceId` with a `QueueCountIcon` +
`StatusDot`. The other tabs are the scope rollups (§3.4).

> Source: `components/project/ScopePages.tsx:676-749` (`WorkspaceScopePage`;
> no-workspace empty-state guard `:682-693`, `workspace-scope-no-workspace`
> `:689`), `WorkspaceOverviewPanel` `:534-674` (mission bucketing
> `:536-551`, `partitionProjectMissions` `:552`, two-column panel `:631`,
> Current section `:632-651`, Archive section `:652-671`) @HEAD.

### 3.2 MissionScopePage (`/project/mission/$missionId`)

Same `ScopeShell`/`SHARED_TABS`. `overview` renders the mission README
(`useScopeMarkdown(missionPath, "README.md")` via `MarkdownViewer`)
above a slice rail; `progress` renders a `MissionProgressHeatmap` + the
mission `PROGRESS.md` + the shared `ScopeProgressRollup`. The `topology`
tab renders the **projected workflow spec graph** via `TopologyTab`
when the mission's README frontmatter declares a `workflow_spec` that is
in the `WorkflowSpecCache` (daemon returns `topology.specGraph`),
falling back to session-name aggregation otherwise.

> Source: `components/project/ScopePages.tsx:751-895` (`MissionScopePage`;
> `useMission` `:759`, `missionPath` `:760-761`, README/PROGRESS
> markdown `:762-763`, overview README section `:775`, progress
> heatmap `:832`, `mission-progress-readme` `:838`, spec-graph topology
> branch `:875-891` — `missionTopology` `:875`, `specGraph` check
> `:879`, session-name fallback `:890`) @HEAD.

### 3.3 SliceScopePage (`/project/slice/$sliceId`)

Default tab `overview` (`SliceOverviewTab` — README + current step +
readiness). Loading/error states are honest empty-states (the error
state names `rig config get workspace.slices_root` as the likely
misconfiguration). `progress` folds in `AcceptanceTab` (acceptance is
the canonical slice-scope progress proof); `story` renders `TimelineTab`
with curated `timeline.md` (`useSliceTimelineMarkdown`) above the
auto-captured event feed; `topology` renders the slice's
workflow-instance-aware `TopologyTab`.

> Source: `components/project/ScopePages.tsx:1187-1297` (`SliceScopePage`;
> default `overview` `:1192`, timeline md `:1204`, loading-state
> guard `:1206`, error-state guard `:1225` (slices_root remediation
> hint `:1239`), story=`TimelineTab` `:1258-1265`,
> progress=`AcceptanceTab` `:1269-1273`, topology `:1294`) @HEAD.

### 3.4 Shared scope rollups

`ScopeStoryRollup`, `ScopeProgressRollup`, `ScopeArtifactsRollup`,
`ScopeTestsRollup`, `ScopeQueueRollup`, `ScopeTopologyRollup` (the
non-overview tabs) all read from one `useProjectScopeRollup(missionId,
loadDetails)` hook so workspace and mission scopes share identical
rollup behavior over their respective slice sets — the slice-00 §1.5
"workspace/mission rollups" foundation. Detail fetching is gated on the
active tab (`active !== "overview"`) so the overview path stays cheap.

> Source: `components/project/ScopePages.tsx:198-217`
> (`useProjectScopeRollup`; `rowsForScope` `:193-196`),
> rollup components `:219-532`; gate `:679`,`:754` (`active !== "overview"`)
> @HEAD.

## 4. Dashboard — the landing surface (`/` → `Dashboard`)

`Dashboard` is a thin composition over the **0.3.1 vellum brand
system**: it imports `MidLayerContent`, `TopLayerContent`,
`DestinationsLayer` from `dashboard/vellum/index.js` — the SAME barrel
`/lab/vellum-lab` imports, so the production dashboard tracks the design
lab exactly (single source of truth). Real-data wiring: `useRigSummary`
→ totalRigs/totalAgents, `usePsEntries` → activeAgents, `useSpecLibrary`
→ librarySize, `window.location.hostname` → classification eyebrow. Per
a 2026-05-15 founder dispatch the heavy `BackLayerContent` /
`BackVellumSheet` back-layer was removed so the dashboard sits on the
page-level cream paper-grid; the barrel still exports them (used by the
lab).

> Source: `components/dashboard/Dashboard.tsx:1-52` (vellum-barrel
> import `:12-16`, single-source-of-truth note `:2-5`, real-data hooks
> `:29-39`, back-layer-removal note `:21-27`, render `:40-50`);
> `components/dashboard/vellum/index.ts:1-26` (barrel; `BackLayerContent`
> `:5` / `BackVellumSheet` `:6` still exported); slice-00 0.3.0-GT
> seam (b) + §2 rows 1/2 @HEAD.

## 5. Cross-cutting properties

- **Live daemon state, no UI-local persistence beyond soft-dismiss** —
  every surface reads daemon hooks; the only UI-local state is the
  per-event-seq dismiss set + transient lens chips + optimistic-outcome
  map (`Feed.tsx:217` lens, `:224` optimistic map, `:240-241` dismiss
  set; `ScopePages.tsx` `useState` tab state `:677`,`:753`,`:1192`)
  @HEAD.
- **Honest empty/error states** — `WorkspaceScopePage` no-workspace
  (`ScopePages.tsx:682-693`), `WorkspaceOverviewPanel` index-unavailable
  (`:565-573`, label `:568`), `SliceScopePage` not-available
  (`:1225-1245`, label `:1235`) all surface the cause + a remediation
  pointer, never a blank screen @HEAD.
- **0.3.0 observability spine on the 0.3.1 vellum brand layer** — the
  classifier / verb-action / scope-rollup *logic* is the 0.3.0
  foundation (§0); the *visual surface* (vellum cards, corner brackets,
  graphics marks, dashboard) is the 0.3.1 brand maturation. The split is
  slice-00 0.3.0-GT seam (b); do not collapse either direction @HEAD.

## OPEN items (carried, not smoothed)

- **OPEN — For-You verb subset (slice-00 0.3.0-GT OPEN-3).** The exact
  shipped For-You-surface verb subset is an unresolved velocity slice-01
  ruling (CHANGELOG `[0.3.1]` "all 7" vs source-material §6 "subset"
  discrepancy). This module describes the **7-verb system-level
  vocabulary only** and reports the literal current `enabledVerbs`
  prop value (§2.3) as source state, NOT as a resolution. Defer
  For-You-subset enumeration to the pending velocity ruling.
- **OPEN — `/project` redirect-stub consolidation.** `/progress`,
  `/slices`, `/steering` are `<Navigate to="/project">` stubs and
  `/slices/$name` redirects into `/project/slice/$sliceId` (§1). The
  former standalone surfaces fold into Project tabs; whether the stubs
  are permanent or transitional is a product decision not resolvable
  from source.
- No slice-00 numeric-drift OPEN (1–5) applies — this module carries no
  migration / route-group / PL-004-event counts.
