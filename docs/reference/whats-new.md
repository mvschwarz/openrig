# What changed in OpenRig 0.6.7

This note is for an agent on an install that was just upgraded to 0.6.7. It lists only what behaves differently from
0.6.6 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## The OpenRig view is now the handoff

- **Open the view as the step after install or start; don't wait to be asked.** Say you're opening it, run
  `rig terminal open saved:kernel --window`, then tell the person where it opened. Don't ask "Open the OpenRig view
  now?", don't wait for a phrase like "show me my agents", and don't finish by printing a command for them to copy. The
  same command brings their agents back later.
- **The layout follows the person's terminal width.** On a narrow terminal the operator gets the first tab. On a wide
  one the dashboard and operator sit side by side and the advisor has its own tab. Inside herdr it opens a focused
  `openrig kernel` space. A `kernel` view the person saved themselves still wins.
- **It opens where the caller is.** Terminal gets a window and Ghostty a tab. From Claude Desktop, iTerm or VS Code on a
  Mac it opens a new Ghostty or Terminal window, and macOS may ask to allow it: mention that clicking Allow is fine only
  in that case. Over SSH, in CI or with no display, it returns a definite no-window result with the reason. Relay the
  `run:` command it prints exactly, or give `env -u TMUX tmux attach-session -t '=<canonicalSessionName>'` for the
  operator.
- **`rig terminal open <view>` opens a window by default.** Pass `--provider herdr` or `--provider cmux` only to add
  tiles to a workspace that's already visible. With `--json`, `reusedWorkspace` and `opened: []` mean an existing view
  was reused, which is success.
- **The TUI's action is now "Open terminals ▸"** (it was `term ▸`). It opens a desktop window through the same
  launcher, so the TUI must run on the daemon's desktop.
- **The `rigs` skill is installed for the person's own agent.** The daemon writes it to `~/.claude/skills/rigs` and
  `~/.agents/skills/rigs` and refreshes it on every upgrade. It now triggers on any mention of OpenRig, rigs or a team
  of coding agents. A copy added earlier with skills.sh is left alone and never refreshed.

## Installing and setting up

- **Show the install preview first.** The published install command has a `--dry-run` preview
  (`rig context get reference/getting-started.md` has both forms). Run the install when the person agrees. If the only
  failures left are provider sign-ins, have them sign in and continue at "Start the kernel".
- **If your own harness refuses a tool call while installing,** say so and show the refusal: Claude Code's auto mode can
  deny calls as well as approve them. Let the person review it in their harness or run that step themselves. A refused
  call doesn't prove the OpenRig command failed.
- **`rig setup` installs herdr by default** on macOS and Linux; `--no-herdr` declines it. On a Mac, ask once about
  Ghostty and on yes rerun `rig setup --ghostty`, keeping `--no-herdr` if it was chosen. Setup no longer installs cmux,
  and an existing cmux still works. In `--json` output the `cmux_install` step is gone and `herdr_install` and
  `ghostty_install` appear.
- **`rig doctor` checks Claude and Codex installs and logins** the way setup does. It exits 1 when either harness is
  missing or signed out, including one the person doesn't use, so ignore a failure on an unused harness. A pass means
  signed in, not that a provider accepts the credential or that an agent can work.
- **When setting up permissions,** recommend keeping the team default and offer remembered allowances only if the
  person wants fewer prompts. People slowed by prompts can be pointed to the workshop listing.
- **Windows users go through WSL2.** For Pi seats there, offer either credential route; a global Pi login still isn't
  shared with managed seats.

## Fewer prompts

- **In Claude team seats, help on lifecycle commands runs without a prompt.** `rig down --help` and `-h` forms run;
  the lifecycle actions themselves still ask. Pipelines, command substitutions, redirects and heredocs aren't allowed
  automatically.
- **The kernel operator's Claude session runs routine inspection without prompts:** Python, command lookup, `cd`, text
  helpers and WebFetch. Compound commands and redirects still go to Claude's own permission check.
- **Managed Codex seats no longer stop at the update menu on start.** Updating Codex is the operator's job: if a Codex
  seat says its model needs a newer Codex, offer to update Codex and restart that seat, without stopping the team. If a
  Codex seat shows a model-switch menu near a rate limit, ask the person; don't change the team's model.

## Messages, wakes and Slack

- **A send or wake no longer answers a question that's waiting for a person.** It's refused with
  `target_needs_input`, and the reason ends `; latest hook, pane unrecognized` when the screen can't be read, even if
  the hook is minutes old. Read the seat with `rig capture` and get the question answered by whoever should answer it.
  Don't retry the send.
- **Slack can post to a channel per rig or seat:** `rig slack channel-map list`, `set <match> <channel>` and
  `remove <match>`. After a change, invite the app to each channel, run `rig slack verify`, then `rig slack disable`
  and `rig slack enable` (or restart the daemon). Thread replies still reach the seat in any channel.
- **A reaction on any part of a Slack ask reaches the seat that asked,** as a task tagged `human-reaction`. Treat it as
  a signal to interpret, not an answer; the ask stays open. An existing app needs the `reactions:read` scope, the
  `reaction_added` event and a reinstall, and `rig slack verify` warns when the scope is missing.
- **A long Slack ask is posted in parts.** If it still can't be posted, you get a task `<ask id>-undeliverable`, tagged
  `slack-undeliverable`: shorten the ask or link a file for the long part, and send it as a new ask.
- **Replies sent with "Also send to #channel" now arrive** at the seat that asked, like any other thread reply.

## Running teams

- **`rig down` prints what each agent seemed to be doing before it stops them,** on one stderr line, or "unknown". It's
  a best-effort snapshot, not a record of what was interrupted. `rig down --host` now exits 2 when the remote teardown
  reports errors.
- **Before a handover or compaction, write the seat's recap** with
  `rig context recap-write --rig <rig> --seat <seat> --file <draft.md>`, not a file tool, so earlier recaps are kept.
  `rig seat handover <seat>` now works on the same seat again and again; a seat left half-handed-over recovers by
  running it again.
- **After a managed compaction, the restore request names the `refocusing` skill,** which the daemon now installs
  globally. Run its trace as one plain command, as the skill shows.
- **The built-in starter and factory leads publish their team's roster** at first start, so `rig roster list` and
  `rig roster find <topic>` know those teams.
- **Claiming a parked queue item clears its `blocked_on`.** To park it again on the same gate, run
  `rig queue block <id>` without `--blocked-on`.
- **A periodic reminder first fires one interval after you register it,** not immediately.
- **Workflows:** `rig workflow run` and `rig workflow watch` exit 3 for an aborted instance. When a step that was sent
  back completes again, the steps that depend on it run again too, including ones that had passed.
- **Sharing teams:** `rig bundle create` and `rig up <link>` name the bundle after `rig.yaml`'s `name`, and
  `rig bundle check` names the file in each finding. Submissions go to `mvschwarz/openrig-registry`. The bundle safety
  check always runs, even with `--skip-version-check --force`.
- **`rig context add <url> --git` fetches one commit,** not the whole history. Use `rig context source update` for later
  revisions.
- **Values that used to fail quietly are refused:** a bad `rig chatroom history --since` (fix the value; the room isn't
  empty) and a `--wake-after` such as `7d` (use hours, for example `168h`).
- **Pi seats print a `[pi-runner] seat …:` line at start** saying whether a credential was found and, if not, how to
  fix it. A MiniMax model gets `MINIMAX_API_KEY` when that name is in `recovery.provider_auth_env_allowlist`.
- **`agents.advisor_session` defaults to `advisor-lead@kernel`.**

## What to stop doing

- **Stop asking whether to open the OpenRig view, or waiting for a phrase.** Open it after install or start.
- **Stop using `--provider herdr` for the first view,** and stop pre-warning about macOS prompts from Terminal or
  Ghostty.
- **Stop suggesting `--skip-version-check --force` to get past a bundle pre-check failure.** The check always runs.
- **Stop retrying a send refused with `target_needs_input`.** Get the question answered instead.
- **Stop telling people to untick "Also send to #channel" when they answer in Slack.** Those replies now arrive.

## Known gaps in 0.6.7

- **Not yet checked on a real machine:** opening the view from Claude Desktop, and the plain-tmux layout without herdr.
  The full first install from nothing and a Linux run come after this release.
- **Help without a prompt has been checked in a live Claude session for one of the 17 lifecycle commands it covers.**
  If another one still asks, report it.
- **Codex team seats aren't asked before lifecycle commands yet.**
- **The send gate trusts the most recently recorded hook.** If hooks are recorded out of order, it can hold a send for
  a question that's already answered, or miss one that's waiting. `rig capture` shows the real screen.
- **A Codex seat whose permission request was approved automatically can still read "needs input".**
- **A launched team still writes its skills into its working folder.**
- **After a restart, `rig status` shows `Kernel: skipped` whatever the kernel seats' state.** Read them with
  `rig ps --nodes --rig kernel --full`.
