---
kind: as-built
title: Living Notes Review Surface — the intent→plan→delivered projection
status: active
topics: [knowledge-and-context, observability, sdlc]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  Working on or consuming the composed slice/mission review surface — the
  /api/review/* routes, the ComposedSliceReview contract, the on-disk SDLC
  convention it projects, staged-approval locks, proof artifacts and the C1
  header, the freeze export, media serving for review evidence, or the
  cross-host FLEET aggregate (/api/review/fleet, the fleet composer's
  union/one-count seam, v0.4.6 MH-5).
siblings: [content-surfaces.md, workspace-primitive.md, mission-control.md]
prerequisite-reads: [workspace-primitive.md]
last-verified-against-source: c8341f72
last-updated: 2026-07-08
---

# Living Notes review surface (v0.4.4)

The review surface is a **pure projection of on-disk markdown into one
reviewable structure per slice**: INTENT → PLAN → DELIVERED. Agents change
files; the daemon re-projects; nothing here writes product state except the
two deliberate approval stamps and the freeze export. Shipped across the
0.4.4 living-notes slices (19 signal layer, 20 composer/surfaces, 22 rig
agents altitude, 23 SDLC operationalization) and the **corrective rebuild**
(2026-07-05/06) that collapsed the surface to the one structure described
here. Everything below is verified at `bb5ad219`.

## 1. The ONE contract — `ComposedSliceReview`

`packages/daemon/src/domain/review/types.ts` defines the read contract every
consumer shares (slice Review tab, mission U5 row expansion, For-You
expansion — never a second endpoint per consumer):

- **identity + phase**: `slice`, `sliceId`, `title`, `missionId`, `phase`
  (five-way, derived read-time: `locked > review > building > spec > intent`,
  `derivePhase` in `compose.ts`), `laneLabel` (SS14 vocabulary INTENT / PLAN /
  BUILD / REVIEW / LOCKED).
- **`intent`**: `{text, media[], ssotPath, degrade}` — the slice README's
  `## Intent` section verbatim (`extractSection`), plus any media it embeds.
- **`plan`**: `{concise: {text, media[]}, lockedArtifacts[], lock, ssotPath}` —
  the PRD's pinned `## Mini-requirements` tier + planned mockups; the pinned
  artifact set is a **frontmatter READ** (`locked-artifacts:` list on the
  slice README — no new write machinery); `lock` is the spec-scope
  staged-approval stamp (§3).
- **`delivered`**: `{items[], extraProof[], lock, proofDirPath}` — the
  redesigned join (§4): each `## Proof contract` deliverable paired with its
  curated proof media and QA's recorded comparison signal. `lock` is the
  delivery-scope stamp; `proofDirPath` is the drill-in door to the full
  fix-loop history.
- **KEPT orthogonal bands**: `needsYou` (two sources, one queue: agent-routed
  items ∪ derived ▲ exceptions with inline evidence), `agents`
  (scope-parameterized `slice:<id> | mission:<id> | rig` — one contract, all
  scopes), `lineage` (`VerifyLineage`: candidate/merge/tip facts + the four
  gate `VerdictCell`s rendering recorded tokens verbatim), `defects`
  (out-of-slice media refs surfaced, never silently dropped), `composedAt`.

**Deleted by the corrective (2026-07-05, founder-blocked original):** the
four parallel renderable structures (`sections`, `acceptance`, `compare`,
`join`) and the coequal `green` field. They do not exist in the types, the
composer output, the UI hook, or the fixtures; the daemon route tests assert
the keys are ABSENT on the wire (`test/review-composer.test.ts`,
`test/review-routes.test.ts`). Recorded-verdict green survives in exactly two
places: the per-deliverable `verified` signal (§4) and the mission ledger's
completion fact (§6) — never a slice-review structure.

## 2. Composer + gatherer split

- `compose.ts` is **PURE**: `(gathered inputs) → composed doc`; identical
  inputs (including caller-supplied `nowIso`/git facts) produce byte-identical
  output — idempotence holds by construction and is pinned by tests.
- `gather.ts` (`ReviewGatherer`) is the impure shell: reads slice docs +
  `proof/*.md` artifacts from disk, attention/agent rows from SQLite,
  approval stamps from frontmatter (cross-checked against the audit log, §3),
  git lineage facts from the workspace default repo. Every unreadable source
  degrades honestly (nulls / "unknown") — the composer renders the named
  degrade, never invented content.

## 3. The two locks = the shipped staged-approval stamps

`plan.lock` and `delivered.lock` are projections of the **staged-approval
verb** (`rig scope slice|mission approve --scope spec|delivery` — see
cli-reference "SDLC control plane verbs"): frontmatter stamps
(`approved-spec-by/-at`, `approved-by/-at`) written daemon-side together with
an append-only `mission_control_actions` audit row (no half-stamp). The
gatherer cross-checks each stamp against the pinned scope-approval
`audit_notes_json` shape (`approval_scope` + scope identity); a stamp with no
matching row projects `auditVerified: false` and renders as an UNVERIFIED
stamp — visible, never a block. Approval is freeze/sign-off, **never**
proven-green (BR-6).

## 4. DELIVERED — promised ↔ curated proof ↔ verified

`composeDelivered` joins the PRD's `## Proof contract` checkbox items
(`extractProofContract`; an optional markdown image on the checkbox line
becomes the deliverable's `plannedRef` mockup) to the C1-headed proof
artifacts in `<slice>/proof/`:

- An artifact **covers** a deliverable when its C1 `evidences:` list names the
  item (exact text or 1-based index).
- `verified` binds to the shipped C1 fields, never mere presence:
  **verified** = a covering `qa|adjudication` artifact records the comparison
  (`self_check`) AND its recorded verdict is passing; **unverified** = some
  covering artifact without a passing recorded QA comparison (QA's
  why-kicked-back `note` still surfaces); **missing** = promised, nothing
  delivered. All three are render states — fail-open by construction.
- The curated proof set is the covering artifacts' body media refs
  (`ProofArtifact.mediaRefs`, populated by `rig proof add --media` or markdown
  refs in the artifact body), normalized slice-relative; refs escaping the
  slice dir become `defects` findings and are never served or inlined.
  Unmapped-artifact media renders bounded as `extraProof`.
- The ▲ insufficient-proof NEEDS-YOU exception fires from the delivered
  MISSING count (`deriveExceptions`).

## 5. Routes, freeze, media serving

- `packages/daemon/src/routes/review.ts`, mounted at `/api/review`
  (`server.ts` route mounts): `GET /slice/:name`, `GET /mission/:name`,
  `GET /rig` (the OPR.0.4.4.22 rig-agents altitude root), `GET
  /agents?scope=slice:<id>|mission:<id>|rig`, `POST /freeze`.
- **Freeze** (`freeze.ts`): the ONE synchronous compose-and-freeze path,
  invoked after the delivery stamp + audit row commit. Renders the composed
  review to a single self-contained HTML file (`REVIEW-<id>-<date>.html` in
  the slice dir): CSS inline, images data-URI-inlined under slice-dir
  containment (resolve-prefix + realpath — a traversal/symlink ref renders
  the muted outside-slice branch, never inlined), video by link + poster.
  Exclusive-create through the allowlist-governed atomic write service;
  re-invocation is an idempotent no-op; a failed render never un-approves.
  The freeze moment also folds the mission brief spine (`brief-spine.ts`)
  into `MISSION_BRIEF.md`, section-scoped, schema-order-preserving.
- **Media serving** for review evidence is ranged on BOTH asset route
  families (iOS-Safari-class players require `206`): `GET /api/files/asset`
  (`routes/files.ts` — single-range parse, `206`/`416`, `Accept-Ranges:
  bytes`; `.html` renders as text/html only under the explicit `?render=1`
  opt-in) and `GET /api/slices/:name/proof-asset/*` (`routes/slices.ts` —
  same range semantics via `fileAssetResponse`, added by the corrective QA
  fixback; immutable-cache posture retained).

## 6. Mission + rig altitudes

`composeMissionReview` consumes `{review, green}` entries per slice: the
board (stage-specific cells re-bound to the collapsed contract — spec-stamp
state, delivered n/m, GREEN·merge pair, stamp), the completion **ledger**
(a query over the slice set, never an authored list; `green` here is the
recorded-verdict fact from `computeRecordedGreen` — regime 1 = four passing
gate verdicts, regime 2 = passing adjudication), `cutComplete` (TRUE only
when every in-cut slice is green AND merged AND has zero open needs-human
items), and the union NEEDS-YOU (distinct identities — one item seen from N
altitudes is one item). `composeRigAgents` serves the standalone rig
altitude (roster ∪ recently-holding, park/health/settled from the queue
transitions log).

## 7. The FLEET altitude — the cross-host aggregate SIBLING (v0.4.6, OPR.0.4.6.MH5)

`GET /api/review/fleet` aggregates every registered host's composed ▲/● set
into one manage-by-exception glance. It is a **sibling aggregate endpoint**,
never a fourth `AgentsScope` value (arch Q2): the scope grammar stays
exactly `slice:* | mission:* | rig`, and the local composer stays a pure
function over local state. `domain/review/fleet-compose.ts` is the ONE
review-domain module allowed to import hosts transport/registry — a
boundary enforced mechanically by the `review-import-audit` static test
(the zero-I/O `fanout-contract` types module is the sole allowlisted
hosts import elsewhere).

**Fan-out-the-composed-set (arch Q1):** the ▲ kinds are time-derived on
their own host's clock, so the fleet root fans out each host's
ALREADY-COMPOSED rig root (`GET /api/review/rig` over `remoteJsonRequest`,
concurrent under the named read-class deadline; the local host joins
in-process via the same gatherer — zero self-transport) and only **unions +
host-dimensions + counts**. It never recomputes exception truth (the
composer is clock-free by test pin), so cross-host clock skew can never
distort a ▲. Per-host failures degrade to the closed `PerHostStatus`
honesty contract; a failed host's counts are ABSENT from its
`FleetHostRollup` — absent-not-zero, in the type.

**One-count across the fleet (arch Q4):** the dedup `Set` lives in the
fleet composer — the one place — keyed `hostId|identity` (rendered verbatim
on the expanded drawer); within-host multi-altitude visibility collapses to
one row with `seenFrom` provenance; an MH-3-forwarded qitem lives only in
its origin host's DB, so no double-count by construction.

**Composition pins the seam (arch Q3, the rule of thumb):** sidedness and
caller pick the TRANSPORT seam (MH-4's CLI-direct verbs); when COMPOSITION
exists — the fleet union/one-count is a correctness rule — the seam pins
daemon-side: ONE composer, one endpoint, every consumer (the `/fleet` route
page and the FLEET band today via the shared `useFleet` hook; the TUI/CLI
fleet consumers as named follow-ups) reads the same one. UI cadence is the
bounded named `FLEET_POLL_INTERVAL_MS` with the feed-cadence-class floor,
and the ambient band gates its FETCH on fleet existence (the FS-1 amplifier
discipline; enable-at-scale remains the FS-1 release-validation gate). Read
+ surface only: acting on a remote host's item rides MH-3/MH-4.

## 8. The on-disk convention it projects (SDLC control plane)

The surface projects the markdown-control-plane shapes operationalized by
OPR.0.4.4.23 — conventions SSOT `docs/reference/sdlc-conventions.md`:
`## Intent` (README) / `## Mini-requirements` + `## Proof contract` (PRD) /
`proof/` C1-headed artifacts + `PROOF.md`, scaffolded for every template kind
by `rig scope slice create` and checked advisory-only by `rig scope audit`
(+ the `rig doctor` SDLC row). The UI half of this surface (the slice Review
tab, mission board, For-You approve+chat) is documented in
[`../ui/project-and-for-you.md`](../ui/project-and-for-you.md).
