# WIP — Topic D: Accept ↔ artifact + receipt ↔ operation

**Status:** draft / stacked scaffold — **depends on Topic C** (writer fence) + an agreed thin publish/target backend.  
**Branch:** `piotr/upstream-accept-receipt-binding`  
**Base:** `mvschwarz/openrig` `main`  
**Depends-on:** Topic C / `piotr/upstream-writer-authority` (stacked draft). Do not merge before C.

## Intent

1. Acceptance binds a clean immutable artifact identity + content digest; publishing B under judgment A must fail.
2. Receipts belong to `submissionId` / operation id, not “latest on target”; retry A after B returns receipt A; crash between artifact and receipt must not confirm B via receipt A.

## Planned in (thin — not full execution-slice)

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
- Shipping the private fork’s full execution-slice monolit

## Stacking note

Open as a **draft PR** that explicitly depends on Topic C. Prefer stacked review: land C’s fence first, then the thin accept+receipt binding on that op.

## Next extraction step

After C lands (or is reviewable): extract accept+receipt contracts from the private fork’s round-2 proofs as a thin consumer of the C fence — not the whole slice.
