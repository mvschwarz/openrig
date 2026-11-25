# Seat pools

A member with a `pool` block in its rig spec is the model of a seat pool: extra agents cloned from it, named
`<member>-s<n>`. The block itself is described in [Rig spec: Seat pool](rig-spec.md#seat-pool-pool). This page
describes the watchdog job that acts on it.

## Status: the job is not armed yet

The daemon accepts `seat-pool` as a watchdog policy and has the code that registers the job, but nothing calls that
code yet, and the watchdog engine does not run the policy:

- launching a rig, re-applying a spec and starting the daemon register no `seat-pool` job;
- a `seat-pool` job registered by hand (`rig watchdog register --policy seat-pool`) is marked `terminal` with
  `unknown_policy:seat-pool` at its first evaluation, and that evaluation is recorded in the job's history; it does
  not read the pool or touch its agents.

The job is armed by a later change. Until then a `pool` block is stored and validated, and nothing else happens.

## The job

Once armed, the daemon keeps one `seat-pool` job for each model member with a usable `pool` block:

- **Target:** the model member's canonical session (`<pod>-<member>@<rig>`), with no generation, registered by
  `daemon@kernel`. The member's other canonical session names in the same rig count as the same target.
- **Spec:** the model's node id (`context.model_node_id`) and the pool block the job was last ensured with
  (`context.pool`). The job finds the pool's agents through the model node, not through a list of its own, so a
  replacement job finds the same agents.
- **Interval:** 60 seconds.

Each time the daemon ensures the job (on launch, on re-apply and at daemon start, once armed):

| The model's job | What happens |
| --- | --- |
| `active` | It gets the current block and keeps running. |
| `stopped` | It gets the current block and stays stopped. The daemon never restarts a job an operator stopped. |
| `terminal`, or none | One new job is registered. |
| More than one `active` or `stopped`, or a row in an unknown state | Nothing is registered or retired, and the state is reported; at daemon start, as a warning that names the node and the job ids. |

A member with no `pool` block never gets a job. A stored block that can't be read leaves the job as it is. At daemon
start each model is ensured on its own, so one that fails is reported and the others still are.

Stopping a `seat-pool` job (`rig watchdog stop`) is allowed while the pool has agents. The agents stay as plain
members of the rig.

## What the job does each time it runs

Once armed, each evaluation of the job reads the pool afresh: the model's stored block, its slot rows, each pool
agent's latest session, its activity, its open rows and its held messages, and the rows waiting for the model.
It then moves waiting rows to free agents, and either adds agents or drains the free agents above what it wants (one
plan never asks for both; an earlier drain's unconfirmed stop can still be tried again alongside an add). Under
`drain: true`, nothing is moved or added.

- **Moving waiting rows.** A pending row addressed to the model (with `dispatch_tag`, only a row carrying the tag) that
  has waited `dispatch_after_s` is moved to a free pool agent: in phase `live`, its latest session running, idle at its
  prompt, with no open row and no held message. The check is repeated just before the move, under the model's custody
  lease, and the move only happens while the row is still pending and still addressed where it was read. A row
  claimed or rerouted in between is skipped and named in the job's notes; it is not a failure. The stored block is
  read again before each move: when a re-apply has changed it since the evaluation planned (any value, cleared or
  unreadable), that move and the rest are skipped with `pool_block_changed`, and the next evaluation plans against the
  block as it is then.
- **Rows left with a drained agent.** A pending row addressed to a `drained` pool agent, under any of its names, is
  moved to a free pool agent the same way, whatever its tags.
- **Adding agents.** The job keeps the pool at a target: the larger of `min` and the demand, capped at `max` (0 under
  `drain`). The demand is the busy agents plus the rows that have waited `dispatch_after_s` and found no free agent,
  and it is never below the busy agents plus the agents still starting. Agents that run and agents still starting
  (phase `adding`) both count toward the target, so an add already reserved or issued is not repeated. The job adds
  the difference, limited to the room left under `max` (every slot except a `drained` one takes room), outside the
  `cooldown_s` after the latest drain. Each agent is
  named `<member>-s<n>`, added the same way as `rig add`, and launched right away:
  - it takes the model member's launch settings as the rig export writes them, without `pool`, `id`, `label`, `cwd`
    and `session_source`, and its launch additions are copied from the model; it starts without the model's
    conversation. Its member `startup` files resolve from the model's launch root, also when the rig export leaves
    them out because that root is not the rig's stored root;
  - it is never kept alive, whatever the model or its agent spec says about `keep_alive`;
  - it works in the model's folder or, with `cwd_template`, in the template's folder with `{rig}` (the rig's name)
    and `{slot}` (the agent's member id, such as `impl-s1`) filled in; the daemon only creates that folder;
  - no agent is added, and the notes say why (`add refused: …`), while the model's stored `process_limits` or
    `claude_auto_mode` can't be read, or while the model has an `accountHome` or an `api-key` token reference, which
    a pool agent does not carry, or while the model's declared member `startup` can't be read or its files can't be
    resolved from its launch root;
  - `n` is one more than the highest slot number on record, skipping a logical id the rig already has. An add that
    ends with no node removes its slot row, which frees its number;
  - the add is reserved and issued under the model's custody lease, with an operation id, and runs after the lease is
    released. Just before the issue, under the same lease, the evaluation reads the job, the holds and the stored
    block again and plans again with the reservation counted: a lower `max`, `drain: true`, any other change to the
    block, a hold (such as a `rig.stopped` recorded since the plan) or surplus that reaches the reservation cancels
    it. A cancelled add has no operation row and is never called; its slot row goes, and the notes report it under
    `add.cancelled` as `cancelled: not issued`, with the cause in `code`;
  - the evaluation that issued the add reports `in flight (attempt <id>)`, and so does every later one while its call
    has not returned, without issuing it again. `max` dropping meanwhile does not cancel or drain an issued add: it
    settles first. A later evaluation reports how it settled, in `attempt.status` (never as a stop), from the node's
    latest session:

    | `attempt.status` | When | The slot |
    | --- | --- | --- |
    | `running` | The agent's latest session runs (or is idle) with its startup `ready`. | `live`; from there it serves and drains like any other agent, and above `max` it receives no row. |
    | `no_node` | No node was created, with the add's code (for example `preflight_failed`). | Removed, which frees its number. |
    | `not_running` | The node exists but does not run: its latest session `exited`, or its executor is confirmed stopped (`probe_absent`), in `attempt.observed`; with the launch's error when the add's call returned. | `drained`, with a reuse hold (JSON `{ code, observed, error? }`: the launch's status or code, or `not_running` when the call never returned; what was observed; the launch's error, if any): never tried again, and it takes no room under `max`. Reported in `slots` every evaluation. |
    | `unknown` | Anything else (startup not ready, no session yet), with what was read. | Stays `adding` and issued, read again every evaluation until it settles; never issued again, never stopped, and no other free agent is drained because of it. |

  - after a daemon restart, an attempt that no process runs any more is settled by the next evaluation: a reservation
    that was never issued is cancelled (`cancelled: not issued`), and an issued add is read again by replaying its
    operation id with what it was issued on, which never runs the add again. With no node recorded, its slot row goes
    and it is reported `no_node`, `not launched (interrupted before create)`; with a node, it settles by the table
    above. What settles this way is reported with the evaluation's other settlements, and kept in the job's history;
  - while a slot is `drained`, no new number is added, and the notes report `held: drained slot awaiting comeback`
    for the add only: rows still move.
- **Latency.** The job runs every 60 seconds, so a row that has waited `dispatch_after_s` is considered by the next
  evaluation, up to one more interval later, before it is moved and before an agent is added. That is not a dispatch
  deadline: a row moves only to an agent that is
  free when it is checked, so with more waiting rows than free agents, the rest stay pending for later evaluations.
- **Draining free agents.** When the pool holds more agents than it wants (above `min` and the work waiting, or every
  agent under `drain: true`), the extra free agents are drained, the newest first. An agent drains only once it has
  sat free and idle at its prompt for `idle_grace_s`, and outside the `cooldown_s` after the latest drain. Under
  `drain: true` the cooldown is skipped but the grace is not: each agent drains only after it has been free and idle
  for `idle_grace_s`. That is the behaviour at this stage. A drain:
  - decides under the model's custody lease, checking the agent again, and marks its slot `draining`;
  - then, under the agent's lifecycle lease, reads the agent again: a row or a held message that reached it, or a
    wake since the evaluation read it, sends the slot back to `live` and nothing is stopped; an agent relaunched since
    then is left alone;
  - refreshes the agent's resume metadata, as `rig down` does before its snapshot. The refresh is best-effort: one
    that fails still captures and stops;
  - captures an `auto-rehydrate` snapshot of the rig while the agent still runs, right before the stop. A capture that
    fails stops nothing: the slot stays `draining` for that evaluation and goes back to `live` in the next;
  - stops the agent with the checked seat stop (the seat stop given an expected node and session), which stops it
    only while its latest session is still the one the evaluation read. Right before each of its effects, after its
    liveness probe, the stop runs the drain's recheck, which reads again the job, the rig and model holds, the pool
    block, and the agent's rows, held messages and activity; stopping again after an earlier attempt also needs the
    pool to still have surplus. An agent whose recorded status is not running keeps nothing only when it is
    positively gone (its latest session exited, or confirmed stopped); an unknown or stale status keeps it, as do rows
    and held messages. What keeps the agent stops nothing. Refused before the detach, a fresh drain whose
    agent got work or woke goes back to `live`, and any other refusal leaves the slot `draining` for that evaluation
    and gives it back to `live` in the next; a retry refused this way leaves the slot `draining` with the earlier
    attempt on record, and the stop is tried again later. Refused between the detach and the kill, the agent is left
    detached and running, the stop is `unconfirmed`, and the slot stays `draining` with the attempt on record; a
    later evaluation stops that session once the agent is free and the pool still has surplus.

  What the stop returned goes in the notes as `stop.result`, never two at once:

  | `stop.result` | When | The slot |
  | --- | --- | --- |
  | `stopped` | The stop succeeded. | `drained` |
  | `absent` | The stop found the session absent in tmux (`session_not_live`, or a `keep_alive` seat already down): a confirmed absence, not a stop. | `drained` |
  | `changed_owner` | The seat or its latest session changed before anything was stopped (`selection_changed`). | `live` |
  | `unconfirmed` | Anything else, with the real code and message (for example `stop_uncertain`). | `draining`. When the stop attempted a kill, the next evaluation stops the same session again, with no new capture, once the agent is free and the pool still has surplus (an agent that still runs and got work or a wake is not stopped); a session relaunched since is `changed_owner`. When the stop had no effect, the next evaluation gives the slot back to `live`, and a later drain starts again with a new capture. |

  A drained agent keeps its node, its sessions and its history: nothing is removed. `rig up` leaves it stopped.
  Bringing a drained agent back is done by a later change.
- **After `pool: {}`.** Clearing the block on re-apply leaves the job running: it drains the free agents with the
  block it was last ensured with (`context.pool`), leaves busy agents `live` until they are free, and ends
  (`terminal`) once every agent is `drained` and the block is still absent. A `live` agent positively gone (its latest
  session `exited`, or its node confirmed stopped) with no work is drained by the checked stop for its recorded session,
  with no capture; an unknown or stale status is not gone.
- **Holds.** The whole pool is held, and nothing is moved, drained or added, while:
  - the job is not `active` (stopped by an operator, or ended);
  - the stored block can't be read (the notes carry an advisory; nothing is removed);
  - the rig's latest `rig.stopped` has no `restore.completed` after it. Any later `restore.completed` ends the hold,
    whatever its result. A `rig up` refused before it starts (`not_attempted`), a restore that throws and
    `rig launch --seats` do not end it; the next `rig up` that completes does. After `rig launch --seats`, run
    `rig down`, then `rig up`.

  Each evaluation of an active job records the cause in the job's notes, for example `held: rig stopped (event 42)`,
  unless the watchdog engine defers it (`rig_delivery_drain`): that evaluation records nothing, even if rows have
  already moved. A stopped job records no note either: the scheduler evaluates only active jobs, and the watchdog
  engine returns `job_not_active`, with no history, when the job is no longer active before the policy runs or after
  it returns. So a job stopped during an evaluation records nothing; the executor's own check only stops the moves
  and adds left in that evaluation.

### When the model node is deleted

Deleting a model node removes its slot rows but leaves its agent nodes and sessions as ordinary members of the rig,
so their pool association and any phase or hold kept only on a slot go with it. Recreating a model with the same name
doesn't recover its former slot numbers, and the next add skips a logical id the rig still has. While the model node is
gone, its job moves, drains and adds nothing and reports `held: model node gone`.

## What the job does not do yet

It does not bring drained agents back, and while a slot is `drained` (an add that settled `not_running` included) it
adds no new number. An add whose launch failed or needs attention while its session still runs is reported `unknown`
and stays issued; nothing yet settles it. An add that settles running after `rig down` keeps running: the pool does not
yet stop an add it issued before the rig went down.
