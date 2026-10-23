# What changed in OpenRig 0.7.0

This note is for an agent on an install that was just upgraded to 0.7.0. It lists only what behaves differently from
0.6.14 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). Six migrations run on the first start (116, 118,
  119, 121, 122 and 123). Two settings are added, `terminal.history_limit` (default 10000) and
  `terminal.inherit_tmux_environment` (default false), and `provider.subscription_moves` is removed.
- **The bundled openrig-core plugin goes from 0.1.15 to 0.1.17.** Startup replaces installed copies of managed plugins and
  marked global skills. It first copies every file it replaces under `$OPENRIG_HOME/backups/managed-refresh/<id>/`,
  whether or not anyone edited it, and logs `[plugin-vendor] preserved previous contents of <file> at <copy> before
  managed refresh` for each one. A stock upgrade from 0.6.14 copies about 22 files (about 250 KB), and a later start with
  no new version copies none. The copies matter only for files someone changed: the copy keeps the bytes, but the change
  may no longer be active after the refresh. Keep the log line, because it names the original file and the copy's folder
  doesn't. If a copy fails, that plugin or skill isn't refreshed, its files are kept, and the log says so. Copies aren't
  cleaned up.
- **If you gave new agents accounts or API keys through tmux's global environment** (`tmux set-environment -g …`), new
  agents no longer inherit it (below). Put the values in the seat's `env`, pass `rig up --env KEY=VALUE`, or keep the old
  behaviour with `rig config set terminal.inherit_tmux_environment true`. Running agents aren't affected.
- **If you write queue rows to another machine by its self-id** (`member@rig@<self-id>`), run `rig host doctor <alias>`
  once per host: bindings learned before 0.7.0 have no address.

## New things you can do

- **Hold a person's routine asks while they're away:** `rig gateway human quiet set <id> --daily HH:MM-HH:MM` or
  `--until <time>` (`--tz`), and `end`, `clear` or `show`. A held ask posts once, without a mention, when quiet ends.
  Asks tagged `escalation` or `wake-escalation` are not held.
- **Apply a person's mode** ("asleep", "out of office"): `rig gateway human mode save <id> <name>` (with
  `--availability`, `--expected-back`, `--decision-room "<their words>"`, `--exclude`, `--quiet`), then `apply <id>
  <name> [--until …]`, `current`, `end` and `account`. Never tell the person "back to normal" while the account shows an
  effect `kept`, `pending` or `failed`.
- **Decide an ask inside a person's decision room:** check `rig gateway human mode room <id>`, then `rig gateway human
  mode decide <qitemId> --application <id> --reason "…" --reversible|--irreversible`. It's recorded as delegated, never
  as their answer, and only the agent that asked can decide. Permission prompts are refused (`permission-prompt`).
- **Pass a rig's name instead of its id** to `archive`, `unarchive`, `release`, `shrink`, `expand`, `snapshot`,
  `export` and `restore --rig`. A name two rigs share is refused and the matching ids are named: with `--json`,
  `archive`, `unarchive`, `release`, `shrink`, `expand` and `restore status --rig` return `rig_ambiguous`.
- **Stop a managed compaction's follow-up after `/compact` was sent:** `rig compact --cancel` now also disarms the
  restore and audit prompts that would follow. It sends no input and can't undo the `/compact`.
- **See your work candidates:** `rig queue whoami` adds `currentWorkChoice` when current work isn't settled.
- **See why a wake didn't land:** `rig queue show --json` adds `lastNudgeInputBox`.
- **See each seat's configured effort:** the TUI agent table's `CFG EFF` column, and `effort` and `effortSource` in
  `rig ps --nodes --full --json`. It's the configured level, not what the model ran.

## Behaviour that changed

- **New agents start from a clean environment, not tmux's global one.** A new seat or handover successor gets:
  - the launch environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `CODEX_HOME`, `OPENRIG_HOME`, `OPENRIG_URL`,
    `OPENRIG_PORT`, `OPENRIG_HOST`, the seat's own identity values (such as `OPENRIG_SESSION_NAME`) and the allowed
    provider sign-in variables. Not `OPENRIG_DB` or `TMUX_TMPDIR` (see Known gaps);
  - the daemon's `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and
    `CLAUDE_CONFIG_DIR`;
  - the values named in tmux's `update-environment`;
  - its own `env`.

  Shell startup still runs. `rig setup` warns when it sees a custom tmux configuration.
- **After a reboot, the daemon restores a kernel whose seats are all detached** (and still bound to their sessions), in
  the background, as `rig up kernel --existing` would. `OPENRIG_NO_KERNEL=1` still skips it, and `rig start --json` reports `kernelRestore`.
- **A seat missing a required startup file no longer blocks its rig's restore:** `rig up <rig> --existing` holds that
  seat and restores the others (`partially_restored`).
- **Seats added to a running rig** with `rig expand`, `rig grow` or add-member get its culture file and rig-level
  startup, for rigs created on 0.7.0 or later. Older rigs get no backfill.
- **A busy daemon gets the real request.** The CLI refuses only when the daemon is stopped or stale, the connection is
  refused or blocked, or the daemon answering belongs to another OpenRig home. A slow daemon is no longer read as down.
- **A new seat's first startup message** says it's OpenRig's identity context, not a task. A seat whose startup sends
  nothing else is asked to run `rig whoami --json` and say it's ready for an assignment.
- **A new Claude seat's first startup text** waits briefly (about five seconds) for Claude's input box before it's
  sent.
- **Codex seats that select openrig-core get the plugin installed into Codex.** While Codex hooks are on
  (`runtime.codex.hooks_enabled`, default on), OpenRig installs it with Codex's own marketplace and plugin commands at
  daemon start and at a fresh launch, unless the person's Codex configuration disables it.
  - **A first install only** (no earlier install or plugin cache): OpenRig checks the installed hook files against its own
    copy, then trusts the plugin's six shipped hooks by their exact definitions, so the seat starts without Codex's hook
    review.
    The file check happens only when trust is granted: a later edit to the cached hook scripts keeps that trust, as with any hook trusted in Codex.
  - **An existing install keeps the person's choices.** A plugin or hook they disabled stays disabled. One they left
    untrusted stays under Codex's review: Codex records nothing for "continue without trusting", so OpenRig doesn't read a
    missing trust record as permission.
  - **What it adds:** the four managed inline hooks stay the only activity reporters; the plugin adds refocus and its
    skills.
- **Watchdog delivery is recorded as it happened:** `rig watchdog status` outcomes are `sent`, `refused`, `failed`,
  `skipped` or `terminal` (0.6.14 had `sent`, `skipped` or `terminal`). Every reminder carries "Delivery may repeat after
  an unconfirmed attempt." under its header line, and two refusals in a row at one seat's prompt raise that seat's prompt
  alert. A park wake shows the continuation its park recorded (`Recorded continuation: …`), so record one when you park.
- **Slack:** a thread reply answers a parked question only if it was written after the question posted, and a message
  Slack rejects as `invalid_blocks` isn't posted again.
- **Claude Code team agents are asked for permission less often.** Housekeeping commands such as `archive`, `attach`,
  `bind`, `release`, `reconcile-session`, `config set` and `seat continue` no longer prompt. `seat restart` and `policy
  permissions apply` now do.
- **`rig up --plan` waits as long as an apply** (120 seconds). An unanswered plan exits 1 and is safe to run again.
- **`rig setup` keeps 10,000 rows of tmux history**, down from 50,000 (`terminal.history_limit`, 2000 to 1000000).

## Output that changed shape

- **`rig gateway human list`** shows each person's availability (`available`, `focus`, `away` or `off`) where it showed
  `away` or `available`, plus a `quiet:` line; JSON adds `availability` and `quiet`.
- **`rig attach`** prints `Sender:` (and `Tmux:` when the names differ), and `rig whoami` adds `identity.senderAddress`.
  A clashing member name is refused with `address_conflict`.
- **Send results** carry `managedCompaction`, and the CLI prints a `Notice:` line.
- **`rig ps --rig <unknown>`** exits 1, and `--host H --rig X` filters by rig.

## What to stop doing

- **Don't use `rig provider moves`:** it's gone with its setting. Report a subscription move as a queue item to whoever
  asked.
- **Don't steer a new seat's account or keys through tmux globals.** Use the seat's `env` or `rig up --env`.
- **Don't close a row `done` with `--closure-reason blocked_on`.** It's refused with `invalid_closure_reason`; use `rig
  queue block <id> --on <child>`.
- **Don't treat "daemon did not respond" as down.** Check the effect before any retry or restart.
- **Don't look up a rig id first** for the commands above; pass the name.
- **Don't restart the daemon to stop a managed compaction's follow-up prompts.** Use `rig compact --cancel`.
- **Don't run `rig up kernel --existing` by hand after a reboot** before checking `rig status`.
- **Don't reuse a `deliveryId` to deduplicate a send,** and don't pass `--reason` or `--actor` to `rig slack verify`.

## Known gaps in 0.7.0

- **A new seat doesn't get the daemon's `OPENRIG_DB` or `TMUX_TMPDIR`.** A tool in the seat that reads `OPENRIG_DB`
  directly can fall back to the default database. If you rely on either, pass it in the seat's `env` or with `rig up
  --env`.
- **A launch that warns "Scoped tmux environment unavailable; retaining the previous environment"** didn't give that seat
  the clean environment, and the seat may lack OpenRig's variables. Check `env` in the seat before relying on them.
- **A Slack channel-mapping change needs a daemon restart** (`rig daemon stop`, then `rig daemon start`). Don't use `rig
  slack disable` then `enable` for it: enabling marks any alerts waiting to post to Slack as already seen, so open
  exchanges miss them.

- **A new Claude seat's startup text can stay in its input box unsent.** If a fresh Claude seat sits idle with text at
  its prompt, press Enter in its pane, or ask the person to.
- **The TUI's terminal button refuses inside a Herdr pane reached over SSH.** Start the TUI with `env -u SSH_CONNECTION
  -u SSH_CLIENT -u SSH_TTY rig tui`, or run `rig terminal open '<view>' --provider herdr`.
- **Claude seats on a macOS native install can read as needing attention after a restore.** Check the pane before
  acting on it.
- **Ubuntu 22.04's stock tmux 3.2a can crash its whole server** when OpenRig checks a pane that has just closed. Avoid
  tmux 3.2a for OpenRig (`tmux -V`).
- **Delegated decisions:** the ask is created before the decision, so without quiet hours it can post to the person
  first. Pair a decision room with quiet hours, or decide before asking.
- **`restore-check` still treats a missing startup file as rig-wide.** Trust `rig up --existing`'s per-seat result.
