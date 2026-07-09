---
kind: as-built
title: Workflow Runtime + Watchdog Policies (PL-004 Phase C/D)
status: active
topics: [coordination, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the daemon-native Workflow Runtime works — workflow specs
  cache, instance state, step trails, the transactional-scribe projection
  contract, or the watchdog policy set including workflow-keepalive.
siblings: [coordination-primitive.md, mission-control.md]
prerequisite-reads: [../README.md, coordination-primitive.md]
last-verified-against-source: slice/opr-0.4.6.wf2-spec-language tip (base d18907ed — WF-1 merged)
last-updated: 2026-07-06
---

# Workflow Runtime + Watchdog Policies (PL-004 Phase C/D)

The daemon-native Workflow Runtime (PL-004 Phase D) turns an intended
sequence of work into durable SQLite state: declarative workflow specs, live
instance state, append-only step trails, and the load-bearing
transactional-scribe contract. The PRD §L4 operating model is
owner-as-author semantically plus workflow-as-transactional-scribe
mechanically (`architecture.md` §3 L398).

> Verified against source at HEAD `7eaf524c`.

## 1. The three Phase D tables (+ the diagnostic addition)

Re-confirmed at HEAD in `packages/daemon/src/db/migrations/`:

- **`workflow_specs`** (`033_workflow_specs.ts:33` `CREATE TABLE … workflow_specs`)
  — a read-through cache of human-authored markdown/YAML spec files. Sources
  are workspace-surface; the daemon caches by `(name, version)` with a
  content `source_hash` so valid operator edits to the spec file win at next
  read (workspace-surface reconciliation). Spec authoring stays
  markdown-authoritative; the cache exists for fast lookup and runtime
  resolution (`architecture.md` §3 L400).
- **`workflow_instances`** (`034_workflow_instances.ts:45` `CREATE TABLE …
  workflow_instances`) — live state per running workflow: `status`
  (`active|waiting|completed|failed`), `current_frontier_json` (active qitem
  ids), `hop_count` (loop-guard counter), `last_continuation_decision_json`.
  Instances survive daemon restart from SQLite — no filesystem
  reconciliation (`architecture.md` §3 L402).
- **`workflow_step_trails`** (`035_workflow_step_trails.ts:32` `CREATE TABLE …
  workflow_step_trails`) — append-only history of meaningful step
  transitions. Every closure produces one trail row pairing the prior qitem
  with the next qitem (null on terminal). `WorkflowStepTrailLog.record()` is
  the only writer (`architecture.md` §3 L404).
- **`040_workflow_specs_diagnostic.ts`** — slice-11 (`f68f453a`,
  slice-00 §1.3 provenance). An `ALTER TABLE ADD COLUMN` adding
  parser/validator diagnostic columns to `workflow_specs` (**no new table,
  no constraint changes beyond a DEFAULT**; the cache carries the
  parse/validation diagnostic for the UI to render — `040_..._diagnostic.ts:5–25`).
  **This migration is net-new since `architecture.md` was last edited** and
  is not described in any prior as-built doc (slice-00 §1.3 — `f68f453a`
  postdates the §3 body) — authored here from source per the slice-08
  drift-to-fix register.

`036_watchdog_policy_enum_extension.ts` is a documenting no-op that records
the Phase D watchdog enum extension (Phase C uses application-layer
enforcement via the `PHASE_D_POLICIES` array, so no DDL is needed —
`architecture.md` §3 L363).

## 2. The transactional-scribe contract

The load-bearing Phase D guarantee is implemented in
`WorkflowProjector.project()` (`packages/daemon/src/domain/workflow-projector.ts`).
Re-confirmed at HEAD: the projector header (`workflow-projector.ts:1–20`)
declares "transactional-scribe contract" and `project()` runs a single
`db.transaction` (`workflow-projector.ts:184` `const txn = this.db.transaction(...)`).
Inside that one transaction:

1. Close the current packet (state mutation on `queue_items`).
2. Create the next-step packet (`QueueRepository.createWithinTransaction()`,
   `workflow-projector.ts:230`).
3. Record the trail entry.
4. Update the instance frontier + status.
5. Persist workflow events.

Either everything commits or everything rolls back; lost handoffs are
impossible by design. Post-commit, subscribers are notified and the next
owner is nudged (`architecture.md` §3 L406).

`WorkflowRuntime` (`packages/daemon/src/domain/workflow-runtime.ts:61`
`export class WorkflowRuntime`) is the orchestration class above the
projector.

**Phase D scope boundary** (`architecture.md` §3 L412): excludes multi-hop
chaining, gate-return-sweep, and the closure-enforcement path. The daemon's
transactional state remains the closure authority via Phase A's hot-potato
strict-rejection (see `coordination-primitive.md` §3); the workflow runtime
**projects on closure, it does not gate closure**.

## 3. The workflow-keepalive watchdog policy

`workflow-keepalive` is the Phase C-deferred watchdog policy, a TypeScript
port of the POC `lib/policies/workflow-keepalive.mjs` adapted to read SQLite
(`packages/daemon/src/domain/policies/workflow-keepalive.ts:1–5`).
Re-confirmed at HEAD (`workflow-keepalive.ts:5–16`):

- **LOAD-BEARING:** it MUST read `workflow_instances` directly via SQLite —
  never the markdown source.
- Eligibility: `status === "active" || status === "waiting"`. Else
  `action=terminal, reason="workflow_not_active"`.
- Frontier empty + no fallback target: skip with `reason="empty_frontier"`.
- Resolves frontier qitem owners by querying `queue_items`; combines with
  explicit observer/created-by targets; sends to the first resolved target.

The watchdog supervision tree itself (PL-004 Phase C, `031_watchdog_jobs.ts` /
`032_watchdog_history.ts`) records only meaningful evaluations; quiet skip
reasons (`not_due`, `no_actionable_artifacts`, `active_wake_not_due`) are
NOT recorded and do NOT emit `watchdog.*` events — POC parity so agents are
not woken about scheduler polls (`architecture.md` §3 L362). The Phase D
policy enum extends Phase C's three values with `workflow-keepalive`.

## 4. Workflow events

> Drift-fix D8 / OPEN-4 (carried verbatim, slice-00): `architecture.md` §3
> L410 says "Existing 20 PL-004 events are unchanged" — internally
> inconsistent with L394's "32 PL-004 events untouched". **Do NOT carry
> either number.** The current `RigEvent` union
> (`packages/daemon/src/domain/types.ts:94`) has **73 members** total
> (slice-00 §1.8, re-confirmed at HEAD). The additive Phase D `workflow.*`
> events are described below WITHOUT asserting a contested PL-004 sub-count.

Phase D extends `RigEvent` with the additive `workflow.*` events
(re-confirmed `domain/types.ts:196–201`): `workflow.instantiated`,
`workflow.step_closed`, `workflow.next_qitem_projected`,
`workflow.completed`, `workflow.failed`, `workflow.routing_table_changed`
(6 members; a separate `workflow_spec` event also exists in the union).

## 5. Route surface

`/api/workflow` (`server.ts:495`) — `POST /validate`
(`routes/workflow.ts:82`), `POST /instantiate` (`:93`,
`getRuntime(c).instantiate(...)`), `POST /project` (`:118`,
`getRuntime(c).project(...)` — the transactional-scribe entry),
`GET /:instance_id/trace` (instance + trail), `POST /:instance_id/continue`
(idempotent inspect). Surface enumerated `routes/workflow.ts:21–28`.
Cross-ref: the `rig workflow` CLI surface — see `../cli-reference.md`.

## 6. The WF-1 failure envelope (OPR.0.4.6.WF1)

Added on top of the kept Phase D core (nothing above was re-specced;
FR-1 regression tests pin it):

- **Step deadlines (FR-2, derived — never stored):**
  `workflow-deadline.ts` classifies every active|waiting instance's
  frontier packet by anchor — claimed w/ `closure_required_at` ·
  claimed w/ NULL deadline (`claimed_at` + threshold; workflow packets
  ship tier `mode2`, which has no SLA entry) · never-claimed
  (`created_at` + threshold) · unclaimed-after-claim (`created_at`;
  unclaim NULLs `claimed_at`). `WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS`
  (4h, = the routine-tier SLA) is THE single threshold home; WF-5
  binds to it. Stuck self-clears on normal re-projection.
- **Keepalive auto-arm (FR-3):** instantiate + every handoff ensure
  ONE per-instance `workflow-keepalive` watchdog job INSIDE the scribe
  transaction; terminal exits disarm it. Auto-armed jobs carry
  `context.deadline_gated: true` — quiet while healthy, and their
  overdue send targets the stuck packet's owner with re-project
  steering. Operator-registered jobs keep exact POC always-send parity.
- **Boot sweep (FR-4):** `workflow-boot-sweep.ts` at daemon startup —
  re-arms missing keepalives, reissues LOST post-commit nudges
  (pending frontier packet with `last_nudge_attempt` NULL = the
  commit-then-crash window, detected from the nudge ledger), surfaces
  stuck instances; one summary log line.
- **Real idempotency (FR-5):** waiting-replay ABSORPTION under the
  full closure-intent identity (exit/packet/step/actor/resultNote/
  effective-blocker/evidence deep-equal) — exact replay = zero writes;
  any mismatch = a new decision via the normal path. Migration 049
  adds `workflow_instances.version`: every guarded advance bumps it
  `WHERE version = ?`; a stale writer gets structured
  `instance_version_conflict` and its whole transaction rolls back.
- **max_hops enforced (FR-6):** compared at projection via
  `exceedsMaxHops(hopCount, baseline, maxHops)` (v1 baseline = 0; the
  baseline is WF-5's resume seam). Exceeding converts the handoff to
  an honest structured failure (packet closed, instance failed, guard
  evidence in trail + `workflow.failed`). Migration 050 adds
  `workflow_specs.spec_json` — before it, `loop_guards`/`invariants`/
  `closure`/`entry` were silently DROPPED at projection-time
  rehydration (column-only rebuild); legacy rows self-heal on
  readThrough and degrade VISIBLY (named once-per-spec advisory).
- **Validation (FR-7):** `parseWorkflowSpec` rejects unknown keys loud
  at every level against EXPORTED closed keysets (WF-2 extends them);
  the validator walks reachability/cycles over the projector's own
  exported `resolveNextStep` — unreachable steps fail; a cycle without
  `max_hops` fails naming the fix; with it, sanctioned.
- **`continue` honesty (FR-8):** relabeled to its real read-only
  inspector semantics everywhere (CLI description/outcome, route
  comment); `project` remains the sole advance write path.
- **The v2 dispositions (FR-9):** every declared-but-unenforced key —
  `invariants.{continuation_required,preserve_lineage,closure_required}`,
  `closure.*`, step `gates[]`, role `skill_refs`, `next_hop.mode:
  prefer`, `loop_guards.spawn_budget` — produces the fail-open
  `declared_not_enforced_v1` validator advisory (warning; never
  blocks). `spawn_budget`'s advisory names its WF-2/WF-6
  parallel-frontier acceptance pointer (arch ruling 2026-07-06).
  `fallbackSynthesis` (instance column, never written) is dispositioned
  in the `workflow-types.ts` JSDoc.

## 7. The WF-2 spec language (OPR.0.4.6.WF2)

WF-2 grows the language the ratified WF-1 engine speaks. ONE named
engine extension (branch execution); everything else is language +
compilation onto shipped seams.

**Conditional-on-outcome branching (FR-1).** A step may declare
`next_hop.on: {<exit>: <step-id>}` — branch keys are the recorded exit
enum ONLY (`handoff|waiting|done|failed`; closed set, enforced at
parse — `spec_branch_key_invalid`). A MAPPED exit routes to its target
INSIDE the same scribe transaction: next qitem created in-txn, instance
stays ACTIVE bound to the target, hop count + version guard bumped
identically to a linear advance, and the taken branch recorded
ADDITIVELY (`lastContinuationDecision.branchTaken` + the trail row's
`closure_evidence.branch_taken`) — never in `closure_reason` (closed
Phase-A enum). An UNMAPPED `failed`/`done` stays terminal exactly as
before; unmapped `waiting` stays a park. The `max_hops` guard fires on
ANY route (branch routes create the canonical remediation cycles);
cycle detection at validation runs over the structural ∪ branch edge
union and requires a declared `max_hops` to sanction any cycle.
Routing seam: `resolveNextStep(spec, step, recordedExit?)` — one
exported function, structural default when no exit supplied (the
validator's path).

**Per-step `harness:` pin (FR-2).** `claude-code | codex` (agent
harnesses only — `terminal` rejected at parse with a teaching error; Pi
joins in 0.4.7). Owner resolution picks the first `preferred_target`
whose node `runtime` column matches (`nodeRuntimeOf`: latest session →
node join); no match = structured `harness_pin_unsatisfied` naming the
pin + every candidate's runtime. Explicit owner overrides are
reconciled too — an override can never silently defeat a pin. Static
check at instantiate for every pinned step; re-checked at each route.

**Per-step `host:` pin (FR-3).** `local`/absent = full execution today.
A registry id validates against `~/.openrig/hosts.yaml` (daemon
read-only twin; unknown id = `host_not_registered` naming registered
ids) but a remote pin fails loud at INSTANTIATE with
`host_pin_remote_unsupported` naming the MH-3 boundary + workaround —
the queue is local-only until MH-3; no qitem is ever minted into a
queue that cannot route it, and there is no silent local fallback.

**Structured step-level `gate:` (FR-5 — the socket; WF-5 owns
semantics).** Singular per step, closed keyset `{target, summary,
evidence_ref}`. HUMAN target (the shipped human-seat predicate) →
compiles to a human-routed item (tier `human-gate` + summary +
evidence_ref — the shipped 0.4.4 write path), resolved by the shipped
`resolve` verb; HANDLER-ROLE target → an ordinary agent item to the
role's resolved seat. Routing INTO a gated step creates the gate item
as the frontier packet and parks the instance `waiting`; resolve/close
continues the flow from that step (the WF-1 unpark — no restart). A
gated ENTRY step parks from birth.

**Dispositions (FR-4) — the inert third state is dead.** The legacy
step `gates: [...]` string list is REMOVED at parse
(`spec_gates_removed`, what/why/fix naming the new `gate:` object);
`next_hop.mode: prefer` is REMOVED at parse
(`spec_prefer_mode_removed` — it never had distinct behavior).
`skill_refs` / `closure.*` / `invariants.{continuation_required,
preserve_lineage,closure_required}` keep their WF-1 FR-9 explicitly-v2
advisories; `spawn_budget` stays explicitly-v2 (WF-6/parallel-frontier
acceptance pointer). Every key is consumed, removed, or
machine-readably advisory — zero silently-inert keys.

**Versioning honesty (FR-6).** New strictness lands at
`parseWorkflowSpec` (the only seam that sees raw keys; the WF-1
exported closed keysets extended with `harness`/`host`/`gate` +
`next_hop.on`) and applies at validate/instantiate/re-parse. A LIVE
instance pinned to a pre-WF-2 spec version keeps executing un-failed
(project() has no validation gate, by design; stored `spec_json` blobs
missing the new optional fields read fine); the same spec FILE
re-validated fails under the new rules.

**Hand-authorability (FR-6).** Three shipped example shapes at
`packages/daemon/src/builtins/workflow-specs/`: `linear-build.yaml`
(zero WF-2 features — the zero-regression reference),
`gated-release.yaml` (human gate + harness pins),
`branched-remediation.yaml` (bounded failed-path remediation loop).

**The composed RSI example (OPR.0.4.6.FAC2).** `factory-rsi.yaml` is the
single-rig recursive-self-improvement factory MVP: it composes the branch +
gate + guard primitives into the inner loop — `plan → implement → qa_check →
review → release_prep` — where `qa_check`/`review` branch `failed` back to
`implement` (bounded remediation) and `release_prep` (the release-manager
prepares artifacts, un-gated) hands off to a human-gated `release_signoff`.
Dogfood is decoupled from this gated loop: the dogfood seat runs out-of-band
against the shipped product and feeds its findings into the next plan (the RSI
edge, ungated). The remediation loops are sanctioned only by the enforceable
`loop_guards.max_hops`; a trip is a WF-5 exception (orchestrator-first via
`exception_routing`). It targets the shipped `factory-rsi` launch starter
(`specs/rigs/launch/factory-rsi/`) whose seats pin 1:1 to its roles via
`preferred_targets` — the v0 hardcode seam, no binding layer.

## The CLI surface (OPR.0.4.6.WF3)

WF-3 made the CLI the primary human/agent driving surface. Render-side
by rule (BR-2): `run`/`watch` consume the shipped SSE endpoints
(snapshot-first-then-stream, priorQitemId dedup, reconnect → announced
poll fallback, outcome-as-exit-code: 0 completed / 3 failed);
`trace`/`list`/`show` human modes are formatted (argo-shape tree, ps-
mechanics columns, ATTN markers) while `--json` stays byte-stable;
`status` composes the needs-attention rollup CLI-SIDE from the
API-carried `instance.deadline` classification (one threshold home —
the CLI never recomputes a class). The two daemon additions:

- **`route`** (`POST /api/workflow/:id/route`, runtime `route()`):
  close+recreate+rebind in ONE scribe transaction — honest
  `handed_off_to` closure with provenance, successor recreate (same
  step; `current_step_id` unchanged; no hop bump — route is not an
  advance), frontier rebind under the version guard, keepalive
  re-target in-txn. Advance-authority revocation is STRUCTURAL: the
  old packet leaves the frontier in the transaction, so a zombie
  owner's stale `project` hits the shipped `packet_not_on_frontier`
  409.
- **The frontier close-path guard** (`workflow-frontier-guard.ts` →
  INJECTED into `QueueRepository` at startup; the queue never imports
  the workflow domain): terminal closure of a live frontier packet
  from non-workflow verbs rejects `workflow_frontier_packet` with a
  what/why/fix naming `rig workflow project` / `route`. Workflow
  writers pass `viaWorkflowVerb`; non-workflow qitems see zero new
  behavior.

## The exception + human-gate model (OPR.0.4.6.WF5)

The deterministic engine's exception layer: the happy path stays
orchestrator-free and PROVEN so; every exception becomes exactly one
durable attention item the moment it exists; the responder resolves it
and the flow resumes from where it stopped.

- **The taxonomy** (`workflow-exception.ts`): three closed classes as
  pure predicates over recorded state — `unmapped_failed` (recorded
  `status=failed`; a WF-2-mapped `failed` routes to remediation and is
  NOT an exception), `stuck_overdue` (the WF-1 deadline evaluator's
  verdict consumed verbatim — the single threshold home), and
  `human_gate_trip` (WF-2 HUMAN gates; the compiled park IS the item).
  Handler-role gate-trips are deterministic handoffs, not exceptions —
  classes (a)/(b) backstop the handler's own step. The occurrence key
  is the recorded packet id of the episode: re-detections dedupe,
  resolve+resume closes, a fresh packet is a NEW occurrence.
- **The maturity dial** (`workflow-exception-router.ts` + the
  `exception_routing` spec grammar + the `workflow.exception_routing`
  settings key): target resolution = spec per-class → spec default →
  host dynamic key → ORCHESTRATOR-FIRST (the declared orchestrator
  role via the same `preferred_targets` pick step owners use) →
  `human@host` never-lost fallback. THE TIER SPLIT: `human-gate` rides
  ONLY human-routed positions — an orchestrator-routed item carries
  the ordinary tier so the shipped attention union (which matches on
  tier regardless of destination) never leaks it into NEEDS-YOU. The
  shipped attention predicate is untouched.
- **Class (a) born-in-txn**: the projector's failed-terminal branch
  creates the item INSIDE the failing transaction — no window where
  the instance is failed and no item exists; a gate-rejected routed
  destination re-creates on `human@host` (never lost, never fails the
  close). **Class (b) at detection**: the boot sweep and the keepalive
  evaluation call the injected ensurer (`workflow-exception-
  escalation.ts`) — occurrence-deduped against OPEN items by tag
  query; the crash-surviving sweep re-creates a missed item.
- **`resume`** (`POST /api/workflow/:id/resume`, runtime `resume()`,
  `rig workflow resume`): redrive semantics in ONE scribe transaction —
  failed→active REBOUND to the recorded failed step; the owner is
  RE-RESOLVED through the projection resolver (never copied from the
  stale destination — resume is the one sanctioned re-resolution
  point); `--decision` lands durably in the redrive packet; the
  occurrence's open items close with provenance; the trail is
  preserved, never rewritten. THE LIVELOCK RAIL (migration 051):
  `hops_baseline` re-anchors the max_hops guard at resume so each
  redrive gets exactly one bounded window; `resume_count` is the
  recorded redrive fact; re-exceeding raises an honest NEW occurrence.
- **The workflow-aware ▲ band** (`review/compose.ts
  deriveWorkflowExceptions` + the gatherer source): the missing-item
  backstop row, the stuck row with evaluator evidence, the
  frontier-non-open ANOMALY row (detection behind WF-3 FR-6's
  prevention), and THE AWARENESS ROW — an orchestrator-routed
  exception renders holder + age in the human band (one identity, two
  projections, count = 1); human-routed items render nothing there
  (the ● item is the row). Recomposition clears on state-exit.

## The workflow ↔ rig binding layer (OPR.0.4.6.FAC1)

Run any workflow on any rig that can support it, without editing the
spec — the self-driving factory's binding substrate. Three seams:

- **A1 — bind at instantiation** (migration 052,
  `workflow_instances.bound_rig`): the effective binding =
  `--rig`/`targetRig` override `?? spec.target.rig ?? null`; the spec
  field stays a DEFAULT (no routing path reads it — display only). The
  rig NAME persists (the durable operator-space coordinate); name→id
  re-resolves fresh at each resolution site — a vanished rig fails loud
  (`bound_rig_not_found`), never silently. NULL = unbound =
  byte-identical pre-FAC-1 behavior. **Unknown-rig validation SPLITS by
  PROVENANCE** (arch ruling 2026-07-07, target-rig zero-regression):
  an explicit operator `--rig`/`targetRig` is AUTHORITATIVE — unknown →
  `bound_rig_unknown` HARD-FAIL before any mutation; a spec-default
  `target.rig` is ADVISORY (authored under the pre-FAC-1 regime where the
  field was ignored at runtime) — unknown → DEGRADE to unbound + a LOUD
  `advisories` notice on the instantiate result (surfaced by route + CLI
  stderr), never a hard-fail. This preserves AC-1 zero-regression for
  shipped/example specs that declare a descriptive `target.rig` AND route
  via `preferred_targets` (e.g. `conveyor`): they instantiate exactly as
  pre-FAC-1. A spec that genuinely needs a bound rig still fails loudly,
  per-step (entry at instantiate, later role-only steps at projection) —
  the degrade is to honest per-step failure with a heads-up, never to
  silence.
- **A2 — role→seat capability resolution**
  (`workflow-role-resolver.ts` pure policy +
  `workflow-role-context.ts` lazy sync snapshot): TIER 3 inside
  `resolveDefaultOwner`, activating ONLY when a role declares zero
  `preferred_targets` AND the instance is bound. Tier order is sacred:
  explicit owner → gate compile → declared `preferred_targets`
  (byte-identical, never inventory-filtered) → capability → loud null.
  The CLOSED fact set: role (`nodes.role`, declared per pod member —
  seat-side, opt-in) · nodeKind · lifecycleState (`running` only) ·
  runtime (harness-pin aware) · sync `pendingWorkCount` (pending-only
  backlog) · the derived canonical coordinate. Async
  `attachAgentActivity`/tmux probes are structurally absent from the
  transaction. Managed seats only: adopted seats are excluded LOUDLY
  (`adopted_seat_not_role_resolvable_v1`). Selection = least backlog,
  plain-codepoint coordinate tiebreak (`driver10@rig < driver2@rig`).
  Resolution runs ONCE at step-close (after the frontier + absorption
  guards — replays perform zero inventory reads) and records as the
  packet destination; the WF-5 resume is the one re-resolution point,
  now capability-aware. All SIX owner-resolution sites carry the
  context: projector next-step, human-gate parked-packet owner,
  handler-role gate destination (no-targets + bound → capability),
  runtime entry (live + recorded), the eager instantiate loop
  (STRUCTURAL zero-role-coverage check only — `bound_rig_role_uncovered`;
  no live resolution of future steps; a warming rig instantiates), and
  resume. The WF-5 exception dial's orchestrator-role position resolves
  capability-aware on the bound rig at both homes (in-txn class-(a) +
  detection-time class-(b)), non-throwing with the human@host
  never-lost fallback. Failures are loud-with-candidates: structured
  per-candidate disqualifiers + a named zero-candidate message; never a
  spawn, never auto-`add_member`, never a dead-seat route. Additive
  `owner_resolution` trail evidence records `{mode, role, boundRig?,
  seat}` per routing decision.
- **A3 — roles bind to SEATS, never occupants**: the ONE string rule —
  the derived canonical coordinate `{pod}-{member}@{rig}` is both the
  tiebreak key and the recorded destination, so an agent handover
  behind the seat never strands the workflow (raw occupant-era session
  names are never recorded as role-resolution destinations).

## The member-exists instantiate advisory (OPR.0.4.6.FAC3 — engine bit)

The queue transport validates the RIG of a destination, never the member
(`topologyValidateRig` is rig-exists-only by design — hardening it would
gate every queue write and break legitimate non-managed destinations),
so a declared `preferred_target` naming a registered rig but a typo'd or
stale MEMBER would mint an orphan packet, visible only later as a WF-5
stuck exception. FAC-3 catches it at the earliest knowable moment: at
instantiate, for every step-referenced role (each step's `actor_role`
plus a handler gate's target role — the same reference set the
structural coverage check walks), each declared `preferred_target` that
parses CANONICAL and names a rig registered on this daemon is probed
for member existence (`rigMemberExists` beside `rigDeclaresRole` —
sync SQL, the derived canonical coordinate per the FAC-1 Q5 one-string
rule, existence at ANY lifecycle state and node kind; liveness stays
projection's business). An unknown member yields ONE aggregated
advisory per unique target — naming every declaring step/role pair, the
consequence (the work will not be claimed; it will surface as a stuck
exception), and the fix hint — pushed into the shipped
`InstantiateResult.advisories` list (the FAC-1 `target.rig`-degrade
surface: one list, now two producers; rendered by the route body + CLI
stderr, zero new surface). ADVISORY-NEVER-DENY: instantiate always
proceeds. Skips (in order): human-seat refs (classified BEFORE parse,
the queue-gate archetype), non-canonical raw/adopted destinations (the
inventory cannot vouch for them), unregistered rigs (the transport
already rejects those loudly at queue-write — no double advisory).

## See also

- `coordination-primitive.md` — PL-004 Phase A; the closure authority the
  runtime projects against.
- `mission-control.md` — PL-005 queue observability + 7-verb contract.
- Source roots: `packages/daemon/src/domain/{workflow-projector,
  workflow-runtime,workflow-instance-store,workflow-spec-cache,
  workflow-step-trail-log,workflow-validator}.ts`,
  `packages/daemon/src/domain/policies/workflow-keepalive.ts`,
  `packages/daemon/src/domain/{workflow-exception,workflow-exception-router,
  workflow-exception-escalation}.ts`, `packages/daemon/src/routes/workflow.ts`.
