# What changed in OpenRig 0.6.11

This note is for an agent on an install that was just upgraded to 0.6.11. It lists only what behaves differently from
0.6.10 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). One migration runs on the first start: `103`
  adds one column to `sessions`, `intentionally_stopped`, which is 0 for every existing row. There are no migrations
  `100` or `102`. The bundled openrig-core plugin stays at 0.1.9; two of its files changed.
- **Two new switches, both off by default:**
  - `output.compact` (or `OPENRIG_OUTPUT_COMPACT`): the seven queue write commands (`rig queue create`, `claim`,
    `unclaim`, `update`, `block`, `handoff` and `handoff-and-complete`) print a short receipt instead of the whole
    row, and `--full` prints the whole row. While it's off their output is unchanged, `--full` is accepted, and
    `rig config` lists the key.
  - `provider.usage_windows` (or `OPENRIG_PROVIDER_USAGE_WINDOWS` in the daemon's environment): `rig provider status
    --refresh` reads a Codex login's usage windows once. While it's off, `--refresh` says how to turn it on and exits 1.

## Output that changed shape

- **`rig queue create --verify` reports `outcome: "claimed"`** for a claimed row whose wake wasn't confirmed, instead
  of `indeterminate`. A claim is pickup, not proof the body was read.
- **`rig queue create --verify` to a registered person who is also a seat with a pane reports the Slack side too.**
  Beside the terminal wake it adds a `gateway` object: `posted` (`connectorAccepted: true`), `transport-failed` or
  `never-posted` (`connectorAccepted: false`, with the detail), or `still-pending` (`connectorAccepted: null`). The
  wait is still bounded by the existing 30-second default, and it can use all of it even when Slack isn't set up or the
  row won't be posted; the Slack side then reads `still-pending`. Posted isn't read, and "This is not a failed handoff"
  isn't shown when Slack reports a failed delivery. `GET /api/queue/:qitemId` returns `ownerNotificationLevel`, or
  `null`.
- **`rig queue whoami --work-candidates` returns up to 50 held and 50 next rows,** with `heldTruncated` and
  `nextTruncated`. `heldAndNextTruncated` now means either list was cut. With `OPENRIG_REFOCUS_WORK_PACKET` on (off by
  default, as in 0.6.10), the refocus work packet lists held and next work separately, up to 50 each.
- **`rig ps --nodes --json` carries `intentionallyStopped`,** and `rig ps --nodes` shows `usage_limit` under REASON for a
  Codex seat at its usage limit.

## Seats and restore

- **A restore no longer starts a seat fresh when an earlier occupant left a resume token.** If a seat wasn't running
  when the snapshot was taken, but an earlier session recorded a resume token, `rig up --existing` and `rig launch`
  stop that seat at `awaiting-decision` and start nothing, because the token doesn't prove that conversation can still
  resume. `rig launch` of such a seat exits 1 where it used to start it fresh. The message names the command that
  starts it fresh on purpose. See the known gap below for how this shows in the rig status API.
- **In a restore of a rig whose seats are in pods, a seat is rolled back as unresumable only when its runtime reports
  the conversation missing.** When Claude, Codex or Pi reports that, the seat goes back to `awaiting-decision` and
  nothing starts, instead of a failed launch that left the new pane behind. A rig where every seat ends this way reads
  `partially_restored` instead of `failed`; the exit code is 1 either way. A Claude that exits to its shell for another
  reason keeps 0.6.10's result: the seat is reported failed and its pane is kept, so you can read what happened. Restores
  of rigs without pods keep their earlier handling.
- **`rig seat launch --fresh --stop` checks before it stops anything.** A seat with a still-live older session is
  refused before the current agent is stopped; 0.6.10 stopped it first. `--plan` previews a fresh launch without
  changing anything and exits 0 even when it would be blocked. `--reason` is required only to execute; leaving it out
  reports `missing_reason`.
- **A seat you stop on purpose no longer makes its rig read `degraded`.** `rig seat stop` records the stop, and `rig ps`
  and the TUI leave that seat out of the rig's state; running counts still exclude it. A rig whose seats were all
  stopped this way reads `stopped`.
- **Restart one Codex seat in place, on Linux:** `rig seat restart <seat> --keep-conversation --reason "<why>"`
  restarts it in its own pane on the same conversation, so it starts again on whatever account its Codex home now
  holds. It doesn't switch accounts itself. Before it stops anything, it checks that the seat is a Codex seat OpenRig
  launched, in a single pane, with a conversation it can prove, and that relaunching wouldn't change the running
  settings; any doubt refuses with nothing stopped. `--plan` runs every check and stops nothing.
  `--verify --expect-account <account>` reports `moved` only when a tool turn has completed in the same conversation
  since the restart and Codex's status names that account.
  On macOS, a request that gets as far as reading the running process refuses before stopping the seat, because that
  reading depends on `/proc`.
- **A forked Claude seat launches with its own session ID** (`rig fork`, or `session_source: fork`), so strict restore
  and clear-attention can verify it as its own conversation. Forking a Claude seat needs Claude Code 2.0.73 or later,
  which OpenRig doesn't check. Forks launched before this keep reading `mismatch` until they're relaunched.
- **Seats no longer inherit the launching Claude Code or Herdr session's identity variables,** such as `CLAUDECODE`.
  If removing them fails, the launch goes ahead with a warning.
- **A member's `cwd` in a rig spec can be `~`, start with `~/`, or use `$VAR` or `${VAR}`,** expanded from the daemon's
  environment, when the path as written doesn't exist. `rig up` warns on stderr when it chose `/` as the launch folder
  itself.
- **A late readiness result no longer overwrites a newer launch attempt.**

## Sends and wakes

- **`rig send --wait-for-idle N` waits before it takes the seat's delivery lease,** so other sends and queue wakes to
  that seat aren't held behind a long wait. N is now a deadline from the start of the wait, including any time spent
  waiting for the lease. A timeout names the wait you asked for.
- **A parked seat whose occupant is known isn't woken again for the same rows after a wake was delivered,** until it
  updates one of them or one changes state. A failed, refused or unrecorded wake still repeats at the next park, and a
  new occupant gets its first wake. "Delivered" means the wake was typed into the seat's terminal, not that the agent
  read it.
- **`rig send --verify` confirms enveloped multi-line messages that the agent's screen indents,** and queue wakes use
  the same check.
- **A Claude footer in auto, bypass or plan mode on the last line reads idle** when no activity hook is reporting.
- **A failed Pi or OMP turn shows the provider's own reason** when it gives one.
- **A `handed-off` closure with no visible successor** gets the same custody advisory and stuck-sweep finding as a
  `done` closure.

## Status

- **A Codex seat at its usage limit stays `unknown` with reason `usage_limit`** while its screen redraws, instead of
  reading `running`. It clears when a readable screen shows no banner, or when Codex shows it's working again. See the
  known gap below.
- **`rig ps` takes a rig's running count and status from the same set of sessions as `rig ps --nodes`.**
- **`rig whoami --full --json` shows a Codex seat's `runtimeContext.threadId`** when its stored conversation ID was
  verified resumable.
- **The TUI says when a queue sample hit its cap or failed to load:** counts read `N+`, a seat missing from the sample
  shows `?`, and Pulse no longer lists a NEEDS YOU item a second time. The caps count the whole host, so a quiet rig can
  read `?` while another rig is busy.
- **The TUI Topology table's Q, WORK and NOW columns fill again** on drilled views and on a seat's page.

## Smaller fixes

- A Slack reply sent with "Also send to channel" in the default channel is recovered after a connection gap.
- `rig config set daemon.port` refuses a port outside 0–65535, and a port like that from the environment or
  `config.json` falls back to the file or default with a warning. `rig daemon start --port` refuses one too, with exit 1.
- Parallel `rig scope slice create` calls get different slice numbers. A number is never reused, and each create leaves
  a hidden `slices/.nn-NN` claim file.
- `rig proof show` and `rig proof judge` take `--project <id>` or a `<project>:` scope prefix. Scope readiness for a
  project selected in the TUI uses that project's own root.
- The chat send and topic routes return 400 before storing anything for payloads that used to fail with 500;
  `/api/wake-resolve` answers a fractional or non-numeric generation with its usual "does not exist" reply; watchdog
  registration refuses a `scan_interval_seconds` that can't be turned into a number (non-numeric text, a boolean, an
  empty array); and unmanaged-pane discovery matches agent
  process names exactly, plus `claude.exe` and names cut to 15 or 16 characters.
- The `rigs` and `openrig-skills` skill descriptions split by who is asking: a person in their own session, or an agent
  inside a rig.
- A new reference page covers keeping a watch for a person with today's queue commands, installed at
  `$OPENRIG_HOME/reference/keeping-a-watch.md`. See the known gap below.

## What to stop doing

- **Stop expecting a restore to start a seat fresh** when an earlier session left a resume token; decide at
  `awaiting-decision`, or use the command the message names.
- **Stop reading `indeterminate` as the answer for a claimed row** from `rig queue create --verify`; 0.6.11 says
  `claimed`.
- **Stop treating `degraded` as a stopped seat's doing** after `rig seat stop`; the rig leaves that seat out.
- **Stop counting a long `--wait-for-idle` as extra time after the lease;** N is a deadline from the start of the wait.

## Known gaps in 0.6.11

- **`rig seat restart --keep-conversation` supports Linux only.** Its automated tests are hermetic: they don't restart a
  real Codex seat.
- **The rig status API can call a running rig `blocked` because of one seat that isn't running.** It happens when the
  latest snapshot recorded no occupant for that seat, an earlier session of the seat left a resume token, and its newest
  session's restore policy is `resume_if_possible`. A restore from that snapshot would stop at the seat for a decision,
  and `GET /api/rigs/:id/status` folds that forecast into the rig's status, so it mixes current status with restore
  readiness: no seat is halted. `rig status` and the TUI's rig list don't show it for a running rig.
- **A Codex seat can keep reading as at its usage limit** when an old usage-limit banner is followed by a submitted
  prompt and the agent's reply, with no Codex working line and no input line below. It's recorded again every five
  minutes, where 0.6.10 let it age out. The case was constructed from the source and hasn't been seen in a real
  session.
- **The keeping-a-watch page says a timer fires once; a held-back wake uses up that fire.** When the typing guard holds
  a one-shot `--wake-after` wake back (it shows as `retained`), that held-back attempt is recorded as the timer's one
  fire and later wakes aren't, so the timer isn't retired: it can wake the owner again at each interval while the row
  stays set aside. A row sharing the timer through `--wake-watchdog`, after the original row was handed off or stopped,
  loses its one wake if that wake is held back. Read the row's transitions after each wake.
- **After `rig scope slice create` says it couldn't verify membership, the slice was kept.** Check `mission.yaml` before
  creating it again: creating it again makes a second slice with the same name.
- **The latest first-install check before this release used 0.6.10 on Linux only.** macOS was last checked with 0.6.8,
  and native Windows hasn't been checked.
- **Only one selected lifecycle-help command has been checked in a live Claude session;** source and parser coverage
  is broader. If a help command still asks, report it.
- **Codex team seats aren't asked before lifecycle commands yet.**
- **The send gate trusts the most recently recorded hook.** If hooks are recorded out of order, it can hold a send for
  a question that's already answered, or miss one that's waiting. `rig capture` shows the real screen.
- **A Codex seat whose permission request was approved automatically can still read "needs input".**
- **A launched team still writes into its working folder;** the operator says what changes before you agree.
- **After a restart, `rig status` shows `Kernel: skipped` whatever the kernel seats' state.** Read them with
  `rig ps --nodes --rig kernel --full`.
- **`rig tui --shared` still attaches on the default tmux server,** so it can't find the dashboard when the daemon runs
  on a non-default tmux socket. Use `rig tui` there instead.
