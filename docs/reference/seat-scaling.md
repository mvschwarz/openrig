# Managed seat scaling (idle-seat reaping)

The daemon can reclaim the memory of a seat that has been provably idle for hours.
Part 1 of [mvschwarz/openrig#2829](https://github.com/mvschwarz/openrig/issues/2829)
stops the runner while keeping its tmux pane and conversation. New queued work
can resume that exact conversation in the same pane. A person's `rig seat stop`
or `rig down` keeps the seat off; queued work does not undo either command.
Reaping remains disabled by default. Part 2's idle-stop policy changes are not
shipped here; the eligibility and configuration below still apply.

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
   reason `idle_reap`. Standby is recorded only after the selected runner is gone
   and the original pane is verified dead. On `stop_uncertain` the
   pass ends at once, the seat is marked `attention_required`, and the seat is
   never retried blind.
3. **Receipt.** A second `seat.reaped` event with `phase: "effect"` records the
   stop result, its `stopPhase`, and whether the reap consumed the breaker
   budget.

The session record, conversation, pane and scrollback, state directory and
workspace survive. `rig seat status` and `rig ps --nodes` distinguish standby from
an explicit stop. Standby does not degrade an otherwise running rig. A rig with
only standby seats reports zero running seats, but queued work can still resume one.

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

1. Turn the feature on for a small set of rigs with `observe` still on and confirm
   `would-reap-observe` receipts appear with the expected eligibility snapshots.
2. Turn `observe` off to enforce once those receipts match what you expect.

To disable immediately, set `policies.seat_scale.enabled` to `off`; the next pass
resets every clock. Work remains queued if the automatic resume cannot bring the
seat back. Inspect the seat's status before choosing an explicit launch or restore.
