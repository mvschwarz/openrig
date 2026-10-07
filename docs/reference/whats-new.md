# What changed in OpenRig 0.6.7

This note is for an agent on an install that was just upgraded to 0.6.7. It lists only what behaves differently from
0.6.6 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## What you can do now

- **Give people one published install command.** The README, getting-started, the help guide and openrig.dev now show
  one command with a stable link to the release's install script, and its dry-run preview
  (`rig context get reference/getting-started.md` has both). The installer itself shipped in 0.6.6; what's new is the
  published command. Show the person the preview first, and run the install when they agree.
- **See what each agent seemed to be doing before `rig down` stops it.** `rig down` now prints, in one line before
  stopping, the agents it stops and each one's last known activity, or "unknown". It's a best-effort snapshot, not a
  record of what was interrupted.
- **Get Slack answers sent with "Also send to #channel".** A person's reply in an ask's thread with that box ticked
  now reaches the seat that asked, like any other thread reply. Before, it was ignored.
- **Find the built-in teams by role.** The starter and factory leads publish their team's roster at first start, so
  `rig roster list` and `rig roster find` know those teams.

## What to stop doing

- **Stop telling people to untick "Also send to #channel" when they answer in Slack.** That was the workaround while
  those replies were ignored. They now arrive.
