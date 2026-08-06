# ROUTING — capabilities these scenarios need from 51-01 / 51-02 (never shimmed here)

Per 51-03 mini-req 2 + README Risks 1/2/3/5: any missing runner verb, stub behavior, or
env-helper capability is a 51-01/51-02 gap. It ROUTES to that slice's owner — it is
never patched, shimmed, or worked around inside 51-03. Each item below is authored
against the locked/ruled shape so it drops in when the dependency lands.

## → 51-01 (stub runtime)
- **R-01. Emit repertoire (items 5–8).** The TWO emit-bearing scenarios — #6
  (`compaction`) and #8 (`slow_output`) — consume `emit.behavior ∈ {compaction,
  slow_output, mid_turn_death, restore}`. (#2 queue-baton uses `send`+`restart`, NOT
  `emit` — corrected count; see `scripts/README.md`.) Step-4 (CLEARED, verdict 1eb6d505)
  built come-up + readiness only; A5 item 5 (ctx%) landed at 13e26355 (CLEARed, verdict
  53397f73); the four emit BEHAVIORS land in 51-01 items 6–8. Until then #6/#8 PARSE but
  their emit steps have no seam to trigger. `usage_limit` is deliberately absent
  (real-runtime-only).
- **R-02. Scenario-resolved stub scripts (scripted-response contract).** `scripts/*`
  reference the 51-01 per-seat script-delivery seam delivered at `up`. The default
  come-up-ready script (51-01 built-in) covers the lifecycle/queue/send scenarios now;
  the behavior scripts under `scripts/` gate on R-01.
- **R-03. Stub ctx% eligibility (A5 item 5).** No scenario here asserts `ps` ctx% for a
  stub seat (it would gate on the A5 ContextMonitor GAP-1/GAP-2 increment). Flagged so a
  future ctx% scenario is added only once that lands.

## → 51-02 (scenario format + runner + env-helper)
- **R-10. The runner + hermetic env-helper.** Nothing runs until the runner script and
  the forced-local/scrubbed-env/scratch-HOME/fail-closed helper exist. The hermeticity
  negative (proof item) is the helper's, exercised via these scenarios.
- **R-11. `daemon: {op: sigterm|restart}` step verb (#11) — LANDED in 51-02 v1.** Arch-ruled
  in ARCH-RULING-51-09 (the daemon-lifecycle verb on the SHARED env-helper lifecycle
  surface: single-owner spawn⇒kill/restart, re-spawned through the same
  forced-local/scratch/fail-closed guarantees under the injected clock). Per dev-planner's
  51-03 review: this verb is NOW IN the amended 51-02 v1 (A2 finals `28dc80cf` / `4180a007`)
  — no longer a rides-the-gate gap. #11 is authored in the ruled shape and is satisfied by
  the 51-02 v1 verb. (Confirm the exact `op` spelling against the A2 finals at run time.)
- **R-12. Multi-rig `up` (#9).** #9 brings up two rigs to prove ps scope honesty. The
  locked format's `topology:` is scenario-singular; #9 uses a per-step `up: {topology:
  fixtures/…}` override to name the second rig. CONFIRM at 51-02 build whether `up`
  accepts a per-step topology override (multi-rig), or whether the format needs a
  `topologies:` list. Routed as a 51-02 spec question; #9 authored in the override shape.
- **R-13. `equals` cross-surface normalizer (#10).** The declarative {tui_socket, ps,
  queue} normalizer ships from 51-02 (arch review rides 51-03 shaping). #10 is authored
  to the declarative `equals:` interface; the normalizer mapping itself is 51-02's.
- **R-14. `env.pre_existing_tmux` hermetic fixture (#5).** The hardest env fixture (a
  pre-existing tmux server inside a scratch scaffold). If the env-helper cannot express it
  hermetically, #5 BLOCKS on 51-02 rather than running non-hermetic — fail-closed beats
  coverage theater.
- **R-15. Disjunctive expect `any_of` (#5).** #5's binding acceptance is "lands on ONE of
  two honest outcomes" (preseed reaches the seat OR the failure is visible on stream).
  The locked `expect` is a single match; #5 uses an `any_of: [expect, expect]` form (pass
  if any holds within its bound). CONFIRM at 51-02 whether the format adopts `any_of` or
  the two outcomes split into two scenarios. Routed as a 51-02 spec question.
- **R-16. `ps` scope selector on `expect` (#9).** Asserting current-rig-default vs `-A`
  vs `--rig <name>` needs the runner to parameterize the shipped `rig ps` read. #9 uses a
  `select: current-rig | all | {rig: <name>}` modifier on the `ps` expect. CONFIRM the
  selector shape at 51-02 (it maps to the shipped ps flags). Routed.
- **R-17. Handoff / queue-completion action (#11, minor).** Faithfully reproducing the
  incident's `handoff-and-complete` closure may need a queue-completion action beyond
  `send`. #11 drives the executed work via `send` (locked verb); if a distinct handoff
  step is required for the exact closure-commit window, it routes to 51-02. Minor.

## → 51-06 (transactional execution-closure) — #11 GREEN gate
- **R-20. #11 GREEN gate = the 51-06 transactional-closure reconcile (POOLED, NOT in
  main).** kill-daemon-mid-handoff is RED-FIRST: its SOLE green gate is the 51-06
  transactional execution-closure + executed-unclosed reconcile, confirmed NOT in main at
  `13e26355` (dev-planner 51-03 review, grounded at source). Expected-RED until 51-06
  lands; recorded as expected-RED, never massaged. **Correction (supersedes an earlier
  acting-orch feed):** `bfbc2182` is the 90840bcb response-integrity CLI commit and
  `4cd2c313` is the slow-op-recorder drain latch — BOTH touch no queue/closure code and
  are orthogonal to #11; neither satisfies its gate. The daemon SIGTERM/restart is just
  the `daemon: {op}` verb (R-11); queue-claim durability across a SIGTERM is baseline
  SQLite, not a slice gate. #11's only non-51-06 blockers are the 51-02 runner (R-10) and
  the `daemon:{op}` verb (R-11, now landed in 51-02 v1).

## Path finalization
These files live under `packages/test-system/` as a self-contained drop. The EXACT tree
location inside the 51-02 runner's home is finalized by the 51-02 build; the shipped
layout is CO-LOCATED — `scenarios/` carries the scenario YAMLs with their fixture assets
(topologies, agents/, culture) beside them, `scripts/` beside it; the formerly separate
`fixtures/` dir was absorbed into `scenarios/`.
