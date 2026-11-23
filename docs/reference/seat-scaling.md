# Managed seat scaling (idle-seat reaping)

The daemon can reclaim the memory of a seat that has been provably idle for hours.
It does this by **stopping** the seat through the existing checked-stop path — never
by deleting anything. This is the local half of the architecture described in
[mvschwarz/openrig#2829](https://github.com/mvschwarz/openrig/issues/2829): idle
seats are reaped here and cold-started back on demand by a separate change
(queue-driven cold start). That return path is **not** part of this feature, so
reaping stays behind a disabled-by-default kill switch until it lands.

The reaper is conservative by construction: it reaps only when every predicate
below holds continuously for the whole threshold, and any doubt (unknown
activity, a failed probe, an unlucky git read) resets the clock and defers.

## Eligibility

A seat is reap-eligible only when **all** of these hold on every tick for
`idle_threshold_minutes` (default 240, i.e. hours not minutes). A single break
resets that seat's idle clock.

| Guard | Source | Effect when it does not hold |
| --- | --- | --- |
| Proven idle at prompt | `SeatActivityService.getSeatStateBySession`; the honest values are `working`, `idle-at-prompt`, `unknown` | `working` resets the clock; **`unknown` also resets** — unknown is never treated as idle |
| No pending input | the same arbitrated state, `needsInput.count === 0` | reset |
| No background work | the same state, `backgroundWork` empty | reset |
| Empty inbox | no `queue_items` in `pending`, `blocked` or `in-progress` addressed to the seat | skip this seat, decision `pending-work` |
| Not a claimed session | the latest session's `origin` is `launched` | skip (adopted sessions are never stopped by the reaper) |
| Not restore-pending | `startup_status` is `ready`; `restoreOutcome` is not `awaiting-decision` | skip |
| Running agent seat | node kind `agent`, runtime not `terminal`, lifecycle state `running` | skip permanently |
| Rig opted in, not protected | `opt_in_rigs` includes the rig; `protected_rigs` does not; `coordination` is always protected | skip permanently |
| Clean workspace | for every repo in the rig's workspace block (plus each seat's working directory): `git status --porcelain` empty **and** no commits ahead of the upstream | skip the **whole rig** this pass, decision `dirty-workspace`; a probe failure is `defer-probe-failed` |

All seats in a rig share one workspace, so the git guard is **rig-granularity**:
untracked files count as dirty, and one dirty repository defers every seat in the
rig. This is the destructive-delete guard applied to processes — a seat whose
worktree holds uncommitted or unpushed work stays up.

The idle clock is durable but deliberately fragile across doubt: it is stored per
seat in the `seat_reap_state` table, and a daemon restart, a missed sampling
window, an activity-sequence change, or any failed probe clears it. Clocks reset
in the safe direction; they are never carried across a restart.

## Reap protocol

For each eligible seat, after the threshold elapses:

1. **Capture first.** The daemon re-derives the seat's resume token through the
   runner's existing `get_state` path and writes a `seat.reaped` event with
   `phase: "capture"` and the full eligibility snapshot. If capture cannot be
   persisted or does not produce a token that agrees with the recorded session
   pointer, nothing is stopped.
2. **Checked stop.** `stopPrecondition` is read and its `expected` tuple is
   carried unchanged into the checked stop with operator `daemon:seat-reaper` and
   reason `idle_reap`. Every existing refusal is honored. On `stop_uncertain` the
   pass ends at once, the seat is marked `attention_required`, and the seat is
   never retried blind.
3. **Receipt.** A second `seat.reaped` event with `phase: "effect"` records the
   stop result, its `stopPhase`, and whether the reap consumed the breaker
   budget.

Nothing is deleted: the session row, the session file, the seat's state directory
and the workspace all survive. Stopping a seat leaves the rig `running`; the
recorded-intentional-stop semantics already prevent a "degraded" misread.

## Configuration

Keys live in the daemon user-settings store and in the CLI config store (both
lists carry the same six keys):

| Key | Default | Meaning |
| --- | --- | --- |
| `policies.seat_scale.enabled` | `off` | Master kill switch. While off, no seat is examined and no clock is kept. |
| `policies.seat_scale.observe` | `on` | OBSERVE mode: log `decision: "would-reap-observe"` and stop nothing. |
| `policies.seat_scale.idle_threshold_minutes` | `240` | How long every predicate must hold before a reap (60–525600). |
| `policies.seat_scale.max_reaps_per_24h` | `12` | Rolling-24h cap on stops that consumed effect (complete or partial). |
| `policies.seat_scale.protected_rigs` | `["coordination"]` | Rigs that are never reaped. `coordination` is always protected. |
| `policies.seat_scale.opt_in_rigs` | `[]` | Rigs the reaper may manage. Empty means nothing is touched. |

A fresh install is unchanged: `enabled` is off, so the reaper performs no probe and
writes no state. A rig is only managed once it is named in `opt_in_rigs` **and**
`enabled` is on.

## Receipts

Every pass writes to the append-only `events` table as `seat.reaped`:

| `phase` | When | Notable fields |
| --- | --- | --- |
| `decision` | a seat was considered but not reaped, or observe mode would reap | `decision`, plus the idle/threshold minutes and the eligibility snapshot when eligible |
| `capture` | the resume snapshot was persisted, immediately before any stop | `sessionId`, `resumeToken`, `resumeType` |
| `effect` | a checked stop was attempted | `result`, `stopPhase`, `budgetConsumed`, `attentionRequired` |
| `terminal` | the reaper self-terminated | `decision`: `reap-cap`, `failed-passes` or `stop_uncertain` |

Decision values are `would-reap-observe`, `pending-work`, `dirty-workspace`,
`defer-probe-failed`, `ineligible`, and the terminal reasons above. The same
`events` ledger that records `session.stopped` carries the receipts; no separate
notification is sent per seat in this slice.

## Circuit breaker and escalation

- After `max_reaps_per_24h` stops that consumed effect (a completed stop or a
  partial effect) in the rolling 24 hours, the reaper ends its pass, records a
  `terminal` receipt with `reap-cap`, and stops its job. The terminal state is
  durable across restarts.
- Three consecutive failed passes (repeated probe or stop failures) similarly
  self-disable with a `failed-passes` terminal receipt, so the job never loops on
  a broken precondition.
- A `stop_uncertain` result ends the pass immediately with a `stop_uncertain`
  terminal receipt and marks that seat `attention_required`.

Self-termination is a safety stop, not a crash. To restore reaping after an
operator has investigated, clear the control row in the daemon database
**while the daemon is down**, then start the daemon again — the terminal
reason is read once per pass and latches an in-memory `ended` flag that the
daemon caches until restart:

```sql
UPDATE seat_reaper_control SET terminal_reason = NULL WHERE singleton = 1;
```

Clearing the row alone does not restore reaping: the running daemon keeps
its `ended` flag and rejects `start()` after self-termination. There is no
CLI verb for this in this slice; the breaker reset is a deliberate operator
action.

## Rollout and recovery

1. Keep `enabled` off until queue-driven cold start is deployed. Without a return
   path, a reaped seat would strand addressed work until it is launched by hand.
2. Turn the feature on for a small set of rigs with `observe` still on and confirm
   `would-reap-observe` receipts appear with the expected eligibility snapshots.
3. Flip `observe` off for enforcement once the observe log is clean and the cold
   start path exists.

To disable immediately, set `policies.seat_scale.enabled` to `off`; the next pass
resets every clock. A reaped seat can be returned with the existing launch/restore
verbs (`rig up <rig> --existing`, or a seat launch) until cold start handles it
automatically.
