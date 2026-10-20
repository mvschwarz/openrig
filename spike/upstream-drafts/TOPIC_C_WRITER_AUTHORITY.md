# WIP — Topic C: Writer authority (one protected mutation)

**Status:** draft / scaffold only — needs an agreed product verb before a real extract.  
**Branch:** `piotr/upstream-writer-authority`  
**Base:** `mvschwarz/openrig` `main`  
**Depends on:** maintainer answer — which **single** product mutation is the first fenced operation?

## Intent

Durable single-writer leases (acquire / renew / release / revoke / transfer) with generation fencing for **one** agreed protected product operation. Guarantee is **API-only fencing**, not an OS sandbox.

## Planned in

1. Migration `085_writer_authority_leases` + `WriterAuthority`
2. Lease lifecycle events
3. **One** call site via `assertHolder` / `withProtectedMutation`
4. Unit + shared-SQLite two-process fence test
5. Honest API-only fence wording in docs

## Explicitly out

- Full `ExecutionSlice` orchestration
- MCP writer tools until an HTTP product surface exists
- `chmod`-as-security claims
- Jeff / DecisionProvider, hermetic profiles, cross-host as merge gate
- Hidden deps (full slice, private profiles)

## Maintainer questions

1. Which single product mutation is first (publish onto disposable target, integration-branch update, other)?
2. Resource kinds: one kind first?
3. Lease TTL / renew for long agent turns?
4. HTTP under `/api/execution/*` or neutral `/api/writer/*`?

## Next extraction step

After the verb is agreed: extract lease schema + authority module + one gated call site against current `main`.
