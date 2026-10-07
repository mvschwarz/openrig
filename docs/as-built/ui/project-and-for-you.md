---
kind: as-built
title: UI Project Observability, For You, Dashboard
status: active
topics: [observability, coordination]
domains: [engineering-advisor, product-advisor, operating-advisor]
applies-when: |
  Need to know how the operator-facing destination surfaces are built —
  the For-You attention feed (5-card classifier, attention merge, verb
  actions), the Project workspace/mission/slice scope pages (tabbed
  rollups), and the Dashboard launcher. The web UI is in maintenance mode;
  claims are sourced to file and symbol (and line where verified) at the
  stamped commit.
siblings: [shell-and-routing.md, ../architecture/mission-control.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 2620dea84efad75e3c5fff9fcf816a78c8e8155f
last-updated: 2026-10-05
---

# UI Project Observability, For You, Dashboard

The three operator-facing destination surfaces: **For You** (`/for-you`,
the attention feed), **Project** (`/project*`, the workspace/mission/slice
scope pages), and the **Dashboard** (`/`, the launcher). All read live
daemon state. For You persists two dismissal sets in localStorage; shared
shell preferences include the theme choice (see
[`library-specs-and-design-system.md`](library-specs-and-design-system.md))
and the maintenance-notice dismissal (see
[`shell-and-routing.md`](shell-and-routing.md)).

> Paths are relative to `packages/ui/src/` unless prefixed `docs/` or
> `packages/`. Verified at `2620dea8` (package version 0.6.6). The web UI
> is in maintenance mode (`docs/reference/developing.md`); this page
> records what ships, not a roadmap.

## 0. Release attribution (forensic seam)

Checked via `git cat-file -e <tag>:<path>`:

| Layer | Release | Forensic proof |
|---|---|---|
| Project-observability foundation (For-You feed, feed-classifier, project scope pages, the Mission Control 7-verb vocabulary) | **0.3.0** | `v0.3.0:components/for-you/Feed.tsx`, `v0.3.0:lib/feed-classifier.ts`, `v0.3.0:components/project/ScopePages.tsx`, `v0.3.0:components/mission-control/components/VerbActions.tsx` all resolve at `v0.3.0` |
| Vellum **brand-identity system** (`dashboard/vellum/*`: CornerBracket, VellumDestinationCard, marks, graphics, barrel) | **0.3.1, NOT 0.3.0** | `git cat-file -e v0.3.0:packages/ui/src/components/dashboard/vellum/index.ts` fails; `v0.3.1:` resolves |

Vellum surface *primitives* (`components/ui/vellum-*.tsx`) shipped 0.3.0;
the brand system under `dashboard/vellum/` is 0.3.1. Do not back-attribute
the brand system to 0.3.0.

## 1. Route reality

Verified at `routes.tsx` (605 lines):

| Path | Reality | Component | Source |
|---|---|---|---|
| `/` (index) | destination route | `Dashboard` | `routes.tsx:96-100` |
| `/for-you` | destination route | `Feed` | `routes.tsx:130-134` |
| `/project` | destination route | `WorkspaceScopePage` | `routes.tsx:136-140` |
| `/project/mission/$missionId` | destination route | `MissionScopePage` | `routes.tsx:142-146` |
| `/project/slice/$sliceId` | destination route | `SliceScopePage` | `routes.tsx:148-152` |
| `/mission-control` | redirect stub to `/for-you` | `() => <Navigate to="/for-you">` | `routes.tsx:496-500` |
| `/slices` | redirect stub to `/project` | `() => <Navigate to="/project">` | `routes.tsx:503-507` |
| `/slices/$name` | redirect stub to `/project/slice/$sliceId` | `useParams` → `<Navigate>` | `routes.tsx:509-516` |
| `/progress` | redirect stub to `/project` | `() => <Navigate to="/project">` | `routes.tsx:519-523` |
| `/steering` | redirect stub to `/project` | `() => <Navigate to="/project">` | `routes.tsx:526-530` |
| `/markdown` | **not a route** — `MarkdownViewer` is a component | (no route) | no `path: "/markdown"` in `routes.tsx` |

> Source: component imports `routes.tsx:42-43` (`Dashboard`, `Feed`),
> `:61-65` (`WorkspaceScopePage`/`MissionScopePage`/`SliceScopePage` from
> `components/project/ScopePages.js`).

The review altitudes `/agents` (`RigAgentsPage`) and `/fleet` (`FleetPage`)
are listed in [`shell-and-routing.md`](shell-and-routing.md).

> **Route-reality contract:** the **Mission Control *system*** lives in the
> daemon (see `../architecture/mission-control.md`); `/mission-control` is
> a redirect stub, not a UI destination. The 7-verb *action vocabulary*
> surfaces here via `VerbActions` in For-You cards. `/progress`, `/slices`
> and `/steering` fold into `/project` tabs.

## 2. For You — the attention feed (`/for-you` → `Feed`)

`Feed` is the operator's attention surface: decision cards first, then the
rest newest-first, subscription- and lens-filtered and soft-dismissable.
Header reads `Attention` / `For You`; max width 720px. A plain-language
`LevelControl` (All activity / Highlights / Needs you) sits at the top of
the feed over the same subscription toggles.

> Source: `components/for-you/Feed.tsx` (`data-testid="for-you-feed"`,
> max-w-720 header; `LevelControl` in `feed-level-control`; design note
> `:3-12`); `lib/feed-levels.ts` `FEED_LEVEL_LABELS`.

### 2.1 The 5-card classifier (0.3.0 spine)

`classifyFeed(events)` maps every `ActivityEvent` to one of five
`FeedCardKind` values — `action-required`, `approval`, `shipped`,
`progress`, `observation` — sorted by `receivedAt` descending. **Nothing is
silently dropped**: an unmatched event type falls through to
`observation`. Queue events are sub-classified by
`queueKind(type, state, tier)`: `*.closed` → shipped;
`qitem.closure_overdue` / `inbox.denied` → action-required; tier
`human-gate` → **approval**; state `pending-approval` → action-required;
`closeout-pending-ratify` → approval; `done|closed|completed|shipped` →
shipped; otherwise progress. A human-seat destination forces
`action-required` unless the card is already an approval.

> Source: `lib/feed-classifier.ts` — `FeedCardKind` `:10-15`, `queueKind`
> `:105-129`, `isHumanSeat`, `classifyEvent` (approval-preserving
> human-seat override; default-observation fallthrough), `classifyFeed`,
> `sortFeedByDecisionBand`.

### 2.2 The feed pipeline

1. **Event cards:** `classifyFeed(events)` capped at `HISTORY_LIMIT = 50`.
2. **Attention merge:** daemon attention rows (`useAttentionItems(50, …)`:
   `GET /api/queue/list?attention=1…`, or `GET /api/queue/attention-aggregate`
   when a remote host subscription is on) and needs-input seats
   (`useNeedsInputSeats`) become cards, and `mergeAttentionIntoFeed` lets a
   queue-derived card supersede a matching event-derived **action-required
   or approval** card; shipped, progress and observation event cards for the
   same qitem remain.
3. **Decision-band sort:** `sortFeedByDecisionBand` lifts every
   action-required and approval card above the rest, newest-first within
   each band.
4. **Hydration:** `hydratedCardKind` re-reads each card against the live
   queue item and the action audit: a recorded outcome on an
   action/approval card → `approval`; tier `human-gate` → `approval`; a
   `done|closed|completed` item → `shipped`; a human-seat destination →
   `action-required`.
5. **Filters, in order:** subscription (`isCardKindSubscribed`;
   `action-required` always visible, `observation` only with the audit
   subscription), the transient lens chips (All / Action req / Approvals /
   Shipped / Progress / Audit), a per-host filter, then dismissal.
   Event cards dismiss by event seq (`forYou.dismissedSeqs`); queue-derived
   cards dismiss by card id (`forYou.dismissedCardIds`); both are
   localStorage-backed.

> Source: `components/for-you/Feed.tsx` — `LENS_CHIPS` `:60-67`,
> `HISTORY_LIMIT` `:69`, `hydratedCardKind` `:167-186`, attention merge and
> sort `:244-276`, dismiss hooks `:285`/`:294`, filter pipeline `:334-356`;
> `hooks/useAttentionItems.ts`, `hooks/useNeedsInputSeats.ts`,
> `lib/attention-feed.ts` (`mergeAttentionIntoFeed`, `attentionKindFor`),
> `hooks/useDismissedSeqs.ts`, `hooks/useDismissedCardIds.ts`.

With one or more remote host subscriptions enabled, the feed shows host
chips and status rows, cards carry a host chip, and verbs forward the
card's `hostId` (`Feed.tsx` host filter; `hooks/useFeedSubscriptions.ts`
key `feed.subscriptions.<hostId>.enabled`; `VerbActions.tsx`).

### 2.3 Queue-item hydration + proof previews

For cards carrying a `qitemId`, `useQueueItemMap` hydrates the queue item;
for `shipped` cards `sliceForCard` matches a slice by tag/text and
`proofPreviewForSlice` pulls the first proof packet with screenshots, so
the card renders an inline `ProofThumbnailGrid` → `ProofImageViewer`.

> Source: `components/for-you/Feed.tsx` (`useQueueItemMap`,
> `sliceForCard`, `proofPreviewForSlice`); `FeedCard.tsx` proof block and
> `<ProofImageViewer>`.

### 2.4 Verb actions on action/approval cards

The **canonical Mission Control action vocabulary is the 7-verb system** —
`MISSION_CONTROL_VERBS = [approve, deny, route, annotate, hold, drop,
handoff]`. `VerbActions` defaults to all seven
(`enabledVerbs = [...MISSION_CONTROL_VERBS]`); route/handoff need a
destination, annotate an annotation, hold/drop a reason.

> Source: `components/mission-control/hooks/useMissionControlAction.ts:5-15`;
> `components/mission-control/components/VerbActions.tsx` (`enabledVerbs`
> default `:108`).

**The For-You actionable-card surface is bare one-tap APPROVE + CHAT.**
`FeedCard` passes `bare`, `enabledVerbs={["approve"]}` and
`oneClickVerbs={["approve"]}`, beside a CHAT button that opens the shared
`ProgressiveTerminal` seeded via `buildChatPreamble` (human-action cards
chat with the sender). Deny/route are not offered here, and the
action-required empty state reads "one-tap approve and chat with the
owning agent". The 7-verb vocabulary remains the Mission Control
system-level vocabulary.

> Source: `components/for-you/FeedCard.tsx:558-570` (`bare` `:561`,
> `enabledVerbs` `:563`, `oneClickVerbs` `:564`),
> `resolveCardTerminalSession`; `Feed.tsx:76-82` (`EMPTY_COPY`);
> `review/chat.ts:21` (`buildChatPreamble`); test
> `test/foryou-bare-approve-chat.test.tsx`.

On mutation success `VerbActions` fires `onOptimisticOutcome`; `Feed`
keeps an optimistic-outcome map keyed by `qitemId` so the
`ActionOutcomePanel` receipt renders before the audit re-fetch. A terminal
qitem with no recorded outcome derives a fallback receipt from its closure
reason. Card footers also carry a "show context" queue-item trigger, a
terminal drill, the evidence reference, and a "review →" link to the
slice's Review tab.

> Source: `Feed.tsx` (optimistic map; optimistic-first lookup);
> `FeedCard.tsx` (`isActionableCard`, `fallbackOutcomeFromQueueItem`,
> `ActionOutcomePanel`, `QueueItemTrigger`, `FeedCardTerminalDrill`).

### 2.5 Card surface (0.3.1 brand layer)

`FeedCard` renders a `bg-surface-low/45 backdrop-blur-[10px]` surface with
a 3-stop ambient box-shadow (no border), four `CornerBracket` marks, a
mono-uppercase kind tag with a tone-coloured icon (a dot only when a kind
has no icon), and `ActorMark` runtime marks. Cards dismiss by keyboard
(Backspace/Delete) or swipe, with an `UndoToast`.

> Source: `components/for-you/FeedCard.tsx` — `CARD_SURFACE_CLASS`
> `:108-109`, `CARD_SHADOW_STYLE`, `KIND_TOKEN`, corner brackets
> `:452-455`, `ActorMark` `:265`; `CornerBracket` from
> `dashboard/vellum/index.ts`.

The 0.3.1 storytelling preview band is **gone**: `Feed.tsx:375-380` records
its removal. The `components/feed/cards/storytelling-cards.tsx` primitives
remain for the `/lab/card-previews` gallery. No UI code calls
`POST /api/missions/:id/complete` any more; the daemon route still exists
(`packages/daemon/src/routes/missions.ts`).

## 3. Project — workspace / mission / slice scope pages (0.3.0 spine)

`/project*` mounts three scope pages on a shared `ScopeShell` +
`TabNav` tabbed pattern. Tab sets:

| Page | Tabs | Default |
|---|---|---|
| `WorkspaceScopePage` | `SHARED_TABS`: Overview, Story, Progress, Artifacts, Proof, Queue, Workflow (`topology`) | `overview` |
| `MissionScopePage` | `MISSION_TABS`: Overview, Steering, Review, Story, Progress, Artifacts, Proof, Queue, Workflow | `steering` |
| `SliceScopePage` | `SLICE_TABS`: Review, Story, Overview, Progress, Artifacts, Proof, Queue, Workflow | `review` |

> Source: `components/project/ScopePages.tsx` — `SharedTab`/`SliceTab`
> `:83-84`, `SHARED_TABS` `:86-94`, `MISSION_TABS` `:98-110`, `SLICE_TABS`
> `:112-123`, `TabNav`, `ScopeShell`; defaults `useState` at `:698`,
> `:798`, `:1226`.

Off the local host, the workspace and mission headers show an `ON <host>`
chip (the slice header does not), the Review tab is local-only, and
file-backed sections explain why local files are not shown.

### 3.1 WorkspaceScopePage (`/project`)

Reads the live workspace name; honest empty state (`NO WORKSPACE
CONNECTED` with an Open-settings action) when unset. Tabs: Overview →
`WorkspacePortfolioPanel`; Story/Progress/Artifacts/Proof/Queue → the
scope rollups (§3.4); Workflow → `HostMultiRigGraph`.
(`WorkspaceOverviewPanel`, the older Current Work / Archive grid, is still
defined but not rendered.)

> Source: `ScopePages.tsx` `WorkspaceScopePage` (no-workspace guard;
> `WorkspacePortfolioPanel` `:745`; `HostMultiRigGraph` `:788`).

### 3.2 MissionScopePage (`/project/mission/$missionId`)

Lands on **Steering** (`SteeringTab`). Review → `MissionReviewTab` (§3.5).
Overview renders the mission README (`MarkdownViewer`) above a slice rail.
Progress renders `MissionProgressHeatmap` plus the mission `PROGRESS.md`
(the per-slice rollup cards were removed). Artifacts → `ArtifactsNavigator`;
Proof → `ScopeProofRollup`. Workflow renders the **projected workflow
spec graph** via `TopologyTab` when the mission README declares a
`workflow_spec` that is in the workflow-spec cache (the daemon returns
`topology.specGraph`), otherwise `ScopeTopologyRollup`.

> Source: `ScopePages.tsx` `MissionScopePage` (`SteeringTab` `:834`,
> `MissionReviewTab` `:843`, `MissionProgressHeatmap` `:906`,
> rollup-cards removal note `:979-983`, `ArtifactsNavigator` `:990`,
> spec-graph branch `:1010-1036`).

### 3.3 SliceScopePage (`/project/slice/$sliceId`)

Lands on **Review** (`SliceReviewTab`, §3.5). Overview →
`SliceOverviewTab` (a 4-metric summary — status, progress, qitems, last
activity — then the README). Story → `ScopeStoryRollup` (the queue-lineage
story graph). Progress → `AcceptanceTab`. Artifacts → `ArtifactsNavigator`;
Proof → `SliceProofTab`; Queue → `SliceQueueTab`; Workflow → `TopologyTab`.
Loading and error states are honest (the error names
`rig config get workspace.slices_root` as the likely misconfiguration).

> Source: `ScopePages.tsx` `SliceScopePage` (`SliceReviewTab` `:1307`,
> `ScopeStoryRollup` `:1317`, `SliceOverviewTab` `:1325`, `AcceptanceTab`
> `:1354`, `ArtifactsNavigator` `:1363`, `SliceProofTab` `:1366`,
> `TopologyTab` `:1379`, slices_root hint `:1276`), `SliceOverviewTab`
> summary grid `:1157-1162`.

### 3.4 Shared scope rollups

`ScopeStoryRollup`, `ScopeProgressRollup`, `ScopeArtifactsRollup`,
`ScopeQueueRollup` and `ScopeTopologyRollup` read from one
`useProjectScopeRollup(missionId, loadDetails)` hook so workspace and
mission scopes share rollup behavior; `ScopeProofRollup`
(`project/ProofTab.tsx`) covers Proof. Detail fetching is gated on the
active tab (`active !== "overview"` for the workspace;
`active !== "overview" && active !== "steering"` for a mission).

> Source: `ScopePages.tsx` `useProjectScopeRollup`, rollup components,
> gates `:700`, `:803`.

### 3.5 Review tabs (the Living Notes surface)

The slice tab (`review/SliceReviewTab.tsx`) renders one reviewable
structure per slice — bands in order **NEEDS YOU → AGENTS → INTENT / PLAN
/ DELIVERED → verify-lineage → SETTLED** — from `GET /api/review/slice/:name`
(`hooks/useReview.ts`), with a proof-readiness status line and a defects
box above NEEDS YOU:

- **DELIVERED** pairs each planned deliverable with its curated proof,
  media inline and expanding one at a time (`?item=` deep link). Without a
  configured readiness policy, `verified` renders as `✓ legacy QA-verified
  (item revision unbound)` · `◇ unverified — no PASSING QA comparison` ·
  `✗ missing — promised, nothing delivered`; with one, as `✓ accepted under
  selected policy` / `◇ current acceptance absent`. A note renders as
  "Judgment note:". Visible, never blocking. "See all proof" drills into
  `proof/`.
- **Media plays**: video inline with native controls (`?seek`/`?play` deep
  links); images open `Lightbox`; evidence and the "full PRD →" door open
  `FileViewer` in the shared right-edge drawer.
- **Two locks** render as stamps: plan-lock in PLAN, both stamps in
  SETTLED; an unaudited stamp renders as UNVERIFIED.
- Review cards share one vellum recipe (`review/vellum.ts`); DELIVERED rows
  stack below the `sm` breakpoint.
- The mission tab (`review/MissionReviewTab.tsx`) is board-first: stage
  cells, the completion ledger, cut-complete, and a row expansion reading
  the same contract. The rig altitude (`review/RigAgentsPage.tsx`, route
  `/agents`) reads `GET /api/review/rig`.

Backend contract: see
[`../architecture/living-notes-review.md`](../architecture/living-notes-review.md).

> Source: `components/review/{SliceReviewTab,MissionReviewTab,
> NeedsYouAccordion,AgentsBandView,VerifyLineageCard,EvidenceOpener,
> RigAgentsPage}.tsx`, `review/vellum.ts`, `hooks/useReview.ts`,
> `SharedDetailDrawer.tsx`; verified labels `SliceReviewTab.tsx:131-135`,
> `:164`, `:194`.

## 4. Dashboard — the launcher (`/` → `Dashboard`)

`Dashboard` is the paper-draft launcher (OPR.0.4.1.14). It renders, in
order: a header with the station online state; `FieldEnvironment` (live
rows: RIGS from `useRigSummary`, AGENTS as the sum of `nodeCount` from
`usePsEntries`, STATION from `window.location.hostname`, OPERATOR ID from
the `agents.operator_session` setting with an `OPERATOR` fallback, and
VERSION from `useDaemonVersion` via `/api/health-summary/version`);
`KernelStatusCard` (from `/api/kernel/status`); `HostConfigCard`; a grid of
six destinations (Topology, Project, For You, Library, Search & Audit,
Settings); and `DashboardFooter`. Its glyphs come from
`dashboard/vellum/fidelity-glyphs.js`.

The vellum barrel `dashboard/vellum/index.ts` still exports
`BackLayerContent` and `BackVellumSheet`; `/lab/vellum-lab`
(`lab/VellumLab.tsx`) imports from it.

> Source: `components/dashboard/Dashboard.tsx` (header comment `:1-24`,
> glyph import, `DESTINATIONS`, data wiring, render order);
> `hooks/useDaemonVersion.ts`; `components/dashboard/vellum/index.ts:5-6`.

## 5. Cross-cutting properties

- **Live daemon state** — every surface reads daemon hooks. UI-local state
  on these surfaces is the two For You dismissal sets (localStorage), the
  lens, host filter and optimistic-outcome map (transient), and each scope
  page's tab state.
- **Honest empty/error states** — `WorkspaceScopePage` no-workspace and
  `SliceScopePage` not-available surface the cause and a remediation
  pointer, never a blank screen.
- **0.3.0 observability spine on the 0.3.1 vellum brand layer** — the
  classifier / verb-action / scope-rollup logic is the 0.3.0 foundation
  (§0); the visual surface is the 0.3.1 brand layer and later refreshes.

## OPEN items (carried, not smoothed)

- **OPEN — `/project` redirect-stub consolidation.** `/progress`,
  `/slices`, `/steering` are `<Navigate to="/project">` stubs and
  `/slices/$name` redirects into `/project/slice/$sliceId` (§1). Whether
  the stubs are permanent or transitional is a product decision not
  resolvable from source.
