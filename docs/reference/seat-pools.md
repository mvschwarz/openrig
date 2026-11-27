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
  `cooldown_s` after the latest drain. Each agent added first brings back the lowest-numbered eligible `drained` slot
  (see *Bringing a drained agent back*), and that counts as one add; only when no eligible slot is left is a new
  number taken. Each new agent is named `<member>-s<n>`, added the same way as `rig add`, and launched right away:
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
    | `running` | The agent's latest session runs (or is idle) with its startup `ready`, and the add's call, if it returned, launched it. | `live`; from there it serves and drains like any other agent, and above `max` it receives no row. |
    | `no_node` | No node was created, with the add's code (for example `preflight_failed`). | Removed, which frees its number. |
    | `not_running` | The node exists but does not run: its latest session `exited`, or its executor is confirmed stopped (`probe_absent`), in `attempt.observed`; with the launch's error when the add's call returned. | `drained`, with a reuse hold (JSON `{ code, observed, error? }`: the launch's status or code, or `not_running` when the call never returned; what was observed; the launch's error, if any): never tried again, and it takes no room under `max`. Reported in `slots` every evaluation. |
    | `attention_required` or `left_attached` | The add's call returned anything but a launch (`attention_required`, `left_attached`, or a failure) while the agent's latest session runs (or is idle). `left_attached` is reported as such; anything else as `attention_required`, with the launch's status or code in `code` when it is another one (for example `failed`). | `live` and held, with a reuse hold (JSON `{ code, error? }`): it takes room under `max`, but it is not free, receives no row and is never drained by the pool. Reported in `slots` every evaluation, until a later change on its node ends the hold (see *A held slot and a later change*). |
    | `unknown` | Anything else (startup not ready, or no session yet), with what was read. | Stays `adding` and issued, read again every evaluation until it settles; never issued again, never stopped, and no other free agent is drained because of it. |

  - after a daemon restart, an attempt that no process runs any more is settled by the next evaluation: a reservation
    that was never issued is cancelled (`cancelled: not issued`), and an issued add is read again by replaying its
    operation id with what it was issued on, which never runs the add again. With no node recorded, its slot row goes
    and it is reported `no_node`, `not launched (interrupted before create)`; with a node, it settles by the table
    above. What settles this way is reported with the evaluation's other settlements, and kept in the job's history;
    an add it settles `not_running` drains its slot (see the cooldown below);
  - a drain step newer than the plan's read, as an add that settles `not_running` here or while the moves await
    starts, holds that evaluation inside the `cooldown_s` after it: its drains (read before the moves) and its add
    (read again right before it), comebacks included (`add.skipped: cooldown`), wait, except under `drain: true`;
    rows still move;
  - while an add that settled `not_running` keeps its slot `drained` with its reuse hold, no new number is taken: an
    evaluation whose add would take a new number (no eligible `drained` slot left to bring back) reports `add.held`
    (`held: failed add <id> (slot <n>) settled not_running (<observed>)`), and `add.failedAdd` names that attempt, its
    slot and its reuse hold, with no limit on how many; when no add runs (the pool is at its target or at `max`, or
    inside a cooldown), the hold shows only in that slot's `reuseHold` under `slots`. Rows still move, and the other
    eligible `drained` slots still come back, outside a cooldown. An ordinary `drained` slot, a comeback's reuse hold
    and an `unknown` add hold no new number.
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

  A drained agent keeps its node, its sessions and its history: nothing is removed. `rig up` leaves it stopped until
  the pool brings it back.
- **Bringing a drained agent back.** A `drained` slot is eligible while it has no reuse hold. The add brings the
  lowest-numbered eligible slot back on its own node, under its own name, with its own sessions and stored settings,
  in the folder recorded in the snapshot it comes back from:
  - the snapshot is the newest one, of any kind, that is restore-usable, holds the slot's node with its logical id in
    its intended topology, and recorded exactly one active occupant for that node (a running session; in an
    `auto-rehydrate` capture, the retained session that has not exited). The drain's own capture qualifies; a snapshot
    taken before the agent existed, or an `auto-periodic` one taken after it stopped, does not;
  - the comeback is reserved on the slot's own row and issued under the model's custody lease, and after the lease is
    released the agent is launched through `launchSingleNode` with that explicit `snapshotId`, never without one, so
    the automatic ranking (which prefers `auto-periodic` snapshots) never picks it. The agent's own restore setting
    decides whether its conversation resumes (`resume_if_possible` with a usable token) or it starts fresh
    (`relaunch_fresh`);
  - with no qualifying snapshot, nothing is launched and the slot stays `drained` with the reuse hold
    `no_qualifying_snapshot`, the node id, how many snapshots were read and the condition (1: restore-usable, 2: holds
    the node, 3: one active occupant) each one failed. The add then tries the next eligible slot, or a new number
    unless an add that settled `not_running` holds new numbers (see *Adding agents*);
  - a newer capture that passes conditions 1 and 2 and whose own occupant map recorded two or more live occupants for
    the node (candidates whose captured sessions were running) stops the search for that slot: no older snapshot is
    picked over it, nothing is launched, and the slot stays `drained` with the reuse hold `conflicting_occupants`,
    naming that snapshot and its candidate session ids, with the snapshots read before it. Only that slot is held: the
    add tries the next eligible slot, or a new number unless an add that settled `not_running` holds new numbers. A
    node recorded absent, and an occupancy the metadata can't tell (a legacy relation, or candidates that were not
    running at capture, as after a reboot), fail condition 3 and the
    search goes on; an unknown occupancy is named (`unknown` on its failed condition, and `unknownOccupants` on the
    comeback issued from an older snapshot) and skipped;
  - a launch refused before it starts (`snapshot_not_found`, `snapshot_wrong_rig`, `snapshot_unusable`,
    `no_matching_nodes` or `selection_changed`) is reported `refused` with its code, and the slot goes back to
    `drained` with that code and the snapshot as its reuse hold: the same snapshot is never sent again. A comeback that
    is held or refused keeps the drain's time, so it does not restart the `cooldown_s`;
  - just before its issue, under the same lease, the comeback is checked as an add is: the job, the holds and the stored
    block again, and a new plan with the reservation counted. A stopped job, a `rig.stopped`, a lower `max`, `drain:
    true`, any other change to the block, or surplus that reaches the reservation cancels it: nothing is launched, the
    slot is `drained` again with no reuse hold (so it stays eligible), and the notes report it under `add.cancelled` as
    `cancelled: not issued`, with the cause in `code`;
  - right before its launch, the comeback reads the job and the rig again: with the job stopped or the rig down, it is
    never launched, the slot is `drained` again with no reuse hold, and the comeback is reported `refused` with the
    code `held`;
  - a launch on the slot's node that does not run is never repeated. It is reported in `attempt.status`, never as a
    stop, and the slot keeps a reuse hold (JSON `{ code, snapshotId, error? }`, the code being the launch's status for
    the node):

    | Launch status for the node | `attempt.status` | The slot |
    | --- | --- | --- |
    | `awaiting-decision`, or `failed` with no session of the node running afterwards | `not_running`, with the status in `code` and the launch's error in `message` (for a pod-aware agent with no runtime adapter, the error names `rig seat launch <seat> --fresh`) | `drained` and held: it takes no room, and the other eligible slots or a new number go on within `max`. A rolled-back launch leaves the node's earlier session and binding as they were. |
    | `attention_required`, `left_attached`, or `failed` while a session of the node still runs | `attention_required` (with `failed` in `code` for a failure) or `left_attached` | `live` and held: it takes room, but it is not free, receives no row and is never drained by the pool. |

    A launch that finds a live session already on the node (one the pool did not start and that is not proven to be an
    agent: the node is in `alreadyRunning`, nothing was launched) is reported `already_running`, and the slot is `live`
    with no hold. It takes room like any agent and is free only once idle at its prompt. Neither a hold nor this records a
    new event per evaluation;
  - a comeback whose launch call returned something else (another refusal, or an error) stays `adding` and issued with
    what it returned, is reported `in flight` with that code, and `unknown` in every later evaluation; it is never
    launched again;
  - after a daemon restart, a comeback no process runs any more is read again from the `restore.subset_completed` that
    its launch records before it returns: the newest one after what it was issued on, for its snapshot, that names its
    node settles it by the table above (or `running`, while its session reads ready). Without one, a session on the node
    newer than the one it was issued on settles it as a later change does (see *A held slot and a later change*). With
    neither, it stays `adding` and issued, reported `unknown`: it takes room and is never launched again;
  - a comeback that runs is reported `running`, with the `snapshotSelection` it was launched from (`mode:
    "explicit"`), and the slot is `live` again. It comes back with its own stored settings, never the model's: the
    model, effort, Codex profile and permission posture follow the slot's latest saved choices, as in any restore.
    Its folder is the one that snapshot recorded (the stored one only when it recorded none): a `rig seat set-cwd` on the slot after that capture does not reach the
    comeback; it is used only by the slot's next fresh launch (`rig seat launch --fresh --stop`, or `rig handover
    --source rebuild`; see [Change an existing seat's working
    directory](agent-startup-guide.md#change-an-existing-seats-working-directory));
  - when the slot's stored settings differ from the model's, the report of a comeback that runs carries a warning
    naming the fields that differ (`cwd` is compared only without `cwd_template`, when the slot took the model's
    folder). The warning compares the slot's stored settings: a `cwd` set after the capture is compared at its new
    value while the agent comes back in the captured folder;
  - every evaluation reports a slot's reuse hold with the slot.
- **After `pool: {}`.** Clearing the block on re-apply leaves the job running: it drains the free agents with the
  block it was last ensured with (`context.pool`), leaves busy agents `live` until they are free, and ends
  (`terminal`) once every agent is `drained` and the block is still absent. A `live` agent positively gone (its latest
  session `exited`, or its node confirmed stopped) with no work is drained by the checked stop for its recorded session,
  with no capture; an unknown or stale status is not gone.
- **Holds.** The whole pool is held, and nothing is moved, drained, added or brought back, while:
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

### A held slot and a later change

A reuse hold on a `drained` or a `live` slot is kept across evaluations, daemon restarts, and `rig down` then `rig up`
(a `drained` slot stays down there, as any drained pool agent; a held `live` slot is restored as any member). The pool
never launches that slot again. With the hold, the slot records what the hold is measured from: the node's latest session
then (its id, status and startup status; a session a launch rolled back, `superseded`, is never taken as the latest) and
the rig's latest event. Each evaluation reads every held slot again before it plans, under the model's custody lease, and
only a later change on the slot's node ends the hold. The evaluation reports what changed under `laterChanges` (the slot,
the session, how it read, and the slot's phase and hold after it):

- a restore since the hold that launched the node (a `rig up`, or `rig launch --seats`) and did not run gives the slot
  that outcome, as a comeback's launch would (`read: restore`), unless the node's latest session reads ready;
- otherwise a session newer than the recorded one (someone's `rig seat launch --fresh`, a `rig launch --snapshot-id`, a
  resume by hand) is a change, and so is, for a held `live` slot, a new status or startup status on the recorded session
  (as `rig seat continue` gives when it reruns startup) or its executor confirmed stopped. For a held `drained` slot,
  the recorded session counts only when it is resumed (it reads ready or needing attention); marked down or detached,
  it is no change. A `restore.outcome_reconciled` alone changes nothing.

The node's latest session then decides:

| The latest session | `read` | The slot |
| --- | --- | --- |
| Runs (or is idle) with startup `ready`, and its executor is not confirmed stopped | `ready` | `live`, with no hold: it serves, and drains, like any agent. If that leaves the pool above what it wants, surplus drains free agents, newest first. |
| Exited, or its executor is confirmed stopped | `absent` | `drained` and eligible, with no hold; except a hold that awaits a decision (`awaiting-decision`) while no session since the recorded one reached `ready`: the slot stays held, now measured from that session. A held `live` slot that becomes `drained` this way counts as a drain step for `cooldown_s`. |
| Runs (or is idle) with a startup that needs attention or failed | `attention` | `live` and held (`attention_required`, or `failed`): it takes room, is not free and receives no row. |
| Anything else (for example a startup still pending) | `unknown` | Back in `adding`, its last attempt issued again and reported `unknown`, with the hold it had: it counts as an unknown result (it takes room and no other free agent is drained because of it), nothing is launched, and every evaluation reads it again by the node's latest session (and by a restore since then), until it reads one of the rows above. |

The change writes no event, and nothing is stopped. After `pool: {}`, a held `live` slot keeps the job running until a
later change ends its hold: the pool never drains it.

### When the model node is deleted

Deleting a model node removes its slot rows but leaves its agent nodes and sessions as ordinary members of the rig,
so their pool association and any phase or hold kept only on a slot go with it. Recreating a model with the same name
doesn't recover its former slot numbers, and the next add skips a logical id the rig still has. While the model node is
gone, its job moves, drains, adds and brings back nothing and reports `held: model node gone`.

## What the job does not do yet

An add whose node was created but has no session when the daemon restarts stays `unknown`: nothing launches it again,
and deleting that node removes its slot row, which frees its number. The pool does no live terminal probe of its own: a
session "present" is one whose executor is not confirmed stopped. An add, or a comeback whose launch had already started,
that settles running after `rig down` keeps running.
