# What changed in OpenRig 0.7.22

This note is for an agent on an install that was just upgraded to 0.7.22.
OpenRig 0.7.22 is a patch for a useful first result, responsive coordination and state that tells the truth. A person's own agent can wait for its task's answer in the background and hand work on with its route. The daemon does less repeated work in several queue and status reads. More status says unknown or not applicable instead of guessing. It also fixes a run of smaller recovery, queue, Slack, terminal and CLI problems.

## Before you upgrade

Run the upgrade in the environment that owns your daemon, keeping the same `OPENRIG_HOME` (legacy `RIGGED_HOME`) if you set it. Stop the daemon, back up its database, install the patch, then restart it. Your agents keep running; do not use `rig down` for this upgrade.

If the daemon was started with `--db`, or with `OPENRIG_DB` (legacy `RIGGED_DB`) set differently from this shell, replace the `DB=` line below with that actual database path. Pass the same `--db "$DB"` to every `rig daemon start`, including recovery; `rig config get db.path` reads this shell's configuration, not the running daemon's launch arguments or environment.

```sh
DB="$(rig config get db.path)" &&
STOP="$(rig daemon stop)" && printf '%s\n' "$STOP" &&
{ printf '%s\n' "$STOP" | grep -qx 'Daemon stopped' || { echo "The stop wasn't confirmed clean; see below before continuing." >&2; false; }; } &&
BACKUP="$DB.before-0.7.22-$(date -u +%Y%m%dT%H%M%SZ)" &&
{ [ ! -e "$BACKUP" ] || { echo "$BACKUP already exists; keep it and run again." >&2; false; }; } &&
cp "$DB" "$BACKUP" &&
{ [ ! -e "$DB-wal" ] || cp "$DB-wal" "$BACKUP-wal"; } &&
npm install -g @openrig/cli@0.7.22 &&
rig daemon start --db "$DB"
```

A failure stops the following commands; fix it before continuing. Back up and install only after `rig daemon stop` prints the line `Daemon stopped`: that is the stop outcome that confirms a clean shutdown. Its other success line, “No daemon target recorded; listener refused. Nothing to stop; prior drain not certified.”, means this stop has no recorded target. It does not prove that no daemon exists or that the last one shut down cleanly. A `Daemon stopped` from `rig daemon status` does not confirm a clean shutdown either.

If the stop failed or had no recorded target, make sure the daemon is running on its original home and database (start it with `rig daemon start --db "$DB"` if `rig daemon status` does not say it is running), then run the whole block again. If the stop is still unconfirmed, use `daemon-shutdown.json` and `daemon.log` in your OpenRig home, together with `rig context get help`, to resolve the reported problem before retrying. Do not continue to the backup or install on an unconfirmed stop.

A clean stop after restarting confirms only the new daemon’s shutdown, not whether earlier unfinished actions completed. Each stop replaces `daemon-shutdown.json`; look in `daemon.log` for earlier shutdown failures.

This release adds no database migration. Coming from 0.7.19 or earlier, 0.7.20's three additive migrations (`176_node_statusline_throttle`, `177_workflow_bound_pod` and `178_seat_pool`) apply at the first start; keep the backup, because downgrading a migrated database is not established. Bundled `openrig` is 0.7.22; `openrig-core` is 0.1.36.

## A person's agent and first answers

The `rigs` skill tells a person's agent to wait in the background for a task at its address, claim each pending task when the wait ends and wait again, and hand on the goal row itself so its return route follows. A task created without a return route takes the route of the one open routed task its creator holds; with two such routes it gets none. This release ships that guidance and route; it doesn't claim a measured change in how agents behave. ([#3656](https://github.com/mvschwarz/openrig/pull/3656), [#3655](https://github.com/mvschwarz/openrig/pull/3655))

`rig_queue_show` takes an optional `waitSeconds`, so an agent can wait for one task's answer in the same read. It waits only while the task is open, returns other states at once, and says when it timed out. `GET /api/queue/:qitemId?waitSeconds=<bound>` offers the same wait. ([#3526](https://github.com/mvschwarz/openrig/pull/3526))

`rig mcp token add <name> --seat <seat> --person <entity_id>` binds a token-file grant to a registered person. That connection is offered `rig_question_list` and `rig_question_answer` for that person's questions, beside its seat's own tools. It extends the existing optional MCP connection. ([#3527](https://github.com/mvschwarz/openrig/pull/3527))

`rig_team` shows a network participant as remote with its check-in. A short destination name that doesn't resolve names the full address when one seat matches, or says it's ambiguous. ([#3672](https://github.com/mvschwarz/openrig/pull/3672))

The project list (`GET /api/scopes/projects`) includes each catalogued project's declared rigs, stopped ones included. An ESM host can import `@openrig/cli/mcp.js` to start and close the HTTP MCP endpoint; the older paths still work. ([#3671](https://github.com/mvschwarz/openrig/pull/3671), [#3682](https://github.com/mvschwarz/openrig/pull/3682))

## Responsive coordination

A queue list page names its handed-off rows' successors from one batched read, with list and show sharing it and their output unchanged. The stuck sweep reads a seat's chained successors from a bounded range instead of its whole history. `/api/ps` builds node inventory only for the rigs it returns, and `/api/ps/resources` counts running seats only from running rigs, with the same output. Completing a mission no longer waits on rebuilding the slice listing. These narrow particular slow reads; they aren't a release-wide speed-up. ([#3666](https://github.com/mvschwarz/openrig/pull/3666), [#3689](https://github.com/mvschwarz/openrig/pull/3689), [#3646](https://github.com/mvschwarz/openrig/pull/3646), [#3356](https://github.com/mvschwarz/openrig/pull/3356))

The slow-operation log names eight full queue scans that still run on the daemon's main thread. This shows where a read is still blocking; it doesn't fix those reads. ([#3687](https://github.com/mvschwarz/openrig/pull/3687))

`rig start --concurrency N` runs up to N restores from one command at once; the default stays one at a time. A request that times out may keep running in the daemon. ([#3336](https://github.com/mvschwarz/openrig/pull/3336))

`rig up --timeout <seconds>` sets how long the CLI waits for the whole launch, restore or plan; timing out doesn't cancel it. A remote apply that times out reads unknown and names `rig ps --host` to check. The daemon's own start budget is unchanged. ([#3608](https://github.com/mvschwarz/openrig/pull/3608))

`daemon.identity_poll_interval_ms` sets the identity reconciler's cadence at startup (default 5000 ms). It caps the cadence; it isn't a freshness deadline. ([#3648](https://github.com/mvschwarz/openrig/pull/3648))

## State that tells the truth

A seat at its usage limit reads unknown with the reset time it reported, never working. This reports the limit; it doesn't recover the account. ([#3510](https://github.com/mvschwarz/openrig/pull/3510))

Proof readiness counts active slices and missions, so no active work reads apart from work that isn't ready. TUI execution lines whose source is absent read as not applicable, never as a failure. A policy edit that keeps a judge listed and `everyJudge` unchanged leaves earlier judgments current. ([#3620](https://github.com/mvschwarz/openrig/pull/3620), [#3624](https://github.com/mvschwarz/openrig/pull/3624), [#3629](https://github.com/mvschwarz/openrig/pull/3629))

`rig stream show` says when an item reached intake and names the intake row that holds it. ([#3639](https://github.com/mvschwarz/openrig/pull/3639))

`rig up` names seats that failed to launch with their failure and reports partial or failed outcomes, locally and with `--host`. It also arms a seat's continuity notice when its start needs attention, not only when it succeeds. ([#3477](https://github.com/mvschwarz/openrig/pull/3477), [#3612](https://github.com/mvschwarz/openrig/pull/3612))

A daemon that can't bind its listener writes one `OPENRIG_LISTEN_FAILED` line and exits with code 69, and `rig daemon start` reports that line. `rig daemon start` checks the port before starting over a stale `daemon.json`. ([#3659](https://github.com/mvschwarz/openrig/pull/3659), [#3657](https://github.com/mvschwarz/openrig/pull/3657))

`rig send` and `rig broadcast` report a seat's waiting permission or MCP elicitation request as a notice; the send itself behaves as before. `rig watchdog status` counts each job's quiet decisions since the daemon started. A handover's recap line says whether the seat folder or its `RECAP.md` is missing, instead of assuming the predecessor never wrote one. A package export that installs outside its kind's usual folder gets a warning; nothing is refused. ([#3570](https://github.com/mvschwarz/openrig/pull/3570), [#3653](https://github.com/mvschwarz/openrig/pull/3653), [#3676](https://github.com/mvschwarz/openrig/pull/3676), [#3692](https://github.com/mvschwarz/openrig/pull/3692))

## Recovery and seats

A large Claude seat's restore packet that takes longer than the PreCompact hook's wait is built in the background instead of being abandoned. While it builds, the earlier packet is kept aside and not delivered. The restore script reads the transcript a line at a time, so a packet is made past 512 MB. ([#3709](https://github.com/mvschwarz/openrig/pull/3709), [#3582](https://github.com/mvschwarz/openrig/pull/3582))

Restore notices for a seat with no parent go to the registered person. After a managed compaction, one notice says when a restore's uptake can't be seen within 30 minutes; it never claims failure and resends nothing. A Claude seat resumed in its kept pane keeps the identity its restore reserved. ([#3640](https://github.com/mvschwarz/openrig/pull/3640), [#3650](https://github.com/mvschwarz/openrig/pull/3650), [#3678](https://github.com/mvschwarz/openrig/pull/3678), [#3680](https://github.com/mvschwarz/openrig/pull/3680))

Each permission prompt is keyed by its start, so a new prompt while a seat's alert is open wakes the alert's owner once. For a Codex seat, the wake ladder uses the pane-confirmed permission state when the activity tracker holds a request. ([#3611](https://github.com/mvschwarz/openrig/pull/3611), [#3630](https://github.com/mvschwarz/openrig/pull/3630))

Pi and OMP seats recovered by an operator read recovered only when runner, session and identity checks agree; otherwise their attention names the failed check. The Pi and OMP runner's turn-end refresh reads entries since its saved position instead of the whole session. A pi-rpc seat that refuses a prompt raises attention. ([#3622](https://github.com/mvschwarz/openrig/pull/3622), [#3532](https://github.com/mvschwarz/openrig/pull/3532), [#2892](https://github.com/mvschwarz/openrig/pull/2892))

A Codex launch creates the generated pod-state folder before dispatch. Codex's activity hook runs from a stable path in the OpenRig home, so moving the Node install no longer breaks it. A restart preview builds a Codex seat's resume command without writing its `config.toml`. A verified Codex process's record is found in the databases it holds open when its declared home has none of its rows. ([#3564](https://github.com/mvschwarz/openrig/pull/3564), [#3610](https://github.com/mvschwarz/openrig/pull/3610), [#3707](https://github.com/mvschwarz/openrig/pull/3707), [#3603](https://github.com/mvschwarz/openrig/pull/3603))

Large composed Claude settings are passed as a private settings file on launch and resume, with an inline fallback. `rig snapshot` and restore find a rig by name across its archived and current identities. ([#3566](https://github.com/mvschwarz/openrig/pull/3566), [#3476](https://github.com/mvschwarz/openrig/pull/3476))

## Queue work

`rig queue update --expect-state <state>` checks the row's state inside the update; a mismatch changes nothing and exits 1. An older daemon ignores the flag. ([#3567](https://github.com/mvschwarz/openrig/pull/3567), [#3662](https://github.com/mvschwarz/openrig/pull/3662))

`rig workflow abort` ends an instance whose frontier packet a queue handoff already closed, and names a live successor it leaves alone. A stuck-sweep finding whose destination rig no longer exists is handed off once instead of retried forever. A forwarded queue create carries its original sender. ([#3609](https://github.com/mvschwarz/openrig/pull/3609), [#3541](https://github.com/mvschwarz/openrig/pull/3541), [#3174](https://github.com/mvschwarz/openrig/pull/3174))

A delivered wake whose recording keeps failing is reported once and retried on the wake retry interval. A delivered parked-owner reminder whose row stays pending for 15 minutes escalates once, never to the parked seat. The parked-owner job retires when its rig has nothing left to watch and comes back on unarchive or re-creation. A rerouted row's earlier wake no longer writes its result to the row, and a row resumed by resolve or an update records its current claimant, as a claim does. ([#3623](https://github.com/mvschwarz/openrig/pull/3623), [#3651](https://github.com/mvschwarz/openrig/pull/3651), [#3647](https://github.com/mvschwarz/openrig/pull/3647), [#3481](https://github.com/mvschwarz/openrig/pull/3481), [#3594](https://github.com/mvschwarz/openrig/pull/3594))

## Slack, terminal and tools

A Slack direct ask's close records who answered. The settled card shows a chosen label as written. An exact repeat of a status notice edits the earlier post with a repeat count instead of posting again. ([#3644](https://github.com/mvschwarz/openrig/pull/3644), [#3577](https://github.com/mvschwarz/openrig/pull/3577), [#3397](https://github.com/mvschwarz/openrig/pull/3397))

An older tmux probe result can't overwrite a newer loss or return. OpenRig's tmux server starts without a usable session bus, so tmux 3.4 doesn't move its panes into tmux-spawn scopes. A trailing `;` in a tmux key argument is sent as part of the key. ([#3493](https://github.com/mvschwarz/openrig/pull/3493), [#3514](https://github.com/mvschwarz/openrig/pull/3514), [#3371](https://github.com/mvschwarz/openrig/pull/3371))

A Herdr follow view recovers after a Herdr restart and brings new tiles back with their agents. The TUI's seat page offers run ▸, and its copy actions strip terminal control. ([#3501](https://github.com/mvschwarz/openrig/pull/3501), [#3641](https://github.com/mvschwarz/openrig/pull/3641), [#3380](https://github.com/mvschwarz/openrig/pull/3380))

The CLI sends daemon requests through a sandbox's supplied HTTP(S) proxy, honouring `NO_PROXY`. Scope updates write inside empty frontmatter. Git context updates use the checked-out branch when a tag shares its name. A bundle link to `/tree/HEAD/<path>` resolves to the remote's default branch. The reference includes flags registered through Commander's `addOption`. OpenRig's `tar` dependency is past a published advisory range. ([#3557](https://github.com/mvschwarz/openrig/pull/3557), [#3294](https://github.com/mvschwarz/openrig/pull/3294), [#3695](https://github.com/mvschwarz/openrig/pull/3695), [#3696](https://github.com/mvschwarz/openrig/pull/3696), [#3694](https://github.com/mvschwarz/openrig/pull/3694), [#3381](https://github.com/mvschwarz/openrig/pull/3381))

The reference explains what the Core app's owner gate admits without an owner bearer, and how trusted-runner reports are attributed. It points typing-guard users to the Claude hook bridge and adds an agy community harness example. ([#3607](https://github.com/mvschwarz/openrig/pull/3607), [#3626](https://github.com/mvschwarz/openrig/pull/3626), [#3627](https://github.com/mvschwarz/openrig/pull/3627), [#3619](https://github.com/mvschwarz/openrig/pull/3619))

## Seat pools

The seat pool still has no on-switch: nothing arms or dispatches a pool. A launch from stored state reports a stored `pool:` block that can't be used, once, in its warnings. The planner reports `max_reached` when a full pool has rows waiting, though nothing calls it yet. The reference and the `--allow-drift` help say which commands leave pool agents out or don't count them as drift. ([#3559](https://github.com/mvschwarz/openrig/pull/3559), [#3652](https://github.com/mvschwarz/openrig/pull/3652), [#3632](https://github.com/mvschwarz/openrig/pull/3632))

## Known limits

- A restore or `rig start` can label a Claude seat `resumed` before its conversation is confirmed, including when Claude reports that no conversation was found. A send can still land on Claude's workspace trust dialog. A fix has merged for a later release. Check the seat's screen after a restore or start before relying on it.
- A `rig send` message sent while Claude's `AskUserQuestion` dialog is open can become the answer to that question. This was observed on Claude Code 2.1.322 and 2.1.323; nothing in this release holds such a message.
- When Claude shows a notice on the same row as its paste hint, a message OpenRig pasted can stay in the input box unsubmitted. A Codex seat with no assigned work can keep reading as waiting on a permission after an auto-approved request finished. Fixes for both have merged for a later release; check the seat's screen.
- When a Codex seat's `config.toml` or `hooks.json` is a symbolic link, OpenRig records its hook trust under the link's target, as in 0.7.21, so such a seat may be asked to review hooks again. With a linked `config.toml`, OpenRig can also miss a setting stored for it that turns OpenRig's hooks off, and set those hooks up anyway. Review any hook prompt yourself; don't treat this upgrade as prior consent.
- The tmux outage record is in memory, so a daemon restarted during a loss records it again.
- While a new restore packet builds, only one earlier packet is kept aside. Two builds for one seat that finish close together can briefly leave the older marker in place; the newer packet is the one delivered.
- A percent `context-usage-threshold` doesn't fire for a Pi seat; use a token threshold.
- Coming from 0.7.19 or earlier, the seat pool's storage applies even though nothing arms a pool.
- A return route records where questions should go; it doesn't guarantee arrival. Choice prompts and other hosts keep their own paths.

## Credits

Thanks to Aschenbath, Dery Ferdika, Edward Bowie, Evgeny Zotov, JUSHUANGHUI LI, James B. Shields, Mike Schwarz, NIKHILA, Roberto Campos, Wu Shuwen, billbenetti, and ziadeh. Their contributions also keep test daemons off the default port and let a contributor's checkout install under npm 12.

## What changed in OpenRig 0.7.21

This note is for an agent on an install that was just upgraded to 0.7.21.
OpenRig 0.7.21 is a patch of ordinary team fixes. An agent can find a team's declared entry point when the team has no single lead. The daemon narrows one source of stalls when reading a mission's execution view. A seat pool's agents stay out of exports, and a bad pool block is named where you will see it. A Pi seat's posted usage feeds the context lane. It also fixes a run of smaller daemon, CLI, terminal, scope and skill problems.

## Before you upgrade

Run the upgrade in the environment that owns your daemon, keeping the same `OPENRIG_HOME` (legacy `RIGGED_HOME`) if you set it. Stop the daemon, back up its database, install the patch, then restart it. Your agents keep running; do not use `rig down` for this upgrade.

If the daemon was started with `--db`, or with `OPENRIG_DB` (legacy `RIGGED_DB`) set differently from this shell, replace the `DB=` line below with that actual database path. Pass the same `--db "$DB"` to every `rig daemon start`, including recovery; `rig config get db.path` reads this shell's configuration, not the running daemon's launch arguments or environment.

```sh
DB="$(rig config get db.path)" &&
STOP="$(rig daemon stop)" && printf '%s\n' "$STOP" &&
{ printf '%s\n' "$STOP" | grep -qx 'Daemon stopped' || { echo "The stop wasn't confirmed clean; see below before continuing." >&2; false; }; } &&
BACKUP="$DB.before-0.7.21-$(date -u +%Y%m%dT%H%M%SZ)" &&
{ [ ! -e "$BACKUP" ] || { echo "$BACKUP already exists; keep it and run again." >&2; false; }; } &&
cp "$DB" "$BACKUP" &&
{ [ ! -e "$DB-wal" ] || cp "$DB-wal" "$BACKUP-wal"; } &&
npm install -g @openrig/cli@0.7.21 &&
rig daemon start --db "$DB"
```

A failure stops the following commands; fix it before continuing. Back up and install only after `rig daemon stop` prints the line `Daemon stopped`: that is the stop outcome that confirms a clean shutdown. Its other success line, “No daemon target recorded; listener refused. Nothing to stop; prior drain not certified.”, means this stop has no recorded target. It does not prove that no daemon exists or that the last one shut down cleanly. A `Daemon stopped` from `rig daemon status` does not confirm a clean shutdown either.

If the stop failed or had no recorded target, make sure the daemon is running on its original home and database (start it with `rig daemon start --db "$DB"` if `rig daemon status` does not say it is running), then run the whole block again. If the stop is still unconfirmed, use `daemon-shutdown.json` and `daemon.log` in your OpenRig home, together with `rig context get help`, to resolve the reported problem before retrying. Do not continue to the backup or install on an unconfirmed stop.

A clean stop after restarting confirms only the new daemon’s shutdown, not whether earlier unfinished actions completed. Each stop replaces `daemon-shutdown.json`; look in `daemon.log` for earlier shutdown failures.

This release adds no database migration. Coming from 0.7.19 or earlier, 0.7.20's three additive migrations (`176_node_statusline_throttle`, `177_workflow_bound_pod` and `178_seat_pool`) apply at the first start; keep the backup, because downgrading a migrated database is not established. Bundled `openrig` is 0.7.21; `openrig-core` is 0.1.35.

## Teams and a person's agent

A roster entry can declare `lead_of`, a team name. When the daemon names no single lead for a rig (no `delegates_to` root, several, or one without a session) and exactly one entry in the rig declares a team, `rig_team` reports that entry as the rig's lead, marked declared, with its team and a note that it is that team's entry point and doesn't manage the network or its other participants. Two or more declarations give no lead, and the note names them; the same seat and team declared in two rosters counts once, and one seat declaring two teams counts as two. This tells an agent where to hand a team's work; nothing routes work automatically. ([#3593](https://github.com/mvschwarz/openrig/pull/3593), [#3606](https://github.com/mvschwarz/openrig/pull/3606))

When `rig attach --self` receives an HTTP error from the daemon, the CLI's text output keeps the error and adds one line naming the unjoined route: `rig queue create --destination <seat> --return-route auto --summary "<the goal>" --body-file <file>`. With `--json`, it prints the daemon's result instead, without that added line. The `rigs` skill says to take that route when the attach fails, names the fewer-prompts route in its top rules, and says what to do when the person's own app refuses a relay: tell them what was refused and why, let them choose, and don't retry another way. This release ships that guidance; it doesn't claim a measured change in how agents behave. ([#3569](https://github.com/mvschwarz/openrig/pull/3569), [#3574](https://github.com/mvschwarz/openrig/pull/3574))

`rig gateway human add` for a person with no connector binding says that they are reached only in the TUI's Feed and Steering until a binding is added, and names the command that adds one. ([#3590](https://github.com/mvschwarz/openrig/pull/3590))

## Queue work

A stuck-sweep finding says it is a diagnostic about its row, not a second assignment: act on the row, and the sweep closes the finding once the row is no longer stuck. The `queue-handoff` skill says tags can be added to a row later with `rig queue tag`, and that a receiver adds its own team's scope tags to a row it owns. ([#3591](https://github.com/mvschwarz/openrig/pull/3591), [#3581](https://github.com/mvschwarz/openrig/pull/3581), [#3599](https://github.com/mvschwarz/openrig/pull/3599))

An explicitly held seat that has never launched, with no assigned work, session, error or recorded launch or restore, reads as planned capacity: it stays visibly held, but no longer marks an otherwise running rig degraded or adds an attention item. A problem written only into such a seat's hold reason no longer adds attention. ([#3538](https://github.com/mvschwarz/openrig/pull/3538))

## Daemon

On a file-backed WAL database, when the main connection is not already in a transaction, a mission's execution view reads its candidates in size-adjusted windows, yielding between them and checking whether the caller has disconnected. The queue is scanned once instead of twice; the stuck sweep's candidate read uses the same conditional pacing. The time target is a soft bound: opening the database, native I/O or processing a large row can still block. Other database modes and calls inside a transaction retain the synchronous read. This narrows one source of daemon stalls; it isn't a cure for every stall or a release-wide speed-up. ([#3558](https://github.com/mvschwarz/openrig/pull/3558))

The daemon's writable SQLite connection keeps temporary storage in memory, so a sandbox whose temp directory refuses writes no longer fails nested writes inside a transaction. Large temporary structures may use more memory. ([#3486](https://github.com/mvschwarz/openrig/pull/3486))

A Pi seat that posts usage facts feeds the context lane: `rig usage top`, `rig ps` and a token `context-usage-threshold` watchdog see it as they see Claude and Codex seats. A relaunched Pi seat reads unknown until its new session's first post. ([#3244](https://github.com/mvschwarz/openrig/pull/3244))

## Seat pools

`rig spec export` leaves a seat pool's agents out and writes the model member with its pool block; an edge that touches a pool agent is left out and named in a "Not carried" line. `rig bundle create` no longer refuses a pooled rig for drift without `--allow-drift`; real drift still refuses. A bad `pool:` block shows its advisory in the warnings you see on preflight, import, launch, `rig expand` and the other paths, and a pod bundle drops a malformed block with a warning instead of failing. The seat pool stays off: nothing arms or dispatches a pool. ([#3546](https://github.com/mvschwarz/openrig/pull/3546), [#3547](https://github.com/mvschwarz/openrig/pull/3547))

## Terminal, scope and reference

Herdr tiles opened by OpenRig 0.7.5 through 0.7.9 keep a fixed size. Opening a Herdr view no longer reuses such a workspace as current, and names the command that closes one. ([#3560](https://github.com/mvschwarz/openrig/pull/3560))

A project nested in another project's workspace can set `scope.idPrefix` in its `project.yaml` (two or three uppercase letters) so its mission and slice ids stop repeating the enclosing project's; unset keeps `OPR`. Creating a mission with an id the enclosing project already uses names the mission that holds it. ([#3583](https://github.com/mvschwarz/openrig/pull/3583))

The reference lists 0.7.20's new flags and shows `rig seat set-statusline-throttle` with its required `--reason`. Project-selection hints name only options their command accepts. "Writing a daemon client" gains a companion-app recipe over the existing Core app job. ([#3550](https://github.com/mvschwarz/openrig/pull/3550), [#3552](https://github.com/mvschwarz/openrig/pull/3552), [#3592](https://github.com/mvschwarz/openrig/pull/3592))

## Known limits

- Successive permission prompts at one seat can stay on one open alert without a fresh wake for each new prompt. A fix is in review. Check a seat that has stopped at a permission prompt before assuming its alert is current.
- While a tmux server is gone, a stale probe observation can still release or reapply the delivery hold. Later observations correct it, with no guaranteed recovery time. The outage record is in memory, so a daemon restarted during a loss records it again.
- A restore or `rig start` can label a Claude seat `resumed` before its conversation is confirmed, including when Claude reports that no conversation was found. A send can still land on Claude's workspace trust dialog. Check the seat's screen after a restore or start before relying on it.
- A `rig send` message sent while Claude's `AskUserQuestion` dialog is open can become the answer to that question. This was observed on Claude Code 2.1.322 and 2.1.323 with OpenRig 0.7.19 and 0.7.20; nothing in this release changes it.
- When a Codex seat's `config.toml` or `hooks.json` is a symbolic link, OpenRig records its hook trust under the link's target, as in 0.7.20, so such a seat may be asked to review hooks again. With a linked `config.toml`, OpenRig can also miss a setting stored for it that turns OpenRig's hooks off, and set those hooks up anyway. Review any hook prompt yourself; don't treat this upgrade as prior consent.
- A percent `context-usage-threshold` doesn't fire for a Pi seat; use a token threshold.
- The seat pool's storage applies on upgrade even though nothing arms a pool.
- A return route records where questions should go; it doesn't guarantee arrival. Choice prompts and other hosts keep their own paths.

## Credits

Thanks to Evgeny Zotov, Mike Schwarz, Roberto Campos, Wu Shuwen, and billbenetti. Their contributions also improve the tmux-server tests' fixture root and the grouped native-input waits in tests.

## What changed in OpenRig 0.7.20

This note is for an agent on an install that was just upgraded to 0.7.20.
OpenRig 0.7.20 tells a person's own agent the consent rules first and where a handed-over task's result is, holds automatic delivery while a seat's tmux server is gone, and, when a parked row's wake is refused at a Claude seat's usage limit, retries it at the stated reset. It also lets a workflow instance stay on one pod, adds an opt-in Claude status-line throttle, and fixes a run of smaller CLI, TUI, scope and workflow problems.

## Before you upgrade

Run the upgrade in the environment that owns your daemon, keeping the same `OPENRIG_HOME` (legacy `RIGGED_HOME`) if you set it. Stop the daemon, back up its database, install the patch, then restart it. Your agents keep running; do not use `rig down` for this upgrade.

If the daemon was started with `--db`, or with `OPENRIG_DB` (legacy `RIGGED_DB`) set differently from this shell, replace the `DB=` line below with that actual database path. Pass the same `--db "$DB"` to every `rig daemon start`, including recovery; `rig config get db.path` reads this shell's configuration, not the running daemon's launch arguments or environment.

```sh
DB="$(rig config get db.path)" &&
STOP="$(rig daemon stop)" && printf '%s\n' "$STOP" &&
{ printf '%s\n' "$STOP" | grep -qx 'Daemon stopped' || { echo "The stop wasn't confirmed clean; see below before continuing." >&2; false; }; } &&
BACKUP="$DB.before-0.7.20-$(date -u +%Y%m%dT%H%M%SZ)" &&
{ [ ! -e "$BACKUP" ] || { echo "$BACKUP already exists; keep it and run again." >&2; false; }; } &&
cp "$DB" "$BACKUP" &&
{ [ ! -e "$DB-wal" ] || cp "$DB-wal" "$BACKUP-wal"; } &&
npm install -g @openrig/cli@0.7.20 &&
rig daemon start --db "$DB"
```

A failure stops the following commands; fix it before continuing. Back up and install only after `rig daemon stop` prints the line `Daemon stopped`: that is the stop outcome that confirms a clean shutdown. Its other success line, “No daemon target recorded; listener refused. Nothing to stop; prior drain not certified.”, means this stop has no recorded target. It does not prove that no daemon exists or that the last one shut down cleanly. A `Daemon stopped` from `rig daemon status` does not confirm a clean shutdown either.

If the stop failed or had no recorded target, make sure the daemon is running on its original home and database (start it with `rig daemon start --db "$DB"` if `rig daemon status` does not say it is running), then run the whole block again. If the stop is still unconfirmed, use `daemon-shutdown.json` and `daemon.log` in your OpenRig home, together with `rig context get help`, to resolve the reported problem before retrying. Do not continue to the backup or install on an unconfirmed stop.

A clean stop after restarting confirms only the new daemon’s shutdown, not whether earlier unfinished actions completed. Each stop replaces `daemon-shutdown.json`; look in `daemon.log` for earlier shutdown failures.

Three additive migrations apply at the first start: `176_node_statusline_throttle` (the status-line throttle setting), `177_workflow_bound_pod` (a workflow instance's pod) and `178_seat_pool` (the seat pool's storage). Migration 178 applies whether or not you declare a pool. Keep the backup: downgrading the migrated database to 0.7.19 is not established. Bundled `openrig` is 0.7.20; `openrig-core` is 0.1.34.

## A person's own agent

The `rigs` skill opens with the consent rules an agent must hold from its first handoff, even if it reads nothing else, and points to step 2 for the full rules. It hands work over with a return route: most of the team's questions come back to the person's conversation, and the result is in the handed-over task's resolution, which the agent reads with `rig queue show <id> --full`. This release ships that guidance; it doesn't claim a measured change in how agents behave. `rig setup`'s next steps and the install reference say the same. ([#3500](https://github.com/mvschwarz/openrig/pull/3500))

The `openrig-user` skill says that Claude Desktop picks up the team's work with a scheduled task, in a fresh session, and that Monitor is for a session kept open. The `rigs` skill can be added to OMP (Oh My Pi), installing the shared skill only. ([#3503](https://github.com/mvschwarz/openrig/pull/3503), [#3509](https://github.com/mvschwarz/openrig/pull/3509))

## Recovery and delivery

When the tmux server a seat depends on goes away, the daemon records it once and holds automatic delivery to that server's seats. It probes read-only every 5 s, backing off to 60 s, without starting the server, and offers owed work again when the server answers. An explicit `rig send` is still attempted. `rig status`, `rig ps` and `rig doctor` report the outage. ([#3448](https://github.com/mvschwarz/openrig/pull/3448))

When a parked row's wake is refused at a Claude seat that has reached its usage limit, the wake's record says so and retries at the stated reset; Codex states no reset, so a Codex seat's wake keeps its ordinary retry. A Codex seat's generation record is read from its declared home. `rig seat status` reads a seat left at a bare shell as needing attention, as `rig ps` does. `rig daemon stop` acts on a start reservation's child only after confirming the reservation still names it. Queue-only manual compaction prepares under the lifecycle lease. The draft guard recognizes its own collapsed paste. ([#3508](https://github.com/mvschwarz/openrig/pull/3508), [#3507](https://github.com/mvschwarz/openrig/pull/3507), [#3515](https://github.com/mvschwarz/openrig/pull/3515), [#3447](https://github.com/mvschwarz/openrig/pull/3447), [#3465](https://github.com/mvschwarz/openrig/pull/3465))

These change how recovery and delivery decide. This release doesn't claim a measured recovery improvement on a running team.

## Workflows, scope and status

A workflow instance can be bound to a pod. A workflow packet's Continuation line names `--evidence-ref` when its step needs a receipt, as `rig workflow show` does, and `rig workflow route` and `rig workflow resume` point to that exact command. Scope and proof default to the calling rig's project. Current-state progress updates carry a timestamp. An empty plan lock written with CRLF line endings is refused. Block notes are kept beside continuations. ([#3161](https://github.com/mvschwarz/openrig/pull/3161), [#3533](https://github.com/mvschwarz/openrig/pull/3533), [#3151](https://github.com/mvschwarz/openrig/pull/3151), [#3156](https://github.com/mvschwarz/openrig/pull/3156), [#3517](https://github.com/mvschwarz/openrig/pull/3517), [#3499](https://github.com/mvschwarz/openrig/pull/3499))

One workflow's unreadable mission no longer hides the attention view's other outcomes. A renamed project keeps its rows by its declared former ids, and rows no project claims are counted. Changes to `files.allowlist` and `progress.scan_roots` through the daemon's settings API are recorded on the event stream on a best-effort basis after saving; direct `rig config set` and `rig config reset` writes are not covered. ([#3492](https://github.com/mvschwarz/openrig/pull/3492), [#3267](https://github.com/mvschwarz/openrig/pull/3267), [#3373](https://github.com/mvschwarz/openrig/pull/3373))

## Settings, seats and tools

An opt-in per-seat throttle limits how often the Claude status line is collected. `rig provider` bindings report what each seat is configured to use. `rig start` can select fresh seats. A settled Slack question card names the chosen option, redacted as the question card is. ([#3433](https://github.com/mvschwarz/openrig/pull/3433), [#3469](https://github.com/mvschwarz/openrig/pull/3469), [#3337](https://github.com/mvschwarz/openrig/pull/3337), [#3519](https://github.com/mvschwarz/openrig/pull/3519))

A model member can declare a seat-pool block, which is stored on its node, and a sizing planner exists for the pool. Nothing arms or dispatches a pool in this release: declaring one changes no seat's behaviour. ([#3480](https://github.com/mvschwarz/openrig/pull/3480), [#3478](https://github.com/mvschwarz/openrig/pull/3478))

The TUI degrades its control socket instead of ending the launcher, completes commands with leading whitespace, and measures health findings in terminal columns. The CLI aligns node rows by terminal column width, normalizes explicit daemon URLs, and brackets IPv6 targets in `rsync` operands. Mission and slice reads ask for the proof policy once per request, and slice-term matching runs in one pass; this release doesn't claim a measured speed-up. ([#3379](https://github.com/mvschwarz/openrig/pull/3379), [#3489](https://github.com/mvschwarz/openrig/pull/3489), [#3490](https://github.com/mvschwarz/openrig/pull/3490), [#3491](https://github.com/mvschwarz/openrig/pull/3491), [#3523](https://github.com/mvschwarz/openrig/pull/3523), [#3521](https://github.com/mvschwarz/openrig/pull/3521), [#3467](https://github.com/mvschwarz/openrig/pull/3467), [#3468](https://github.com/mvschwarz/openrig/pull/3468))

## Known limits

- While a tmux server is gone, a stale probe observation can still release or reapply the delivery hold. Later observations correct it, with no guaranteed recovery time. The outage record is in memory, so a daemon restarted during a loss records it again.
- A restore or `rig start` can label a Claude seat `resumed` before its conversation is confirmed, including when Claude reports that no conversation was found. A send can still land on Claude's workspace trust dialog. Check the seat's screen after a restore or start before relying on it.
- A `rig send` message sent while Claude's `AskUserQuestion` dialog is open can become the answer to that question. This was observed on Claude Code 2.1.322 and 2.1.323 with both OpenRig 0.7.19 and 0.7.20.
- Linked Codex configuration files keep version-specific hook-trust limits, as in 0.7.19. This release doesn't migrate existing noncanonical state or include the linked-path alias change. Review any hook prompt yourself; don't treat this upgrade as prior consent.
- The seat pool's migration and stored block apply on upgrade even though nothing arms a pool.
- A return route records where questions should go; it doesn't guarantee arrival. Choice prompts and other hosts keep their own paths.

## Credits

Thanks to Ary Rabelo, Dery Ferdika, Devulapalli Naga Sri Vaishnavi, Edward Bowie, Mike Schwarz, Roberto Campos, Samuel Smith, Wu Shuwen, and billbenetti. Their contributions also improve the daemon's memory-limit reasons, tests, CI on Ubuntu, the custom-view SQL contract, Claude readiness polling, startup probing, and documentation.

## What changed in OpenRig 0.7.19

This note is for an agent on an install that was just upgraded to 0.7.19.
OpenRig 0.7.19 improves how a team brings permission prompts to a person, reports interrupted recovery, and starts again after a failed launch. It also adds optional Claude hook delivery, per-seat Linux memory limits, and a versioned interface for apps answering human questions.

## Before you upgrade

Run the upgrade in the environment that owns your daemon, keeping the same `OPENRIG_HOME` (legacy `RIGGED_HOME`) if you set it. Stop the daemon, back up its database, install the patch, then restart it. Your agents keep running; do not use `rig down` for this upgrade.

If the daemon was started with `--db`, or with `OPENRIG_DB` (legacy `RIGGED_DB`) set differently from this shell, replace the `DB=` line below with that actual database path. Pass the same `--db "$DB"` to every `rig daemon start`, including recovery; `rig config get db.path` reads this shell's configuration, not the running daemon's launch arguments or environment.

```sh
DB="$(rig config get db.path)" &&
STOP="$(rig daemon stop)" && printf '%s\n' "$STOP" &&
{ printf '%s\n' "$STOP" | grep -qx 'Daemon stopped' || { echo "The stop wasn't confirmed clean; see below before continuing." >&2; false; }; } &&
BACKUP="$DB.before-0.7.19-$(date -u +%Y%m%dT%H%M%SZ)" &&
{ [ ! -e "$BACKUP" ] || { echo "$BACKUP already exists; keep it and run again." >&2; false; }; } &&
cp "$DB" "$BACKUP" &&
{ [ ! -e "$DB-wal" ] || cp "$DB-wal" "$BACKUP-wal"; } &&
npm install -g @openrig/cli@0.7.19 &&
rig daemon start --db "$DB"
```

A failure stops the following commands; fix it before continuing. Back up and install only after `rig daemon stop` prints the line `Daemon stopped`: that is the stop outcome that confirms a clean shutdown. Its other success line, “No daemon target recorded; listener refused. Nothing to stop; prior drain not certified.”, means this stop has no recorded target. It does not prove that no daemon exists or that the last one shut down cleanly. A `Daemon stopped` from `rig daemon status` does not confirm a clean shutdown either.

If the stop failed or had no recorded target, make sure the daemon is running on its original home and database (start it with `rig daemon start --db "$DB"` if `rig daemon status` does not say it is running), then run the whole block again. If the stop is still unconfirmed, use `daemon-shutdown.json` and `daemon.log` in your OpenRig home, together with `rig context get help`, to resolve the reported problem before retrying. Do not continue to the backup or install on an unconfirmed stop.

Three additive migrations record the hook bridge, each session's launched folder, and app access. Keep the backup: downgrading the migrated database to 0.7.18 is not established. Bundled `openrig` is 0.7.19; `openrig-core` is 0.1.33.

## Questions and consent

A permission prompt can reach the existing alert route even when its seat has no open work. A recovery waiting directly on that prompted seat or row no longer hides the prompt. Clears from an earlier occupant do not clear the current occupant's alert. ([#3425](https://github.com/mvschwarz/openrig/pull/3425), [#3446](https://github.com/mvschwarz/openrig/pull/3446))

The installer guidance keeps your conversation unless you choose the operator's pane, and teaches reloading a skill added during the session. The guidance says an answer covers that prompt, rather than permission to answer unrelated prompts later. ([#3423](https://github.com/mvschwarz/openrig/pull/3423), [#3431](https://github.com/mvschwarz/openrig/pull/3431), [#3454](https://github.com/mvschwarz/openrig/pull/3454))

## Recovery and delivery

Restore now reports skipped saved hooks and missing working folders as gaps. Restore's working-folder projection skips a folder confirmed absent; adapter home/state setup is separate. A fresh launch from a spec can still create its declared folder. Recreated seats' notices and receipts agree about which seat launched, and a delivered sequence can close its notice. Closure is best-effort if bookkeeping fails; a later sequence can still owe work. ([#3430](https://github.com/mvschwarz/openrig/pull/3430), [#3436](https://github.com/mvschwarz/openrig/pull/3436), [#3450](https://github.com/mvschwarz/openrig/pull/3450), [#3350](https://github.com/mvschwarz/openrig/pull/3350), [#3415](https://github.com/mvschwarz/openrig/pull/3415))

`launch --fresh` can replace the shell left by a failed start without `--stop`. Fresh launch can reopen a terminal server after a host restart when the old process is confirmed gone. A missing tmux server is reported as a detached session, with guidance to restore or relaunch the seat; unavailable readings remain uncertain. Duplicate automatic watchdog registration no longer aborts startup. ([#3392](https://github.com/mvschwarz/openrig/pull/3392), [#3435](https://github.com/mvschwarz/openrig/pull/3435), [#3429](https://github.com/mvschwarz/openrig/pull/3429), [#3443](https://github.com/mvschwarz/openrig/pull/3443))

For a seat you type in, `rig seat set-typing-guard <seat> --mode queue-only --reason <text>` keeps ordinary automatic notices out of its input. Watchdog reminders can be noted on a matching row or recorded in a new queue row without a nudge; parked-owner reminders remain retained. Interrupted reminders survive daemon restart. Other delivery modes keep their own behavior. ([#3418](https://github.com/mvschwarz/openrig/pull/3418), [#3461](https://github.com/mvschwarz/openrig/pull/3461))

Claude hook delivery is opt-in: `rig seat set-hook-bridge <seat> --enabled true --reason <text>`, then inspect `rig seat hook-bridge <seat>`. On supported Claude versions, launch or restore installs the bridge; it takes messages only after this occupant's waiter has armed. Until then, ordinary typed delivery applies. If an already-routed bridge becomes unavailable, fallback follows the existing delivery checks and names why. The help's 20 seconds is not an arrival deadline: queued work, waiter state and the existing delivery checks determine waiting and fallback. A hook handoff is not proof the agent read or acted on it. ([#3270](https://github.com/mvschwarz/openrig/pull/3270), [#3445](https://github.com/mvschwarz/openrig/pull/3445))

## Settings and connected tools

On Linux with systemd, `process_limits: { memory_max: "512M" }` requests a per-seat memory limit alongside `tasks_max`; swap is separate. `rig seat status` shows the observed limit and counters. A limit that cannot be verified is reported, not silently claimed effective. Recovery may attempt a launch without a process limit, with a warning; that attempt can fail. An uncertain or already-started command is not repeated merely to obtain the limit. ([#3417](https://github.com/mvschwarz/openrig/pull/3417))

Apps can use the versioned [human-answer interface](https://github.com/mvschwarz/openrig/blob/v0.7.19/docs/reference/core-app.md) to read questions, submit answers and recover receipts. Credentials identify an app and permitted actors; they are not private per-person logins. Other improvements bind external input to its run, add optional webhook signatures, and pass advisory participant fields through `rig_team`. ([#3426](https://github.com/mvschwarz/openrig/pull/3426), [#3420](https://github.com/mvschwarz/openrig/pull/3420), [#3364](https://github.com/mvschwarz/openrig/pull/3364), [#3396](https://github.com/mvschwarz/openrig/pull/3396), [#3410](https://github.com/mvschwarz/openrig/pull/3410))

Capable runners offer `rig seat cancel <seat> --run-id <run> --native-turn-id <turn> --request-id <id>` for the exact target from `rig seat status <seat> --json`. Inspect its `requested`, `cancelled`, `not-this-turn` or `not-supported` result. Neither permission withdrawal nor an accepted cancellation request proves the operation stopped; raw Claude/Codex TUI seats do not gain this runner capability. ([#3364](https://github.com/mvschwarz/openrig/pull/3364))

## Known limits

- A later unreadable tmux sample can show recorded running again after an earlier stopped reading. “Liveness unconfirmed” is not evidence of a live process; inspect the seat before relying on that label.
- Linked Codex configuration files retain version-specific hook-trust limits. This release does not migrate existing noncanonical state or include the linked-path alias change wholesale. Review any hook prompt yourself; do not treat this upgrade as prior consent.
- Queue-only reminders are not exactly-once: a lost note receipt can repeat a note. Check the row before acting twice.
- Downgrading past the Claude hook `exec` change can leave generated settings unrecognized by the older daemon. Keep your settings backup and inspect them before restarting an older release. ([#3427](https://github.com/mvschwarz/openrig/pull/3427))
- Manual compaction preparation can be held at queue-only. Inspect `rig compact <seat> --state` and `rig seat held-messages <seat>` before deliberately choosing an existing delivery route or level; changing the level does not replay retained messages.
- A return route records where questions should go; it does not guarantee arrival. Choice prompts, foreign or conflicting routes, existing delivery custody, and a relay that cannot be made keep their existing paths. Tasks at a conversation's address are read on its next turn. When checking open routed tasks, include blocked rows: `OPENRIG_SESSION_NAME='<recorded address>' rig queue list --owned --state pending,in-progress,blocked`.

## Credits

Thanks to Dery Ferdika, Devulapalli Naga Sri Vaishnavi, Edward Bowie, Evgeny Zotov, James B. Shields, Mike Schwarz, NIKHIL, Roberto Campos, Samuel, Samuel Smith, Wu Shuwen, billbenetti, and dependabot[bot]. Their contributions also improve terminal column sizing, JSON errors, transcript searches, workflow ownership, account-label display, scope links, cleanup and documentation.

## What changed in OpenRig 0.7.18

This note is for an agent on an install that was just upgraded to 0.7.18.
OpenRig 0.7.18 can send a team's seat prompts to the conversation your person
handed the work over from, restore says more truthfully what it left running,
and three settings can be chosen per seat: native input, Claude's auto mode
and, on Linux, a task limit. It adds four database migrations. If you upgraded
from 0.7.16 or earlier, also read "What changed in OpenRig 0.7.17" below, and so
on back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`), with a
  database backup first. Your agents keep running through it; don't use
  `rig down`. If the daemon was started with `--db`, back up that path and pass
  the same `--db` to `rig daemon start`. Four migrations run before it listens
  (`171_claude_auto_mode`, `171_node_input_route`, `172_queue_return_route`,
  `173_node_process_limits`); each adds columns or indexes. Going back to
  0.7.17 after them isn't established.
- **The plugins:** `openrig` carries 0.7.18, and openrig-core moves to 0.1.32
  because its skills and refocus hook changed.

## Your person's own conversation

- **A return route:** when your person stays in their own conversation, hand
  their goal over with `rig queue create --return-route auto` (or
  `--return-route self` from a session that joined the team). Every handoff
  carries the route. When routed work is held at a seat's prompt, or waits on
  it, a prompt that isn't a choice dialog is sent to that conversation as a
  task. Choice prompts, a prompt already with the gateway, and a route that
  can't be used (another host's, two that disagree, or a relay that couldn't be
  made) keep their existing path. The `rigs` skill teaches this.
- **Guidance:** the kernel operator is instructed to answer a registered person
  where they wrote (not proof an answer is delivered), and
  `messaging-the-human` says how to close the ask an answer settles.
- **Slack and MCP:** a button answer keeps each option's history and who gave
  it; a click that fails to record enters the existing retry path, which fills
  only a still-unanswered question; and `rig_question_answer` sends the
  operator token when the daemon requires one.

## Recovery

- **A bare shell restore leaves no longer counts as running** in `rig ps`,
  including a recreated seat; a seat with a delegation parent or escalation
  destination gets that owner one queue item per restore.
- **After OpenRig's home moved:** `rig up --existing --cwd` honors `--cwd`,
  names a missing saved folder and leaves a declared project folder
  unscaffolded, and Claude seats keep the core plugin. Each restored seat's
  checkpoint is its own file, `.rigged-checkpoint-<session>-<digest>.md`.
- **Restore and `restore-check` name agents that share a recorded
  conversation,** and `rig seat handover --recover` accepts a successor alone in
  its session's current window.
- **Also:** a later `rig down` no longer exits 2 over a released session's kept
  skills (a plain `down` of a stopped rig still exits 1), and Codex 0.167.1 and
  0.167.2 seats read their real activity.

## Queue, delivery and settings

- **Per-seat choices, all opt-in:** `rig seat set-input-route <seat> --route
  native --reason <text>`; Claude's `autoMode` (`claude_auto_mode`, or
  `rig seat set-permissions --auto-mode`); and on Linux with systemd, a
  requested task limit, `process_limits: { tasks_max: N }`. A fresh start whose
  limit isn't seen to take effect is refused; a recovery that can't apply it
  may try without the limit, with a warning; an uncertain start is reported and
  not retried. OpenRig 0.7.17 rejects teams whose exported `rig.yaml` contains
  `claude_auto_mode` or `process_limits`. Upgrade the receiving install to
  0.7.18, or remove those fields from a copy only if you intend to share without
  those per-seat settings.
- **`rig compact <pi-seat>`** requests Pi's own compaction; `--state` reports
  the attempt.
- **Queue:** `rig queue tag <id> --add <tag>` adds tags to an existing row, and
  `rig queue list` names a handed-off row's successors.

## Limits to keep in view

- **A routed prompt waits for the conversation's next turn;** nothing wakes an
  idle one, and arrival isn't guaranteed. A prompt can still change between
  OpenRig reading it and sending the key.
- **Checkpoints:** the seat isn't told where its file is, and a written file
  isn't proof it was read. After a `--cwd` restore, `rig down` doesn't clean
  OpenRig's Claude settings, hooks and collector from that folder. When a full
  restore recreates a seat, its result can still list it as not started.
- **Native input route:** withdrawing a permission doesn't cancel a native
  seat's work in progress.
- **Queue help** says a human seat such as `human@host` asks no one; that holds
  only for an unregistered one.
- **The older notes below are each version's own:** their upgrade steps install
  that version, and where one points to a 0.7.8 or 0.7.9 section below, read
  that version's GitHub Release instead. 0.7.17's maintenance drain lets
  delivery go on when its record can't be read; the daemon log then says
  `control read unavailable; allowing automatic delivery`.
- **Linked Codex config files:** when a Codex seat's `config.toml` or
  `hooks.json` is a symbolic link, OpenRig records its hook trust under the
  link's target, as in 0.7.14. A change to key it by the file's own name isn't
  in this release, and such a seat may be asked to review hooks again. With a
  linked `config.toml`, OpenRig can also miss a setting stored for it that
  turns OpenRig's hooks off, and set those hooks up anyway when it moves them
  into `hooks.json`.
- **0.7.17's limits below still apply,** except the bare-shell count, the
  second `rig down`'s exit 2 and Codex 0.167.1 and 0.167.2's `unknown`.

## What changed in OpenRig 0.7.17

This note is for an agent on an install that was just upgraded to 0.7.17.
OpenRig 0.7.17 teaches the installer, the kernel operator and the `rigs` skill
to bring a team's questions to the conversation your person started it from:
when they stay in their own Claude Code conversation, a seat's prompt is to go
there as a task, and only their recorded words back to the seat. In this
release's first trial, that guidance didn't complete the journey (see "Limits
to keep in view"). Restore and
`rig down` report more of what they did, a rig's automatic delivery can be held
during maintenance, and three daemon read paths changed. It adds two database
migrations. If you upgraded from 0.7.15 or
earlier, also read "What changed in OpenRig 0.7.16" below, and so on back. For
the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`), with a
  database backup first. Your agents keep running through it; don't use
  `rig down`. Migration 168 records the occupant generation with each Claude
  context sample, and migration 170 adds `rig_delivery_drains`. Going back to
  0.7.16 after them isn't established.
- **The `openrig` plugin carries 0.7.17,** because its
  `working-with-an-openrig-team` skill changed. openrig-core stays 0.1.31.
- **One new setting:** `ui.topology_remote_seats` (off by default) lets the TUI's
  topology TABLE read a remote rig's seats, read-only.

### Your person's own conversation

- **If your person installed OpenRig from their own Claude Code conversation and
  stays there,** the installer is instructed to hand their goal to the team as a
  task from that conversation's address, and no longer says they'll answer in
  the operator's pane. Ask where they'll answer only when that's genuinely unclear.
- **The kernel operator is instructed to bring a seat's prompt to that address
  as a task,** with the prompt and its choices verbatim, the seat, what it was
  doing and the escalation's id, and to relay only the person's recorded words:
  the key from a fresh capture, the reason starting `task <id>:`, and the effect
  checked. It is to tell the person the lead has their goal, that the team is
  instructed to bring its questions and the result to that conversation but a
  seat's prompt may still wait without reaching it, and to offer the team's
  space or a seat's terminal only if they choose to watch or answer in the pane.
  A person who chose the panes gets the earlier instructions unchanged.
- **If you're the person's agent,** check your address while work is open, show
  a forwarded prompt whole, and read the newest review before saying the work is
  done (the `rigs` skill and `working-with-an-openrig-team`).
- **The launch plan** now says a team seat with no permission policy gets the
  team default. An empty person registry reads
  `undeliverable:no-registered-human`; a registry that failed to load still
  reads `unavailable:human-registry`.
- **The installing-for-someone procedure** is no longer in every seat's
  startup text; read it from the `rigs` skill's
  `references/installing-for-someone.md` when you need it.

### Recovery

- **Restore** reads `partially_restored`, and names the seat, when it skipped a
  seat that isn't in the snapshot's roster or left one attached. Which seats
  launch is unchanged. An adopted seat keeps its recorded session name when tmux
  and OpenRig's addressing keep it as given; otherwise restore names the old and
  new address.
- **Resume one banked original conversation** (opt-in): read
  `GET /api/startup/<rigId>/nodes/<nodeId>/original?snapshotId=<id>&historySessionId=<id>`,
  then POST `action: "resume"` with that `revision`, an `operationId` and the
  exact `expectedOriginal`. Keep the operation id after a timeout: repeating the
  same request reconciles instead of dispatching again. A result that can't be
  proven stays partial. Details: `docs/reference/daemon-http-clients.md`.
- **Hold one rig's automatic delivery during maintenance:**
  `POST /api/rigs/<rigId>/delivery-drain` with a `drainId`, `owner` and
  `reviewAt` holds its queue wakes, watchdog delivery and stuck-sweep findings;
  `POST /api/rigs/<rigId>/delivery-drain/end` ends it. A review deadline prompts
  the owner and never ends the drain. Direct sends and native starts aren't
  held, and unknown delivery isn't replayed. If the drain record can't be
  read, delivery isn't held: the daemon log says
  `control read unavailable; allowing automatic delivery` and delivery goes on.
- **A restore that can't confirm it stopped a blank session** keeps that
  session's record and binding: the seat reads `attention_required` and says the
  session may still be running. Check with `rig capture`, stop it with
  `rig seat stop`, then retry.
- **`rig down` releases a claimed tmux session** (self-attached inside tmux,
  adopted, bound or reconciled), prints `Released, not stopped: <session>`, and
  exits 0; the session keeps running. An external CLI attachment is unchanged on
  `down`. Separately, `rig remove` or `shrink` of a member that joined with
  `rig attach --self` outside tmux no longer fails with `409 kill_failed`.
- **Claude resume and handover:** a pane that moves during resume-token capture
  leaves the token unknown; discovered handover resolves a relative
  `CLAUDE_CONFIG_DIR` against the seat's directory.

### Delivery, workflows and tools

- **Three daemon read paths changed:** the stuck sweep reads undelivered ids in
  windows and yields between them (a window and one row's derivation are still
  synchronous); Codex thread lookup reads only new log rows after its first full
  read per process and Codex home (a cold or fallback read is still full); a work
  node's `SPEC.md` is reread when its file metadata changed, within a two-second
  settle window, or when that metadata can't be read. No speed claim is made for
  this release.
- **Draft-aware delivery** reads an empty input box under Claude Code 2.1.322 or
  2.1.323's wide paste hint and auto-update failure as empty and sends once
  (checked with Claude Code 2.1.322 and 2.1.323 in a test run), and
  `rig send --dangerously-interact` without `--type-without-checking` now stops
  on a person's text there (shown by its tests; not yet checked with Claude
  Code itself).
- **Claude's question dialog,** in the several-question, editor-shortcut and
  preview layouts OpenRig recognizes, refuses an ordinary send with
  `target_needs_input` (shown by its tests; not yet checked with Claude Code
  itself).
- **A send at a model picker** says to close it with Esc; don't use
  `--dangerously-interact` there. A Claude seat that won't start under managed
  `disableSideloadFlags` names the setting.
- **A resumed Codex conversation** isn't told to sign in again because of an old
  token-refresh failure that newer output follows. A refusal that is still the
  latest thing Codex printed, or a marked quote in an unfinished code block with
  nothing newer above the composer, can still read current.
- **`rig provider switch --token-file`:** the Claude token step is now kept for
  pane readings it used to drop (Claude itself, nothing, another POSIX shell);
  after a failed environment correction it's kept only for a session proven to
  be this seat's, and never for fish or Nushell. An account-home or wrapped
  launch in a non-POSIX pane still refuses. A command carrying the step doesn't
  prove the token was applied; check the seat's account.
- **A hosted member with no wake trigger** gets an `awaiting-pickup:` record: its
  work waits in its queue until it reads it. Don't read that as a failure.
- **A `rig queue handoff` whose answer was lost** names the source row to read
  (`rig queue show '<id>' --full --json`) before any retry.
- **`rig workflow revise`** can remove an obsolete required order from unstarted
  work and projects the newly ready work once. Replaying a `rig workflow route`
  that adopted a queue handoff's sole successor, without `--packet`, selects that
  successor and writes nothing.
- **An external connection's `rig_queue_show`** adds `viewer`, `item.createdBy`
  and actor labels, with `you` true only for this connection.
- **Also:** `rig bundle check` reports schema-invalid configuration names;
  `rig queue erase --members <empty file> --rig <id>` erases an account rig that
  never had a member; a Pi or OMP runner pane names its model and state;
  `rig environment recreate` handles a replaced Podman socket (not run against a
  live engine); the text output of `rig network status` and the connect
  confirmation hide a hub URL's query string (`--json` keeps the full URL);
  `rig setup` prints the harness login line.

### Limits to keep in view

- **Your person's conversation isn't woken.** A seat's question waits until
  they return to it, and a prompt that changes between the capture and the key
  can take the key. In this release's first trial, with Claude Code and a
  simulated person, a reviewer's permission question never reached the person,
  the person's agent twice offered a bare terminal attachment as a way to
  answer a seat's prompt, and the work didn't reach a reviewed commit. No
  return address for the person's conversation had been established, and no
  escalation for the reviewer's question was recorded. This route doesn't
  reliably complete that journey, and a second trial wasn't run.
- **Restore's overall result:** `restore-check`'s recovery plan still counts
  seats restore leaves alone, and says restore tries the conversation for an
  in-roster external CLI seat. A seat left as a bare shell after "Harness not
  started" still counts as running in `rig ps`.
- **A second `rig down`** while a released session runs reports that seat's
  kept skills as an error and exits 2. After `rig down --delete`, a later
  `rig down` of another rig in the same working directory may remove OpenRig's
  shared guidance and Claude additions there while the released session runs.
- **A Codex seat resumed on 0.167.1 or 0.167.2** can read `unknown`
  (`unrecognized_client_version`).
- **Draft-aware delivery beside the wide footer** accepts only Claude Code's two
  known failure wordings; a new one reads unknown and holds.
- **Claude's preview question dialog** in a pane too narrow for its 30-column
  option column plus 4-column gap can render differently and read unknown, so
  an ordinary send isn't refused there.
- **`rig scope` and `rig proof` can't be limited to a rig's own project.**
- **Reading queue state with `rig queue list`:** the median time was about 22%
  (about 90 ms) slower than 0.7.16 in a matched test on a pre-release build. The
  cause wasn't found, and the final build wasn't re-measured.
- **Linked Codex config files:** when a Codex seat's `config.toml` or
  `hooks.json` is a symbolic link, OpenRig records its hook trust under the
  link's target, as in 0.7.14. A change to key it by the file's own name isn't
  in this release, and such a seat may be asked to review hooks again. With a
  linked `config.toml`, OpenRig can also miss a setting stored for it that
  turns OpenRig's hooks off, and set those hooks up anyway when it moves them
  into `hooks.json`. ([#3078](https://github.com/mvschwarz/openrig/issues/3078))
- **"Person approved" entries** an agent recorded for its own approvals don't
  establish the person's approval; check the conversation.
- **Slack buttons:** in 0.7.16's tests, an answer given by button wasn't seen to
  reach OpenRig, and the cause isn't known. Type the reply instead.
- **Managed compaction with Claude Code 2.1.322:** typed text in the input box
  can carry `/compact` along as text while `rig compact --state` reports it
  sent, and the draft-aware guard can leave the preparation prompt unsent.
  Empty the box first and check the seat compacted.
- **No memory claim** is made for this release.
- **0.7.16's limits** below still apply unless this release changes them (the
  wide-footer case and restore's overall result).

## What changed in OpenRig 0.7.16

This note is for an agent on an install that was just upgraded to 0.7.16.
OpenRig 0.7.16 keeps the team's launch default for a seat whose policy is the
built-in `standard` or `open`, and the `rigs` skill has you bring a seat's
permission, trust and hook-review prompts to your person as questions, then
run the `rig seat continue` a seat shows after its startup prompt is answered.
A failed handover's running successor can be adopted, a
seat's runtime home can be recorded, an upgrade keeps OpenRig's packaged
recovery skills, and a send to a missing seat is kept and says so. It adds two
database migrations. If you upgraded from 0.7.14 or
earlier, also read "What changed in OpenRig 0.7.15" below, and so on back. For
the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Stop, back up, install, then start.** These were the steps for upgrading to
  0.7.16; for a later version, follow the steps in that version's note.
  `rig daemon stop` (seats keep running, so don't use `rig down`), copy the
  database file (`rig config get db.path` shows it), install 0.7.16 with the
  existing installation method, then `rig daemon start`.
- **Two migrations run before the daemon listens.** Migration 167 adds
  `seat_handover_attempts` and migration 169 adds `seat_runtime_home_records`.
  Going back to 0.7.15 after them isn't established; keep the backup.
- **The plugins:** the `openrig` plugin's manifests carry the CLI's version,
  0.7.16. openrig-core moves to 0.1.31, because its skills changed.

### A person's first team

- **`standard` and `open` keep the team default.** A seat whose effective policy
  is the built-in `standard` or `open` launches with the team default's
  allowances, as a seat with no policy does; before, any recorded policy turned
  the team default off. The member's policy decides over the rig's, other
  recorded choices keep their meaning. The Claude team default includes ask
  rules for lifecycle commands such as `rig up` and `rig down`; the Codex team
  default does not add equivalent per-command ask rules, and native settings
  and explicit permission choices still apply. The launch plan says whether a seat gets the team
  default's allowances. ([#3230](https://github.com/mvschwarz/openrig/pull/3230))
- **Bring a seat's permission, trust or hook-review prompt to your person as a
  question** by default (the `rigs` skill). Show the prompt, capture the seat
  again before sending, and send the digit or letter the screen shows for their
  choice, never their words; when the screen shows no key, ask. A yes to one
  prompt isn't a yes to the next, and an instruction they gave outright lets you
  decide that kind of prompt within what they said. Never record your own
  answer as theirs. ([#3206](https://github.com/mvschwarz/openrig/pull/3206))
- **After your person answers a prompt a seat stopped at while starting,** check
  `rig ps --nodes --rig <rig>` again: if it shows `Startup details (<seat>)`
  ending in `rig seat continue <seat>`, run that command, which delivers the
  seat's startup instructions in the same conversation. Send Escape as the key
  itself: `rig send <seat>@<rig> $'\e' --dangerously-interact --reason "…"`.
  Repeat the prompt check while you wait for a seat's result. ([#3271](https://github.com/mvschwarz/openrig/pull/3271))
- When more than one assistant on the team could be the one your person means,
  list the team and ask which. ([#3179](https://github.com/mvschwarz/openrig/pull/3179))
- On an external grant, `rig_team` names the team the way the person knows it
  and its members by their roster `label`; a label that breaks the rules is set
  aside with `label_problem`. ([#3221](https://github.com/mvschwarz/openrig/pull/3221), [#3249](https://github.com/mvschwarz/openrig/pull/3249))
- The `rigs` skill's setup path teaches an installing assistant the person
  stays with to keep its own return address, so the team's questions come back
  to it. ([#3134](https://github.com/mvschwarz/openrig/pull/3134))

### Recovery

- **After an upgrade, a seat's packaged recovery skills come back current:**
  on `rig up --existing`, a seat's own unedited copies of OpenRig's packaged
  skills, such as `claude-compaction-restore` and
  `seat-continuity-and-handover`, follow the current packaged source instead of
  staying at the earlier version or being named missing. An edited copy (its
  bytes or a file mode), a file OpenRig didn't write and a copy recorded from
  another source are kept, and the restore names each. A skill the seat's
  profile selects itself keeps its own restore policy. ([#3279](https://github.com/mvschwarz/openrig/pull/3279))
- **A handover failed but its successor is running:** for a Claude seat, try
  `rig seat handover <seat> --recover --reason "<why>"`, which adopts the
  running successor, before another handover or a fresh launch. It records the
  conversation the successor holds now, or the one its launch named with a
  warning when that can't be read. Recovery from a real failed handover wasn't
  checked when this release was tested. ([#3044](https://github.com/mvschwarz/openrig/pull/3044))
- **A seat's conversation lives under a home OpenRig doesn't know:**
  `rig seat runtime-home <seat>` shows the home the next launch uses, and
  `rig seat record-runtime-home <seat> --home <abs> --expect-occupant <gen>
  --expect-original <id> --expect-revision <n> --reason "<why>"` records it,
  with no relaunch or manual database edit. Recording sets the home used by the
  seat's next launch; a later explicit home change is retained, and restoring a
  selected conversation shows and applies the home selected for that original. ([#3220](https://github.com/mvschwarz/openrig/pull/3220))
- **A runtime switch stuck after a reboot:** a switch still before commit,
  past its deadline, with its staging session gone and no sign of its
  successor, settles as `abandoned` at daemon start or on
  `rig seat set-runtime <seat> --recover`. ([#3109](https://github.com/mvschwarz/openrig/pull/3109))
- A manual `rig compact` whose preparation stops at a prompt waits instead of
  disarming; `rig compact <seat> --state` shows the prompt. A manual compaction
  no longer needs a context-usage reading, so `rig compact <seat> --skip-map`
  compacts a seat at Claude Code's "Context limit reached" screen (checked once,
  in Claude Code's default mode). ([#3144](https://github.com/mvschwarz/openrig/pull/3144))
- A failed managed restore or preparation notice for a seat with no
  independent parent goes to the receiving agent or kernel operator, then a
  registered person. ([#3235](https://github.com/mvschwarz/openrig/pull/3235))
- An attached or adopted Claude seat can capture its resume token from process
  metadata. ([#3242](https://github.com/mvschwarz/openrig/pull/3242))
- `rig launch` isn't refused because another seat is paused or being typed in,
  and takes a seat's session name. ([#3184](https://github.com/mvschwarz/openrig/pull/3184))
- For the default `http://127.0.0.1:<port>` target, the TUI's daemon-only
  start passes only the port, so it honours the daemon's configured bind, or
  its default loopback-plus-Tailscale bind when none is configured. It doesn't
  promise a kernel that isn't listed. ([#3181](https://github.com/mvschwarz/openrig/pull/3181), [#3227](https://github.com/mvschwarz/openrig/pull/3227))

### Delivery, workflows and tools

- **A send to a missing seat prints "Recorded, not delivered"**: the message is
  in the sender's outbox, `--verify` exits nonzero, and a queue row keeps its
  exact address with a destination advisory (`destination_status`, or
  `unmatched_destination_seat` for a missing seat in a known rig). It isn't lost and it wasn't
  delivered: restore the seat or redirect the work. ([#3142](https://github.com/mvschwarz/openrig/pull/3142))
- A state-changing park or close carrying `--summary` or `--evidence-ref` is
  applied and stores the supplied non-blank fields; note-append and re-estimate
  rules are unchanged. ([#3136](https://github.com/mvschwarz/openrig/pull/3136))
- A draft typed while a conditional Enter's own checks wait makes the guard
  refuse with `draft_input_changed`. ([#3176](https://github.com/mvschwarz/openrig/pull/3176))
- A send to a busy Codex seat (0.167.1 and 0.167.2) with an empty input is
  delivered once. That's shown by the change's own tests; it wasn't checked
  with the real programs when this release was tested. ([#3232](https://github.com/mvschwarz/openrig/pull/3232))
- **A workflow whose frontier packet someone handed off:** `rig workflow route`
  to the same target adopts the handoff's successor, and `rig workflow project`
  records the exit on the closed packet. Replay with the original `--packet`. ([#3252](https://github.com/mvschwarz/openrig/pull/3252), [#3255](https://github.com/mvschwarz/openrig/pull/3255))
- `rig workflow list` filters by mission, project, rig, workflow, slice or
  tag. ([#3170](https://github.com/mvschwarz/openrig/pull/3170))
- MCP tools whose verb takes `--host` accept `host` on an owner connection, and
  `rig mcp token rotate <name>` replaces a file-backed grant's token in place,
  with no grace window. ([#3010](https://github.com/mvschwarz/openrig/pull/3010), [#3200](https://github.com/mvschwarz/openrig/pull/3200))
- Per-seat Codex filesystem policies (`codex_permissions` filesystem form) are
  carried through managed launch, resume, restore and rebuild, and the resume
  command `rig ps` shows carries their flags. When this release was tested,
  enforcement wasn't checked with a real Codex seat, and neither were a manual
  resume with that command nor two seats keeping their policies apart. ([#3108](https://github.com/mvschwarz/openrig/pull/3108), [#3239](https://github.com/mvschwarz/openrig/pull/3239))
- `rig ps` names the daemon it answered from, and `--fields activityState`
  works with `--nodes --json`. The TUI's Projects view can span registered
  hosts. ([#3107](https://github.com/mvschwarz/openrig/pull/3107), [#3240](https://github.com/mvschwarz/openrig/pull/3240), [#3191](https://github.com/mvschwarz/openrig/pull/3191))

### Limits to keep in view

- **Restore's overall result:** a rig can still read `fully_restored` while a
  seat restore didn't start, or a seat kept in its external CLI attachment,
  goes unnamed. A seat restore left as a bare shell after "Harness not started"
  still counts as running in `rig ps`. `restore-check` can also say "Restore
  tries …" for a self-attached member that restore leaves out; that member
  isn't restored.
- **Draft-aware delivery ([#3076](https://github.com/mvschwarz/openrig/issues/3076)):** typing after the guard's final check and before
  the paste can still leave the notice beside the person's draft, and text
  typed after the input read before a conditional Enter can still be submitted
  with OpenRig's text. Neither narrowing is checked with the real programs on
  this release.
- **A wide Claude Code footer:** with Claude Code's full-width
  auto-update-failure footer on screen, a seat in the opt-in draft-aware typing
  mode whose input is empty can hold an ordinary send. The message is kept;
  `rig seat held-messages` shows it.
- **Seats at the edit floor can stop for approval, OpenRig's own commands
  included.** A Claude seat at the harness's edit floor can ask before shell
  commands, including read-only `rig` commands. A `standard` or `open` seat now
  keeps the team default; other recorded choices keep their meaning. A seat that
  keeps the team default can still ask before the project's own commands, such
  as running its tests or `git add` and `git commit`. Each prompt waits until
  someone approves it, so a team can stall while nobody answers.
- **A question about a seat's prompt can wait with the kernel operator.** If
  you aren't registered as the team's person, OpenRig's question about a seat's
  prompt doesn't reach you; it waits with the kernel operator. The kernel
  operator's offer to register you mentions pairing, but seat questions need a
  registered person too. Registering wasn't tested as a fix for this. This is
  OpenRig's own question, separate from your agent reading a seat's screen and
  bringing its prompt to you.
- **Approvals your agent recorded:** In one Claude setup, your agent recorded
  approvals it made itself as "Person approved". Those entries alone do not
  establish your approval; check the conversation to see who actually decided.
- **A new Claude agent's startup text can stay unsent in its input box while
  the seat reads ready.** Press Enter in its terminal.
- **Managed compaction with Claude Code 2.1.322** (other versions weren't run;
  0.7.15 behaves the same): if someone has typed text in the seat's input box
  when managed compaction runs, `/compact` can be sent as part of that text
  instead of as a command. The seat isn't compacted, but `rig compact --state`
  reports the compaction, restore and audit as sent. Make sure the input box is
  empty before compacting, and check that the seat actually compacted. With the
  draft-aware typing guard on, the long preparation prompt can stay unsent (it
  shows as `[Pasted text #1]`), and the attempt stops as
  `preparation_incomplete`.
- **Packaged skills across an upgrade:** a Claude seat that loads the vendored
  openrig-core plugin reads these skills from the plugin and keeps no seat
  copies. A resumed Codex conversation isn't sent its skill catalog again until
  a fresh start; the files are current. When an upgrade changes only one file's
  mode and another file's bytes, and `rig down` had already removed the first,
  the copy is kept and named rather than followed. If saving a skill's new
  record fails, files whose source changed are named missing, as before, and a
  later restore tries again.
- **Linked Codex config files:** when a Codex seat's `config.toml` or
  `hooks.json` is a symbolic link, OpenRig records its hook trust under the
  link's target, as in 0.7.14. A change to key it by the file's own name isn't
  in this release, and such a seat may be asked to review hooks again. With a
  linked `config.toml`, OpenRig can also miss a setting stored for it that
  turns OpenRig's hooks off, and set those hooks up anyway when it moves them
  into `hooks.json`. ([#3078](https://github.com/mvschwarz/openrig/issues/3078))
- **Daemon memory:** 0.7.14's comparison under load established neither equal
  memory nor a regression against 0.7.13. This release makes no memory claim.
- **From 0.7.15:** its limits below still apply, except where this release
  changes them: [#3232](https://github.com/mvschwarz/openrig/pull/3232) repairs the input read behind the busy Codex seat case,
  [#3230](https://github.com/mvschwarz/openrig/pull/3230) changes which seats launch at the edit floor, and [#3176](https://github.com/mvschwarz/openrig/pull/3176) narrows the
  conditional Enter window.

## What changed in OpenRig 0.7.15

This note is for an agent on an install that was just upgraded to 0.7.15.
OpenRig 0.7.15 takes some repeated synchronous work off a busy daemon's read
paths and names more of what it was doing when it stalls. `rig daemon start`
has a 180-second readiness budget for a slow start. Restore tries a saved
conversation when an eligible seat has no saved startup context, and records it
as a gap. Slack previews on
posts to a person are off by default. It adds one database migration. If you
upgraded from 0.7.13 or earlier, also read "What changed in OpenRig 0.7.14"
below, and so on back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Stop, back up, install, then start.** `rig daemon stop` (seats keep running,
  so don't use `rig down`), copy the database file (`rig config get db.path`
  shows it), install 0.7.15 with the existing installation method, then
  `rig daemon start`.
- **One migration runs before the daemon listens.** Migration 165 adds four
  columns and two indexes to `activity_grants`. Going back to 0.7.14 after it
  isn't established; keep the backup.
- **A slow start:** `rig daemon start` now gives the daemon child it started a
  180-second readiness budget, printing "Waiting for daemon child <PID>
  readiness …" about every 20 s. Let it finish, then read `rig daemon status`.
  Synchronous work can run past the budget. A child still not ready when that
  budget is exhausted is reported pending as before; follow that message's
  restart steps before starting again. The longer budget doesn't identify or
  cure the cause of a slow start.
- **The plugins:** the `openrig` plugin's manifests carry the CLI's version,
  0.7.15. openrig-core moves to 0.1.30, because its skills changed.

### Restore, seats and delivery

- **A seat with a resume token but no saved startup context:** for an eligible
  seat in a rig with pods that restore starts in its own pane, restore now
  tries the saved conversation with an empty plan and records the
  `startup_context` gap. A successful resume with that gap makes the rig read
  `partially_restored`: that's the honest result, not a failure. A missing
  conversation or failed start keeps its own status. No saved startup plan is
  replayed; the adapter's ordinary bootstrap and existing skill restoration
  still run. An external CLI attachment is kept, and no-token seats still wait
  for a decision. `restore-check` reads an eligible seat with a token yellow. ([#3177](https://github.com/mvschwarz/openrig/pull/3177))
- **`rig seat restart --keep-conversation`** names `rig launch '<rig>' '<node>'`
  when it refuses a recoverable seat whose tmux session is gone. ([#3135](https://github.com/mvschwarz/openrig/pull/3135))
- **When a daemon stalls,** read `logs/slow-operations.jsonl`: it adds three
  queue sites and three selected steps of an ordinary nodes read
  (`nodes.inventory.build`, `nodes.inventory.activity_sync`,
  `nodes.inventory.terminal_work`). These nodes records are written after a
  slow call completes; a missing record does not rule out unfinished work or
  work outside those steps. ([#3100](https://github.com/mvschwarz/openrig/pull/3100), [#3138](https://github.com/mvschwarz/openrig/pull/3138))
- **Draft-aware pastes** re-check the input right before pasting, and hold
  after recent client activity or when tmux can't be read. An ordinary guarded
  paste waits about 300 ms longer. This is shown by the change's own tests; it's
  not yet checked with the real programs on this release. ([#3097](https://github.com/mvschwarz/openrig/pull/3097))
- **A terminal seat whose tmux session has another name** gets the exact text
  of a send, with no From/To envelope typed into its shell. ([#3074](https://github.com/mvschwarz/openrig/pull/3074))
- **Slack:** when the arrival note is recorded before the answer is routed, an
  answer to a reply in an older thread posts back into that thread; otherwise
  it posts top-level (see the limits below). ([#3120](https://github.com/mvschwarz/openrig/pull/3120))

### Other changes to act on

- **Slack previews on posts to a person are off by default.** An existing
  install stops showing link and media previews after its next connector rewire
  or daemon restart. `rig slack setup --unfurl on` turns them back on, and
  `rig slack status` shows the mode. Earlier previews aren't removed. ([#3157](https://github.com/mvschwarz/openrig/pull/3157))
- **OpenRig's own changed Codex hook declarations are renewed** from its record
  at the start or seat launch that installs a new openrig-core, instead of
  stopping at Codex's hook review. It runs in the daemon's Codex home at start,
  when hooks are on and a Codex seat selected openrig-core, and in each such
  seat's own Codex home at its launch. A person's own choice in any layer
  OpenRig reads keeps the review. ([#3143](https://github.com/mvschwarz/openrig/pull/3143))
- `restore-check` and restore warn when a snapshot's named Codex profile was
  cleared from the current seat. ([#3155](https://github.com/mvschwarz/openrig/pull/3155))
- Runner activity grants are bound to the actual launch, and the
  replacement's activation revokes its predecessor's grant. A grant made before
  this release stays tied to the seat's occupant until then. ([#3060](https://github.com/mvschwarz/openrig/pull/3060))
- `rig context work-install --mission <missing>` warns that the mission doesn't
  exist. ([#3141](https://github.com/mvschwarz/openrig/pull/3141))
- A connected assistant is told to leave `rigId` out of `rig_team` to see its
  own team, and an external inbox grant is told only about the tools it's
  offered. ([#3104](https://github.com/mvschwarz/openrig/pull/3104), [#3140](https://github.com/mvschwarz/openrig/pull/3140))
- The TUI keeps connected assistants' check-in lines when a rig's inventory
  can't be read. ([#3105](https://github.com/mvschwarz/openrig/pull/3105))
- The `openrig` plugin needs Claude Code 2.1.119 or later. ([#3137](https://github.com/mvschwarz/openrig/pull/3137))
- Terminal views find tmux again when its cached path is gone, and a
  `SKILL.md` with CRLF line endings is discovered. ([#3129](https://github.com/mvschwarz/openrig/pull/3129), [#3153](https://github.com/mvschwarz/openrig/pull/3153))

### Limits to keep in view

- **Daemon memory:** 0.7.14's comparison under load established neither equal
  memory nor a regression against 0.7.13. This release makes no memory claim.
- **Restore's overall result:** a rig can still read `fully_restored` while a
  seat restore didn't start, or a seat kept in its external CLI attachment,
  goes unnamed. A seat restore left as a bare shell after "Harness not started"
  still counts as running in `rig ps`. `restore-check` can also say "Restore
  tries …" for a self-attached member that restore leaves out; that member
  isn't restored.
- **Draft-aware delivery ([#3076](https://github.com/mvschwarz/openrig/issues/3076)):** typing after the guard's final check and before
  the paste can still leave the notice beside the person's draft. In the tested
  append-mode schedule Enter was refused and nothing was submitted or deleted;
  this is not a guarantee for every interleaving. The prior conditional-send
  Enter-window case is unchanged.
- **Slack reply threads:** recording the arrival note is best effort: a failed
  write is not retried and that answer posts top-level. Creating the message
  and recording the arrival note are separate writes, so a notification can
  also be posted before the note is recorded, with the same top-level outcome.
  The person's message is kept. ([#3120](https://github.com/mvschwarz/openrig/pull/3120))
- **A wide Claude Code footer:** with Claude Code's full-width
  auto-update-failure footer on screen, a seat in the opt-in draft-aware typing
  mode whose input is empty can hold an ordinary send. The message is kept;
  `rig seat held-messages` shows it.
- **Draft-aware delivery to a busy Codex seat:** on Codex (seen with 0.167.1
  and 0.167.2), a send to a seat in the opt-in draft-aware typing mode while
  it's busy can be pasted into its input without Enter. The message isn't
  delivered, and it isn't kept for `rig seat held-messages`. A deliberate send
  reports failed, and its text stays in the seat's input box. This was seen on
  0.7.12 and 0.7.14, and there's no fix for it in this release.
- **Seats at the edit floor can stop for approval, OpenRig's own commands
  included.** A Claude seat running at the harness's edit floor can ask for
  approval before shell commands, including OpenRig's own read-only `rig`
  commands such as `rig whoami` and `rig queue show`. Choosing a built-in
  policy such as standard when your team is set up doesn't change that at
  launch: the plan shows `launch_posture=floor`. Each prompt waits until
  someone approves it, in the seat or through your own agent, so a team can
  stall while nobody answers.
- **Approvals your agent recorded:** In one Claude setup, your agent recorded
  approvals it made itself as "Person approved". Those entries alone do not
  establish your approval; check the conversation to see who actually decided.
- **A new Claude agent's startup text can stay unsent in its input box while
  the seat reads ready.** Press Enter in its terminal.
- **Linked Codex config files:** when a Codex seat's `config.toml` or
  `hooks.json` is a symbolic link, OpenRig records its hook trust under the
  link's target, as in 0.7.14. A change to key it by the file's own name isn't
  in this release, and such a seat may be asked to review hooks again. With a
  linked `config.toml`, OpenRig can also miss a setting stored for it that
  turns OpenRig's hooks off, and set those hooks up anyway when it moves them
  into `hooks.json`. ([#3078](https://github.com/mvschwarz/openrig/issues/3078))
- **From 0.7.14:** its limits below still apply, except where this release
  changes them: the TUI keeps check-in lines ([#3105](https://github.com/mvschwarz/openrig/pull/3105)), and the draft-aware paste
  window is narrower, as [#3097](https://github.com/mvschwarz/openrig/pull/3097)'s own tests show.

## What changed in OpenRig 0.7.14

This note is for an agent on an install that was just upgraded to 0.7.14.
OpenRig 0.7.14 makes concurrent node reads take turns and indexes bounded queue
listings over retained history. In the change's own tests, taking turns kept
health checks and queue reads from waiting behind a whole burst; a comparison
under load didn't attribute that gain to this change. A connected assistant
reaches a seat by its plain name and hears three new errors when it can't.
Connected assistants show in `rig ps`,
`rig_team` and the TUI. It adds three database migrations. If you upgraded from
0.7.12 or earlier, also read "What changed in OpenRig 0.7.13" below, and so on
back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Stop, back up, install, then start.** `rig daemon stop` (seats keep running,
  so don't use `rig down`), copy the database file (`rig config get db.path`
  shows it), install 0.7.14 with the existing installation method, then
  `rig daemon start`.
- **Three migrations run before the daemon listens.** Migration 163 adds the
  `network_installations` table and four columns to `network_bindings`.
  Migrations 164 and 166 build indexes. The author's measurement of 166 took
  3.47 s on 28,976 rows, not a real installation's size, so a large database can
  take longer. The write overhead, and going back to 0.7.13 after these three
  migrations, aren't established; keep the backup.
- **If the start is reported pending:** the CLI waits 20 s, then may print
  "Daemon startup is pending after the readiness deadline". Readiness remains
  unconfirmed. It leaves the child running and the startup reservation
  retained, without recording the daemon. Inspect the address and log it
  prints. The child may later answer, and status can then report it running,
  but that does not finish this start's recording or release its reservation.
  Don't start it again until the steps below are done. The message's restart
  steps stop that child and clear the reservation: stop the named child PID and
  wait for it to exit, inspect `daemon-start.lock`, and only when both recorded
  launcher and child PIDs are absent, archive the lock and run
  `rig daemon start`. On a large database the new start can be reported pending
  again; reaching a recorded start this way hasn't been tested.
  `rig daemon stop` cannot stop that unpublished child.
- **The plugins:** openrig-core stays 0.1.29. The `openrig` plugin's manifests
  carry the CLI's version, 0.7.14.

### Reads, seats and people

- **Node reads take turns** through their three synchronous steps (inventory;
  activity; terminal and work). A nodes response is no longer one snapshot
  across those steps, and in a burst each response comes later: about 43 ms
  against 21 ms median in a 24-request burst. One very large rig is still one
  step. ([#3101](https://github.com/mvschwarz/openrig/pull/3101))
- **A plain seat name over MCP** resolves to the seat's actual session: its own
  name, then its pod-member form, then that name's slug, among seats the grant
  can address. Three errors are new: `destination_ambiguous` (pass one of the
  listed candidates), `destination_not_found` (no reachable seat has that name;
  `rig_team` lists the names) and `destination_unchecked` (the team couldn't be
  read; try again). ([#3088](https://github.com/mvschwarz/openrig/pull/3088))
- **Connected assistants** are listed with their check-in line in `rig ps`,
  `rig_team` and the TUI's tables. The check-in is a status, never a gate on
  delivery. ([#3057](https://github.com/mvschwarz/openrig/pull/3057), [#3058](https://github.com/mvschwarz/openrig/pull/3058))
- **Before a first team launches, check the logins it needs.** `rig doctor` and
  setup now explain that a missing login matters when a seat you would start
  runs on that harness. The operator is taught to check before launch;
  `rig specs preview <team> --kind rig --json` shows each seat's runtime.
  ([#3077](https://github.com/mvschwarz/openrig/pull/3077))
- **Registration guidance:** when the readable person registry holds nobody,
  `rig daemon start` and `rig gateway participants` tell the setup agent to
  offer registration. The kernel operator is taught to offer it in its greeting
  and register only on a yes. ([#3041](https://github.com/mvschwarz/openrig/pull/3041), [#3071](https://github.com/mvschwarz/openrig/pull/3071))

### Other changes to act on

- An ordinary send is refused as needing input while an open Claude Code or
  Codex `/model` picker is positively identified; nothing is typed. Close the
  picker before trying to deliver the message. This is shown by the change's
  own tests; it hasn't yet been checked with the real Claude Code and Codex
  programs on this release. ([#3083](https://github.com/mvschwarz/openrig/pull/3083))
- On a resume of a Codex seat's own conversation in a rig with pods, including
  `rig up --existing`, OpenRig avoids adding missing guidance blocks to the
  repository's tracked `AGENTS.md` when Codex is 0.164.0 or later, no guidance
  file or developer instructions are configured, and the configuration and
  block sources can be read. ([#3039](https://github.com/mvschwarz/openrig/pull/3039))
- `rig queue list --tag <t>` (repeatable, all must match), `--mission` and
  `--slice` filter exactly. ([#3066](https://github.com/mvschwarz/openrig/pull/3066))
- `rig broadcast` prints a held recipient as retained; nothing was typed there.
  ([#3054](https://github.com/mvschwarz/openrig/pull/3054))
- `rig compact --state` names the input check that stopped a managed
  compaction (`inputReadFailure`). ([#3053](https://github.com/mvschwarz/openrig/pull/3053))
- `rig workflow validate` adds a `harness_pin_unchecked` warning for each
  pinned step. ([#3102](https://github.com/mvschwarz/openrig/pull/3102))
- Account erasure also removes OpenRig's own wakes and notices for the
  account's seats. ([#3089](https://github.com/mvschwarz/openrig/pull/3089))
- With `recovery.auto_drive_provider_prompts` on, Claude Code's gated-grants
  trust check is never answered for you. ([#3073](https://github.com/mvschwarz/openrig/pull/3073))

### Limits to keep in view

- **Queue listings:** the new indexes aren't a cure for every stall. Listings of
  active work showed no gain, one case was slower, and writes weren't measured.
  ([#3090](https://github.com/mvschwarz/openrig/pull/3090))
- **Daemon memory:** in a comparison under load, the daemon's resident
  anonymous memory and its memory when idle afterwards had medians about
  23-25 MiB higher than on 0.7.13, but the runs overlapped. Neither equal
  memory nor a regression is established.
- **Draft-aware delivery ([#3076](https://github.com/mvschwarz/openrig/issues/3076)):** an automatic notice can still be left beside a
  draft started during delivery. On a conditional send, one that names the
  conversation it expects, an isolated test with a scripted terminal also showed
  characters typed during OpenRig's last checks before Enter submitted with
  OpenRig's text; that hasn't been tested with a real client or model.
- **The TUI's tables** can drop a connected assistant's check-in line when its
  rig's seat inventory can't be read; `rig roster` still prints it.
- **Repository guidance on restore:** rigs without pods, old or unknown Codex
  versions, configured guidance and unreadable configuration keep the existing
  file path. Fresh, fork and handover launches are outside this resume fix.
  Existing managed blocks may still refresh, and the seat-skills line still
  belongs to the file writer; check `git status`. A block whose source can't be
  read is reported missing.
- **Linked Codex config files:** when a Codex seat's `config.toml` or
  `hooks.json` is a symbolic link, OpenRig records its hook trust under the
  link's target, as in 0.7.13. A change to key it by the file's own name isn't
  in this release, and such a seat may be asked to review hooks again. With a
  linked `config.toml`, OpenRig can also miss a setting stored for it that
  turns OpenRig's hooks off, and set those hooks up anyway when it moves them
  into `hooks.json`. ([#3078](https://github.com/mvschwarz/openrig/issues/3078))
- **From 0.7.13:** its limits below still apply, except where this release
  fixes them. The runtime fixes cover adding missing guidance on the eligible
  Codex resumes described above and the unquoted pairing description. The fix
  for recognized model pickers is shown by the change's own tests and hasn't
  yet been checked with the real programs on this release. This release also
  changes the operator-first registration and pre-launch login guidance. In a
  few test runs with real agents, the operator offered registration once in its
  greeting, on Claude Code and on Codex (one run each); a no registered nobody,
  and a yes registered the default person. The person saw the offer in 3 of 4
  runs; in the fourth, the setup agent didn't pass the operator's offer on. The
  login guidance worked in both runs tested.

## What changed in OpenRig 0.7.13

This note is for an agent on an install that was just upgraded to 0.7.13.
OpenRig 0.7.13 writes a person a note after they answer a runner's permission
request and wakes the waiting runner on the decision. It tells a receiving agent
what an answer typed at the machine means and how to ask the person back.
`rig daemon start` tells the setup agent to offer to register the person when nobody is registered,
and a usage-limited Claude seat waits for the reset its message states. It adds
three database migrations. If you upgraded from 0.7.11 or earlier, also read
"What changed in OpenRig 0.7.12" below, and so on back. For the full capability
map, read `rig context get onboarding-width/public-what-you-can-do.md`. After the
upgraded daemon starts, `rig context get reference/whats-new.md` describes this
version. Without a running daemon, read the packaged
`daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Back up the database, install 0.7.13, then restart the daemon:** `rig daemon stop`,
  copy the database file (`rig config get db.path` prints its path), install
  OpenRig 0.7.13 using your existing installation method, then `rig daemon start`.
  Your agents keep running through a daemon restart; don't use `rig down`, which
  ends them. Three migrations run on the daemon's first start: 160 and 161 (for
  the experimental hub connector below) and 162 (indexes for session reads).
  Going back to 0.7.12 after them isn't established.
- **The plugins:** openrig-core moves from 0.1.28 to 0.1.29 (its activity relay
  and refocus hooks changed). The `openrig` plugin's manifests now carry the
  CLI's version, 0.7.13. A Codex seat can ask for hook approval after the
  upgrade; see Codex hook review after an upgrade below.

### Answers, setup and seats

- **A runner's permission answer gets a note back to the person:** who decides
  it and in what state, or that it's kept and the tool hasn't run. A runner
  already waiting sees the decision at once. If a person asks what happened to
  an answer, read that note before asking them to answer again. If it says the
  answer couldn't be passed on, follow its retry instruction or use the
  `rig seat decide-permission` command it names.
  ([#3001](https://github.com/mvschwarz/openrig/pull/3001))
- **If you receive a person's answer**, the text you read now says what an answer
  typed at this machine's terminal or TUI means (recorded as `human@host`): act
  on a clear one with the request's own decision command, and don't ask them to
  confirm. When it's unclear, ask them back with a new ask to them
  (`rig queue create --destination <person> …`), never to `human@host`. When the
  default receiving agent asks back, the question reaches the person's Feed and
  their reply decides. Closing a runner's request without deciding permits nothing.
  ([#3030](https://github.com/mvschwarz/openrig/pull/3030))
- **Setup:** when the person registry can be read and holds nobody,
  `rig daemon start` ends by telling the setup agent to offer to register the
  person, with the command to run only on their yes; pass it on. Asking to be
  reachable registers the person as the default directly. In fresh-install
  tests the setup agent passed the offer on in 5 of 6 installs, and a no
  registered nothing. `rig up`, `rig start` and `rig context` start the daemon
  without printing it. A person who talks to the
  kernel operator first isn't offered registration in this release: offer
  `rig gateway human add` yourself. ([#3028](https://github.com/mvschwarz/openrig/pull/3028))
- **A first team's permissions:** in the change's own tests, before launch, the
  kernel operator names the commands the team will ask for, reuses a choice the
  person made, or makes one project-scoped offer, applied on their yes. Don't
  tell the person it means fewer asks: that hasn't been shown. Chained commands
  and OpenRig's own lifecycle commands still ask on Claude seats. ([#3029](https://github.com/mvschwarz/openrig/pull/3029))
- **A usage-limited Claude seat** whose limit message states a reset time parks
  its pending work until then. Don't release it on a timer.
  ([#2917](https://github.com/mvschwarz/openrig/pull/2917))

### Other changes to act on

- **Handover:** a handover whose successor launched but isn't ready says it may
  be running. Look at the pane (`rig capture '<seat>'`) before another handover
  or a fresh launch, either of which ends it. A handover also cleans up the
  retiring occupant's own claims and jobs. ([#3003](https://github.com/mvschwarz/openrig/pull/3003), [#3024](https://github.com/mvschwarz/openrig/pull/3024))
- **Adopted sessions:** release one with `rig unclaim <session>`, then end its
  process and its tmux session. Closing its viewing window only detaches it. A
  fresh launch after that ended the server's last session reopens the server.
  ([#2996](https://github.com/mvschwarz/openrig/pull/2996), [#3006](https://github.com/mvschwarz/openrig/pull/3006), [#3009](https://github.com/mvschwarz/openrig/pull/3009))
- **Connected assistants** show a check-in status against the cadence their
  roster entry states (`check_in_minutes` or `check_in_on_request: true`), as a
  Check-in line in `rig roster show` and `find`. It's a status, not a delivery
  gate, and a cadence is the person's statement, not proof the assistant ran.
  ([#3023](https://github.com/mvschwarz/openrig/pull/3023))
- **Passive SSH host status reads `unknown`** now that routine listings don't
  probe SSH hosts. Use `rig host doctor` to check one. ([#2979](https://github.com/mvschwarz/openrig/pull/2979))
- **Guidance files:** cleanup removes redundant recognized copies of a managed
  block and keeps distinct edited copies. A saved write record lets OpenRig keep
  a person's edits; on a fresh start, a differing block with no write record is
  refreshed and named, while an exact resume or restore keeps it. A recognized
  block whose marker pair is incomplete is named
  (`guidance_block_markers_damaged`) and left as it is; repair the marker by
  hand. If both marker words were changed, it can read as no block. ([#3020](https://github.com/mvschwarz/openrig/pull/3020))
- **Delivery reads truer:** Claude's auto-update failure footers (one clipped form
  too) no longer hold a send, an unrecognised wake result reads unknown, and an
  ordinary one-time park wake is kept and retried while its park is
  current and the failed attempt typed nothing (an unknown effect needs checking;
  repeating waits and usage-limit expiry keep their own lifecycle). ([#2948](https://github.com/mvschwarz/openrig/pull/2948), [#3016](https://github.com/mvschwarz/openrig/pull/3016), [#3011](https://github.com/mvschwarz/openrig/pull/3011), [#3038](https://github.com/mvschwarz/openrig/pull/3038))
- **The TUI:** for a quiet seat the daemon explicitly reads as unknown, the
  list, explorer and agent-detail status rows show unknown. Screen motion still
  shows active, a daemon that serves no activity keeps the screen fallback, and
  the topology graph is unchanged. Feed times use `ui.timezone`. ([#3012](https://github.com/mvschwarz/openrig/pull/3012), [#3022](https://github.com/mvschwarz/openrig/pull/3022))
- **Experimental, at the person's own risk:** `rig network` connects one local
  seat to a hub they already have. The connector uses the MCP SDK, which the
  installed package already included in 0.7.12. The daemon starts it even with
  no binding.
  ([#2993](https://github.com/mvschwarz/openrig/pull/2993))

### Limits to keep in view

- **Not in this release:** a Codex snapshot restore or `rig up --existing` can
  write OpenRig's managed guidance into a tracked `AGENTS.md`, leaving the
  worktree modified; check `git status` after either operation.
- **Not in this release:** the kernel operator's own registration offer, as above
  ([#3041](https://github.com/mvschwarz/openrig/pull/3041)). While nobody is registered, `rig daemon start` repeats its offer
  even after a no; nothing is registered without a yes.
- **Speed and memory:** On one performance host, whole `rig queue create`
  invocations had a median about 10.4% slower than 0.7.12 (about +29 ms). Send
  latency stayed within the comparison's unchanged range. The cause remains
  unidentified. The standard idle-memory comparison was inconclusive. A post-hoc
  analysis of the same six runs found 7.9–8.6 MiB (4.2–5.3%) higher daemon RSS
  across three matched idle windows, using the median of three arm medians per
  version. The cause and steady-state behavior remain unestablished.
- **Draft-aware delivery ([#3076](https://github.com/mvschwarz/openrig/issues/3076)):** an automatic OpenRig notice can be left beside a
  draft started during delivery. This also concerns notices admitted by
  openrig-urgent and urgent-only modes. In the reproduced 0.7.12 Claude Code and
  Codex cases, the person's draft remained intact and no Enter was sent, but
  OpenRig's text stayed in the input. The guard and paste path are unchanged in
  this cut; a native 0.7.13 reproduction has not run.
- **Native model pickers:** with a /model picker open, an ordinary send can act
  on the picker instead of delivering the message. In 0.7.12 tests it confirmed
  Claude Code's already-selected default and advanced Codex's model selection;
  neither message reached the model. Close or deliberately resolve the picker
  before ordinary delivery. The native 0.7.13 case has not run.
- **Codex hook review after an upgrade:** in one test whose Codex home already
  held earlier hook approvals, `rig up --existing` stopped for hook review in
  each Codex pane; approving the hooks resumed all three conversations. A
  separate test of the same upgrade on a fresh Codex home, on another host,
  restored without review. The cause of the difference is not established.
- **A first team with Codex installed but signed out:** a Claude person's starter
  team includes a Codex reviewer that waits for a Codex sign-in, and the person
  isn't told beforehand. If Codex is installed, tell the person about the
  possible sign-in wait before the team starts; signing in first was not tested
  as a remedy.
- **The hub connector isn't inert:** it starts, sweeps leftover credential
  folders and schedules local rounds even with no binding; only the hub pass is
  absent. Don't describe it as off. ([#2993](https://github.com/mvschwarz/openrig/pull/2993))
- **The recorder:** a queued begin record can be lost before the durable append,
  and a stalled worker has no acknowledgement timeout. ([#3019](https://github.com/mvschwarz/openrig/pull/3019))
- **Proof reads** are much more responsive, but still pause briefly, and a whole
  read takes slightly longer. It isn't a hard latency bound or an atomic snapshot. ([#2970](https://github.com/mvschwarz/openrig/pull/2970))
- **Usage-limit parking** was tested with `claude -p`'s message; if an
  interactive seat's report lacks it, the seat is retried as before. ([#2917](https://github.com/mvschwarz/openrig/pull/2917))
- **Handover:** a context delivery failure, and a Codex launch failure after an
  undismissed update prompt, can still say "retry" while a successor runs.
  ([#3003](https://github.com/mvschwarz/openrig/pull/3003))
- **Answers:** an ask-back can stop at Claude Code's own permission prompt,
  which the person doesn't see. A receiving agent the person chose can still
  decline to act on a clear answer. A pairing requester's description is quoted
  for the receiving agent but not yet in the request's summary or notices.
  ([#3030](https://github.com/mvschwarz/openrig/pull/3030))
- **0.7.12's limits below** still apply, except that [#2970](https://github.com/mvschwarz/openrig/pull/2970) and [#2948](https://github.com/mvschwarz/openrig/pull/2948)
  are now in this release, runner answers are confirmed and reach a waiting
  runner at once ([#3001](https://github.com/mvschwarz/openrig/pull/3001)), and `rig seat stop` no longer suggests `rig down`
  for an adopted session ([#3006](https://github.com/mvschwarz/openrig/pull/3006)). 0.7.12's not-run list was for that release.

## What changed in OpenRig 0.7.12

This note is for an agent on an install that was just upgraded to 0.7.12.
OpenRig 0.7.12 routes a person's typed, clicked or qualified answers with the
question to the configured receiving agent or the kernel operator to decide.
Answers wait when no receiver is available. Setup's guidance asks the agent to
offer to register the person, which it didn't reliably do in testing. `rig down` stops
only terminals it can show belong to the seat. It adds five database
migrations. If you upgraded from 0.7.10 or earlier, also read "What changed in
OpenRig 0.7.11" below, and so on back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Back up the database, then restart the daemon.** Five migrations run on the
  daemon's first start: 155, 156 and 157 (queue erasure and its batches), 158
  (queue inbox check-ins) and 159 (an index for handed-off rows). If
  `$OPENRIG_DB` isn't backed up yet, copy that file (`rig config get db.path`
  shows it) with the daemon stopped, then `rig daemon start`. Going back to
  0.7.11 after these migrations isn't established.
- **New settings:** `retention.closed_content_days` (`0`, keeps closed work's
  content), `retention.closed_metadata_days` (`0`) and `retention.erasure_ledger`
  (empty, no ledger). Erasing closed work is opt-in. `rig config` shows each with
  its source.
- **The openrig-core plugin moves from 0.1.27 to 0.1.28.** Its activity relay
  and refocus hooks changed (with a new `refocus-state.cjs`), as did the
  agent-operated-software, claude-compaction-restore, openrig-user,
  retiring-and-inheriting-a-seat, seat-continuity-and-handover and
  session-compaction-and-restore skills. A Codex session kept running across the
  upgrade can ask for hook approval until it's relaunched.
- **`rig down` now leaves some terminals running.** It stops only a tmux session
  carrying the seat's own `OPENRIG_NODE_ID`, on the server and session it read.
  For a terminal OpenRig didn't create, or a mismarked or replaced one, it exits
  2 and names the terminal and how to stop it. A seat joined with `rig attach` as
  an external CLI is listed as not stopped, which alone doesn't make it exit 2.
  Tell the person, and stop those by hand if they're theirs to stop.
  ([#2962](https://github.com/mvschwarz/openrig/pull/2962))

### Answers from a person reach an agent

- Answers nothing else reads, such as a host pairing request or a mode's
  scheduled end, use the configured receiving agent or the kernel operator.
  Answers wait when no receiver is available, and nothing decides them
  meanwhile; a direct decision uses the request's own command (`rig host approve`
  or `rig host deny`, `rig seat decide-permission`). An ordinary close isn't
  permission, and kept words aren't a default permit. ([#2923](https://github.com/mvschwarz/openrig/pull/2923))
- Pairing answers go to the receiving agent, and a person can decide directly in
  the TUI's pairing settings. ([#2931](https://github.com/mvschwarz/openrig/pull/2931), [#2935](https://github.com/mvschwarz/openrig/pull/2935))
- A runner's permission answer goes to the receiving agent, which decides while
  the runner waits, so a qualified answer ("only if it's the test file") is
  read before anything acts. The answer is kept and an explicit decision works,
  but the runner's confirmation updates to the person aren't written in this
  release: no Feed confirmation, receiver-state notice or immediate wake. The
  decision reaches the runner at its next read (up to about 21 seconds in
  testing). Decide one directly with `rig seat decide-permission`. ([#2934](https://github.com/mvschwarz/openrig/pull/2934))
- **What to do:** design for an agent to read the person's answer with its
  question and decide. If no receiver is available, say the answer is waiting;
  don't describe it as read or decided. Pairing settings in the TUI also offer
  the direct decision described above.
- **A chosen receiver** (`agents.operator_session`) in an explicit or auto
  permission mode gets no OpenRig allowance for `rig host approve` or `deny`, so
  Claude's review can refuse them; a kernel receiver in auto mode is included.
  The default kernel with the default policy passed at its tested scope.
- **A receiver that was stopped and then started** may not act on an answer
  that waited for it. When it needed to ask back in testing, the question
  appeared in its own conversation, not in the Feed or Steering.

### Other changes to act on

- **Setup's guidance** asks the agent to offer to register the person; in
  testing it didn't reliably make the offer (0 of 5 runs). Registering works
  when the person asks for it (`rig gateway human add`): nothing is registered
  without their yes, an existing default is kept, and no person is chosen
  automatically. A team started from the person's own assistant fits their
  logins, with a review before commit. ([#2924](https://github.com/mvschwarz/openrig/pull/2924), [#2905](https://github.com/mvschwarz/openrig/pull/2905))
- **Harnesses:** `protocol: pi-rpc`, launch wrappers in presets, and Pi
  cross-runtime switches. ([#2870](https://github.com/mvschwarz/openrig/pull/2870), [#2759](https://github.com/mvschwarz/openrig/pull/2759), [#2669](https://github.com/mvschwarz/openrig/pull/2669))
- **A relay connector** that can't accept incoming connections can pull
  (`OPENRIG_RELAY_MODE=pull` in the relay secrets file); push stays the default.
  ([#2844](https://github.com/mvschwarz/openrig/pull/2844))
- **herdr-app:** `rig terminal open <view> --provider herdr-app` opens a view in
  the herdr-app window. Following isn't claimed. ([#2744](https://github.com/mvschwarz/openrig/pull/2744))
- **Queue erasure** for closed-work retention and account deletion, off by
  default. ([#2837](https://github.com/mvschwarz/openrig/pull/2837), [#2843](https://github.com/mvschwarz/openrig/pull/2843))
- **Delivery evidence:** each send records one `transport.delivery_evidence`
  event. Read it as what was known about a delivery, not proof the agent read
  it. ([#2937](https://github.com/mvschwarz/openrig/pull/2937), [#2943](https://github.com/mvschwarz/openrig/pull/2943))
- **Seat self-knowledge:** managed guidance points to skills, help and project
  context; `rig seat status` shows when guidance was written relative to the session's recorded moments, and what the
  refocus hook recorded. ([#2918](https://github.com/mvschwarz/openrig/pull/2918), [#2920](https://github.com/mvschwarz/openrig/pull/2920), [#2916](https://github.com/mvschwarz/openrig/pull/2916))
- **Codex "Hooks need review" with smol-toml 1.9** is fixed; stop working around
  it by hand. ([#2804](https://github.com/mvschwarz/openrig/pull/2804))
- **A start reservation left after a reboot** is archived by `rig daemon start`;
  don't clear it by hand. ([#2915](https://github.com/mvschwarz/openrig/pull/2915))

### Limits to keep in view

- **Not in this release:** daemon pauses of up to about a second while reading
  proof on large mission trees ([#2970](https://github.com/mvschwarz/openrig/pull/2970)), and a delivery stall to a Claude seat
  showing Claude's auto-update failure footer ([#2948](https://github.com/mvschwarz/openrig/pull/2948)). Don't tell a person
  either is fixed.
- **`rig down`** keeps no stored host or boot identity, doesn't guard against
  another program running as the person, and a daemon restart between losing the
  tmux server and the stop wasn't exercised. ([#2962](https://github.com/mvschwarz/openrig/pull/2962))
- **Codex working counter:** a capture that doesn't name its pane keeps the old
  comparison, and a restart that keeps the pane and its process id isn't seen.
  ([#2980](https://github.com/mvschwarz/openrig/pull/2980))
- **Custom blocker IDs** explain the wait but give no event wake; the timer
  remains. ([#2983](https://github.com/mvschwarz/openrig/pull/2983))
- **Runner permission answers** were run end to end with a real receiving agent
  and the example runner, whose requesting agent was a stand-in; a model-driven
  runner waiting on a person's answer hasn't been run. ([#2934](https://github.com/mvschwarz/openrig/pull/2934))
- **An already-running tmux server** keeps its old environment, daemon
  credentials included, until it restarts. ([#2850](https://github.com/mvschwarz/openrig/pull/2850))
- **Delivery:** events are best effort, so a missing event isn't proof nothing
  was sent. A footer row OpenRig doesn't recognize can still hold a delivery ([#2925](https://github.com/mvschwarz/openrig/issues/2925)),
  and a held message's full envelope can stay held; clearing a draft doesn't
  deliver it ([#2515](https://github.com/mvschwarz/openrig/pull/2515)). With unreadable input, `--dangerously-interact` pastes
  with a warning and doesn't press Enter ([#2800](https://github.com/mvschwarz/openrig/pull/2800)).
- **Not run for this release** (not run, not passed): the two-seat Codex journey
  with `AGENTS.md` restore; Codex account-home, upgrade and continuity checks;
  the OpenShell worker's second report; Pi model switches on real providers; ACP
  in a desktop app; Slack directory paging; some Slack setup cases; native
  checks of [#2786](https://github.com/mvschwarz/openrig/pull/2786), [#2799](https://github.com/mvschwarz/openrig/pull/2799), [#2807](https://github.com/mvschwarz/openrig/pull/2807) and [#2813](https://github.com/mvschwarz/openrig/pull/2813) ([#2947](https://github.com/mvschwarz/openrig/pull/2947) partly); a button-and-words
  answer, a non-pairing ask with an explicit owner, Steering's Approve page, and
  the answer and setup checks on a default model; `--wait-for-kernel` ([#2888](https://github.com/mvschwarz/openrig/pull/2888)),
  [#2800](https://github.com/mvschwarz/openrig/pull/2800)'s installed effect, and [#2720](https://github.com/mvschwarz/openrig/issues/2720) beyond one platform. Don't tell a person
  these work.
- **0.7.11's limits below** still apply, except Codex hook setup with smol-toml
  1.9.x ([#2720](https://github.com/mvschwarz/openrig/issues/2720)), fixed by [#2804](https://github.com/mvschwarz/openrig/pull/2804).

## What changed in OpenRig 0.7.11

This note is for an agent on an install that was just upgraded to 0.7.11.
OpenRig 0.7.11 sends ordinary messages and work notices into a person's typed
draft by default instead of refusing them, lets a person reach the team from
their own coding agent (the `openrig` plugin) or an ACP app (`rig acp serve`),
holds a prepared managed compaction until the seat is idle, and clears a
restore that stopped at a prompt. On Linux, a daemon run as a systemd user
service keeps its seats when its unit restarts. It adds five database
migrations. On OpenShell 0.1.6 the worker's maintained cleanup now works, but
the worker still isn't end to end. If you upgraded
from 0.7.9 or earlier, also read "What changed in OpenRig 0.7.10" below, and
from 0.7.8 or earlier, the
[0.7.9 release notes](https://github.com/mvschwarz/openrig/releases/tag/v0.7.9)
too. For the full
capability map, read `rig context get onboarding-width/public-what-you-can-do.md`.
After the upgraded daemon starts, `rig context get reference/whats-new.md`
describes this version. Without a running daemon, read the packaged
`daemon/docs/reference/whats-new.md`; `$OPENRIG_HOME/reference/whats-new.md` can
still be the previous copy until startup.

### After the upgrade

- **Back up the database, then restart the daemon.** Five migrations run on
  the daemon's first start: 150 (node launch wrapper), 151 (Pi account
  switches), 152 (workflow instance spec), 153 (events retention marks) and 154
  (workflow instance root objective). If `$OPENRIG_DB` isn't backed up yet,
  copy that file (`rig config get db.path` shows it) with the daemon stopped,
  then `rig daemon start`. Going back to 0.7.10 after these migrations isn't
  established.
- **New settings:** `transport.draft_delivery` (`deliver`), `acp.to` (empty),
  `daemon.seat_poll_interval_ms` (1000) and `retention.events_days` (`0`, keeps
  every event). `rig config` shows each with its source.
- **The openrig-core plugin moves from 0.1.26 to 0.1.27.**
  Its activity relay and refocus hooks changed, as did the refocusing,
  openrig-user and openrig-skills skills. Managed refresh preserves replaced
  files under `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits
  you still need from the preserved copy.
- **Linux, with the daemon as a systemd user service:** the seats move into
  their own scope only when their tmux server next starts fresh; until then,
  stopping or restarting the daemon's unit still takes them down.
- **Tell the person sends now join their drafts** (below). To keep the refusal,
  run `rig config set transport.draft_delivery refuse`; it applies from the
  next send, with no restart.
- **Pi seats:** a Pi seat that declares an absolute `PI_CODING_AGENT_DIR` in its
  `env:` now uses it as its account home and needs a readable `auth.json`
  there, or the launch stops. Prepare one, or remove the declaration to keep
  the managed seat login. Ask the person before changing their spec.
- **herdr-core terminals:** new starts no longer inherit `HC_SCOPE`,
  `HC_TERMINAL_ID` or `HC_TERMINAL_SOCKET`; a daemon or tmux server already
  running with them keeps them until it's restarted.
- **Claude seats that load openrig-core themselves** lose OpenRig's unchanged
  copies of its skills at their next launch, so each skill loads once; the
  launch result warns with the copies removed or kept.

### Sends and drafts

- **Under `deliver` (the default),** an ordinary `rig send` or work notice to a
  seat whose prompt holds a person's typed draft pastes the message at the
  cursor and submits the combined input as one prompt. The result says whether
  submission was confirmed and, when OpenRig saw the draft, that it joined it.
  An unset, unreadable or invalid value follows `deliver`.
- **Still refused or held under either value:** menus, permission prompts, a
  seat's typing guard (`draft-aware`, `hold`), managed compaction's sends and
  `--wait-for-idle`.
- **Under `refuse`,** a send is refused, and a work notice retried once the
  prompt is clear, where OpenRig detects the draft. Claude Code and Codex sends
  now also read the input box before pasting, so a draft only the box shows
  refuses too (`target_needs_input` / `prompt_draft`).
- **The draft-aware typing guard** reads a Claude composer with a statusLine or
  the background task panel, and Claude Code 2.1.319's bare
  `✔ Update installed · Restart to update` row in a narrow pane, so an empty box
  gets the wake instead of `draft_input_unknown`.
- **Held messages coalesce:** a sender's newest held message at a seat retires
  its earlier ones. Read them with `rig seat held-messages <seat>` (each with
  `--id <id>`); an older backlog clears at that sender's next held message or
  with `rig seat retire-held-message`.
- **Stopped seats aren't woken at each daemon start:** their rows stay owed, and
  the start-up log says `waiting=N (not replayed: …)`. That isn't delivery.

### Compaction, restore and handover

- **A prepared managed compaction is held, not re-requested.** When the map is
  complete but `/compact` couldn't go in, the attempt stays `waiting`, marked
  `prepared`, and sends `/compact` at the next idle moment with an empty box.
  `rig compact <seat> --state` shows it; a manual `rig compact` reads
  `already_in_progress`; `--cancel` disarms it. It ends on a context dip, a
  conversation change, a stale map (`prepared_map_stale`: 15 points of growth or
  2 hours) or a map that stops reading ready.
- **The final `/compact` waits out the preparation's own fresh activity** (up
  to about 23 s, against 9 s), so an idle seat that ran out of context compacts
  instead of being refused; a busy seat can wait up to about 14 s longer.
- **A queue wake refused at a prompt** no longer goes in right after
  "Compacted" while the compaction still owes its turn boundary and restore
  request; it goes in at the next idle moment after that step clears.
- **A full restore stopped at a prompt clears itself** once the seat runs the
  conversation it was restoring. If a seat still reads `attention_required`, run
  `rig seat clear-attention <seat>`, with `--reason` after a partial restore or
  a community harness's assisted startup. `proof_superseded` means the restore
  changed mid-check.
- **A Codex helper inside a Claude seat** no longer takes the seat's resume
  token (`transcript_not_this_session`).
- **A Claude rebuild handover may report its priming packet unconfirmed.**
  Submit the existing packet once, only if it's still staged. Never resend it
  blindly or rerun the handover.
- **`on_restore: follow_source`** on a spec's `resources.skills[]` entry
  refreshes that skill from its source on restore; `keep_saved` is the default.

### Working with the team from outside

- **The `openrig` plugin** lets a person use their own Claude Code or Codex
  with their local team: hand it work, follow it, answer the team's questions
  in their own words, and read the result. Install it from the package
  (`claude plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig"`,
  then `claude plugin install openrig@openrig-app`) or from this repository on
  GitHub. Everyone using the app on a machine acts as the seat it names.
- **VS Code, Copilot CLI and Cursor** start its server with no seat: add your
  own `rig mcp serve --front-door` server with `OPENRIG_SESSION_NAME` set and
  turn the plugin's off. A seatless app can create tasks, send and post as
  `unknown-mcp-<8 hex>`, but can't claim, update, hand off or answer.
- **ACP apps:** `rig acp serve --to <member@rig>` (or the `acp.to` setting)
  makes the team an agent in an app that launches a custom ACP agent, such as
  Zed or T3 Code. Nothing runs until an app starts it, and it uses the daemon
  `rig` uses. A question left unanswered in the app stays open in the TUI and
  Slack. The `@openrig/acp` launcher is packed beside the CLI at the same
  version. See `docs/reference/acp-agents.md`.
- **Assistants through a grant service** are experimental, unsupported and off
  by default: they need your own internet-reachable `rig mcp serve --http
  --grant-service <url>` and an outside grant service. A registered person can
  answer the team's questions from one, and `--task-destination <member@rig>`
  names where its tasks go (`docs/reference/hosted-members.md`).
- **The `relay` gateway connector** is off unless you add a relay binding. It
  hands questions and updates to a bridge the operator runs on loopback;
  "Accepted by bridge" isn't delivery (`docs/reference/gateway-relay.md`).

### OpenShell workers

On OpenShell 0.1.6 the maintained cleanup (`delete-owned`) now works for a
custom image, and recreate and an exact resume passed in our native run. A
restored guest still receives its startup text again, so strict recall after a
restore isn't met, and the worker isn't end to end. The CA fix holds on 0.1.6.
"Never grant the guest access to the daemon's main API
port (normally 7433)."

### Other changes to act on

- Denying or dropping a host pairing request in Steering now gives the requesting machine no access; in 0.7.9 and 0.7.10, that action could return the daemon access token. ([#2884](https://github.com/mvschwarz/openrig/pull/2884))
- **Pairing answers now reach the target's kernel operator.** On a 0.7.11 target with a receiving kernel operator, typed words and Approve or Deny choices in the TUI, Steering or Slack are replies for that agent to read. Receiving a reply neither grants nor denies access. The operator acts on clear intent with `rig host approve <code>` or `rig host deny <code>` and asks back when the answer is unclear. The commands also work from a plain terminal on the target; they use its operator bearer (`OPENRIG_AUTH_BEARER_TOKEN`, or `--bearer <token>`). ([#2900](https://github.com/mvschwarz/openrig/pull/2900))
- **An Approve click on an operator-owned request waits for the operator to act.** A stopped operator keeps ownership; the answer waits in its queue. A stopped or unknown running state is named with the terminal route, without claiming the answer was read. If there is no operator, it cannot receive answers, or OpenRig cannot determine one, the request names that case and uses the agent-free path: Approve and Deny decide directly, and replies lead to another ask rather than denial. File-only replies and the literal `[file reply]` have no words stored on the agent-free ask; they still do not deny it.
- **TUI answers use the daemon's operator bearer when configured.** Ordinary terminal calls keep their separate terminal credential. A missing or wrong action credential leaves the answer unrecorded and shows what to set; this does not weaken the daemon's authentication.
- **Receipt, clarification and outcome are separate steps.** Receipts, agent-free re-asks and outcomes inferred from clicks or closes need the requesting machine to keep polling. An explicit `rig host approve` or `rig host deny` attempts its outcome update directly. An expiry timer closes the ask even if polling stopped; an unanswered expired ask gets no further update. Requests and decisions live in daemon memory, so a restart drops an open request. Approval still must be collected before expiry. This target-side change does not change older targets.

- **Rows on another host:** `rig queue show`, `list`, `transitions`, `update`
  and `block` take `--host <id>`; `claim` doesn't, since only the destination
  seat on its own host claims. `--host` never follows `rig host select`.
- **A seat's unclaimed backlog:** a seat with no escalation route or delegation
  parent gets one `unclaimed-backlog` notice. To route its findings to a
  watching seat:
  `rig edge add <rig> <root seat's logical id> <watching seat> --kind escalates_to`.
- **Claims read `working`** for up to 60 minutes while a Claude owner has a
  live background shell, and 20 while a managed restore is owed.
- **A cross-host handoff that overrides your claim** wakes you with the
  successor's id: stop and coordinate with that seat.
- **Code results:** set an `openrig.code-result/v1` manifest as `evidenceRef`;
  `rig queue artifact <qitemId>` and `rig_artifact_read` return the commit pair.
- **Workflows:** runs keep their own spec; `rig workflow unregister
  <name>[@<version>]` (or `--prune-missing`) removes registered versions;
  `rig workflow trace <id> --full` returns the whole trail; `show`, `trace` and
  `status` print `objective:`.
- **`rig stream emit` timeouts:** repeat with the same `--id`, or check with
  `rig stream list` before emitting again.
- **Launch and setup:** `launch_wrapper` works for local Claude Code, Pi and
  Codex seats; `rig provider switch --seat <pi seat> --to-account <name>
  --account-home <dir> --reason "<why>"` switches a Pi seat's account (`--dry-run`
  first), and a Pi seat with a declared account home starts again; `rig config set` says when
  an environment variable masks the saved value.
- **Linux seats:** when the daemon runs as a systemd user service, the seats'
  tmux server starts in its own user scope (`openrig-tmux-<id>.scope`), so the
  daemon's unit can stop or restart without ending them. Otherwise the server
  starts as before, with one log line giving the reason.
- **Writable terminal tiles** attach as in 0.7.10: the screen in use sizes the
  seat and text reflows on resize. Read-only tiles keep showing without attaching
  or resizing the seat. Web fixed geometry is opt-in through
  `terminal.fixed_geometry` (off by default). As in 0.7.10, Enter or Ctrl-C while
  the first attach is in flight can close that viewer; the agent keeps running,
  so reopen the view. Kept writable tiles from 0.7.8, 0.7.9 or pre-reflow 0.7.11
  need a manual refresh: close only the owned viewer and reopen with
  `rig terminal open`; for `--follow`, use `--no-follow` first, then open a fresh
  view. The agent and conversation are preserved; no automatic migration runs.
  ([#2868](https://github.com/mvschwarz/openrig/pull/2868), [#2757](https://github.com/mvschwarz/openrig/pull/2757), [#2821](https://github.com/mvschwarz/openrig/pull/2821))
- **A Claude seat launched with `--settings` JSON written with spaces** can be
  verified again.
- **`view.changed` is no longer stored,** and `/api/events` no longer sends it.
- **Old history-only events can be pruned, if you choose to.** `retention.events_days` (default `0`, which keeps every
  event) turns on a pass in the retention sweep (at daemon start and daily) that deletes `view.changed`,
  `snapshot.created`, `watchdog.evaluation_fired` and the `queue.created`, `queue.updated`, `queue.claimed`,
  `queue.unclaimed` and `queue.handed_off` events older than that many days; 14 is a reasonable value
  (`rig config set retention.events_days 14`). Every other type is kept at any age, because restore, startup proof and
  the seat readers fold from them, and the newest event is always kept. What you give up: pruned events no longer
  replay from `/api/events` (an older cursor or a large `?replay`), no longer appear in `rig telemetry events` (which
  reports the gap) or in older log and feed entries, and a later change of the setting can't bring them back. A new
  value is read at the next sweep: the daily one, or the next daemon start. The first sweep after turning it on works
  through the old history in short steps while the daemon keeps answering. `retention.enabled false` stops every
  retention pass from the next daemon start.
- **The database file does not shrink by itself.** Pruned rows free pages that new events reuse, which slows the file's
  growth; other tables still grow. To give the space back to the disk: find the file with `rig config get db.path`, stop the daemon
  (`rig daemon stop`), copy the file aside, run `sqlite3 <that file> "VACUUM;"` (it needs free disk about the size of
  the file and can take a few minutes), then `rig daemon start`. Never vacuum the file of a running daemon.
- **With pruning on, `rig telemetry events` reports the pruned ranges.** A page that spans pruned events inside the
  retained window has a `retained_sequence_gap` for each missing seq range and `coverage.status` `partial` (it used to be
  `retained_window`); events pruned from the start of the log show up as `before_retained_floor`.
- **Large fleets:** `daemon.seat_poll_interval_ms` (up to 2000) lowers CPU at
  the cost of activity freshness; keep 1000 if tmux is slow.
- **Terminals:** Herdr follow views work on macOS (protocol 22) and open a
  snapshot (`follow_unsupported`) where live following isn't supported.

### Limits to keep in view

- **OpenShell:** a restored guest gets its startup text again, strict recall
  isn't met, and the worker isn't end to end (above).
- **Drafts:** detection isn't complete. Under `refuse`, an unreadable input box
  lets the send go ahead; under `deliver`, a result may not mention a draft.
- **A post-compaction step can still hold** when the box reads as typed, under
  draft-aware delivery or the typing guard, or after a lost `/compact`. Run
  `rig compact <seat> --cancel`, then send a restore request naming the newest
  restore map, marker and packet. A refused queue wake now waits for that step,
  but recovery at daemon start and a new handoff's wake don't check yet.
- **`keep_saved` skills:** a skill whose source changes between `rig down` and
  the restore comes back missing, named in the restore's warnings; an edited seat
  copy is kept.
- **Terminal tiles** each run one tmux command a second while showing (8 tiles
  used about 6–8% of one core on an Apple Silicon Mac mini).
- **A message held as `draft_input_unknown`** isn't retried, and whether
  managed compaction gets past the update banner wasn't retested.
- **Claude provider switch:** the "probe pane returned to a shell" failure in
  [#2341](https://github.com/mvschwarz/openrig/issues/2341) isn't shown fixed;
  the launcher-script rebuild timeout and `--no-chrome` are fixed.
- **ACP apps** were checked in T3 Code (Beta) 0.1.7 and with a scripted client;
  the unanswered-question notice hasn't run in a live app. A cancel stops
  waiting; the team's work carries on.
- **The `openrig` plugin** hasn't run in Claude Desktop, the Codex app or
  Copilot CLI. **Grant-service assistants** still aren't woken.
- **Claude `launch_wrapper`** hasn't run with zsh, on macOS arm64 or with a real
  installed Claude; an alias or shell function named `claude` fails closed.
- **Going back to 0.7.10** isn't established; an older permission hook also
  gives named-policy Claude sessions no decision until they're relaunched.
- **The other 0.7.10 limits below still apply:** `rig exec` cancels,
  permission requests in seat status, Codex hooks (including
  `rig seat restart --keep-conversation` refusing a Codex seat launched with
  developer instructions), smol-toml 1.9.x, Slack, Claude Code 2.1.319's auto
  mode, Codex snapshot restores and `AGENTS.md`, unretried reminders, SSH host
  status, advisories on a native resume, seats handed over before 0.7.9, `rig`
  in the TUI's shell after a project-local install, the "Startup prompt still
  staged" message, and a partial install from two npm installs at once.
  0.7.10's bare-banner and launcher-script limits are fixed, and its OpenShell
  limit is replaced by the one above.

---

## What changed in OpenRig 0.7.10

The changes from 0.7.9 to 0.7.10, published on 2026-11-08, for an install
upgrading from 0.7.9 or earlier. 0.7.10 added `rig exec` for finite runs on
Claude Code or Codex, sent a held post-compaction step after two idle polls that
can't read the input box, left every tmux mode before a delivery, and showed
agent spec advisories at launch. Its OpenShell line below is corrected.

### After the upgrade

- **Restart the daemon** to load the new code: `rig daemon stop`, then
  `rig daemon start`. This release adds no migrations.
- **The bundled openrig-core plugin goes from 0.1.25 to 0.1.26.** Its Claude
  hooks add a `PermissionRequest` hook that reports permission requests to seat
  status, and its refocus hook and the refocusing skill's trace script changed.
  Managed refresh preserves replaced files under
  `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits you still
  need from the preserved copy.
- **Check agent specs before relaunching seats:** run `rig agent validate <path>`
  and read any `agent spec advisory` line. A profile's `uses.<category>` written
  as a single value now selects that resource; if the resource pool doesn't hold
  it, a member using that profile fails to resolve with "not found in resource
  pool". Ask the person before you change their spec.
- **Codex hooks:** a Codex seat kept running across the upgrade can show "Hook
  failed — plugin contents changed; hook approval required" until relaunched; in
  0.7.9's upgrade test, one seat restarted with OpenRig's managed restart showed
  no review afterwards.
- **OpenShell:** rebuild a guest image with this release's `guest.py` before
  using it; the CA repair is in that file, which the image carries.
- **Codex tool commands use a non-login shell:** managed Codex seats now pass
  Codex `-c allow_login_shell=false`, so plain `rig` works however OpenRig was
  installed, with a Codex that supports `allow_login_shell` (checked in Codex's
  source at 0.162.1 and 0.166); not yet run with a live Codex seat. Setup that lives only in login or rc files, and shell functions and
  aliases, may be missing from tool commands, and a model request for
  `login: true` gets Codex's refusal, "login shell is disabled by config". To
  defer to Codex's own setting, run `rig config set launch.codex_login_shell
  true`; a login file that sets `PATH` outright can then hide `rig`. It applies
  at each seat's next launch, and a restart in place keeps the running choice.
  ([#2613](https://github.com/mvschwarz/openrig/pull/2613))

### Finite runs: `rig exec`

`docs/reference/acp-agents.md` is the rule. Read it before handing a row to
Claude Code or Codex.
- **Install the adapters first:** `@agentclientprotocol/claude-agent-acp`
  0.101.0 and `@agentclientprotocol/codex-acp` 2.5.0, as that page shows.
  `rig exec harnesses` reports the adapter and native versions it finds.
- **Run:** `rig exec run <row> --harness claude` (or `codex`). `--plan` shows
  what would run and starts nothing; `--wait` waits for the outcome. A connector
  owns the run, so leaving `--wait` or closing the terminal doesn't stop it.
  Running it again returns the row's run instead of sending the task twice;
  `--again` starts another turn once that run has ended.
- **Read the outcome** with `rig exec status <runId|row>`. `interrupted` means
  the connector died without recording an outcome, so the outcome is unknown. A
  `completed` turn is the agent's report, not finished work: check the work
  before you close the row. `--wait` exits 0 for `completed`, 2 for any other
  outcome and 3 when you stop waiting.
- **Cancel** with `rig exec cancel <runId>`, not `rig acp cancel`. An
  acknowledgement isn't a settled shutdown, and it says nothing about further
  spend.
- **Usage and cost** the agent reported are on the row's outcome note, for
  `rig acp run` too, each with its source; what it didn't report reads unknown.

### Compaction and delivery

- **A held post-compaction step goes in.** After two idle polls in a row that
  can't read a seat's input box, the next poll sends the step (the turn
  boundary, the restore request or the audit). `rig compact <seat> --state` and
  `rig seat status` say it went in over a box OpenRig couldn't read; they never
  call that box empty. A draft OpenRig can't recognise in that box may receive
  the restore text.
- **Still held:** a box that reads as typed, with or without a suggestion; a
  seat whose draft-aware delivery or typing guard holds OpenRig's input; and the
  step after a `/compact` whose result was lost. To take over a held restore by
  hand, run `rig compact <seat> --cancel`, then send the seat a restore request
  naming its newest restore map, its restore marker and its packet. A step
  already being pasted can still land.
- **tmux modes:** a send or wake now leaves every tmux mode in a seat's pane,
  including a chooser, customize or clock mode a person has open. If a send is
  still refused for a tmux mode, the refusal names why leaving failed.
- **A scrolled pane with a stale record:** leaving the mode now goes through the
  seat's address, so a stale binding naming the same reused tmux pane, from
  another rig for example, no longer makes the send fail with nothing sent.
- **Herdr views kept across an upgrade keep working,** on Linux Herdr 0.9.5 /
  protocol 22. A viewer or follow view kept from 0.7.5 through 0.7.9 now counts
  as the same attachment when only OpenRig's tile script changed, and moves to
  the current command, so the viewer stays confirmed and the follow view goes on
  adding and closing tiles. A kept viewer that's already running keeps its
  earlier sizing for as long as it runs, its own re-attaches included; writable
  viewers opened after the upgrade size their pane. A different session, tmux,
  server or read-only setting still holds the view, as before. Checked against
  the scripts those releases used, not yet with a live Herdr. It follows
  @natefaerber's approach in
  [#2467](https://github.com/mvschwarz/openrig/pull/2467). ([#2634](https://github.com/mvschwarz/openrig/pull/2634))

### OpenShell workers

0.7.10 fixes, in the source, the two problems that stopped the OpenShell worker
in 0.7.9, but the worker hasn't run end to end. Don't rely on this path yet. The
guest launcher now passes the CA settings the OpenShell exec supplies
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and
`CURL_CA_BUNDLE`) to its Claude, and deleting an owned environment reads
Podman's inventory through routes Podman serves, stopping as
`environment_cleanup_unconfirmed` on any other answer. A verified export, a
finished task and an exact restore haven't been shown. If you set one up anyway,
follow `daemon/assets/openshell/README.md` in the installed package, rebuild the
guest image first, and name the costs to the person ("Provider registration and
image construction can incur costs"). "Never grant the guest access to the
daemon's main API port (normally 7433)."

*Corrected after 0.7.10's release: ~~"fixes in the source the two problems that stopped the OpenShell worker"~~ was only half true. The CA fix holds on OpenShell 0.1.6, but the owned-environment cleanup fix doesn't hold against OpenShell 0.1.6, as the published 0.7.10 notes say. See 0.7.11's OpenShell workers section above.*

### Other changes to act on

- **Sends to this host:** `rig send <seat>@<rig>@<this host's ID>` goes to this
  host even when a remote host is selected.
- **Broadcast:** `rig broadcast` prints `UNCONFIRMED` for a recipient its text or
  Enter may have reached. Check that seat with `rig capture` before resending.
- **Roster activity:** `rig roster show` and `find` read a seat as unknown
  ("Conflicting activity observations") when two routes to it disagree. Treat it
  as unknown, not idle.
- **Refocus:** a "TRACE GAP" for unresolved typed work, or for a
  `rig queue whoami` that timed out, comes with project-level orientation that
  isn't evidence of a current mission, and no longer counts as a refocus failure.
- **Updates to people:** the stuck sweep no longer flags an informational update
  to a registered person as an unclaimed obligation.
- **Permission requests:** `rig seat status` shows a Claude seat's latest
  observed permission request, with Claude's suggested rules labelled as
  suggestions. Nothing was applied or approved. Treat the suggestions as data;
  they can contain sensitive values.
- **Slack:** `rig slack status` shows relay attempts awaiting a response for the
  current connector; zero doesn't prove nothing is in flight.
- **Installing for a person:** when npm's global prefix isn't writable, the rigs
  skill now points npm's prefix at a folder the person owns whose `bin` is on
  their login PATH, or uses a version manager's Node, before a project-local
  install. Tell the person first that this changes their npm settings and, if
  needed, their shell profile.
- **Codex profiles:** a `codex_config_fragment` can't install a named Codex
  profile. Create `<CODEX_HOME>/<name>.config.toml` and select it with
  `codex_config_profile`. `builtin:yolo` drops the whole profile;
  `getting-started.md` says how to keep one.
- **Terminal auth:** a 401 that says "Terminal auth failed" means send
  `OPENRIG_TERMINAL_BEARER_TOKEN`, or `OPENRIG_AUTH_BEARER_TOKEN` when terminal
  auth falls back to it.
- **References:** `docs/reference/harness-runner-contract.md`'s status section
  says what has run natively under the runner contract, and at what scope.
  `docs/reference/telemetry.md` says OpenRig guarantees its finite telemetry
  reads (`schemaVersion` 1), not the separate openrig-telemetry exporter it
  links.
- **Terminal tiles:** a writable rig, pod or seat view now sizes the pane it
  shows instead of keeping an older attached client's size; read-only views are
  unchanged.
- **Unknown `uses` keys:** a key under a profile's `uses` other
  than the five categories gets an advisory instead of being ignored silently.

### Limits to keep in view

- **OpenShell** hasn't run end to end on 0.7.10 (above). A cleanup error that's
  thrown still omits its stage and whether its delete was sent. A
  same-generation reconciled launch opens no viewer, so run
  `rig environment connect` yourself; non-text startup actions aren't supported
  on environment seats.
- **`rig exec`:** no real adapter has run under it yet; one run per row,
  detached ownership and reconciling were checked against a stand-in agent.
  Concurrent runs, long or background tasks, recovery across a reboot, MCP
  servers and Windows aren't covered. A Ctrl-C just before the connector is
  launched isn't caught by `--wait`.
- **Draft-aware delivery to Claude:** a narrow Claude pane showing
  `✔ Update installed · Restart to update` on its own line can still hold
  deliveries at an empty prompt, queue wakes included; 0.7.10 doesn't recognize
  that bare banner. A held message isn't replayed automatically by that path.
- **Seats handed over before 0.7.9** keep their adopted origin until a later
  launched handover or managed launch records a new session. Until then
  `rig seat stop`, `clean` and in-place restart refuse them, and now say why.
  Don't use `rig unclaim` to get around it: that ends OpenRig's management of
  the seat.
- **Permission requests in seat status** show only the latest one, held in
  memory for five minutes and lost on a daemon restart.
- **Agent spec advisories** don't show for a native resume that continues a
  saved conversation.
- **The other limits in the
  [0.7.9 release notes](https://github.com/mvschwarz/openrig/releases/tag/v0.7.9)
  still apply:** open updates for a person, Slack,
  SSH host status, shared asks, permit records, existing seats, Codex hooks, and
  grant-service assistants not being woken. 0.7.9's limits on a restore request
  held after compaction, `rig broadcast`'s `FAILED`, what has run under the
  runner contract, and Codex seats' `rig: command not found` are fixed or
  changed. The limits in the
  [0.7.8 release notes](https://github.com/mvschwarz/openrig/releases/tag/v0.7.8)
  that 0.7.9 didn't fix or change, and the
  [0.7.7](https://github.com/mvschwarz/openrig/releases/tag/v0.7.7) and
  [0.7.6](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6) limits, still
  apply.

---
