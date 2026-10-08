# What changed in OpenRig 0.6.8

This note is for an agent on an install that was just upgraded to 0.6.8. It lists only what behaves differently from
0.6.7 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## Skills from the managed catalog

- **A skill with uncommitted changes in the catalog now blocks only itself.** Before, one edited skill made the whole
  catalog unavailable to work-install, launch and restore preflight. Now that skill is skipped and named, and the
  remaining clean skills stay available for projection.
- **Read the warning, don't retry.** `catalog_skill_skipped` names a skill nobody selected; `selected_skill_skipped`
  names the selector and the folder. The fix is to commit or restore that folder's content in the catalog, then run the
  projection again.
- **A selected skipped skill makes the inspection commands exit 1.** `rig context work-install --runtime <runtime>`
  and `rig skill loadout --runtime <runtime>` inspect by default. Use `--apply-skills` with work-install or `--apply`
  with skill loadout to project the remaining clean skills. Read the warnings and projection result; exit 1 alone does
  not say whether files were changed. With `--json`, skipped skills are in `skillLoadout.skipped` or
  `loadout.skipped`, respectively.
- **A seat keeps the copy it already has** of a skipped skill, unchanged. After the catalog change is committed or
  restored, the next applied projection can refresh it. No seat receives the skipped skill's uncommitted files, and
  launch only warns about the skip.
- **An uncommitted `catalog.yaml` still makes the whole catalog unavailable,** because it changes every selection.

## Launch plans

- **`rig launch <rig> <seat> --plan` previews one seat's launch** without launching it, locally or with `--host`. Use
  it before starting a single seat, as `--seats … --plan` already allowed for several.
- **A plan is never sent to a daemon older than 0.5.9,** which would ignore the flag and launch. If `rig launch --plan`
  refuses for that reason, restart or upgrade that daemon. If it exits non-zero saying the daemon may have acted, check
  `rig ps --nodes -A` before retrying.

## Slack

- **Answer a person's thread reply in that thread.** When someone replies inside a thread OpenRig opened, answer with
  `rig queue create --human-intent update --reply-to <the inbound reply's row>`, and the answer posts in that thread.
  A top-level message is still answered top-level.
- **A short rate limit is waited out.** When Slack asks for a pause of 10 seconds or less, OpenRig waits and retries the
  post once. A longer pause is still left to the usual retry of retained messages.

## Managed compaction

- **A quiet seat is restored after `/compact`.** The turn boundary, the restore request and the read-depth
  audit now reach a Claude seat that takes no turn after compacting. Before, they waited for the seat's next turn,
  so a seat with nothing to do could sit unrestored. Each stage still waits until the seat's screen shows it idle.

## Workflows

- **Validate before you run.** `rig workflow validate` reports `step_cannot_finish` when no allowed exit can finish a
  step or route onward, and such a workflow cannot be instantiated. Allow `done` or an exit with a route onward. In a
  dependency graph, `handoff` can also finish a sink without a next step. A spec that validated on 0.6.7 may need a
  correction.

## The TUI

- **Type whole commands on an empty command line.** The footer toggle is now `F`, and in a selected Scopes view the
  mini-requirements and narrative keys are `M` and `N`, so `find`, `feed`, `mission`, `narrative` and `needs` reach the
  command line intact.
- **`j` and `k` move the selection down and up** when the command line is empty. With text on the line they're ordinary
  letters.

## Smaller changes

- **A Claude seat launched with `--remote-control`** confirms its identity instead of staying "identity not confirmed".
- **`rig down` still saves its recovery snapshot** when finding one seat's resume details fails.
- **A wake for a handed-off task shows its summary** on one line, so read it to see what the task is for.
- **`rig scope audit` accepts slice folders numbered 100 and above.** `rig proof add --file` keeps a leading UTF-8
  byte-order mark.
- **Building from source no longer needs POSIX shell tools** for the CLI and TUI output. It hasn't been run on Windows
  yet; WSL2 is still the way to run OpenRig there.
- **A topology naming reference** explains how to name a team's pods and seats: `rig context get
  reference/topology-naming.md`.

## What to stop doing

- **Stop treating a non-zero work-install exit as proof that nothing changed.** Read the skipped-skill warnings and
  projection result. Inspection alone changes no skill files; an applied projection can update clean skills while
  reporting a skipped one.
- **Stop scripting around the TUI's single-letter keys.** Type the command whole.
- **Stop assuming a workflow that validated on 0.6.7 can finish.** Validate it again on 0.6.8.

## Known gaps in 0.6.8

- **Not yet checked on a real machine:** the full first install from nothing, on Mac, Linux and Windows.
- **Only one selected lifecycle-help command has been checked in a live Claude session;** source and parser coverage
  is broader. If a help command still asks, report it.
- **Codex team seats aren't asked before lifecycle commands yet.**
- **The send gate trusts the most recently recorded hook.** If hooks are recorded out of order, it can hold a send for
  a question that's already answered, or miss one that's waiting. `rig capture` shows the real screen.
- **A Codex seat whose permission request was approved automatically can still read "needs input".**
- **A launched team still writes its skills into its working folder.**
- **After a restart, `rig status` shows `Kernel: skipped` whatever the kernel seats' state.** Read them with
  `rig ps --nodes --rig kernel --full`.
