# Queue-driven seat cold start: review fixes (#2829 slice 1)

**A–G implemented; focused gates pass. Not pushed; no PR opened.**

- Branch: `feat/seat-cold-start`.
- Upstream base merged, not rebased: `c00289e2687ac2880b2595d159f2b2272a08c48f`.
- Operator's integration commit: `764cb55fd`; the safety plugin blocked rebase.
- Tested implementation: `c55f67be333dbfd163cc0489d9b523fdea1baafd`.
- Migration: **163**, `packages/daemon/src/db/migrations/163_seat_cold_starts.ts`,
  registered in both migration lists. Upstream's 158–162 are preserved.
- Node `v22.23.4`, npm `10.9.9`. Final gates ran on 2026-11-12.

## Commit list

Original feature and operator integration:

1. `51b00571f` feat(daemon): add the cold_start opt-in to the rig spec
2. `80766c140` feat(daemon): cold-start a dormant opted-in seat when queued work arrives
3. `edd7e96f3` test(daemon): cover cold-start eligibility, coalescing and Pi continuity
4. `2396eafe0` fix(daemon): wire the cold-start launcher once runtime adapters exist
5. `764cb55fd` merge: integrate upstream main (migration 158 collision resolved as 163)

Review-fix commits, in order:

6. `862bc4992` fix(daemon): honor stop intent on rolled-back cold starts
7. `15500df61` fix(daemon): bind cold-start stop attribution to session identity
8. `d3d146bb4` fix(daemon): revalidate cold-start eligibility under lifecycle lease
9. `6a076b76c` fix(daemon): recover cold starts after repaired seat lifetimes
10. `e68fa3f7d` fix(daemon): probe every current peer before deferring cold start
11. `c8f9d1ac4` fix(daemon): coalesce cold-start refusals per queue drain pass
12. `49c64efcd` docs(daemon): clarify cold-start eligibility and conservative limits
13. `b030dd26b` test(daemon): exercise cold-start stops through lifecycle writers
14. `c55f67be3` fix(daemon): limit teardown rechecks to revivable stop intents

The final status-only commit records this package; it does not change the tested implementation.

## Findings → fixes and regression evidence

| Finding | Fix | Regression coverage |
|---|---|---|
| A — superseded launch bypassed explicit stop | Stop intent is classified before the failed-start fallback. | `seat-cold-start.test.ts`: failed launch → down intent → peer live, no launch. `seat-cold-start-stop-generations.test.ts`: same sequence through real teardown. |
| B — reused name borrowed an older reaper event | `session.stopped.sessionId` identifies the exact session row. The supported stop path writes it in the flag's transaction; teardown writes `rig-teardown` / `rig_down`, removal writes `rig remove` / `node_removal`. Legacy or mismatched events fail closed. | Same-name reaper → relaunch → down/human stop refuses; reaper → relaunch → crash allows. Real writer scenarios, removal audit, and same-generation reaper → down coverage. |
| C — eligibility checked before awaited probes | Starter takes the existing delivery-guard lifecycle lease and synchronously rechecks current seat identity, persisted opt-in, stop intent and attempt ledger immediately before calling the existing launch door. The door joins the same lease. | Stop/opt-out/identity changes during probes refuse. A stop committed while waiting for the actual lifecycle lease refuses. Pi continuity tests share the real guard with the door. |
| D — permanent three-failure disable | Positive target liveness clears failures. Failure counts also expire after 15 quiet minutes, covering successful operator lifetimes never observed by queue wakes. | Capped seat → observed operator run → dormant → launch; unobserved-life cap expiry; existing three-failure and success-reset cases. |
| E — only five peers checked | Probe each distinct latest running peer session, bounded by actual rig size, stopping on the first live one. | Five stale peers followed by a live sixth, seven probes including the target, launches. |
| F — refusal work repeated for waiting rows | Drain-pass evaluation tokens plus TTL-bounded in-memory memoization before seat resolution; dot/dash canonical addresses coalesce. New passes recheck immediately; entries expire after one second. Queue receiver classification itself is still re-read. | Resolution/probe/log counts for repeated refusals, TTL expiry, immediate next-pass liveness recheck, real queue drain token sharing/renewal. |
| G — constants and documentation | Existing named 60-second and three-failure constants retained; named failure-window/TTL constants added. Classifier now has the eligibility table; reference docs and PR body state the single-seat limitation. | Exact minimum-interval boundary, failure cap tests, single-seat-rig refusal. Prose is reviewed, not pinned by text assertions. |

Generation attribution uses the existing transactional event ledger instead of a new table.
The session id is optional in the event type for compatibility with older events, but an
absent id **never** authorizes a reaper revival. No name-based fallback remains.

The expanded gate initially caught four teardown regressions from reprobes of every
already-stopped row. `c55f67be3` preserves the old unstopped-row path and includes only
exact-generation reaper stops in additional rechecks. All 113 teardown tests now pass.

## Eligibility table

All allowed rows also need current opt-in, an unchanged/unarchived seat, no live target,
a live peer, and the attempt/backoff gates.

| Latest recorded state | Classification | Cold start |
|---|---|---|
| No session row | dormant / never ran | allowed |
| Explicit stop, exact session-id event `daemon:seat-reaper` / `idle_reap` | daemon_reclaim | allowed |
| Explicit stop, any other/legacy/missing attribution, including superseded rows | intentional | refused |
| Superseded without stop intent | failed_start | allowed under backoff |
| Crash/lost session without stop intent | dormant | allowed |
| Deleted/spec-removed seat, archived rig or ambiguous identity | unavailable | refused |

## Merged queue seam, re-pinned

`packages/daemon/src/domain/queue-repository.ts`:

- Drain pass token: 1825; waiting-row receiver predicate: 1849.
- Physical-session-aware no-receiver checks: 1879–1888.
- Nonthrowing, fire-and-forget notifier: 1896–1902.
- Unroutable send classification retains its notification: 2114–2119.
- Post-failure receiver classification: 1716–1721.

Upstream's physical-address refactor and queue claim/handover behavior remain intact.
The existing queue wake-recovery suite passes; no new delivery/pickup path is added.

## Verification at the tested implementation

`npm ci` was rerun because the merged lockfile changed. Tail:

```text
added 448 packages, and audited 453 packages in 3s
21 vulnerabilities (2 low, 5 moderate, 10 high, 4 critical)
```

No dependency upgrades or audit autofixes were attempted.

`npm run build` — exit 0. Tail:

```text
✓ built in 3.80s

> @openrig/cli@0.7.1 build
> tsc && node ../../scripts/prepare-workspace-build.mjs cli

> @openrig/tui@0.1.0 build
> tsc && node ../../scripts/prepare-workspace-build.mjs tui
```

`npm run lint` — exit 0. Tail:

```text
> openrig@0.7.1 lint
> npm run typecheck:prep && tsc --noEmit --project packages/daemon/tsconfig.json && tsc --noEmit --project packages/ui/tsconfig.json && tsc --noEmit --project packages/cli/tsconfig.json && tsc --noEmit --project packages/tui/tsconfig.json

> openrig@0.7.1 typecheck:prep
> npm run build -w packages/daemon

> @openrig/daemon@0.7.1 build
> tsc && node scripts/copy-workflow-specs.mjs
```

Focused + touched-seam verification — exit 0:

```sh
npx vitest run packages/daemon/test/seat-cold-start \
  packages/daemon/test/queue-cold-start-hook.test.ts \
  packages/daemon/test/rigspec-cold-start.test.ts \
  packages/daemon/test/seat-lifecycle-service.test.ts \
  packages/daemon/test/rig-teardown.test.ts \
  packages/daemon/test/checked-seat-stop.test.ts \
  packages/daemon/test/rig-lifecycle-route.test.ts \
  packages/daemon/test/seat-delivery-guard.test.ts \
  packages/daemon/test/wake-recovery-no-receiver.test.ts \
  packages/daemon/test/migration-fixture-parity.test.ts
```

Tail:

```text
✓ |@openrig/daemon| test/seat-lifecycle-service.test.ts (37 tests) 1274ms
✓ |@openrig/daemon| test/rig-lifecycle-route.test.ts (23 tests) 1439ms
✓ |@openrig/daemon| test/seat-cold-start.test.ts (41 tests) 4458ms
✓ |@openrig/daemon| test/rig-teardown.test.ts (113 tests) 8294ms

Test Files  12 passed (12)
     Tests  304 passed (304)
  Duration  10.28s
```

Cold-start-only selection contains 65 passing tests across five files (41 + 3 + 5 + 4 + 12).
Full command output is local under `.omo/evidence/cold-start-review-{build,lint,tests}.log`.
The pre-fix status package is preserved as `.omo/evidence/cold-start-review-before-fixes.md`.

LSP diagnostics ran on all 13 edited TypeScript files. No new error diagnostics were
introduced. Existing Biome errors remain in unchanged upstream lines: assignment-in-expression
in `rig-teardown.ts` (194, 233, 461, 536) and `queue-repository.ts` (826), and unsafe-finally
in `rig-teardown.test.ts` (121), alongside existing import-order/non-null style warnings.
The repository's actual lint/typecheck command passes. No full-repository test run is
claimed for the merged base; older full-suite results are historical only.

## Continuity and remaining limits

**Unit-level continuity against the real launch door with faked tmux/Pi adapter;
live fleet e2e pending.** The tests run real SQLite migrations, snapshots,
`RestoreOrchestrator.launchSingleNode` and the delivery guard. They demonstrate exact
Pi session-file resume, awaiting-decision without a fresh replacement, and unchanged
pending queue work. They do not prove native Pi process behavior or live-fleet pickup.

- Opt-in remains default off; no scheduler, topology, memory gate, reaper or rig-level verb was added.
- The reaper seam remains exactly `daemon:seat-reaper` / `idle_reap`, now session-id-bound.
- A rig whose **only seat is dormant never cold-starts** because a live peer is required.
- A running rig without a restore-usable snapshot fails closed through the launch door.
- New teardown/removal audit events are persisted transactionally; these paths retain
  their existing subscriber-notification behavior.
- The operator's merge already tracks generated
  `packages/daemon/assets/openshell/__pycache__/guest.cpython-310.pyc` (introduced in
  `764cb55fd`). It was not changed or removed in this fix task; remove it from a future
  contribution separately if unintended. No public push was performed.
- `npm ci` reports the dependency audit findings above. Remediation is outside A–G.
- Independent post-fix review and live-fleet e2e remain outstanding.

## Alignment record (implementer self-check, not independent approval)

Bound to branch `feat/seat-cold-start`, implementation
`c55f67be333dbfd163cc0489d9b523fdea1baafd`, 2026-11-12T09:25:55Z.
Tracked tree was clean at binding; only local `.omo/` and this status file were untracked.

- Req A–G: SATISFIED at the unit/route seam level by the mapping and executed gate above.
- Upstream integration and migration 163: SATISFIED by `764cb55fd` and migration parity tests.
- Default-off, launch continuity, delivery lease and daemon/docs scope: SATISFIED by
  rigspec, Pi continuity, guard, queue and lifecycle tests plus the diff against the merge.
- No push / no PR: SATISFIED; no publishing commands were run.
- Live fleet e2e: GAP, explicitly pending rather than represented as a passing test.
- Inherited generated bytecode / dependency audit: OUT-OF-SCOPE for this fix task.

Recommendation: **accept the A–G fixes for independent review**, not fleet acceptance
or publication. The tested behavior is bounded to the evidence stated here.

## Proposed PR body (not submitted)

**What a user gets** — With `cold_start: true` on a pod/member, pending work can wake
that dormant seat of a running rig through the existing single-seat `rig launch`
door. A usable Pi conversation is resumed; an unresumable conversation parks as
awaiting-decision, never silently replaced. Opt-in remains off by default.

**Who stays down** — Human/rig-down/removal stops, removed seats and down rigs.
Only the exact session generation stopped by `daemon:seat-reaper` / `idle_reap`
is revivable. Intentional stop wins even over rolled-back launch history. Eligibility
is checked under the delivery lease. Simultaneous work and refusal evaluations
coalesce; three failures pause retries until observed liveness or 15 quiet minutes.
A rig whose **only seat is dormant never cold-starts**: this conservative gate needs
a live peer; start that seat explicitly.

**Verification** — Build and lint pass; 304 tests pass across 12 focused/lifecycle/queue
suites, including 65 cold-start tests. Continuity evidence is **unit-level against
the real launch door with faked tmux/Pi adapter; live fleet e2e pending**. No new
scheduler, topology, memory gate, reaper or rig-level verb. Migration 163 follows
the merged upstream base `c00289e26`.

**Limits to review** — Missing restore snapshots fail closed. Legacy stop events
without a session id cannot authorize reaper revival. Independent post-fix review
and real-fleet resume/pickup are still needed. This is a local review package, not
a release or merge commitment.
