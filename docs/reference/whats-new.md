# What changed in OpenRig 0.6.9

This note is for an agent on an install that was just upgraded to 0.6.9. It lists only what behaves differently from
0.6.8 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## Slack

- **A typed reply to a decision with structured questions is kept.** It's recorded on the row in `humanAnswers` as a
  tagged entry (`kind: "typed-reply"`), placed under the first unanswered question, with the count of questions still
  unanswered. A clicked answer is still the option's ID. Typed text that matches an option's ID is never read as clicking
  it. The decision still closes, and closing doesn't mean approval: read the reply and its placement before acting. The
  `messaging-the-human` skill says how.
- **`rig slack status` shows the inbound retry backlog:** how many inbound messages, reactions and click answers are
  waiting to be retried, kept across restarts. If those records can't be read, the line says the count is unknown and
  why; it never reads as an empty backlog.
- **An alert retried after its row closed isn't posted.** A Slack post that failed is kept and retried when the gateway
  next starts. If the row has left the active states by then, the alert is dropped and the row records
  `slack-owner-notification-dropped … reason=row-not-active`. Alerts for rows still open, decision-resolved notices and
  digests still post. `rig slack enable` says how many earlier undelivered posts wait to be retried.

## Sends and waits

- **A cross-host send that may have arrived reads as unconfirmed, not failed.** `rig send <session> --host <id>` to an
  http-registered host now waits up to 30 seconds. When the answer doesn't come back, or the connection drops after the
  request went out, the send exits 1 with `failedStep: "remote-outcome-unknown"` and "Delivery UNCONFIRMED". **Check the
  target with `rig capture <session> --host <id>` before any resend**; a blind resend can deliver twice. Only a host
  that was never reached reads as unreachable.
- **`rig chatroom wait` keeps waiting through a slow or restarting daemon.** A failed poll is retried until your
  `--timeout`; the first one prints a line on stderr. An error answer from the daemon, such as a removed rig, still ends
  the wait at once. If the last poll before the deadline failed, the timeout says new messages may have arrived unseen.

## Kernel status

- **A kernel that recovered from a failed start reads ready.** When every declared kernel seat reports ready, for
  example after `rig seat continue`, `rig status` says so and adds an indented line naming the earlier failure and
  when it happened. `GET /api/kernel/status` returns that as `last_boot_failure`. The kernel's agent list shows each
  seat once, with its runtime.

## Scope approval

- **`rig scope <tier> approve --workspace <path>` stamps the work tree you named.** Before, it reported success while
  the stamp landed in the daemon's own work tree. A named workspace with no `missions/` folder is now refused instead
  of falling back to the configured one. The approval record names the root it wrote under.

## Claude seats on NixOS

- **A Claude Code installed from nixpkgs is recognised as the seat's runtime,** so its seats read `running` and sends
  no longer warn that the runtime couldn't be established. A seat that still carries an attention marker from an
  earlier failed launch keeps it: clear it with `rig seat clear-attention <seat>`.

## A correction to the 0.6.8 note

- **`rig launch` takes a rig ID, not a rig name.** The 0.6.8 note wrote `rig launch <rig> <seat> --plan`. Read the ID
  from `rig ps --json`; a name gives `rig_not_found`.

## What to stop doing

- **Stop resending a cross-host message after a timeout.** Check the target first; the first send may have arrived.
- **Stop restarting a kernel whose status read `bootstrap_failed` after its seats recovered.** Read `rig status`
  again on 0.6.9; a recovered kernel reads ready.
- **Stop passing a rig's name to `rig launch`.** Pass its ID.

## Known gaps in 0.6.9

- **The first install from nothing has been checked on a Mac, in Terminal,** not yet on Linux or Windows.
- **Only one selected lifecycle-help command has been checked in a live Claude session;** source and parser coverage
  is broader. If a help command still asks, report it.
- **Codex team seats aren't asked before lifecycle commands yet.**
- **The send gate trusts the most recently recorded hook.** If hooks are recorded out of order, it can hold a send for
  a question that's already answered, or miss one that's waiting. `rig capture` shows the real screen.
- **A Codex seat whose permission request was approved automatically can still read "needs input".**
- **A launched team still writes its skills into its working folder.**
- **After a restart, `rig status` shows `Kernel: skipped` whatever the kernel seats' state.** Read them with
  `rig ps --nodes --rig kernel --full`.
