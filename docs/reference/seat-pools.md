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
It then moves waiting rows to free agents and adds agents, in that order.

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
  the difference, limited to the room left under `max` (every slot except a `drained` one takes room). Each agent is
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
    a pool agent does not carry, or while the model's member `startup` files can't be resolved from its launch root;
  - `n` is one more than the highest slot number on record, skipping a logical id the rig already has. An add that
    ends with no node removes its slot row, which frees its number;
  - the add is reserved and issued under the model's custody lease, with an operation id, and runs after the lease is
    released; the evaluation that issued it reports `in flight (attempt <id>)`, and so does every later one while it
    has not settled, without issuing it again. A later evaluation reports how it settled: `running`, or `no_node`
    with the add's code;
  - while a slot is `drained`, no new number is added, and the notes report `held: drained slot awaiting comeback`
    for the add only: rows still move.
- **Latency.** The job runs every 60 seconds, so a row that has waited `dispatch_after_s` is considered by the next
  evaluation, up to one more interval later, before it is moved and before an agent is added. That is not a dispatch
  deadline: a row moves only to an agent that is
  free when it is checked, so with more waiting rows than free agents, the rest stay pending for later evaluations.
- **Holds.** The whole pool is held, and nothing is moved or added, while:
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
gone, its job moves nothing and reports `held: model node gone`.

## What the job does not do yet

It does not drain agents or bring drained agents back. An add that creates its node but does not settle running (the
agent failed to start, needs attention, or its state is unknown) stays in flight; nothing yet settles it, and an add
cut off by a daemon restart is not resumed. An add that settles running after `rig down` keeps running.
