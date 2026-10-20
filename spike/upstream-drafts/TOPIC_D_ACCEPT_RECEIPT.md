# WIP — Topic D: Accept ↔ artifact + receipt ↔ operation

**PR contents today:** docs-only scaffold — this file under `spike/upstream-drafts/`. **No** accept/publish/receipt TypeScript or contract tests yet.  
**Status:** stacked design placeholder — **depends on Topic C** (writer fence) + an agreed thin publish/target backend.  
**Branch:** `piotr/upstream-accept-receipt-binding`  
**Base:** `mvschwarz/openrig` `main`  
**Depends-on:** Topic C / draft PR [#1598](https://github.com/mvschwarz/openrig/pull/1598) (`piotr/upstream-writer-authority`). Do not merge or undraft before C has a real extract + agreed op.

## Intent

1. Acceptance binds a clean immutable artifact identity + content digest; publishing B under judgment A must fail.
2. Receipts belong to `submissionId` / operation id, not “latest on target”; retry A after B returns receipt A; crash between artifact and receipt must not confirm B via receipt A.

## Planned extract (thin — future; not full execution-slice)

1. `artifact-acceptance` + units
2. Thin publish + per-operation receipt index under the writer fence
3. Contract tests: receipt-per-op + failpoint skew
4. Simulation without target: never fake `published=true`

## Explicitly out

- Full `ExecutionSliceService` (roles / queue close / DEV productization)
- Cross-host as merge gate
- Jeff / DecisionProvider
- Native smoke / Railway
- Hermetic private homes
- Shipping the private fork’s full execution-slice monolith

## Stacking note

Keep as a **draft PR** that explicitly depends on Topic C. Prefer stacked review: land C’s fence first, then the thin accept+receipt binding on that op. Fork round-2 accept/receipt proofs are **evidence for a later extract**, not a claim that this PR already contains them.

## Next extraction step

After C lands (or is reviewable with an agreed publish op): extract accept+receipt contracts from the private fork’s round-2 proofs as a thin consumer of the C fence — not the whole slice.
