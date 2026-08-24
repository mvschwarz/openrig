# test-system/evals — the live-model eval harness (a DIFFERENT gate from scenarios)

Two gates, one per question-kind — the legible split the desk ruled
(qitem-20260824042353-045e8f4a):

- `../scenarios/` = the DETERMINISM gate. Stub seats, scripted replies, judgment-free.
  Asks: does the STRUCTURE hold? (`run-scenarios.mjs`, `packages/daemon/test/helpers/scenario-*.ts`)
- `./` (evals) = the LIVE-MODEL gate. A REAL seat receives a NATURAL prompt and DECIDES.
  Asks: does a seat pull the right context entry BEFORE acting, and follow it AFTER loading?
  (`run-evals.mjs`, `packages/daemon/test/helpers/eval-*.ts`)

ONE eval harness serves BOTH slices through one portable `EvalCase` shape (anti-fork — the ruling
also amends slice-05 Q3 so there is one eval convention, not two):
- slice-07: SELECTION-before-LOADING — does the seat pull `rig context get <ref>` for a natural prompt?
- slice-05: BEHAVIOR-after-DELIVERY — does it follow what it loaded?

Grading:
- DOOR grade = deterministic expected-command-pattern match (+ loading order: get precedes action).
  This is what the CE-08 thinning gate consumes.
- Rubric (1-5) rides each case as authored text; the LLM-judge is OPTIONAL and DEFERRED (API-gated,
  agent-browser's `--judge` shape) — switch it on later without re-authoring the cases.

Layout:
- `cases/*.ts` — selection + loading `EvalCase`s (natural prompt, expected patterns, order, rubric).
- `fixtures/` — canonical-ref packs backing the structural canonical-ref checks only. The LIVE run
  does NOT point a seat at these; per Repair 2 the eval resolves refs against the EXACT production
  package (built by `generate-context-packs.mjs`), so fixture-vs-production drift fails structurally.
- runner + grader code lives in `packages/daemon/test/helpers/eval-*.ts` (vitest-wired), standalone
  live entry `packages/daemon/scripts/run-evals.mjs` — mirroring the scenario system's split, not
  agent-browser's bun layout (this repo is node/tsx/vitest).

Status: RED-first build in progress (slice-07 R6). Lock amendments (07 proof-contract + PRD R6; 05 Q3)
land via dev-planner + r1 re-stamp BEFORE the R6 fold; the build proceeds under the ruling meanwhile.
