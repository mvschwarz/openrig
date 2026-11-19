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
- **Latency.** The job runs every 60 seconds, so a row that has waited `dispatch_after_s` can wait up to one more
  interval of the job before it is moved.
- **Holds.** The whole pool is held, and nothing is moved, while:
  - the job is not `active` (stopped by an operator, or ended);
  - the stored block can't be read (the notes carry an advisory; nothing is removed);
  - the rig's latest `rig.stopped` has no `restore.completed` after it. Any later `restore.completed` ends the hold,
    whatever its result. A `rig up` refused before it starts (`not_attempted`), a restore that throws and
    `rig launch --seats` do not end it; the next `rig up` that completes does. After `rig launch --seats`, run
    `rig down`, then `rig up`.

  Each evaluation records the cause in the job's notes, for example `held: rig stopped (event 42)`.

### When the model node is deleted

Deleting a model node removes its slot rows but leaves its agent nodes and sessions as ordinary members of the rig,
so their pool association and any phase or hold kept only on a slot go with it. Recreating a model with the same name
doesn't recover its former slot numbers. While the model node is gone, its job moves nothing and reports
`held: model node gone`.

## What the job does not do yet

It does not add agents, drain them or bring drained agents back.
