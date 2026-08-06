# 51-03 → real 51-02 runner: format-conformance adaptation guide

My 51-03 v1 was authored to the arch-shape SKETCH (fc30a736). The 51-02 runner is now
built + CLEARED (verdict 57d5aa7d, commit 20e1b39c on hv/51-02-runner) at locked spec
28dc80cf/4180a007. Grounding on dev-driver's authoritative example scenarios
(`scenario-02-baton.yaml`, `scenario-10-one-view-state.yaml`, `topo-stub-baton.yaml`),
the real runner's format differs from my sketch-authored set in these ways. This guide
drives the conformance pass over all 11 scenarios + fixtures.

## The deltas (real runner form)
1. **Topology path** — `topology: ./<rig>.yaml` (sibling `./` relative), not `fixtures/<rig>.yaml`.
2. **Queue setup = `env.queue` PRECONDITION, not a `send` action.** There is NO queue
   action verb (verb set is topology/seat lifecycle + `daemon:{op}`). A claimed baton is
   established up front via:
   ```yaml
   env:
     queue:
       - id: baton-1
         source: harness@<rig>
         destination: <pod>-<member>@<rig>
         summary: "..."
         claim: true
   ```
   The pipeline runs the shipped `rig queue create`/`claim` writes BEFORE the steps.
   → My #2 (used `send`) and #11 (used `send`) must move baton creation to `env.queue`.
3. **`expect queue` is a LIST** keyed on the real shipped fields: `qitemId`, `state`,
   `destinationSession` (NOT my `{items:[{destination,state,owner}]}`).
   ```yaml
   - expect:
       surface: queue
       within: 20s
       match:
         - qitemId: baton-1
           state: in-progress
           destinationSession: <pod>-<member>@<rig>
   ```
4. **`equals` = a LIST under a nominal `surface` anchor.** The schema requires a valid
   `surface` on every expect, so #10 anchors with `surface: ps` and lists compared
   surfaces: `equals: [tui_socket, ps, queue]` (NOT my `equals: {surfaces:[...]}`).
5. **#2 "restart" = `daemon: {op: restart}`** (ratified), NOT a seat `restart:` — no
   snapshot-free per-seat relaunch verb exists (F2). The `expect pane "restored"` leg is
   an items-6-8 DEFERRED assertion, VISIBLY annotated (comment), never silently dropped.
6. **Topology fixture form**: `version: "0.2"`, `name:`, `culture_file: culture.md`,
   `pods:[{id,label,members:[{id,agent_ref,profile,runtime:stub,cwd: .}],edges:[]}]`; no
   top-level `edges`. Canonical seat session = `<pod>-<member>@<name>`. Needs `agents/`
   + `culture.md` sibling fixtures (dev-driver's examples ship them).
7. **`any_of` (R-15, my #5) is NOT a verb** → would fail `UNKNOWN_STEP_VERB`. #5 needs a
   decision: split into two scenarios (breaks the "eleven" count → PM scope call) OR route
   `any_of` as a 51-02 v2 format addition. FLAGGED to PM/51-02 — not shimmed, not
   silently split.
8. **`select` on `expect` (R-16, my #9) is silently ignored** (not a schema key). #9's
   `-A`/`--rig` legs need a ps scope selector the runner honors. The CORE leak-catch
   (default ps = current-rig only, beta absent) IS expressible now; the -A/--rig
   confirmatory legs route to 51-02 (R-16). Adapt #9 to the default-scope core + flag the
   selector legs.
9. **`seed_regression` stays on every 51-03 scenario** (mini-req 3) — dev-driver's 51-02
   evidence scenarios omit it (they're not seed scenarios); mine keep it.

## Conformance pass status
- **ADAPTED to real form this increment:** #2 queue-baton-survives-restart, #10
  one-view-state-after-mutation-storm.
- **PENDING conformance pass (next increment):** #1, #3, #4, #7 (topology `./` + field
  names), #9 (select rework + flag), #11 (env.queue + daemon verb + RED-first), fixtures
  (culture_file/cwd/agents), #5 (any_of PM decision), emit #6/#8 (also gate on items 6-8).

## Real-validator conformance report (my 11 through 51-02 `validateScenario`, topologyKind:stub)
Ran 2026-08-06 against the CLEARED runner's real validator:
- **10/11 PASS the schema** — incl. the adapted #2 and #10 (validator-confirmed conformant).
- **1 HARD FAIL: home-divergence-preseed-visible → `UNKNOWN_STEP_VERB@steps[1].any_of`** (R-15).
  `#5` is the ONE scenario blocked on a format/scope DECISION (add `any_of` to 51-02 v2, OR a
  PM ruling to split the "eleven" into two single-outcome scenarios). NOT shimmed, NOT
  silently split — RAISED to orch/PM + dev-driver (format-tweak question).
- CAVEAT: the validator checks STRUCTURE only (surface valid / one match mode / verb valid /
  within), NOT `match:` field CONTENT. So the sketch-authored #1/#3/#4/#7/#8/#9/#11 schema-PASS
  but still need the runtime-shape pass (real field names: queue→qitemId/state/destinationSession;
  ps shape; env.queue for #11's baton; #9 `select` is ignored-not-rejected = the R-16 runtime gap).
  Schema-pass ≠ runtime-correct. That pass is the next increment.

## dev-driver's source-grounded answers to #9 / #5 (2026-08-06) — for the runtime pass
- **#9 (R-16 ps scope selector):** `rig ps` DOES support scope — per-rig `ps --nodes --rig <name>`,
  all-rigs `ps --nodes -A` (FR-3: `-A` is the `--nodes` fleet-widener). The reader CAN map an
  optional scope selector to these. BUT the daemon may SILENTLY IGNORE the selector in its
  projection → asserting the scoped legs risks a FALSE GREEN (selector dropped). **RESOLUTION
  (dev-driver v1 rec, adopt):** #9 asserts the current-rig-DEFAULT leg LIVE (honest, shipped); the
  all-rigs/per-rig legs become VISIBLY-ANNOTATED R-16 deferrals (same discipline as #2 pane-restored),
  lighting up when R-16 honors the selector end-to-end. Also: #9's leak-catch core needs multi-rig
  `up` (R-12) — still open; note it as the core dep. No scope param added until R-16 is honored.
- **#5 (any_of):** NOT in the locked grammar (match/contains/equals are single-outcome) → a real
  FORMAT AMENDMENT, and in tension with FLAG-3 determinism (a disjunctive verdict accepts a race).
  ROUTED TO PM via orch. Three options: (a) pin #5 to ONE deterministic outcome if the SUT is
  drivable (dev-driver + my preference); (b) amend format to add any_of (dev-driver implements on a
  PM ruling); (c) split the eleven (PM reserved scope call). #5 HELD as authored (any_of) pending
  the ruling; NOT shimmed.

## UPDATE 2026-08-06 — #5/#9 rulings applied → 11/11 schema-PASS
- #5 RE-SCOPED per the era-split ruling (GAP-7 folded d0668d5f in main): GREEN leg pins
  preseed-reaches (deterministic at fixed tip); seed_regression{gap7-home-divergence} leg pins
  failure-visible-on-stream. NO any_of (validator refusal correct). 
- #9 adapted to endorsed v1: current-rig-default leg LIVE; -A/--rig scoped legs VISIBLY-DEFERRED
  (R-16, false-green risk if selector silently dropped); R-12 multi-rig-up noted as core dep.
- **All 11 now PASS the real 51-02 validateScenario (11/11).**
- REMAINING (next increment, needs verify-at-source of real --json shapes): runtime field-name pass
  for the sketch scenarios #1/#3/#4/#7/#8/#11 (queue→qitemId/state/destinationSession, ps shape,
  env.queue for #11 baton, stream/policy_provenance shapes) + fixture-form pass (culture_file/cwd:./
  agents). #6/#8 also gate on 51-01 items 6-8 (emit). #11 GREEN gate = 51-06 (R-20).

## INCREMENT 3 (2026-08-06) — #6/#8 emit scenarios composed (items 6-8 folded, main 9cf78106)
- #6 compaction-restore-resumes-role: `restore` is an EMIT BEHAVIOR now (not a seat verb).
  Flow = emit compaction (real precompact seam → seat-keyed marker) → emit restore (real
  compaction-restore-bridge.cjs → one-shot directive) → expect pane contains "restore
  delivered" (the runner's real mirror line). Seed wrong-seat-restore exploits seat-keying.
- #8 stream-emit-durable-replay-live: emit slow_output → deterministic chunks + activity set;
  expect stream (rig stream list --json = durable/replayable bare array) match [{runtime:stub}]
  (intent-level; exact event field names verify-at-source) + expect pane contains "slow_output
  chunk 3/3" (deterministic last chunk). Seed stream-not-durable drops the durable-store event.
- **All 11 STILL PASS the real validator (11/11).** Manifest YAML-only c0ba79aa.
- REMAINING runtime field-name pass (needs verify-at-source of shipped --json shapes):
  #1 (ps settled/empty), #3/#4 (policy_provenance shape), #7 (pane already real), #11 (env.queue
  baton + queue-list fields + daemon verb), + fixture-form pass (culture_file/cwd:./agents), +
  #8's exact stream event shape + #6's cross-seat seed mechanics. #11 GREEN gate still = 51-06.

## INCREMENT 4 (2026-08-06) — grounded the real read-surface shapes (verify-at-source, VERIFY-AT-SOURCE-51-02)
REAL --json shapes the runner binds to (dumb-reader):
- **ps** default `rig ps --json` = BARE ARRAY of PER-RIG PsEntry {rigId,name,nodeCount,runningCount,activeCount,
  hasWorkCount,status:"running"|"partial"|"stopped",lifecycleState,uptime,...} — NOT per-seat (seats via `--nodes`
  = different endpoint/NodeEntry). So #1/#9 assert per-RIG summary, not per-seat.
- **queue** list = BARE ARRAY QueueItem[] (qitemId/state/destinationSession…); compact BLANKS body/summary → read
  via --full/show. (#2 already correct.)
- **stream** `rig stream list --json` = BARE ARRAY StreamItem {streamItemId,tsEmitted,sourceSession,body,format,
  hintType,…}. NOTE: this is the SEND/BROADCAST coordination stream, NOT the activity/hooks stream that
  emit-behaviors write. FLAG-#8: `emit slow_output` writes ACTIVITY (/api/activity/hooks), not StreamItem — so
  #8's "stream durable" premise needs a decision: model it with `send` (which DOES create a durable StreamItem)
  OR confirm whether the runner's `stream` surface should also read activity. ROUTE to dev-driver/orch (surface
  semantics), don't guess. My #8 currently uses emit slow_output + a StreamItem match — mismatched; HELD pending the ruling.
- **policy_provenance** = `rig policy effective --json` → {effective:{binding,resolvedScope}|null,
  posture:"known"|"unknown_posture",hint?}; binding carries setBy/setAt/record.evidence_citation. #3/#4 must assert
  {posture, effective:{binding:{…}}} — NOT my sketch {policy,source}. (Adapt in the next pass.)
- **pane** capture → CaptureResult{content}; `contains` = substring on content (#2/#6/#7/#8-pane already correct).
- **tui_socket** = UNIX socket, send `state` → {ok,instanceId,state:{screen,drill,filter,viewTab,…}} (#10 normalizer).
- **proof** = NO read surface (FLAG-1, fail-closed UnboundSurfaceError) — no scenario asserts it.

## NEW EXPRESSIBILITY FINDINGS (route, don't shim)
- **F-#1 (emptiness):** #1 "settled → NO residue" needs an EMPTY-array assertion. Subset `match: []` trivially
  passes (empty subset ⊆ anything) so it does NOT assert emptiness; `contains`/`equals` don't either. The format
  has no negative/emptiness/length assertion. ROUTE to 51-02 (a `match: []`-means-exact-empty rule, or an
  `absent`/`count` form). #1 HELD pending the ruling (parallel to #5's any_of finding).
- **F-#8 (stream vs activity):** see stream note above.

## Field-name pass status
- ADAPTED this increment: #7 (./ topology; pane contains already real), #9 (ps default-leg → bare-array PsEntry shape).
- HELD on a routing decision: #1 (emptiness F-#1), #8 (stream-vs-activity F-#8).
- REMAINING mechanical: #3/#4 (policy effective shape), #11 (env.queue baton + queue bare-array + daemon verb),
  fixture-form pass (culture_file/cwd:./agents). #11 GREEN gate still = 51-06.

## INCREMENT 5 (2026-08-06) — CO-LOCATION + runtime field-name pass + composition ledger (live runner)
Ran the eleven against the REAL runner (main 5dc70f0e, run-scenarios.mjs) in a hermetic env.
Form CONFIRMED by review50-r1: green-through-bound-product-steps + LOUD unbound verb + route the
unbound runner verbs = the honest ledger (a seed-bearing clean-PASS pre-binding would be the shim).

CO-LOCATION (fixture-form pass, DONE): the runner resolves `topology: ./<rig>.yaml` as a
scenario-file SIBLING and needs `culture.md` + `agents/<seat>/agent.yaml` siblings. Absorbed
fixtures/ into scenarios/ (flat, matches shipped scenario-02-baton layout): fixed topos (version
"0.2", culture_file, per-pod edges, no top-level edges, no summary), added culture.md + agents/
{impl,qa,worker,lead}, normalized all `topology:` refs to `./`.

RUNTIME FIELD-NAME PASS (this increment): send `to:` → canonical `<pod>-<member>@<rig>` (#7/#10/#11);
`expect pane seat:` → canonical session (#5/#7); #1 `expect ps` → bare-array PsEntry (per-RIG, not
sketch {rigs:[{seats}]}); #11 first `expect queue` → bare-array {qitemId,state,destinationSession}.

COMPOSITION LEDGER (live runner):
- GREEN THROUGH EVERY BOUND PRODUCT STEP (block only at the routed seed_regression): #1, #2, #9.
- SURFACE RESOLVES, content marker routed to 51-01 stub behavior: #5 (preseed "trust reached" not
  emitted by the default stub), #7 (stub does not echo the sent text to its pane; the send DID
  arrive — pane shows "From: <unknown sender>").
- LOUD UNBOUND VERB (routed to 51-02 runner binding): #6/#8 (emit), #3/#4 (policy; #4 also restore),
  #10 (mutate; its sends composed first).
- 51-06 GATED (expected-RED, never massaged): #11 (queue shape adapted; R-17 send-vs-queue premise
  + R-20 51-06 closure surface).

ROUTED RUNNER/STUB GAPS (never shimmed in 51-03):
- 51-02 verb bindings: seed_regression (ALL 11), emit-step (#6/#8), mutate (#3/#10), policy (#3/#4),
  restore (#4). scenario-real-deps default-throws these (main 5dc70f0e).
- 51-02 format: F-#1 emptiness/absent/count assertion (#1 second leg); R-16 ps scope selector +
  R-12 multi-rig up (#9 scoped legs); R-17 queue-establish verb (#11).
- 51-01 stub behavior: preseed emit (#5 "trust reached"), pane echo of sent text (#7), send `from`.
- 51-06: #11 executed-unclosed closure surface (R-20).
