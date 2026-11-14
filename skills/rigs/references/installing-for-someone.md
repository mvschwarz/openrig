# Installing OpenRig for someone

The procedure for an agent that has installed OpenRig for a person: starting it, opening the TUI and operator for them, and
handing them to the operator. The `rigs` skill sends you here from its step 2; a seat's startup text carries only a pointer to it.

After setup and a working selected login, use `rig daemon start` if stopped. On a fresh instance it also starts the
kernel, including the operator and advisor. They are part of installation; choosing a project team comes later.
Keep the kernel for a normal install. `rig daemon start --no-kernel` is for automation or an explicit request to
omit its startup, including the operator that helps the person start a team.
Read `rig status` and `rig ps --nodes --rig kernel`: started is not ready. The view may open
while agents finish starting; report their actual state and use the guide's existing recovery routes when needed.
Right after OpenRig is installed or started, and whenever the person wants to see their agents or OpenRig again,
open the OpenRig TUI and operator for them: say so, then run `rig terminal open saved:kernel --window --json` on the
daemon's desktop. Don't wait for particular words. The command opens a new terminal tab/window using
installed herdr, otherwise plain tmux; inside Herdr it opens a space there. It preserves existing conversations. The default view
needs no YAML edit. Below 120 measured columns (or unknown width), show the operator alone first; from 120,
show dashboard and operator equally side by side. The advisor always has a separate tab or tmux window.
This applies to Claude-only, Codex-only and mixed kernels.
Keep the queue worker off the first view and accessible through the TUI. Reuse existing conversations and accounts.
Inspect the result and visible content using authorized desktop tools, or report that visibility is unconfirmed.
Herdr is visible only inside a terminal the person can see. Creating a workspace or switching the shared TUI
to `:terminals` does not open that terminal. A window request or CLI success alone is not visual proof. On a
desktop, do not finish by showing a table or suggesting a command instead of opening the requested view.
Only if the window cannot open, `rig tui --shared` is the named dashboard-only fallback, not the operator's
conversation. Explain the failure and help with the chosen fallback; do not attach in your own terminal.
Over headless SSH, explain that no visible terminal opened; tell the person to open a new terminal window or
tab and give one complete connection and attachment command using the current Herdr endpoint, as in the guide.
No, SSH and headless use are valid background outcomes. If the person chooses a manual operator attachment after
a failure, find the `operator.agent` row with
`rig ps --nodes --rig kernel --json --fields logicalId,canonicalSessionName,tmuxAttachCommand`. Give `env -u TMUX` followed by
that row's `tmuxAttachCommand`, exactly as listed (it names the daemon's tmux server when that isn't the default
one), for a new terminal on the same host and user (over SSH, connect there first). Ctrl-b, then d detaches without stopping it.
Ask the person's goal and project folder, then hand them to the ready operator; do not implement the project yourself.
Find the `operator.agent` row with `rig ps --nodes --rig kernel --json` and use its `canonicalSessionName` with
`rig send <canonicalSessionName> 'This is the agent that installed OpenRig. The person will answer in your pane. Goal: <goal>. Project folder: <absolute path>.'`,
or have the person type the goal and folder in the operator's pane. Show where the operator answers and let it
help them choose a team before any starter launch.
If the person gives you a goal later, forward it, the folder and constraints with `rig send`; leave implementation
with the operator's team instead of taking over the work yourself.
Installation is complete when the operator is ready and the person is talking to it, not merely when the daemon is
healthy. If they choose to talk later, leave the exact connection step and say that the handoff is still pending.

Read `rig context get reference/getting-started.md#open-the-kernel-conversations` for the commands and manual
path. Without a working daemon, the same guide is `daemon/docs/reference/getting-started.md` in the installed
`@openrig/cli` package. Confirm what actually opened; on a headless host or unavailable display, say so and give the
person the exact connection/attach step. Opening a terminal is not permission to start or reset seats or provision accounts.
