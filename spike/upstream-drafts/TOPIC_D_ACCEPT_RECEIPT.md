# Topic D — Accept↔artifact + receipt↔operation (real extract)

**Stacked on:** Topic C [#1598](https://github.com/mvschwarz/openrig/pull/1598) (`piotr/upstream-writer-authority`)  
**Branch:** `piotr/upstream-accept-receipt-binding`  
**PR contents today:** real thin extract (not docs-only).

## What lands

1. `OperationPublishService` — accept binds clean immutable artifact; receipt keyed by `operationId`
2. HTTP `POST /api/writer/accept-publish`
3. Contract tests: receipt↔op (retry A after B), simulation without target, failpoint child recovery
4. Does **not** weaken assertions vs fork round-2 Contract 1 intent

## Explicitly out

- Full `ExecutionSliceService` (roles/queue/DEV productization)
- Jeff / DecisionProvider / hermetic / OMP-prime / native smoke
- Cross-host as merge gate

## Depends on C

WriterAuthority + FencedPublishTarget + migration 118. Without C, this PR has no fence.
