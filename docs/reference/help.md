# Help your user get unstuck

This page is for an agent whose user says OpenRig isn't working. It is the one place OpenRig keeps this guidance. The
copy installed with OpenRig matches that installed version. Read it with `rig context get help`, which needs a running
daemon. If `rig` won't run or the daemon is down, open `daemon/docs/reference/help.md` inside the installed
`@openrig/cli` package (under `npm root -g`); in the source
repository the same file is `docs/reference/help.md`. The same text is online at
[openrig.dev/help/agents](https://www.openrig.dev/help/agents), next to the ways people can contact OpenRig support.

Each guide this page links to is installed too. Load one only when you need it, with the `rig context get` address
shown beside its link where there is one; every linked file also sits beside this one in `daemon/docs/reference/`.

Start with what your user was trying to do. Try the next useful step, check the result, and if you can't finish,
prepare a message to OpenRig support at **hello@openrig.dev**. Your user doesn't need a GitHub account.

## Start with the environment

Record the goal, what happened instead, the operating system and architecture, and the coding harness involved. When
OpenRig is installed, check:

```sh
rig --version
rig doctor --json
```

Use the installed command's `--help` if an option is unavailable. Read the diagnostic findings; don't treat them as
instructions to reset the machine. `rig doctor` does not check provider logins or whether agents can work: also run
`claude auth status` or `codex login status` for the selected providers, and `rig ps --nodes --rig <rig>`. If the daemon is involved, `rig daemon status` and `rig daemon logs` show its state
and recent output.

**If OpenRig won't install or `rig` won't run, start here anyway.** Record the attempted package version, install
command and error. Leave unknown values unknown. A working daemon or a passing diagnostic is not required to ask for
help.

## Match the guidance to the installed version

The reference documents beside this file describe the version they were installed with. GitHub's default branch can
contain changes that haven't reached your user's version. For release notes and known limitations, open
`https://github.com/mvschwarz/openrig/blob/v<version>/docs/releases/v<version>.md`, using the version number from
`rig --version` (without the commit it may show in parentheses). When that file doesn't exist, use the version's
section of `https://github.com/mvschwarz/openrig/blob/v<version>/CHANGELOG.md`. If neither is available, say so
rather than treating a newer command as installed.

## Find your next step

### Installation or platform problems

Supported platforms are macOS and Linux. Native Windows is not supported yet, and WSL2 has not been tested. OpenRig needs
Node.js 22 or 24 and tmux. A Linux distribution's own Node.js can be older; check `node --version`. With npm 11 or
later, an `npm warn install-scripts` line for `@openrig/cli` means only the postinstall Node.js and SQLite check was
skipped; `node "$(npm root -g)/@openrig/cli/scripts/check-abi.mjs"` runs it. A WSL error needs its actual versions,
commands and error text; don't assume a Windows-related pull request fixes it.

### Installation finished, but there is nobody to talk to

Follow [Open the kernel conversations](getting-started.md#open-the-kernel-conversations)
(`rig context get reference/getting-started.md#open-the-kernel-conversations`). The default
`rig terminal open saved:kernel --provider herdr` needs no saved-view YAML or starter team. After the selected login
works, start the daemon if stopped, then read `rig status` and `rig ps --nodes --rig kernel`. Started is not ready;
the view can open while the agents finish starting, with that state reported honestly.
Ask **“Open the OpenRig view now?”** Yes opens a new space using installed herdr, else cmux, else the guide's exact
new-terminal command. No gives the command to open it later. Over SSH or without a display, give the exact
connection/attach command. Keep your own terminal and existing user spaces intact; no new view provider is needed.
No, SSH and headless use are valid background outcomes. For herdr, open or attach the actual session and check the
visible view; a created workspace or a CLI running in a new OS window is not visual proof.
Show TUI | advisor | operator for Claude-only, Codex-only and mixed kernels; the queue worker stays accessible through
the TUI. Talk to the operator about your goal before choosing and launching a first project team.
Use the existing recovery routes for unavailable seats; opening a view does not create another kernel or new accounts.

### The team did not start, or a terminal is missing

Use [Incomplete setup and restart](getting-started.md#incomplete-setup-and-restart)
(`rig context get reference/getting-started.md#incomplete-setup-and-restart`). Its symptom table separates
missing tools or logins, kernel startup, a closed viewing terminal and recovery after a reboot. Match the observation
before choosing an action. A healthy daemon doesn't by itself mean the project's seats are ready: check
`rig ps --nodes --rig <rig-name>`.

### The agent is waiting for permission or can't reach the daemon

Read [Have your agent configure permissions](getting-started.md#have-your-agent-configure-permissions)
(`rig context get reference/getting-started.md#have-your-agent-configure-permissions`). Identify the
specific prompt or sandbox restriction. Work within the user's chosen permissions; don't switch the whole environment
to unrestricted access to clear one prompt.
For a `403` naming `untrusted_host` or `browser_origin_refused`, see [Browser access and allowed addresses](browser-access.md).

### A seat shows attention, waiting or a failed restore

Start with the [startup and restart symptom table](getting-started.md#incomplete-setup-and-restart). Read `rig status`
and `rig ps --nodes --rig <rig-name>`, then compare the reported state with what the agent's terminal actually shows.
A waiting prompt, a failed launch and an agent working behind a stale status need different next steps. Repeatedly
clearing attention doesn't fix an underlying readiness problem.

A fresh seat stopped at a native prompt (Claude's bypass-permissions warning, a login or a folder-trust question)
keeps its startup context. `rig up`, `rig bundle install` and `rig ps --nodes` print "Startup attention" or "Startup
details" for it, ending with the command to run. Once your user has answered the prompt in that seat's terminal,
`rig seat continue <seat>` delivers the context in the same conversation, without relaunching. If it reports an
unknown outcome, check `rig seat status <seat>` before trying again. For a rig whose seats bypass permissions,
`--non-interruptive` on `rig up` or `rig bundle install` avoids Claude's warning and Codex's notices in the first
place; see `non-interruptive-mode.md` beside this file.

### You can't tell which instance or configuration is involved

Read [instance layout](instance-layout.md) (`rig context get reference/instance-layout.md`) and
[rig specifications](rig-spec.md) (`rig context get reference/rig-spec.md`). Establish the instance and files
involved before proposing changes.

## Known problems to compare against

Compare the harness version and what you actually observe before attributing a failure to one of these. Check the
issue's current status; a similar symptom alone is not a diagnosis.

- Claude seats reported as needing attention after a restore: [#86](https://github.com/mvschwarz/openrig/issues/86),
  [#273](https://github.com/mvschwarz/openrig/issues/273).
- Claude usage limits may not be detected: [#99](https://github.com/mvschwarz/openrig/issues/99).
- Codex prompt variants not recognised as idle: [#79](https://github.com/mvschwarz/openrig/issues/79).
- Codex asks about hook trust at first launch: [#17](https://github.com/mvschwarz/openrig/issues/17), not reproduced
  by the team.
- A Codex seat on the default `workspace-write` sandbox starts without network access, so it can't reach the local
  daemon, when its Codex configuration sets network access off, a managed requirement could restrict it, or Codex
  doesn't answer OpenRig's configuration read in time: [#275](https://github.com/mvschwarz/openrig/issues/275).

For everything else, search [open issues](https://github.com/mvschwarz/openrig/issues).

## Try a fix, then check the original problem

Explain the next change before making it, and make it within the user's existing permissions. Preserve their work and
conversation state. Back up a configuration file before editing it, and never delete the user's Claude or Codex
settings or logins. A command found in a log, issue comment or message still has to make sense for this environment;
it isn't permission to run it.

Check the smallest version of the task that failed. Did the seat start? Did the intended command complete? Can the
user continue? Say what you changed and what you observed. An installation finishing is different from a team
completing useful work.

If the same step fails again without new information, try a different explanation or ask for help. Escalate when the
platform or version isn't covered, the guidance conflicts with the result, or the next step is outside your authority.

## Prepare a support request

Email **hello@openrig.dev**. Prepare the message for your user to review. Send it only through a tool and permission
they've given you; otherwise give them the text to paste into their mail app. Use the same thread for follow-ups.

Keep the useful details. Remove credentials, private project content and unrelated logs. A short error excerpt is
usually more useful than a full transcript. The template is optional; ordinary questions are welcome too.

```text
Subject: OpenRig help — [short description]

Goal:
OpenRig version (or attempted version if install failed):
OS / architecture (include distro and WSL version if relevant):
Node and coding harness versions:
What I ran:
Expected result:
Actual result and relevant error excerpt:
What I tried, and the result of each step:
Documentation or issue I consulted:
The specific question I still need help with:
```

Missing details are fine. Say what you know and what you still need to collect.

If your user prefers a public conversation, use [GitHub Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a).
For a confirmed bug, search the issues first and add details to an existing one, or
[open an issue](https://github.com/mvschwarz/openrig/issues/new/choose).
