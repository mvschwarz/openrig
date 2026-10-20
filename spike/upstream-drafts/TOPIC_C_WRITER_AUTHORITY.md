# Topic C — Writer authority (real extract)

**PR contents today:** real daemon extract (not docs-only).  
**Branch:** `piotr/upstream-writer-authority`  
**Base:** `mvschwarz/openrig` `main`  
**First fenced product verb (from fork journal):** publish onto a disposable `publish_target` via `FencedPublishTarget.publish` under a live writer lease + matching generation.

## Guarantee

**API-only fencing** — not an OS sandbox. Soft `0444` on the published artifact resists accidental overwrite only.

## Ship set

1. Migration `118_writer_authority_leases` (fork used `085`; upstream already shipped a different `085`)
2. `WriterAuthority` — acquire / renew / release / revoke / transfer + `assertHolder` / `withProtectedMutation`
3. Lease lifecycle events (`writer.acquired|released|revoked|transferred`)
4. Call site: `FencedPublishTarget.publish` (needs clean `BoundAcceptance`)
5. Thin HTTP `/api/writer/*` (acquire/renew/release/revoke/transfer/publish/active)
6. Unit + shared-SQLite two-process fence test + call-site revoke-blocks-publish test

## Explicitly out

- Full `ExecutionSliceService` / Jeff / DecisionProvider
- Per-operation receipt index (Topic D)
- MCP writer tools
- Native OMP/Prime smoke
- `chmod`-as-security claims

## Maintainer notes

- Default resource kind for acquire HTTP is `publish_target`.
- Publish target root: `OPENRIG_PUBLISH_TARGET_ROOT` (explicit opt-in).
- Without a wired target, `POST /api/writer/publish` returns 503 — never silent `published=true`.
