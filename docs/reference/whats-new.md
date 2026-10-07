# What changed in OpenRig 0.6.7

This note is for an agent on an install that was just upgraded to 0.6.7. It lists only what behaves differently from
0.6.6 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` always describes the installed version. Without a running daemon, the same
file is at `$OPENRIG_HOME/reference/whats-new.md`.

## What you can do now

- **Install OpenRig with one command, and show the person the plan first.** The install line and its dry-run preview
  are in getting-started (`rig context get reference/getting-started.md`). The preview prints what it will install and
  changes nothing. Run the install itself when the person agrees.
- **Know what each agent was doing before `rig down` stopped it.** `rig down` now prints the agents it stops and what
  each was doing, or "unknown", in one line before stopping them. Keep that line: it's the record of what was interrupted.
- **Get Slack answers sent with "Also send to #channel".** A person's reply in an ask's thread with that box ticked
  now reaches the seat that asked, like any other thread reply. Before, it was ignored.
- **Find the built-in teams by role.** The starter and factory leads publish their team's roster at first start, so
  `rig roster list` and `rig roster find` know those teams.

## What to stop doing

- **Stop telling people to untick "Also send to #channel" when they answer in Slack.** That was the workaround while
  those replies were ignored. They now arrive.
