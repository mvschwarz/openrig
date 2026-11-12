# Queue-driven seat cold start: review fixes (#2829 slice 1)

**A–G implemented; CRITICAL stop-attribution spoofing and drain-pass TTL warning fixed;
focused gates pass. Not pushed; no PR opened.**

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
| F — refusal work repeated for waiting rows | Drain-pass evaluation tokens before seat resolution; dot/dash canonical addresses coalesce for the entire token lifetime. New passes recheck immediately; the one-second TTL applies only outside a pass. Queue receiver classification itself is still re-read. | Resolution/probe/log counts for repeated refusals, same-pass notifications 1,001 ms apart, outside-pass TTL expiry, immediate next-pass liveness recheck, real queue drain token sharing/renewal. |
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

---

## Live Pi end-to-end demonstration (native runtime, single-host)

Run 2026-11-12 after the merge, on this checkout's built daemon (head `ec622c97b`,
implementation `c55f67be3` code included), Node v22.23.4, tmux 3.5a. This closes the
"live fleet e2e pending" item for one seat; it does **not** claim a 9-rig fleet run.

**Setup.** A scratch daemon from this checkout only (never the installed daemon), its
own private tmux socket and scratch `OPENRIG_HOME`/`HOME` (the repo's hermetic scenario
scaffold), an ephemeral loopback port, and a two-seat rig `coldrig`:
`dev.keeper` (pi, stays live) and `dev.sleeper` (pi, `cold_start: true`), both real
native `pi` 5.1.48 (OmO fork) processes against the zai provider, with the seat's own
managed `PI_CODING_AGENT_DIR` auth.json. A `rig snapshot coldrig` was taken while both
seats were live (the launch door needs a restore-usable snapshot).

**Sequence and observed result (four consecutive runs):**

1. Both seats reached `running`; the sleeper's runner-state sidecar recorded
   `sessionFile=<…>.jsonl` and `ready:true`.
2. The sleeper's tmux session was killed out-of-band (the issue's "no
   continuity-preserving option today" case), then the daemon was restarted — the boot
   reconciler recorded the seat `detached` with `intentionally_stopped=0`, the exact
   state a crashed/rebooted seat has. The keeper stayed live, so the rig still counted
   as running.
3. `rig queue create --destination dev-sleeper@coldrig` (sourced from the keeper).
4. The wake failed against the missing session; the queue's positive no-receiver
   evidence triggered the cold start. `seat_cold_starts` recorded
   `last_outcome:"resumed"`, `consecutive_failures:0`, `last_success_at` set — in
   09:03:29, 09:09:03, 09:12:41 and 09:21:16 runs.
5. The relaunched seat's runner-state reported the **same** `sessionFile` as before
   (`SAME CONVERSATION: true`) and `ready:true`; the pi seat resumed its conversation
   rather than starting fresh.
6. The queued row then reached the revived seat on the wake ladder's normal retry
   cadence (~5 min, not instantly) and the **pi seat itself claimed it**
   (`claimed_at` set, state `in-progress`/`done`); the pane shows the agent working the
   row.

**Receipts (local, not part of the branch):** `.omo/evidence/coldstart-demo.log` (the
final evidence-complete run: before/after session file, ledger, claimed row, pane
tail) and `.omo/evidence/npm-test-postmerge.log`, `lint-postmerge.log`,
`ui-postmerge.log`.

**What the live run caught that unit tests could not:**

- **A real wiring defect:** the first live attempts failed with
  `awaiting_decision:… (no pi adapter available)` — the cold-start call into
  `launchSingleNode` did not thread the runtime adapters map, so a pod-aware resume
  could not verify continuity. Fixed by wiring the adapters (and `fsOps`) into the
  late-bound launcher exactly as the HTTP launch routes do; the fix is commit
  `2396eafe0`, and the four resumed runs above are after it. Behaviour without it was
  correct-but-unhelpful: fail closed to `awaiting-decision`, never a silent fresh start.
- **Snapshot dependency is real:** on a rig that had never been snapshotted, the door
  answered `failed:no_usable_snapshot` (fail closed, documented limit above). Operators
  get cold start only with a restore-usable snapshot; the fix is a snapshot policy, not
  a code change here.
- **Dormancy needs a daemon-observed state:** an out-of-band kill leaves
  `sessions.status='running'` until the boot reconciler (or a daemon-recorded stop, as
  slice 2's reaper will write) records it. The intended production path is a recorded
  stop; out-of-band teardown cold-starts after the next daemon start. Recorded as a
  limit, not silently papered over.

**Still outstanding:** a multi-rig/fleet run on the operator's pi fleet (this used one
scratch daemon and two seats), and independent post-fix review.

## Security closure and drain-pass warning — 2026-11-12

Latest implementation: `538ebf7e1b28120a3734a65db32a45fb1705dbbf`, branch
`feat/seat-cold-start`, clean tracked tree at binding, 2026-11-12T10:35:54Z.
Implementer self-check, not independent security approval. Starting head was
`bbc9e5327` (the live-demo status commit after the supplied `ec622c97b`).

### CRITICAL: caller-controlled reaper attribution — CLOSED

A caller could POST `operator: daemon:seat-reaper` and `reason: idle_reap` to
the seat-stop route, producing an exact-generation revivable stop. Queued wake
notifications could then relaunch a deliberately stopped seat. Runtime-custody
middleware did not establish authority to claim a daemon identity.

`e54f1ffbc` — `fix(daemon): reserve internal stop attribution at the HTTP boundary`

- `packages/daemon/src/routes/seat.ts:570`: the stop route ignores body operator
  claims and records the transport sender, or null when absent. It also strips
  `daemon:*` transport identities: that header is caller-controlled, not authentication.
  Reason text and checked-stop preconditions retain their existing handling.
- Internal `SeatLifecycleService.stopSeat` calls are unchanged; the exact-generation
  `daemon:seat-reaper` / `idle_reap` attribution remains the only revivable stop.
- CLI `runLifecycleVerb("stop", ...)` posts to this route, so `--operator` cannot
  bypass it. The current MCP server exposes no separate seat-stop tool or direct
  lifecycle stop writer. No CLI/MCP command or rig-level verb was changed.
- Cost: body-supplied stop labels are no longer recorded, even ordinary labels;
  callers without a transport identity are recorded as unattributed intentional stops.

Tests in `seat-cold-start-stop-generations.test.ts`:

- `keeps a caller stop intentional when daemon attribution is supplied: $operator / $sender`
  runs real HTTP routing, SQLite persistence, lifecycle writing and the delivery lease,
  then a cold-start wake notification. Four cases cover missing, normal and forged
  transport identity, plus another reserved daemon name. They assert no launch and
  persisted non-revivable attribution bound to the exact session id.
- `revives the exact generation stopped by an internal reaper-style call` proves the
  direct internal writer still records reaper attribution and the wake launches once.

### WARNING: TTL expiry inside a slow drain pass — CLOSED

`538ebf7e1` — `fix(daemon): retain cold-start refusals for the whole drain pass`

`packages/daemon/src/domain/seat-cold-start.ts:225` expires evaluations only when
no drain token is supplied. The WeakMap retains each token's evaluations for its
lifetime without adding timers or scheduling. The existing test
`rechecks liveness on the next drain pass without waiting for the TTL` now advances
the injected clock 1,001 ms between same-pass notifications and asserts one recipe
evaluation, two liveness probes (target and peer), and one refusal log. A new token
still rechecks immediately; the separate outside-pass TTL test still passes.

### Verification tails

Red before production edits: the two focused files reported
`Tests 5 failed | 46 passed (51)`. Three forged-reaper route cases launched once
instead of zero; the other reserved-name case persisted the body identity;
the slow-pass case evaluated the recipe twice instead of once. The internal-reaper
regression already passed. Green after edits: both focused files pass.

`npm run build` — exit 0:

```text
✓ built in 3.79s
> @openrig/cli@0.7.1 build
> tsc && node ../../scripts/prepare-workspace-build.mjs cli
> @openrig/tui@0.1.0 build
> tsc && node ../../scripts/prepare-workspace-build.mjs tui
```

Non-blocking UI warnings: stale Browserslist data and a minified chunk over 500 kB.
No dependency or UI changes were made.

`npm run lint` — exit 0:

```text
> npm run typecheck:prep && tsc --noEmit --project packages/daemon/tsconfig.json && tsc --noEmit --project packages/ui/tsconfig.json && tsc --noEmit --project packages/cli/tsconfig.json && tsc --noEmit --project packages/tui/tsconfig.json
> openrig@0.7.1 typecheck:prep
> npm run build -w packages/daemon
> @openrig/daemon@0.7.1 build
> tsc && node scripts/copy-workflow-specs.mjs
```

Focused and stop-path suites — exit 0:

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
  packages/daemon/test/migration-fixture-parity.test.ts \
  packages/cli/test/seat-lifecycle-verbs.test.ts
```

```text
✓ |@openrig/daemon| test/seat-lifecycle-service.test.ts (37 tests) 1641ms
✓ |@openrig/daemon| test/rig-lifecycle-route.test.ts (23 tests) 1667ms
✓ |@openrig/daemon| test/rig-teardown.test.ts (113 tests) 8234ms
Test Files  13 passed (13)
     Tests  362 passed (362)
  Duration  10.77s
```

Negative CLI option tests emit expected required-option errors; existing mocked
tmux/claim paths emit scope/probe warnings. No test failures. LSP error diagnostics
on all four changed TypeScript files: none. `git diff --check`: exit 0.

### Alignment and residual risks

- Req 1, reserved caller attribution non-forgeable: SATISFIED by route + persisted
  event assertions in `e54f1ffbc`; both body and header spoofing are covered.
- Req 2, internal reaper stop still revives: SATISFIED by the direct lifecycle regression.
- Req 3, per-token refusal lifetime with outside-pass TTL: SATISFIED by `538ebf7e1`
  and both cache tests in the executed selection.
- Req 4, build/lint/focused stop suites and recorded tails: SATISFIED above.
- Req 5, intentional-stop refusal/delivery guard preserved, no scheduler or rig-level
  verbs, no weakened tests, no secrets: SATISFIED by the four-file implementation diff
  and the executed lifecycle/teardown/guard suites.
- Req 6, no push, PR or GitHub comment: SATISFIED; no publishing command was run.

Self-review: route owns caller stop attribution; starter owns cold-start admission;
tests own the corresponding regressions. No new tagged variants, casts, helpers,
dependencies, error handling or logging. Existing manual request parsing is retained.
Pure-LOC measurement: route 536, starter 296, existing cold-start tests 498, generation
tests 140. The first three are inherited oversized files; this bounded security fix
does not restructure them. No full-suite or new native-runtime/fleet acceptance is
claimed: the HTTP/lifecycle/SQLite/guard surface is real, tmux and the launch callback
are simulated. Independent review remains recommended. Recommendation: accept these
two bounded fixes for independent review, not fleet acceptance or publication.
