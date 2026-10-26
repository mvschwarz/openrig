# OpenRig Changelog

Agent-readable release notes for coding agents and human operators installing,
upgrading, or operating OpenRig.

Versioning: pre-1.0 minor releases may include contract additions,
deprecations, and behavioral changes. Breaking changes are called out explicitly.

---

## [0.7.2] - 2026-10-25

Published as `@openrig/cli@0.7.2`, built from the commit tagged `v0.7.2`
(`8b180689`). This entry carries the corrected public notes from the
[GitHub Release](https://github.com/mvschwarz/openrig/releases/tag/v0.7.2).

OpenRig 0.7.2 gives each seat more of its own setup. A seat can run on its own
Claude or Codex account, move to another login or to the other runtime without
leaving its team, and keep its own Claude tool rules in a shared project
folder. Sends are refused less often at seats that are plainly working, and
more reliably at real dialogs, including Pi's. Codex seats can still commit
after a restore, an assistant over MCP can hand work on, and Rex joins Herdr
and cmux as a terminal. It is built from the commit tagged `v0.7.2`. The changes
since 0.7.1:

### Before you upgrade

- **Restart the daemon after installing.** Six database updates apply on its
  first start.
  ```bash
  npm install -g @openrig/cli@0.7.2
  rig daemon stop && rig daemon start
  ```
- **Startup replaces OpenRig's own plugin and skill files** (openrig-core goes
  from 0.1.18 to 0.1.19; the `delegating-work` and `openrig-user` skills
  changed). As in 0.7.1, it first copies each file it replaces under
  `$OPENRIG_HOME/backups/managed-refresh/` and logs where, edited or not. If
  you did edit one, reapply your change from the copy.
- **On Linux, if a seat's tools use the session bus, set the bus address in
  the rig's or member's `env:`.** Seats now start with an address that can't
  connect, even when a shell startup file sets `XDG_RUNTIME_DIR` (see Behaviour
  that changed and Known issues).
  ([#2036](https://github.com/mvschwarz/openrig/pull/2036))
- **Declare a seat's own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the rig spec's
  `env:`.** A one-off `rig up --env` no longer applies those two, and says so.
  ([#1945](https://github.com/mvschwarz/openrig/pull/1945))
- **If you might go back to an earlier version, set equivalent native Claude
  rules first.** Code from before #1914 opens the upgraded database but leaves
  per-member Claude tool rules out of launch, so a seat's denies stop applying.
  `docs/reference/rig-spec.md` has the details.
  ([#1914](https://github.com/mvschwarz/openrig/pull/1914))

### What's new and fixed

**A seat's own account and runtime**
- A seat can run on its own Claude or Codex login. Sign in to a separate home
  once, natively, then name it as an absolute `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` in the member's or rig's `env:`. It applies at the seat's next
  launch, and `rig seat status` and `rig provider status` show which home a
  seat uses and where it comes from.
  ([#1937](https://github.com/mvschwarz/openrig/pull/1937),
  [#1945](https://github.com/mvschwarz/openrig/pull/1945))
- `rig provider switch --seat <seat>` now moves one seat to another
  subscription login on the same conversation. A Codex seat moves to a login
  saved in its own Codex home (`--to-account <name>`, Linux only), after its
  current login is saved as `before-switch-<time>`. A Claude seat moves to its
  own subscription token file (`--token-file <path>`, made with
  `claude setup-token`), and `--stored-login` moves it back; OpenRig keeps only
  the file's path and your label, never the token. `rig provider precheck
  --seat <seat>` shows what a switch would do, changing nothing.
  ([#1972](https://github.com/mvschwarz/openrig/pull/1972),
  [#1980](https://github.com/mvschwarz/openrig/pull/1980),
  [#1991](https://github.com/mvschwarz/openrig/pull/1991))
- `rig seat set-runtime <seat> --runtime claude-code|codex --reason "<why>"`
  moves a live seat between Codex and Claude Code. The successor starts first,
  gets a handover and confirms it before the old runtime stops, and the seat
  keeps its address, queue rows and claims. `--dry-run` shows the settings, what
  is cleared and the costs; `--recover` finishes an interrupted switch. Built
  on @Aschenbath's design in
  [#1214](https://github.com/mvschwarz/openrig/pull/1214).
  ([#1895](https://github.com/mvschwarz/openrig/pull/1895))
- `rig provider status --refresh --provider claude --claude-token-file <path>
  --credential-label <label>` reads a Claude token's usage on request, one
  model turn per refresh.
  ([#1901](https://github.com/mvschwarz/openrig/pull/1901))
- A Claude seat set to the alias `haiku` with the `plan` permission is told at
  launch, at restore and in `rig seat status` that Claude Code answers its
  plan-mode turns with Sonnet, and how to set a full Haiku id.
  ([#1942](https://github.com/mvschwarz/openrig/pull/1942))

**Claude tool rules per member.** Claude members that share a project folder
can keep their own tool rules: `claude_permissions` with `allow` and `deny`
lists in the spec, or `rig seat set-permissions <seat> --rules <file.json>
--reason "<why>"` for an existing seat. A change is audited and applies at the
next managed launch or resume; OpenRig never writes the rules into the
project's Claude settings. Checked natively on Claude Code 2.1.309: two seats
in one folder enforce their own rules, a managed policy wins, and fresh, resume
and fork launches enforce them. See Known issues for what isn't claimed.
([#1914](https://github.com/mvschwarz/openrig/pull/1914))

**Sending to a seat**
- A working Claude seat that quotes approval-prompt text in its own output, such
  as `› 1. Yes, proceed (y)`, no longer has sends and queue wakes refused as if
  it were at a prompt, including when Claude draws its input box high in a tall
  pane. Real permission, question and MCP dialogs still refuse.
  ([#1955](https://github.com/mvschwarz/openrig/pull/1955),
  [#2005](https://github.com/mvschwarz/openrig/pull/2005))
- A draft in a Claude seat's input box that starts with a blank line no longer
  reads as an empty box, so a send isn't typed into it.
  ([#1977](https://github.com/mvschwarz/openrig/pull/1977))
- A draft-aware send to a Claude seat keeps ownership of its paste when Claude's
  footer changes to a hint such as "paste again to expand" (see Known issues
  for #14). ([#1921](https://github.com/mvschwarz/openrig/pull/1921))
- An ordinary `rig send` to an adopted Pi window waiting at a confirmation
  dialog is refused with `target_needs_input` and types nothing, instead of
  choosing the highlighted answer
  ([#2015](https://github.com/mvschwarz/openrig/pull/2015)). A later change
  extends that recognition to Pi's input and editor dialogs, including help
  rows that wrap in an 80-column pane
  ([#2026](https://github.com/mvschwarz/openrig/pull/2026)). A Pi seat that
  OpenRig runs shows an extension dialog in its pane, cancels it and marks the
  seat as needing attention
  ([#1996](https://github.com/mvschwarz/openrig/pull/1996)).
- A queue wake refused at an approval prompt is retried once when the seat's
  attention clears, instead of waiting for the stuck sweep.
  ([#1961](https://github.com/mvschwarz/openrig/pull/1961))
- After a person declines a Claude permission prompt, `rig seat clear-attention
  <seat> --reason "<what you saw>"` clears the prompt the latest hook still
  names, and the send refusal says to.
  ([#1912](https://github.com/mvschwarz/openrig/pull/1912))
- `rig send` to a mid-turn Codex seat says the message joins the running turn
  and may redirect it, and names `--wait-for-idle` for separate work.
  ([#2007](https://github.com/mvschwarz/openrig/pull/2007))
- `rig capture` says when a pane smaller than 80x24 may cut off the prompt a
  seat is at, with the command to resize it.
  ([#1969](https://github.com/mvschwarz/openrig/pull/1969))
- A seat with an unrelated pane beside its own still gets sends and wakes, in
  its recorded pane.
  ([#1616](https://github.com/mvschwarz/openrig/pull/1616), @Vaishnavi220506)

**Codex seats**
- A Codex seat on the default workspace-write sandbox can still commit after a
  resume, fork or restore, and can write its own topology folder, so it keeps
  its `LEARNED.md`. When the sandbox refuses its recap, the daemon saves it.
  ([#2000](https://github.com/mvschwarz/openrig/pull/2000),
  [#2023](https://github.com/mvschwarz/openrig/pull/2023),
  [#2018](https://github.com/mvschwarz/openrig/pull/2018),
  [#2008](https://github.com/mvschwarz/openrig/pull/2008))
- `rig seat restart --keep-conversation` on a Codex seat keeps a writable root
  whose path holds a space, looks for the resumed conversation in the home the
  running Codex uses, and, when it can't prove the resume, says the pane
  restarted instead of "nothing was restarted".
  ([#2003](https://github.com/mvschwarz/openrig/pull/2003),
  [#2037](https://github.com/mvschwarz/openrig/pull/2037),
  [#1950](https://github.com/mvschwarz/openrig/pull/1950),
  [#1958](https://github.com/mvschwarz/openrig/pull/1958))
- When a Codex home has a `hooks.json`, OpenRig puts its activity hooks there
  and moves its own old inline block out of `config.toml`. Your hooks, their
  trust and your disables stay; @fsafey found the mixed-format problem in their
  fork. ([#1957](https://github.com/mvschwarz/openrig/pull/1957)) Inline hook
  trust is keyed by the managed group's actual position.
  ([#2028](https://github.com/mvschwarz/openrig/pull/2028), @dajiaohuang)
- A signed-out Codex seat at the sign-in chooser or API-key entry reports
  `login_required` instead of waiting out the readiness timeout (Codex 0.164.0
  and 0.162.1).
  ([#1967](https://github.com/mvschwarz/openrig/pull/1967), @Aschenbath)
  ([#1983](https://github.com/mvschwarz/openrig/pull/1983))
- A resumed Codex seat is recognized when its footer shows a model with a
  reasoning label, such as `GPT-6.1 Sol medium`, or a versioned non-`gpt`
  model, so `rig up --existing` no longer stops there.
  ([#1944](https://github.com/mvschwarz/openrig/pull/1944))
  ([#1778](https://github.com/mvschwarz/openrig/pull/1778), @Nikhila-Dhevi-R)

**Claude compaction and restore**
- A managed Claude restore reads its own restore files without stopping at a
  Read approval, including on macOS, through a symlinked home or project, and
  for the generic or configured `post-compact-extra.md` and preparation root.
  The grants apply from the seat's next launch or resume.
  ([#1940](https://github.com/mvschwarz/openrig/pull/1940),
  [#1952](https://github.com/mvschwarz/openrig/pull/1952),
  [#1962](https://github.com/mvschwarz/openrig/pull/1962))
- A seat restored with `claude --resume` that stops at Claude's resume chooser
  in a tall pane is reported as waiting for a person's choice instead of
  resumed, and a Codex model chooser there reads as `model_selection_gate`. An
  old chooser above a resumed session no longer reads as live.
  ([#2010](https://github.com/mvschwarz/openrig/pull/2010))
- After a managed compaction, a Claude seat's restore starts on the next poll
  instead of waiting for something to change its screen.
  ([#1971](https://github.com/mvschwarz/openrig/pull/1971))
- `rig compact <seat> --state` and seat status show an owed restore stage and
  its last delivery result, and repeated failures open one queue item for
  whoever can act. ([#1953](https://github.com/mvschwarz/openrig/pull/1953))
- When Claude refuses a startup turn late, for example on an expired login,
  OpenRig checks again before the next startup input's Enter and holds the rest
  as owed. ([#1976](https://github.com/mvschwarz/openrig/pull/1976))
- The model-divergence monitor no longer flags a Claude seat pinned to an
  undated id that answers with its dated snapshot, or to a Bedrock
  inference-profile id.
  ([#1927](https://github.com/mvschwarz/openrig/pull/1927),
  [#1931](https://github.com/mvschwarz/openrig/pull/1931))

**Assistants and other agents**
- OpenRig's MCP server adds `rig_queue_handoff` and `rig_queue_unclaim` (36
  tools), so an assistant can pass held work on, or put it back, in one step.
  ([#1970](https://github.com/mvschwarz/openrig/pull/1970))
- A community-harness preset can set `first_input: true` to hand the harness
  its first startup turn at launch instead of pasting it into the pane. The
  Cursor example uses it and is no longer startup-assisted, and OpenClaw seats
  keep named conversations as a local agent or a Gateway client.
  ([#1987](https://github.com/mvschwarz/openrig/pull/1987),
  [#2017](https://github.com/mvschwarz/openrig/pull/2017),
  [#2009](https://github.com/mvschwarz/openrig/pull/2009))
- `rig stream act <id>` records what a reader did about a stream item:
  `--work <row>`, `--decline "<reason>"` or `--duplicate <id>`.
  `rig stream show` lists each reader's current action.
  ([#1899](https://github.com/mvschwarz/openrig/pull/1899))
- The guide that `rig acp run --help` names now ships:
  `rig context get reference/acp-agents.md`.
  ([#1930](https://github.com/mvschwarz/openrig/pull/1930))

**Running a team**
- Rex is a terminal provider. From a Rex pane, `rig terminal open <view>
  --window` and the TUI open the team's view as a Rex session;
  `--provider rex` selects it.
  ([#1935](https://github.com/mvschwarz/openrig/pull/1935), @vanducng)
- An open rig view keeps a seat's tile when its tmux session is replaced, and a
  fresh replacement prints how to reopen the view.
  ([#1964](https://github.com/mvschwarz/openrig/pull/1964),
  [#1941](https://github.com/mvschwarz/openrig/pull/1941))
- `rig launch <rig> <seat>` first-starts one seat of a team imported with
  `--materialize-only`, without restoring the others.
  ([#1965](https://github.com/mvschwarz/openrig/pull/1965))
- A pod seat that never launched starts fresh from its saved launch recipe after
  a daemon restart, instead of waiting at a shell.
  ([#1503](https://github.com/mvschwarz/openrig/pull/1503), @Vaishnavi220506)
- After a team's tmux server dies, `rig down` settles its seats, so `rig
  archive` and `rig up` can proceed.
  ([#1999](https://github.com/mvschwarz/openrig/pull/1999))
- A team of terminal seats reads fully restored after `rig start`, and
  `rig down` names the terminals it stops.
  ([#1984](https://github.com/mvschwarz/openrig/pull/1984))
- A launch whose tmux made no session fails as `session_not_created` or
  `session_unconfirmed` instead of reading launched.
  ([#1910](https://github.com/mvschwarz/openrig/pull/1910))
- A service bundle install on a machine without Docker Compose v2 stops with
  `compose_missing` before it writes the target or creates the team, and
  `--plan` warns that it would.
  ([#2025](https://github.com/mvschwarz/openrig/pull/2025))
- `rig export` copies the team's culture file and names each seat whose agent
  ref points outside the exported folder.
  ([#1975](https://github.com/mvschwarz/openrig/pull/1975))
- `rig queue resolve <row> --decision "<evidence>"` also releases a row parked
  on a typed blocker such as `external:`, `fold:` or `auth:`.
  ([#1809](https://github.com/mvschwarz/openrig/pull/1809), @dajiaohuang, from
  @BillyOutlast's report)
- `rig queue whoami` resolves a project-tagged row against its catalogued
  project, `rig proof add` finds a slice in another catalogued project, and
  `rig scope mission create` writes the mission's name.
  ([#1526](https://github.com/mvschwarz/openrig/pull/1526), @Vaishnavi220506)
  ([#1938](https://github.com/mvschwarz/openrig/pull/1938),
  [#1936](https://github.com/mvschwarz/openrig/pull/1936))
- A `rig queue create` whose outcome is unknown reads the row back once by its
  ID before reporting, and a cross-host write that times out reads
  INDETERMINATE instead of failed.
  ([#1978](https://github.com/mvschwarz/openrig/pull/1978),
  [#1911](https://github.com/mvschwarz/openrig/pull/1911))
- Slack: every post names its sender first, an escalation names the seat the
  work waits on, a reply from another registered person reaches the agent as
  their own message instead of answering someone else's question, and Slack
  rows name who wrote.
  ([#1960](https://github.com/mvschwarz/openrig/pull/1960),
  [#1893](https://github.com/mvschwarz/openrig/pull/1893))

**Reliability**
- A dead seat's stuck-sweep finding goes to someone who can act, not to the
  dead seat, and says which rule chose them.
  ([#2011](https://github.com/mvschwarz/openrig/pull/2011),
  [#2021](https://github.com/mvschwarz/openrig/pull/2021),
  [#2033](https://github.com/mvschwarz/openrig/pull/2033))
- A seat held at a choice prompt that no hook announces, such as Claude's
  usage-limit dialog, now escalates while it holds work.
  ([#1919](https://github.com/mvschwarz/openrig/pull/1919))
- The parked-owner reminder no longer reaches a seat in the first 5 minutes
  after it starts waiting, such as just after a handoff or a question to a
  person. A seat at an approval or question prompt gets no grace.
  ([#1963](https://github.com/mvschwarz/openrig/pull/1963))
- A Pi or OMP seat's second startup block reaches the running turn instead of
  raising `runtime_error`.
  ([#1943](https://github.com/mvschwarz/openrig/pull/1943), reported by
  @astral-fleet-sessions)
- The daemon starts listening before it works through a backlog of queue
  notifications, so startup doesn't time out behind them.
  ([#1993](https://github.com/mvschwarz/openrig/pull/1993))
- A startup database-conflict check that can't get an answer now says so,
  instead of reading like a clean one.
  ([#1974](https://github.com/mvschwarz/openrig/pull/1974), from @calv-io-n's
  finding)
- Proof-source monitoring watches the missions root, not the whole workspace.
  ([#1951](https://github.com/mvschwarz/openrig/pull/1951))
- Queue views, health reads with long histories and send checks do less
  repeated work. ([#2031](https://github.com/mvschwarz/openrig/pull/2031),
  [#2013](https://github.com/mvschwarz/openrig/pull/2013),
  [#1994](https://github.com/mvschwarz/openrig/pull/1994))
- A stalled-after-claim finding's age counts from the stall, not the claim.
  ([#1959](https://github.com/mvschwarz/openrig/pull/1959))
- From contributors: queued terminal input is dropped after its client
  disconnects ([#1636](https://github.com/mvschwarz/openrig/pull/1636),
  @Vaishnavi220506); TUI focused summaries load their health findings
  ([#1986](https://github.com/mvschwarz/openrig/pull/1986), @Kero-66 and
  @Aschenbath); the TUI keeps the stream's connection state across pages
  ([#2014](https://github.com/mvschwarz/openrig/pull/2014), @Nikhi00718); the
  web dashboard reads a skipped kernel boot as "Boot not tracked", not
  "Unknown" ([#1917](https://github.com/mvschwarz/openrig/pull/1917),
  @Aschenbath, reported by @Kero-66); the compaction-and-restore scenario runs through a launch script, and the test-system docs state the CI job's real counts
  ([#1924](https://github.com/mvschwarz/openrig/pull/1924),
  [#1925](https://github.com/mvschwarz/openrig/pull/1925), @DeryFerd).
- Guidance: the installer guide says what setup and starting Codex seats write
  to your home configuration, and the operator puts project work on a team's
  queue; a Codex user who declines the remembered command rule is offered the
  operator conversation; `rig queue update --help` and its refusal say how to
  cancel a row (`--state done --closure-reason canceled`); `rig skill audit`
  says what its stale and hash findings mean; 14 subcommands that showed a
  blank help summary now have one; the `openrig-user` skill says a queue
  create's request ID isn't the row; `delegating-work` also applies when judging
  a delegated result; and `docs/reference/seat-delivery.md` lists all six
  typing-guard modes.
  ([#2001](https://github.com/mvschwarz/openrig/pull/2001),
  [#1973](https://github.com/mvschwarz/openrig/pull/1973),
  [#1956](https://github.com/mvschwarz/openrig/pull/1956),
  [#1966](https://github.com/mvschwarz/openrig/pull/1966),
  [#1923](https://github.com/mvschwarz/openrig/pull/1923),
  [#1909](https://github.com/mvschwarz/openrig/pull/1909),
  [#2012](https://github.com/mvschwarz/openrig/pull/2012),
  [#1989](https://github.com/mvschwarz/openrig/pull/1989))

### Behaviour that changed

- On Linux, a seat launched by OpenRig now gets the daemon's `XDG_RUNTIME_DIR`,
  with `DBUS_SESSION_BUS_ADDRESS=disabled:`, a session bus address that can't
  connect. Tools whose sockets live in the runtime directory work in seats
  without per-tool setup, and a seat's D-Bus clients don't find or start the
  session bus on their own. A seat's own `XDG_RUNTIME_DIR`, from `env:` for
  example, leaves both as before, and its own bus address is kept. Unchanged:
  macOS, a daemon started without `XDG_RUNTIME_DIR`, and
  `terminal.inherit_tmux_environment` on. See Known issues.
  ([#2036](https://github.com/mvschwarz/openrig/pull/2036), reported by
  @borfast in
  [#2030](https://github.com/mvschwarz/openrig/issues/2030))
- `rig up --env CLAUDE_CONFIG_DIR=…` or `CODEX_HOME=…` isn't applied, and the
  CLI says so; other `--env` values work as before. Name a seat's home in the
  spec's `env:`. ([#1945](https://github.com/mvschwarz/openrig/pull/1945))
- `rig provider switch` acts: it used to answer `failed_safely` every time.
  ([#1972](https://github.com/mvschwarz/openrig/pull/1972),
  [#1980](https://github.com/mvschwarz/openrig/pull/1980))
- A `rig send` to a seat that is switching runtime is held, not typed
  (`outcome: retained`, `reason: runtime_switch_in_progress`); send it again
  after the switch. ([#1895](https://github.com/mvschwarz/openrig/pull/1895))
- `rig seat status --json` always carries `permissions.account.advisories`
  (empty unless there's an advisory).
  ([#1942](https://github.com/mvschwarz/openrig/pull/1942))
- Every Slack post starts with `From <seat> on <machine>`, and an escalation's
  headline reads `Waiting on <seat>: <summary>`; update anything that read the
  sender from the last line.
  ([#1960](https://github.com/mvschwarz/openrig/pull/1960))
- A row OpenRig creates itself, such as a stuck-sweep finding or a workflow
  escalation, wakes its seat from OpenRig's own sender with no reply line, instead
  of from the row's creator. A stuck-sweep closure is recorded as
  `stuck-sweep@system`.
  ([#1905](https://github.com/mvschwarz/openrig/pull/1905))
  ([#1811](https://github.com/mvschwarz/openrig/pull/1811), @Aschenbath)
- With `agents.operator_session` set, a dead seat's finding goes to that agent
  first, then the operator seat (`workspace.operator_seat_name`), then the
  row's creator. Approvals still reach the person. With it unset, routing is as
  before. ([#2021](https://github.com/mvschwarz/openrig/pull/2021))
- An alert for a seat at a choice prompt follows `queue.wake_human_rung`: under
  `explicit-only` it stays with the operator seat as a visible row, unless that
  seat is a person. Only one choice-prompt alert reaches a person at a time on a
  machine; the others wait as visible rows and post when it retires.
  Permission-prompt alerts post as before.
  ([#1919](https://github.com/mvschwarz/openrig/pull/1919))
- On a Codex home with a `hooks.json`, OpenRig's activity hooks go there, and
  its own old inline block moves out of `config.toml`.
  ([#1957](https://github.com/mvschwarz/openrig/pull/1957))
- The recap store refuses to write through a link at `RECAP.md` or
  `recap-superseded/` (`recap_write_refused`), a layout that used to work.
  ([#2018](https://github.com/mvschwarz/openrig/pull/2018))
- Cross-host queue writes wait 15 seconds for the daemon's answer, and a
  timeout reads "queue request got no answer in time" with the ID to reconcile
  by. ([#1911](https://github.com/mvschwarz/openrig/pull/1911))
- The Cursor reference preset is `startup_assisted: false` and passes its first
  prompt at launch. ([#2017](https://github.com/mvschwarz/openrig/pull/2017))
- In a Pi seat that OpenRig runs, an extension `/command` typed mid-turn runs
  at once instead of being refused as a steer.
  ([#1943](https://github.com/mvschwarz/openrig/pull/1943))

### Known issues

- **On Linux, seats now get the runtime directory with a session bus address
  that can't connect.** This is an accepted trade-off, and default hygiene, not
  isolation. A shell startup file that sets only `XDG_RUNTIME_DIR` used to let a
  seat's clients find the session bus; now the seat keeps
  `DBUS_SESSION_BUS_ADDRESS=disabled:`. To use a session bus, set its address in
  the rig's or member's `env:`. `systemctl --user` reaches the person's user
  service manager from a seat, whatever the bus address. A Codex stdio MCP
  server still needs `env_vars = ["XDG_RUNTIME_DIR"]` in Codex's `config.toml`
  to see the variable. ([#2036](https://github.com/mvschwarz/openrig/pull/2036))
- **Per-member Claude tool rules have limits.** Member denies aren't claimed to
  hold in bypass mode (`full_bypass`). Handover and restore carry the rules, but
  aren't proven to keep the same conversation. An allow list doesn't withdraw
  broader inherited grants, and these are Claude's own tool rules, not OS or
  credential isolation. A change applies at the next launch or resume, not in a
  running process. Going back to code from before #1914 drops the stored rules
  from launch (see Before you upgrade).
  ([#1914](https://github.com/mvschwarz/openrig/pull/1914))
- **Pi dialog recognition is a bounded screen check.**
  [#2015](https://github.com/mvschwarz/openrig/pull/2015) refuses ordinary
  sends at an adopted Pi confirmation dialog, and
  [#2026](https://github.com/mvschwarz/openrig/pull/2026) later extended the
  same classifier to Pi's input and editor dialogs and wrapped help rows. Each
  was checked with a real Pi for its own case only. Layouts outside them keep
  the earlier behaviour, so an ordinary send can still type into them: more than
  six rows under a confirmation dialog's border, a widget that draws its own
  border, clipped or incomplete help, more than three wrapped help rows, and
  custom extension UIs. Neither check was repeated on the final 0.7.2 build.
- **Moving a seat's account or runtime has limits.** A conversation saved under
  a seat's earlier home doesn't resume in its new one, and live usage refresh
  still reads only the daemon's own logins. A Codex login switch is Linux only;
  other seats on that Codex home keep their old login until their next token
  refresh, then stop with "signed in to another account" until you run the
  printed `rig seat restart <peer> --keep-conversation` for each. A runtime
  switch starts a new native conversation (only the handover carries over),
  clears the source runtime's model, effort and Codex profile, and doesn't apply
  Claude launch additions such as an agent file or run startup slash commands.
  Selected separate-home restart/restore and useful conversation-continuity
  cases passed. Runtime switching worked in both directions in a minimal setup;
  one direction required an extra Enter. See Verification and remaining limits
  below for the untested paths.
- **A new Claude agent's startup text can stay unsent in its input box.** Press
  Enter in its terminal.
- **Claude seats on a macOS native install can read as needing attention after a
  restore** ([#86](https://github.com/mvschwarz/openrig/issues/86)). Check the
  seat's terminal before acting on it.
- **A Slack channel-mapping change needs a daemon restart.** Don't use
  `rig slack disable` then `enable` for it, which marks waiting alerts as seen.
- **Ubuntu 22.04's tmux 3.2a:** the known crashing query is gone, but a narrower
  race remains. Prefer another tmux.
- **`rig daemon start` can take 20 to 40 seconds before its listener warning,**
  longer than the TUI's 30-second "restore everything" wait. On a slow host, run
  `rig daemon start` yourself first.
- **A Claude seat signed in with a long-lived token (`claude setup-token`) still
  gets no automatic usage reading.** The reader accepts only claude.ai
  subscription logins and reports `not_subscription_login` for any other. Read a
  token's usage on request with `rig provider status --refresh --provider claude
  --claude-token-file <path> --credential-label <label>`; the label is yours,
  not an account the provider confirmed.
- **Managed Claude launch requires `/usr/bin/env` support for `-0` and `-u`**
  (option support checked on GNU coreutils and macOS 15; BusyBox and older macOS
  unverified). Without the required option support, launch stops instead of
  falling back to credential-bearing command-line arguments.
- **In draft-aware mode, an agent's multi-line message to a Claude seat can
  remain unsubmitted when the paste changes Claude's footer hint.** OpenRig
  withholds Enter, leaving the text in the composer and later sends waiting.
  Observed on Claude 2.1.309 with both 0.7.0 and the 0.7.1 pre-cut build. 0.7.2
  reads Claude's recognized footer hints as part of the same composer
  ([#1921](https://github.com/mvschwarz/openrig/pull/1921)), but the original
  failure didn't reproduce in a native check, so
  [#14](https://github.com/mvschwarz/openrig/issues/14) remains open.
- **Prompt-looking text in a seat's recent output can still be mistaken for an
  active approval prompt in some layouts, so OpenRig can refuse sends and queue
  wakes.** 0.7.2 lets sends through to a Claude seat whose running timer row sits
  directly above its empty, framed input box (checked natively on Claude Code
  2.1.309, for the layouts exercised). An idle Claude seat with quoted prompt
  text above its input box, a draft in the box, a mode bar OpenRig doesn't
  recognize (such as `⏸ manual mode on`), an unframed box, and Codex seats are
  unchanged. Inspect the current native prompt and the refusal before retrying;
  do not assume that waiting 15 seconds clears it.
- **The shared-database check needs `lsof`.** Without a working `lsof`, the
  check can't tell whether another live daemon holds the database. The daemon
  now says so at startup and on `/healthz`, but the optional
  `daemon.db_conflict: stop` stops only on a confirmed conflict, so it doesn't
  stop then. The warning for a database outside `OPENRIG_HOME` doesn't depend
  on `lsof`. ([#1974](https://github.com/mvschwarz/openrig/pull/1974))
- **Managed Claude restoration can still ask for approvals.** 0.7.2 lets a seat
  read its own restore files without asking, from its next launch or resume. A
  relative `policies.claude_compaction.message_file_path` still asks once, and a
  packet read can ask after the native conversation changes. In 0.7.1's
  representative test, the restore also asked to run four read-only commands,
  which these grants don't cover. Check the retained restore map and reported
  gaps before treating restoration as complete.
  ([#1940](https://github.com/mvschwarz/openrig/pull/1940),
  [#1952](https://github.com/mvschwarz/openrig/pull/1952),
  [#1962](https://github.com/mvschwarz/openrig/pull/1962)) A native check on Claude
  2.1.309 passed the Read grants with no approval prompt; a complete restore
  with no help isn't claimed.
- **A managed Claude restore can remain owed.** If a seat stays idle after
  compaction, `rig compact <seat> --state` and seat status now show the owed
  stage and its last delivery result; also read its saved restore map. Before
  sending a manual restore request, reconcile the native conversation and
  pending state to avoid a duplicate; do not repeat `/compact` merely because
  the restore request has not arrived.
  ([#1953](https://github.com/mvschwarz/openrig/pull/1953))
- **On Linux, very large trees can still cause severe daemon stalls and
  file-watch-limit failures.** Proof-source monitoring now recurses only at the
  configured missions root, so unrelated checkouts and build trees in the
  workspace aren't watched, but a large missions tree still is, and the stalls'
  cause hasn't been confirmed.
  ([#1813](https://github.com/mvschwarz/openrig/issues/1813),
  [#1951](https://github.com/mvschwarz/openrig/pull/1951))
- **A Claude startup refusal that arrives after OpenRig's last check can still
  race the next startup input's Enter.** When OpenRig withholds Enter, the
  pasted input may stay in the input box: don't resend it, and follow the
  recovery step the seat reports. Recovery after signing in wasn't verified
  natively.
  ([#1976](https://github.com/mvschwarz/openrig/pull/1976))
- **Claude Code answers plan-mode turns with Sonnet when a seat's model is the
  alias `haiku`.** That's Claude Code's own behaviour, and OpenRig now says so.
  Configuring the full id `claude-haiku-5-5` gave a Haiku answer in a plan-mode
  follow-up on Claude Code 2.1.309.
  ([#1942](https://github.com/mvschwarz/openrig/pull/1942))
- **A cross-host queue create can still end with an unknown outcome.** A
  timed-out `rig queue create --host` now reads INDETERMINATE, and the CLI reads
  the row back once by its ID. If it's still unknown, check that host for the
  original row ID before retrying. If the row exists, do not create a
  replacement. If a retry is needed, reuse the same `--id` and payload; an
  unsuccessful read is not proof that the row is absent.
  ([#1911](https://github.com/mvschwarz/openrig/pull/1911),
  [#1978](https://github.com/mvschwarz/openrig/pull/1978))
- **A Codex seat whose queue-state folder or team-workspace path contains a
  space can still be misread on an ordinary resume or restore,** because those
  arguments come before the conversation id. An in-place restart is fixed.
  ([#2037](https://github.com/mvschwarz/openrig/pull/2037))
- **Automatic Codex hook approval needs OpenRig's plugin folder to match what
  shipped.** If `$OPENRIG_HOME/plugins/openrig-core` holds files that didn't
  ship, the Codex plugin still installs or upgrades, but OpenRig approves
  nothing itself: an existing approval stays as it was, and Codex's own hook
  review applies. On a restart without a version change, if a hook file or the
  plugin manifest there differs from what this version shipped, OpenRig doesn't
  install or upgrade its Codex plugin. On a version upgrade, OpenRig's managed
  refresh replaces an edited plugin file with the shipped one and keeps your
  edited copy under `$OPENRIG_HOME/backups/managed-refresh/`; after upgrading,
  inspect those backups and reapply any deliberate customization.
- **Terminal views:** a view opened before 0.7.2 needs closing and reopening to
  keep its tiles through a session replacement, and a replacement that takes
  too long can still need a reopen. This wasn't run in the Herdr, cmux or Rex
  apps or over SSH, so
  [#1939](https://github.com/mvschwarz/openrig/issues/1939) stays open. Rex
  wasn't run on Linux, and a Rex tile that fails 2 to 10 seconds after opening
  is still listed as opened.
  ([#1964](https://github.com/mvschwarz/openrig/pull/1964),
  [#1935](https://github.com/mvschwarz/openrig/pull/1935))
- **Herdr's own status for a seat can read idle or unknown while OpenRig shows
  it waiting** (`needs-input`), because OpenRig doesn't feed Herdr a state. Use
  OpenRig's view or the Feed to find waiting seats. Reopening a view with
  `--provider herdr` adds a workspace each time; from inside Herdr,
  `rig terminal open <view> --window` reuses a matching one.
  ([#2032](https://github.com/mvschwarz/openrig/pull/2032))

### Credits

Thank you to everyone whose work is in this release: @Vaishnavi220506,
@Aschenbath, @dajiaohuang, @DeryFerd, @vanducng, @Nikhila-Dhevi-R, @Nikhi00718
and @Kero-66, and to @borfast, @BillyOutlast, @tianqizhao0704, @calv-io-n,
@george661, @fsafey, @astral-fleet-sessions and the Heretek-AI team, whose
reports, ideas and outside audit led to fixes here.

Thanks also to @alexveli1 and @george661, who reported
[#1764](https://github.com/mvschwarz/openrig/issues/1764) (addressed by
[#1778](https://github.com/mvschwarz/openrig/pull/1778) and
[#1944](https://github.com/mvschwarz/openrig/pull/1944)); @kainne44 and
@bobbiejaxn, who reported [#81](https://github.com/mvschwarz/openrig/issues/81)
(partly addressed by [#1919](https://github.com/mvschwarz/openrig/pull/1919));
@oneandonlydean, who reported
[#1813](https://github.com/mvschwarz/openrig/issues/1813) (partly addressed by
[#1951](https://github.com/mvschwarz/openrig/pull/1951)); @todie, who reported
[#1419](https://github.com/mvschwarz/openrig/issues/1419) (its closure
attribution addressed by
[#1811](https://github.com/mvschwarz/openrig/pull/1811)); @reisalbuquerque, who
reported [#49](https://github.com/mvschwarz/openrig/issues/49) (partly addressed
by [#1503](https://github.com/mvschwarz/openrig/pull/1503)); @jimallen, who
reported [#17](https://github.com/mvschwarz/openrig/issues/17) (partly addressed
by [#2028](https://github.com/mvschwarz/openrig/pull/2028)); @parkingmeter, who
reported [#1933](https://github.com/mvschwarz/openrig/issues/1933) (addressed by
[#1963](https://github.com/mvschwarz/openrig/pull/1963)); @vanducng, who
reported [#1939](https://github.com/mvschwarz/openrig/issues/1939) (addressed by
[#1964](https://github.com/mvschwarz/openrig/pull/1964) and
[#1941](https://github.com/mvschwarz/openrig/pull/1941), open for confirmation);
and @haichongfu and @vadym-abstract-factory, who reported
[#14](https://github.com/mvschwarz/openrig/issues/14) (worked on again in
[#1921](https://github.com/mvschwarz/openrig/pull/1921); still open).

Thanks also to @reco for the runtime-switch request in [#589](https://github.com/mvschwarz/openrig/issues/589); @pr0xc3nt4ur1 for the edge-preservation and update case in [#1193](https://github.com/mvschwarz/openrig/issues/1193); and @m3ac-AllbrittenJ and @lev-gpt for the stall-reporting and age evidence in [#331](https://github.com/mvschwarz/openrig/issues/331).

## Verification and remaining limits

This release's selected checks found no demonstrated regression against published 0.7.1 or data loss. This is not an all-paths pass. The sealed package, installed checks and a real 0.7.1 upgrade passed at their recorded scope; both first-user journeys completed.

- Slack replies can land outside the originating thread when an agent follows the existing reply hint without --reply-to. This round trip failed in testing. The hint predates 0.7.2; the later fix #2055 is not in this release.
- Abrupt power-loss recovery on 0.7.2 was not tested: the fixture hit its disk-growth cap before its power cut. The 0.7.1 comparison passed data and native-conversation recovery, but its separate terminal-team restore was partial. That baseline is not proof of 0.7.2 recovery.
- Native account, home and runtime coverage is partial. Selected separate-home restart/restore and useful conversation-continuity cases passed. Runtime switching worked in both directions in a minimal setup; one direction required an extra Enter. The full home matrix, a second Claude subscription token, same-token handover and stored-home-change cases, native switch edge cases and full-kernel coverage, some Slack button cases, and the right-side agents' useful answers after resume remain untested. Controlled restart cases do not substitute for the full native matrix.
- The named-risk managed compaction and restore exercise completed with useful continuation after about 46 minutes of work, but the adopted Claude home had no OpenRig hooks. Marker, packet and trace paths that depend on those hooks were not exercised by that run.
- Comparable release-level speed, resource-use and provider usage/charge proof remain unavailable. No across-the-board performance improvement is claimed.

The long-paste issue #14 remains open; the Codex model-picker limitation #2010 and ordinary Codex resume/restore with a space in a workspace or queue-state path remain. The fixed in-place restart path is not proof for ordinary restore. Existing Linux session-bus, Claude member-rule, Pi recognition and other documented limits still apply.

Hermes, Cursor's plug-in work and the Codex member-permission counterpart are not included. Follow-up coverage review is scheduled for 2026-10-26 at 12:00 UTC; that is a review date, not a promise that every gap will be closed.

## [0.7.1] - 2026-10-25

Published 2026-10-25 as `@openrig/cli@0.7.1`, built from the commit tagged
`v0.7.1` (`1e392d56`). This entry is its release notes, as published on the
[GitHub Release](https://github.com/mvschwarz/openrig/releases/tag/v0.7.1).

OpenRig 0.7.1 gives you more say over how much your team does on its own. You
choose, per seat, how much automatic input reaches an agent's terminal and how
far other agents may act on it, and you can see the permissions each seat will
launch with. Questions to you land on the TUI's Feed, and Slack can carry every
ask or only urgent ones. Team skills stay out of your project, assistants such
as Claude Desktop can do much more through MCP, and a managed compaction
survives a daemon restart.

### Before you upgrade

- **Restart the daemon after installing.** Eight database updates apply on its
  first start.
  ```bash
  npm install -g @openrig/cli@0.7.1
  rig daemon stop && rig daemon start
  ```
- **Startup replaces OpenRig's own plugin and skill files** (openrig-core goes
  from 0.1.17 to 0.1.18). As in 0.7.0, it first copies each file it replaces
  under `$OPENRIG_HOME/backups/managed-refresh/` and logs where, edited or not.
  If you did edit one, reapply your change from the copy.
- **Claude seats need Claude Code 2.1.280 or newer to see their team skills**
  (`claude --version`).
- **If an earlier version reset your worktree's Claude permission mode, set it
  back once by hand.** Launching a managed Claude seat used to rewrite
  `defaultMode` in `.claude/settings.local.json` to `acceptEdits`; 0.7.1 stops,
  but doesn't repair files already changed.
  ([#1776](https://github.com/mvschwarz/openrig/pull/1776))
- **If you might go back to 0.7.0, undo Slack subscription choices first.**
  0.7.0 can't read a person file that holds one, so its people registry stops
  loading. Save each choice (`rig gateway human show <id> --json > <id>.json`),
  then run `rig gateway human set <id> slack-subscription unset`: someone on
  `urgent-only` gets every ask in Slack again, as 0.7.0 does. Set it again after
  you return to 0.7.1. The unset removes only the Slack subscription, so a
  person file that still holds a `subscriptions:` entry fails on 0.7.0 too.
  Don't restore an older gateway folder or database instead: that can lose newer
  people, bindings and delivery records.
- **If you go back to 0.7.0 and then upgrade again,** old process evidence can
  keep a seat reading `running` instead of being relaunched.
  ([#1906](https://github.com/mvschwarz/openrig/pull/1906))

### What's new and fixed

**How much your team does on its own**
- `rig seat set-typing-guard <seat> --mode off|openrig-urgent|urgent-only|hold`
  sets how much automatic input reaches a seat. `rig send --urgent` or an urgent
  queue row marks a message urgent, naming who marked it. Held input stays
  readable and is never replayed.
  ([#1770](https://github.com/mvschwarz/openrig/pull/1770),
  [#1781](https://github.com/mvschwarz/openrig/pull/1781))
- `rig seat set-terminal-policy <seat> --preset no-peer-interventions|help-within-instructions|full-control`
  sets how far OpenRig and other agents may act on a seat, with exceptions for
  compaction and model changes. Existing seats keep full control.
  ([#1846](https://github.com/mvschwarz/openrig/pull/1846))
- `rig seat status` shows the permissions a seat's next fresh launch will use
  and where each comes from; `rig setup` asks before adding OpenRig's line to
  your shared guidance files.
  ([#1843](https://github.com/mvschwarz/openrig/pull/1843))

**Asks to you.** An ask lands on the TUI's Feed. Every ask still posts to Slack
by default; `rig gateway human set <id> slack-subscription urgent-only` keeps
Slack for asks marked `--alert`, which stand out with a mention.
([#1868](https://github.com/mvschwarz/openrig/pull/1868),
[#1878](https://github.com/mvschwarz/openrig/pull/1878))

**Seats keep their setup out of your project**
- Team skills live in each seat's own storage, not your project's
  `.claude/skills` or `.agents/skills`; `rig skill loadout --seat <seat>` shows
  them. ([#1008](https://github.com/mvschwarz/openrig/pull/1008), @puniserv)
- A Claude member can bring its own agent file, system prompt file, plugin
  folders and Advisor model.
  ([#1737](https://github.com/mvschwarz/openrig/pull/1737),
  [#1736](https://github.com/mvschwarz/openrig/pull/1736), @Aschenbath)
- A seat's role no longer overwrites the others' in a shared `CLAUDE.md` or
  `AGENTS.md`, and `rig down` restores your guidance files byte for byte.
  ([#1840](https://github.com/mvschwarz/openrig/pull/1840),
  [#1854](https://github.com/mvschwarz/openrig/pull/1854),
  [#1859](https://github.com/mvschwarz/openrig/pull/1859),
  [#1867](https://github.com/mvschwarz/openrig/pull/1867))

**Assistants and other agents**
- OpenRig's MCP server grows from 23 to 34 tools, including identity, restore
  status, a rig's team and lead, following a handoff, reading a result and
  deciding inside a person's decision room. `rig mcp serve --http` serves an
  assistant on another machine, each caller acting as its own seat.
  ([#1831](https://github.com/mvschwarz/openrig/pull/1831),
  [#1835](https://github.com/mvschwarz/openrig/pull/1835),
  [#1842](https://github.com/mvschwarz/openrig/pull/1842),
  [#1853](https://github.com/mvschwarz/openrig/pull/1853),
  [#1860](https://github.com/mvschwarz/openrig/pull/1860),
  [#1596](https://github.com/mvschwarz/openrig/pull/1596), @pdurlej)
- `rig acp run <row>` hands a row's task to an ACP agent such as Hermes or
  OpenClaw; a new guide covers A2A agents.
  ([#1823](https://github.com/mvschwarz/openrig/pull/1823),
  [#1829](https://github.com/mvschwarz/openrig/pull/1829))
- Community harnesses can report, name and reopen conversations, with examples
  for Cursor, Hermes and OpenClaw.
  ([#1768](https://github.com/mvschwarz/openrig/pull/1768),
  [#1769](https://github.com/mvschwarz/openrig/pull/1769),
  [#1771](https://github.com/mvschwarz/openrig/pull/1771),
  [#1783](https://github.com/mvschwarz/openrig/pull/1783),
  [#1784](https://github.com/mvschwarz/openrig/pull/1784),
  [#1826](https://github.com/mvschwarz/openrig/pull/1826),
  [#1870](https://github.com/mvschwarz/openrig/pull/1870))

**Running a team**
- A daemon restart, such as an upgrade, picks up a managed compaction where it
  stopped. ([#1866](https://github.com/mvschwarz/openrig/pull/1866))
- `rig edge add` and `rig edge remove` change one edge on a running rig.
  ([#1733](https://github.com/mvschwarz/openrig/pull/1733),
  [#1746](https://github.com/mvschwarz/openrig/pull/1746))
- `rig up <spec> --name <rig>` runs one spec as several rigs.
  ([#1692](https://github.com/mvschwarz/openrig/pull/1692), @klueless-io)
- `rig watchdog update` retunes a job in place; the context watch takes token or
  percent thresholds. ([#1803](https://github.com/mvschwarz/openrig/pull/1803),
  @AdamWhitehurst) ([#1735](https://github.com/mvschwarz/openrig/pull/1735),
  @akushonkamen)
- `policies.claude_compaction.preparation_root` puts restore maps where seats
  may write. ([#1585](https://github.com/mvschwarz/openrig/pull/1585),
  @Aschenbath)
- Herdr: tiles come back after a Herdr restart (one over SSH needs reopening),
  `--session` picks a Herdr session, and the TUI's terminal button works over
  SSH. ([#1796](https://github.com/mvschwarz/openrig/pull/1796),
  [#1076](https://github.com/mvschwarz/openrig/pull/1076), @Aschenbath)
  ([#1748](https://github.com/mvschwarz/openrig/pull/1748))
- New seats get the daemon's `OPENRIG_DB` and `TMUX_TMPDIR`.
  ([#1812](https://github.com/mvschwarz/openrig/pull/1812))
- `rig setup --providers` is remembered (`provider.selected`), so the kernel
  starts seats only for the harnesses you chose.
  ([#1817](https://github.com/mvschwarz/openrig/pull/1817))
- Optional `daemon.db_conflict: stop` keeps a second daemon off a database
  another live daemon holds; the default still only warns.
  ([#1890](https://github.com/mvschwarz/openrig/pull/1890))
- `rig stream subscribe <seat>` and `rig stream read` give a seat bounded pages
  of the observations meant for it, and `rig stream show <id>` says what became
  of one. ([#1891](https://github.com/mvschwarz/openrig/pull/1891),
  [#1888](https://github.com/mvschwarz/openrig/pull/1888))
- Stream retention is on: items emitted after the upgrade are deleted after 30
  days, or beyond the newest 20,000, unless a record names them
  (`retention.stream_days`, `retention.stream_max_items`). History from before
  the upgrade is kept. ([#1891](https://github.com/mvschwarz/openrig/pull/1891),
  [#1897](https://github.com/mvschwarz/openrig/pull/1897))
- Off by default: once decisions are enabled, `rig project wake --decide` lets
  your intake seat route stream observations with one bounded typed decision
  each, and hands anything uncertain back to that seat.
  ([#1879](https://github.com/mvschwarz/openrig/pull/1879),
  [#1882](https://github.com/mvschwarz/openrig/pull/1882),
  [#1894](https://github.com/mvschwarz/openrig/pull/1894))

- Off by default since 0.6.12: with `bundle.services_enabled` on (`rig
  config set bundle.services_enabled true`), a bundle carries its Compose
  file, `rig bundle inspect` shows each service before anything runs, and
  `rig bundle install <bundle> --target <folder>` starts its services, then
  its seats, in that folder. In 0.7.1, `--plan --target` previews the
  services an install would run, the before-install view also names a Claude
  member's own agent, prompt and plugin folders, and the example
  secrets-manager team publishes Vault's port on the host's loopback only.
  Proven on Linux; not run on macOS.
  ([#1474](https://github.com/mvschwarz/openrig/pull/1474),
  [#1848](https://github.com/mvschwarz/openrig/pull/1848),
  [#1745](https://github.com/mvschwarz/openrig/pull/1745),
  [#1845](https://github.com/mvschwarz/openrig/pull/1845))

**Reliability**
- `rig daemon start` waits for a slow daemon instead of stopping it, and warns
  rather than fails when only a secondary listener, such as Tailscale's, can't
  be verified. ([#1716](https://github.com/mvschwarz/openrig/pull/1716),
  @dajiaohuang) ([#1743](https://github.com/mvschwarz/openrig/pull/1743),
  [#1793](https://github.com/mvschwarz/openrig/pull/1793))
- A Claude seat whose startup turn is refused reports its remaining startup
  context as owed; with an expired login, later startup inputs can still be
  submitted first (see Known issues).
  ([#1869](https://github.com/mvschwarz/openrig/pull/1869))
- On Ubuntu 22.04's tmux 3.2a, a closing session no longer sends the query that
  crashes tmux. ([#1755](https://github.com/mvschwarz/openrig/pull/1755))
- A rebuilt Codex seat keeps its narrower sandbox, and read-only Codex profiles
  launch. ([#1779](https://github.com/mvschwarz/openrig/pull/1779),
  [#1791](https://github.com/mvschwarz/openrig/pull/1791),
  [#1825](https://github.com/mvschwarz/openrig/pull/1825), @bradvin)
- Reminders and workflow keepalives survive a seat swap.
  ([#1777](https://github.com/mvschwarz/openrig/pull/1777),
  [#1782](https://github.com/mvschwarz/openrig/pull/1782))
- OpenRig's hooks run without Node on the seat's PATH.
  ([#1727](https://github.com/mvschwarz/openrig/pull/1727),
  [#1728](https://github.com/mvschwarz/openrig/pull/1728),
  [#1729](https://github.com/mvschwarz/openrig/pull/1729))
- After a daemon restart that can't see the seats' tmux server, running agents
  are no longer detached and relaunched beside themselves.
  ([#1906](https://github.com/mvschwarz/openrig/pull/1906))
- Provider credentials and the activity-hook token stay off tmux, shell and
  `env` command lines; @pr0xc3nt4ur1 first raised it in
  [#1360](https://github.com/mvschwarz/openrig/pull/1360).
  ([#1907](https://github.com/mvschwarz/openrig/pull/1907))
- An answer retried from Slack or Steering after an interrupted close is used
  once, and a replayed Slack reply stays absorbed.
  ([#1896](https://github.com/mvschwarz/openrig/pull/1896),
  [#1898](https://github.com/mvschwarz/openrig/pull/1898))
- One stuck row on a removed rig no longer stops the stuck sweep from flagging
  the rest, and stopped watchdog jobs release their old schedules.
  ([#1903](https://github.com/mvschwarz/openrig/pull/1903),
  [#1900](https://github.com/mvschwarz/openrig/pull/1900))
- Health diagnoses still list when an unrelated diagnosis row holds a malformed
  field. ([#1920](https://github.com/mvschwarz/openrig/pull/1920))
- Upgrading OpenRig no longer stops a working Codex seat at "Hooks need review".
  OpenRig can renew approval of its own Codex plugin during an upgrade when the
  prior approval exactly matches the previous shipped bundle, nothing is
  disabled, and the installed bytes match the shipped bundle. Explicit disables
  and unrelated hooks are preserved.
  ([#1948](https://github.com/mvschwarz/openrig/pull/1948))
- A seat waiting at a prompt that only its pane shows, such as a Codex approval
  prompt, is shown as needing attention, with its reason, in the seat view,
  `rig ps`, the compact JSON and the rig count.
  ([#1946](https://github.com/mvschwarz/openrig/pull/1946))
- From contributors: launch probe evidence
  ([#1499](https://github.com/mvschwarz/openrig/pull/1499), @Aschenbath);
  request IDs for creates and checked stops
  ([#1790](https://github.com/mvschwarz/openrig/pull/1790),
  [#1792](https://github.com/mvschwarz/openrig/pull/1792), @bradvin); faster
  cost history, ordered stream replay, kept web-UI drafts and guarded sends at
  Claude's MCP prompts ([#1756](https://github.com/mvschwarz/openrig/pull/1756),
  [#1757](https://github.com/mvschwarz/openrig/pull/1757),
  [#1758](https://github.com/mvschwarz/openrig/pull/1758),
  [#1864](https://github.com/mvschwarz/openrig/pull/1864),
  [#1865](https://github.com/mvschwarz/openrig/pull/1865), @Nikhi00718); a
  non-blocking preflight
  ([#1759](https://github.com/mvschwarz/openrig/pull/1759), @icey-zzz); clearer
  compact-plan output ([#1629](https://github.com/mvschwarz/openrig/pull/1629),
  @taljeri); exports keep culture files
  ([#1657](https://github.com/mvschwarz/openrig/pull/1657), @Totopo27); no flash
  in terminal views ([#1663](https://github.com/mvschwarz/openrig/pull/1663),
  @Vaishnavi220506); pod startup files for added seats
  ([#1701](https://github.com/mvschwarz/openrig/pull/1701), @AdamWhitehurst); Pi
  idle heartbeats ([#1702](https://github.com/mvschwarz/openrig/pull/1702),
  @okle100); the `rig ps` activity column
  ([#1614](https://github.com/mvschwarz/openrig/pull/1614),
  @shravansumanthanan); full workflow trails
  ([#1732](https://github.com/mvschwarz/openrig/pull/1732), @psbanka).

### Behaviour that changed

- `rig ps --nodes` separates every column with a space and adds an ATTN column
  before REASON; update scripts that read columns by position.
  ([#1780](https://github.com/mvschwarz/openrig/pull/1780),
  [#1876](https://github.com/mvschwarz/openrig/pull/1876))
- `rig queue show --json` drops `lastNudgeInputBox`, and send results no longer
  describe the input box.
  ([#1738](https://github.com/mvschwarz/openrig/pull/1738))
- `rig down` asks before stopping the rig you're in; without a terminal it stops
  nothing and prints the `--yes` command.
  ([#1838](https://github.com/mvschwarz/openrig/pull/1838))
- `rig up --plan` no longer starts a stopped daemon; it exits with
  `daemon_not_running`.
  ([#1836](https://github.com/mvschwarz/openrig/pull/1836))
- An urgent or critical row's wake starts with `Urgent (marked by …):`.
  ([#1770](https://github.com/mvschwarz/openrig/pull/1770))
- `rig provider moves` is back with a new job: filing and reading subscription
  move reports. It switches nothing.
  ([#1847](https://github.com/mvschwarz/openrig/pull/1847),
  [#1849](https://github.com/mvschwarz/openrig/pull/1849))
- `rig queue show` and `rig queue whoami` print human notices on stderr.
  ([#1808](https://github.com/mvschwarz/openrig/pull/1808))
- A seat joined with `rig attach` as an outside app stays attached through
  `rig down` and restore.
  ([#1827](https://github.com/mvschwarz/openrig/pull/1827),
  [#1834](https://github.com/mvschwarz/openrig/pull/1834))
- `rig send --dangerously-interact --reason` into a seat's input box stops and
  shows text already typed or pasted there, apart from suggestions, instead of
  pasting over it; clear it and retry, or pass `--type-without-checking`. Keys
  for a recognized native menu are sent as before.
  ([#1892](https://github.com/mvschwarz/openrig/pull/1892))
- `rig send` to a terminal seat types exactly your text, without the From/To
  lines, and queue wakes type nothing into it.
  ([#1100](https://github.com/mvschwarz/openrig/pull/1100))
- A stream body over 16 KiB is stored truncated and marked, and
  `rig stream list --after` from a pruned item returns `stream_cursor_expired`
  instead of an empty list.
  ([#1891](https://github.com/mvschwarz/openrig/pull/1891))
- A send held for a draft in the seat's input box reports
  `inputPhase: "not_reached"`, and a managed compaction prompt held that way
  counts as not sent. ([#1884](https://github.com/mvschwarz/openrig/pull/1884),
  [#1889](https://github.com/mvschwarz/openrig/pull/1889))

### Known issues

- **A new Claude agent's startup text can stay unsent in its input box.** Press
  Enter in its terminal.
- **Claude seats on a macOS native install can read as needing attention after a
  restore** ([#86](https://github.com/mvschwarz/openrig/issues/86)). Check the
  seat's terminal before acting on it.
- **A Slack channel-mapping change needs a daemon restart.** Don't use
  `rig slack disable` then `enable` for it, which marks waiting alerts as seen.
- **Ubuntu 22.04's tmux 3.2a:** the known crashing query is gone, but a narrower
  race remains. Prefer another tmux.
- **`rig daemon start` can take 20 to 40 seconds before its listener warning,**
  longer than the TUI's 30-second "restore everything" wait. On a slow host, run
  `rig daemon start` yourself first.
- **A Claude seat signed in with a long-lived token (`claude setup-token`) gets
  no usage reading.** The reader accepts only claude.ai subscription logins and
  reports `not_subscription_login` for any other.
- **Managed Claude launch requires `/usr/bin/env` support for `-0` and `-u`**
  (option support checked on GNU coreutils and macOS 15; BusyBox and older macOS
  unverified). Without the required option support, launch stops instead of
  falling back to credential-bearing command-line arguments.
- **In draft-aware mode, an agent's multi-line message to a Claude seat can
  remain unsubmitted when the paste changes Claude's footer hint.** OpenRig
  withholds Enter, leaving the text in the composer and later sends waiting.
  Observed on Claude 2.1.309 with both 0.7.0 and the 0.7.1 pre-cut build;
  [#14](https://github.com/mvschwarz/openrig/issues/14) remains open.
- **Prompt-looking text in a seat's recent output can be mistaken for an active
  approval prompt, so OpenRig can refuse sends and queue wakes even while the
  seat is working.** Inspect the current native prompt and the refusal before
  retrying; do not assume that waiting 15 seconds clears it.
- **`rig acp run --help` points to `reference/acp-agents.md`, which is not
  included in this release's reference context pack.** Read
  `daemon/docs/reference/acp-agents.md` inside the installed @openrig/cli
  package instead.
- **The shared-database check needs `lsof`.** #1763's warning that another live
  daemon is using the same database, and the optional
  `daemon.db_conflict: stop`, find that daemon with `lsof`. On a host without a
  working `lsof` (each lsof call times out after 1 s), the check is skipped
  without a message, so neither the warning nor the stop happens. The warning
  for a database outside `OPENRIG_HOME` doesn't depend on `lsof`.
- **Managed Claude restoration can require native approvals.** On a seat without
  bypass permissions, restoration can ask to read OpenRig files outside its
  working directory. In a representative `openrig-core` test on Claude Code
  2.1.309 (`acceptEdits`), the restore and audit completed after three one-time
  Read approvals (the restore marker, post-compaction instructions and
  refocusing skill) plus four approvals for read-only commands. Check the
  retained restore map and reported gaps before treating restoration as
  complete.
- **A managed Claude restore can remain owed without showing why delivery is
  delayed.** If a seat remains idle after compaction, inspect
  `rig compact <seat> --state` and its saved restore map. Before sending a
  manual restore request, reconcile the native conversation and pending state to
  avoid a duplicate; do not repeat `/compact` merely because the restore request
  has not arrived.
- **On Linux, workspaces containing very large checkout or build trees can cause
  severe daemon stalls and file-watch-limit failures.** The recursive
  proof-source watcher covers the workspace root. Keeping large checkout/build
  trees outside that root may reduce exposure; this mitigation has not yet been
  verified. ([#1813](https://github.com/mvschwarz/openrig/issues/1813))
- **A Claude startup with an expired login can still submit later startup inputs
  before noticing the refusal.** The packaged whats-new
  (`reference/whats-new.md`) overstates the hold behavior. Resolve the login and
  follow the seat's reported continuation guidance; this test did not verify
  recovery. ([#1869](https://github.com/mvschwarz/openrig/pull/1869))
- **On Claude Code 2.1.309, a seat configured with the model alias `haiku` and
  the plan permission answered on Sonnet in one observed run.** Configuring the
  full id `claude-haiku-5-5` gave a Haiku answer in the plan-mode follow-up.
- **A Cursor seat's startup is assisted.** It reports `attention_required` and
  needs one operator acknowledgement:
  `rig seat clear-attention <seat> --reason "<why>"`. This wasn't rechecked
  natively on 0.7.1. ([#1870](https://github.com/mvschwarz/openrig/pull/1870))
- **A resumed Codex seat can be misreported as not interactive when its header
  has scrolled off and its footer uses a multi-word model label such as GPT-6.1
  Sol medium; `rig up --existing` can then stop.** Reported on 0.7.0; the same
  recognition checks remain in 0.7.1.
  ([#1764](https://github.com/mvschwarz/openrig/issues/1764))
- **Cross-host queue creation can report failure after the row was created.** A
  `rig queue create --host` request can time out or return failure even though
  the destination host created the row. Check that host for the original row ID
  before retrying. If the row exists, do not create a replacement. If a retry is
  needed, reuse the same `--id` and payload; an unsuccessful read is not proof
  that the row is absent.
- **Automatic Codex hook approval needs OpenRig's plugin folder to match what
  shipped.** If `$OPENRIG_HOME/plugins/openrig-core` holds files that didn't
  ship, the Codex plugin still installs or upgrades, but OpenRig approves
  nothing itself: an existing approval stays as it was, and Codex's own hook
  review applies. On a restart without a version change, if a hook file or the
  plugin manifest there differs from what this version shipped, OpenRig doesn't
  install or upgrade its Codex plugin. On a version upgrade, OpenRig's managed
  refresh replaces an edited plugin file with the shipped one and keeps your
  edited copy under `$OPENRIG_HOME/backups/managed-refresh/`; after upgrading,
  inspect those backups and reapply any deliberate customization.
- **With `CODEX_HOME` set in a seat's environment,
  `rig seat restart --keep-conversation` can report that the resume was not
  proven and that nothing restarted, although the process actually restarted and
  resumed.** Inspect the seat's pane and native `/status` before retrying; a
  failed proof read is not proof that no restart occurred.
- **`rig provider switch` does not switch a seat's account in 0.7.1.** Its
  precheck can refuse an unknown target, and its execution path is not yet
  wired. The separate home-level Codex auth-switch/restart path is not this
  command.

### Credits

Thank you to everyone whose work is in this release: @Aschenbath, @bradvin,
@Nikhi00718, @AdamWhitehurst, @puniserv, @pdurlej, @klueless-io,
@shravansumanthanan, @taljeri, @Totopo27, @Vaishnavi220506, @okle100,
@dajiaohuang, @icey-zzz, @akushonkamen, @psbanka and @adampog, and to @lev-gpt,
@XVVH, @Kero-66, @pr0xc3nt4ur1, @VltrnOne, @BillyOutlast, @gogabrielordonez,
@geoff-dhango, @alexveli1, @aanestesia, @team-sudarshana, @oneandonlydean,
@t1m3fr33d0m, @smota and @z4cc, whose reports and ideas led to fixes here.

Thanks also to @george661, who reported
[#1710](https://github.com/mvschwarz/openrig/issues/1710) (partly addressed by
[#1721](https://github.com/mvschwarz/openrig/pull/1721)); @m3ac-AllbrittenJ, who
reported [#331](https://github.com/mvschwarz/openrig/issues/331) (partly
addressed by [#1801](https://github.com/mvschwarz/openrig/pull/1801)); @shintaii
and @gopinathrimc, who reported
[#27](https://github.com/mvschwarz/openrig/issues/27) (partly addressed by
[#1735](https://github.com/mvschwarz/openrig/pull/1735)); @kainne44 and
@bobbiejaxn, who reported [#81](https://github.com/mvschwarz/openrig/issues/81)
(partly addressed by [#1876](https://github.com/mvschwarz/openrig/pull/1876) and
[#1946](https://github.com/mvschwarz/openrig/pull/1946)); and @haichongfu and
@vadym-abstract-factory, who reported
[#14](https://github.com/mvschwarz/openrig/issues/14) (partly addressed by
[#1871](https://github.com/mvschwarz/openrig/pull/1871)).

## [0.7.0] - 2026-10-23

Published 2026-10-23 as `@openrig/cli@0.7.0`, built from the commit tagged
`v0.7.0` (`c99450f3`). This entry is its release notes.

0.7.0 makes a running team easier to live with. A person can set quiet hours
and modes ("asleep", "out of office") so routine questions wait until they're
back. Agents can pass a rig's name almost everywhere instead of looking up its
id. A machine that reboots brings its kernel back by itself, a rig with one
broken seat still restores the rest, and a busy daemon gets your request
instead of a refusal. Under the hood, the core got smaller and simpler, and a
long list of contributor fixes landed. The changes since 0.6.14:

### Before you upgrade

- Restart the daemon after installing (`npm install -g @openrig/cli@0.7.0`,
  then `rig daemon stop && rig daemon start`). Six database updates apply on
  its first start.
- If you pass accounts or API keys to new agents through tmux's global
  environment (`tmux set-environment -g …`), new agents no longer inherit it.
  Put the values in the seat's `env`, pass `rig up --env KEY=VALUE`, or keep the
  old behaviour with `rig config set terminal.inherit_tmux_environment true`.
  `rig setup` warns when it sees a custom tmux configuration. Running agents
  aren't affected.
- Startup replaces OpenRig's own plugin and skill files with 0.7.0's copies.
  It first copies each file it replaces under
  `$OPENRIG_HOME/backups/managed-refresh/` and logs where, whether or not you
  edited it: about 22 copies on the first start after upgrading from 0.6.14, so
  a copy doesn't mean you changed anything. If you did edit one, your change
  may stop working until you reapply it from the copy; the log line names the
  original file.
- If you write queue rows to another machine by its own id
  (`member@rig@<self-id>`), run `rig host doctor <alias>` once per host so the
  binding learns its address.
- If a script uses `rig provider moves`, change it: the command and its setting
  are gone (see "Behaviour that changed").

### What's new and fixed

Quiet hours and modes for the person:

- `rig gateway human quiet set <id> --daily HH:MM-HH:MM` (or `--until`) holds
  routine asks while the person is away and posts each one once when they're
  back. Escalations still go through
  ([#1584](https://github.com/mvschwarz/openrig/pull/1584),
  [#1606](https://github.com/mvschwarz/openrig/pull/1606),
  [#1649](https://github.com/mvschwarz/openrig/pull/1649),
  [#1720](https://github.com/mvschwarz/openrig/pull/1720)).
- `rig gateway human mode` saves and applies a person's modes, ends them on a
  schedule with `--until`, and reports what each one changed. Inside a mode's
  agreed "decision room", the agent that asked can record a delegated
  decision; permission prompts are never decided this way
  ([#1656](https://github.com/mvschwarz/openrig/pull/1656),
  [#1715](https://github.com/mvschwarz/openrig/pull/1715),
  [#1705](https://github.com/mvschwarz/openrig/pull/1705)).

Rig names everywhere:

- `archive`, `unarchive`, `release`, `shrink`, `expand`, `snapshot`, `export`,
  `restore --rig` and the matching MCP tools take a rig's name. A name two rigs
  share says so ([#1681](https://github.com/mvschwarz/openrig/pull/1681) and
  siblings, @Nikhi00718).

Restore and launch:

- After a reboot, the daemon restores a kernel whose seats are all detached
  ([#1081](https://github.com/mvschwarz/openrig/pull/1081), @haralez).
- A seat missing a startup file no longer blocks the whole rig's restore; the
  other seats come back
  ([#1696](https://github.com/mvschwarz/openrig/pull/1696)).
- Seats added to a running rig get its culture and startup files (rigs created
  on 0.7.0) ([#1632](https://github.com/mvschwarz/openrig/pull/1632)).
- `rig up --env` reaches every launch shape
  ([#1511](https://github.com/mvschwarz/openrig/pull/1511)).
- Before a new Claude agent's first startup message, OpenRig looks briefly (up
  to about five seconds) for Claude's input box, and keeps its checks on the
  submission. It doesn't guarantee delivery; see Known issues
  ([#1730](https://github.com/mvschwarz/openrig/pull/1730)).
- Codex seats that select `openrig-core` get its refocus and skills: OpenRig
  installs the plugin into Codex and, on a first install, trusts its own six
  hooks after checking their files, so a fresh Codex seat starts without
  Codex's hook review. The file check happens only when trust is granted: a
  later edit to the cached hook scripts keeps that trust, as with any hook
  trusted in Codex. The trust covers that Codex home, so your own Codex
  sessions there load the plugin too; its hooks do nothing outside an OpenRig
  seat. A plugin or hook you already disabled, or left untrusted, keeps your
  choice ([#1824](https://github.com/mvschwarz/openrig/pull/1824)).
- A new agent's first startup message says it's OpenRig's identity context, not
  a task, and a seat with nothing else to start with is asked to confirm its
  identity and wait for an assignment
  ([#1754](https://github.com/mvschwarz/openrig/pull/1754)).

Seeing what's happening:

- The TUI's agent table shows each seat's configured effort
  ([#1529](https://github.com/mvschwarz/openrig/pull/1529), @tianxingjian2406).
- `rig queue show --json` says why a wake didn't land
  ([#1555](https://github.com/mvschwarz/openrig/pull/1555), @1solomonwakhungu).
- A long-open TUI says when its build differs from the daemon's, and refreshes
  less often ([#1600](https://github.com/mvschwarz/openrig/pull/1600)).
- `rig ps --rig` and `--host --rig` report an unknown rig and filter correctly
  ([#1690](https://github.com/mvschwarz/openrig/pull/1690),
  [#1698](https://github.com/mvschwarz/openrig/pull/1698),
  [#1706](https://github.com/mvschwarz/openrig/pull/1706), @Nikhi00718).

Reliability:

- A busy daemon gets the real request; the CLI refuses only when it's confirmed
  down, and a timed-out write says its outcome is unknown
  ([#1650](https://github.com/mvschwarz/openrig/pull/1650)).
- `rig compact --cancel` stops a managed compaction that already sent
  `/compact`, with no daemon restart
  ([#1660](https://github.com/mvschwarz/openrig/pull/1660)).
- Watchdog deliveries are recorded as they happened, and repeated refusals at a
  prompt raise an alert
  ([#1713](https://github.com/mvschwarz/openrig/pull/1713)).
- Slack: a thread reply answers only a question posted before it, and a
  rejected message isn't re-posted
  ([#1568](https://github.com/mvschwarz/openrig/pull/1568),
  [#1703](https://github.com/mvschwarz/openrig/pull/1703), @Aschenbath).
- Team agents are asked for permission less often: 15 housekeeping commands no
  longer prompt ([#1665](https://github.com/mvschwarz/openrig/pull/1665)).

### Behaviour that changed

- New agents start from a clean environment, not tmux's global one (above)
  ([#1573](https://github.com/mvschwarz/openrig/pull/1573)).
- `rig provider moves` and `provider.subscription_moves` are removed; report a
  subscription move as a queue item instead. `rig slack verify` lost
  `--reason` and `--actor`
  ([#1672](https://github.com/mvschwarz/openrig/pull/1672),
  [#1674](https://github.com/mvschwarz/openrig/pull/1674)).
- A `done` close can't use `--closure-reason blocked_on`; use
  `rig queue block <id> --on <child>`
  ([#1704](https://github.com/mvschwarz/openrig/pull/1704), @Aschenbath).
- `rig setup` keeps 10,000 rows of tmux history, down from 50,000
  ([#1264](https://github.com/mvschwarz/openrig/pull/1264), @Quentin-M).
- `rig up --plan` waits as long as an apply. `rig seat restart`, and
  `policy permissions apply`, now ask for permission.
- Output shapes: `rig gateway human list` prints `availability`
  (`available|focus|away|off`); `rig attach` prints `Sender:`; a reused
  `deliveryId` no longer deduplicates a send.

### Known issues

- A new Claude agent's startup text can stay in its input box unsent. If a
  fresh Claude seat sits idle with text at its prompt, open its terminal and
  press Enter.
- The TUI's terminal button refuses inside a Herdr pane reached over SSH (also
  in 0.6.14). Start the TUI with
  `env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY rig tui`, or run
  `rig terminal open '<view>' --provider herdr`. A fix is on its way.
- Claude seats on a macOS native install can read as needing attention after a
  restore ([#86](https://github.com/mvschwarz/openrig/issues/86)). A fix is in
  progress and isn't in this release.
- A Slack channel-mapping change needs a daemon restart
  (`rig daemon stop && rig daemon start`). Don't use `rig slack disable` then
  `enable` for it: enabling marks any alerts waiting to post to Slack as
  already seen, so open exchanges miss them.
- Ubuntu 22.04's stock tmux 3.2a can crash its whole server when OpenRig checks
  a pane that has just closed, interrupting the other sessions on that server.
  Avoid tmux 3.2a for OpenRig; check your version with `tmux -V`. A replacement
  version has not been verified against this crash.

### Credits

Thank you to everyone whose work is in this release: @Nikhi00718, @Aschenbath,
@PROACTIVA-US, @jayhemnani9910, @rudycelekli, @markankamaransheogarat-sys,
@haralez, @tianxingjian2406, @1solomonwakhungu, @AdamWhitehurst, @Quentin-M,
@arxh80, @DeryFerd, @okle100, @zichen0116 and @13pgpg.

Tested on our own machines, and with first-time setups on Claude and on Codex,
before release. A first-time setup on a Mac wasn't completed.

## [0.6.14]

0.6.14 is the last planned release of the 0.6 line: a small set of stability
fixes on top of 0.6.13. A seat launched by an older OpenRig that refuses every
send for a missing tmux pane can now be repaired without losing its session, a
manual compaction keeps waiting while its preparation sits at an approval, `rig
ask --wake` refuses runtimes it can't wake, refocus finds notes without starting
the CLI once per ancestor, the docs open with a getting-started page for people,
an optional Mac check, off by default, can stop one account's `rig` commands
from reaching another account's daemon, and the inventory read behind `rig ps`
and TUI refreshes avoids a full event-log scan. It is built from the commit
tagged `v0.6.14`. The changes since 0.6.13:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). No migration runs. One setting is added,
  `transport.local_user_guard`, off by default, and `/healthz` gains an `euid`
  field ([#1566](https://github.com/mvschwarz/openrig/pull/1566)). From 0.6.12
  or earlier, 0.6.13's migration `117` runs first (and from 0.6.11 or earlier,
  0.6.12's twelve before it).
- Expect the bundled openrig-core plugin to go from 0.1.14 to 0.1.15, carrying
  refocus's own notes lookup
  ([#1563](https://github.com/mvschwarz/openrig/pull/1563)).
- Expect `rig ask --wake` to refuse a Pi, custom or unrecorded runtime before
  any wake starts. The CLI and the daemon both need 0.6.14 to catch every case
  ([#1561](https://github.com/mvschwarz/openrig/pull/1561)).
- Expect a manual `rig compact` to wait longer: its preparation has 180 seconds
  (was 120), and the request times out after 240 seconds (was 180)
  ([#1562](https://github.com/mvschwarz/openrig/pull/1562)).

### Highlights

- Repair a seat that refuses every send because an older OpenRig never
  recorded its tmux pane: `rig reconcile-session <seat> --repair-missing-pane
  --no-launch` fills only the missing pane and keeps the seat's session, resume
  token and history. It never adopts and records no event. It refuses, writing
  nothing, when the binding already has a pane, the session has more than one
  pane or window, the pane changes between its two looks, a seat operation is
  running, or typing protection is on; an older daemon refuses the request
  rather than adopting ([#1564](https://github.com/mvschwarz/openrig/pull/1564)).
- Keep a manual `rig compact` waiting when the seat's preparation stops at an
  ordinary approval. OpenRig never answers the approval; someone has to, inside
  the deadline ([#1562](https://github.com/mvschwarz/openrig/pull/1562)).
- Refuse `rig ask --wake` for a runtime it can't wake, instead of silently
  trying a Claude wake ([#1561](https://github.com/mvschwarz/openrig/pull/1561)).
- Resolve each ancestor's notes file inside refocus's trace instead of starting
  `rig scope resolve-notes` once per ancestor, which could use up the trace's
  time on a loaded machine
  ([#1563](https://github.com/mvschwarz/openrig/pull/1563)).
- Read fresh-launch fences through the existing node and type index in the
  fleet inventory read behind `rig ps` and each `rig tui` refresh. The query
  added in 0.6.13 scanned the whole event log, which on a long-lived install
  was slow whenever the database's pages weren't cached; it returns the same
  rows ([#1617](https://github.com/mvschwarz/openrig/pull/1617)).

### Off by default

- Add an optional Mac check, `transport.local_user_guard` (or
  `OPENRIG_TRANSPORT_LOCAL_USER_GUARD`), that makes the CLI refuse a local daemon
  another account runs when the daemon's `/healthz` report and two `ps` readings
  agree. Missing or disagreeing evidence, and an older daemon, keep today's
  behaviour; it isn't authentication. `/healthz` gains `euid` beside `pid`
  whether or not the check is on
  ([#1566](https://github.com/mvschwarz/openrig/pull/1566)).

### Guidance and docs

- Add a getting-started page for people, `docs/reference/quickstart.md`, with a
  glossary; make `getting-started.md` the setup reference for the agent doing
  the setup; lead the README's install section with the `rigs` skill; and show
  what OpenRig changes on your machine before you install
  ([#1565](https://github.com/mvschwarz/openrig/pull/1565)).
- Drop three finished items from the roadmap
  ([#1560](https://github.com/mvschwarz/openrig/pull/1560)).
- Name the missing-pane repair where people meet the problem. The send refusal
  "Managed pane identity unavailable or changed; no input written." now names
  `rig reconcile-session <seat> --repair-missing-pane --no-launch`. The
  compaction refusal for a protected seat with no recorded pane says both fixes
  refuse while typing protection is on, how to turn it off and back on with the
  person's agreement, and that plain reconcile adopts into a new session row.
  The as-built CLI reference and the `openrig-user` skill list
  `--repair-missing-pane`, `rig config --help` lists
  `transport.local_user_guard`, and `rig ask --help`'s exit codes cover the
  `--wake` refusals. Text and help only
  ([#1594](https://github.com/mvschwarz/openrig/pull/1594)).

### Dependency and install-script changes

- The README's skill and install-script commands, getting-started and the
  quickstart's example tag pin `v0.6.14`. No dependency changes.

### Known limitations

- The compaction and refocus fixes are tested without a native compaction or a
  loaded machine. Confirm a compaction by its restore request or the drop in
  context, and check that refocus showed the current work
  ([#1562](https://github.com/mvschwarz/openrig/pull/1562),
  [#1563](https://github.com/mvschwarz/openrig/pull/1563)).
- The pane repair refuses while typing protection is on; the send and
  compaction refusals say so, and protection goes off only if the person
  agrees. It covers a running launched seat whose pane was never recorded, and
  refuses others. A delivery held from before the repair can still refuse
  ([#1564](https://github.com/mvschwarz/openrig/pull/1564),
  [#1594](https://github.com/mvschwarz/openrig/pull/1594)).
- `rig context get reference/quickstart.md` doesn't resolve: the page ships
  under the package's `docs/reference/` but isn't in the reference context pack
  ([#1565](https://github.com/mvschwarz/openrig/pull/1565)).
- On a Mac with more than one user account, a second user's `rig` commands can
  reach the first user's daemon on its default port unless
  `transport.local_user_guard` is on. The check trusts the daemon's own report,
  identity can change between the check and the connection, and direct HTTP
  clients aren't covered ([#1566](https://github.com/mvschwarz/openrig/pull/1566)).
- 0.6.13's other limitations still apply.

## [0.6.13]

0.6.13 is the quick follow-up to 0.6.12: fixes found by running teams on it
every day, plus documentation. A Claude seat handed over in place waits for the
new Claude before its packet is typed, Slack recovers missed messages in mapped
channels, recent threads and relayed channels, Pi seats honour their reasoning
effort, an OMP seat can be retried after a provider hiccup, and an existing seat
can move to a new working folder. It is built from the commit tagged `v0.6.13`.
The changes since 0.6.12:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). Migration `117` runs on every upgrade: it adds an empty,
  Codex-only `provider_account_readings` table, which fills only with
  `provider.usage_windows` on (off by default) and then keeps each resolved
  Codex account's readings across a restart
  ([#1535](https://github.com/mvschwarz/openrig/pull/1535)). There is no
  migration `116`. From 0.6.11 or earlier, 0.6.12's twelve migrations run first.
- Expect the bundled openrig-core plugin to go from 0.1.13 to 0.1.14: generated
  Claude hook commands call the daemon's Node by its absolute path, and existing
  bare-`node` entries refresh automatically
  ([#1545](https://github.com/mvschwarz/openrig/pull/1545)).
- Expect a rig name containing a dot to be refused before anything launches,
  including when you add a member to an existing one or retry its first start,
  because tmux would rename the session
  ([#1500](https://github.com/mvschwarz/openrig/pull/1500)).
- Expect a Pi seat's `effort` to reach Pi as `--thinking` from its next managed
  launch, restore or handover
  ([#1528](https://github.com/mvschwarz/openrig/pull/1528)); managed Claude
  seats to receive `EDITOR`, `VISUAL`, `DISPLAY`, `XAUTHORITY` and an absolute
  `WAYLAND_DISPLAY` from their next launch
  ([#1546](https://github.com/mvschwarz/openrig/pull/1546)); and the shipped
  agent specs' role file to count as the seat's role after a fresh launch
  ([#1522](https://github.com/mvschwarz/openrig/pull/1522)).
- Expect `rig restore-check` to report caveats where it was green for hooks,
  still exiting 0 ([#1537](https://github.com/mvschwarz/openrig/pull/1537)), and
  Slack recovery to scan threads inside its seven-day window once from their
  root on the first start
  ([#1536](https://github.com/mvschwarz/openrig/pull/1536)).
- Expect new output, with nothing removed: a model line per seat after `rig ps
  --nodes`'s table ([#1493](https://github.com/mvschwarz/openrig/pull/1493)), an
  input-box note on `rig capture`'s stderr
  ([#1490](https://github.com/mvschwarz/openrig/pull/1490)), the
  `caller_cancelled` send refusal
  ([#1513](https://github.com/mvschwarz/openrig/pull/1513)), and JSON fields
  `modelObservation`, `inputBox`, `signIn`, the Codex restart report's gate
  fields and `/api/attention` update items
  ([#1508](https://github.com/mvschwarz/openrig/pull/1508),
  [#1502](https://github.com/mvschwarz/openrig/pull/1502),
  [#1054](https://github.com/mvschwarz/openrig/pull/1054)).

### Highlights

- Check a fresh in-place Claude handover's ready result against the current
  screen, so the packet waits for the successor instead of reaching a shell
  ([#1553](https://github.com/mvschwarz/openrig/pull/1553), part of
  [#1544](https://github.com/mvschwarz/openrig/issues/1544)).
- Recover Slack messages in the channel map's channels, replies in tracked
  threads whose root was posted or which closed in the last seven days, and
  channels a hub relays to a machine without its own connection; recovered
  replies land late and never answer a decision, and a rate limit holds its
  method across a restart
  ([#1536](https://github.com/mvschwarz/openrig/pull/1536),
  [#739](https://github.com/mvschwarz/openrig/issues/739)).
- Send a Pi seat's `effort` as `--thinking`, with `rig seat set-effort` and `rig
  seat effort` for Pi ([#1528](https://github.com/mvschwarz/openrig/pull/1528));
  let an OMP seat take an ordinary retry after a typed transient provider
  failure ([#1550](https://github.com/mvschwarz/openrig/pull/1550)).
- Add `rig seat set-cwd <seat> --cwd <absolute-path> --reason <text>` to save an
  existing seat's working folder for its next fresh launch or rebuild handover
  ([#1498](https://github.com/mvschwarz/openrig/pull/1498), finishing
  [#1154](https://github.com/mvschwarz/openrig/pull/1154)).
- Show the model each seat was last seen using in `rig ps --nodes`, `rig roster
  show` and `rig roster find`
  ([#1493](https://github.com/mvschwarz/openrig/pull/1493)).
- Type nothing later for a send whose caller went away before input started
  ([#1513](https://github.com/mvschwarz/openrig/pull/1513)); read Claude Code's
  MCP approval menu ([#1549](https://github.com/mvschwarz/openrig/pull/1549)),
  Codex's current folder-trust panel
  ([#1494](https://github.com/mvschwarz/openrig/pull/1494)) and a Codex pane's
  old menu above an empty composer
  ([#1548](https://github.com/mvschwarz/openrig/pull/1548)) correctly.
- Read Linux processes from `/proc` on a worker thread instead of forking `ps`
  ([#1385](https://github.com/mvschwarz/openrig/pull/1385)).

### Seats, launch and restore

- Prove a Claude launched through a wrapper script by its executable path
  ([#1540](https://github.com/mvschwarz/openrig/pull/1540)); clear a failed
  restore's warning after a ready fresh launch
  ([#1527](https://github.com/mvschwarz/openrig/pull/1527)); read a complete
  idle screen as idle through terminal repaints
  ([#1521](https://github.com/mvschwarz/openrig/pull/1521)).
- Name the Codex startup screen that stopped `rig seat restart
  --keep-conversation`
  ([#1502](https://github.com/mvschwarz/openrig/pull/1502)); print the Pi/OMP
  READY line once per ready transition
  ([#1401](https://github.com/mvschwarz/openrig/pull/1401)); and report a
  guidance block's real file in the node-detail API
  ([#1523](https://github.com/mvschwarz/openrig/pull/1523)).

### Sends, wakes and queue

- Send one message for a seat's parked rows that fall due in the same pass
  ([#1507](https://github.com/mvschwarz/openrig/pull/1507)); route a stuck-item
  finding on a person's item to the agent that closed it
  ([#1495](https://github.com/mvschwarz/openrig/pull/1495), finishing
  [#1177](https://github.com/mvschwarz/openrig/pull/1177)); and trim spaces in
  `rig queue list --state`
  ([#1501](https://github.com/mvschwarz/openrig/pull/1501)).

### Status, TUI and web UI

- Show a sign-in fact on each provider account row
  ([#1508](https://github.com/mvschwarz/openrig/pull/1508)); show open updates
  for a person in the TUI's Feed
  ([#1054](https://github.com/mvschwarz/openrig/pull/1054)); open a seat's
  terminal in the Herdr the shared TUI is viewed from, on Linux
  ([#1356](https://github.com/mvschwarz/openrig/pull/1356)); and show an aborted
  workflow as aborted in the web UI
  ([#1276](https://github.com/mvschwarz/openrig/pull/1276)).
- Keep a Codex account's last reading, its reset and its last observed
  exhaustion across a daemon restart, shown as history rather than a current
  reading, and show an expectation, never a reading, when a window's reset has
  passed ([#1535](https://github.com/mvschwarz/openrig/pull/1535)).

### Workflows, commands and messages

- Clear a redriven workflow's old completion time
  ([#1517](https://github.com/mvschwarz/openrig/pull/1517)); accept a rig name
  in `rig grow` and `rig remove`
  ([#1407](https://github.com/mvschwarz/openrig/pull/1407)); give working cmux
  remedies in `rig doctor`
  ([#1514](https://github.com/mvschwarz/openrig/pull/1514)) and real remedies
  for an edited projected file
  ([#1512](https://github.com/mvschwarz/openrig/pull/1512)); and print the
  daemon's message from `rig provider`
  ([#1510](https://github.com/mvschwarz/openrig/pull/1510)).

### Off by default

- Keep the refocus work packet off for both runtimes, and bound its fields when
  `OPENRIG_REFOCUS_WORK_PACKET=1` turns it on
  ([#1542](https://github.com/mvschwarz/openrig/pull/1542)).

### Guidance and docs

- Correct the README's machine effects
  ([#1510](https://github.com/mvschwarz/openrig/pull/1510)); say one working
  account is enough and list what starting OpenRig writes
  ([#1539](https://github.com/mvschwarz/openrig/pull/1539)); give a standard Mac
  user a user-local Node.js route and say what the registry's checks decide
  ([#1557](https://github.com/mvschwarz/openrig/pull/1557)); explain an adopted
  seat's restart refusal
  ([#1509](https://github.com/mvschwarz/openrig/pull/1509)) and comparing token
  use across machines ([#1505](https://github.com/mvschwarz/openrig/pull/1505));
  and list the community-built Rig HQ viewer
  ([#1515](https://github.com/mvschwarz/openrig/pull/1515)).

### Dependency and install-script changes

- End the one-line installer with `INSTALLED, SETUP NOT COMPLETE` when `rig
  setup` isn't ready, keeping setup's exit status
  ([#1547](https://github.com/mvschwarz/openrig/pull/1547)).

### Tests and repository checks

- Tie managed `/compact` and parked refocus to their hook effects in tests
  ([#1538](https://github.com/mvschwarz/openrig/pull/1538)); remove a test
  fixture's calendar expiry
  ([#1559](https://github.com/mvschwarz/openrig/pull/1559)); and carry 0.6.12's
  versions and release text onto development main
  ([#1558](https://github.com/mvschwarz/openrig/pull/1558)).

### Known limitations

- A fresh in-place Claude handover can still report ready early when the screen,
  pane or process can't be read or proven
  ([#1553](https://github.com/mvschwarz/openrig/pull/1553)).
- Slack recovery doesn't catch up older open threads, doesn't prune its thread
  coverage file yet, and one Slack app across machines hasn't run on two real
  machines ([#1536](https://github.com/mvschwarz/openrig/pull/1536),
  [#1436](https://github.com/mvschwarz/openrig/pull/1436)).
- Managed compaction's 600-character budget rests on one comparison, nothing
  confirms compaction ran, two hook runs for one seat aren't serialized, and the
  plugin's manifest hooks still call bare `node`
  ([#1483](https://github.com/mvschwarz/openrig/pull/1483),
  [#1344](https://github.com/mvschwarz/openrig/pull/1344),
  [#1475](https://github.com/mvschwarz/openrig/pull/1475),
  [#1545](https://github.com/mvschwarz/openrig/pull/1545)).
- `rig seat set-cwd` checks the new folder once, and background work can use it
  before you switch ([#1498](https://github.com/mvschwarz/openrig/pull/1498)).
- `rig policy current` and plain `rig ps` don't show a policy stored with
  `--seat` ([#1285](https://github.com/mvschwarz/openrig/pull/1285)); `rig up
  --env` isn't forwarded for flat-node specs or v1 bundles
  ([#1294](https://github.com/mvschwarz/openrig/pull/1294)); the draft-aware
  guard can delay other work for a seat
  ([#1481](https://github.com/mvschwarz/openrig/pull/1481)).
- On a Mac with more than one user account, a second user's `rig` commands can
  reach the first user's daemon on its default port; this release doesn't change
  that.
- Managed compaction, refocus after a compaction and snapshot restore behave as
  in 0.6.12, and 0.6.12's other carried limitations still apply
  ([#1483](https://github.com/mvschwarz/openrig/pull/1483)).

## [0.6.12]

0.6.12 is a fix release about recovery and everyday operation, most of it from
the community. Restore brings back what you left running and leaves down what
you stopped, a slow Claude start ends as needing attention instead of failed,
managed compaction sends a `/compact` short enough to run again, Claude seats
load the hooks OpenRig ships for them, and you can set one seat's reasoning
effort, give a team environment variables in its spec, change a seat's
permission policy in place, launch a rig by name and read what each seat
reports it costs. It is built from the commit tagged `v0.6.12`. The changes
since 0.6.11:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). Twelve migrations run on the first start, whatever you use:
  `100` typing guard modes
  ([#1481](https://github.com/mvschwarz/openrig/pull/1481)), `104`
  `nodes.effort_choice` ([#1209](https://github.com/mvschwarz/openrig/pull/1209)),
  `105` Claude cost columns on `usage_samples`
  ([#1233](https://github.com/mvschwarz/openrig/pull/1233)), `107` and `108` Pi
  usage tables ([#1237](https://github.com/mvschwarz/openrig/pull/1237),
  [#1244](https://github.com/mvschwarz/openrig/pull/1244)), `109` the mode
  store's index per category
  ([#1274](https://github.com/mvschwarz/openrig/pull/1274)), `110`
  `workflow_instances.scope_json`
  ([#1273](https://github.com/mvschwarz/openrig/pull/1273)), `111`
  `rigs.env_json` and `nodes.env_json`
  ([#1294](https://github.com/mvschwarz/openrig/pull/1294)), `112` two indexes
  for recent queue activity, about 10 to 12 MB on a long-running install
  ([#1326](https://github.com/mvschwarz/openrig/pull/1326)), `113`
  `applied_launch_observations.daemon_opt_out`
  ([#1371](https://github.com/mvschwarz/openrig/pull/1371)), `114`
  `sessions.agent_app` ([#1392](https://github.com/mvschwarz/openrig/pull/1392))
  and `115` the Slack thread map keyed by channel and thread timestamp
  ([#1436](https://github.com/mvschwarz/openrig/pull/1436)). There are no
  migrations `102` or `106`.
- Expect Claude seats whose plugins include `openrig-core` to run its hooks
  (activity relay, compaction save and restore, refocus) from their next
  launch, restore or handover: they start with `CLAUDE_CODE_PLUGIN_DIRS` set,
  which needs Claude Code 2.1.280 or later. openrig-core goes from 0.1.9 to
  0.1.13 ([#1344](https://github.com/mvschwarz/openrig/pull/1344)). The refocus
  hook may take up to 60 seconds instead of 5
  ([#1475](https://github.com/mvschwarz/openrig/pull/1475)).
- Expect `rig start --last` to leave down a rig you stopped on purpose with
  `rig down` or `rig seat stop`, and to print how to bring it back; `--json`
  carries `keptDown`
  ([#1238](https://github.com/mvschwarz/openrig/pull/1238)). After `rig down`,
  `rig ps` reads the rig `stopped`
  ([#1254](https://github.com/mvschwarz/openrig/pull/1254)) and the restore
  hint is `rig up '<name>' --existing`
  ([#1425](https://github.com/mvschwarz/openrig/pull/1425)).
- Expect an ordinary terminal seat to relaunch fresh on restore and re-run its
  startup actions; a missing required startup file for such a seat blocks the
  whole restore before anything launches
  ([#1328](https://github.com/mvschwarz/openrig/pull/1328)). Expect restore to
  stop a seat whose current runtime differs from its snapshot's, before
  launch ([#1190](https://github.com/mvschwarz/openrig/pull/1190)).
- Expect a restored Claude seat that's slow to draw its screen to be watched
  for up to `runtime.readiness_timeout_seconds` and then end
  `attention_required` with its pane and token kept, not `failed`, so a restore
  can take longer ([#1359](https://github.com/mvschwarz/openrig/pull/1359)).
  "Returned to a shell" now means the process tree shows an idle shell
  ([#1357](https://github.com/mvschwarz/openrig/pull/1357),
  [#1395](https://github.com/mvschwarz/openrig/pull/1395),
  [#1373](https://github.com/mvschwarz/openrig/pull/1373),
  [#1364](https://github.com/mvschwarz/openrig/pull/1364)), and a Pi or OMP
  seat at a bare shell reads `attention_required`
  ([#1391](https://github.com/mvschwarz/openrig/pull/1391)).
- Expect a send to a pane in tmux copy or view mode to leave the mode and
  deliver, or be refused with `pane_in_mode` (HTTP 409) with no text typed
  ([#912](https://github.com/mvschwarz/openrig/pull/912)). Expect `rig send
  --dangerously-interact` to type exactly the bytes and keys given, adding
  Enter only for a complete answer staged in a recognised Claude Code or
  Codex input box ([#1366](https://github.com/mvschwarz/openrig/pull/1366)).
- Expect managed `/compact` to be at most 600 characters and sent only to an
  idle seat, with a separate `compact` result (`submitted, unconfirmed`,
  `uncertain`, `not sent`) in `rig compact` and `--state`. `rig compact` exits
  1 (was 2) for `pane_unknown_protected`, and `rig send` exits 1 with HTTP 409
  (was 2 with 500) when a write throws without a code
  ([#1483](https://github.com/mvschwarz/openrig/pull/1483)).
- Expect exit 1 and HTTP 400, not exit 2 and 500, for eleven client-fixable
  `rig queue update` refusals
  ([#1319](https://github.com/mvschwarz/openrig/pull/1319)); exit 1 from `rig
  ask` for an unknown or ambiguous rig
  ([#1202](https://github.com/mvschwarz/openrig/pull/1202)); and up to 120
  seconds of waiting in `rig add`, single-seat `rig launch` and `rig launch
  --seats` ([#1287](https://github.com/mvschwarz/openrig/pull/1287),
  [#1271](https://github.com/mvschwarz/openrig/pull/1271)).
- Expect a runtime `--version` check to give up after 30 seconds: daemon start
  no longer hangs on it, `rig bootstrap` blocks on a runtime that fails or
  times out its check ([#1211](https://github.com/mvschwarz/openrig/pull/1211)),
  and `rig up`'s preflight fails a Claude, Codex or OMP check that doesn't
  answer (a warning for Pi)
  ([#1301](https://github.com/mvschwarz/openrig/pull/1301)).
- Expect `login_required` only for Claude's current login refusal, not for the
  "Not logged in" footer alone
  ([#1417](https://github.com/mvschwarz/openrig/pull/1417)); the `fable` alias
  to name `claude-fable-5-1`, with `[1m]` set aside when comparing
  ([#1482](https://github.com/mvschwarz/openrig/pull/1482)); and pinned Pi
  seats to be checked, accepting a `:high`-style thinking suffix
  ([#1349](https://github.com/mvschwarz/openrig/pull/1349),
  [#1403](https://github.com/mvschwarz/openrig/pull/1403)).
- Expect a custom permission policy saved with CRLF line endings to take
  effect at the next launch or restore instead of falling back to the floor
  ([#1402](https://github.com/mvschwarz/openrig/pull/1402)).
- Expect `rig bundle create` to refuse harness login files, and an existing
  archive holding one without a record to fail verify, unpack and install
  ([#1488](https://github.com/mvschwarz/openrig/pull/1488)).
- Expect `rig scope mission create` to write `status: planned`
  ([#1289](https://github.com/mvschwarz/openrig/pull/1289)), and `--workspace
  <project>` to create and read missions under the project's declared
  `missions.root` ([#1430](https://github.com/mvschwarz/openrig/pull/1430)).
- Expect the daemon to run tmux without `/bin/sh` on Linux and macOS
  (`OPENRIG_TMUX_SHELL=1` keeps the old path)
  ([#1241](https://github.com/mvschwarz/openrig/pull/1241)), and to write
  Codex's `config.toml` only when a Codex seat exists or launches
  ([#1297](https://github.com/mvschwarz/openrig/pull/1297)).
- Expect a person's new message in a rig's own mapped Slack channel to reach
  that rig's representative, and seat posts to name the machine
  ([#1436](https://github.com/mvschwarz/openrig/pull/1436)); the Slack manifest
  adds the `users:read` scope
  ([#1433](https://github.com/mvschwarz/openrig/pull/1433)).
- Expect `rig remove` and `rig shrink` to keep a seat that receives work while
  stopping (409, with the work listed) unless `--fallback` takes it
  ([#1459](https://github.com/mvschwarz/openrig/pull/1459)), and a stale `rig
  unclaim` to be refused with `session_not_current`
  ([#1379](https://github.com/mvschwarz/openrig/pull/1379)).
- Read `Typing guard: on (hold)` in `rig seat status` for hold; its JSON's
  `desired` and `effective` now mean hold only
  ([#1481](https://github.com/mvschwarz/openrig/pull/1481)).
- Read lower `rig usage top` figures where a seat changed conversation or a
  window reset ([#1348](https://github.com/mvschwarz/openrig/pull/1348),
  [#1473](https://github.com/mvschwarz/openrig/pull/1473)), and execution-view
  rows bound to a mission by their exact `mission:` tag
  ([#1304](https://github.com/mvschwarz/openrig/pull/1304)) or a slice by its
  SPEC `id:` ([#1331](https://github.com/mvschwarz/openrig/pull/1331)).

### Highlights

- Launch a rig by name: `rig launch <rig>` takes a name or an ID, and a name
  two active rigs share stops with `rig_ambiguous`
  ([#1312](https://github.com/mvschwarz/openrig/pull/1312)).
- Set one seat's reasoning effort with `rig seat set-effort <seat> --effort
  <level> --reason "<why>"` (or `--clear`), used at its next launch, restore,
  handover or in-place restart, and read it four ways with `rig seat effort`
  ([#1209](https://github.com/mvschwarz/openrig/pull/1209)).
- Change an existing seat's permission policy with `rig policy apply <policy>
  --seat <seat> --reason "<why>"`
  ([#1285](https://github.com/mvschwarz/openrig/pull/1285)).
- Give a team environment variables with `env:` on the rig and members in
  `rig.yaml`, or for one launch with `rig up <spec> --env KEY=VALUE`; the
  values aren't secret ([#1294](https://github.com/mvschwarz/openrig/pull/1294)).
- Keep a Codex fork's startup context when its new conversation ID arrives
  late, with `rig seat continue` to deliver it once
  ([#1438](https://github.com/mvschwarz/openrig/pull/1438)), and complete a
  handover to a Codex fork with the ID pending
  ([#1216](https://github.com/mvschwarz/openrig/pull/1216)).
- Correct a row's subject with `rig queue update <id> --summary` alone
  ([#1270](https://github.com/mvschwarz/openrig/pull/1270)), store an outcome
  with `--resolution` on a close
  ([#1292](https://github.com/mvschwarz/openrig/pull/1292)), and read how a row
  ended in `rig queue show <id> --full`'s `closingTransition`
  ([#1290](https://github.com/mvschwarz/openrig/pull/1290)).
- Hand work to the team from an agent with no shell through five queue tools
  on `rig mcp serve` ([#1441](https://github.com/mvschwarz/openrig/pull/1441)).
- Read what each seat reports it costs with `rig usage cost`, and the same on
  the TUI's System → Cost page; a missing figure is never $0
  ([#1233](https://github.com/mvschwarz/openrig/pull/1233),
  [#1261](https://github.com/mvschwarz/openrig/pull/1261)).
- Start the CLI faster: it loads only the command being run
  ([#1380](https://github.com/mvschwarz/openrig/pull/1380)). The daemon runs
  tmux without a shell, batches transcript captures, skips unchanged
  terminals and reads the queue with far fewer queries
  ([#1241](https://github.com/mvschwarz/openrig/pull/1241),
  [#1242](https://github.com/mvschwarz/openrig/pull/1242),
  [#1262](https://github.com/mvschwarz/openrig/pull/1262),
  [#1263](https://github.com/mvschwarz/openrig/pull/1263),
  [#1326](https://github.com/mvschwarz/openrig/pull/1326),
  [#1369](https://github.com/mvschwarz/openrig/pull/1369),
  [#1384](https://github.com/mvschwarz/openrig/pull/1384),
  [#1389](https://github.com/mvschwarz/openrig/pull/1389)).

### Seats, launch and restore

- Recover a seat whose startup failed for a recoverable reason on its next
  successful send or capture
  ([#1236](https://github.com/mvschwarz/openrig/pull/1236)); keep a periodic
  snapshot taken during `rig down` from replacing the pre-down one
  ([#1147](https://github.com/mvschwarz/openrig/pull/1147)); ignore a context
  reading taken before a seat changed when compacting
  ([#1365](https://github.com/mvschwarz/openrig/pull/1365)); and launch Claude
  sessions with `idleCompaction: false` while managed compaction is on
  ([#1282](https://github.com/mvschwarz/openrig/pull/1282)).
- Say which check a failed process-lineage check found
  ([#1398](https://github.com/mvschwarz/openrig/pull/1398)); retry a staged
  Claude startup prompt twice and recognise more footers
  ([#1295](https://github.com/mvschwarz/openrig/pull/1295)); pass
  `TERM_PROGRAM` to managed Claude seats so Shift+Enter inserts a newline
  ([#1399](https://github.com/mvschwarz/openrig/pull/1399)); and keep
  `--no-daemon` in the printed Codex resume command
  ([#1371](https://github.com/mvschwarz/openrig/pull/1371)).
- Log why a Codex resume token wasn't captured
  ([#1284](https://github.com/mvschwarz/openrig/pull/1284)); write
  `rig seat set-resume-token` to the latest session after a clock change
  ([#1204](https://github.com/mvschwarz/openrig/pull/1204)); and name the live
  older session in `rig seat clean`'s advice
  ([#1206](https://github.com/mvschwarz/openrig/pull/1206)).
- Leave a non-object `.claude/settings.local.json` or `.mcp.json` untouched
  with a warning ([#1311](https://github.com/mvschwarz/openrig/pull/1311)); stop
  rewriting a Claude seat's settings when its status line is in place
  ([#1286](https://github.com/mvschwarz/openrig/pull/1286)); replace a
  read-only collector copy by rename
  ([#1251](https://github.com/mvschwarz/openrig/pull/1251)); and remove the
  launch script with `/bin/rm` or the shell's `rm`
  ([#1310](https://github.com/mvschwarz/openrig/pull/1310)).
- Warn in `daemon.log` when an isolated `OPENRIG_HOME` still carries the real
  `HOME` or `CODEX_HOME` ([#1299](https://github.com/mvschwarz/openrig/pull/1299));
  find Codex sign-in files in the real home when `HOME` is unset
  ([#1418](https://github.com/mvschwarz/openrig/pull/1418)); and treat an empty
  `OPENRIG_HOME` as unset in the TUI socket, terminal token and `rig
  crash-cart` ([#1470](https://github.com/mvschwarz/openrig/pull/1470)).
- Catch up an OMP seat's history past 1 MiB over its RPC protocol v2
  ([#1279](https://github.com/mvschwarz/openrig/pull/1279)); show the first
  usable error field for a failed Pi or OMP turn
  ([#1208](https://github.com/mvschwarz/openrig/pull/1208)); resolve `rig
  bootstrap` and `rig requirements` spec paths from your folder
  ([#1213](https://github.com/mvschwarz/openrig/pull/1213)); add `detail` to a
  failed `rig create --json`
  ([#1378](https://github.com/mvschwarz/openrig/pull/1378)); and add `rig status
  --json` ([#1291](https://github.com/mvschwarz/openrig/pull/1291)).
- OpenRig 0.6.12 adds `rig community-harness list` for installed
  community-harness presets, showing their maintainer and declared limits.
  These harnesses are not tested by OpenRig. Support is launch-only: no resume
  or fork, no resource projection or startup-file delivery, and identity
  remains unconfirmed. A quiet screen is not proof that the seat is idle
  ([#1392](https://github.com/mvschwarz/openrig/pull/1392),
  [#1518](https://github.com/mvschwarz/openrig/pull/1518)).

### Sends, wakes and queue

- Recognise Codex's `»` prompt in input boxes
  ([#635](https://github.com/mvschwarz/openrig/pull/635)) and in `rig send
  --verify` ([#1220](https://github.com/mvschwarz/openrig/pull/1220)), and read
  a Codex seat as needing a person only when a real prompt shows
  ([#943](https://github.com/mvschwarz/openrig/pull/943)).
- Keep a held-back wake from using up a one-shot park timer
  ([#1222](https://github.com/mvschwarz/openrig/pull/1222)); stop a watchdog
  retired mid-check from delivering
  ([#1325](https://github.com/mvschwarz/openrig/pull/1325)) while recording its
  last attempt ([#1439](https://github.com/mvschwarz/openrig/pull/1439)); keep
  a blocker's next wake when it changes mid-send
  ([#1435](https://github.com/mvschwarz/openrig/pull/1435)); and mark a row
  served by its owner's own reminder `servedByOwnReminder`
  ([#1424](https://github.com/mvschwarz/openrig/pull/1424)).
- Point an unverifiable `handed_off_to` close at `rig queue handoff` and flag a
  self-targeted close ([#1358](https://github.com/mvschwarz/openrig/pull/1358));
  stamp a cross-host handoff's close with the sender's identity
  ([#1333](https://github.com/mvschwarz/openrig/pull/1333)); absorb an inbox
  entry in one transaction
  ([#1451](https://github.com/mvschwarz/openrig/pull/1451)); and say to register
  a person when none is
  ([#1219](https://github.com/mvschwarz/openrig/pull/1219)).
- Say `--summary` is a row's subject in help, warnings and skills
  ([#1354](https://github.com/mvschwarz/openrig/pull/1354)), add it to the reply
  hint ([#1355](https://github.com/mvschwarz/openrig/pull/1355)), and show a
  body's first line in the TUI's RECENT when a row has no summary
  ([#1393](https://github.com/mvschwarz/openrig/pull/1393)).

### Status, transcripts and TUI

- Say activity is unknown when `rig capture --lines` cut lines
  ([#1226](https://github.com/mvschwarz/openrig/pull/1226)); note when a `rig
  ps` context filter needs `--nodes`
  ([#1437](https://github.com/mvschwarz/openrig/pull/1437)); stop a stopped
  seat's transcript capture and keep its transcript readable
  ([#1281](https://github.com/mvschwarz/openrig/pull/1281)); report a quiet
  pane as `capture_unchanged`
  ([#1262](https://github.com/mvschwarz/openrig/pull/1262)); and keep the first
  line in `rig transcript --tail`
  ([#1227](https://github.com/mvschwarz/openrig/pull/1227)).
- Label the TUI's proof count `accepted` or `paired`
  ([#1288](https://github.com/mvschwarz/openrig/pull/1288)); keep TUI helpers
  working after the start folder is deleted
  ([#1485](https://github.com/mvschwarz/openrig/pull/1485)); send the window
  width with terminal previews
  ([#1205](https://github.com/mvschwarz/openrig/pull/1205)); find headings with
  combining marks ([#1471](https://github.com/mvschwarz/openrig/pull/1471));
  stop the Help list at its end
  ([#1469](https://github.com/mvschwarz/openrig/pull/1469)); ignore sideways
  swipes ([#1458](https://github.com/mvschwarz/openrig/pull/1458)); and keep
  emoji whole in TUI rows
  ([#1453](https://github.com/mvschwarz/openrig/pull/1453)) and web UI log
  previews ([#1454](https://github.com/mvschwarz/openrig/pull/1454)).
- Read an IPv6 HTTP host as reachable in `GET /api/hosts`
  ([#1457](https://github.com/mvschwarz/openrig/pull/1457)), and take
  `?replay=0|<n>|all` on `GET /api/events`
  ([#1387](https://github.com/mvschwarz/openrig/pull/1387)).

### Workflows, scope and proof

- Stamp `--project`, `--mission`, `--slice` and `--tags` on a workflow's
  packets ([#1273](https://github.com/mvschwarz/openrig/pull/1273)); resolve a
  `member@{rig}` target against the bound rig
  ([#1293](https://github.com/mvschwarz/openrig/pull/1293)); and pick up a
  workflow spec restored with an older modification time
  ([#1363](https://github.com/mvschwarz/openrig/pull/1363)).
- Show a slice parked on an `external:` gate as a waiting lane
  ([#1303](https://github.com/mvschwarz/openrig/pull/1303)); show a `merged:`
  report on the merged rung
  ([#1302](https://github.com/mvschwarz/openrig/pull/1302)); and resolve a
  dependency by a sibling's SPEC `id:`
  ([#1372](https://github.com/mvschwarz/openrig/pull/1372)).
- Read CRLF files like Unix ones in SPEC intents
  ([#1316](https://github.com/mvschwarz/openrig/pull/1316)), checkbox blocks
  ([#1315](https://github.com/mvschwarz/openrig/pull/1315)), `PROGRESS.md`
  ([#1314](https://github.com/mvschwarz/openrig/pull/1314)) and artifact-pool
  reads ([#1322](https://github.com/mvschwarz/openrig/pull/1322)); read folded
  evidence ([#1461](https://github.com/mvschwarz/openrig/pull/1461)) and `1)`
  mini-requirements ([#1460](https://github.com/mvschwarz/openrig/pull/1460))
  in the Scopes view; and refuse a scope-audit mission outside the slices root
  ([#1221](https://github.com/mvschwarz/openrig/pull/1221)).
- Keep a saved mode and a posture side by side, with `rig mode unset
  --category` ([#1274](https://github.com/mvschwarz/openrig/pull/1274)); read
  an unusable preview answer as unknown
  ([#1283](https://github.com/mvschwarz/openrig/pull/1283)); and mark the mode
  fields nothing acts on
  ([#1307](https://github.com/mvschwarz/openrig/pull/1307)).

### Usage, Slack and notifications

- Say when a `rig usage series`
  ([#1305](https://github.com/mvschwarz/openrig/pull/1305)) or `rig bundle
  history` ([#1306](https://github.com/mvschwarz/openrig/pull/1306)) bound
  isn't a date.
- Relay Slack channels across machines with `forwardChannels`
  ([#1436](https://github.com/mvschwarz/openrig/pull/1436)); deliver named bots
  to one seat with `botInbox`
  ([#1433](https://github.com/mvschwarz/openrig/pull/1433)); show a person the
  gate's question, not the agent packet
  ([#1143](https://github.com/mvschwarz/openrig/pull/1143)), even with long
  tags ([#1240](https://github.com/mvschwarz/openrig/pull/1240)); thread
  follow-ups to button answers and resolved reactions
  ([#1228](https://github.com/mvschwarz/openrig/pull/1228)); and say how to
  paste the manifest ([#1207](https://github.com/mvschwarz/openrig/pull/1207)).
- Deliver non-ASCII ntfy titles
  ([#1317](https://github.com/mvschwarz/openrig/pull/1317)), and keep emoji
  whole in shortened notification bodies, slice stories and `rig ask`
  excerpts ([#1472](https://github.com/mvschwarz/openrig/pull/1472)).

### Bundles, specs, packs and requests

- Keep a member's `mechanic` through bundling
  ([#1464](https://github.com/mvschwarz/openrig/pull/1464)); report a blank
  spec list item as a validation error
  ([#1318](https://github.com/mvschwarz/openrig/pull/1318)); read a bare agent
  profile key as empty ([#1320](https://github.com/mvschwarz/openrig/pull/1320));
  accept `..` inside a file name in context packs
  ([#1234](https://github.com/mvschwarz/openrig/pull/1234)) and agent images
  ([#1465](https://github.com/mvschwarz/openrig/pull/1465)); read an empty
  Compose `ps` as no services
  ([#1452](https://github.com/mvschwarz/openrig/pull/1452)); and report bytes
  from macOS's rsync in `rig file copy`
  ([#1232](https://github.com/mvschwarz/openrig/pull/1232)).
- Answer a `null` JSON body with 400
  ([#1342](https://github.com/mvschwarz/openrig/pull/1342)) and an oversized
  limit with 400 ([#1456](https://github.com/mvschwarz/openrig/pull/1456));
  match chat search literally
  ([#1455](https://github.com/mvschwarz/openrig/pull/1455)); fix `rig restore`'s
  hint ([#1466](https://github.com/mvschwarz/openrig/pull/1466)); warn about a
  misread watchdog cadence
  ([#1463](https://github.com/mvschwarz/openrig/pull/1463)); and forward `--full`
  in `rig whoami --host`
  ([#1231](https://github.com/mvschwarz/openrig/pull/1231)).

### Off by default

- `output.compact` now also shortens `rig queue show` and `rig queue
  transitions` (`rig queue transitions --full` is new)
  ([#1224](https://github.com/mvschwarz/openrig/pull/1224)) and bounds `rig
  whoami --json` peers to the new `output.whoami_peers` (default 8;
  `--all-peers` lists all) ([#1225](https://github.com/mvschwarz/openrig/pull/1225),
  [#1248](https://github.com/mvschwarz/openrig/pull/1248)).
- `provider.usage_windows` now also shows Claude's windows, with `--provider
  codex|claude` ([#1197](https://github.com/mvschwarz/openrig/pull/1197)), each
  seat's configured account
  ([#1235](https://github.com/mvschwarz/openrig/pull/1235)) and every
  registered machine's windows with `--all-hosts` or `--hosts`
  ([#1246](https://github.com/mvschwarz/openrig/pull/1246)); the TUI's System →
  Usage and Usage · all hosts pages read them
  ([#1243](https://github.com/mvschwarz/openrig/pull/1243),
  [#1259](https://github.com/mvschwarz/openrig/pull/1259)). A Claude account's
  current availability always reads `unknown`
  ([#1504](https://github.com/mvschwarz/openrig/pull/1504)).
- Add `usage.pi_cost_facts` and `usage.pi_openrouter_charge`: Pi's cost
  estimate and OpenRouter's charge beside it in `rig usage cost`, read at a Pi
  seat's launch or resume
  ([#1237](https://github.com/mvschwarz/openrig/pull/1237),
  [#1244](https://github.com/mvschwarz/openrig/pull/1244)).
- Add `provider.subscription_moves`: `rig provider moves`, `moves show` and
  `moves record` ([#1450](https://github.com/mvschwarz/openrig/pull/1450)).
- Add `bundle.services_enabled`: bundles carry their Compose file and install
  into a lasting target ([#1474](https://github.com/mvschwarz/openrig/pull/1474)).
- Add `transport.verify_input_box`: `--verify` to Claude Code or Codex reads
  verified only when the input box held the text and then emptied
  ([#1267](https://github.com/mvschwarz/openrig/pull/1267)).
- Add the per-seat draft-aware typing guard, `rig seat set-typing-guard <seat>
  --mode draft-aware` ([#1481](https://github.com/mvschwarz/openrig/pull/1481)),
  and `rig bundle create --include-login-files`
  ([#1488](https://github.com/mvschwarz/openrig/pull/1488)).
- Add `OPENRIG_TMUX_CONTROL=1` for one tmux control client
  ([#1383](https://github.com/mvschwarz/openrig/pull/1383)) and
  `OPENRIG_REFOCUS_BUDGET_MS` for a slow refocus
  ([#1475](https://github.com/mvschwarz/openrig/pull/1475)).

### Guidance and docs

- Offer to join the team before the first operator message
  ([#1492](https://github.com/mvschwarz/openrig/pull/1492),
  [#1496](https://github.com/mvschwarz/openrig/pull/1496)); offer Codex users
  one removable rules file
  ([#1467](https://github.com/mvschwarz/openrig/pull/1467)); re-check network
  checks and install through `rig setup`
  ([#1434](https://github.com/mvschwarz/openrig/pull/1434)); brief a peer by its
  model ([#1486](https://github.com/mvschwarz/openrig/pull/1486)); add an opt-in
  wake loop for attached apps
  ([#1444](https://github.com/mvschwarz/openrig/pull/1444)); explain `rig ask
  --wake` targets ([#1426](https://github.com/mvschwarz/openrig/pull/1426)); and
  point the operator at keeping-a-watch, which now teaches a low-allowance
  warning ([#1217](https://github.com/mvschwarz/openrig/pull/1217),
  [#1266](https://github.com/mvschwarz/openrig/pull/1266),
  [#1268](https://github.com/mvschwarz/openrig/pull/1268)).
- Document a newline when Shift+Enter submits
  ([#1404](https://github.com/mvschwarz/openrig/pull/1404)), Codex compaction
  sizing ([#1340](https://github.com/mvschwarz/openrig/pull/1340)), keeping your
  own Claude status line
  ([#1308](https://github.com/mvschwarz/openrig/pull/1308)), `HOME` for Pi
  ([#1335](https://github.com/mvschwarz/openrig/pull/1335)) and pinned per-agent
  `rigs` skill installs ([#1431](https://github.com/mvschwarz/openrig/pull/1431)).
  In the repository: the README's web UI line
  ([#1491](https://github.com/mvschwarz/openrig/pull/1491)) and contributor
  pointer ([#1370](https://github.com/mvschwarz/openrig/pull/1370)), the roadmap
  ([#1423](https://github.com/mvschwarz/openrig/pull/1423)), the skill workflow
  ([#1432](https://github.com/mvschwarz/openrig/pull/1432)) and the coordination
  notes ([#1277](https://github.com/mvschwarz/openrig/pull/1277)).
- User-visible text says "harness" for the agent software around a model, and
  "community harness" for one an outside contributor maintains;
  `docs/reference/topology-naming.md` defines the terms
  ([#1506](https://github.com/mvschwarz/openrig/pull/1506)).

### Dependency and install-script changes

- The daemon declares `string-width` `^8.3.0`, already in the installed tree
  ([#1481](https://github.com/mvschwarz/openrig/pull/1481)), and exports
  `./composer-prompts` ([#635](https://github.com/mvschwarz/openrig/pull/635))
  and `./workflow-scope` ([#1273](https://github.com/mvschwarz/openrig/pull/1273)).
  The same `postinstall` and `node >=22`.

### Tests and repository checks

- Run Linux checks on pushes to main
  ([#1487](https://github.com/mvschwarz/openrig/pull/1487)); regenerate shipped
  skills from one home ([#1396](https://github.com/mvschwarz/openrig/pull/1396));
  add a daemon-restart scenario
  ([#1440](https://github.com/mvschwarz/openrig/pull/1440)); look up the
  snapshot restore source only on a changed seat
  ([#1375](https://github.com/mvschwarz/openrig/pull/1375)); use stub runtimes
  ([#1298](https://github.com/mvschwarz/openrig/pull/1298)); clean up test
  folders ([#1300](https://github.com/mvschwarz/openrig/pull/1300),
  [#1352](https://github.com/mvschwarz/openrig/pull/1352),
  [#1362](https://github.com/mvschwarz/openrig/pull/1362),
  [#1330](https://github.com/mvschwarz/openrig/pull/1330)); wait on conditions
  in timing tests ([#1245](https://github.com/mvschwarz/openrig/pull/1245),
  [#1255](https://github.com/mvschwarz/openrig/pull/1255),
  [#1427](https://github.com/mvschwarz/openrig/pull/1427),
  [#1443](https://github.com/mvschwarz/openrig/pull/1443),
  [#1447](https://github.com/mvschwarz/openrig/pull/1447)); run the native
  transcript suite concurrently
  ([#1377](https://github.com/mvschwarz/openrig/pull/1377)); test cross-host
  usage ([#1265](https://github.com/mvschwarz/openrig/pull/1265)); and fix two
  repository scripts ([#1229](https://github.com/mvschwarz/openrig/pull/1229),
  [#1230](https://github.com/mvschwarz/openrig/pull/1230)).

### Known limitations

- Managed compaction's 600-character budget rests on one comparison on Claude
  Code 2.1.282, and nothing confirms compaction ran
  ([#1483](https://github.com/mvschwarz/openrig/pull/1483)). The plugin hooks
  haven't run through this path in a real session, and two hook runs for one
  seat aren't serialized
  ([#1344](https://github.com/mvschwarz/openrig/pull/1344),
  [#1475](https://github.com/mvschwarz/openrig/pull/1475)).
- One Slack app across machines was simulated in one process, not run on two
  machines ([#1436](https://github.com/mvschwarz/openrig/pull/1436)).
- `rig policy current` and plain `rig ps` don't show a policy stored with
  `--seat` ([#1285](https://github.com/mvschwarz/openrig/pull/1285)).
- The draft-aware guard can delay other work for a seat while it waits for
  idle ([#1481](https://github.com/mvschwarz/openrig/pull/1481)).
- `rig up --env` is not forwarded for flat-node specs or v1 bundles, although
  the launch may succeed. Do not rely on the flag for those formats in this
  release ([#1294](https://github.com/mvschwarz/openrig/pull/1294)).
- `rig seat restart --keep-conversation` supports Linux only. The rig status
  API can still fold a restore forecast into a running rig's status, and a
  constructed Codex usage-limit screen can linger, as in 0.6.11.

Thanks to everyone whose pull requests are in this release; they are listed in
the release notes, with how it was tested.

---

## [0.6.11]

0.6.11 is a fix release about recovery and wasted agent time, most of it from
the community. A send that waits for a seat to go idle no longer holds up every
other send to that seat, a parked seat isn't woken again for rows that haven't
changed, restore stops for a decision instead of starting a seat fresh when an
earlier conversation may still be resumable, a Codex seat at its usage limit
stays marked as limited while its screen redraws, and on Linux a Codex seat can
be restarted in place on the same conversation. It is built from the commit
tagged `v0.6.11`. The changes since 0.6.10:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). One migration runs on the first start: `103` adds one column
  to `sessions`, `intentionally_stopped`, which is 0 for every existing row
  ([#1192](https://github.com/mvschwarz/openrig/pull/1192)). There are no
  migrations `100` or `102`. openrig-core stays at 0.1.9; two of its files
  changed ([#1174](https://github.com/mvschwarz/openrig/pull/1174),
  [#1066](https://github.com/mvschwarz/openrig/pull/1066)).
- Expect a restore to stop a seat at `awaiting-decision` and start nothing when
  the seat wasn't running at the snapshot but an earlier session recorded a
  resume token, because the token doesn't prove that conversation can still
  resume. `rig up --existing` and `rig launch` no longer start it fresh, and
  `rig launch` of such a seat exits 1; the message names the command that
  starts it fresh on purpose
  ([#1141](https://github.com/mvschwarz/openrig/pull/1141)).
- Expect a restore of a rig whose seats are in pods to roll a seat back to
  `awaiting-decision` as unresumable only when Claude, Codex or Pi reports its
  conversation missing, starting nothing and leaving no new pane behind. A rig
  where every seat ends this way reads `partially_restored` instead of
  `failed`, with exit 1 either way. A Claude that exits to its shell for
  another reason is reported failed with its pane kept, as in 0.6.10. Restores
  of rigs without pods keep their earlier handling
  ([#1191](https://github.com/mvschwarz/openrig/pull/1191),
  [#1218](https://github.com/mvschwarz/openrig/pull/1218)).
- Read `outcome: "claimed"` from `rig queue create --verify` for a claimed row
  whose wake wasn't confirmed, instead of `indeterminate`
  ([#1168](https://github.com/mvschwarz/openrig/pull/1168)).
- Expect `rig send --wait-for-idle N` to wait before it takes the seat's
  delivery lease, so other sends and queue wakes to that seat aren't held
  behind it. N is now a deadline from the start of the wait, including any time
  spent waiting for the lease, and a timeout names the wait you asked for
  ([#1103](https://github.com/mvschwarz/openrig/pull/1103),
  [#1183](https://github.com/mvschwarz/openrig/pull/1183)).
- Expect `rig seat launch --fresh --stop` to refuse a seat with a still-live
  older session before it stops the current agent. `--plan` previews a fresh
  launch without changing anything and exits 0 even when it would be blocked;
  `--reason` is required only to execute
  ([#1156](https://github.com/mvschwarz/openrig/pull/1156)).
- Expect a seat stopped with `rig seat stop` to be left out of its rig's state,
  so the rig no longer reads `degraded` for it. `rig ps --nodes --json` carries
  `intentionallyStopped`, and a rig whose seats were all stopped this way reads
  `stopped` ([#1192](https://github.com/mvschwarz/openrig/pull/1192)).
- Read `rig queue whoami --work-candidates` as up to 50 held and 50 next rows,
  with `heldTruncated` and `nextTruncated`; `heldAndNextTruncated` now means
  either list was cut. With `OPENRIG_REFOCUS_WORK_PACKET` on (off by default,
  as in 0.6.10), the refocus work packet lists held and next work separately,
  up to 50 each ([#1066](https://github.com/mvschwarz/openrig/pull/1066)).

### Highlights

- Restart one Codex seat in place on Linux with `rig seat restart <seat>
  --keep-conversation --reason "<why>"`: the same pane and conversation, on
  whatever account its Codex home now holds. It doesn't switch accounts itself.
  It refuses with nothing stopped unless the seat is a Codex seat OpenRig
  launched, in a single pane, with a conversation it can prove and unchanged
  running settings. `--plan` runs every check and stops nothing, and `--verify
  --expect-account <account>` reports `moved` only when a tool turn has
  completed in the same conversation since the restart and Codex's status names
  that account. On macOS, a request that gets as
  far as reading the running process refuses before stopping the seat
  ([#1196](https://github.com/mvschwarz/openrig/pull/1196),
  [#1195](https://github.com/mvschwarz/openrig/pull/1195),
  [#1212](https://github.com/mvschwarz/openrig/pull/1212)).
- Stop waking a parked seat whose occupant is known again for the same rows
  after a wake was delivered, until it updates one of them or one changes
  state. A failed, refused or unrecorded wake still repeats at the next park,
  and a new occupant gets its first wake. Delivered means typed into the
  seat's terminal, not read ([#1142](https://github.com/mvschwarz/openrig/pull/1142)).
- Keep a Codex seat at its usage limit `unknown` with reason `usage_limit` while
  its screen redraws, instead of `running`, with `usage_limit` under REASON in
  `rig ps --nodes`. It clears when a readable screen shows no banner, or when
  Codex shows it's working again
  ([#1185](https://github.com/mvschwarz/openrig/pull/1185)).
- Report the Slack receipt beside the terminal wake from `rig queue create
  --verify` for a registered person who is also a seat with a pane, in a
  `gateway` object (`posted`, `transport-failed`, `never-posted` or
  `still-pending`); posted isn't read. It waits for that receipt up to the
  existing 30-second default, even when Slack isn't set up or the row won't be
  posted, and then reports the Slack side as pending.
  `GET /api/queue/:qitemId` returns `ownerNotificationLevel`
  ([#1085](https://github.com/mvschwarz/openrig/pull/1085)).
- Launch a forked Claude seat (`rig fork`, or `session_source: fork`) with its
  own session ID, so strict restore and clear-attention can verify it as its
  own conversation. Forking a Claude seat needs Claude Code 2.0.73 or later,
  which OpenRig doesn't check; forks launched before this read `mismatch` until
  they're relaunched ([#1144](https://github.com/mvschwarz/openrig/pull/1144)).

### Seats and restore

- Stop passing the launching Claude Code or Herdr session's identity variables,
  such as `CLAUDECODE`, to seats; if removing them fails, the launch goes ahead
  with a warning ([#1151](https://github.com/mvschwarz/openrig/pull/1151),
  finishing [#771](https://github.com/mvschwarz/openrig/pull/771)).
- Warn on stderr when `rig up` chose `/` as the launch folder itself
  ([#1150](https://github.com/mvschwarz/openrig/pull/1150), from
  [#226](https://github.com/mvschwarz/openrig/pull/226)).
- Expand a member `cwd` that is `~`, starts with `~/` or uses `$VAR` or
  `${VAR}`, from the daemon's environment, when the path as written doesn't
  exist
  ([#1153](https://github.com/mvschwarz/openrig/pull/1153)).
- Keep a late readiness result from overwriting a newer launch attempt
  ([#1188](https://github.com/mvschwarz/openrig/pull/1188)).
- Show a Codex seat's `runtimeContext.threadId` in `rig whoami --full --json`
  when its stored conversation ID was verified resumable
  ([#911](https://github.com/mvschwarz/openrig/pull/911)).

### Sends and queue

- Confirm enveloped multi-line messages that the agent's screen indents in
  `rig send --verify` and in queue wakes
  ([#1145](https://github.com/mvschwarz/openrig/pull/1145)).
- Read a Claude footer in auto, bypass or plan mode on the last line as idle
  when no activity hook is reporting
  ([#1179](https://github.com/mvschwarz/openrig/pull/1179)).
- Show the provider's own reason for a failed Pi or OMP turn when it gives one
  ([#1181](https://github.com/mvschwarz/openrig/pull/1181)).
- Give a `handed-off` closure with no visible successor the same custody
  advisory and stuck-sweep finding as a `done` closure
  ([#1189](https://github.com/mvschwarz/openrig/pull/1189)).

### Status and TUI

- Take a rig's running count and status in `rig ps` from the same set of
  sessions as `rig ps --nodes`
  ([#1186](https://github.com/mvschwarz/openrig/pull/1186)).
- Say in the TUI when a queue sample hit its cap or failed to load: counts read
  `N+`, a seat missing from the sample shows `?`, and Pulse no longer lists a
  NEEDS YOU item a second time. The caps count the whole host
  ([#1175](https://github.com/mvschwarz/openrig/pull/1175)).
- Fill the TUI Topology table's Q, WORK and NOW columns again on drilled views
  and on a seat's page ([#1173](https://github.com/mvschwarz/openrig/pull/1173)).

### Slack and ports

- Recover a reply sent with "Also send to channel" in the default channel after
  a connection gap ([#1187](https://github.com/mvschwarz/openrig/pull/1187)).
- Refuse a `daemon.port` outside 0–65535 in `rig config set`, and fall back to
  the file or default with a warning when the environment or `config.json`
  holds one ([#1140](https://github.com/mvschwarz/openrig/pull/1140)); refuse
  one in `rig daemon start --port`, with exit 1
  ([#1201](https://github.com/mvschwarz/openrig/pull/1201)).

### Scope, proof and refused requests

- Give parallel `rig scope slice create` calls different slice numbers. A
  number is never reused, and each create leaves a hidden `slices/.nn-NN` claim
  file ([#1007](https://github.com/mvschwarz/openrig/pull/1007)).
- Take `--project <id>` or a `<project>:` scope prefix in `rig proof show` and
  `rig proof judge`; scope readiness for a project selected in the TUI uses
  that project's own root
  ([#1149](https://github.com/mvschwarz/openrig/pull/1149), finishing
  [#136](https://github.com/mvschwarz/openrig/pull/136)).
- Return 400 before storing anything from the chat send and topic routes for
  payloads that used to fail with 500
  ([#1122](https://github.com/mvschwarz/openrig/pull/1122)); answer a
  fractional or non-numeric generation in `/api/wake-resolve` with the usual
  "does not exist" reply ([#1129](https://github.com/mvschwarz/openrig/pull/1129));
  refuse a watchdog `scan_interval_seconds` that can't be turned into a number,
  such as non-numeric text, a boolean or an empty array
  ([#1131](https://github.com/mvschwarz/openrig/pull/1131)); and match unmanaged
  agent process names exactly, plus `claude.exe` and names cut to 15 or 16
  characters ([#1133](https://github.com/mvschwarz/openrig/pull/1133)).

### Off by default

- Add `output.compact` (or `OPENRIG_OUTPUT_COMPACT`): the seven queue write
  commands print a short receipt instead of the whole row, and `--full` prints
  the whole row. While it's off, their output is unchanged
  ([#1137](https://github.com/mvschwarz/openrig/pull/1137)).
- Add `provider.usage_windows` (or `OPENRIG_PROVIDER_USAGE_WINDOWS` in the
  daemon's environment): `rig provider status --refresh` reads a Codex login's
  usage windows once. While it's off, `--refresh` says how to turn it on and
  exits 1 ([#1194](https://github.com/mvschwarz/openrig/pull/1194)).

### Guidance and docs

- Split the `rigs` and `openrig-skills` skill descriptions by who is asking: a
  person in their own session, or an agent inside a rig
  ([#1174](https://github.com/mvschwarz/openrig/pull/1174)).
- Add a reference page on keeping a watch for a person with today's queue
  commands ([#1064](https://github.com/mvschwarz/openrig/pull/1064)); see Known
  limitations.

### Dependency and install-script changes

- No npm dependency or lockfile change beyond OpenRig's own version, the same
  `postinstall`, and the same `node >=22`.

### Tests and repository checks

- Fix daemon and CLI tests that failed on some Linux machines: ext4 inode
  reuse, dash as `/bin/sh` and a 002 checkout umask
  ([#1148](https://github.com/mvschwarz/openrig/pull/1148), finishing
  [#83](https://github.com/mvschwarz/openrig/pull/83)); clean up after the
  pane-isolation tests ([#1169](https://github.com/mvschwarz/openrig/pull/1169));
  keep the TUI default socket-path test from failing on macOS
  ([#1182](https://github.com/mvschwarz/openrig/pull/1182)); and run the
  portability report when it's started through a symlinked path
  ([#1109](https://github.com/mvschwarz/openrig/pull/1109)).

### Known limitations

- `rig seat restart --keep-conversation` supports Linux only. Its automated
  tests are hermetic: they don't restart a real Codex seat.
- The rig status API (`GET /api/rigs/:id/status`) can call a running rig
  `blocked` because of one seat that isn't running: it folds a restore forecast
  (that seat would stop for a decision) into current status. No seat is halted,
  and `rig status` and the TUI's rig list don't show it for a running rig
  ([#1141](https://github.com/mvschwarz/openrig/pull/1141)).
- A Codex seat can keep reading as at its usage limit when an old banner is
  followed by a submitted prompt and the agent's reply, with no Codex working
  line and no input line below; it's recorded again every five minutes. The
  case was constructed from the source and hasn't been seen in a real session
  ([#1185](https://github.com/mvschwarz/openrig/pull/1185)).
- The keeping-a-watch page says a timer fires once. When the typing guard holds
  a one-shot `--wake-after` wake back (it shows as `retained`), that held-back
  attempt is recorded as the timer's one fire and later wakes aren't, so the
  timer isn't retired: it can wake the owner again at each interval while the
  row stays set aside. A row sharing the timer through `--wake-watchdog`, after
  the original row was handed off or stopped, loses its one wake if that wake
  is held back.

Thanks to everyone whose pull requests are in this release; they are listed in
the release notes, with how it was tested.

## [0.6.10]

0.6.10 is a fix release, most of it from the community. Setup can be told
which agent harnesses a person uses, a resumed Claude seat whose session ID
changed proves and restores, sends reach Codex seats behind a launcher and
Claude seats showing a suggested prompt, restore puts back the guidance `rig
down` removed, and attach commands name the tmux server the daemon actually
uses. It is built from the commit tagged `v0.6.10`. The changes since 0.6.9:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). Two migrations run on the first start. `099` adds one partial
  index to the queue table (`idx_queue_items_recovery_tags`)
  ([#1073](https://github.com/mvschwarz/openrig/pull/1073)). `101` adds four
  empty columns to `sessions` for a resumed Claude conversation's new ID
  ([#1080](https://github.com/mvschwarz/openrig/pull/1080)). Neither changes
  existing data, and there is no migration `100`. openrig-core goes from 0.1.8
  to 0.1.9 ([#1080](https://github.com/mvschwarz/openrig/pull/1080)).
- Read `rig capture --lines N` as the last N lines, with stderr saying how
  many earlier lines were cut. In `--json`, `lines` is then the count returned,
  with new `requestedLines` and `omittedLines`. `--history-plus-pane` keeps the
  old N history lines plus the whole pane, and the old JSON without those two
  fields; without `--lines` nothing changes
  ([#1136](https://github.com/mvschwarz/openrig/pull/1136)).
- Expect compact `rig queue list`, `overdue` and `undelivered` rows to carry
  `summary`, and to leave out `body`, `evidenceRef`, `humanDetail`, `waiting`,
  `chainOfRecord`, `replyTo`, `humanQuestions` and `humanAnswers` entirely,
  instead of `null` or `""`. `fieldsElided` names them
  ([#1096](https://github.com/mvschwarz/openrig/pull/1096)).
- Expect `rig launch <rigId> <seat>` (or `--seats`) on a seat whose agent
  exited to a shell in its kept pane to return `attention_required` and exit
  1, naming the ways back, instead of reporting it already running
  ([#1070](https://github.com/mvschwarz/openrig/pull/1070)).
- Expect `rig up <rig> --existing` to report the rig `partially_restored` and
  exit 1 when a seat is still missing part of its OpenRig guidance; the node
  lists `guidanceGaps` ([#1068](https://github.com/mvschwarz/openrig/pull/1068)).
- Read `lastNudgeResult` as `claimed` on a claimed row whose wake wasn't
  confirmed; the recorded value is in the new `lastNudgeWireResult`
  ([#1094](https://github.com/mvschwarz/openrig/pull/1094)).
- Expect `rig chatroom history` without `--after` or `--since` to return the
  newest messages, still listed oldest first; `--after` and `--since` still
  page forward ([#1057](https://github.com/mvschwarz/openrig/pull/1057)).

### Highlights

- Choose the harnesses at setup with `rig setup --providers claude`, `codex`,
  `both` or a comma list. One not chosen isn't installed or checked and reads
  `skipped`, never failed. The first hour also stops echoing tmux's
  "error connecting to …" at daemon start, and the next steps say the remaining
  steps are part of the install ([#1065](https://github.com/mvschwarz/openrig/pull/1065)).
- Prove a resumed Claude seat whose conversation continued under a new
  session ID, when its first SessionStart hook from the launched process
  reports `source: "resume"`. It restores as `resumed` and sends without the
  "launch identity differs" warning. Resume commands now carry
  `OPENRIG_RESUME_LAUNCH`, and the plugin must be 0.1.9
  ([#1080](https://github.com/mvschwarz/openrig/pull/1080)).
- Deliver `rig send` and queue wakes to a Codex seat whose `codex` is a
  launcher that starts Codex as a child; the deepest `codex` on one process
  chain counts as the seat ([#1088](https://github.com/mvschwarz/openrig/pull/1088)).
- Treat Claude's faint suggested prompt in an empty input box as empty, not
  as a person's draft, so a send to that idle seat isn't refused as
  `prompt_draft`. Typed text is still refused
  ([#1139](https://github.com/mvschwarz/openrig/pull/1139)).
- Put back the OpenRig guidance blocks `rig down` removed from `CLAUDE.md`,
  `CLAUDE.local.md` or `AGENTS.md` before a resumed seat starts, without
  touching the person's own text ([#1068](https://github.com/mvschwarz/openrig/pull/1068)).
- Name the daemon's tmux server in every printed attach command (`-L <name>`
  or `-S <path>`) when it runs on a non-default socket; the default server's
  commands are unchanged ([#1083](https://github.com/mvschwarz/openrig/pull/1083)).
- Report a seat's wake result and any claim from `rig queue create --verify`
  as soon as one is recorded, as `outcome`, `wakeResult` and `claim`, instead
  of `still-pending` after 30 seconds
  ([#1029](https://github.com/mvschwarz/openrig/pull/1029)).
- Start the daemon for the first time after a timed-out health probe when the
  port is free, as on WSL2; refuse only when the port is really held, naming
  `--port` ([#1061](https://github.com/mvschwarz/openrig/pull/1061)).

### Seats and restore

- Show a seat whose tmux session is confirmed gone as `detached`, with
  activity reason `session_missing`, and say in `rig ps --nodes` and `rig seat
  status` to restore or relaunch it; the stored status isn't rewritten
  ([#1074](https://github.com/mvschwarz/openrig/pull/1074)).
- Read a Codex usage-limit banner as activity `unknown` with reason
  `usage_limit` instead of idle; `rig provider signals` can show a
  provider-event signal for that seat's account that allows a switch decision
  ([#973](https://github.com/mvschwarz/openrig/pull/973)).
- Accept a rig name in `rig add`, as `rig down` does; a name shared by two
  active rigs is refused with `rig_ambiguous` and the candidates
  ([#1027](https://github.com/mvschwarz/openrig/pull/1027)).
- Say why `rig start` skipped an existing kernel and how to bring it back
  (`rig up kernel --existing`) ([#1060](https://github.com/mvschwarz/openrig/pull/1060)).
- Refuse a restore's proof from a launcher that isn't Claude when the Claude
  it starts names a different conversation; such a seat reads `attention_required`
  instead of a false resume ([#1091](https://github.com/mvschwarz/openrig/pull/1091)).
- Keep a Codex seat's last context reading when the newest usage record holds
  only quota numbers ([#1124](https://github.com/mvschwarz/openrig/pull/1124)).
- Keep git metadata paths that end in a space or tab in a fresh Codex launch's
  `--add-dir` ([#1134](https://github.com/mvschwarz/openrig/pull/1134)).

### Sends and queue

- Stop the queue's recovery and stuck-sweep lookups scanning every row
  ([#1073](https://github.com/mvschwarz/openrig/pull/1073)).
- Match `rig view show <lens> --rig <name>` as a literal session suffix, so
  `_` and `%` in a rig name are no longer wildcards, in all seven lenses
  that filter by rig
  ([#1126](https://github.com/mvschwarz/openrig/pull/1126),
  [#1165](https://github.com/mvschwarz/openrig/pull/1165)).
- Match `rig ask` chat keywords such as `config.json` or `C++` literally
  ([#1127](https://github.com/mvschwarz/openrig/pull/1127)).
- Read CRLF queue files in `rig heartbeat`
  ([#1120](https://github.com/mvschwarz/openrig/pull/1120)), and pick its
  latest proof with a timestamp that names no zone read as UTC
  ([#1121](https://github.com/mvschwarz/openrig/pull/1121)).

### Slack

- Reply once in the thread when a decision click isn't recorded, saying why
  and, where it helps, to answer in words. A recorded click still gets its
  usual reply. Best effort; it needs the Slack bot token
  ([#1067](https://github.com/mvschwarz/openrig/pull/1067)).

### Terminal and attach

- Open a terminal view in cmux when a caller of the daemon's terminal API
  names no provider and Herdr isn't available, and say so. `rig terminal open`
  without `--provider`, and the TUI's "Open terminals", still open Herdr, or
  plain tmux when Herdr is missing, never cmux; the TUI's preview now asks for
  the same provider as the window it opens
  ([#1071](https://github.com/mvschwarz/openrig/pull/1071), [#1167](https://github.com/mvschwarz/openrig/pull/1167)).
- Recognise a tmux started inside a Herdr pane by Herdr's own markers, so
  `rig terminal open --window` opens in the current Herdr
  ([#1130](https://github.com/mvschwarz/openrig/pull/1130)).

### CLI output

- Return 400, not 500, for a `?limit=` that isn't a number
  ([#586](https://github.com/mvschwarz/openrig/pull/586)).
- Print the daemon's error as JSON from `rig usage top --json` and `rig usage
  series --json` ([#1075](https://github.com/mvschwarz/openrig/pull/1075)), and
  have `rig usage top` read every sample in its window
  ([#1116](https://github.com/mvschwarz/openrig/pull/1116)).
- Show the instance and packet the daemon returns in `rig workflow
  instantiate` and `rig workflow project`
  ([#1102](https://github.com/mvschwarz/openrig/pull/1102)).
- Keep a line ending in `%`, and drop a repeated prompt, in `rig transcript
  --tail` ([#1104](https://github.com/mvschwarz/openrig/pull/1104)).
- Ignore `--json` after `--` when printing an error
  ([#1106](https://github.com/mvschwarz/openrig/pull/1106)), and print the
  daemon's error from `rig env` instead of a JavaScript one
  ([#1115](https://github.com/mvschwarz/openrig/pull/1115)).
- End a truncated file read at a whole UTF-8 character, with
  `truncatedAtBytes` saying where ([#1119](https://github.com/mvschwarz/openrig/pull/1119)).

### TUI

- Count CR+LF as one Enter ([#1111](https://github.com/mvschwarz/openrig/pull/1111)),
  keep an emoji whole at a wrap ([#1112](https://github.com/mvschwarz/openrig/pull/1112)),
  page directory listings in Local reading by 10 with PageUp and PageDown
  ([#1113](https://github.com/mvschwarz/openrig/pull/1113)), and skip fenced
  examples when opening a file at a heading
  ([#1114](https://github.com/mvschwarz/openrig/pull/1114)).

### Scope and progress

- Add a progress row only under a matching `##` heading
  ([#1107](https://github.com/mvschwarz/openrig/pull/1107)), and update
  frontmatter only inside its exact `---` delimiters
  ([#1110](https://github.com/mvschwarz/openrig/pull/1110)).
- Report a capability delta expired only when its successor is a readable
  file ([#1123](https://github.com/mvschwarz/openrig/pull/1123)).
- Ignore headings and checkboxes inside fenced examples in a slice's detail
  panes ([#1125](https://github.com/mvschwarz/openrig/pull/1125)) and in the
  progress tree ([#1128](https://github.com/mvschwarz/openrig/pull/1128)).

### Guidance

- Keep a team's own first steps and checks from stopping for approval: plain
  `rig` commands, the file tool instead of a heredoc, and the project's test
  command first ([#1082](https://github.com/mvschwarz/openrig/pull/1082)).
- Have the operator say what launching a team into the person's folder
  changes for their own agent there, before they agree
  ([#1086](https://github.com/mvschwarz/openrig/pull/1086)), and tell the person
  which seat is waiting on a prompt and what it asks
  ([#1087](https://github.com/mvschwarz/openrig/pull/1087)).
- Look for a managed guidance block's closing marker only after its opening
  one in `rig package install`
  ([#1135](https://github.com/mvschwarz/openrig/pull/1135)).

### Off by default

- Add `queue.wake_human_rung`: `explicit-only` keeps the wake ladder's last
  escalation off the person's Slack unless the row is addressed to a person;
  the default, `always`, changes nothing
  ([#1090](https://github.com/mvschwarz/openrig/pull/1090)).

### Dependency and install-script changes

- No npm dependency or lockfile change beyond OpenRig's own version, the same
  `postinstall`, and the same `node >=22`.

### Tests and repository checks

- Add a scenario for the `rig up` round trip
  ([#1092](https://github.com/mvschwarz/openrig/pull/1092)); keep the docs guard
  exact on unusual file names ([#1105](https://github.com/mvschwarz/openrig/pull/1105))
  and the portability report on header-shaped added text
  ([#1108](https://github.com/mvschwarz/openrig/pull/1108)); list same-second
  bootstrap runs newest first in `GET /api/bootstrap`
  ([#1132](https://github.com/mvschwarz/openrig/pull/1132)).

## [0.6.9]

0.6.9 is a quick fix release for what people meet in their first hour and in
the Slack channel: a Slack connection that stops delivering is caught and
replaced, a typed Slack answer is kept, Slack status shows what waits to be
retried, a kernel that recovered reads ready, and a cross-host send or a long
chatroom wait no longer reports failure when the work went through. It is
built from the commit tagged `v0.6.9`. The changes since 0.6.8:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). Migration `098` adds an index on `(qitem_id, transition_id)`
  to the queue's transition history, and openrig-core stays at 0.1.8.
- Stamp the work tree named by `rig scope <tier> approve --workspace <path>`,
  and refuse a named workspace with no `missions/` folder instead of stamping
  the configured one ([#997](https://github.com/mvschwarz/openrig/pull/997)).
- Give a cross-host `rig send --host` to an http-registered host a 30-second
  request budget, plus any `--wait-for-idle` time, and report a send that may have arrived as
  `remote-outcome-unknown` ("Delivery UNCONFIRMED", exit 1) with the check to
  run before any resend; only a host never reached reads as unreachable
  ([#1048](https://github.com/mvschwarz/openrig/pull/1048)).

### Highlights

- Keep a typed Slack reply to a decision with structured questions in
  `humanAnswers`, as a tagged typed reply placed under the first unanswered
  question; typed text that matches an option's ID is never read as a click,
  and closing still isn't approval ([#1045](https://github.com/mvschwarz/openrig/pull/1045)).
- Show in `rig slack status` how many retained inbound retry records wait,
  covering messages, reactions and click answers, or that the count is unknown
  and why ([#1036](https://github.com/mvschwarz/openrig/pull/1036)).
- Drop a retained Slack alert, replayed at gateway start, whose row has left
  the active states, and record why on the row; open rows' alerts,
  decision-resolved notices and digests still post ([#1051](https://github.com/mvschwarz/openrig/pull/1051)).
- Detect a Slack Socket Mode connection that stays open while events stop,
  by server pings and by the echo of OpenRig's own posts, and replace it,
  opening the new connection first and at most once every 5 minutes. Name the
  delivery state beside "connected" in `rig slack status` and the connections
  view ([#1052](https://github.com/mvschwarz/openrig/pull/1052)).
- Report a kernel ready once every declared seat recovered from a failed start,
  with the earlier failure on its own line in `rig status` and as
  `last_boot_failure` from `/api/kernel/status`; list each kernel seat once
  ([#1044](https://github.com/mvschwarz/openrig/pull/1044)).
- Keep a long `rig chatroom wait` going through a slow or restarting daemon
  until its `--timeout` ([#1047](https://github.com/mvschwarz/openrig/pull/1047)).

### Dependency and install-script changes

- No npm dependency or lockfile change beyond OpenRig's own version, the same
  `postinstall`, and the same `node >=22`.

### Seats

- Recognise a Nix-wrapped Claude Code as the seat runtime, so its seats read
  `running` ([#1053](https://github.com/mvschwarz/openrig/pull/1053)).

### Off by default

- Add the refocus work packet, off by default; no change unless enabled
  ([#1043](https://github.com/mvschwarz/openrig/pull/1043)).

### Docs

- Say that `rig launch` takes a rig ID, from `rig ps --json`, in the capability
  map and the what-changed note.

## [0.6.8]

0.6.8 is mostly fixes, most of them from the community: one skill being edited
in the managed catalog no longer stops every seat's skills, a launch plan can
never start a seat, Slack replies stay in their thread, and a workflow that
could never finish is caught at validate. It is built from the commit tagged
`v0.6.8`. The changes since 0.6.7:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). There are no migrations, and openrig-core stays at 0.1.8.
- Move the TUI's footer toggle to `F`, and the selected Scopes view's
  mini-requirements and narrative keys to `M` and `N`, so `find`, `feed`,
  `mission`, `narrative` and `needs` type whole on an empty command line
  ([#1020](https://github.com/mvschwarz/openrig/pull/1020)). Move the selection down and up with `j` and `k` on an empty
  line ([#1019](https://github.com/mvschwarz/openrig/pull/1019)).
- Report `step_cannot_finish` from `rig workflow validate`, and refuse to
  instantiate, when no allowed exit can finish a step or route onward. An
  allowed mapped exit is valid; in a dependency graph, `handoff` can finish a
  sink without a next step. A spec that validated on 0.6.7 can be refused now
  ([#1012](https://github.com/mvschwarz/openrig/pull/1012)).
- Report a selected skill skipped for uncommitted catalog content with exit 1
  from `rig context work-install --runtime <runtime>` and `rig skill loadout
  --runtime <runtime>`. Inspection is the default; applying with
  `--apply-skills` or `--apply`, respectively, still reconciles the remaining
  clean skills ([#1031](https://github.com/mvschwarz/openrig/pull/1031)).
- Refuse `rig launch --plan` against a daemon older than 0.5.9, which would
  ignore the plan and launch ([#1024](https://github.com/mvschwarz/openrig/pull/1024)).

### Highlights

- Skip a managed catalog skill with uncommitted or untracked content by itself,
  with a named warning, instead of making the whole catalog unavailable for `rig
  context work-install`, `rig up`, launch and restore preflight. A seat keeps
  the copy it already has until the catalog change is committed or restored and
  a later applied projection refreshes it, no runtime gets the uncommitted
  files, and launch only warns. Uncommitted `catalog.yaml` still makes the
  catalog unavailable ([#1031](https://github.com/mvschwarz/openrig/pull/1031)).
- Preview a single seat's launch with `rig launch <rig> <seat> --plan`, locally
  or over `--host` ([#1023](https://github.com/mvschwarz/openrig/pull/1023)). Read the daemon's version before any plan, and
  exit non-zero, naming `rig ps --nodes -A`, when an answer isn't a plan but
  shows the daemon acted ([#1024](https://github.com/mvschwarz/openrig/pull/1024)).
- Post an agent's `--human-intent update --reply-to <reply row>` answer in the
  Slack thread where the person replied; the `messaging-the-human` skill says
  how ([#1021](https://github.com/mvschwarz/openrig/pull/1021)). Wait out a Slack rate limit of 10 seconds or less and retry
  the post once ([#1026](https://github.com/mvschwarz/openrig/pull/1026)). Keep the bot token on Slack's hosts inside the
  private-file download itself ([#1006](https://github.com/mvschwarz/openrig/pull/1006)).
- Deliver the turn boundary, restore request and read-depth audit to a Claude
  seat that stays quiet after a managed `/compact`, instead of waiting for its
  next turn. Each stage still waits for an idle screen ([#1035](https://github.com/mvschwarz/openrig/pull/1035)).

### Dependency and install-script changes

- No npm dependency or lockfile change beyond OpenRig's own version, the same
  `postinstall`, and the same `node >=22`.
- Finish the CLI and TUI build output with `scripts/prepare-workspace-build.mjs`
  instead of `chmod`, `mkdir` and `cp`, so building from source no longer needs
  POSIX shell tools; not yet run on Windows. Originally contributed by
  @dajiaohuang in #956 ([#1033](https://github.com/mvschwarz/openrig/pull/1033)).

### Launch, seats, queue and scope

- Confirm a Claude seat's identity when it was launched with `--remote-control`
  ([#1025](https://github.com/mvschwarz/openrig/pull/1025)). Save `rig down`'s recovery snapshot even when finding one seat's
  resume details fails ([#1030](https://github.com/mvschwarz/openrig/pull/1030)).
- Show a handed-off task's summary, on one line of up to 120 characters, in its
  wake ([#1028](https://github.com/mvschwarz/openrig/pull/1028)).
- Accept slice folders numbered 100 and above in `rig scope audit` ([#1016](https://github.com/mvschwarz/openrig/pull/1016)).
  Keep a leading UTF-8 byte-order mark in `rig proof add --file` ([#270](https://github.com/mvschwarz/openrig/pull/270)).

### Docs

- Add a topology naming reference and point the rig spec, bundle and authoring
  guides to it ([#1000](https://github.com/mvschwarz/openrig/pull/1000)). Bring the architecture and CLI reference docs to
  0.6.7 ([#1015](https://github.com/mvschwarz/openrig/pull/1015)).

## [0.6.7]

0.6.7 is about the first hour: after install or start, the agent opens the
OpenRig TUI and the kernel's operator for you, laid out for your terminal, and
the operator asks fewer permission questions. It is built from the commit
tagged `v0.6.7`. The changes since 0.6.6:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then `rig
  daemon start`). The first start runs two migrations, the team install folder
  ([#901](https://github.com/mvschwarz/openrig/pull/901)) and the Slack thread-part map ([#947](https://github.com/mvschwarz/openrig/pull/947)); installs openrig-core 0.1.8,
  which running seats pick up at their next launch ([#928](https://github.com/mvschwarz/openrig/pull/928), [#965](https://github.com/mvschwarz/openrig/pull/965), [#972](https://github.com/mvschwarz/openrig/pull/972), [#975](https://github.com/mvschwarz/openrig/pull/975)); and
  copies the `rigs` and `refocusing` skills into `~/.claude/skills` and
  `~/.agents/skills`, refreshed on every upgrade, leaving a skills.sh copy of
  `rigs` alone ([#967](https://github.com/mvschwarz/openrig/pull/967), [#928](https://github.com/mvschwarz/openrig/pull/928)).
- Install herdr by default in `rig setup` on macOS and Linux with herdr's own
  installer (`--no-herdr` declines; a failed install falls back to plain tmux),
  offer Ghostty on a Mac (`--ghostty`, `--no-ghostty`), and stop installing or
  configuring cmux. `rig setup --json` drops `cmux_install` and adds
  `herdr_install` and `ghostty_install` ([#936](https://github.com/mvschwarz/openrig/pull/936)).
- Open a desktop window by default from `rig terminal open <view>`; pass
  `--provider herdr|cmux` to add tiles to an open workspace ([#954](https://github.com/mvschwarz/openrig/pull/954)). Lay out the
  default `saved:kernel` view by terminal width; a saved `kernel` view still
  wins ([#978](https://github.com/mvschwarz/openrig/pull/978), [#998](https://github.com/mvschwarz/openrig/pull/998)). Use a personal herdr config unchanged ([#969](https://github.com/mvschwarz/openrig/pull/969), [#998](https://github.com/mvschwarz/openrig/pull/998)).
- Check Claude Code and Codex installs, and a login or configured provider
  credential, in `rig doctor`, with four new rows, and exit 1 when either is
  missing or has neither, including an unused harness. A pass means a local
  credential is available ([#924](https://github.com/mvschwarz/openrig/pull/924)).
- Default `agents.advisor_session` to the kernel's advisor seat, and target the
  seat's own rig in `rig restore-packet write` ([#937](https://github.com/mvschwarz/openrig/pull/937)). Name bundles after
  `rig.yaml`'s `name` in `rig bundle create` and `rig up <link>` ([#985](https://github.com/mvschwarz/openrig/pull/985)). Fire a
  periodic reminder one interval after registration ([#860](https://github.com/mvschwarz/openrig/pull/860)). Resolve `rig
  package` paths and `--target .` from the caller's folder ([#754](https://github.com/mvschwarz/openrig/pull/754)). Turn off
  Codex's startup update check for managed launches ([#986](https://github.com/mvschwarz/openrig/pull/986)).
- Rewrite a Claude seat's status-line command with quoted paths ([#852](https://github.com/mvschwarz/openrig/pull/852)) and move
  its activity relay to `$OPENRIG_HOME/state/claude-activity-hooks/` ([#870](https://github.com/mvschwarz/openrig/pull/870)) at
  its next launch. Add a command hook to Claude team seats' launch settings
  ([#927](https://github.com/mvschwarz/openrig/pull/927)) and to the kernel's Claude seats, with a wider allowance ([#983](https://github.com/mvschwarz/openrig/pull/983)); no
  settings file is written.

### Highlights

- Open the OpenRig TUI and operator as the step after install or start, with
  `rig terminal open saved:kernel --window`: the operator leads under 120
  columns, the dashboard and operator share the first tab from 120, and the
  advisor has its own tab ([#978](https://github.com/mvschwarz/openrig/pull/978), [#998](https://github.com/mvschwarz/openrig/pull/998)). Open in the caller's terminal: a herdr
  `openrig kernel` space, a new Terminal window copying your front window's size
  when available, a Ghostty tab, or from Claude Desktop, iTerm or VS Code on a
  Mac a new Ghostty or Terminal window at the app's default size; on Linux GNOME
  Terminal, Konsole or xterm at a readable size ([#952](https://github.com/mvschwarz/openrig/pull/952), [#970](https://github.com/mvschwarz/openrig/pull/970), [#998](https://github.com/mvschwarz/openrig/pull/998)). Reuse an
  open herdr view ([#957](https://github.com/mvschwarz/openrig/pull/957)) and never resize existing windows ([#958](https://github.com/mvschwarz/openrig/pull/958)). Without a
  display, say why and print the command to run ([#954](https://github.com/mvschwarz/openrig/pull/954), [#970](https://github.com/mvschwarz/openrig/pull/970)). Use the same
  launcher for the TUI's **Open terminals**, with attach commands when no window
  can open ([#959](https://github.com/mvschwarz/openrig/pull/959)). Point help, setup and onboarding at the command ([#950](https://github.com/mvschwarz/openrig/pull/950)).
- Carry the install-to-operator route in the `rigs` skill: finish the install,
  hand over the goal, folder and branch, relay the operator's questions, and
  give a command when no window opens; drop the macOS-prompt warning ([#909](https://github.com/mvschwarz/openrig/pull/909),
  [#964](https://github.com/mvschwarz/openrig/pull/964), [#971](https://github.com/mvschwarz/openrig/pull/971), [#982](https://github.com/mvschwarz/openrig/pull/982), [#988](https://github.com/mvschwarz/openrig/pull/988)).
- Publish a one-command install with a stable link and a `--dry-run` preview
  ([#917](https://github.com/mvschwarz/openrig/pull/917)). Tell an installing agent to show a refusal from its own permission
  rules instead of reporting a failure ([#950](https://github.com/mvschwarz/openrig/pull/950)).
- Run lifecycle help (`--help`, `-h`) and common spellings of allowed commands
  without a prompt in Claude team seats; lifecycle actions still ask ([#927](https://github.com/mvschwarz/openrig/pull/927)).
  Allow the kernel operator's routine inspection commands and WebFetch ([#983](https://github.com/mvschwarz/openrig/pull/983)),
  read `/rigs` pages with WebFetch ([#994](https://github.com/mvschwarz/openrig/pull/994)), and run first-boot checks as separate
  commands ([#932](https://github.com/mvschwarz/openrig/pull/932)). Match setup's permission text to the team default ([#916](https://github.com/mvschwarz/openrig/pull/916)), and
  point prompt-weary users to the workshop team ([#939](https://github.com/mvschwarz/openrig/pull/939)).
- Refuse a `rig send` or wake to a Claude seat whose unrecognised screen follows
  a hook saying it is waiting for a person, and escalate the wake ([#1001](https://github.com/mvschwarz/openrig/pull/1001)). Keep
  a seat waiting at an approval counted as needing attention after a daemon
  restart ([#885](https://github.com/mvschwarz/openrig/pull/885)).
- Add `rig slack channel-map list|set|remove` for a channel per rig or seat,
  checked by `rig slack verify` and shown in the TUI ([#944](https://github.com/mvschwarz/openrig/pull/944)). Deliver an emoji
  reaction on any message posted for an ask to the asking seat ([#931](https://github.com/mvschwarz/openrig/pull/931), [#947](https://github.com/mvschwarz/openrig/pull/947)).
  Post a long ask as numbered thread replies, and tell the seat when it still
  can't be posted ([#929](https://github.com/mvschwarz/openrig/pull/929)). Route "Also send to #channel" replies ([#910](https://github.com/mvschwarz/openrig/pull/910)). Retry a
  Slack socket that fails or stalls while opening ([#942](https://github.com/mvschwarz/openrig/pull/942)).
- Ship a what-changed note for agents, `rig context get reference/whats-new.md`,
  read by the `openrig-upgrade` skill's last step ([#934](https://github.com/mvschwarz/openrig/pull/934), [#1010](https://github.com/mvschwarz/openrig/pull/1010)). Refresh the
  capability map for 0.6.6 ([#905](https://github.com/mvschwarz/openrig/pull/905)) and 0.6.7 ([#1010](https://github.com/mvschwarz/openrig/pull/1010)).
- Let `rig seat handover` run again on the same seat ([#987](https://github.com/mvschwarz/openrig/pull/987)). Teach seats to
  write their recap with `rig context recap-write` before a handover ([#1002](https://github.com/mvschwarz/openrig/pull/1002)),
  and include a Codex predecessor's messages in the recap ([#848](https://github.com/mvschwarz/openrig/pull/848)). Deliver
  refocus with the restore request, also when wrapped as pasted text, and post
  one stream issue after three failures in a row ([#928](https://github.com/mvschwarz/openrig/pull/928), [#972](https://github.com/mvschwarz/openrig/pull/972), [#975](https://github.com/mvschwarz/openrig/pull/975)). Move a
  finished restore map into place from the daemon ([#965](https://github.com/mvschwarz/openrig/pull/965)).
- Publish the built-in starter and factory leads' rosters at first start ([#918](https://github.com/mvschwarz/openrig/pull/918)).
  Show each first-team choice's graph in the shared TUI ([#948](https://github.com/mvschwarz/openrig/pull/948)). Name the file in
  each `rig bundle check` finding ([#985](https://github.com/mvschwarz/openrig/pull/985)). Retrieve shallowly by default in `rig
  context add --git`, falling back to a full clone with a warning when the
  server refuses, and name `openrig-registry` for submissions ([#951](https://github.com/mvschwarz/openrig/pull/951)).

### Behaviour changes

- Back up and replace conflicting files on a bundle reinstall only in the team's
  recorded install folder ([#901](https://github.com/mvschwarz/openrig/pull/901)). Always run the bundle safety check, even with
  `--skip-version-check --force` ([#876](https://github.com/mvschwarz/openrig/pull/876)). Return HTTP 400 with a `code` for a
  conflicting-file install refusal, and 409 with codes for the others ([#926](https://github.com/mvschwarz/openrig/pull/926)).
- Clear a claimed task's blocker; `rig queue update <id> --state blocked`
  without `--blocked-on` reuses it ([#761](https://github.com/mvschwarz/openrig/pull/761)). Show a parked task's real wake time,
  never 1970 ([#946](https://github.com/mvschwarz/openrig/pull/946)). Print an error for an invalid `--wake-after` such as `7d`
  ([#945](https://github.com/mvschwarz/openrig/pull/945)).
- Rerun the steps that depend on a sent-back step when it completes again
  ([#817](https://github.com/mvschwarz/openrig/pull/817)). Refuse `rig workflow resume --occurrence` with no matching failure
  ([#757](https://github.com/mvschwarz/openrig/pull/757)). Exit 3 from `rig workflow run` and `watch` for an aborted run ([#847](https://github.com/mvschwarz/openrig/pull/847)).
  Use the workflow file in the caller's folder ([#845](https://github.com/mvschwarz/openrig/pull/845)).
- Exit 2 from `rig down --host` when the remote teardown reports errors ([#756](https://github.com/mvschwarz/openrig/pull/756)),
  and print each agent's last known activity before human-mode `rig down` stops
  them ([#922](https://github.com/mvschwarz/openrig/pull/922)). Exit 1 from `rig chatroom wait` at its deadline ([#968](https://github.com/mvschwarz/openrig/pull/968)). Refuse a
  `rig chatroom history --since` value SQLite can't read ([#930](https://github.com/mvschwarz/openrig/pull/930)), and escape C1
  control characters in its error ([#991](https://github.com/mvschwarz/openrig/pull/991)). Pass `rig skill audit` on a clean
  install, with new `--json` fields ([#807](https://github.com/mvschwarz/openrig/pull/807)). Report malformed pods, members and
  edges as validation errors ([#846](https://github.com/mvschwarz/openrig/pull/846)). Say OpenRig supports one configured human
  in `rig gateway human` messages ([#961](https://github.com/mvschwarz/openrig/pull/961)).
- Read `attention_required` for a running seat whose pane fails its identity
  check, keep the stored result in `storedStartupStatus`, and name the verdict
  in `rig restore-check` ([#940](https://github.com/mvschwarz/openrig/pull/940)).
- End a context section at an empty heading, and stop an inline triple-backtick
  span from hiding later headings ([#962](https://github.com/mvschwarz/openrig/pull/962)).
- Check a mission's folded rung against `arrangement.source.integration_ref`
  when `mission.yaml` declares it ([#682](https://github.com/mvschwarz/openrig/pull/682)).

### Dependency and install-script changes

- npm dependencies: none added, removed or changed; only OpenRig's own versions
  moved to 0.6.7 ([#1005](https://github.com/mvschwarz/openrig/pull/1005)). Node requirement unchanged (`node >=22`).
- Install scripts: unchanged (`postinstall: node scripts/check-abi.mjs`).
- `rig setup` runs herdr's installer (`curl -fsSL https://herdr.dev/install.sh |
  sh`) unless `--no-herdr`, runs `brew install --cask ghostty` only with
  `--ghostty`, and no longer installs cmux ([#936](https://github.com/mvschwarz/openrig/pull/936)).
- The repository's `scripts/install.sh` (not in the package) is published with a
  stable link ([#917](https://github.com/mvschwarz/openrig/pull/917)); its closing and plan text changed ([#916](https://github.com/mvschwarz/openrig/pull/916), [#950](https://github.com/mvschwarz/openrig/pull/950)).
- Database: migrations `096_rig_install_root` ([#901](https://github.com/mvschwarz/openrig/pull/901)) and `097_thread_part_map`
  ([#947](https://github.com/mvschwarz/openrig/pull/947)).
- Bundled plugin: openrig-core 0.1.8 ([#928](https://github.com/mvschwarz/openrig/pull/928), [#965](https://github.com/mvschwarz/openrig/pull/965), [#972](https://github.com/mvschwarz/openrig/pull/972), [#975](https://github.com/mvschwarz/openrig/pull/975)).
- Files written outside the project: the `rigs` and `refocusing` skills ([#967](https://github.com/mvschwarz/openrig/pull/967),
  [#928](https://github.com/mvschwarz/openrig/pull/928)), a refocus health file under `$OPENRIG_HOME/refocus/` ([#928](https://github.com/mvschwarz/openrig/pull/928)), the Claude
  activity relay under `$OPENRIG_HOME/state/claude-activity-hooks/` ([#870](https://github.com/mvschwarz/openrig/pull/870)), and
  a private herdr config only when you have none ([#998](https://github.com/mvschwarz/openrig/pull/998)). Exclude generated
  `.codex/plugins/shared:openrig-core/` files in `.git/info/exclude` ([#919](https://github.com/mvschwarz/openrig/pull/919)).

### Kernel, setup and first run

- Explain a Codex seat that needs a newer Codex and offer to update it ([#916](https://github.com/mvschwarz/openrig/pull/916)).
  Give the order for stopping everything, kernel last, then `rig daemon stop`
  ([#932](https://github.com/mvschwarz/openrig/pull/932)). Drop retired team names from help and guides ([#935](https://github.com/mvschwarz/openrig/pull/935)).

### Claude, Codex and Pi

- Read a Claude seat's session correctly with inline permission settings, fixing
  0.6.6's known issue [#921](https://github.com/mvschwarz/openrig/issues/921) ([#933](https://github.com/mvschwarz/openrig/pull/933)). Quote the Claude resume token ([#798](https://github.com/mvschwarz/openrig/pull/798)). Keep
  `$$` and similar literal in rewritten managed blocks ([#908](https://github.com/mvschwarz/openrig/pull/908)).
- Report a late Codex sign-in or client notice at restore, and retry fresh on a
  late "no saved session" ([#759](https://github.com/mvschwarz/openrig/pull/759)). Find a Codex conversation when its home path
  has spaces ([#851](https://github.com/mvschwarz/openrig/pull/851)).
- Report the Pi version and a seat's credential readiness before launch ([#938](https://github.com/mvschwarz/openrig/pull/938)).
  Forward `MINIMAX_API_KEY` to `minimax/<id>` Pi seats when allowlisted ([#891](https://github.com/mvschwarz/openrig/pull/891)).

### Launch, seats and terminal

- Restore a fresh-launched seat after a clean `rig down` ([#955](https://github.com/mvschwarz/openrig/pull/955)). Keep a plugin
  skill copy whose remembered source can no longer be projected, with a
  `plugin_skill_kept` warning, instead of failing the launch; a seat selecting
  that plugin refreshes it at its next launch ([#819](https://github.com/mvschwarz/openrig/pull/819)). Look up names containing
  `%` correctly ([#844](https://github.com/mvschwarz/openrig/pull/844)). Keep tmux session names with `|` or edge spaces ([#752](https://github.com/mvschwarz/openrig/pull/752)),
  and read launch settings from the exact session ([#755](https://github.com/mvschwarz/openrig/pull/755)). Wait up to 45 seconds
  for `rig terminal open` ([#758](https://github.com/mvschwarz/openrig/pull/758)). Close a failed terminal attach without
  stopping the daemon ([#907](https://github.com/mvschwarz/openrig/pull/907)).

### Chat, usage, transcripts and retention

- Keep `rig chatroom watch` messages in order ([#760](https://github.com/mvschwarz/openrig/pull/760)). Scope `rig usage top` to
  each seat's own run ([#835](https://github.com/mvschwarz/openrig/pull/835)) and compare `rig usage series` cutoffs as moments
  ([#840](https://github.com/mvschwarz/openrig/pull/840)). Read a consistent transcript copy during replacement ([#843](https://github.com/mvschwarz/openrig/pull/843)). Keep the
  right watchdog history entries at tied timestamps ([#753](https://github.com/mvschwarz/openrig/pull/753)), and prune long
  snapshot histories in one query ([#836](https://github.com/mvschwarz/openrig/pull/836)).

### Scope, projects and TUI

- Handle workspace paths starting with `-` ([#974](https://github.com/mvschwarz/openrig/pull/974)), keep mission membership on
  failed moves ([#976](https://github.com/mvschwarz/openrig/pull/976)), check slice edits by literal path ([#1003](https://github.com/mvschwarz/openrig/pull/1003)), copy text
  literally into new missions and slices ([#977](https://github.com/mvschwarz/openrig/pull/977)), update frontmatter by its real
  YAML key ([#979](https://github.com/mvschwarz/openrig/pull/979)), and resolve a hinted slice past an unrelated folder ([#1004](https://github.com/mvschwarz/openrig/pull/1004)).
- Prefer the deeper project over one declared at `/` ([#857](https://github.com/mvschwarz/openrig/pull/857)).
- Resolve a rig, host, pod or agent address from any TUI page ([#984](https://github.com/mvschwarz/openrig/pull/984)).

### Docs

- Bring the reference guides ([#903](https://github.com/mvschwarz/openrig/pull/903)) and architecture docs ([#902](https://github.com/mvschwarz/openrig/pull/902)) to 0.6.6, and
  add the 0.6.6 changelog section ([#906](https://github.com/mvschwarz/openrig/pull/906)). Cover kernel seats failing at first
  start on a crashing tmux ([#999](https://github.com/mvschwarz/openrig/pull/999)). Name WSL2 as the Windows route, with one
  user's working setup and both Pi credential routes ([#960](https://github.com/mvschwarz/openrig/pull/960), [#963](https://github.com/mvschwarz/openrig/pull/963)). Bring the
  README and reference guides to 0.6.7 ([#1009](https://github.com/mvschwarz/openrig/pull/1009)).

## [0.6.6]

0.6.6 is about getting to your agents fast: after install, the kernel's operator
asks what you want to build, offers three teams and launches one, and teams can
be shared and installed from a GitHub folder link. It is built from main at
`2620dea8` (after [#900](https://github.com/mvschwarz/openrig/pull/900)). Work merged to main after that point isn't included.
The changes since 0.6.5:

### Before you upgrade

- Restart the daemon after upgrading the CLI (`rig daemon stop`, then
  `rig daemon start`). The first start adds the saved non-interruptive choice
  to rigs ([#737](https://github.com/mvschwarz/openrig/pull/737)) and installs openrig-core 0.1.4, which running seats pick up at
  their next launch ([#685](https://github.com/mvschwarz/openrig/pull/685), [#829](https://github.com/mvschwarz/openrig/pull/829)).
- Rename the built-in teams: `starter` (a Claude Code builder and a Codex
  reviewer; `first-project` is an alias), `factory`, `code-review` (was
  `adversarial-review`), `research` (was `research-team`) and `pm` (was
  `pm-team`), with no alias for the last three. Remove `conveyor`, `demo`,
  `implementation-pair`, `product-team`, `first-project-claude`,
  `first-project-mixed` and `factory-rsi` from the shelf; keep `secrets-manager`
  and the kernel. Existing rigs created from removed specs keep restoring. Stop
  loading test-driven-development by default ([#864](https://github.com/mvschwarz/openrig/pull/864), [#866](https://github.com/mvschwarz/openrig/pull/866), [#868](https://github.com/mvschwarz/openrig/pull/868)).
- Give Claude Code and Codex seats outside the kernel, with no member or rig
  `permission_policy`, no saved seat choice and no named Codex profile, a team
  default at their next launch: Claude Code runs `rig`, project reads and common
  test commands without prompts and asks before lifecycle commands; Codex can
  also write the workspace folder and its pod's state folder. Set an explicit
  policy, such as `permission_policy: none`, to keep the old behaviour ([#893](https://github.com/mvschwarz/openrig/pull/893)).
- Give seats of the rig named `kernel`, with no explicit choice, policy or Codex
  profile, an operational default: Claude Code in `acceptEdits` with an allow list
  for file tools, reads under home and operational commands; Codex with
  `-s danger-full-access -a never` ([#820](https://github.com/mvschwarz/openrig/pull/820), [#858](https://github.com/mvschwarz/openrig/pull/858)).
- Derive a new rig's default Docker Compose project from its rig ID, not its name;
  existing rigs keep theirs. Bring a newly started project down (never with
  volumes) when boot fails, refuse conflicting replaced generations with
  `compose_project_conflict`, and exit 2 from `rig down` when it keeps a project a
  live same-name rig still uses ([#481](https://github.com/mvschwarz/openrig/pull/481)).
- Leave a launch-created `AGENTS.md` or `CLAUDE.md` visible to Git, with a
  warning naming the exclude line, and exclude new files under
  `.codex/plugins/openrig-core/` in a marked `info/exclude` block ([#721](https://github.com/mvschwarz/openrig/pull/721), [#727](https://github.com/mvschwarz/openrig/pull/727)).
- Set a once-only Slack recovery checkpoint per channel on the first start, and
  deliver top-level messages missed during a gap as "Recovered after a gap" tasks
  ([#742](https://github.com/mvschwarz/openrig/pull/742)).
- Write managed compaction restore maps in the seat's launch folder under
  `.openrig/compaction/`, git-ignored, with the OpenRig home as a fallback ([#685](https://github.com/mvschwarz/openrig/pull/685)).

### Highlights

- Have the kernel's operator greet first, ask the goal once, offer starter,
  workshop and factory with one recommendation and a drawing, adapt the team to
  the providers present, launch on a yes, show the team and hand the goal to the
  lead ([#858](https://github.com/mvschwarz/openrig/pull/858), [#862](https://github.com/mvschwarz/openrig/pull/862), [#880](https://github.com/mvschwarz/openrig/pull/880), [#884](https://github.com/mvschwarz/openrig/pull/884), [#890](https://github.com/mvschwarz/openrig/pull/890)). Read the workshop pin fresh from the
  registry's raw file ([#900](https://github.com/mvschwarz/openrig/pull/900)). Start the lead from that goal, with one light
  mission and slice for continuing work ([#865](https://github.com/mvschwarz/openrig/pull/865)). Keep the kernel when an agent
  installs OpenRig and pass the goal to the operator ([#873](https://github.com/mvschwarz/openrig/pull/873)); print the operator
  handoff after every setup result ([#859](https://github.com/mvschwarz/openrig/pull/859), [#886](https://github.com/mvschwarz/openrig/pull/886)). Stop assuming macOS in the
  advisor's startup context ([#770](https://github.com/mvschwarz/openrig/pull/770)).
- Open a new terminal space with the kernel's TUI, advisor and operator after
  install ([#821](https://github.com/mvschwarz/openrig/pull/821)). Provide a default `saved:kernel` view showing all three for
  every kernel runtime mix ([#830](https://github.com/mvschwarz/openrig/pull/830), [#854](https://github.com/mvschwarz/openrig/pull/854)). Give exact tmux or `ssh -t` attach
  commands when herdr or cmux isn't available ([#831](https://github.com/mvschwarz/openrig/pull/831), [#833](https://github.com/mvschwarz/openrig/pull/833), [#878](https://github.com/mvschwarz/openrig/pull/878)). Open the TUI's
  work views without a running rig ([#818](https://github.com/mvschwarz/openrig/pull/818)), and show rig specs as graphs with
  Launch ([#867](https://github.com/mvschwarz/openrig/pull/867), [#874](https://github.com/mvschwarz/openrig/pull/874)).
- Accept public GitHub folder links in `rig up` and `rig bundle create`,
  `inspect` and `install`, pinned to one commit ([#708](https://github.com/mvschwarz/openrig/pull/708)). Declare and pick bundle
  configurations with `rig bundle configurations`, `--preset` and `--seat`
  ([#704](https://github.com/mvschwarz/openrig/pull/704)). Show what a bundle will do before install: posture, files, startup
  actions, writes, domains, preconditions and per-seat facts ([#710](https://github.com/mvschwarz/openrig/pull/710), [#717](https://github.com/mvschwarz/openrig/pull/717), [#723](https://github.com/mvschwarz/openrig/pull/723),
  [#738](https://github.com/mvschwarz/openrig/pull/738), [#892](https://github.com/mvschwarz/openrig/pull/892)). Route bundle contents before seats launch, add
  `rig bundle install --cwd` ([#692](https://github.com/mvschwarz/openrig/pull/692), [#705](https://github.com/mvschwarz/openrig/pull/705), [#720](https://github.com/mvschwarz/openrig/pull/720), [#722](https://github.com/mvschwarz/openrig/pull/722)), check bundles with
  `rig bundle check` ([#708](https://github.com/mvschwarz/openrig/pull/708)), and carry a context pack or a project with
  `--context-pack` and `--project-dir` ([#694](https://github.com/mvschwarz/openrig/pull/694), [#700](https://github.com/mvschwarz/openrig/pull/700), [#716](https://github.com/mvschwarz/openrig/pull/716)). Record the real
  assembler version ([#718](https://github.com/mvschwarz/openrig/pull/718)). Offer use, replace or cancel when a team is already
  installed, backing up a stopped team's edited files ([#877](https://github.com/mvschwarz/openrig/pull/877)). Install
  `.rigbundle` files through `rig bootstrap` ([#709](https://github.com/mvschwarz/openrig/pull/709)). Document the v1 bundle
  formats and the publishing guide ([#702](https://github.com/mvschwarz/openrig/pull/702), [#750](https://github.com/mvschwarz/openrig/pull/750), [#751](https://github.com/mvschwarz/openrig/pull/751), [#777](https://github.com/mvschwarz/openrig/pull/777), [#810](https://github.com/mvschwarz/openrig/pull/810)).
- Save `--non-interruptive` on the rig for full-bypass seats, clear it with
  `--no-non-interruptive`, default it with `launch.non_interruptive`, and accept
  `non_interruptive:` in a rig spec ([#737](https://github.com/mvschwarz/openrig/pull/737), [#741](https://github.com/mvschwarz/openrig/pull/741), [#892](https://github.com/mvschwarz/openrig/pull/892)). Continue a Claude seat's
  startup after its bypass warning with `rig seat continue` ([#740](https://github.com/mvschwarz/openrig/pull/740), [#748](https://github.com/mvschwarz/openrig/pull/748)). Add the
  `builtin:auto` policy ([#680](https://github.com/mvschwarz/openrig/pull/680), [#733](https://github.com/mvschwarz/openrig/pull/733)) and describe every built-in policy ([#713](https://github.com/mvschwarz/openrig/pull/713)).
  Accept `--operator` on `rig seat set-permissions` ([#689](https://github.com/mvschwarz/openrig/pull/689)).
- Copy a selected plugin's skills into Claude Code and Codex seats' skill folders
  ([#815](https://github.com/mvschwarz/openrig/pull/815), [#823](https://github.com/mvschwarz/openrig/pull/823)).
- Add `rig roster list`, `show` and `find` ([#697](https://github.com/mvschwarz/openrig/pull/697)), and
  `rig telemetry events`, `transitions` and `tenures` ([#696](https://github.com/mvschwarz/openrig/pull/696)).
- Pick the `rig context work-install` project by rig, then working folder, then
  the only unclaimed project, with candidate commands when still ambiguous ([#690](https://github.com/mvschwarz/openrig/pull/690),
  [#688](https://github.com/mvschwarz/openrig/pull/688), [#772](https://github.com/mvschwarz/openrig/pull/772)), and list a project's declared worlds ([#691](https://github.com/mvschwarz/openrig/pull/691)). Use the same catalog
  and selection in operating posture ([#693](https://github.com/mvschwarz/openrig/pull/693), [#712](https://github.com/mvschwarz/openrig/pull/712)).
- Type `rig send --dangerously-interact` answers as keystrokes, so numbered menus
  get the digit ([#663](https://github.com/mvschwarz/openrig/pull/663)).

### Behaviour changes

- Return `rig queue create`, `handoff` and `handoff-and-complete` once saved; the
  wake follows, and `--verify` waits for it ([#776](https://github.com/mvschwarz/openrig/pull/776)).
- End `rig doctor` by naming what it didn't check instead of "System checks look
  good." ([#855](https://github.com/mvschwarz/openrig/pull/855)).
- Print setup's next steps before the permission menu and add `nextSteps` to
  `--json` ([#886](https://github.com/mvschwarz/openrig/pull/886)); list each failed step with its fix ([#842](https://github.com/mvschwarz/openrig/pull/842)); report macOS-only
  steps as skipped in a Linux dry run ([#769](https://github.com/mvschwarz/openrig/pull/769)).
- Report attention when a bundled prompt reveals a provider gate ([#684](https://github.com/mvschwarz/openrig/pull/684)), and
  `bypass_consent_gate` until `rig seat continue` ([#740](https://github.com/mvschwarz/openrig/pull/740)).
- Send Claude seats a short startup-proof line after their startup text ([#719](https://github.com/mvschwarz/openrig/pull/719),
  [#743](https://github.com/mvschwarz/openrig/pull/743), [#747](https://github.com/mvschwarz/openrig/pull/747)), check later Claude startup files the same way, and surface
  staged or unverified startup text as warnings ([#736](https://github.com/mvschwarz/openrig/pull/736)).
- Read idle Claude panes under warning rows in every permission mode, and live
  work beside the mode bar as working ([#735](https://github.com/mvschwarz/openrig/pull/735), [#814](https://github.com/mvschwarz/openrig/pull/814)); recognise tall question
  pickers ([#745](https://github.com/mvschwarz/openrig/pull/745)).
- Never merge a bundle's context pack into an installed one ([#694](https://github.com/mvschwarz/openrig/pull/694)); refuse unsafe
  entries in `rig bundle inspect` ([#695](https://github.com/mvschwarz/openrig/pull/695)); record the configuration ID and
  assembler in every `bundle.yaml` ([#708](https://github.com/mvschwarz/openrig/pull/708)); refuse an escaping legacy `project`
  block ([#716](https://github.com/mvschwarz/openrig/pull/716)); prefer a profile's selected skill over a differing catalog copy,
  with a warning ([#720](https://github.com/mvschwarz/openrig/pull/720), [#722](https://github.com/mvschwarz/openrig/pull/722)).
- Refuse package skill or agent names that would write outside the install
  target ([#725](https://github.com/mvschwarz/openrig/pull/725)).
- Warn instead of failing preflight when `pi` isn't on the daemon's PATH ([#655](https://github.com/mvschwarz/openrig/pull/655)).
- Pass an allowlisted provider base URL to OMP seats of that provider ([#744](https://github.com/mvschwarz/openrig/pull/744)).
- Keep guidance files a surviving seat still uses when `rig down` can't stop it
  ([#662](https://github.com/mvschwarz/openrig/pull/662)).
- Delete service volumes through the API only for a JSON boolean `volumes: true`
  ([#668](https://github.com/mvschwarz/openrig/pull/668)).
- Cap an infinite or overflowing `rig host pair --timeout` at about 25 days
  ([#734](https://github.com/mvschwarz/openrig/pull/734)).
- Open rig specs on the TUI's graph tab ([#867](https://github.com/mvschwarz/openrig/pull/867)).
- Split `rig seat set-permissions` errors ([#689](https://github.com/mvschwarz/openrig/pull/689)), and print the permission source
  in `rig seat status` ([#680](https://github.com/mvschwarz/openrig/pull/680)).

### Dependency and install-script changes

- No npm dependency changes; `node >=22` and the postinstall check are unchanged.
- Add the optional repository script `scripts/install.sh`, not in the package
  and not yet documented ([#832](https://github.com/mvschwarz/openrig/pull/832), [#841](https://github.com/mvschwarz/openrig/pull/841), [#853](https://github.com/mvschwarz/openrig/pull/853)).
- On macOS, the daemon may run `/usr/bin/osascript` to verify a version-named
  Claude process ([#724](https://github.com/mvschwarz/openrig/pull/724), [#730](https://github.com/mvschwarz/openrig/pull/730)).
- Run the user's `git` for GitHub link import ([#708](https://github.com/mvschwarz/openrig/pull/708)) and generated-file hygiene
  ([#721](https://github.com/mvschwarz/openrig/pull/721), [#727](https://github.com/mvschwarz/openrig/pull/727)).
- Add one database migration ([#737](https://github.com/mvschwarz/openrig/pull/737)), and ship openrig-core 0.1.4 ([#685](https://github.com/mvschwarz/openrig/pull/685), [#829](https://github.com/mvschwarz/openrig/pull/829)).

### Kernel, setup and first run

- Say `--no-kernel` skips the operator too ([#873](https://github.com/mvschwarz/openrig/pull/873)); offer the kernel view before
  a team ([#859](https://github.com/mvschwarz/openrig/pull/859)); use the new team names in shipped text ([#866](https://github.com/mvschwarz/openrig/pull/866)); explain what
  stopping or restarting a live team does ([#895](https://github.com/mvschwarz/openrig/pull/895)).
- Document `rig seat continue`, startup attention, readiness timeouts, Claude's
  bypass warning and `builtin:auto` in getting started and the help guide ([#779](https://github.com/mvschwarz/openrig/pull/779));
  document Node 22 or 24 on Linux, npm 11's postinstall warning and macOS-only
  cmux ([#839](https://github.com/mvschwarz/openrig/pull/839)).

### Claude, Codex, Pi and Oh My Pi

- Verify shell-wrapped, version-named Claude processes by executable path ([#724](https://github.com/mvschwarz/openrig/pull/724),
  [#730](https://github.com/mvschwarz/openrig/pull/730)). Keep Claude activity hooks across `rig up --existing` ([#731](https://github.com/mvschwarz/openrig/pull/731)) and warn
  when a restore can't reapply them ([#746](https://github.com/mvschwarz/openrig/pull/746)). Quote the fork parent ID ([#773](https://github.com/mvschwarz/openrig/pull/773)).
- Recognise Codex 0.160's update menu header ([#861](https://github.com/mvschwarz/openrig/pull/861)).
- Keep Pi seats' daemon routing ([#666](https://github.com/mvschwarz/openrig/pull/666)), explain Pi credential errors ([#667](https://github.com/mvschwarz/openrig/pull/667)) and
  incompatible flags ([#655](https://github.com/mvschwarz/openrig/pull/655)), and report how OMP exited at startup ([#646](https://github.com/mvschwarz/openrig/pull/646)).

### Launch, queue and Slack

- Add `runtime.readiness_timeout_seconds` ([#643](https://github.com/mvschwarz/openrig/pull/643)). Name the reached daemon when
  `rig whoami` can't find the seat ([#660](https://github.com/mvschwarz/openrig/pull/660)). Trace inventory requests that carry a
  diagnostic header ([#726](https://github.com/mvschwarz/openrig/pull/726)).
- Clarify `rig queue block --on` and external gates ([#664](https://github.com/mvschwarz/openrig/pull/664)). Sort less for the
  TUI's recent queue activity ([#816](https://github.com/mvschwarz/openrig/pull/816)).
- Keep Slack gateway records after an interrupted write ([#669](https://github.com/mvschwarz/openrig/pull/669)), and show live
  connection and recovery state in `rig slack status` ([#742](https://github.com/mvschwarz/openrig/pull/742)).

### CLI, services and terminal

- Start a stopped local daemon for `rig context add` ([#784](https://github.com/mvschwarz/openrig/pull/784)); find a context-pack
  folder created after startup ([#686](https://github.com/mvschwarz/openrig/pull/686)); accept `.mjs` and `.py` pack helpers
  ([#706](https://github.com/mvschwarz/openrig/pull/706)).
- Accept `--actor` on `rig project shadow-drain` and `shadow-stop` ([#665](https://github.com/mvschwarz/openrig/pull/665)); refuse
  FIFO inputs in `rig project experimental` ([#670](https://github.com/mvschwarz/openrig/pull/670)); show empty `rig capture`
  panes as empty ([#671](https://github.com/mvschwarz/openrig/pull/671)); close `rig mcp serve` at end of input ([#674](https://github.com/mvschwarz/openrig/pull/674)) and keep
  its reached daemon address ([#676](https://github.com/mvschwarz/openrig/pull/676)); quote mission names in `NOTES.md` ([#768](https://github.com/mvschwarz/openrig/pull/768)).
- Keep `rig env logs --tail 0` ([#673](https://github.com/mvschwarz/openrig/pull/673)); survive a corrupt cached service receipt
  in `rig env status` ([#675](https://github.com/mvschwarz/openrig/pull/675)); start terminal tiles with the daemon's tmux and
  report panes that exit at once ([#715](https://github.com/mvschwarz/openrig/pull/715)); apply backspace runs in transcripts
  ([#677](https://github.com/mvschwarz/openrig/pull/677)).

### Skills

- Point `rig compact-plan` at `claude-compaction-restore` and drop dangling skill
  references ([#683](https://github.com/mvschwarz/openrig/pull/683)); send agents changing OpenRig to `developing-openrig` ([#829](https://github.com/mvschwarz/openrig/pull/829)).
- Add the `rigs` skill to the repository, for `npx skills add mvschwarz/openrig
  --skill rigs` ([#872](https://github.com/mvschwarz/openrig/pull/872), [#881](https://github.com/mvschwarz/openrig/pull/881)).

### Docs

Refresh the developer documentation for this release, checking each claim
against the code at the time; a final pass against the release commit lands
separately.

- Refresh the README, CONTRIBUTING, SUPPORT and SECURITY ([#782](https://github.com/mvschwarz/openrig/pull/782)).
- Refresh the reference pages for specs, projects, bundles, operations and process
  ([#777](https://github.com/mvschwarz/openrig/pull/777), [#783](https://github.com/mvschwarz/openrig/pull/783), [#785](https://github.com/mvschwarz/openrig/pull/785), [#788](https://github.com/mvschwarz/openrig/pull/788), [#789](https://github.com/mvschwarz/openrig/pull/789), [#791](https://github.com/mvschwarz/openrig/pull/791), [#795](https://github.com/mvschwarz/openrig/pull/795), [#797](https://github.com/mvschwarz/openrig/pull/797), [#823](https://github.com/mvschwarz/openrig/pull/823), [#825](https://github.com/mvschwarz/openrig/pull/825)).
- Refresh the architecture pages and regenerate the CLI reference ([#775](https://github.com/mvschwarz/openrig/pull/775), [#778](https://github.com/mvschwarz/openrig/pull/778),
  [#781](https://github.com/mvschwarz/openrig/pull/781), [#787](https://github.com/mvschwarz/openrig/pull/787), [#790](https://github.com/mvschwarz/openrig/pull/790), [#792](https://github.com/mvschwarz/openrig/pull/792), [#793](https://github.com/mvschwarz/openrig/pull/793), [#794](https://github.com/mvschwarz/openrig/pull/794), [#799](https://github.com/mvschwarz/openrig/pull/799), [#804](https://github.com/mvschwarz/openrig/pull/804), [#805](https://github.com/mvschwarz/openrig/pull/805), [#826](https://github.com/mvschwarz/openrig/pull/826), [#856](https://github.com/mvschwarz/openrig/pull/856)), and update
  ARCHITECTURE, DESIGN and the TUI README ([#796](https://github.com/mvschwarz/openrig/pull/796), [#803](https://github.com/mvschwarz/openrig/pull/803), [#806](https://github.com/mvschwarz/openrig/pull/806)).
- Use `npm ci` in contributor setup ([#714](https://github.com/mvschwarz/openrig/pull/714)); ask contributors whether an agent
  could do a behaviour before adding code, and point them at the capability map
  ([#827](https://github.com/mvschwarz/openrig/pull/827), [#828](https://github.com/mvschwarz/openrig/pull/828)).

Thanks to everyone whose pull requests are in this release; they are listed in
the release notes. See [0.6.6 release notes](https://github.com/mvschwarz/openrig/releases/tag/v0.6.6) for how it
was tested and known issues.

## [0.6.5]

0.6.5 collects what was merged to main since 0.6.4. It is built from main at
`b345706b` (after [#651](https://github.com/mvschwarz/openrig/pull/651)), plus eight changes merged to main afterwards: [#652](https://github.com/mvschwarz/openrig/pull/652),
[#653](https://github.com/mvschwarz/openrig/pull/653), [#654](https://github.com/mvschwarz/openrig/pull/654), [#656](https://github.com/mvschwarz/openrig/pull/656), [#657](https://github.com/mvschwarz/openrig/pull/657), [#658](https://github.com/mvschwarz/openrig/pull/658), [#679](https://github.com/mvschwarz/openrig/pull/679) and [#681](https://github.com/mvschwarz/openrig/pull/681) (ported as [#687](https://github.com/mvschwarz/openrig/pull/687)). Work merged to
main after that point isn't included.
The changes since 0.6.4:

### Before you upgrade

- If your shell rc sets a `CODEX_HOME` different from the daemon's, align them
  (or unset the daemon's explicit selection) before upgrading. Managed resume
  now uses the daemon-selected home and does not search the other home for an
  earlier thread. With `CODEX_HOME` unset, a second install still shares
  `~/.codex`; set an absolute `CODEX_HOME` when starting a daemon to give it its
  own Codex home ([#638](https://github.com/mvschwarz/openrig/pull/638)).
- Restart the daemon after upgrading the CLI (`rig daemon stop`, then
  `rig daemon start`); the running daemon keeps its old build. The first start
  updates the database, including two new usage-sample indexes whose build time
  on very large histories hasn't been measured ([#569](https://github.com/mvschwarz/openrig/pull/569)), and installs openrig-core
  0.1.3, which running seats pick up at their next launch ([#568](https://github.com/mvschwarz/openrig/pull/568), [#591](https://github.com/mvschwarz/openrig/pull/591)).
- Give Codex seats on the default `workspace-write` sandbox network access
  inside the sandbox unless your Codex config or a managed requirement says
  otherwise; set `network_access = false` under `[sandbox_workspace_write]` to
  keep it off ([#608](https://github.com/mvschwarz/openrig/pull/608)).
- Re-apply the daemon's OpenRig settings and its matching `rig` at every seat
  launch, so shell startup files can't redirect a seat ([#618](https://github.com/mvschwarz/openrig/pull/618)).

### Highlights

- Set reasoning effort per seat with `effort` on a pod member, in profile
  `preferences` or in agent `defaults`; passed to Claude as `--effort` and to
  Codex as `model_reasoning_effort`, unchecked, and ignored by Pi ([#320](https://github.com/mvschwarz/openrig/pull/320)).
  Recognize `--effort` in Claude identity proof, so an effort-set seat passes
  the exact identity check without an unverified-identity warning ([#681](https://github.com/mvschwarz/openrig/pull/681)).
- Let Codex seats reach the local daemon under the default sandbox, after a
  short read of the Codex configuration (about 0.1 to 1.5 seconds; network stays
  off if it takes over 4 seconds). Not checked with real logins, managed policy
  bundles or on Linux ([#608](https://github.com/mvschwarz/openrig/pull/608), toward [#275](https://github.com/mvschwarz/openrig/issues/275)). Name a blocked daemon connection as
  blocked instead of advising a new daemon ([#504](https://github.com/mvschwarz/openrig/pull/504)).
- Save the current Claude conversation before shutdown, so `rig down` and
  `rig up` after `/clear` restore it. For an archived rig, the refresh skips
  another rig's live namesake and the archived row keeps its own saved
  conversation. Shutdown adds two process checks and a small file read, and a
  stalled process listing or file system can delay it. `/clear` followed
  immediately by `rig down` with no new message was checked with a real Claude
  session on Linux; a change between that read and shutdown is unverified
  ([#658](https://github.com/mvschwarz/openrig/pull/658)).
- Record the assigned session ID for fresh Claude launches ([#656](https://github.com/mvschwarz/openrig/pull/656)); confirm
  wrapped and natively installed Claude seats from the native process and the
  saved conversation ID during restore, readiness, identity checks and
  `rig seat clear-attention` ([#264](https://github.com/mvschwarz/openrig/pull/264), [#335](https://github.com/mvschwarz/openrig/pull/335), [#520](https://github.com/mvschwarz/openrig/pull/520), [#554](https://github.com/mvschwarz/openrig/pull/554)); show acknowledged
  continuity as unverified without strict restore proof ([#652](https://github.com/mvschwarz/openrig/pull/652), [#651](https://github.com/mvschwarz/openrig/pull/651)); deliver to
  Claude launcher shim chains ([#567](https://github.com/mvschwarz/openrig/pull/567)).
- Wait for an attempt-specific restore map before managed Claude compaction
  sends `/compact`: up to 25 minutes for automatic compaction, after which that
  attempt stops and automatic compaction stays off until `rig compact` runs
  again. Add `rig compact --state`, `--cancel` and `--skip-map` ([#610](https://github.com/mvschwarz/openrig/pull/610), [#633](https://github.com/mvschwarz/openrig/pull/633)).
  Stop with `occupant_generation_unavailable` when the occupant is unknown
  ([#645](https://github.com/mvschwarz/openrig/pull/645)). Teach the bundled restore skill a ranked restore map ([#591](https://github.com/mvschwarz/openrig/pull/591)). Load a
  post-compaction profile without a seat recap, with a warning ([#597](https://github.com/mvschwarz/openrig/pull/597)). Act only
  on fresh context readings ([#464](https://github.com/mvschwarz/openrig/pull/464)). Not tested against a real Claude compaction.
- Add `rig ps --resources` for host load and transcript capture cost, back idle
  capture off to once every 6 seconds, and apply transcript line and interval
  settings to running seats without a restart ([#556](https://github.com/mvschwarz/openrig/pull/556), [#624](https://github.com/mvschwarz/openrig/pull/624), [#536](https://github.com/mvschwarz/openrig/pull/536)).
- Batch tmux reads in the activity, identity and structural sweeps ([#293](https://github.com/mvschwarz/openrig/pull/293), [#309](https://github.com/mvschwarz/openrig/pull/309)).
  Defer full queue views in Slack sweeps until an item needs a post: much faster
  on a synthetic 200-row queue with few posts, about 11% slower when none had
  been posted, and still a scan of active rows. Based on [korallis/agent-stack#139](https://github.com/korallis/agent-stack/pull/139)
  by korallis and Lee ([#642](https://github.com/mvschwarz/openrig/pull/642)). Find the latest usage sample through an index,
  based on [korallis/agent-stack#137](https://github.com/korallis/agent-stack/pull/137) ([#569](https://github.com/mvschwarz/openrig/pull/569)). Run execution-view Git checks
  without blocking the daemon ([#557](https://github.com/mvschwarz/openrig/pull/557)), start fewer processes in the refocus hook
  ([#499](https://github.com/mvschwarz/openrig/pull/499)), and keep each session-boundary marker once ([#545](https://github.com/mvschwarz/openrig/pull/545)).
- Add clickable Slack questions on human decisions; older Slack apps must turn
  on Interactivity by hand ([#195](https://github.com/mvschwarz/openrig/pull/195)). Thread follow-up updates with
  `rig queue create --human-intent update --reply-to <id>` ([#155](https://github.com/mvschwarz/openrig/pull/155)). Upload local
  evidence files again, and attach video and PDF up to 50 MiB ([#298](https://github.com/mvschwarz/openrig/pull/298), [#305](https://github.com/mvschwarz/openrig/pull/305)).
  Tested against a simulated Slack only.
- Add the Oh My Pi runtime (`runtime: omp`) with per-seat state; no live
  provider session was run, and full-restore recovery of OMP seats is still open
  ([#35](https://github.com/mvschwarz/openrig/pull/35), [#41](https://github.com/mvschwarz/openrig/issues/41)).
- Check the real queue store and selected Claude hooks in `rig restore-check`
  ([#328](https://github.com/mvschwarz/openrig/pull/328)), run restore's own pre-checks against the snapshot it would use ([#636](https://github.com/mvschwarz/openrig/pull/636)),
  and report an unlocated rig spec as yellow "not checked" ([#631](https://github.com/mvschwarz/openrig/pull/631)).
- Pick and print the queue create ID before sending, and warn when a same-ID
  retry's body wasn't saved ([#495](https://github.com/mvschwarz/openrig/pull/495)). Accept `--source` outside a seat as a
  self-declared source ([#440](https://github.com/mvschwarz/openrig/pull/440)). Name the daemon asked when a queue ID isn't found
  ([#654](https://github.com/mvschwarz/openrig/pull/654)).
- Teach the route to the current project's context in onboarding and the
  bundled restore and reorientation skills: `rig context work-install` lists
  what the project declares, `--deliver` prints it all, and with several
  projects it stops with `project_required` until `--project <id>` picks one.
  Add placement guidance for project knowledge ([#679](https://github.com/mvschwarz/openrig/pull/679)).
- Validate rig specs locally without a daemon ([#566](https://github.com/mvschwarz/openrig/pull/566)).

### Behaviour changes

- Deliver a Claude send with an "unverified conversation" warning when the only
  objection is one mismatched launch token, such as after `/clear` ([#607](https://github.com/mvschwarz/openrig/pull/607)).
- Refuse `@` in pod and member IDs; `rig spec validate` can still pass such a
  spec, so run `rig spec preflight` ([#473](https://github.com/mvschwarz/openrig/pull/473)).
- Print a request-ID line to stderr on every `rig queue create` ([#495](https://github.com/mvschwarz/openrig/pull/495)).
- Exit 1 or 2 on failed daemon reads in `rig bootstrap`, `rig requirements`
  ([#202](https://github.com/mvschwarz/openrig/pull/202)), `rig env status` ([#382](https://github.com/mvschwarz/openrig/pull/382)), `rig plugin list`, `rig agent-image list`,
  `rig context list`, `rig specs ls` ([#577](https://github.com/mvschwarz/openrig/pull/577)), `rig start --all` ([#578](https://github.com/mvschwarz/openrig/pull/578)),
  `rig mode cite` ([#426](https://github.com/mvschwarz/openrig/pull/426)), `rig chatroom history` and `wait` ([#476](https://github.com/mvschwarz/openrig/pull/476)),
  `rig config reset` ([#284](https://github.com/mvschwarz/openrig/pull/284)) and `rig compact-plan` ([#579](https://github.com/mvschwarz/openrig/pull/579)); refuse
  `rig gateway human remove` when its queue lookup fails ([#531](https://github.com/mvschwarz/openrig/pull/531)); exit 1 from
  `rig plugin used-by` for an unknown plugin ([#262](https://github.com/mvschwarz/openrig/pull/262)).
- Refuse blank, non-numeric or negative `rig chatroom wait --timeout` values; a
  suffix is not a unit, so `30s` is 30 seconds and `2m` is 2 seconds ([#355](https://github.com/mvschwarz/openrig/pull/355),
  [#650](https://github.com/mvschwarz/openrig/pull/650)). Validate `rig ask --wake-timeout` ([#356](https://github.com/mvschwarz/openrig/pull/356)).
- Keep the rig record and block `--delete` when `rig down` can't confirm a
  session is absent ([#513](https://github.com/mvschwarz/openrig/pull/513)).
- Detach terminals viewing a seat session that ends, even with
  `detach-on-destroy off` ([#187](https://github.com/mvschwarz/openrig/pull/187)).
- Write Claude onboarding and trust to `<CLAUDE_CONFIG_DIR>/.claude.json` for
  permission-mode launches ([#565](https://github.com/mvschwarz/openrig/pull/565)) and to both files for classic launches when
  the daemon has `CLAUDE_CONFIG_DIR` set ([#592](https://github.com/mvschwarz/openrig/pull/592)); leave an already-provisioned
  file unwritten ([#595](https://github.com/mvschwarz/openrig/pull/595)) and a malformed one untouched ([#565](https://github.com/mvschwarz/openrig/pull/565)).
- Keep a user's own Claude status line and an unparseable settings file; such a
  seat reports unknown context usage and skips resume-token capture ([#497](https://github.com/mvschwarz/openrig/pull/497),
  [#500](https://github.com/mvschwarz/openrig/pull/500)).
- Take Claude terminal and locale variables from the seat's pane ([#326](https://github.com/mvschwarz/openrig/pull/326)), and
  pass `USER` and `LOGNAME` to seats ([#564](https://github.com/mvschwarz/openrig/pull/564)).
- Rename restore-check `seat.<s>.queue-file` to `seat.<s>.queue-store` ([#328](https://github.com/mvschwarz/openrig/pull/328));
  move an unlocated spec from red to yellow ([#631](https://github.com/mvschwarz/openrig/pull/631)); add the
  `rig.<name>.restore-preconditions` check ([#636](https://github.com/mvschwarz/openrig/pull/636)).
- Flag `handed_off_to` closures to a seat with no linked successor in a fixed
  24-hour window ([#604](https://github.com/mvschwarz/openrig/pull/604), [#341](https://github.com/mvschwarz/openrig/pull/341)); record one `closure-overdue` transition per claim
  ([#593](https://github.com/mvschwarz/openrig/pull/593)); warn on queue writes to unknown local seats ([#337](https://github.com/mvschwarz/openrig/pull/337)).
- Evaluate the 200 busiest families and mark `rig health` PARTIAL instead of
  failing ([#357](https://github.com/mvschwarz/openrig/pull/357)); name failed health sources as unavailable ([#626](https://github.com/mvschwarz/openrig/pull/626)).
- Turn notifications off with a warning for an invalid ntfy or webhook URL, and
  move URL credentials into a Basic Authorization header ([#149](https://github.com/mvschwarz/openrig/pull/149)).
- Refuse rig files that resolve outside the rig folder through a symlink when
  bundling ([#507](https://github.com/mvschwarz/openrig/pull/507)); refuse backslash-traversal and drive-letter entries and skip
  links when unpacking ([#292](https://github.com/mvschwarz/openrig/pull/292)); warn about missing or unreadable declared skills
  ([#259](https://github.com/mvschwarz/openrig/pull/259), [#274](https://github.com/mvschwarz/openrig/pull/274)).
- Bind a second TUI's control socket separately ([#205](https://github.com/mvschwarz/openrig/pull/205)); activate TUI controls
  on primary clicks only ([#549](https://github.com/mvschwarz/openrig/pull/549)).
- Parse local context pack names as YAML ([#370](https://github.com/mvschwarz/openrig/pull/370)); treat `my.host:/path` as remote
  for registered dotted hosts ([#368](https://github.com/mvschwarz/openrig/pull/368)); resolve single-quoted Slack secrets ([#376](https://github.com/mvschwarz/openrig/pull/376));
  give colon-version workflows new Library IDs ([#441](https://github.com/mvschwarz/openrig/pull/441)); stop writing kernel seat
  roles into shared `CLAUDE.md` or `AGENTS.md` ([#562](https://github.com/mvschwarz/openrig/pull/562)); keep blank lines in
  `rig transcript` ([#639](https://github.com/mvschwarz/openrig/pull/639)); print full rig names with `rig ps --full` ([#600](https://github.com/mvschwarz/openrig/pull/600)).

### Messaging and delivery

- Submit with tmux's named `Enter` key instead of `C-m` ([#540](https://github.com/mvschwarz/openrig/pull/540)).
- Retry an unreadable observation until the wait-for-idle deadline ([#603](https://github.com/mvschwarz/openrig/pull/603)), and
  report only observed facts in the `producer-link:` advisory ([#606](https://github.com/mvschwarz/openrig/pull/606)).
- Write pasted text through an owner-only temporary file ([#292](https://github.com/mvschwarz/openrig/pull/292)).
- Find panes whose working folder contains `|` ([#216](https://github.com/mvschwarz/openrig/pull/216)).
- Deliver subscriber-generated events once and in order ([#527](https://github.com/mvschwarz/openrig/pull/527)).
- Answer malformed JSON request bodies with 400 ([#587](https://github.com/mvschwarz/openrig/pull/587)).
- Compare `rig chatroom history --since` as instants ([#208](https://github.com/mvschwarz/openrig/pull/208)), and keep truncated
  ntfy titles ASCII ([#217](https://github.com/mvschwarz/openrig/pull/217)).

### Queue

- Escalate prompt-blocked work as one operator alert and resume wake retries
  once the prompt clears; keep unresolved operator routes for re-resolution
  instead of exhausting them ([#619](https://github.com/mvschwarz/openrig/pull/619), [#644](https://github.com/mvschwarz/openrig/pull/644)).
- Keep the retry path for an unclaimed baton whose wake the typing guard held
  ([#623](https://github.com/mvschwarz/openrig/pull/623)).
- Preserve shared watchdogs across park transitions ([#505](https://github.com/mvschwarz/openrig/pull/505)), and record fired
  receipts only for the latest park ([#210](https://github.com/mvschwarz/openrig/pull/210)).
- Skip stuck findings for asks already posted to their person ([#518](https://github.com/mvschwarz/openrig/pull/518)).
- Report unverified handoff custody on rows closed without a local successor
  ([#341](https://github.com/mvschwarz/openrig/pull/341)).
- Report a remote body cut off mid-response as an unknown outcome ([#336](https://github.com/mvschwarz/openrig/pull/336)).
- Keep writes addressed to this daemon's own host ID local ([#588](https://github.com/mvschwarz/openrig/pull/588)).
- Report a human-closed alert's real delivery outcome ([#296](https://github.com/mvschwarz/openrig/pull/296)).
- Retire stopped-session activity evidence ([#288](https://github.com/mvschwarz/openrig/pull/288)).
- Answer a non-numeric `whoami` recent limit with 400 ([#647](https://github.com/mvschwarz/openrig/pull/647)).

### Seats, launch and restore

- Skip damaged snapshots ([#207](https://github.com/mvschwarz/openrig/pull/207)), and order same-second snapshots and
  checkpoints by insertion ([#206](https://github.com/mvschwarz/openrig/pull/206), [#601](https://github.com/mvschwarz/openrig/pull/601)).
- Use the whole readiness allowance before timing out ([#530](https://github.com/mvschwarz/openrig/pull/530)).
- Relaunch a rig's last seat after `rig seat stop` ended the tmux server ([#325](https://github.com/mvschwarz/openrig/pull/325)).
- Remove members whose session already exited in `rig shrink` ([#431](https://github.com/mvschwarz/openrig/pull/431)).
- Address tmux sessions by exact name ([#449](https://github.com/mvschwarz/openrig/pull/449), [#614](https://github.com/mvschwarz/openrig/pull/614), [#625](https://github.com/mvschwarz/openrig/pull/625)), including sessions
  literally named `=name` ([#515](https://github.com/mvschwarz/openrig/pull/515)).
- Report failed Compose teardown ([#533](https://github.com/mvschwarz/openrig/pull/533)), and keep capture until a seat's
  termination is confirmed ([#538](https://github.com/mvschwarz/openrig/pull/538)).
- Keep periodic snapshot intervals longer than about 24.8 days ([#548](https://github.com/mvschwarz/openrig/pull/548)).
- Report a mutating handover's timeout as an unknown outcome ([#198](https://github.com/mvschwarz/openrig/pull/198)).
- Resolve `rig seat status` by canonical name ([#340](https://github.com/mvschwarz/openrig/pull/340)).
- Skip non-object transcript lines in `rig restore-packet write` ([#291](https://github.com/mvschwarz/openrig/pull/291)).
- Keep the previous recap when a recap write fails ([#209](https://github.com/mvschwarz/openrig/pull/209)).
- Report the identity hook's `tokenPersisted` from stored state ([#40](https://github.com/mvschwarz/openrig/pull/40)).

### Claude, Codex and Pi

- Press Enter once more on a visibly staged Claude startup prompt, and start
  with a warning instead of failing ([#598](https://github.com/mvschwarz/openrig/pull/598)); distinguish an unrecognized input
  box from a text mismatch ([#634](https://github.com/mvschwarz/openrig/pull/634), [#617](https://github.com/mvschwarz/openrig/pull/617)).
- Report the later reset when both Claude limits are used up ([#455](https://github.com/mvschwarz/openrig/pull/455)).
- Recognize the Codex 0.157 and 0.158 empty composer as idle, and a far
  status row as active ([#295](https://github.com/mvschwarz/openrig/pull/295)).
- Stage long Pi commands outside the terminal line limit ([#212](https://github.com/mvschwarz/openrig/pull/212)), reject failed
  Pi startup responses ([#213](https://github.com/mvschwarz/openrig/pull/213)), and run runtime version probes from a valid
  folder with a stated failure reason ([#471](https://github.com/mvschwarz/openrig/pull/471)).

### Slack

- Render ordinary https evidence links as links ([#89](https://github.com/mvschwarz/openrig/pull/89)).
- Search up to 10 history pages before re-posting an ambiguous post ([#395](https://github.com/mvschwarz/openrig/pull/395)).
- Warn about missing optional scopes in `rig slack verify` ([#334](https://github.com/mvschwarz/openrig/pull/334)), and explain
  an unavailable person registry in `rig slack enable` ([#332](https://github.com/mvschwarz/openrig/pull/332)).
- Redact upload titles ([#302](https://github.com/mvschwarz/openrig/pull/302)), and stop private downloads at their size bound
  ([#333](https://github.com/mvschwarz/openrig/pull/333)).
- Scope inbound deduplication by channel ([#452](https://github.com/mvschwarz/openrig/pull/452)), keep concurrent dead-letter
  work ([#377](https://github.com/mvschwarz/openrig/pull/377)), and settle a stopped socket loop ([#387](https://github.com/mvschwarz/openrig/pull/387)).

### TUI

- Back off repeated stream drops ([#380](https://github.com/mvschwarz/openrig/pull/380)), bound stream header waits ([#546](https://github.com/mvschwarz/openrig/pull/546)),
  follow standard SSE framing ([#535](https://github.com/mvschwarz/openrig/pull/535)), and close refused or late streams ([#204](https://github.com/mvschwarz/openrig/pull/204),
  [#543](https://github.com/mvschwarz/openrig/pull/543)).
- Recognize application-cursor arrow keys ([#429](https://github.com/mvschwarz/openrig/pull/429)), keep command argument
  whitespace ([#443](https://github.com/mvschwarz/openrig/pull/443)), and decode control-socket UTF-8 across chunks ([#203](https://github.com/mvschwarz/openrig/pull/203)).
- Keep the local reader's selection in range ([#434](https://github.com/mvschwarz/openrig/pull/434)).
- Label retired and deferred slices ([#350](https://github.com/mvschwarz/openrig/pull/350)), show the served wave-map source
  ([#428](https://github.com/mvschwarz/openrig/pull/428)), show daemon adoption as N/A for a selected project ([#552](https://github.com/mvschwarz/openrig/pull/552)), and list
  current evidence before retained proof rounds ([#553](https://github.com/mvschwarz/openrig/pull/553)).

### CLI and hosts

- Count pane-only permission prompts in the `rig ps` attention total ([#180](https://github.com/mvschwarz/openrig/pull/180)).
- Say the daemon didn't respond, instead of calling it stopped, in `rig status`
  ([#349](https://github.com/mvschwarz/openrig/pull/349)), `rig start` ([#437](https://github.com/mvschwarz/openrig/pull/437)), `rig bootstrap`, `rig discover`, `rig workflow`
  and `rig workspace` ([#439](https://github.com/mvschwarz/openrig/pull/439)).
- Bound kernel readiness waits ([#363](https://github.com/mvschwarz/openrig/pull/363)) and workflow stream connection waits
  ([#381](https://github.com/mvschwarz/openrig/pull/381)).
- Keep remote daemon health verdicts in `rig host doctor` ([#396](https://github.com/mvschwarz/openrig/pull/396)), render remote
  `rig up` errors ([#329](https://github.com/mvschwarz/openrig/pull/329)), print `rig terminal open` HTTP errors ([#229](https://github.com/mvschwarz/openrig/pull/229)), and
  keep remote terminal session quoting ([#369](https://github.com/mvschwarz/openrig/pull/369)).
- Refuse out-of-range `rig usage top` windows ([#483](https://github.com/mvschwarz/openrig/pull/483)), and report seats with
  missing counters as unknown ([#582](https://github.com/mvschwarz/openrig/pull/582)).
- Refuse self-dependencies ([#286](https://github.com/mvschwarz/openrig/pull/286)) and stale mission composition plans ([#339](https://github.com/mvschwarz/openrig/pull/339)),
  warn about dangling dependencies after a slice move ([#263](https://github.com/mvschwarz/openrig/pull/263)), read CRLF
  frontmatter ([#378](https://github.com/mvschwarz/openrig/pull/378)), and stop seeding progress checkboxes ([#338](https://github.com/mvschwarz/openrig/pull/338)).

### Files, transfer and context

- Write config files atomically where the folder allows ([#576](https://github.com/mvschwarz/openrig/pull/576)), and keep the
  saved `rig.yaml` when `rig export` fails ([#640](https://github.com/mvschwarz/openrig/pull/640)).
- Stage local context packs before publishing them ([#583](https://github.com/mvschwarz/openrig/pull/583)).
- Recognize headings indented up to three spaces ([#584](https://github.com/mvschwarz/openrig/pull/584)), and keep fenced
  examples intact in the shipped address script ([#388](https://github.com/mvschwarz/openrig/pull/388)).
- Canonicalize context root aliases ([#436](https://github.com/mvschwarz/openrig/pull/436)), and report dangling symlinks only
  when they are ([#585](https://github.com/mvschwarz/openrig/pull/585)).
- Publish complete agent images, manifest last ([#580](https://github.com/mvschwarz/openrig/pull/580)).
- Make transcript tail reads progress on damaged UTF-8 ([#581](https://github.com/mvschwarz/openrig/pull/581)).
- Explain an unresolved refocus work node and fall back to the project chain
  ([#484](https://github.com/mvschwarz/openrig/pull/484)), and use `topology.root` in the shipped `compose.py` ([#486](https://github.com/mvschwarz/openrig/pull/486)).

### Specs, bundles, proof and workflows

- Preserve file modes ([#321](https://github.com/mvschwarz/openrig/pull/321)), handle read-only sources ([#575](https://github.com/mvschwarz/openrig/pull/575)) and create output
  folders ([#258](https://github.com/mvschwarz/openrig/pull/258)) in `rig bundle create`.
- Include built-in libraries in `rig plugin used-by` ([#262](https://github.com/mvschwarz/openrig/pull/262)).
- Resolve `openrig-home:` plugin paths ([#620](https://github.com/mvschwarz/openrig/pull/620)), and load the built-in core plugin
  from a custom `OPENRIG_HOME` ([#627](https://github.com/mvschwarz/openrig/pull/627)).
- Add `orientation: role` startup files and a role line in
  `rig queue whoami --json` and the refocus hook ([#562](https://github.com/mvschwarz/openrig/pull/562)).
- Support nested mission folders in lifecycle compilation ([#211](https://github.com/mvschwarz/openrig/pull/211)), proof
  evidence ([#394](https://github.com/mvschwarz/openrig/pull/394)) and the proof watcher ([#373](https://github.com/mvschwarz/openrig/pull/373)); include mission status in
  readiness revisions ([#366](https://github.com/mvschwarz/openrig/pull/366)); count slice-local review records ([#427](https://github.com/mvschwarz/openrig/pull/427)); include
  `README.md` nodes in execution views ([#438](https://github.com/mvschwarz/openrig/pull/438)); remove temporary receipts after
  failed proof writes ([#383](https://github.com/mvschwarz/openrig/pull/383)).
- Keep cached workflow versions through parse errors ([#508](https://github.com/mvschwarz/openrig/pull/508)) and while
  unfinished work uses them ([#512](https://github.com/mvschwarz/openrig/pull/512)), recover repaired rows in place ([#442](https://github.com/mvschwarz/openrig/pull/442)),
  detect same-second edits ([#435](https://github.com/mvschwarz/openrig/pull/435), [#572](https://github.com/mvschwarz/openrig/pull/572)), and keep cache removal within the
  scanned folder ([#433](https://github.com/mvschwarz/openrig/pull/433)).
- Probe bracketed IPv6 service targets ([#215](https://github.com/mvschwarz/openrig/pull/215)), and require every Compose
  replica to be healthy ([#218](https://github.com/mvschwarz/openrig/pull/218)).
- Treat folders starting with two dots as inside their parent ([#459](https://github.com/mvschwarz/openrig/pull/459), [#524](https://github.com/mvschwarz/openrig/pull/524)).

### Platform and setup

- Bracket IPv6 daemon hosts in CLI ([#461](https://github.com/mvschwarz/openrig/pull/461)) and daemon ([#509](https://github.com/mvschwarz/openrig/pull/509)) URLs, and probe
  IPv6 registered hosts ([#398](https://github.com/mvschwarz/openrig/pull/398)).
- End open event streams after a short grace period in `rig daemon stop`
  ([#324](https://github.com/mvschwarz/openrig/pull/324)).
- Sanitize pairing requester names and prune expired pairing requests ([#149](https://github.com/mvschwarz/openrig/pull/149)).

### Docs and skills

- Ship the README in the npm package ([#272](https://github.com/mvschwarz/openrig/pull/272)), and describe OpenRig as a network
  of agents ([#297](https://github.com/mvschwarz/openrig/pull/297), [#304](https://github.com/mvschwarz/openrig/pull/304)).
- Correct the help guide's known problems, the capability page and the rig-spec
  runtime list ([#468](https://github.com/mvschwarz/openrig/pull/468)); document Pi seat folders, models and environment ([#469](https://github.com/mvschwarz/openrig/pull/469))
  and HTTP readiness ([#214](https://github.com/mvschwarz/openrig/pull/214)).
- Remove unshipped references from shipped skills ([#467](https://github.com/mvschwarz/openrig/pull/467), [#510](https://github.com/mvschwarz/openrig/pull/510)), route simple
  seat additions to `rig grow` ([#406](https://github.com/mvschwarz/openrig/pull/406)), and explain attention checks and token
  correction ([#651](https://github.com/mvschwarz/openrig/pull/651)).
- Clarify help for `rig seat handover` ([#351](https://github.com/mvschwarz/openrig/pull/351)), `rig gateway human add` ([#354](https://github.com/mvschwarz/openrig/pull/354)),
  `rig broadcast --pod` ([#322](https://github.com/mvschwarz/openrig/pull/322)) and `rig context trace --seat` ([#323](https://github.com/mvschwarz/openrig/pull/323)).
- Explain cmux's socket mode change in the README ([#609](https://github.com/mvschwarz/openrig/pull/609)).
- Add contributor architecture maps, a `developing-openrig` skill and a roadmap
  ([#282](https://github.com/mvschwarz/openrig/pull/282), [#539](https://github.com/mvschwarz/openrig/pull/539)).

### Web UI

- Keep terminal UTF-8 intact across reads ([#456](https://github.com/mvschwarz/openrig/pull/456)).
- Write `metadata.status: complete` when completing a mission ([#386](https://github.com/mvschwarz/openrig/pull/386)).
- Show the newest recent observations ([#506](https://github.com/mvschwarz/openrig/pull/506)), report unobserved CLI versions as
  unknown ([#523](https://github.com/mvschwarz/openrig/pull/523)), and return 400 for unknown audit verbs ([#501](https://github.com/mvschwarz/openrig/pull/501)).

Thanks to everyone whose pull requests are in this release; they are listed in
the release notes. See [0.6.5 release notes](https://github.com/mvschwarz/openrig/releases/tag/v0.6.5) for known
issues.

## [0.6.4]

0.6.4 is the code tested and published as the 0.6.4-rc.1 release candidate, now the normal release. Only its version and these notes changed.

```
npm install -g @openrig/cli
```

It was cut from main at `afde814f`, and since then it has changed only by the bounded changes described here: the repairs below, the web UI default, and browser access with its docs page. If something breaks for you, please open an issue.

### Two changes you might notice

**The web UI is off by default.** The daemon no longer serves the web UI's pages or its terminal connection unless you turn it on with `rig config set ui.enabled true` and then stop and start the daemon. While it's off, opening the page shows those steps, and `rig ui open` prints them. The web UI is in maintenance mode; the CLI and the TUI are the supported ways to use OpenRig.

**The daemon checks which address and which web page a request comes from.** Nothing changes for the CLI, the TUI, agents, the queue, Slack, or other OpenRig hosts that reach this machine by its IP address, its own hostname or its own Tailscale name. Two cases now need one setting:

- If you reach the daemon by a custom DNS name, an `/etc/hosts` alias or a reverse-proxy domain, add that name to `OPENRIG_ALLOWED_HOSTS`.
- If a local app or development server on another port calls the daemon from a browser, add its origin to `OPENRIG_ALLOWED_ORIGINS`.

Each refusal says which setting to add, and both need a daemon restart. The details are in [Browser access and allowed addresses](https://github.com/mvschwarz/openrig/blob/v0.6.4/docs/reference/browser-access.md) ([#358](https://github.com/mvschwarz/openrig/pull/358), [#372](https://github.com/mvschwarz/openrig/pull/372)).

### Repairs made after the candidate was cut

These repairs went into the candidate after it was cut.

- **Bundles keep binary files intact.** `rig bundle create` re-encoded binary files in agent packages ([#245](https://github.com/mvschwarz/openrig/issues/245), [#257](https://github.com/mvschwarz/openrig/pull/257)).
- **Local commands reach the daemon you started.** A daemon started with `rig daemon start --port` is now the one other commands talk to ([#246](https://github.com/mvschwarz/openrig/issues/246), [#266](https://github.com/mvschwarz/openrig/pull/266)).
- **A rig's only seat can be relaunched fresh.** `rig seat launch --fresh --stop` on a single-seat rig no longer refuses after stopping the seat ended the tmux server ([#265](https://github.com/mvschwarz/openrig/issues/265), [#267](https://github.com/mvschwarz/openrig/pull/267)).
- **More time for Claude's capability check.** A managed Claude launch with an explicit permission mode first reads `claude --help`. That check now gets five seconds instead of one. Answers arriving within the longer budget can succeed; a timeout can still refuse the launch. Slow answers were reported when several seats started at once ([#260](https://github.com/mvschwarz/openrig/issues/260), [#271](https://github.com/mvschwarz/openrig/pull/271)).
- **Seats launch after an upgrade removes the old version.** Fresh launches and restores use the running version's built-in startup files instead of failing on paths into the removed install ([#261](https://github.com/mvschwarz/openrig/issues/261), [#269](https://github.com/mvschwarz/openrig/pull/269)).
- **Claude seats take messages after a full down and up.** When a managed Claude seat resumes in auto mode, it accepts ordinary messages again once OpenRig confirms the same Claude process is running in its pane. A resume it can't confirm asks for your attention instead of starting a fresh conversation ([#287](https://github.com/mvschwarz/openrig/pull/287), toward [#273](https://github.com/mvschwarz/openrig/issues/273)).
- **Natively installed Claude is recognized.** OpenRig recognizes a native Claude install behind its managed shell wrapper, including versioned install paths. When it can't observe the runtime, ordinary delivery goes ahead with a warning; a pane that is plainly an idle shell, or the wrong recipient, is still refused ([#310](https://github.com/mvschwarz/openrig/pull/310), a follow-up to [#197](https://github.com/mvschwarz/openrig/issues/197)).
- **Restoring an older Claude seat keeps an uncertain launch.** If the resume check can't tell whether the conversation came back, the restore keeps the new session and asks for attention instead of closing it ([#345](https://github.com/mvschwarz/openrig/issues/345), [#346](https://github.com/mvschwarz/openrig/pull/346)).
- **Replacing proof files doesn't write through links.** `rig proof add --replace` now swaps in a new file, so a symlinked or hard-linked artifact no longer overwrites the other path's contents ([#307](https://github.com/mvschwarz/openrig/pull/307)).
- **Slack keeps long messages, and retry errors stay contained.** A message from a registered person is stored with its complete text; before, anything past 1,800 characters was lost. A storage error while the gateway retries undelivered events is now logged instead of escaping ([#361](https://github.com/mvschwarz/openrig/issues/361), [#375](https://github.com/mvschwarz/openrig/issues/375), [#404](https://github.com/mvschwarz/openrig/pull/404)).

### Everything else since 0.6.3

**Messaging and delivery.** An unverified runtime is reported separately from a stopped agent ([#240](https://github.com/mvschwarz/openrig/pull/240)). tmux reads use printable separators and a shell-free command path ([#179](https://github.com/mvschwarz/openrig/pull/179), [#167](https://github.com/mvschwarz/openrig/pull/167)). Native process checks no longer depend on your locale ([#239](https://github.com/mvschwarz/openrig/pull/239)). Event subscriptions cancelled during replay are released ([#233](https://github.com/mvschwarz/openrig/pull/233)). CLI request deadlines cover the whole response, and a body that fails after its headers is reported as an unknown outcome ([#201](https://github.com/mvschwarz/openrig/pull/201)).

**Queue, seats and rigs.** A blocked row keeps its park timer through a seat handover, and a rerouted row's periodic timer is retired ([#242](https://github.com/mvschwarz/openrig/pull/242)). Closed queue items show the right pickup state ([#176](https://github.com/mvschwarz/openrig/pull/176)). Discovery claims survive background rescans ([#237](https://github.com/mvschwarz/openrig/pull/237)). A seat launch that times out reports an unknown outcome ([#191](https://github.com/mvschwarz/openrig/pull/191)). Attaching accepts runtime guards for existing nodes ([#228](https://github.com/mvschwarz/openrig/pull/228)). Kernel Claude seats get the shared activity hooks ([#178](https://github.com/mvschwarz/openrig/pull/178)). An unset native Claude config selection stays unset ([#225](https://github.com/mvschwarz/openrig/pull/225)). Importing YAML over a stopped rig with the same name archives the old one and shows its ID and unarchive command ([#196](https://github.com/mvschwarz/openrig/pull/196)).

**Files, transfer and context.** SSH, rsync and Herdr output keeps UTF-8 intact across chunks ([#230](https://github.com/mvschwarz/openrig/pull/230), [#241](https://github.com/mvschwarz/openrig/pull/241)). Local rsync directory operands are preserved ([#231](https://github.com/mvschwarz/openrig/pull/231)). Atomic file edits keep the executable bit ([#235](https://github.com/mvschwarz/openrig/pull/235)). File-shaped entries are projected instead of failing ([#185](https://github.com/mvschwarz/openrig/pull/185)). Oversized suffix ranges are clamped ([#234](https://github.com/mvschwarz/openrig/pull/234)). Headings inside fenced examples aren't treated as context addresses ([#236](https://github.com/mvschwarz/openrig/pull/236)). `rig env status` says when a service receipt is stale ([#232](https://github.com/mvschwarz/openrig/pull/232)).

**Platform and setup.** Codex readiness works with providers other than OpenAI ([#222](https://github.com/mvschwarz/openrig/pull/222)). Removing Codex activity hooks leaves the rest of your config untouched ([#186](https://github.com/mvschwarz/openrig/pull/186)). Daemon liveness on Windows no longer uses `ps` ([#173](https://github.com/mvschwarz/openrig/pull/173)). Module URLs and transcript paths are portable ([#168](https://github.com/mvschwarz/openrig/pull/168)). `ps` rows whose command name contains spaces are kept ([#82](https://github.com/mvschwarz/openrig/pull/82)).

**Onboarding and repository.** The onboarding text that new seats read now covers both ways a build goes wrong, and the skills router says a project, rig or machine may add its own skills ([#303](https://github.com/mvschwarz/openrig/pull/303)). Release checks skip tag diffs when old tags are absent ([#152](https://github.com/mvschwarz/openrig/pull/152)), and security and integration PRs are asked for practical scenarios ([#224](https://github.com/mvschwarz/openrig/pull/224)).

Fixes merged to main after this candidate was cut, including many community contributions, aren't in this release. They'll ship in the next release, with their credits.

### How it was tested

Most installed and real-agent results below come from earlier builds of this candidate. The final package received the package-content/stock check and the affected Slack component checks; unchanged-path evidence was carried forward through checked package deltas.

- **Required checks:** the integrated release changes passed their recorded CI runs. The release checks cover build and packaging, types, repository checks, package test suites and an installed-package scenario.
- **Scripted checks without real agents:** installed copies of candidate builds ran the repository's scripted checks. Three known failures remain: two cases in plugin usage reporting ([#251](https://github.com/mvschwarz/openrig/issues/251), fixed on main for the next release), and `rig proof add --file` dropping a leading byte order mark from the stored file ([#250](https://github.com/mvschwarz/openrig/issues/250)).
- **A fresh first-time install** ran Claude-only, Codex-only and mixed teams through useful work, with seats handing work and review results to each other, then a warm resume and a graceful reboot. The tester approved the providers' ordinary permission prompts as a first-time user would.
- **Real Claude Code agents on a test server:** after a full down and up, a Claude seat took and answered an ordinary message, carried on with its own queue work, and kept its conversation through a daemon restart.
- **The final package's Slack checks:** tests of the installed Slack components kept long inbound messages whole. In both retry-fault cases, the gateway logged the error, kept running and delivered the event once on the next automatic retry. These used synthetic connections on Linux with the package's existing dependencies. They aren't a live Slack test or a fault trial of the whole daemon.

**Tested environments**, from the run receipts. Unlisted versions are not established by this summary.

| Run | Platform | Versions |
|---|---|---|
| Fresh install | macOS on Apple silicon | Claude Code 2.1.286, then 2.1.287 after the warm resume (the launcher version changed between phases); Codex 0.159.3; Node 24.21.0 |
| Test server | Ubuntu Linux, x86-64 | Claude Code 2.1.220, Codex 0.145.0 |
| Final Slack checks | Linux, x86-64 | Node 22.22.1; no providers |

The tested release-candidate package's SHA-256 is `5344a48a747629f71d4427ce52d24e6e1034e9097b4d5d34ec125d5396fa66b6`; 0.6.4 differs from it only in its version and release notes. The 0.6.4 package SHA-256 is `251f3622587eef7f84289292a90547dec3cc5b53a89c93600c3296da91d7445f`.

### Known limits

- **A restore can report a problem with a seat that works.** In the test-server run, `rig up` after a full down exited with an error, reporting that the Claude seat needed attention, while that seat went on to take and answer an ordinary message. `rig restore-check` also reported a failure for that rig ([#273](https://github.com/mvschwarz/openrig/issues/273)).
- **Codex under its default sandbox.** In the test-server run, Codex 0.145.0 under its default workspace-write sandbox could not reach the local daemon, blocking its queue work ([#275](https://github.com/mvschwarz/openrig/issues/275)). That run did not prove cross-seat queue handoffs; its successful queue continuation was Claude working its own row.
- **After a reboot** the daemon doesn't come back on its own. Start it with `rig daemon start`, then bring your rig back with `rig up <name>`.
- **Stopping the daemon** can report a timeout while closing connections ([#166](https://github.com/mvschwarz/openrig/issues/166)).
- **Setup's optional cmux step** can report an error.
- **Browser access** protects against unknown web pages and names. It isn't complete browser isolation, so keep the daemon on loopback or your tailnet. The browser-access page lists its other limits.
- **Windows** wasn't tested.

### Thanks

To the people whose pull requests are in this release: [@rudycelekli](https://github.com/rudycelekli), [@nvtoan0201-swe](https://github.com/nvtoan0201-swe), [@MTG-Thomas](https://github.com/MTG-Thomas), [@hobostay](https://github.com/hobostay), [@hoklims](https://github.com/hoklims), [@mvdpoel](https://github.com/mvdpoel), [@oodadoudou](https://github.com/oodadoudou) and [@Coder8124](https://github.com/Coder8124).

And to the people whose reports shaped it: [@m3ac-AllbrittenJ](https://github.com/m3ac-AllbrittenJ) for [#260](https://github.com/mvschwarz/openrig/issues/260) and [#261](https://github.com/mvschwarz/openrig/issues/261), [@rudycelekli](https://github.com/rudycelekli) for [#361](https://github.com/mvschwarz/openrig/issues/361) and [#375](https://github.com/mvschwarz/openrig/issues/375) and their fixes, [@korallis](https://github.com/korallis) for the park-timer finding in [korallis/agent-stack#61](https://github.com/korallis/agent-stack/pull/61), and [@dmelo](https://github.com/dmelo) for [#197](https://github.com/mvschwarz/openrig/issues/197).

## [0.6.3]

- Recognize running managed Claude Code seats behind OpenRig's shell wrappers
  using pane lineage, foreground process and native session identity checks.
  This repairs the 0.6.2 messaging refusal reported by
  [@dmelo](https://github.com/dmelo) in
  [#197](https://github.com/mvschwarz/openrig/issues/197)
  ([#220](https://github.com/mvschwarz/openrig/pull/220)).
- Clean up unusable snapshot helpers when their ownership is proven, instead
  of accumulating them on repeated attempts. Thanks to
  [@z4cc](https://github.com/z4cc) for
  [#188](https://github.com/mvschwarz/openrig/issues/188)
  ([#189](https://github.com/mvschwarz/openrig/pull/189)).
- Keep archived duplicate rigs out of seat-reference resolution and preserve
  another live seat's session and queue work when removing a stale node.
  Thanks to [@Farkinell](https://github.com/Farkinell) for
  [#174](https://github.com/mvschwarz/openrig/issues/174)
  ([#181](https://github.com/mvschwarz/openrig/pull/181)).

- Protect proof media from artifact writes: reject binary artifact bodies and
  require an explicit `--replace` to overwrite an existing Markdown artifact
  ([#177](https://github.com/mvschwarz/openrig/pull/177)). Repository script tests
  also run serially to prevent interference from shared build outputs
  ([#221](https://github.com/mvschwarz/openrig/pull/221)).

See [0.6.3 release notes](docs/releases/v0.6.3.md) for the verification limits.
Source regression coverage does not establish installed Claude/Fedora delivery.

## [0.6.2]

- Start with two Claude Code agents, two Codex agents, or a Claude owner and
  Codex checker, using the same first-project task and review path. Agent-guided
  setup recommends a scoped `rig` command allowance after your explicit choice;
  broader permissions remain separate
  ([#147](https://github.com/mvschwarz/openrig/pull/147)).
- Install schema-version-2 bundles into `--target` and launch from those retained
  files. Local CLI bundle paths resolve from your working directory; conflicting
  target files are preserved ([#146](https://github.com/mvschwarz/openrig/pull/146)).
  Without `--target`, `rig up <file>.rigbundle` installs into your current directory, so run it from the project folder you want.
- Refuse message delivery into a bare shell where an agent runtime should be
  running ([#150](https://github.com/mvschwarz/openrig/pull/150), fixes
  [#142](https://github.com/mvschwarz/openrig/issues/142)).
- Preserve the named target during managed launches after a tmux/host restart,
  instead of confusing it with an old bare pane binding; existing identity checks
  remain. Thanks to [@diaztunjano](https://github.com/diaztunjano) for reporting
  [#141](https://github.com/mvschwarz/openrig/issues/141), addressed by
  [#151](https://github.com/mvschwarz/openrig/pull/151).
- Repair self-host sender identity, tmux window parsing, Codex hook-path
  canonicalization, Pi input editing, TUI health display and restore diagnostics;
  carry runtime hints to Herdr and allow configured Anthropic endpoint forwarding.
  See the [community fixes and credits](docs/releases/v0.6.2.md#community-fixes).

See [0.6.2 release notes](docs/releases/v0.6.2.md) for usage and compatibility.
Installed first-use and reboot/power-loss verification remain pending; these
source changes do not establish those outcomes.

## [0.6.1]

- One version-matched agent help guide: `rig context get help`, also available
  inside the installed package when the CLI cannot run. It links setup, restart,
  permissions and instance guidance, with a support route at hello@openrig.dev
  ([#113](https://github.com/mvschwarz/openrig/pull/113)).
- `rig view show execution --project <catalog-id> --mission <mission>` selects
  a catalogued project's missions. Thanks to
  [@dajiaohuang](https://github.com/dajiaohuang)
  ([#105](https://github.com/mvschwarz/openrig/pull/105)).
- Recognize the Codex `»` conversation prompt during startup/resume checks,
  including after a dismissed hook-review panel. Unresolved menus remain gates.
  Thanks to [@dajiaohuang](https://github.com/dajiaohuang)
  ([#111](https://github.com/mvschwarz/openrig/pull/111)).
- Repair the bundled Vault skill's frontmatter and check shipped skill headers
  ([#115](https://github.com/mvschwarz/openrig/pull/115)); remove historical
  development evidence from the public source tree
  ([#118](https://github.com/mvschwarz/openrig/pull/118)) and the retired TUI
  drivability prototype ([#119](https://github.com/mvschwarz/openrig/pull/119)).
- Run eight PR test jobs, including the UI suite and one installed queue-durability
  scenario with an intentional failure control
  ([#117](https://github.com/mvschwarz/openrig/pull/117)). This does not cover all
  historical scenarios or every platform.
- Parse SQLite boot timestamps as UTC on non-UTC hosts so current identity and
  context readings are compared with the correct generation start time. Thanks
  to [@Coder8124](https://github.com/Coder8124)
  ([#124](https://github.com/mvschwarz/openrig/pull/124)).
- Recognize headerless Codex conversations with custom status-line field order
  and mixed-case model names ([#125](https://github.com/mvschwarz/openrig/pull/125));
  thanks to [@Hexgunner69](https://github.com/Hexgunner69) for the report and
  [@Aummadour](https://github.com/Aummadour) for regression cases. The separate
  stale restore-warning issue is not fixed by this change.
- Resolve a linked worktree's Git metadata directories for Codex fresh launches
  instead of passing its `.git` file as a directory
  ([#126](https://github.com/mvschwarz/openrig/pull/126)); thanks to
  [@mgall-ibizdigital](https://github.com/mgall-ibizdigital) for the report and
  suggested approach.

See [0.6.1 release notes](docs/releases/v0.6.1.md) for changes and compatibility
limits. Slack manifest/setup assistance and Rig Stream classification remain
experimental; no new validation of those experiments is claimed.

## [0.6.0]

- **Breaking:** OpenRig requires Node.js 22 or 24 and uses better-sqlite3 13.
  Node 20 is no longer supported, and the install check refuses it; Node 26 is
  untested. Switch Node, then reinstall the CLI; existing
  data is migrated in place. See [Moving off Node 20](README.md#moving-off-node-20).
  Thanks to [@jimallen](https://github.com/jimallen) for reporting the Node 26
  install failure and proposing the upgrade ([#16](https://github.com/mvschwarz/openrig/pull/16)).
- Choose permissions per seat for future launches with
  `rig seat set-permissions <seat> --mode <mode> --reason <text>`. Codex
  `full_bypass` now also sets `-a never`; Claude Code modes such as `auto` are
  accepted only when the managed executable supports them. Rig-level verbs move
  to `rig policy permissions …`, with the old verbs kept as aliases. Thanks to
  [@DoowanKang](https://github.com/DoowanKang) ([#30](https://github.com/mvschwarz/openrig/issues/30))
  and [@djogss](https://github.com/djogss) ([#33](https://github.com/mvschwarz/openrig/issues/33)).
- Protect a seat where you type by hand with `rig seat set-typing-guard`. While it
  is on, automatic messages and wakes are held instead of typed in; the default is
  unchanged. Thanks to [@some-marketing](https://github.com/some-marketing)
  ([#48](https://github.com/mvschwarz/openrig/issues/48)).
- Experimental: `rig slack manifest` prints the Slack app manifest offline, with a
  prefilled create-app link, and a new setup guide describes the manual steps.
  Creating the app remains a step you do in Slack, and the steps have not been
  confirmed against a real app creation. The existing Slack connector is not
  experimental.
- Open a whole rig in Herdr from the TUI (`term ▸ rig <name>`), up to 16 seats per
  tab in a workspace named after the rig; the empty starting tab is closed only
  when that is confirmed safe. Thanks to [@shintaii](https://github.com/shintaii)
  ([#26](https://github.com/mvschwarz/openrig/issues/26)).
- Pi seat activity reports carry the occupant generation and are accepted only
  for the seat's current occupant. Thanks to
  [@DoowanKang](https://github.com/DoowanKang) ([#29](https://github.com/mvschwarz/openrig/issues/29)).
- The kernel starter summary identifies the library preview and explains automatic
  runtime-variant selection. Thanks to [@tgrundtvig](https://github.com/tgrundtvig)
  ([#21](https://github.com/mvschwarz/openrig/issues/21)).
- Codex seats launch with `--no-daemon` when supported. Thanks to
  [@reisalbuquerque](https://github.com/reisalbuquerque) ([#69](https://github.com/mvschwarz/openrig/issues/69)).
- Missions without a `metadata` block no longer fail the readiness reader. Thanks
  to [@shravansumanthanan](https://github.com/shravansumanthanan) for the fix and
  [@kainne44](https://github.com/kainne44) for the report
  ([#72](https://github.com/mvschwarz/openrig/issues/72)).
- Experimental and optional, off by default: a classifier seat can have Jev,
  through OpenRouter, label Rig Stream observations. Check, turn on or turn off
  with `rig project experimental status|enable|disable --config <file>`, then run
  one bounded foreground `rig project wake … --experiment <file>`. Labels are
  advisory, with no accuracy or reliability claim, and the feature may be
  incomplete. See [stream classification](docs/reference/stream-classifier-worker.md).
- Report problems with either experiment through a
  [GitHub issue](https://github.com/mvschwarz/openrig/issues/new/choose) or a pull
  request ([CONTRIBUTING.md](CONTRIBUTING.md)).

Includes [#77](https://github.com/mvschwarz/openrig/pull/77),
[#84](https://github.com/mvschwarz/openrig/pull/84) by
[@mvdpoel](https://github.com/mvdpoel), [#91](https://github.com/mvschwarz/openrig/pull/91)
and [#94](https://github.com/mvschwarz/openrig/pull/94).

Release preparation: [#109](https://github.com/mvschwarz/openrig/pull/109).
An ordinary candidate-tarball install with real postinstall passed on fresh
macOS 15 ARM64 / Node.js 22.22.1, including SQLite 13, all 89 migrations,
write/reopen and unauthenticated daemon startup/shutdown. Fresh Node 24 install
and authenticated native fresh/resume/fork permission enforcement were not
completed. See the [verification scope](docs/releases/v0.6.0.md#verification-scope)
and [known limitations](docs/releases/v0.6.0.md#known-limitations). The final
artifact will be separately bound to the merged release commit.

## [0.5.17]

- Install the CLI with Bun as well as npm: `bun add -g @openrig/cli`. The package
  no longer depends on the unpublished `@openrig/daemon`; it imports the daemon
  copy it already ships, which also makes the package smaller. OpenRig still runs
  on Node.js, and Bun may block the package's postinstall check. Thanks to
  [@drewpayment](https://github.com/drewpayment) for reporting this
  ([#66](https://github.com/mvschwarz/openrig/issues/66)).

Includes [#68](https://github.com/mvschwarz/openrig/pull/68). The Node support
range and SQLite version are unchanged.

## [0.5.16]

- Let a rig write Claude Code's managed instruction blocks to `CLAUDE.local.md`
  instead of a tracked `CLAUDE.md`, with `managed_blocks: { claude-code: CLAUDE.local.md }`.
  The default stays `CLAUDE.md`, and Codex stays on `AGENTS.md`. Blocks already
  written to `CLAUDE.md` are not moved; remove them by hand after switching.
  Thanks to [@hvpaiva](https://github.com/hvpaiva) for reporting and proposing
  this ([#25](https://github.com/mvschwarz/openrig/issues/25)).
- Add an advisory portability report for pull requests. It lists added lines
  that contain machine-, network- or account-specific values. Findings never
  fail the check; operational errors, such as a git failure, still do.
- Show badges and a short demo of agents working in the README.

Includes [#54](https://github.com/mvschwarz/openrig/pull/54) and
[#56](https://github.com/mvschwarz/openrig/pull/56) by
[@mvschwarz](https://github.com/mvschwarz). The Node support range and SQLite
version are unchanged.

## [0.5.15]

- Recognize Codex through shell and Node launchers during startup and recovery,
  while keeping uncertain process identity visible.
- Skip recognized Codex update notices without installing provider updates, and
  give clearer startup recovery guidance, including `rig up <name> --existing`.
- Add the OpenRig Software Factory recipe and worked example for continuing
  reviewed work, with incremental team growth using `rig grow`.
- Guide agents through user-chosen command permissions, preserving existing rules
  and explaining project versus user scope. Permission defaults are unchanged.
- Explain provider hooks, workspace trust and other machine changes before the
  first launch.
- Show Pi replies and tool progress, retain managed OpenRig context in shell
  tools, and report bounded provider errors without exhausted-retry duplicates.
- Submit pasted Pi messages explicitly and handle input beyond the terminal's
  canonical buffer limit, including cancellation and oversized-input recovery.
- Add a guarded retry for an added seat whose first startup failed during resource
  projection; retain its complete original configuration for recovery.

Pi support remains qualified and supervised: controlled coding and continuity
were verified, but ordinary useful-task completion and unattended teamwork remain
unverified. Shipped permission defaults, the Node support range and SQLite version
are unchanged; project work-policy features are outside this release.

Includes [#37](https://github.com/mvschwarz/openrig/pull/37) by
[@danielkuykendall23-boop](https://github.com/danielkuykendall23-boop), and
[#38](https://github.com/mvschwarz/openrig/pull/38),
[#39](https://github.com/mvschwarz/openrig/pull/39),
[#45](https://github.com/mvschwarz/openrig/pull/45) and
[#46](https://github.com/mvschwarz/openrig/pull/46) by
[@mvschwarz](https://github.com/mvschwarz).

**Known compatibility limitation:** on macOS arm64 with Node 24, SQLite dependency
installation can fail when a suitable prebuilt binary is unavailable, and
compiler-built SQLite has also shown runtime cleanup failures. Use Node 22 on
that platform for now; the declared Node support range is unchanged.
See [the release notes](docs/releases/v0.5.15.md) for starting commands and guidance.

## [0.5.14] - 2026-09-14

VM inspection was accepted: generally zero-to-two-second loading with
occasional timeouts, formatting, icon colors and default views. This is an
observed result, not a general latency or availability guarantee. The completed
single-consumer Slack/phone exercise remains evidence for unchanged notifications.

- Enter a confirmed running rig directly, with responsive Help, Skip and Local
  during slow or unverified startup.
- Keep the navigator and labelled useful content during page/rig changes, slow
  reads and failures; preserve scope identity, passive prior content and confirmed
  removal semantics. Read the selected rig before unrelated fleet details.
- Send complete bounded human briefs with related thread detail, distinguish
  quiet FYIs from decisions, and retain delivery/reply correlation.
- Find instance-wide Human requests and delivered Updates in Feed; open Health,
  Configuration and Connections under System, with six top-level entries.
- Browse Feed categories, explicitly expand Specs kinds and Derived terminal
  views, and find Saved views without expanding the whole catalog.
- Read mission outcomes, current or planned owner, blockers and next dependencies
  above slice boxes at both terminal widths. Native accepted judgments drive
  completion; assigned or reopened work and mission lifecycle remain distinct.
- Reduce repeated terminal inventory work while preserving saved-view preview
  and explicit Herdr Open; no general latency improvement is claimed.
- Keep primary queue facts readable when optional blocker descriptions fail;
  bound fleet reads across stages and avoid duplicate policy/receipt read work.
- Reduce restore/startup inventory scans with selective event indexes, preserving
  history and projection results; private replay is not a live latency guarantee.
- Preserve nullable identity provenance during queue-history archival. Shared
  history, RECENT and OWNER/receipt readers now include archived records;
  unknown historical provenance stays null rather than being reconstructed.

Root, CLI, daemon and web UI are `0.5.14`; terminal TUI remains `0.1.0`.
Migration head advances to `084_inventory_event_indexes`, following review read
indexes in 083, archive identity provenance in 082 and explicit human-intent fields
in migration 081. Private installed review and controlled notification checks
retain their exact candidate and
runtime attribution. See [the release notes](docs/releases/v0.5.14.md) for
operator guidance and verification limits.

Known limitations: the inherited CLI health-check deadline can reject a queue
command before its request is sent; that defect and occasional server delay are
not fixed here. Same-candidate recovery did not establish durable responsiveness.
Bundled Workflow Specs can disappear from discovery when an upgrade changes the
install directory; that fix is explicitly deferred beyond 0.5.14. Recorded
shutdown/config-preservation uncertainties and the prior recorder-write failure
remain disclosed.

## [0.5.13] - 2026-09-10

**Status**: release candidate, unpublished. Exact-cut substance review,
release verification and publication remain pending; live adoption is separate.

- Enter the TUI with useful Help, Skip and local intent reading even while
  the daemon is unavailable or its state is unverified.
- Choose a project, read its current sources and follow links, then return
  to the same place without confusing projects that share a name.
- Separate requests needing human action from updates in ATTENTION, and
  inspect their source without implying approval.
- Preview saved or derived terminal views before deliberately opening them;
  navigate CONFIG, Help and health with readable values at narrow widths.
- Choose scoped human-led or delegated oversight and retain current context,
  assessment and action evidence without claiming improved behavior.
- Update Git-backed context through an explicit merge that preserves local
  authorship, conflicts and the distinction between selected and consumed bytes.

Root, CLI, daemon and web UI are `0.5.13`; terminal TUI remains `0.1.0`.
Migration head advances to `080_scoped_operating_posture`. Natural behavioral
effect remains **UNOBSERVED** and human time cost **UNMEASURED**. The default
multi-client control-socket limitation remains disclosed and unfixed.
See [the full release notes](docs/releases/v0.5.13.md) for usage and proof limits.

## [0.5.12] - 2026-09-09

**Status**: release candidate; exact-cut review, final verification and
publication remain pending.

- Record authorized proof judgments and corrections once; derive affected
  slice, mission and project readiness with attributable evidence.
- Inspect authored versus running graphs, deliberately adopt supported
  revisions, and reconcile ambiguous operations without duplicate work.
- Discover exception ownership before failure; admit dependency-failure
  tasks/wakes atomically and recover one occurrence without hiding another.
- Keep healthy unchanged waits quiet while preserving change-driven wake,
  bounded recovery and explicit expansion of compact reads.
- Enter through bare interactive `rig` for normal startup and selective
  return, preserving conversation history or requesting an explicit fresh start.
- Browse general instance settings and provenance in CONFIG, with Slack as
  one subsection and passive, secret-safe inspection.

Root, CLI, daemon and web UI are `0.5.12`; terminal TUI remains `0.1.0`.
Migration head remains `079_workflow_lifecycle_parallel`. Accepted development
and native evidence retains its original attribution; release preparation does
not imply a new human usability study, full-platform run or public adoption.
See [the full release notes](docs/releases/v0.5.12.md) for operational guidance
and known limits.

## [0.5.11] - 2026-09-07

**Status**: release candidate; final verification and publication remain pending.

- Start useful repository work with the focused `first-project` owner/checker
  team and an attachable shared kernel TUI.
- Inspect workflow owners and waits, declared spec purpose, effective instance
  configuration, and human connection state in the ordinary TUI.
- Navigate with command completion, readable Recent activity, and persistent
  timezone selection. Unverified daemon probes no longer read as confirmed down.
- Reuse project release profiles that retain both the release ceremony and the
  actual post-release boundary, independently of successor scope.
- Preserve context delivery and generation evidence; honor authored startup
  proof selection; improve exception routing, bounded shutdown receipts,
  startup child identity, and cross-host origin attribution.
- Diagnosis `show`/`list --json` now return summaries; use `--full --json`
  for complete evidence. Queue previews also print an exact full-read command.

Root, CLI, daemon, and web UI are `0.5.11`; terminal TUI remains `0.1.0`.
Migration head remains `079_workflow_lifecycle_parallel`.

The health-agent experiment remains a POC, and the Herdr journey requires no
plugin. Neither is a new cold-agent architecture or a plugin/adoption claim.
See [the full release notes](docs/releases/v0.5.11.md) for operational guidance
and the retained verification limits.

## [0.5.7] - 2026-09-01

**Status**: release-cut candidate. Final release-wide verification and public
publish remain release-manager gates.

### Summary For Installing Agents

- **Package versions**: root, CLI, daemon, and web UI are `0.5.7`; the terminal
  TUI remains `0.1.0`.
- **Migration**: head advances `076` → `077_node_session_source`; normal daemon
  startup applies the ordered migration list automatically.
- **Theme**: elastic topology lifecycle and coherent work delivery.

### Elastic topology lifecycle

- Create a rig without hand-authored YAML; grow existing or new pods in single
  or batch operations; and preserve faithful spec show/export, including a
  member's declared agent-image source.
- Refuse unsafe shrink while work is active. Explicit drain fallback preserves
  queue identity and state, checks that the destination session is live, and
  removes only the intended target; ordinary cleanup stays direct.

### Coherent work delivery

- Compose product-journey SDLC context across world, project, mission, and
  slice layers, with useful non-overwriting scaffold defaults.
- Accept optional project YAML enrichment with explicit warnings and default
  fallback, load Markdown by section address, and support explicit project
  selection, switching, root isolation, and ambiguity refusal.
- Project the complete catalog of public plugin-only skills together with the
  helper files their instructions reference.

### Deferred and post-release

- Restore honesty is deferred to `0.5.8`.
- Cleaned parent-host two-project dogfood runs after release.

See [`docs/releases/v0.5.7.md`](docs/releases/v0.5.7.md) for the full notes.

## [0.5.6] - 2026-08-30

**Status**: shipped; **"world-building as context engineering."** OpenRig 0.5.6 ships the context system's next layer, makes long-running agents durable, and makes messages to humans trustworthy. Three themes: the context a seat runs on is structured, tagged, and verifiable; an agent seat can now outlive its own context window without a human managing the transition; and anything routed to a human carries proof of delivery. **v0.5.6 contains v0.5.5 in full.**

### Summary For Installing Agents

- **Package version**: bumps from `0.5.5`.
- **Migrations**: THREE new (apply automatically on daemon start; no manual steps). Head advances `073` → `076`:
  - `074_context_usage_watchdog.ts`
  - `075_context_usage_watchdog_generation.ts`
  - `076_owner_notification_levels.ts`
- **Node engines**: unchanged.
- **API surface**: existing commands remain; additive verbs and configuration below.
  - New verbs: `rig view show execution`, `rig scope resolve-notes`.
  - New watchdog condition: `usage-threshold` (`rig watchdog`).
  - New continuity policy: `compaction_strategy` in the AgentSpec (four modes) with a declared `mechanic`.
  - New reference docs at stable paths: `docs/reference/sdlc-conventions.md`, `docs/reference/mission-install.md`, `docs/reference/lore-routing.md`, `docs/reference/planning-dial.md`, `docs/reference/wave-sdlc.md`, `docs/reference/release-boundary.md`, `docs/reference/product-management-pass.md`.
- **Context packs**: 41 ship (up from 39).
- **Delivery defaults**: deliberately wide open (post at `NOTICE` and above, interrupt at `ALERT` and above). Tune down from measured volume with the two dials rather than pre-filtering.
- **Continuity modes**: opt-in per seat; unconfigured seats keep today's behavior exactly.

### The context system: structured, tagged, verifiable

- **The mission install.** A documented five-layer convention (`docs/reference/mission-install.md`) for installing project context into a seat: the pieces, their arrangement, the seat's own position, the current contract, and a derive-your-own-delta step that proves the install was consumed rather than skimmed.
- **Lore routing.** What a seat learns locally routes into addressable, rig-local lore packs (`docs/reference/lore-routing.md`) — carried with a maturity stage from birth, and structurally excluded from anything that ships.
- **Taxonomy everywhere.** Every pack entering `rig context` carries its class — WORLD / LORE / SKILLS / MISSION — surfaced in listings, with a loud refusal for untagged packs.
- **A public world pack with checkable claims.** The public onboarding pack is authored as atoms whose claims each carry a check that can fail, with the verifier shipped inside the pack — public content that cannot rot silently.
- **A complete, self-retrievable skill index.** The skill router's index now covers the full shipped set, is retrievable through the routes it teaches, and carries a recurrence test so coverage gaps stay found.
- **A substance gate for what ships.** A whole-surface review pass over every packaged file (bundle and npm surfaces included) runs as a named release step; this release shipped with all 5,316 packaged files passing.

### Continuity: seats that outlive their context windows

- **Continuity policies in the agent spec.** `compaction_strategy` is now live configuration with four modes: `default-compaction`, `managed-compaction`, `handover`, and `apprentice-handover`. Modes apply to Claude seats (positive runtime matching — Codex seats keep their native behavior) and resolve through the same spec-default < profile < member precedence as the rest of the agent spec.
- **The apprentice handover, automated.** A seat declaring `apprentice-handover` gets two armed triggers: near its context threshold, the system creates a fresh successor seat and runs its onboarding install; nearer the wall, it mints an owned handover work item for the seat that executes the swap. The executing seat is declared configuration (`mechanic:` on the policy) — never inferred from topology, and arming refuses loudly if it is missing.
- **Managed compaction with honest restores.** Seats in `managed-compaction` mode get a pre-compaction prep nudge (deposit your state before the window closes) and, after a configured restore, a durable receipt recording how much usable context the restore actually recovered — so a restore that silently refills the window instead of recovering width is visible.
- **Context-usage triggers as a primitive.** `rig watchdog` gains a usage-threshold condition: fire any command when a seat's context usage crosses a calibrated per-seat threshold. The continuity modes are built on it; your own automation can be too.

### The human layer: delivery you can prove

- **No more silent fall-through.** One destination resolver classifies every dispatch: terminal-bound seats use the terminal; registered humans and virtual seats route through the gateway; nothing falls through to a terminal lookup that cannot succeed. Unregistered external addresses get a structured, teaching refusal.
- **Delivery receipts on the work item.** Every gateway post writes its receipt atomically on the queue row: `posted` (with the message timestamp and channel), `transport-failed` (with the error), or — derivably — `never-posted`. `rig queue undelivered` now consults that ledger first and returns only genuine failures. "Did this reach them?" is one read.
- **Notification levels, one vocabulary.** Queue transitions classify as `RECORD` < `NOTICE` < `ALERT` at write time — a human-required decision is `ALERT`; system ceremony events are `NOTICE`; the rest is durable record. Two independent dials configure the minimum level that posts and the minimum level that interrupts.
- **A delivery-rules engine.** Stored per-human preferences and availability decide how each message class is delivered. An `off` preference suppresses interruption — never the durable record, the post, or the receipt. Away windows defer routine traffic into digests (4-hour and daily), with exactly-once delivery by construction: durable episode identities, retry until a real receipt, and structurally non-overlapping digests.
- **Files dropped in Slack become work.** A file or image upload lands as a work item with the file transferred to local storage and referenced by path — authenticated download, size-bounded, per-file failures named, and no URL or token ever written to a row. A park blocked on a registered human automatically enters the alert path and posts exactly once per episode.

### Operational honesty

- A rate-limited seat gets exactly one timed wake at its stated reset.
- A seat holding claimed live work while sitting idle gets woken by the system, consuming the arbitrated activity oracle — with exactly one wake per park episode.
- Refocus state keys to the current occupant of a seat; a fresh occupant never inherits a predecessor's baselines.
- `rig ps` counts claimed in-progress work as assigned work.
- Sends refuse empty bodies; unknown daemon API routes return JSON 404s.
- Stuck-sweep findings stop re-minting after closure; cross-host custody verification completes durably instead of refreshing forever.
- Blocker actuation is unified: one helper, cross-host closure honest, delivery after the transaction commits.
- Rig expansion and serialization preserve what they were given: `session_source` versions, `services`, and member overrides survive round-trips; fork forwards model, role, restore policy, and label.
- `rig view show execution` derives who is building what, what is next, and each item's completion rung (locked / built / reviewed / folded / adopted) at read time — unknowns render as INDETERMINATE, never as idle or done.

### Process and reference

- The SDLC conventions document is now a component menu: choose per mission from the simple flow, the wave model, or the rigorous overlay, with planning rigor as a dial. Four full references ship at `docs/reference/`: `planning-dial.md`, `wave-sdlc.md`, `release-boundary.md`, and `product-management-pass.md`, joined by `mission-install.md` and `lore-routing.md`.

---

## [0.5.5] - 2026-08-27

**Status**: shipped; **"the ambient-attention release"** — the fleet notices, retries, escalates, diagnoses, and onboards on its own so you can stop hand-babysitting the work in flight. **v0.5.5 contains v0.5.4 in full** — one reconciled lineage.

### Summary For Installing Agents

- **Package version**: bumps from `0.5.4`.
- **Migrations**: TWO new. Head advances `071` → `073`:
  - `072_thread_seat_map.ts`
  - `073_queue_transition_wakes.ts`
- **Node engines**: unchanged.
- **API surface**: existing commands remain. New verbs: `rig parked [seat]`, `rig seat handover --source fork:|rebuild` (execute path, was dry-run), `queue block --on <blocker>` (park-with-wake), `rig gateway human` fragment-lifecycle verbs, `rig view show escalations`. `rig ps` gains a typed `ACTIVITY` column.

### Headline

**Stop babysitting the work.** `rig parked <seat>` diagnoses "is anyone silently stuck" with confidence and teaching inline; the standing stuck-sweep runs without you and routes findings. Baton wakes retry, aggregate, and escalate on their own — hand off the row and stop chasing nudges. Parks carry their own wake and read HEALTHY. `rig ps` gains a typed ACTIVITY column from one oracle. The Slack human layer is live end-to-end, and fresh installs onboard themselves.

### What you can now do

#### Diagnose silent-stuck without capture arithmetic

`rig parked [seat]` answers "is anyone silently stuck" as a derived diagnosis — activity × open obligations, with per-input confidence and remedy taught inline. **Reach for it when:** a seat looks idle and you suspect dropped work; before any `claimedAt` arithmetic or pane capture.

#### Hand off work; stop babysitting nudges

Failed baton wakes retry, aggregate, and escalate on their own (transitions ARE the ladder state, restart-safe; per-destination aggregation; rungs deliver-and-advance; unconfirmed-with-no-pickup escalates without re-send). **Reach for it when:** you hand off work — the row is enough. Watch `rig view show escalations` for the aggregates.

#### Consume the standing stuck sweep instead of running it

Overdue + undelivered become routed findings with derived evidence inline. **Reach for it when:** you used to hand-run `queue overdue` / `undelivered` on a timer — stop; consume its findings instead.

**Caveat (5.6 backlog):** cross-host successor visibility is a proven false-positive class; treat cross-host-lineage findings as unverified until the 5.6 detector fix. Contained fleet-wide one-per-condition; delta teaches the caveat.

#### Park a row on a real blocker without waking the attention machinery

`queue block --on <blocker>` records the wake; held-with-live-wake is not flagged; auto-unparked owners get an honest wake. **Reach for it when:** imminent-but-blocked work; for not-imminent work use the workspace instead (the queue is a conveyor).

#### Read seat activity from one oracle

`rig ps` carries a true `ACTIVITY` column — typed taxonomy (working / idle-at-prompt / needs-input-as-count+reason / unknown) with evidence ladder + visible rung degradation, seat-keyed across swaps. **Reach for it when:** any "is it thinking or stuck" question — the oracle beats capture; the TUI reads the same truth.

#### Execute seat handover, not just plan it

`rig seat handover --source fork:` (carries live context) or `rebuild` (primes from the durable chain and names its priming artifacts). Mid-swap failures record honestly. **Reach for it when:** replacing an occupant — no more dry-run-only planning surface.

#### Reach human decision owners directly through Slack

Gateway running, thread-per-seat, exactly-once inbound reconciliation, escalation loudness (mention) distinct from routine. Humans are addressable members; `rig gateway human` has full fragment-lifecycle verbs. **Reach for it when:** anything must reach a human decision owner — an escalation-class send arrives loud on their phone.

#### Onboard fresh installs without hand-walking

Fresh installs get focused onboarding packs by default (config off; existing rigs untouched). **Reach for it when:** standing up a new rig or seat — stop hand-walking the eight pieces.

#### Trust refocus to fire only when it should

Refocus fires at a context threshold or on demand — NEVER at session start (post-compaction both runtimes; usage threshold Claude-only). **Reach for it when:** a long session loses the plot — trigger it. A fresh seat getting a refocus is now a bug to file, not noise to ignore.

#### Author scopes with the one-file convention

`scope mission create` → `NOTES.md` + intent-bearing `SPEC`; `slice create` → `SPEC`-only (no IMPLEMENTATION-PRD) + acceptance `PROGRESS`; release missions get a capability-delta scaffold. `repair` is ADDITIVE — stamps append, never rewrite author frontmatter. **Reach for it when:** creating any scope node — stamp verification is a mechanical strip again.

#### Bind daemons safely from any managed environment

Daemon bind intent has provenance: an inherited `OPENRIG_HOST` never selects single-bind; adoption gates test ALL required listeners. **Reach for it when:** daemon maintenance from any managed environment — no more `env -u` ceremony.

### What to STOP doing (each was correct under 0.5.4 and is wrong now)

1. **STOP the per-lock author-reconstruction protocol.** `scope repair/approve` used to rewrite author frontmatter; now stamps APPEND — strip-reconstruction is mechanical; the protocol is retired.
2. **STOP diagnosing parks by `claimedAt` arithmetic + capture.** `rig parked` derives the diagnosis with confidence and teaching; capture is a fallback glance, not the method.
3. **STOP storing deferred work as queue rows.** The queue is a conveyor for imminent sequential work; deferred work lives in the mission workspace and re-mints when due.
4. **STOP authoring `IMPLEMENTATION-PRD.md` and `MISSION_NOTES.md` on new work.** `SPEC.md` is the one spec file; `NOTES.md` is the chain name; locks bind SPEC-only.
5. **STOP routing contact through an orchestrator by default.** Any agent escalates directly; orchestrators/PMs also send judgment-worthy updates.

### Landed, not yet drivable (recorded so nobody reaches for it)

- Delivery preferences + availability (stored, validated) — no rules engine consumes them yet (0.5.6 slice 01).
- S01 operator rung — human-layer connector delivery leg lands in 0.5.6 (S11 territory). Escalation view + daemon health carry the floor now.
- `@external` addresses on the direct send path fall through to tmux (routing fix in 0.5.6 wave-2). Reach humans via the gateway path (queue/escalation), not raw `rig send` to `@external`.
- Multi-human topology — single-human ships as an honesty marker; multi-human is 0.5.7.

### Known Limitations (0.5.6 backlog)

- **Cross-host successor visibility false positives** in the stuck-sweep detector — 39 active findings at census (20 proven FP, 19 unverified); contained fleet-wide; fix lands in 0.5.6 wave 1.
- **`@external` direct-send routing** — 0.5.6 wave-2 routing fix.
- **Delivery preferences → rules engine** — 0.5.6 slice 01.

---

## [0.5.4] - 2026-08-26

**Status**: release candidate; **"the honesty release"** - commands distinguish absence, uncertainty, staging, and completed effects instead of collapsing them into reassuring output. **v0.5.4 contains v0.5.3 in full** - one reconciled lineage, no product divergence.

### Summary For Installing Agents

- **Package version**: bumps from `0.5.3`.
- **Migrations**: none in this release. Migration head stays at 071 (matching 0.5.3).
- **Node engines**: unchanged.
- **API surface**: existing commands remain; new seat lifecycle verbs are `rig seat set-model`, `rig seat stop`, and `rig seat clean`.

### Headline

**Trust what the command says, including when the answer is uncertain.** Transport probes now classify found, absent, and indeterminate outcomes through one resolution path. Delivery verification distinguishes text staged in a prompt from text consumed by an agent. Queue, refocus, preview, import, and lifecycle surfaces preserve the state and refusal that actually occurred.

### What you can now do

#### Resolve transport failures without inventing a missing seat

Send, capture, nudge, and walk use one classified session probe. A transport blip is reported as indeterminate rather than `Session not found`, while genuine absence remains explicit. Recovery output names what was checked and what action is available.

#### Tell staged delivery from consumed delivery

`rig send --verify` classifies the pane effect instead of equating typed text with a completed turn. Single-recipient, fan-out, and JSON results derive from the same outcome model, so a staged prompt is not reported as consumed.

#### Deliver unknown-sender messages honestly

An unattributable message is delivered with an unknown-sender notice instead of being refused. Where a reply path exists, the sender is told that attribution was unavailable and should follow up with a signed message.

#### Manage one seat through supported lifecycle verbs

`rig seat set-model`, `rig seat stop`, and `rig seat clean` provide audited, single-seat operations. Stop and clean refuse when any affected session is live or indeterminate; set-model is proven against a real managed successor rather than only stored configuration.

#### Trust state-preserving queue and refocus behavior

Adding a queue note no longer changes terminal state. Envless owned queue listing refuses instead of silently changing scope. Refocus keeps due state until delivery is visible. Bounded previews say they are bounded.

#### Refuse duplicate running rig names at every import path

Create and import routes now share one running-name guard. A duplicate running name returns a teaching `409 rig_name_running` refusal instead of spending resources or degrading into a generic server error.

### Stability and authority fixes

- Startup boundaries are hermetic across scratch/test environments.
- The bundled `openrig-core` plugin has an explicit advancing authority, so an older runtime cannot silently overwrite newer installed guidance.
- Stale lab refocus registrations are retired.
- CLI and daemon refusal codes survive route and import boundaries without fallback noise.

### Known Limitations (0.5.5 backlog)

- **Writer-layer disk cap** - the one-time VM cleanup recovered headroom, but the permanent cap at the layer that writes snapshots is unfinished.
- **Repair/approve frontmatter rewrite** - the known rewrite defect remains outside this release.
- **Observation pipeline performance** - shared pane/process observation remains measurement-gated; 0.5.4 does not claim the broader polling/census redesign.

---

## [0.5.3] - 2026-08-26

**Status**: shipped; **"the context release"** — pull exact context by address instead of reading files. **v0.5.3 contains v0.5.2 in full** — one lineage, no divergence.

### Summary For Installing Agents

- **Package version**: bumps from `0.5.2`.
- **Migrations**: none in this release. Migration head stays at 071 (matching 0.5.2). Nothing to apply on a v0.5.2→v0.5.3 upgrade.
- **Node engines**: unchanged.
- **API surface**: preserved from v0.5.2; no CLI-command or flag removals or renames.
- **New CLI verbs**: `rig context get`, `rig context list`, `rig context profile`, `rig context recap-write`.

### Headline

**Pull exact context by address instead of reading files.** `rig context get <pack-ref>/<file>#<H2-slug>[/<H3-slug>]` returns the exact span bytes of one section. The `openrig-skills` router teaches the three-step: ask → ref → load. Refocus resolves refs automatically. Handovers write a durable, superseded-chain seat recap. Composition is by reference, so there is no second copy to drift.

### What you can now do

#### Pull exact context by address, not by reading files

`rig context get <pack-ref>/<file>#<H2-slug>[/<H3-slug>]` returns the exact span bytes of one section. The `/<file>` component is required even in a one-file pack. A bogus slug fails loud and lists the addressable sections. `rig context list` shows every shipped entry's ref and name; `rig context show` inspects one. Refs are canonical full paths (e.g. `skills/<namespace>/<name>`). Cross-source access (`seat:` / `mission:` atoms) is an authoring affordance: declared in pack manifests and granted via `rig context profile --rig/--seat/--mission` during composition — not an ad-hoc argument to `get`.

**Reach for it when:** you need one section of a shipped skill or library entry and would previously have read or copied the whole file.

#### Discover context by asking, not by guessing paths

The `openrig-skills` router teaches the three-step: ask → ref → load. Run `rig context list` for refs, match your moment to an entry's `when`, load by ref.

**Reach for it when:** you don't know which skill or context applies, or nothing is projected after a cold boot.

#### Write a durable seat recap

`rig context recap-write` maintains a seat-scoped `RECAP.md` beside `LEARNED` with a collision-safe superseded chain; restore packets carry an authored-recap pointer.

**Reach for it when:** handover, compaction boundary, or any moment your successor would otherwise re-derive your state from scrollback.

#### Trust refocus to resolve refs

The refocus hook resolves library refs automatically (ref beats file), fails loud but non-blocking, and delivers pointers — the shipped channel for pointing running seats at new content.

#### Fetch bounded domain expertise on demand

`rig context get` serves expertise packs by path-like ref, e.g. `skills/process/context-engineering`. The old `context-pack:` colon form was removed and the CLI says so.

**Caveat that pack:** it is titled "Traditional Context Engineering — 2024-2025 Snapshot" for a reason — provisional, historical, non-normative by the project owner's ruling. Current OpenRig skills, explicit user rulings, and measured practice outrank it on any conflict.

### What to STOP doing (each was correct under 0.5.2 and is wrong now)

1. **STOP copying library content into seat or mission files to compose context.** Compose by ref — addressing means there is no second copy to drift. Nothing catches the copy automatically; it is still a defect by rule.
2. **STOP treating a `MODEL DIVERGENCE` proclamation as alias noise.** The canonicalize-then-compare fix ended the pinned=fable / effective=claude-fable-5 false-positive class, and the monitor now isolates per-seat throws. A proclamation on this runtime is a real escalation — act on it.
3. **STOP confusing explicit-path requirements with permission.** The guards described in this release demand explicit paths (e.g. `OPENRIG_SKILL_CANON_ROOT`); that mechanism does not grant authorization. **Historical guidance correction (2026-09-10):** the earlier approval statement was project-specific, not a universal rule. Current project and mission authority determines whether local commits, apply operations, pushes or PRs require approval.
4. **STOP hand-placing evidence or trusting a placeholder PRD as the proof contract.** `rig proof add` pairs evidence to the contract, and a pristine scaffold PRD can never silently become that contract: the authored SPEC serves with a named advisory (`contractSource` in the echo tells you which source bound).

### Landed but not yet drivable (recorded so nobody reaches for it)

Eval CASES ship (14 selection/loading cases), but no runnable grading pass exists today. `--provider rig` is the live proof-contract door and is NOT YET DRIVEN — it says so itself and redirects to fake (the wiring is exactly the convergence-test driver work in flight). `--provider fake` replays only transcripts supplied via `--transcripts <map.json>` and errors every case without one. When the live door is driven, the next release promotes this to a capability.

### Known Limitations (5.4 backlog)

- **Reply-hint self-qualify** — still open from 5.2; reply-hints on some cross-host messages address themselves via machine-ID rather than registered host name; substitute the registered host name from `rig host list`. Fix in 5.4.
- **Eval grading pass** — CASES ship; no runnable grading pass yet. Driven `--provider rig` lands in 5.4.
- **`rig send --verify` does not detect staged-unsent** for multi-line sends toward Claude seats — carried from 5.2 backlog.
- **Claude transcripts thin under fullscreen upsell** — carried from 5.2 backlog.
- Plus internal debt items ledgered for maintenance.

---

## [0.5.2] - 2026-08-22

**Status**: shipped; test system exercises for real, crash-cart fleet-restore conductor, reliability fixes shipped through the test system. **v0.5.2 contains v0.5.1 in full** — one lineage, no divergence.

### Summary For Installing Agents

- **Package version**: bumps from `0.5.1`.
- **Migrations**: none in this release. v0.5.1 shipped migrations 068-071 (068 CREATE + 071 DROP-IF-EXISTS pair, net no-op for any v0.5.0→v0.5.1 upgrader); v0.5.2 stays at 071.
- **Node engines**: unchanged.
- **API surface**: preserved from v0.5.1; no CLI-command or flag removals or renames.
- **New bundled skills**: none (this release is crash-cart + reliability focus).

### Headline

**A test system that catches real bugs on its own product, plus a crash-cart fleet-restore conductor.** The reliability fixes in this release were found and validated by scenarios that drive the real product through the same commands a person uses. Type bare `rig` at a dead daemon and you now reach a truthful cockpit; one Enter restores the fleet kernel-first with surviving tmux panes adopted.

### Crash-cart fleet-restore conductor

Type bare `rig` at a dead daemon and reach a truthful cockpit — no cryptic error, no silent failure. One Enter restores the fleet kernel-first, adopts any surviving tmux panes (never clobbers them), and presents an exact per-seat remediation walkable in one keystroke. Cancel is honest. Destructive restore is only offered when adoption cannot succeed. Ten build rounds, four independent gates, non-author QA door test.

### Daemon event-loop no longer hangs under load

A class of daemon event-loop freeze under load is fixed and measured. If your daemon was going unresponsive under fleet-wide activity, that's this class.

### Unattended Claude seat handover

Outgoing Claude seat writes a recap and submits its packet automatically at handover (compaction, session boundary, explicit handover); incoming seat picks up with the recap in hand rather than a cold start. Door-proven end-to-end.

### `rig policy` honest under adversarial input

Malformed or hostile policy input now produces honest structured errors rather than silent failure or unexpected behaviour. Three review rounds.

### Cross-host messages carry their machine of origin

Messages sent across hosts now include the machine they came from, so multi-host coordination reads correctly at the receiving end. Enforced end-to-end via door tests.

### Codex model-config drift detector

A new detector for a class of Codex model-config drift that would previously go unnoticed. Caught real cases on landing.

### Test-integrity

- Test runner refuses to run against a dirty tree — a green run means green source.
- Hermetic test roots.
- Flaky fixtures isolated.

### Governance in code

- Plan locks are explicit (chosen when you ask for one), not inherited from ambient state.
- Wake is opt-in.

### Container tar-file hang eliminated at the seam

A class of container tar-file hang is dead by construction — not worked around, but the seam that made it possible is closed.

### Known Limitations (5.3 backlog)

- **Reply-hint self-qualify** — reply-hints on some cross-host messages address themselves via machine-ID rather than registered host name; using the reply-hint directly may fail with "no registered host X". Substitute the registered host name from `rig host list`. Fix in 5.3.
- **`rig queue handoff --summary`** warns yet the field is unsettable on its own output. Fix in 5.3.
- **`rig send --verify` does not detect staged-unsent** for multi-line sends toward Claude seats. Multi-line sends can stage silently.
- **Claude transcripts thin under fullscreen upsell** — upstream fullscreen upsell writes `"tui":"fullscreen"`; one accepted prompt can re-flip a fleet. Fix + pin + prevention in 5.3.
- **Test runners can silently skip on unbuilt trees** — a final-gate rule (build CLI + assert zero skips) is adopted for the release ceremony; product-side fix in 5.3.
- **`seat-handover` model-fidelity real-Codex end-to-end** fails identically on main (environment-vs-product distinction unrooted). Isolation fix in 5.3.
- Plus internal debt items ledgered for maintenance.

---

## [0.5.1] - 2026-08-12

**Status**: shipped; a test system for the product, plus reliability fixes shipped through it. **v0.5.1 contains v0.5.0 in full** — one lineage, no divergence.

### Summary For Installing Agents

- **Package version**: bumps from `0.5.0`.
- **Migrations**: additive only. Existing v0.5.0 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **API surface**: preserved from v0.5.0; no CLI-command or flag removals or renames.
- **New bundled skills**: none (this release is test-system + reliability focus).

### Headline

**A test system for the product, plus reliability fixes shipped through it.** Scenarios drive the real product through the same commands a person uses, so it can prove its own behaviour without a human checking by hand. The reliability fixes of this window ship through the test system — proving its value on its first cycle.

### Test system

- **Stub runtime for tests** — a fake agent runtime that scenarios can drive. Lets scenarios exercise the daemon end-to-end without needing a real Claude or Codex process.
- **Scenario format + runner** — a text-based scenario format and an executor that runs scenarios against the real product. Includes a real fix that surfaced from writing the runner: text-matching against a pane or transcript could never match its two intended surfaces; now it does.
- **Seed scenarios** — three seed scenarios that run green end-to-end against the real product. See Known Limits for the seed-scenario one that could not be built.

### Container test bed — scaffolding

- **Scaffolding for container mode** — argument builders, image-identity stamping, runbooks, and a unit suite. **The runner does not yet execute in containers** — this is scaffolding you will see in the tree but that no test currently drives. Container-mode execution is scoped forward.

### Reliability fixes shipped through the test system

- **Honest render for daemon transport failures** — the operator sees the actual failure rather than a silent no-op or generic error.
- **Queue-persistence** — two fixes ensuring queue records reflect what actually happened after they were written.
- **Cross-machine send regression** — found and fixed during verification. The test system doing its job: proving product behaviour across machines and catching a regression before release.

### Small features

- **Per-agent model from spec** — each agent's model comes from its spec rather than a fleet-wide default, so different agents can run on different providers or models.
- **Token usage tracked over time** — the daemon records token use so operators can see trends and predict when a seat is approaching a usage limit.
- **Machine-of-origin on messages** — messages carry the machine they came from, so multi-host coordination is legible.

### Other

- **UI timing hardening** — UI tests no longer fail on load-timing flakes.
- **Queue records tell the truth after they are written** — a class of wrote-it-and-it-did-not-stick issues closed.
- **Unreached-message visibility** — show messages that never reached an agent. On landing, this surfaced nine real handoffs that had been silently lost since 8 August.

### Known Limits

- **Container mode is scaffolded but not driven** — no test currently executes in a container. Scoped forward.
- **Seed scenarios: three of the intended set run green** — the tenth cannot be built without two capabilities that do not yet exist in the product (a scenario cannot mutate the running system's shape; the terminal interface exposes navigation state rather than fleet inventory). Both scoped forward.

---

## [0.5.0] - 2026-08-06

**Status**: shipped; mission control TUI + context library + permission-policy built-ins + provider usage observability + plan amendment + honest CLI + build discipline. **v0.5.0 includes everything from v0.4.8** — there is no divergence between the two releases.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.8`.
- **Migrations**: additive only.
- **Node engines**: unchanged.
- **New bundled skills**: `applying-a-permission-policy` and `delegating-work` join the shipped set alongside the v0.4.8 skills. Two additional skills (`retiring-and-inheriting-a-seat` and `oversight-team`) are still at draft stage and will land in a future release once they mature.
- **Behavior change**: `rig.yaml` startup `context_pack` entries are no longer delivered at instantiation — they are rejected with a teaching error pointing at `rig context compose` + a delivery command.

### Headline

**Mission control in the terminal + context library + permission-policy built-ins.** Typing `rig` (or `rig tui`) opens the new TUI: file-tree navigator, dense agent detail (working directory, runtime, context %), a topology graph with the whole fleet on one screen, honest status/activity language, motion design, working scrolling, and honest width-clip indicators throughout. The context library ships as a first-class store-and-compose noun (`rig context`) with paced delivery via `rig walk` and attached-context on `rig send` / `rig broadcast` / `rig queue create` via `--context` / `--body-context`. The v0.4.8 permission-policy foundation gets its **four built-in templates** (`locked`, `standard`, `open`, `yolo`) plus `none` as a deliberate no-policy choice, plus an agent-driven translator skill.

### Permission policies — built-in templates + custom + agent-driven translation

Building on the v0.4.8 permission-policy foundation, v0.5.0 ships the built-in policy templates plus the skill that applies them:

- **Four built-in policy templates**: `locked`, `standard`, `open`, `yolo`. Read-only from the package; copy to customize. Plus `none` as a deliberate no-policy choice.
- **`rig setup --policy <name>`** — records the chosen policy into a rig spec. Takes a built-in name (`locked | standard | open | yolo | none`) or a path to a custom policy file (custom policies live as `.policy.md` files you author).
- **`applying-a-permission-policy`** (bundled skill) — reads the policy spec at rig setup / preflight, checks the seat's current harness version, shows the concrete diff before writing, and lands the config into Claude `~/.claude/settings.json` and/or Codex `config.toml`. Never blind writes. Agent-driven on purpose — harness permission formats change frequently across versions, so a deterministic writer would break the moment the harness surface shifts.
- **Two surfaces**: the **launch-flag** surface (Claude `--permission-mode`, Codex sandbox/bypass, Pi `--approve` / `--no-approve`) is stable and OpenRig-set for you — the floor (Claude `acceptEdits`, Codex workspace-write) and the full-bypass YOLO mode live here. The **config-file** surface (Claude `~/.claude/settings.json`, Codex `config.toml`) is where allow/ask/deny rules live and where the skill applies your chosen policy.
- **Deterministic vs best-effort**: the launch-flag floor and YOLO are deterministic. Fine-grained config-file rules are best-effort because harness rule grammars vary; the skill surfaces the caveats (prefix collisions, target-first leaks, Claude's lack of a native network gate) via the diff-before-write flow. If a translation is uncertain, hand-editing the harness's own settings file — or falling back to YOLO / floor as blunt instruments — remains a valid path.

### Permission-writer guarantee, now test-pinned

- **OpenRig writes zero permission entries into your `~/.claude/settings.json`** — pinned by a permanent guard test plus an empty-writer sweep. The one sanctioned exception is the project-local `acceptEdits` floor that v0.4.8 itself defines.
- **Warning ordering during permission-policy discovery** — pre-existing main-floor warnings emit first, then the permission-policy attachment warning. Presentation-only; semantic fence unchanged.

### Context library

- **`rig context`** — stores and composes context packs. Nouns store and compose; `rig context` never delivers on its own.
- **`rig walk`** — delivers a stored context pack paced.
- **`--context` / `--body-context`** — attach a stored context pack (by reference) to `rig send`, `rig broadcast`, or `rig queue create`. Snapshot + provenance preserved.
- **Grammar (strict)**: nouns store and compose; verbs deliver. The old v0.4.x context-window usage viewer is removed; the `rig context` name now belongs to the library.

### Behavior change (v0.4.8 → v0.5.0)

- **`rig.yaml` startup `context_pack` entries are no longer delivered at instantiation.** They are rejected with a teaching error pointing at `rig context compose` + a delivery command (`rig send --context`, `rig broadcast --context`, `rig walk`, or `--context` / `--body-context` on `rig queue create`). The bundle router still stores the pack; it just doesn't auto-deliver it at startup. Users who adopted startup `context_pack` on v0.4.8 (shipped days ago; small window) should migrate to the compose + delivery-command pattern.

### Provider usage observability

- **`GET /api/provider/usage`** + **`rig provider status`** — the daemon tracks account-level usage per host so operators can answer "am I about to hit a usage limit". Explicit-unknown when the provider doesn't report it; conflict-shows-both-facts when signals disagree. Codex account-switch flows are preserved.

### Plan amendment done right

- **`rig scope slice approve --re-approve --reason "..."`** — re-stamps a locked plan with an append-only audit trail, replacing an earlier workaround where an already-approved status forced a Status-note edit.

### Honest CLI output

- **`rig ps`** — says when it is showing one rig of many rather than silently limiting.
- **`rig send --json`** — returns structured errors as `{fact, consequence, action}`.
- **Activity-hook fix** — ends the fleet-wide "producer link stale" advisories that were firing on every send. Operator-facing quality improvement.

### Build discipline

- **Contributor gates and lanes** have a single source of truth at `docs/reference/developing.md`.

### UI status (unchanged from v0.4.7)

- **Web UI remains in maintenance mode** as introduced in v0.4.7 — still ships, still runs, no new feature work. CLI/TUI is the primary surface; v0.5.0's TUI (`rig` / `rig tui`) is where mission-control investment lands going forward. The UI is not deprecated and not removed; existing deployments continue to work.

### Known Issues

- **Codex `HOME` fix not landed in v0.5.0** — a permission-posture fix that ensures the daemon and Codex seats agree on the `HOME` environment (so the posture writes reach the seat) was accepted for v0.5.0 but was inadvertently omitted from the shipped build. It ships as an early bug-fix in v0.5.1. In the meantime, the v0.4.8 deployment note applies: **the daemon's `HOME` must equal the seat's tmux `HOME`** for the permission-posture writes to reach Codex seats — verify this on any remote-host upgrade.

---

## [0.4.8] - 2026-08-05

**Status**: shipped; permission-posture fast-follow + permission-policy foundation.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.7`.
- **Migrations**: additive only. Existing v0.4.7 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Default launch posture changed**: from hardcoded `--permission-mode acceptEdits` to configurable, default `dontAsk`. If a seat needs the prior behavior, `acceptEdits` remains selectable; a deliberate `bypassPermissions` is preserved untouched across writes.

### Headline

**Permission-posture fast-follow + permission-policy foundation.** Launch posture is configurable, the deny set writes at a level project-local approvals can't override, and dangerous operations are gated by explicit prefix rules that actually hold under the current Claude harness. The **permission-policy foundation** (harness-neutral schema + `rig setup --policy` flag) lands as the framework the built-in templates + `applying-a-permission-policy` skill ride on top of in v0.5.0.

### Configurable launch posture

- **`--permission-mode` no longer hardcoded** — replaced by a configurable posture defaulting to `dontAsk`. This closes the class of freezes where an autonomous seat could get stuck on a modal permission prompt with nobody to click through it. `dontAsk` is the default because it matches what an autonomous seat can actually respond to; `acceptEdits` remains selectable when a seat needs the prior behavior.

### Deny set that project-local approvals can't override

- **Writes go to user-level `~/.claude/settings.json`** instead of the project-local approval file — so **deny wins over project-local approvals**. Writes are additive (never destructive to sibling keys) and forward-migrate a legacy `acceptEdits` value into the new schema. A deliberate `bypassPermissions` value is preserved.

### Bounded-dangerous deny set

- **Four dangerous operations gated by default**: `git push`, `gh pr create`, `npm publish`, and `rig down`.
- **`rig down` gated via the prefix rule `Bash(rig down:*)`** — the current Claude harness (2.1.220) only supports prefix matches on Bash rules, and flag-only patterns provably don't gate target-first forms such as `rig down <rig> --force`. The prefix rule is the only shape that actually holds. Plain `rig down` is gated in v0.4.8; selective allowance (e.g. `rig down <rig>` for a specific target) is deferred to v0.5.0 server-side enforcement.

### `rig up` un-gated

- **The prior release's ask-gate on `rig up` is removed** — `rig up` is a reversible operation and doesn't warrant an interactive gate.

### Permission-policy foundation (built-ins land in v0.5.0)

- **Harness-neutral policy schema** — the permission-policy spec is a harness-neutral surface with `default_posture`, `floor`, and `allow` / `ask` / `deny` expressed as **semantic actions** (`push_to_remote`, `force_push`, `delete_files`, `read_secrets`, `create_pr`, `publish_package`, and so on) rather than raw shell-command patterns.
- **`rig setup --policy <name>`** — a new flag on `rig setup` records a permission-policy choice into an existing rig spec. Takes a built-in name or a path to a custom policy file. The **built-in policy files themselves land in v0.5.0**; v0.4.8 ships the framework that consumes them.
- **Two surfaces**: the **launch-flag** surface (Claude `--permission-mode`, Codex sandbox / bypass flags, Pi `--approve` / `--no-approve`) is stable and OpenRig-set for you — the floor and full-bypass YOLO live here. The **config-file** surface (Claude `~/.claude/settings.json`, Codex `config.toml`) is where allow/ask/deny rules live; because harness rule grammars change frequently across versions, this surface is applied interactively by an agent-driven skill (that skill ships in v0.5.0 as `applying-a-permission-policy`).

### Deployment Note (operators read this)

- **The daemon's `HOME` must equal the seat's tmux `HOME`** for the posture writes to reach seats. This is a Claude 2.1.220 settings-path invariant that matters for the remote-host leg of any upgrade. Local-only hosts satisfy this automatically; remote-host upgrades should verify HOME parity between the daemon process and the tmux seat process before treating the upgrade as complete. (v0.5.0 documents this as a Known Issue for Codex `HOME` divergence; the product fix ships in v0.5.1.)

### Superseded

- **An initial v0.4.8 attempt was withdrawn on final review** — it baked `dontAsk` as a **platform default** rather than an OpenRig-side default. The shipped v0.4.8 is a re-scoped permission-agnostic base plus a policy-spec system. Nothing from the withdrawn attempt shipped.

---

## [0.4.7] - 2026-08-03

**Status**: shipped; recovery honesty + starter bootstrap + skills wave + Slack connector + UI maintenance-mode milestone.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.6`.
- **Migrations**: additive only. Existing v0.4.6 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Rig-spec starter behavior change**: rigs instantiated before v0.4.7 need re-instantiation (or spec-level patching) to pick up the starter fixes — the loader and audit changes apply immediately, but starter-spec content lands at instantiation.
- **Web UI**: frozen in maintenance mode at this release (see below).

### Headline

**Recovery honesty is the through-line.** On a resumed restore, the startup sequence now loads a seat's applicable skill preloads before the role-defining first message — so a resuming seat knows its skills before it starts working. Compaction recovery is honest: transcript ingest exposes degraded states explicitly, and a post-compact restore-and-audit is gated on the seat being idle so "restore-sent" actually means "delivered". Daemon liveness reporting is honest; CLI probes report uncertainty honestly. Alongside recovery, the release lands starter-bootstrap hygiene, a broad skills-inventory wave, a first-class Slack connector, tightened CLI contract honesty, and the **UI maintenance-mode milestone** (CLI is primary from here forward).

### Recovery honesty

- **Startup skill-preload ordering** — on a resumed restore, applicable skill preloads are loaded before the seat's role-defining first message. The sequencing (not timing) guarantees the "load skills before doing anything" preload arrives first, before the seat starts working from its role.
- **Claude transcript ingest** — exposes degraded states explicitly so a stale capture no longer looks like a quiet transcript.
- **Post-compact restore-and-audit is idle-gated** — restore-sent actually means delivered.
- **Seat-liveness API** — consumers should key seat liveness off the honest lifecycle state (updated every few seconds) rather than the older session-status field, whose staleness cleanup is tracked for a subsequent release.
- **Daemon `rig ps` + daemon-status** — report liveness honestly: a dead seat drops effective running to 0 and reports `attention_required`; `rig send` and `rig capture` return an explicit "session missing" error when the seat is gone.
- **CLI probes report uncertainty honestly** — unconfirmable status returns `UNKNOWN` with no false start advice; confirmed-stopped fails with actionable guidance.

### Starter bootstrap

- **Product-team starter bootstrap hygiene** — plus a skill-preload for starter seats on both fresh-start and restore.
- **Default culture loads at startup** — rig specs are audited at load time.
- **Rig-spec migration path** — rigs instantiated before v0.4.7 need re-instantiation (or spec-level patching) to pick up the starter fixes; loader and audit changes apply immediately, but starter-spec content lands at instantiation.

### Skills wave

- **Bundled skill layer** — gains public routing + a default projection, plus public-skill strip and mirror controls, plus a plugin fix that keeps the documented skill count honest.
- **Bundled skill inventory** — grows substantially, from a handful to broad coverage across core, PM, pod, and process families.

### Slack connector + human queue

- **First-class Slack connector** — CLI `rig slack` commands + supporting library. Hosted create crosses an inconclusive local probe to the real configured-daemon result.

### CLI contract honesty

- **`--json` errors, flag validation, and scoped overdue behavior** tightened for machine-readable use.

### UI — moved to maintenance mode (milestone)

- **The web UI is frozen at this release in maintenance mode.** Wording is CLI-primary — never "deprecated". The UI still ships and still runs; it is no longer receiving new feature work. CLI/TUI is the primary surface going forward.
- What lands in v0.4.7 to make this explicit:
  - A dismissible in-app banner in the web UI announcing the maintenance-mode status.
  - A `rig ui open` stderr notice at launch time, so operators driving the CLI see the status before they open the browser.
  - Documentation positioning updated across README and user-facing docs.
- Existing v0.4.6 deployments keep working; nothing is removed. The substantive product investment shifts to the CLI and, from v0.5.0, the terminal TUI.

### Queue, topology, review polish

- Queue compact-list rows mark elided fields so "omitted" is distinguishable from "empty".
- Nested Approve posts a missions-root-relative scope path.
- Mission review card composition is polished.
- Unverified delivered items read "artifact-recorded" rather than "nothing delivered".
- The drawer file viewer resolves inline in-body images via the file-asset API.
- Proof-of-work Markdown links open in the in-app drawer.
- Docs guard encodes the root-placement rule for `docs/DESIGN.md`.

### Host sizing guidance

- **Swap + per-box seat budget** — recommended: add swap on the host, and plan for roughly ~2 GB RSS per seat as an observed baseline.

---

## [0.4.6] - 2026-07-09

**Status**: shipped; workflows + multi-host coordination + factory foundations theme. 0.4.5 was skipped (no cut).

### Summary For Installing Agents

- **Package version**: bumps from `0.4.4`. 0.4.5 was skipped.
- **Migrations**: additive only — `049_workflow_instance_version`, `050_workflow_spec_json`, `051_workflow_resume`, `052_workflow_instance_bound_rig`, `053_sessions_node_id_index`, `054_queue_transitions_archive`. Existing v0.4.4 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **New bundled skills**: `openrig-herdr` and `openrig-cmux` ship in canonical shared source + bundled openrig-core plugin, byte-parity guarded.

### Headline

**Workflows + multi-host coordination + factory foundations.** OpenRig gains a rock-solid deterministic workflow engine — spec language, CLI, web UI, exception + human-gate model — plus the self-driving factory starter that runs on top of it. Multi-host coordination lands the full happy path: hosts register + select, remote workspaces read, cross-host queue routing, cross-host direct coordination verbs (`rig send` / `rig capture` / `rig transcript` / `rig broadcast`), and a fleet-attention rollup. Terminal provider first-class treatment and daemon read-path hardening ride alongside; a new Pi agent runtime adapter joins Claude and Codex as a first-class runtime.

### The rock-solid deterministic workflow engine

- **Migrations**: additive only — 049 `workflow_instances.version` (optimistic concurrency, default 0), 050 `workflow_specs.spec_json` (full parsed spec at cache time; legacy rows self-heal on next read-through and degrade with a visible advisory until then).
- **Behavioral**: `loop_guards.max_hops` is now ENFORCED at projection (exceeding converts the handoff to an honest structured failure — instances that silently looped will now fail loud at the guard); workflow spec validation is STRICT (unknown keys reject at parse; unreachable steps and unguarded cycles fail validation — declare `loop_guards.max_hops` to sanction a loop); waiting-exit replays are absorbed (exact duplicates return the stored outcome with zero writes); `rig workflow continue` is relabeled to its real read-only inspector semantics (the wire was always read-only; the label lied).
- **New**: per-instance workflow-keepalive watchdog jobs auto-arm in the routing transaction and disarm at terminal (deadline-gated: quiet while healthy, stuck-steering nudge when a step is overdue — 4h threshold on the routine-tier SLA); a startup sweep re-arms keepalives, reissues nudges lost to the commit-then-crash window, and surfaces stuck instances.
- **Advisories (fail-open)**: declared-but-unenforced spec keys (`invariants.*` except `allowed_exits`, `closure.*`, `gates[]`, `skill_refs`, `next_hop.mode: prefer`, `spawn_budget`) warn `declared_not_enforced_v1` at validation; exit code unchanged.

### The full-featured workflow spec language

- **The workflow spec DSL** the engine parses ships full-featured: step definitions with `role`/`target.rig`/`preferred_targets`, `next_hop.on` branch semantics, `invariants.allowed_exits`, `loop_guards.max_hops`, `exception_routing`, `closure.*`, `gates[]`, `skill_refs`, `spawn_budget`. Strict-keyset validation at parse (unknown keys reject; unreachable steps + unguarded cycles fail); shipped-spec compat pinned by fixture round-trip. Composes with the workflow-to-rig binding + the exception model.

### The workflow CLI

- **Migrations**: none.
- **New verbs**: `rig workflow run <spec>` (instantiate + follow live to a terminal state; exit 0 = completed, exit 3 = workflow failed — distinct from transport 1/2, so `run && next-thing` is honest) · `rig workflow watch <instance>` (read-only mid-flight attach; snapshot-first so fast early steps still render exactly once; drops reconnect then degrade to an announced poll fallback) · `rig workflow status` (the needs-attention rollup: counts + one row per failed/stuck/waiting instance with combined reasons and the next action; proven-empty on a clean fleet) · `rig workflow route <instance> --to <session>` (re-target the current frontier step: honest handed_off_to closure + successor recreate + frontier rebind in one transaction; the step does NOT advance; the old owner's stale project is structurally rejected with `packet_not_on_frontier`).
- **Behavioral**: `trace`/`list`/`show` human output is now formatted (per-step tree, columns, status glyphs, ATTN markers) — `--json` payloads are byte-identical to before; named daemon rejections render as what/why/fix in human mode (`--json` keeps the raw body).
- **Guard**: out-of-band TERMINAL closure of a live workflow-frontier packet (raw `rig queue update`, Mission Control route/handoff) now rejects with `workflow_frontier_packet` (HTTP 400) naming the correct workflow verbs. Non-workflow queue items are unaffected. The predicate is injected at startup (the queue layer does not import the workflow domain).
- **Events**: `workflow.routing_table_changed` extended additively with `{instanceId, stepId, from, to}` on route emissions; existing `{rigName, cause}` consumers unaffected.

### The workflow web UI

- **New pages + components**: `WorkflowsPage` (workflow catalog + instantiate flow), `WorkflowInstancePage` (per-instance detail + trail), `WorkflowInstancesBand` (in-band rollup surface), `WorkflowTopologyGraph` (visual topology renderer), `InstanceTrailTimeline` (packet + step trail).
- **New hooks**: `useWorkflow`, `useWorkflowSse` (workflow SSE stream, unscoped by rig — never `?rigId=`); workflow events cross-rig aggregate.
- **Behavioral**: workflow layout math is extracted as pure exports (`buildLauncherViews` / `suggestLayout`) for unit tests; permutation-invariant edge-handle assignment (`computeStepDepths` / `assignEdgeHandles`); post-merge borderRadius design-compliance fix landed. Twin fixture backfill for these routes is routed as a non-blocking 0.4.7 hygiene fast-follow; UI acceptance is carried by per-cut real screenshots + the two-host integration proof.

### The exception + human-gate model

- **Migrations**: `051_workflow_resume` — two additive columns on `workflow_instances` (`resume_count`, `hops_baseline`, both NOT NULL DEFAULT 0; no backfill; behavior byte-identical until the first resume).
- **New verb**: `rig workflow resume <instance> [--decision <text>]` — redrive a FAILED instance from its failed step: back to active, rebound, fresh packet to the step's RE-RESOLVED owner (a replaced dead seat receives the redrive — the recorded stale destination is never copied); completed steps never re-run; one fresh `max_hops` window per resume (`hops_baseline`); the resolved exception occurrence closes; a repeat failure raises a NEW occurrence-distinct item.
- **Exceptions are durable attention items now**: an unmapped `failed` close creates the item IN THE SAME transaction as the failure (no item-less failed window); stuck/overdue instances get their item at sweep/keepalive detection, occurrence-deduped. Items carry plain-language summary, a trace evidence pointer, the resume affordance, and structured tags (`workflow:`/`instance:`/`step:`/`exception:`/`occurrence:`) for query-side joins.
- **The maturity dial**: exception routing is configurable per class / per workflow (`exception_routing:` in the spec — strict-keyset validated) and per host (`rig config set workflow.exception_routing orchestrator|human_only`). Default = ORCHESTRATOR-FIRST: the item routes to the workflow's declared `orchestrator_role` target while the human band shows an AWARENESS row (holder + age — visibility, not a to-do). `human_only` classes/workflows route `human@host` first and gate there. No resolvable target = `human@host`, never lost. Orchestrator-routed items carry an ordinary tier — they never leak into the human attention legs; the shipped attention predicate is unchanged.
- **The attention band is workflow-aware**: failed/stuck instances with no item render a backstop row naming the missing-item anomaly; a frontier referencing a closed packet renders an anomaly row (the detection twin of the CLI close-path guard); healthy fleets render zero workflow rows.
- **Happy-path guarantee unchanged**: a healthy run creates zero exception items of any routing and involves no orchestrator — pinned by test and proof.
- **Events**: additive `workflow.resumed` (`{instanceId, workflowName, stepId, resumedBy, decision, resumeCount}`).

### Add / select hosts — host registry + dashboard

- **Host registry verbs** (shipped at 0.4.4) gain the dashboard-side complement: `HostConfigCard` surfaces each registered host's declared transport, health, and identity; `HostIndicator` shows the current selection at the operator field of view. New hooks: `useHosts`, `useFleet` (registry read + fleet-wide rollup).
- **`rig host select` persists a sticky selection** consumed by the observe/interactive verbs (see cross-host coordination verbs, below); durable writes never follow the selection (deliberate asymmetry — see cross-host queue routing, below).

### View remote workspace

- **A remote host's workspace surfaces are readable from a local operator** — the workspace observability tabs shipped at 0.4.1 gain `--host <id>` scope; the registry + bearer path fans out per-host reads. Read-only for this pass; cross-host writes are the queue-routing and coordination-verb sections below.

### Cross-host queue routing

- **A queue item can now be sent — and a hot-potato handed off — to a destination on ANOTHER host.** `rig queue create/handoff/handoff-and-complete` gain `--host <id>` and the host-qualified destination form `member@rig@<host>` (both resolve to the same out-of-band `hostId` envelope; the session string stays `member@rig`). The local daemon forwards the write to the target host's daemon over the host registry + bearer (the shipped mission-control forward-then-strip WRITE, generalized); **the qitem lives in the target host's DB** and that host's own nudge wakes the destination agent on ITS tmux.
- **Explicit-only routing**: queue verbs never follow the persisted `rig host select` selection — a durable write does not silently re-home on a sticky selection (deliberate asymmetry with the observe/interactive verbs).
- **At-least-once + idempotent, never exactly-once**: the forwarding daemon mints the qitem id before the first forward; a cross-host handoff's successor id is derived deterministically (`qitem-xh-…`) from (source, destination, host) so retries absorb on the target's primary key. Cross-host handoffs create the successor FIRST and close the local source SECOND (never-drop); the source close records the opaque three-part `closure_target=member@rig@<host>` (audit metadata, never parsed) and the successor carries the continued `chain_of_record` (opaque lineage ids on the target). Re-drives absorb on a matching `closure_target`; a mismatch is a structured `cross_host_close_conflict` (409).
- **Failure honesty**: unknown / ssh-declared / unreachable / auth-failed hosts each surface a distinct structured `remote_queue_write_failed` error naming the host; nothing is written on either side. Transport is http-only (daemon→daemon); the `rig send --host` ssh shell-out is untouched.
- **No migrations. Local (no-host) queue behavior is byte-identical.** Claim/update/inbox stay local-by-principle; sender-side ops on a forwarded item are a named follow-up.

### Cross-host agent coordination

- **The direct coordination verbs now cross hosts — send, observe, coordinate JUST WORK.** `rig send` and `rig capture` gain an **http transport branch**: an http-registered host (the kind the shipped `rig host pair` front door creates) is reached CLI-DIRECT via the shipped `runRemoteHttpOp` against the remote daemon's EXISTING `/api/transport/send|capture` routes — **zero daemon-side changes**; the ssh path stays byte-verbatim for ssh-registered hosts (the host entry's declared transport dictates the path; never a fallback). `rig transcript` and `rig broadcast` gain their FIRST cross-host affordance the same way (`--host <id>`, http-only): transcript reads the remote daemon's tail/grep routes with origin output verbatim; broadcast posts to the remote daemon's own fan-out engine, printing its per-target results verbatim (a partial fan-out exits non-zero, exactly as local) under its own named 30s deadline.
- **The `agent@rig@host` target form is CLI-edge sugar, uniform on the session-target verbs** (send/capture/transcript): the suffix is host-qualified IFF it matches a REGISTERED host id, else the target passes through unchanged with a loud host hint on failure (adopted/raw names containing `@` keep working — deliberately different from the queue verbs' always-strip rule; both documented side-by-side in cli-reference). Precedence: explicit `--host` > target sugar > the persisted host selection; a `--host`-vs-sugar conflict is a structured error. Broadcast's positional is message text (never parsed as a target), so it takes `--host`/selection only. Every session string that reaches any daemon stays `member@rig`.
- **Failure honesty per branch:** the http branch names its own steps (unknown-host / permission-gate / remote-daemon-unreachable / remote-command-failed, with the remote route's own error text surfaced); the ssh branch keeps its shipped taxonomy. `send --verify` over http prints the REMOTE route's verdict verbatim — never a locally synthesized "Verified: yes". Named terminal-bearer posture: default/tailnet = pass-through; a remote enforcing a different terminal bearer surfaces as the structured permission-gate step (remedy documented; no new auth machinery).
- **No migrations. No daemon changes. Local (no-host, no-selection) behavior of all four verbs is byte-identical.** Durable cross-host coordination remains the queue; the coordination verbs add no queue surface.

### Fleet-attention altitude

- **A fleet-altitude attention surface** — the attention band gains a fleet-wide altitude rollup (`FleetBand` + `FleetPage`): aggregates attention counts across every registered host, per-host status, drill-down to the per-host attention list. Composes with the host registry + the remote-workspace read. New hooks: `useFleet`, `useReviewAgents`.

### The workflow-to-rig binding layer

- **Migrations**: `052_workflow_instance_bound_rig` — one additive nullable column on `workflow_instances` (`bound_rig` TEXT; NULL = unbound = byte-identical prior behavior; no backfill).
- **Point a workflow at a rig at INSTANTIATION**: `rig workflow instantiate|run … --rig <name>` overrides the spec's `target.rig` DEFAULT; the binding persists on the instance (`boundRig` in `--json`, rendered by `show`/`trace`). Unknown-rig validation splits by provenance: an explicit `--rig <unknown>` is a hard `bound_rig_unknown` naming the registered rigs; an unknown spec-default `target.rig` DEGRADES to unbound with a loud instantiate advisory (surfaced in `--json` `advisories` + on stderr) — shipped/example specs that carry a descriptive `target.rig` and route via `preferred_targets` (e.g. `conveyor`) instantiate byte-identically to prior behavior (zero-regression).
- **Roles resolve to SEATS by capability**: pod members may declare `role: <name>` (rig.yaml, `rig expand` fragments, `rig add` fragments — opt-in per seat; charset-validated; rejected on terminal members; round-trips through export). On a bound instance, a workflow role with **no `preferred_targets`** resolves at step-close to a live capable seat on that rig: running agents declaring the role, managed seats only (adopted seats excluded loudly with `adopted_seat_not_role_resolvable_v1`), harness-pin-aware runtime match, least pending backlog, deterministic coordinate tiebreak. Declared `preferred_targets` stay the explicit override tier, byte-identical and never liveness-filtered; every previously-shipped spec behaves identically.
- **Resolve-once, record-in-the-packet**: resolution happens once inside the close+create transaction and records as the packet destination; replays consume the record (zero inventory reads); `rig workflow resume` re-resolves by design and is now capability-aware. Roles bind to the stable seat coordinate `{pod}-{member}@{rig}` — an agent handover behind the seat never strands the workflow.
- **Honest failures**: no live capable seat = structured `next_owner_unresolved` with per-candidate disqualifiers + fix line; zero-declaring rigs get a named message; instantiate hard-fails only on STRUCTURAL zero-role coverage (`bound_rig_role_uncovered`) — a declared-but-not-yet-running seat is fine (factory rigs warm up). Never a spawn, never auto-`add_member`, never a dead-seat route.
- **Exception routing rides the binding**: the exception model's orchestrator-role position resolves capability-aware on the bound rig (never-lost human@host fallback unchanged).
- **Scale-out = add a member under a role** (`rig add` fragments carry `role`); auto-scale-out is explicitly NOT built.

### The self-driving factory starter (`factory-rsi`)

- **New shipped starter: `rig up factory-rsi`** — the single-rig recursive-self-improvement factory MVP. One rig, seven seats (`plan-planner`, `build-implementer`, `check-qa`, `review-reviewer`, `dogfood-tester`, `release-manager`, `orch-lead`), running the new `factory-rsi` workflow. A launch-tier product starter (a `product-team` sibling), workspace-agnostic — point `--cwd <repo>` at whatever the loop should improve.
- **New builtin workflow: `factory-rsi`** — the inner loop `plan → implement → qa_check → review → release`, with `qa_check`/`review` `failed` → `implement` (bounded remediation), engine-routed — never an orchestrator relay. Dogfood is **decoupled** from this gated loop: the dogfood seat runs out-of-band against the **shipped** product and feeds its findings into the next plan (the RSI edge, ungated — no loop-stop in the MVP; the continuous out-of-band runtime mechanism is refined in a later release). The remediation loops are sanctioned only by the enforceable `loop_guards.max_hops`; a trip is an exception routed orchestrator-first (`exception_routing`), and `rig workflow resume` grants one more bounded window.
- **Recorded-state cycles**: the next plan's input is the *recorded* dogfood findings (`evidence_ref` / the packet trail), never a seat's chat memory — the RSI feedback is durable recorded state.
- **Publish stays a human act**: the release leg is two steps — `release_prep` (the release-manager PREPARES notes/docs/PR and records the evidence; un-gated, runs first) hands off to `release_signoff`, which holds the ship decision at the configured human gate target. Prepared artifacts exist before sign-off; no seat pushes, tags, publishes, or upgrades a host.
- **Rides the merged engine, no new machinery**: runs on the workflow engine + spec language + exception model as shipped, with the v0 hardcode seam (`target.rig: factory-rsi` + `preferred_targets` pin each role 1:1 to a seat) — no binding-layer dependency, no engine change. Runtime config: seats inherit their runtime's default model (no per-seat pin); plan/build/release/orch run on claude-code, and qa/review/dogfood run on codex for cross-runtime diversity against the builder.
- **No migrations. No breaking changes.**

### The member-exists instantiate advisory + cross-rig wrapping workflow

- **Mis-routed workflow destinations are caught loudly at instantiate, never silently orphaned.** A declared `preferred_target` that names a rig registered on this daemon but a MEMBER that does not exist (a typo or a stale seat name) now surfaces **ONE loud, aggregated advisory** on the shipped instantiate `advisories` list — naming the destination, every declaring step/role pair, the consequence (the work will not be claimed; it will surface as a stuck exception), and the fix hint (`rig ps` / add the member). Rendered exactly where advisories already render: the route body + CLI stderr. **No new surface, no new flag** — the shipped `target.rig`-degrade list simply gains a second producer.
- **ADVISORY, never a deny**: instantiate always proceeds; the queue transport gate stays rig-exists-only (unchanged). Scope guards: human-seat refs are classified before parse and skipped; raw/adopted (non-canonical) destinations are skipped (legitimate — the inventory cannot vouch for them); an unregistered rig keeps its existing loud transport rejection (no double advisory). Existence is structural — any lifecycle state, any member kind (a declared-but-not-launched seat or an explicitly named terminal member is a legitimate destination; liveness stays a projection-time concern).
- **Cross-rig wrapping workflow**: workflows declared on one rig may `preferred_target` a seat on another registered rig; the routing packet travels via the cross-host queue routing path (host-qualified destination form) and lands in the target host's DB. Local-rig-only workflows are byte-identical.
- **No migrations. No CLI changes. No breaking changes.** Advisory-free specs instantiate byte-identically.

### Pi agent runtime adapter

- **New runtime adapter: Pi** — an agent runtime beyond Claude/Codex, joining the shipped runtime dial as a first-class option in rig specs (`runtime: pi`) and pod member declarations. The adapter honors the standard runtime contract (identity via `rig whoami`, startup guidance, hooks, transcript path). Pi runtime seats participate in all workflow / role / queue / send / capture surfaces exactly like Claude/Codex seats.

### Terminal provider first-class treatment

- **The terminal provider dial gets first-class treatment across the terminal-facing surfaces** — the terminal launcher (`TerminalLauncher`), send/capture/broadcast surfaces, and the new `openrig-cmux` skill's `--provider cmux` seam honor a declared terminal provider per member with best-effort fallback. Existing seats using cmux keep their behavior byte-identical; declared-provider seats now route deterministically.

### Daemon read-path hardening

- **The daemon's read-path is hardened for the multi-host + workflow load** — SSE stream backpressure guards, projection caches, and additive indices for read-side query performance. **No functional behavior change** — reads that returned correct results before return the same results now, faster.
- **Migrations**: `053_sessions_node_id_index` (additive index) + `054_queue_transitions_archive` (archive table for read-side query performance). Additive only.

### New bundled skills (canonical + plugin, byte-parity guard)

- **`openrig-herdr`** — the full rig terminal open/views/status model: verbs, view grammar (`rig | pod:<rig>/<pod> | mission:<id> | slice:<id> | saved`), honest-partial/degrade reading, read-only policy (rig/pod interactive, mission/slice read-only-by-construction, saved per-member), scroll/copy + never-retroactive-flip honesty, same-size-only duplicate limit, terminal-views.yaml schema. AGPL clean-room rail — no herdr source text vendored. Ships in `skills/_canonical/core/openrig-herdr/` + `packages/daemon/assets/plugins/openrig-core/skills/openrig-herdr/`.
- **`openrig-cmux`** — the provider-agnostic vs cmux-specific delta (`--provider cmux`) with shipped-integration open-or-focus rule, patterns only (no arm's-length constraint pointing at openrig-herdr for the shared model). Ships in `skills/_canonical/core/openrig-cmux/` + `packages/daemon/assets/plugins/openrig-core/skills/openrig-cmux/`.

### Known Follow-ons

- **Save-verb** — did not land in 0.4.6; rides 0.4.7.
- **Twin fixture backfill** for the new workflow + multi-host UI routes (WorkflowsPage, WorkflowInstancePage, FleetPage, FleetBand, TerminalLauncher, HostConfigCard, HostIndicator, etc.) — non-blocking 0.4.7 hygiene fast-follow; UI acceptance carried by per-cut real screenshots + the two-host integration proof.
- **Carry-forwards from 0.4.4**: `openrig-user` bundled plugin stale-copy sweep, `whoami --all-hosts` silent host filter, managed-stop SIGTERM-escalation brittleness (recurred at 0.4.4 cutover), post-cutover reconcile-settle-visibility signal on `/healthz`.
- **iOS Safari** (Living Notes composer verification) — carry-forward from 0.4.4.
- **Wider mission-template prose sweep** — post-cut sequencing.
- **Continuous out-of-band dogfood runtime** — the factory-rsi RSI edge ships ungated in the MVP; the continuous mechanism is refined in a later release.

---

## [0.4.4] - 2026-07-06

**Status**: shipped; multi-host + Living Notes theme.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.3`.
- **Migrations**: additive only. Existing v0.4.3 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Backward compatibility**: `rig ps` default view flips to a consolidated all-active-rigs compact projection (the v0.4.0 current-rig-only default is retired); progressive-disclosure via `--full` / `-A` / `--rig <name>` returns the v0.4.3 default shape. `--json` shape unchanged (scope-not-shape). `rig host` gains three new verbs (`add` / `list` / `doctor`); transport posture documented (no behavior change).

### Headline

**Multi-host + Living Notes.** A shared rig topology can now span multiple hosts with staged whole-topology spin-up, real cross-host file movement, and a consolidated For-You feed that aggregates activity across every registered host. Living Notes ships as the durable INTENT → PLAN → DELIVERED signal layer with a one-structure review contract (single vertical stack, delete-not-demote) and cheap composer surfaces. Operator UX picks up `rig ps` consolidated default (with progressive disclosure), an agent-altitude coordination panel, and the operationalize-SDLC control plane. As-built docs closeout catches everything up.

### The SDLC control plane ships in source (OPR.0.4.4.23 — release requirement)

- **Conventions SSOT**: `docs/reference/sdlc-conventions.md` (copied into the assembled CLI package) — the section names the Living Notes UI projects (`## Intent` / `## Mini-requirements` / `## Proof contract`), the proof-contract format + `plannedRef` mockup pairing, the two staged-approval locks, the C1 proof header + closed sets, the three role contracts, the curation rule, the elastic-middle doctrine, and the advisory fail-open audit posture. Once shipped, the repo doc is the living SSOT; the corrective-redesign spec it derives from is the historical design record.
- **Scaffold**: `rig scope slice create` emits the convention sections + `proof/` + `PROOF.md` + an `IMPLEMENTATION-PRD.md` skeleton (elastic-middle note in its header) for **EVERY template kind** — enumeration-tested, so a future kind fails until covered. Mission templates carry the conventions pointer.
- **Advisory audit**: `rig scope audit` (both byte-identical classifier copies) gains `missing_intent_section` / `mini_requirements_missing_or_malformed` / `proof_contract_missing_or_malformed` / `ui_slice_missing_mockup` (mockup ref = a real image ref or plannedRef token, never bare prose) — low/info severities by construction (the exit code flips on HIGH findings only; records-and-advises, never gates). `rig workspace doctor` gains check #8 (`sdlc_convention_sections`, advisory warn) — the 7-check diagnostic is now 8.
- **Skill**: `mission-slice-sop` now ships in the canonical product skill source (+ `skills/_canonical` mirror), updated to teach the full flow: intent → mini-requirements + proof contract → mockups (UI slices) → plan-lock (`--scope spec`) → build the locked set → QA mockup↔delivered visual compare → `rig proof add` C1 drops → proof-lock (`--scope delivery`). The bundled openrig-core plugin's copy is now pinned by a CI byte-parity test. **Census (verbatim)**: before this slice, `mission-slice-sop` was absent from the canonical shared skill source and `skills/_canonical` mirror; the bundled plugin carried a stale orphan copy (from `c7f501a7`) with no guard — that orphan is replaced and parity-guarded. KNOWN residue: the plugin's `openrig-user` copy remains a wholesale-stale older edition with no mechanical guard (routed as a follow-up candidate, not swept here).
- **Bootstrap**: the shipped `openrig-start.md` overlay (the CLAUDE.md/AGENTS.md floor every managed seat sees) + the product-team and pm-team rig-spec cultures point fresh seats at the SOP skill and the SSOT at boot.
- **CLI help**: `rig proof`, `rig scope slice create`, and `rig scope slice approve` help text teach the flow and cite the SSOT; cli-reference gains the SDLC control-plane verbs section (`approve` locks, `rig proof add`, the audit advisories).

### `rig host` verbs + the documented multi-host transport posture (OPR.0.4.4.13)

- **New verbs (capped at exactly three)**: `rig host add` (registry writes validated by the loader's own rules — no more hand-edited YAML for the standard path), `rig host list` (config pointers, never secret values), `rig host doctor <id>` (stepwise distinct errors: transport → remote rig binary → daemon health → identity) with `--posture product-factory-vps` — the ONE built-in security baseline, three-valued per item (UNKNOWN is never pass).
- **Transport posture DECIDED + documented** (no behavior change): ssh carries pane ops (`send`/`capture`), http-bearer carries daemon REST (`up`/`down`/`launch`), `ps`/`whoami` follow the host's declared transport, fan-out is http-only; NO cross-transport fallback; NO http parity for send/capture in 0.4.4. Per-command table in cli-reference §Cross-host execution.
- **Product-factory bootstrap**: `scripts/bootstrap-product-factory-vps.sh` (fresh Ubuntu VPS → factory-ready; smoke-tested VPS posture as encoded defaults).

### BREAKING: `rig ps` consolidated all-rigs default + explicit disclosure ladder (OPR.0.4.4.21)

- **Default scope flips**: bare `rig ps` now shows **every ACTIVE rig on the host** as one compact O(rigs) row (the v0.4.0 current-rig-only default is retired — it hid running rigs from the operator's field of view). New display elements: the host rollup line ("N rigs · M seats · K need attention"), the archived/stopped count line, the drill-ladder footer, and an ATTN column (additive `attentionCount` JSON field).
- **`--json` is scope-not-shape**: still a bare array with the existing per-entry keys; scope widens to ALL non-archived rigs INCLUDING stopped ones (only the human table folds stopped rigs into the count line). Scripts that assumed current-rig-only add the existing `--rig <name>` flag — same schema, wider scope. **One-line migration for the old fleet firehose: `rig ps --nodes -A --full`.**
- **`-A`/`--all-rigs` keeps exactly ONE meaning** — the `--nodes` fleet widener. Bare `rig ps -A` is now a structured teaching error (all-rigs IS the default; archived history stays behind `--include-archived`).
- **`--nodes` names its scope everywhere**: session default applies locally only; `rig ps --host <id> --nodes` requires an explicit `--rig` or `-A` (implicit scope defaults don't cross host boundaries); multi-host fan-out is rollup-only by default; the full explicit ladder (`--all-hosts --nodes -A`, `--full` for complete records) fans out per-node with hostId-stamped projected rows.
- **`--all-hosts`/`--hosts --json` shape change**: emits the intra-P4 shared `AggregatedPayload` — `items` (per-host O(rigs) rows stamped with their origin `hostId`) + `hosts` (closed-enum per-host statuses: `ok | unreachable | unsupported-transport | auth-failed`).

### Multi-host foundation (OPR.0.4.4.11 + 13 + 15 + 18)

- **Shareable whole-topology staged spin-up (S11)** — a rig topology can be brought up in stages across multiple hosts; the spec + the daemon coordinate to reach a green whole-fleet state without requiring single-host bring-up.
- **VPS product-factory multi-host hardening (S13)** — `rig host` verbs (above) + the documented transport posture harden the fresh-Ubuntu-VPS → factory-ready flow. Product-factory bootstrap script + runbook ship for the smoke-tested VPS posture.
- **Multi-host consolidated For-You feed (S15)** — the For-You feed aggregates activity across all registered hosts in the topology. Real-host feed-subscription capture is sequenced as a lifecycle-post-publish belt-and-suspenders proof.
- **`rig file` cross-host movement (S18)** — files move across registered hosts via the `rig file` surface. Real registered-host two-host round-trip proves the flow on top of the VM stand-ins already merged.

### Living Notes signal layer (OPR.0.4.4.19 + 20 + corrective rebuild)

- **Living Notes signal layer (S19)** — durable agent-authored notes at mission and slice altitude; INTENT / PLAN / DELIVERED entries thread down the mission tree with agent authorship + timestamps.
- **Living Notes composer surfaces (S20)** — cheap authoring surfaces make Living Notes the first-class place agents record decisions, plans, and delivered work.
- **One-structure review contract §3.1 (corrective rebuild)** — the review surface reads left-to-right as a single vertical stack (INTENT above, PLAN + mockup in the middle, DELIVERED with paired proof at the bottom); a plan change **deletes** the old plan and writes a new one — never demotes / stacks multiple competing plans. Replaced an earlier three-column layout after human review.

### Operator UX (OPR.0.4.4.22)

- **Agent altitude coordination panel (S22)** — a coordination surface scoped to the right altitude (workspace / mission / slice) so the operator sees actual coordination state without drowning in per-seat detail. Composes with the workspace observability tabs shipped at 0.4.1.

### Docs closeout (OPR.0.4.4.24)

- **As-built docs closeout (S24)** — the as-built documentation family (`docs/as-built/architecture.md`, `docs/as-built/cli-reference.md`, codemaps) is caught up to what shipped through 0.4.4.

### Known Follow-ons

- **R2 — iOS-Safari S20** — deferred to 0.4.5 for iOS Safari verification.
- **R4 — S18 symlink footgun** — routed to the 0.4.5+ backlog.
- **`openrig-user` stale plugin copy + `whoami --all-hosts` silent host filter** — 0.4.5 candidates.
- **Wider mission-template prose sweep** — post-cut sequencing.
- **Belt-and-suspenders real-host proofs (R13-1 / R1 / R3)** — published-npm Linux install smoke, real registered-host two-host e2e for S13 + S18, and S15 real-host feed-subscription capture sequenced as post-publish lifecycle validation lanes. Shipped code already proven via VM/SSH stand-ins per PM rulings; real-host lanes are defense-in-depth belt-and-suspenders, not release gates.

---

## [0.4.3] - 2026-07-03

**Status**: shipped; "rigs that survive" theme.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.2`.
- **Migrations**: additive only. `045_resume_verification`, `046_seat_identity_verdicts`, `047_events_node_type_index`. Existing v0.4.2 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Backward compatibility**: `rig send` default posture changes — unknown / stale / missing / busy activity signals now advise-and-send instead of default-blocking; only `needs_input` (a real interactive picker on the target pane) is a hard send-refuse. `--dangerously-interact --reason "..."` override still available for intentional prompted-seat driving.

### Headline

**Rigs actually survive.** Crash-restore ledger (FR-3 → FR-7) survived a real hard power-off → reboot → `rig start`: both Claude and Codex seats restored to their **original** sessions with recalled pre-crash markers, zero fresh-prime. That's the load-bearing "rigs survive" claim, and it's proven at the operating-system level, not just in unit tests.

### Survival Backbone

- **Crash-restore resume-token ledger (FR-3 → FR-7 + FR-6.1)** — capture-on-adoption / snapshot-refresh / restore-target-pin / freshness threshold (1h advisory, `--fresh` re-verify, FR-6.1 periodic re-stamp) / **no-silent-fresh-prime** guarantee on the restore path.
- **Fixture-home isolation guard** — a fresh-prime that would clobber a live rig's home dir is refused loudly.
- **Liveness PID-verify** — daemon distinguishes a live seat from a dead-PID ghost.
- **Daemon event-loop health + terminal broker resilience** — health signal exposed; `TerminalSessionBroker` recovers cleanly across daemon restarts.
- **Startup-proof** — challenge-verified orientation read; seat can't skip past its orientation material.

### The Deny-by-Default `rig send` Reversal

The 0.4.1 3-layer guard was too strict at the fleet level — unknown / stale / missing / busy all default-blocked, requiring `--dangerously-interact` for routine coordination. Corrected:

- **Only `needs_input` hard-refuses** — that's the actual footgun-point.
- **Unknown / stale / missing / busy advise-and-send** — peer sends land; operator sees the advisory in output.
- **`--dangerously-interact --reason` override** — unchanged for intentional prompted-seat driving.

Also: **Codex activity-signal hardening** so idle Codex takes normal sends while the genuine prompt block holds; **hook-trust autoclear** fast-follow for fully-unattended Codex restore.

### `rig send` Unified Targeting

Multi-recipient list + `--pod` + `--rig` — reuses broadcast fan-out + per-recipient guard. Backward-compatible.

### Wave-2 UI + Theming

- **Rig-status + launch-control UI** — start / stop / recover a rig from the workspace surface; launch modal for mixed-plan rigs.
- **Switch-client view-retarget** — a switch-client action lands on the correct target view.
- **Dashboard theming (Vellum Dark opt-in)** — `light` = existing `:root` (byte-identical); `dark` = first shipped alternate; token-block + registry scales to N. Uses Tailwind `darkMode: 'selector'`.

### Recovery + Seat Lifecycle

- **Seat-handover full-cycle** — outgoing seat delivers captured context to a fresh successor; resume marker carries via FR-3; loud-unwind on both lanes on failure.
- **Seat-forking closeout** — fork lifecycle terminates on the shared checkpoint; predecessor + successor named.
- **Idle-gate watchdog** — idle seat holding a claimable gate qitem is woken with bounded skip-recording.

### Hardening + Bug Pile-ins

- **Session-admin mutation auth-guard** — admin mutation surface no longer reachable without the correct auth posture.
- **Secret-boundary B1 hardening (`rig auth`)** — fd-first: open the fd + operate on the fd, never re-resolve the path. Closes the check-then-use gap under interruption / concurrent-legitimate-rig-process scenarios (TOCTOU class closed as a consequence). Leak-hunt regression against the real credential file.
- **`rig queue show` bounded body preview** — long qitem bodies truncated in show view; full body inspectable via the queue-item drawer.
- **Manual configurable compaction trigger + same-seat guard** — Claude Code seats can be compacted from outside the seat; same-seat mutation refused.

### Doctrine

- **`mission-slice-sop` skill** ships — per-file rules for `PROGRESS.md` / `PROOF.md` / `MISSION_NOTES.md` / `MISSION_BRIEF.md` / `README.md`, the SCAFFOLD/POPULATE/PROJECT/VERIFY lifecycle, hot-potato queue handoffs, `rig scope audit` backstop.

### Known Follow-ons

- Slice-04 real-provider handover VM-marker — code proven at runtime; real-provider end-to-end VM-round-trip is a fast-follow proof capture (not a claim gap; the load-bearing survival proof is the crash-restore capstone).
- `rig ps` consolidated-default + progressive disclosure — captured for 0.4.4.
- Deploy-identity: git SHA via `/healthz` + `rig --version` (version-truth-vs-commit-truth observability gap) — captured for 0.4.4 Discovery.
- Managed-hooks-via-`requirements.toml` — later fast-follow.
- Skill-layer cut depth (slice-25) + dashboard glyph swap (slice-24) — deferred.

---

## [0.4.2] - 2026-07-01

**Status**: shipped; targeted CLI hotfix.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.1`.
- **Migrations**: none — no schema changes ship in `0.4.2`.
- **Node engines**: unchanged.
- **Backward compatibility**: no CLI surface, daemon, or dependency changes. `rig daemon status` no longer false-negatives during the daemon's post-start listener-bind window; genuine-down reporting is unchanged.

### Fixed

- **`rig daemon status` false-negative after restart** — the probe's single `/healthz` fetch lost to the post-restart HTTP-listener bind window (process up, not yet accepting), causing a false "Daemon not running" / "healthz failed" report even though `/healthz` was returning `200`. Fixed by wrapping the three `getDaemonStatus` `/healthz` branches in a status-probe-local bounded settle (max 5 attempts, 200ms backoff, hard-bounded). Genuine-down still fails all attempts and is reported stopped / unhealthy after the budget — never masked, never an unbounded wait.

### Scope

- `packages/cli/src/daemon-lifecycle.ts` — three probe branches now go through `probeHealthzWithSettle`.
- `packages/cli/test/daemon-lifecycle.test.ts` — focused probe-layer tests: transient-then-healthy settles to running / healthy; pid-alive-but-never-answers stays `healthy: false`; genuine-down still reported stopped after the hard-bounded budget.

No dependency, script, config, or behavioral package-field changes beyond the CLI hotfix and version bumps.

---

## [0.4.1] - 2026-06-30

**Status**: shipped; observability + operator-UI overhaul.

### Summary For Installing Agents

- **Package version**: bumps from `0.4.0`.
- **Migrations**: additive only. Migration 044 adds a nullable `queue_items.summary` column; pre-0.4.1 items degrade cleanly to a body-fallback label. Existing v0.4.0 databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged.
- **Backward compatibility**: `rig send` defaults now refuse a send when the target pane is at an interactive prompt or permission block (3-layer guard: L0 default-blocked, L1 `--raw` still guarded, L2 `--dangerously-interact --reason "..."` audited override). `rig queue create` + `rig queue handoff` gain an optional `--summary` field with WARN-on-author (does not hard-break existing callers). Cosmetic Project tab renames: Topology → Workflow (test-id stable as `project-tab-topology`); Queue folds into Story.

### Headline

OpenRig v0.4.1 is the **workspace-as-mission-cockpit** release: a coherent altitude projection (workspace → mission → slice), a Mission **Steering** landing tab (`STEERING.md` + `MISSION_BRIEF.md`), a **Story** queue-item DAG git-graph that reconstructs what actually happened on a mission, a **Workflow** spec visualizer, a **Proof** tab, a Workspace **Portfolio** panel, an **Artifacts** navigator, and a **Progress** heat-map — all derived through a new UI digital twin so visual intent can be approved before any UI slice is built.

### New Top-Level CLI Verbs

- **`rig auth`** — product-native, CLI-local Codex auth-profile management with a hardened secret boundary (refuses symlinked active auth, hardlink + symlinked-parent escapes out of `CODEX_HOME`). List / show / switch / capture / forget profiles under `~/.openrig/codex-auth/`.

### `rig send` — Interactive-Prompt Guard

- **L0 (default)** — blocks `rig send` when the target pane is at an interactive prompt or permission block. Hook-primary (Codex `PermissionRequest`) with a hardened capture-pane fallback (12-line trailing-content scan + 15-second send-readiness freshness).
- **L1 — `--raw`** — exact keystrokes; the L0 guard still applies.
- **L2 — `--dangerously-interact --reason "..."`** — explicit override, implies `--raw`, requires `--reason`, writes an audit row.

### Workspace Observability Surfaces

- **Mission Steering tab** — landing tab when you click into a mission. Panel 1 projects `STEERING.md` (what agents are currently being told to do); Panel 2 projects the new mission `MISSION_BRIEF.md` doctype (the locked 7-section template).
- **Mission Brief doc-type + projection** — `rig scope init-workspace` / `rig scope mission create` emit a root `MISSION_BRIEF.md` from the 7-section template (Brief / What & why / Building / Progress / Proven / Needs you / Pointers); the Steering tab renders it markdown → UI.
- **Story tab — queue-item DAG git-graph** — scrollable, upward-growing git-graph derived from `chain_of_record` + handoff lineage; single-parent edges only (no invented merge state); one-line rows over a curved gutter; Tier-3 drawer with the full agent-speak body + chain. Mission + slice altitudes; client-side from `/api/queue` (no new surface). Queue tab folds into Story.
- **Workflow tab — spec visualizer** — finishes the half-built Project Topology tab into a real read-only visualizer of the configured workflow spec (dotted-grid canvas, dark-header step cards, per-step state dot, dagre LR layout, amber reject → rework loop-back). Label rename Topology → Workflow (`project-tab-topology` id-stable). Mission + slice altitudes.
- **Proof tab** — per-slice proof galleries + empty-state for scaffolded-but-unpopulated slices; reads from each slice's `proof/` directory and an optional `PROOF.md` summary.
- **Progress heat-map** — Project Progress tab consolidates to the heat-map (per-slice rollup cards retired).
- **Artifacts navigator** — slice-altitude `ArtifactsNavigator` replaces the prior `SliceArtifactsTab` card wall; resolves via the existing `/api/files/*` surface; Decisions surface routes through Story (decision-of-record items are Story nodes).
- **Workspace portfolio** — workspace parent-altitude cross-mission portfolio panel (mission list + steering glance on expand, lazy `MISSION_BRIEF.md` fetch); rollup metric counts *proven* (from `hasProofPacket`) rather than `done`.

### UI Digital Twin + Visual-Intent Convention

- **UI digital twin (harness)** — a derive-from-source twin renders all six real Project UI surfaces 1:1 daemon-free from typed fixtures (cache-seed + a thin fetch override + a seeded SSE stream; **not** MSW). One self-contained `intent.html` per surface; tsc compile-time drift-guard; ~2-step per-slice authoring loop; production-isolated dev-only target. Per-surface build: `TWIN_ROUTE=<route> npm run twin:build`.
- **`rig scope` intent-visual slot** — `rig scope slice create` scaffolds an `## Intent visual` slot in the slice `README.md` (with `[change.diff]` + the `TWIN_ROUTE=<route> npm run twin:build` rebuild command). Non-visual slices get an explicit `N/A` line.
- **Visual intent → proof convention** — adopted alongside the harness.

### Topology + For-You

- **Topology edge-flow animation** — when a real queue handoff or `rig send` travels an edge, the edge animates in the handoff direction, brightens while live, then settles static after TTL. Animates **only** on a real queue/send signal (no workflow DAG, no ambient motion); reduced-motion omits the flow.
- **For-You phone restyle + real-data fidelity** — the Dashboard restyle reaches For-You as a phone-friendly cards layout with an altitude-dial level filter (All activity → Highlights → Needs you). The internal `source.type` wrapper string no longer renders, and the vestigial storytelling-preview band that ignored the level filters is removed.

### Reliability + Correctness

- **Fresh-install daemon-start fix** — `@hono/node-ws` is now declared in `@openrig/cli` (the CLI vendors the built daemon and does not depend on `@openrig/daemon`, so its `package.json` must mirror the daemon runtime deps for a global install to resolve them). A packaging-completeness gate now fails the test suite if a daemon runtime dep is not mirrored in the CLI.
- **Table / hybrid terminal-action reliability** — terminal-action errors surface as a visible alert instead of silent failure on the topology Table view + the hybrid surface; the Table terminal now opens cleanly.
- **Queue-item human-readable summary** — additive nullable `summary` field on queue items (migration 044). The Story-row label prefers the authored summary and degrades to the body fallback for pre-0.4.1 items. The agent-speak body remains the source of truth and is inspectable in the queue-item drawer.
- **Seat-scoped post-compaction restore** — Claude Code seats get a scoped, idempotent restore packet derived from the JSONL transcript.
- **Table-view crash fix** — null-safe TanStack filter + an `ErrorBoundary` on all three topology Table mounts (host / rig / pod).
- **Dashboard route refresh** — cosmetic visual overhaul of the welcome / home launcher route (paper-draft launcher grid + six cards + Field Environment).

### Conventions Adopted

- **Visual intent → proof** (the digital-twin convention) — derive-from-source twin (no MSW), one `intent.html` per surface, twin-data-freshness as the residual release-close check.
- **Release-durability close AC-9 — skill-cascade integrity**.
- **Release-durability close AC-10 — twin-data-freshness**.

### Known Limitations + Follow-ons

- The skill-layer cut still awaits a decision on the load-bearing set; the cut does not execute in this release. The shipping cascade-drift checker (slice 04.3) is not in this cut.
- Convention drift control (slice 28) is partially delivered (convention ratified + folded into the release-close gate; product skill + audit-code in flight).
- Twin capture tooling (slice 11.2) is in flight; the twin harness ships.
- Workspace UX architecture (slice 15) design-discovery scope is approved; remaining mockups are in flight.
- For-You embedded terminal phone-UX is a non-gating polish check, not yet phone-verified.
- `rig send` hook-primary `PermissionRequest` path lands with this release; the fallback capture-pane guard is fully proven; the hook-primary path rides its full proof on the next iteration.
- `rig auth` deeper structured secret-boundary follow-on is tracked separately, not in this cut.
- Inherited cascade-metadata hygiene from v0.4.0 remains the documented residue; bulk fix is a separate work item.

### Carry-Forward From v0.4.0

The v0.4.0 cascade-metadata hygiene findings (`missing_provenance` + `missing_verified` on the skill layer) remain the documented residue. Other v0.4.0 known issues (managed-seat Codex hook-trust ID-scrape, resume auto-capture-on-reconcile, post-host-adoption smoke for `rig seat clear-attention` + Codex resume posture) carry forward to subsequent releases.

---

## [0.4.0] - 2026-06-20

**Status**: wrap-gate CLEAR; lifecycle push / npm publish / tag held for authorization from the project owner.

### Summary For Installing Agents

- **Package version**: bumps from `0.3.4` at the lifecycle wrap step.
- **Migrations**: additive only; no schema-breaking migrations. Existing v0.3.4 databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged.
- **Backward compatibility**: read-command DEFAULTS change (compact-by-default for `rig ps`, `rig whoami`, `rig queue list`, `rig restore-check`, `rig context`); `--full` returns the v0.3.4 default shapes. `rig queue list` adopts docker / kubectl-aligned grammar (`-a` / `-A` / `--full` / `-o json|wide` / `--mine` / `--source` / `--destination`); the prior unscoped firehose default is retired (opt-in via `-A -a --full`). Existing flag forms continue to work and compose with the new grammar.

### Token-Efficient Defaults (headline)

Five read-commands flip from firehose-by-default to compact-by-default — closes a ~225,000-token aggregate context-window cost on aged hosts.

- **`rig ps`** — compact TL;DR per node (slice 25); `--full` for v0.3.4 shape; `--rig <name>` / `--session <sess>` filters. **Slice 34** breadth default flipped to current-rig (derived from `OPENRIG_SESSION_NAME`'s `@<rig>` suffix); `-A`/`--all-rigs` for fleet breadth; all-states default preserved (topology/readiness signal, unlike queue-list); `--full` JSON now emits `resumeTokenPresent` boolean instead of the resume-token value (security fix). Daemon-side payload source-dedup (slice 26): `recoveryGuidance` no longer duplicated per-node; `contextUsage` compact in list payload.
- **`rig whoami`** — compact identity-recovery essentials by default (~192 tokens vs ~909); `--full` (alias `--verbose`) returns v0.3.4 payload. Allowlist projection — future fields default to `--full`.
- **`rig queue list`** — docker / kubectl grammar (slices 28 + 32): `-a` for history, `-A` for cross-rig breadth, `-o json|wide` for encoding, `--mine` / `--source` / `--destination` for scope. Default is active + compact + current-rig.
- **`rig restore-check`** — summary counts + not-ready seats only by default (slice 29); `--full` for complete per-seat detail. Closes the largest measured bomb (~79,000 → low thousands).
- **`rig context`** — compact summary by default (slice 30); `--full` for complete payload.

### New Top-Level CLI Verbs and Subcommands

- **`rig skill audit`** (slice 10) — read-only audit of the skill cascade. Detects `missing` / `stale` / `self-referential` / `invalid-date` / `mirror-drift` across canonical → product mirror → hub cwd → installed plugin. False-green prevention: emits `unable-to-audit` exit `2` rather than reporting `clean` when evidence unavailable.
- **`rig scope mission|slice progress`** (slice 33) — deterministic `PROGRESS.md` updates through the command surface rather than hand-edited markdown. `rig scope mission|slice create` now scaffold `PROGRESS.md` automatically.
- **`rig scope mission|slice stage / verified / reconcile`** (slice 35) — maturity vocabulary from `conventions/scope-and-versioning` §2 enforced through commands. `stage <id> <new-stage>` sets `stage` (wip / provisional / established / canonical / superseded / retired); `superseded` REQUIRES `--successor`; invalid stages rejected. `verified <id> --against "<source>"` stamps `verified: <today> against <source>`; `--against` MANDATORY (bare timestamps rejected — the anti-stale keystone). `reconcile <id>` is the idempotent repair verb (backfills `PROGRESS.md` + conforms `id`/`stage`/`verified` frontmatter + repairs id-registration ghosts). `create` now writes mandatory `stage` (default `wip`) + a `verified` placeholder. `show` derives read-time effective-reliability projection from (stage × verified) — stale-`verified` `canonical` reported as effectively `provisional`. Composes with slice 33 to make `rig scope` the deterministic convention-enforcer.
- **`rig seat clear-attention`** extended to derived projection staleness (slice 16) — reaches the second class of projection staleness (`restoreOutcome=failed` on a live ready session) that v0.3.4 couldn't.

### UI + Topology + Identity

- Real (interactive) terminals (slice 01) — per-seat terminals are interactive; read-only 3-second snapshot view retired for local-host seats. Global `LiveTerminalRegistry` caps concurrently-live terminals (`ui.terminal.max_live_terminals` config); `LiveTerminalProvider` + `ProgressiveTerminal` interaction model — live where the user is looking, static smoked-glass thumbnails everywhere else; in-place multi-live in the topology grid; shared smoked-glass styling across focused / popover / grid / node-detail.
- Real-terminal session broker (slice 38) — release-critical reliability: a daemon-owned `TerminalSessionBroker` keyed by canonical `sessionName` (one tmux pipe-pane per session, N WebSocket subscribers, output fanout, session-level seed + shared scrollback ring, input-owner semantics, honest cleanup). Closes the "second view steals output from the first" failure mode (tmux's one-pipe-pane-per-pane constraint). `terminal-ws` is now a thin broker subscriber. Resize policy = canonical fixed geometry (120×40); subscribers fit/scroll their container, no per-subscriber tmux resize.
- Unified static/live terminal component (slice 39) — shared `StaticTerminalPlate` + opaque mirror + static line-return fix + 90×27 mirror geometry (fit-to-container projection of the broker's 120×40 live stream); fontSize-scaling for selection on scaled views (not CSS transform); geometry-comment sweep (behavior-neutral).
- Agent Images library polish (slice 07) — Fork-now + row metadata + nested-failure rendering.
- Attention / activity detection elite tier (slice 09) — richer `agentActivity` consumption.
- Topology graph-view ghost render fix (slice 21).
- Reliable active/idle node state (slice 18) — DOT→terminalActive fallback; dead `pane_silence_flag` retired.
- Multi-host dogfood hardening (slice 02).
- Native Codex session-identity capture (slice 11) — foundation for 0.4.1 identity refactor.
- Codex resume preserves approval posture (slice 17).
- Scope-backed progress rails (slice 15).

### Bug-Fix Wrap

- Wrap convergence fixes (slice 24) — P1 For-You drill captured/live contract + P2 daemon test-harness WebSocket registration.

### Known Limitations / Carry-Forward

- **Plugin-lineage drift in `openrig-core`** — the openrig-core plugin skill lineage is divergent/stale; full re-sync is OPR.0.4.1.4 (rides 0.4.1). Boot-path layers (canonical + hub cwd) verified current in wrap-gate AC-3 sweep. `rig skill audit` (slice 10) is the runtime mechanism for future drift detection.
- All earlier "PUSHED to 0.4.1" carry-forwards from the original wrap-gate were RESTORED to 0.4.0 during the wrap: slice 34 (`rig ps` current-rig default + `-A`/`--all-rigs` + `resumeTokenPresent`) landed — see Token-Efficient Defaults; slice 35 (`rig scope` stage/verified/reconcile) landed — see New Top-Level CLI Verbs. Real-terminal-related slices 38 + 39 also shipped via the project owner's live-dogfood forward-fix authorization on 2026-06-21. Nothing of substance carries forward to 0.4.1 from the original wrap-gate set.

### What To STOP Using

- Stop using `rig ps --nodes --json` as the casual status check assuming v0.3.4 shape; compact default IS the casual check.
- Stop using bare `rig queue list` as the cross-rig firehose; default is now active + current-rig.
- Stop using `rig whoami --json` for the heavy payload on boot; default is compact.
- Stop using `rig restore-check` as a per-seat-detail fleet scan; default is summary + not-ready only.
- Stop hand-editing `PROGRESS.md` markdown; use `rig scope ... progress`.
- Stop applying the `token-efficiency-boot-guardrail` pack's CLI-command prohibitions on hosts running 0.4.0 (host-version workarounds; CLI-prohibitions half retires at host-upgrade). The pack's bounded-local-search + scope/over-flag discipline GRADUATE to a standing convention.

### Verification

- Wrap worktree clean on `8d55ea60`.
- CLI surfaces source-verified against the command modules at the release SHA.
- The historical CLI→skill cascade sweep reported the internal canonical skill source → product mirror at `packages/daemon/specs/agents/shared/skills/core/openrig-user/SKILL.md` → hub cwd `.claude/skills/openrig-user/SKILL.md` + `.agents/skills/openrig-user/SKILL.md` as byte-identical (reported md5 `e2aa9176`). This records the historical report, not a fresh mirror check.
- cli-reference.md updated for 6 changed commands + new `rig skill` section; `last-verified-against-source` bumped to `8d55ea60`.
- Stale-pattern grep (`dumps everything` / `--notify required` / `rig down 404`) returned 0 hits across active SKILL.md locations.
- The historical AC-6 self-check evidence was internal and is not a public reproducible receipt.

---

## [0.3.4] - 2026-06-15

**Status**: released. npm `@openrig/cli@0.3.4` (latest); GitHub Release
`v0.3.4`; git tag `v0.3.4`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step;
  CLI reports the new version after `npm publish`.
- **Migrations**: no new schema-bumping migrations in 0.3.4. Existing
  databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged from 0.3.3 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings
  remain backward compatible. New routes are additive
  (`POST /api/rigs/:id/up` plan / apply path is the same path 0.3.3
  shipped; `POST /api/sessions/:session/reconcile` is new;
  `POST /api/sessions/:session/clear-attention` is new;
  `POST /api/rigs/:rigId/nodes/:nodeRef/launch` and
  `POST /api/rigs/:rigId/nodes/launch-subset` are new). New CLI
  commands (`rig start`, `rig reconcile-session`,
  `rig seat clear-attention`) are additive. `rig up` flips from
  fresh-by-default to resume-original-by-default — callers that
  implicitly relied on fresh-prime as the default must now name
  `--fresh <seats...>` explicitly.

### `rig start` — Recovery Entry Point (slice 01)

New top-level command. Sequences existing primitives: daemon-start
-> kernel auto-boot wait -> candidate listing -> picker / flags ->
per-rig restore (`/api/rigs/:id/up`) + reconcile:

```
rig start                            Interactive: daemon + kernel + pick-and-restore
rig start --last                     Headless: restore all rigs that were last running
rig start --all                      Headless: restore all rigs with restore-usable snapshots
rig start --rigs <name> [<name>...]  Headless: restore only the named rigs
rig start --json                     JSON output for agents
```

- **Id-grounded end-to-end**: candidate preview and apply both go
  through `POST /api/rigs/:id/up`. Same-name rigs surface as
  separate candidates; selection carries `rigId` so the name-based
  `/api/up` route is never consulted in the recovery path (no
  `ambiguous_name` 409).
- **Re-codes nothing**: same `/api/rigs/:id/up` that
  `rig up <existing>` uses; same five-term vocabulary on the
  seat-level outcome.

### `rig up` — Resume Original By Default (slice 02)

`rig up <existing-rig>` resumes original sessions by default.
`--fresh <seats...>` is now the explicit per-seat opt-in for
operation B (deliberate fresh-prime):

- **Default**: seats resume; outcome reports `resumed`.
- **`--fresh <logicalId> [<logicalId>...]`**: deliberate fresh-
  prime for the named seats; outcome reports `fresh-primed`.
- **`awaiting-decision`**: when the daemon cannot resume and the
  operator has not opted into fresh. TTY callers get a per-seat
  `[y/N]` prompt; headless callers get the explicit hint
  `rig up --existing <source> --fresh <logicalId>`. ZERO session
  started for `awaiting-decision` seats.
- **Backward-incompatible default flip**: callers that implicitly
  depended on fresh-prime as the default must now name `--fresh`
  explicitly. The `--existing` flag (treat `<source>` as a rig
  name) is unchanged.

### `rig reconcile-session` — Adopt a Hand-Resumed Session (slice 03)

New top-level command. Adopts a LIVE, hand-resumed canonical
session back into its persisted node without launching:

```
rig reconcile-session <session>
rig reconcile-session <session> --rig <rigId> --node <logicalId>
rig reconcile-session <session> --no-launch
rig reconcile-session <session> --json
```

- **NEVER launches / relaunches / kills / replays startup / presses
  resume menus / compacts / types into the pane.** The only mode
  this command has; `--no-launch` is accepted for explicitness.
- **Same node id, no re-key**: the live process binds back to its
  OWN persisted node.
- **Honest reporting**: projection drift is a list of unproven
  metadata fields; conversation continuity is reported as a status
  string, never claimed as proven.
- **Daemon route**: `POST /api/sessions/:session/reconcile`.

### `rig up --plan` — Read-Only Restore Preview (slice 04)

```
rig up <existing-rig> --plan [--json]
```

- **No mutation**: returns the restore plan only.
- **Per-node `intendedAction`**: `resume` / `fresh-prime` /
  `awaiting-decision` keyed to the five-term vocabulary.
- **Snapshot the plan would consume**: surfaced in the response so
  the operator can verify the floor before apply.
- **Honest async timeout**: when the preview cannot complete
  within bound, the response says so rather than claiming a clean
  plan.

### Pod-Aware Claude Resume-Selection Menu (slice 05 rev1 BLOCKING)

`ClaudeCodeAdapter.verifyResumeLaunch` now treats a Claude
resume-selection menu the same way it treats the Codex
unresolved-gate case (the 0.3.3 slice 21 FR-2 pattern):

- Returns immediately with `recovery: attention_required` and
  last-12-line pane evidence on BOTH the inner poll loop and the
  final-probe exit path.
- ZERO numeric selection keystrokes are ever sent.
- Routes into the existing `HarnessLaunchResult` ->
  startup-orchestrator `startupStatus: attention_required` ->
  `ps` / `status` projection — same path the Codex case uses.

### Five-Term Restore Status Vocabulary (slice 06)

The seat-level status on `rig up`, `rig restore`, and `rig ps` is
now ONE of:

- **`resumed`** — original session continuity proven by the
  native-resume probe.
- **`fresh-primed`** — operator opted into deliberate fresh-prime
  (operation B); a brand new session started instead of resumed.
- **`awaiting-decision`** — daemon could not resume and operator
  has not opted into fresh. ZERO session started. The honest
  zero-session state.
- **`attention_required`** — seat is live or parked but needs
  operator action (auth gate, model-selection menu, trust prompt,
  stuck recovery). NEVER reported as `failed`.
- **`failed`** — the launch transport itself failed.

Replaces the prior 2-3 term collapsed model that hid edge cases.
`awaiting-decision` is new and replaces the prior pattern where
zero-session outcomes were either misreported as success or as
failure.

### Codex Profile-V2 Preflight (slice 07 rev1 BLOCKING)

Profile-load check on profile-bearing launch and restore
surfaces, with narrowed legacy-profile detection:

- **Legacy detection requires legacy-specific patterns only**:
  `contains legacy`, `[profiles.<name>]`, `cannot be used while.*
  legacy`, `legacy profile selector`. The prior generic match
  against `failed to load configuration` was also catching
  invalid-TOML stderr and giving the wrong migration hint.
- **Invalid TOML surfaces the parse reason**: up to 3 stderr
  lines (e.g. `expected newline`) with a generic TOML-validity
  hint instead of a wrong hint pointing at
  `[profiles.<profile>]`.
- **Stale comment in `codex-runtime-adapter.ts` corrected**:
  absent `.config.toml` passes (Option B), not fails.

### cmux Launch Readiness (slice 08)

Launch path no longer silently produces a partial cmux workspace:

- **Honest partial-workspace state**: when cmux comes up with a
  subset of expected windows / panes, the seat surfaces an honest
  partial state instead of being projected as launched-clean.
- **One-click open-missing affordance**: UI surfaces the one-click
  path to open the missing workspace pieces.

### Periodic Snapshots (slice 09)

`PeriodicSnapshotScheduler` ships as the crash-insurance floor
under event-driven and teardown snapshots:

- **`snapshots.periodic.enabled`** (default `true`): master
  switch.
- **`snapshots.periodic.interval_seconds`** (default `300`):
  per-rig snapshot interval.
- **`snapshots.periodic.retention_keep`** (default `10`):
  per-rig `auto-periodic` retention count.
- **`auto-periodic` snapshot kind**: captured per enabled rig on
  interval; pruned by `retention_keep`.
- **Restore selector**: treats `auto-periodic` and `auto-pre-down`
  symmetrically — the newer wins. A daemon crash between teardown
  snapshots no longer loses arbitrary lifecycle state.
- **`rig ps` / status**: surfaces last-snapshot / floor so the
  operator can see the crash-insurance floor at a glance.

### `rig seat clear-attention` (slice 10)

New subcommand on `rig seat`. Evidence-gated, operator-attested,
audited reconcile of a stuck `attention_required` seat back to
`ready`:

```
rig seat clear-attention <session>
rig seat clear-attention <session> --reason "<operator attestation>"
rig seat clear-attention <session> --json
```

- **Without `--reason`**: clear requires daemon-side evidence the
  seat is back to a clean state.
- **`--reason <text>`**: operator-attestation override of the
  evidence gate; the attestation string lands in the audit row
  verbatim.
- **Daemon route**: `POST /api/sessions/:session/clear-attention`.
- **Output**: `Cleared <session>: <from> -> ready (<clearedBy>)`.
- **Replaces** the hand-edit-SQLite / fake-clear pattern. Node id
  is unchanged.

### Node-Granular Managed Partial Restore (slice 11)

`rig launch` relaunches a seat or subset by logical id through
orchestration:

```
rig launch <rigId> <nodeRef>                  Single seat
rig launch <rigId> --seats <a,b,c>            Subset (comma-separated)
rig launch <rigId> --seats <a,b> --hold-reason "<text>"
rig launch <rigId> --seats <a,b> --json
```

- **Single target**:
  `POST /api/rigs/:rigId/nodes/:nodeRef/launch`.
- **Subset**: `POST /api/rigs/:rigId/nodes/launch-subset`.
- **Partial outcomes never collapsed**: `launched`, `held` (with
  reason), `alreadyRunning`, and `failedTargets` (liveness
  unknown) reported separately.
- **Retires** the v0.3.x-era `pod_aware_launch_unsupported`
  dead-end and the "use `rig up` instead" workaround that lost
  per-seat control.

### Slow Codex Resume Classification (slice 13)

Internal classification tweak in `verifyResumeLaunch` for slow
but genuinely-resuming Codex sessions:

- Previously the slow path mis-categorized through the
  unresolved-gate branch.
- Now correctly classifies through the five-term vocabulary and
  reaches `resumed` when the readiness probe confirms.

### What to STOP Using

- `rig up <existing-rig>` is no longer fresh-by-default. Use
  `--fresh <seats...>` for deliberate fresh-prime.
- A live or parked seat is NEVER `failed`. Use
  `attention_required`. The honest zero-session state is
  `awaiting-decision`.
- `pod_aware_launch_unsupported` / "use `rig up` instead" for
  per-seat relaunch is RETIRED. Use `rig launch <rigId> <nodeRef>`
  or `rig launch <rigId> --seats <a,b>`.
- Hand-editing SQLite or fake-clearing a stuck
  `attention_required` seat is RETIRED. Use
  `rig seat clear-attention <session>` (evidence-gated) or
  `rig seat clear-attention <session> --reason "<attestation>"`
  (operator-attested, audited).
- Relying only on event-driven or teardown snapshots for crash
  safety is RETIRED. The periodic snapshot scheduler is the
  floor; tune `snapshots.periodic.*` to taste.
- Classifying invalid TOML as a legacy-profile problem is
  RETIRED. The Codex profile-v2 preflight surfaces the actual
  parse reason.
- Restoring a hand-resumed session by relaunching the whole rig
  is RETIRED. Use `rig reconcile-session <session> --no-launch`.

### Known Limitations / 0.3.4 Carry-forwards

- **`rig view list/show --json` flag inconsistency** —
  wrapper-layer routing path remains; the daemon's
  `view show <name>` route returns JSON correctly when invoked
  directly. Workaround: human-readable output for now.
- **`docs/DESIGN.md` docs-guard ledger** — design-doc update
  ledger carries forward; no runtime impact.
- **Slice-21 FR-1 (native Codex session-id hook)**: scope-tipped
  to 0.4.0 after build-time forensic. Carried forward from 0.3.3.
- **Slice-13 component 3 (auto-rollout dispatcher)**: skill-layer
  landing remains; product-code dispatcher / invocation is
  intentionally out of the shipped runtime bundle. Carried
  forward from 0.3.3.
- **Slice-05 sub-scopes carried forward**: agent / port /
  managed-app collision detection (Item 4.3); broader
  install-into-existing-rig pathway acceptance (Item 4.4);
  `--target-name` CLI flag for install-time rig-name overrides.
- **Slice-21 FR-4(d) accepted-queue-state schema**: deferred from
  0.3.2; carried forward.
- **Onboarding journey + battle-hardening**: slices 04
  (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) carried forward to a later release.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots remains a
  follow-up; non-blocking for 0.3.4.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental`
  only; not split-deferred (stays held).
- **0.3.4 host-upgrade flow held**: operators installing v0.3.4
  fresh from npm have full access immediately; existing-host
  upgrade follows the standard daemon-restart flow. The named
  host-upgrade flow is held for separate sequencing.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts cleanly (no new migrations to apply in 0.3.4)
rig daemon start

# Confirm rig start surface is wired
rig start --help

# Confirm rig up --plan + --fresh are wired
rig up --help | grep -E "(plan|fresh)"

# Confirm rig reconcile-session is wired
rig reconcile-session --help

# Confirm rig seat clear-attention is wired
rig seat clear-attention --help

# Confirm rig launch supports single-seat + subset relaunch
rig launch --help

# Confirm five-term vocabulary on rig ps
rig ps --help | grep -i attention
```

---

## [0.3.3] - 2026-06-11

**Status**: released. npm `@openrig/cli@0.3.3` (latest); GitHub Release
`v0.3.3`; git tag `v0.3.3`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step;
  CLI reports the new version after `npm publish`.
- **Migrations**: one new migration in 0.3.3 — `042_rig_archive`
  (`ALTER TABLE rigs ADD COLUMN archived_at TEXT` + `idx_rigs_archived`;
  append-only, non-destructive, no rigs-row restructure). Existing
  databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.2 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings
  remain backward compatible. New routes are additive
  (`/api/rigs/:id/archive`, `/api/rigs/:id/unarchive`,
  `/api/rigs/:rigId/pods/:podNamespace/members`). New CLI commands
  (`rig archive`, `rig unarchive`, `rig add` / `rig add-member`) are
  additive. New `rig ps`, summary, and `rig up` flags
  (`--include-archived`, `?includeArchived=true`, `?archived=only`)
  are additive and default to existing exclude-archived behavior.

### Large Startup-File Transport (slice 16)

`TmuxAdapter.sendText` no longer caps at the OS `MAX_ARG_STRLEN`
limit:

- **Payloads over 100KB** are written to a unique temp file (Node
  `fs`, never shell-embedded), loaded into a unique tmux buffer,
  and pasted with `paste-buffer -d -r`. `-r` preserves raw LF so
  multi-line packs do not early-submit on every newline; `-d`
  drops the buffer on successful paste. The single trailing C-m
  stays the caller's separate `sendKeys(["C-m"])`.
- **Payloads under 100KB** keep the exact inline
  `tmux send-keys -t <t> -l <text>` command (behavior-preserving).
- **Cleanup**: temp file unlinked in `finally`; explicit
  `delete-buffer` on paste-error path; unique temp + buffer names
  per call so parallel `rig up` seats do not collide.
- **Backward-compatible constructor**: optional second arg supplies
  the file/buffer ops (default wires Node `fs` + `os.tmpdir`);
  `new TmuxAdapter(exec)` is unchanged.

### `send_text` Inline Dash Sentinel (slice 17)

Inline `tmux send-keys -t <t> -l <text>` now carries a `--`
end-of-options sentinel:

- Any small `send_text` startup payload whose content begins with
  `-` (notably `---` YAML frontmatter — the norm for per-seat
  packs) is no longer parsed by tmux as flags.
- Inert for non-dash content.
- The slice-16 large/buffer path is already immune (content
  travels via a file, never argv) and is untouched.

### cmux 0.64.x Compatibility (slice 18)

`surface.list` normalizer resolves the surface handle across cmux
0.64.x AND 0.63.x:

- cmux 0.64.x renamed the surface identifier: `list-panels --json`
  rows carry `ref` with no `id` (0.63.x carried `id`). Result:
  `surfaceId` came back undefined and cmux-transport never mapped
  `surface.sendText` -> `cmux send`, throwing
  "Unknown cmux method: surface.sendText" (HTTP 500
  `build_workspace_failed`).
- New `normalizeSurfaceRow` resolves the handle from
  `ref ?? surface_ref ?? surface_id ?? id`, normalizing every
  row regardless of array key (`panels` / `pane_surfaces` /
  `surfaces`).
- One resolution order serves both versions — no
  version-negotiation shim. Mirrors the existing
  `normalizeWorkspaceRow` and create/split handle patterns.

### `rig archive` Affordance (slice 19)

New top-level commands and a non-destructive archive lifecycle:

```
rig archive <rigId> [--force] [--json]
rig unarchive <rigId> [--json]
```

- **Non-destructive**: rig row preserved; `archived_at` set;
  `rig.archived` event fires. `unarchive` clears `archived_at`
  and fires `rig.unarchived`.
- **Default reads exclude archived**: `rig ps`,
  `/api/rigs/summary`, `/api/rigs`, `/api/ps`. Opt-in via
  `rig ps --include-archived` / `?includeArchived=true` /
  `?archived=only`. `rig ps` marks archived rows with `*` and
  renders a legend; the flag propagates through cross-host argv.
- **`rig up` archived-name refusal (AC-7)**: a name matching ONLY
  an archived rig is refused with a 3-part error pointing at
  `rig unarchive`; `--json` emits `rig_archived`. Never silently
  restores.
- **`--force` on archive**: required when a rig is running or
  degraded; surfaces a 3-part fact / consequence / action error
  without it (AC-6).
- **UI**: lazy collapsible "Archive" section under the localhost
  host node, fed by `useArchivedRigs` (separate query against
  `/api/rigs/summary?archived=only`), not by client-side
  filtering. `rig.archived` / `rig.unarchived` events drive
  global query invalidation (`["rigs","summary"]` +
  `["rigs","summary","archived"]` + `["ps"]` + `["nodes", rigId]`
  when present) so a CLI archive reactively refreshes other
  mounted UIs.
- **Migration `042_rig_archive`**: `ALTER TABLE rigs ADD COLUMN
  archived_at TEXT` + `idx_rigs_archived`. Append-only; mirrors
  the `023_stream_items` precedent.

### `rig add` / `rig add-member` (slice 24)

New top-level command for the `add_member` converge op:

```
rig add <rigId> <podNamespace> <member-fragment-path> \
    [--json] [--rig-root <root>]
```

- **Member fragment**: YAML or JSON; tolerates a bare member or a
  `{ member }` wrapper; uses the spec snake_case field names
  (`id`, `runtime`, `agent_ref`, `profile`, `cwd`, ...).
- **Daemon route**:
  `POST /api/rigs/:rigId/pods/:podNamespace/members`. Outcome ->
  HTTP: `rig_not_found` / `pod_not_found` -> 404,
  `member_conflict` -> 409, `validation_failed` /
  `preflight_failed` -> 400, success -> 201. Per-node launch
  status (`launched` / `failed` / `attention_required`) rides in
  the 201 body.
- **MCP tool**: `rig_add` ships in lockstep.
- **Honest edge validation**: non-array `edges` is REJECTED
  (CLI prints error + exits 1; route returns 400
  `validation_failed`; domain returns `validation_failed` as
  defense in depth). Edge `kind` is validated against the
  canonical `VALID_EDGE_KINDS` set exported from
  `rigspec-schema.ts` and reused (not duplicated). Edges still
  carry NO runtime behavior (the edge-runtime fence holds).
- **Built on the topology-converge spine**: `Op` union + differ +
  `convergeOp` scaffold (AC-6); `rig add` is imperative CLI
  sugar over the converge interface, not a bypass.

### `rig down` Accepts Name-or-Id (slice 22)

`rig down <name>` now works:

- `/api/rigs/summary?includeArchived=true` is fetched; id-match
  across ALL rigs (archived ids still reach teardown);
  name-match ACTIVE rigs only.
- Same-name active+archived pair resolves the ACTIVE rig (not
  ambiguous).
- Archived-only name does not resolve by name (use the id, or
  `rig unarchive` first).
- The packaged `openrig-user` skill is corrected across specs
  source + assets/plugins copy + `_canonical` mirror; the
  `down.ts` resolver comment is corrected. The historical v0.3.1
  and v0.3.2 CHANGELOG entries and release notes are left intact
  (the bug genuinely existed at those releases).

### Honest Codex Restore Gate (slice 21 FR-2)

`verifyResumeLaunch` no longer returns `ok:true` unless the
native-resume-probe proves the seat actually resumed:

- **Unresolved operator-action gates** (update that cannot
  auto-dismiss, trust, model-selection) and a bounded poll that
  never reaches `resumed` return `ok:false` with
  `recovery: attention_required` plus last-12-line pane evidence.
- **Routes into existing projection**: `HarnessLaunchResult` ->
  startup-orchestrator `startupStatus: attention_required` ->
  `ps` / `status` projection. Same path the Codex auth-refusal
  case already shipped; no new state machinery.
- **Auto-dismiss preserved**: a skippable update gate still
  auto-dismisses and continues to success; only UNRESOLVED gates
  fail loudly. The readiness loop (`checkReady`) stays the
  SECOND check that upgrades the seat to `ready` once it
  genuinely reaches the TUI.
- **Carry-forward**: FR-1 (native Codex session-id hook) scope-
  tipped to 0.4.0 after build-time forensic; FR-2 ships alone in
  0.3.3.

### `rig send --verify` Honest Delivery Outcomes (slice 99.0.6.3)

The three outcomes are now named in the response:

- **`delivered`**: `ok:true` + post-capture re-confirmed the
  snippet (the prior `Verified: yes`).
- **`rendered-unconfirmed`**: text + Enter both succeeded but
  the capture could not re-confirm (redraw race, or the capture
  threw). LANDED, NOT failure. Exit stays clean.
- **`failed`**: the transport itself failed (`send_failed` /
  `submit_failed` carry `outcome: "failed"`; HTTP mapping
  unchanged).

The legacy `Verified: yes/no` line is preserved verbatim
(parsers); a new `Delivery:` line carries the named outcome plus,
for `rendered-unconfirmed`, a `rig capture <session>`
confirmation pointer. `--json` carries `outcome` through.
Mid-work / wait-for-idle REFUSALS deliberately carry no outcome
(nothing was sent).

### `rig whoami` Peers Contract (slice 99.0.6.1)

`peers[]` is this rig's roster EXCLUDING self. It is NOT a
directionally-edged subset, and it is NOT host inventory.

- **`WhoamiResult.peersNote`** (required string, additive)
  carries the contract in-band, naming the three pointers:
  `peers[]` (roster), `edges{}` (directional graph),
  `rig ps --nodes` (inventory including self + live state).
- **CLI Peers header**: keeps the literal `Peers:` prefix
  verbatim (shipped parsers grep on it), then adds the
  in-band clarifier.
- **No new field**: `peers[]` name and shape are unchanged; no
  `roster` / `podRoster` field is added (peers[] already IS the
  roster).

### Workflow Instantiate By Name (slice 04.1)

`rig workflow instantiate <built-in-name>` (e.g. `conveyor`,
`basic-loop`) now resolves end-to-end:

- `WorkflowRuntime.instantiate` resolves the identifier against
  the seeded spec cache BY NAME first via the new
  `WorkflowSpecCache.resolveSourcePathByName`, falling back to
  literal-sourcePath only when no named spec matches.
- The cache returns the STORED path verbatim — no source-tree
  re-derivation — so the `dist/builtins` production layout
  stays safe.
- Diagnostic rows are excluded via `version != ''` (valid specs
  always carry a version) so resolution needs no dependency on
  the slice-11 status column / migration.

### Guided Golden Path State Clarity (slice 04.2)

The new-operator golden path now points at the correct discovery
verb:

- `rig workflow specs` lists built-in / seeded workflow specs
  (`(built-in)` tagged). USE THIS to discover names before
  `rig workflow instantiate <name>`.
- `rig workflow list` lists workflow INSTANCES; empty for a
  fresh operator.

Corrected in `docs/reference/getting-started.md` and in the
CLI's `setup` golden-path text (`goldenPathNextSteps()` step 4).

### For-You Manage-By-Exception (slice 20)

Feed-interaction UX on existing signals only (the 0.4.0
attention-detection layer is untouched):

- **Drill-to-terminal**: new `FeedCardTerminalDrill` in the card
  footer opens the resolved source/author session's terminal
  PREVIEW via `GET /api/sessions/:sessionName/preview`,
  reusing `TerminalPreviewPopover` over the same
  externally-owned-trigger event contract `TopologyTerminalView`
  uses. Session-NAME keyed ONLY. Honest framing — "terminal
  preview" / "captured snapshot, not live"; disabled with an
  honest title when no session resolves.
- **Decision-band sort**: `feed-classifier` exports
  `sortFeedByDecisionBand` — a stable two-band partition
  (action-required + approval above progress / observation /
  shipped) using the existing newest-first comparator within
  each band. Applied at the single `Feed.tsx` merge-consumption
  seam. Not a ranking engine.
- **One-click approve (approve-only)**: `VerbActions` gains an
  additive `oneClickVerbs` prop. APPROVE submits directly on
  click; deny/route stay select+confirm. Defense in depth:
  prop type narrowed to
  `Array<Extract<MissionControlVerb, "approve">>` so misuse is a
  compile error, and a runtime `ONE_CLICK_SAFE_VERBS = {"approve"}`
  allowlist rejects cast-forced `"deny"` / `"route"`. Reuses the
  same `performSubmit` path (identical optimistic receipt and
  held-error behavior).

### CLI Release-Surface Parser (slice 13.1)

Deterministic TypeScript Compiler API extractor that walks
Commander registrations in `packages/cli/src/commands/*.ts` at
two git refs and emits a structured release-surface-diff:

- Resolves both Commander idioms (chained inline subcommands
  and factory indirection through `addCommand(buildChildCommand())`).
- Emits the REGISTRATION name (`rig-policy.ts` surfaces as
  `policy`); option name-tokens taken from `.option()` arg[0]
  only so template-literal descriptions never drop an option.
- Reads batched via one `git cat-file --batch` per ref (fast,
  offline, deterministic).
- 3-part honest failure shape; never a silent empty diff.
- NOT registered as a `rig` verb at 0.3.3 — the module is
  product code with hermetic test fixtures (including a
  v0.3.1..v0.3.2 worked example checked in at
  `src/release-surface/release-surface-diff.v0.3.1-v0.3.2.yaml`).

### Skill <-> CLI-Surface Binding Index (slice 13.2)

Deterministic offline lookup that joins a release surface-diff
to "which skills are affected by this release":

- Composes with the slice 13.1 parser; invocation-agnostic.
- Implements the ratified join grammar: component-wise prefix
  match in either direction (so `up` does not match `update`);
  conservative over-include bias for the no-false-negative floor.
- Drops `--version` from the binding index (the canonical grammar
  is command paths only, not global flags); the skill body still
  documents `rig --version` as prose.
- Ships with the v0.3.2-affected-skills regression fixture
  derived from the corpus.

### Known Limitations / 0.3.4+ Deferrals

- **Slice-21 FR-1 (native Codex session-id hook)**: scope-tipped
  to 0.4.0 after build-time forensic.
- **Slice-13 component 3 (auto-rollout dispatcher)**: skill-layer
  landing for this release; product-code dispatcher / invocation
  is intentionally out of the shipped runtime bundle. 13.1
  parser + 13.2 binding index ARE shipped product code.
- **Slice-05 sub-scopes carried forward**: agent / port /
  managed-app collision detection (Item 4.3); broader install-
  into-existing-rig pathway acceptance (Item 4.4);
  `--target-name` CLI flag for install-time rig-name overrides.
- **Slice-21 FR-4(d) accepted-queue-state schema**: deferred from
  0.3.2; carried forward.
- **Onboarding journey + battle-hardening**: slices 04
  (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) carried forward to a later release.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots remains a
  follow-up; non-blocking for 0.3.3.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental`
  only; not split-deferred (stays held).
- **`rig view list/show --json` flag inconsistency** — wrapper-
  layer routing path remains; the daemon's `view show <name>`
  route returns JSON correctly when invoked directly.
  Workaround: human-readable output for now.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts and migration 042 applies
rig daemon start

# Confirm rig archive surface is wired
rig archive --help
rig unarchive --help

# Confirm rig add surface is wired
rig add --help

# Confirm rig down accepts name-or-id
rig down --help

# Confirm rig workflow specs lists built-ins
rig workflow specs

# Confirm rig send --verify carries the delivery outcome
rig send --help | grep -i verify

# Confirm rig whoami peers contract is stated in-band
rig whoami --json | jq '.peersNote'
```

---

## [0.3.2] - 2026-06-02

**Status**: released. npm `@openrig/cli@0.3.2` (latest); GitHub Release
`v0.3.2`; git tag `v0.3.2`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step; CLI
  reports the new version after `npm publish`.
- **Migrations**: one new migration in 0.3.2 — `041_rig_policy`
  (`CREATE TABLE` for the operator-context-mode bindings store; no impact
  on existing data; binding rows are operator-authored at runtime).
  Existing databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.1 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon route
  paths, RigSpec/AgentSpec schemas, and persisted settings remain backward
  compatible. New routes are additive. New CLI commands (`rig policy`,
  `rig scope`, `rig workspace doctor`) are additive. New `rig queue create`
  flags (`--body-file`, `--mission`, `--slice`) are additive.

### Rigbundles First-Class

`rig bundle` ships cross-primitive bundling end-to-end:

- **Five content kinds routed**: skills + plugins (hybrid) +
  workflow_specs + context_packs + agent_images. Each kind lands in
  its canonical library under `$OPENRIG_HOME`; consumer-scan
  visibility preserved.
- **`bundle.yaml` author manifests** auto-detected when present.
  Vendoring uses both-sides path containment + symlink-escape
  protection + integrity hashing in the manifest.
- **`rig bundle create` new flags**: `--notes <text>`,
  `--min-daemon-version <ver>`, `--min-cli-version <ver>` — operator
  notes captured in bundle provenance metadata; min-version gates
  power the install-time compatibility check.
- **`rig bundle install` new flags**: `--skip-version-check` (operator-
  explicit override of the install-time compatibility check),
  `--force` (operator-explicit override of the install-time conflict
  check). NOT recommended for routine use; provided for known-good
  operator scenarios.
- **`rig bundle history`** — new subcommand reading
  `~/.openrig/bundle-audit.jsonl` with optional `--rig` /
  `--since` filters.
- **Install timeout bumped** — the prior 5-second cap was too short
  for tmux-session-bootstrapping installs.

### Workspace + Workflow GA

Operator-facing surface hardened:

- **`rig workspace validate --max-files`** — strict-int regex enforced;
  out-of-range values produce a 3-part error before `client.post`.
- **`rig workflow project --exit`** — enum guard against
  `handoff | waiting | done | failed`.
- **14 new discriminator tests** on validator paths.

### `rig up <starter>` Paper-Cut Fix-Round

Four bounded fixes unblocking the homepage quick-start on fresh
0.3.1→0.3.2 installs:

- **HTTP 4xx surface for pre-launch failures**: `cycle_error`,
  `preflight_failed`, `validation_failed`, `service_boot_failed` —
  replaces bare 500.
- **No orphan rig record on pre-launch failure**: instantiator
  re-ordered + rollback path + compose teardown order tightened.
- **Path-form `rig up <install-internal-spec>` defaults cwd**: closes
  the divergence between path-form and bare-form invocation; library
  specs now match path-form behavior.
- **`walkYamlFiles` skip standard noise dirs**: `.worktrees`,
  `node_modules`, `.git`, `dist`, `.turbo`, `.next`. Plus stale
  `workflow_specs` rows prune at startup with an install-root
  preservation guard (shipped built-in specs survive the prune).

### Coordination + First-User Setup Fix-Round (slice 21)

Five bounded follow-rounds:

- **FR-1 — Coordination-model boot instinct**: `rig send` vs
  `rig queue` vs `rig queue handoff` + §1b doctrine surfaced in
  `core/openrig-user/SKILL.md`.
- **FR-2 — First-user workspace + workflow setup teaching**: skill
  + docs content for the path from fresh install to first
  workflow_spec authoring.
- **FR-3 — MISSION_NOTES durable-pattern hardening**: convention
  codemap + auto-scaffold via `rig scope mission create` (uses
  `conventions/mission-notes/TEMPLATE.md`); `--no-mission-notes`
  opts out.
- **FR-4 — Queue ergonomics**:
  - `rig queue create --body-file <path>` (use `-` for stdin) kills
    the backtick-shell-corruption class for multiline bodies.
    Mutually exclusive with `--body`.
  - First-class `--mission <id>` / `--slice <id>` flags translate
    to `mission:<id>` / `slice:<id>` tags (compose with `--tags`).
  - `lastNudgeResult` wording fix; closure-vs-acceptance docs.
- **FR-5 — `rig workspace doctor`**: 7-check workspace-readiness
  diagnostic (workspace root, missions folder, file allowlist,
  daemon alignment, daemon reload, optional slice docs,
  MISSION_NOTES presence). Default exit-code: non-zero only on
  `fail`; `--strict` makes warn-or-fail non-zero. CLI overlays
  `OPENRIG_FILES_ALLOWLIST` from operator's shell env.

### Daemon Test Substrate-Path Scrub (slice 14)

Internal-team substrate path shape scrubbed from 4 daemon source
sites + 10 test files. Hook-constants de-duplicated. Privacy class
closed for tracked source + test surface.

### ConceptCard Data Source (slice 17)

`ConceptCard` wired to shaped backlog candidates; storytelling-adapter
completion deferred from 0.3.1 is now complete.

### For-You Priority Windowing (slice 20)

Server-side attention query (Option 3): SQL predicate pushdown +
exact-match attention regex + dismissal as string-keyed for
queue-derived cards.

### Operator Context-Mode Bindings (slice 09)

New `rig policy` command surface paired with daemon-side typed-primitive
store (migration `041_rig_policy`):

- **Six modes**: `sleep | desk | mobile | away | focus | debug`.
- **Four scopes**: `global_host | rig | workstream | qitem`.
- **Restate-and-confirm posture (HG-4)**: `set` is restate-only
  until `--confirm` is passed; scripts cannot silently apply a
  binding.
- **`--qualifier` strict reject for `global_host` (HG-7 guard
  finding)**: operators who type `--scope global_host --qualifier
  <id>` get an error and the daemon is never contacted.
- **Operator-edit verbs require bearer token**: `set --confirm`
  and `unset` require `--bearer <token>` (or
  `OPENRIG_AUTH_BEARER_TOKEN` env).
- **6 subcommands**: `set`, `show`, `effective`, `cite`, `unset`,
  `defaults`.

### Scope Tree Primitive (slice 12)

New `rig scope` command for operating the substrate scope tree
(missions, slices, sub-slices) per
`conventions/scope-and-versioning`:

- **Mission tier**: `ls`, `show`, `create` (auto-mints stable
  dot-IDs into mission frontmatter; auto-scaffolds MISSION_NOTES
  by default; `--template` auto-selects `release` when name matches
  `release-X.Y.Z`).
- **Slice tier**: `ls`, `show`, `create`, `ship`, `close`, `move`.
- **Templates ship under `dist/lib/scope-templates/`**: `release-
  feature`, `placeholder`, `mission-notes`, `bug-fix`,
  `research`, `backlog-deprecation`, `backlog-tech-debt`,
  `mission-placeholder`, `mission-release`.
- **Top-level option `--workspace <path>`** overrides workspace
  root (otherwise inferred from cwd or `$OPENRIG_WORK_ROOT`).

### Known Limitations / 0.3.3 Deferrals

- **Slice-05 Item-3 sub-scopes deferred to 0.3.3**: agent/port/managed-app
  collision detection (Item 4.3); broader install-into-existing-rig
  pathway acceptance (Item 4.4); the `--target-name` CLI flag.
  Design-contingent on the CLI surface decision.
- **Slice-21 FR-4(d) accepted-queue-state schema deferred to 0.3.3**:
  the new `accepted` queue state is a schema model change; carried
  forward per the release-triage philosophy.
- **Onboarding journey + battle-hardening deferred to 0.3.3**: slices
  04 (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) physically moved to the `release-0.3.3` mission tree.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots is a follow-up
  from slice-21 FR-5 QA; non-blocking for 0.3.2.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental` only;
  not split-deferred to 0.3.3 (stays held).
- **`rig down <name>` still returns HTTP 404** at v0.3.2; use
  `rig down <rigId> --delete` instead.
- **`rig view list/show --json` flag inconsistency** — wrapper-layer
  routing path remains; daemon's `view show <name>` route returns
  JSON correctly when invoked directly. Workaround: human-readable
  output for now.

---

## [0.3.1] - 2026-05-15

**Status**: released. npm `@openrig/cli@0.3.1` (latest); GitHub Release
`v0.3.1`; git tag `v0.3.1`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step; CLI
  reports the new version after `npm publish`.
- **Migrations**: no schema-breaking migrations in 0.3.1. Existing databases
  upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.0 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon route
  paths, RigSpec/AgentSpec schemas, and persisted settings remain backward
  compatible. New routes are additive. New ConfigStore keys are opt-in
  default-off.

### Claude Auto-Compaction Policy

The headline 0.3.1 feature: operator-configurable Claude session
auto-compaction with safe defaults.

- **Opt-in default-off**: with no policy configured, no behavior change. The
  daemon never sends an auto-`/compact` until the operator explicitly enables
  the policy.
- **7 new ConfigStore keys** in the `policies.claude_compaction.*` namespace
  (lockstep across CLI VALID_KEYS + daemon SETTINGS_VALID_KEYS): `enabled`,
  `threshold_percent` (strict integer 1-100), `compact_instruction` (default
  empty; appended to `/compact` slash-command args when set),
  `message_inline`, `message_file_path`, `pre_compact_instruction`,
  `post_restore_audit_instruction`. Strict validation across all source
  layers (`set/POST/env/file`) — invalid env values fall back to defaults
  with a warning to stderr rather than silently coercing.
- **5 operator-editable prompt surfaces** rendered in the
  Settings → Policies UI form: pre-compaction prep, compact instruction,
  post-compaction restore (inline), restore file path, post-restore audit.
  Daemon-owned wrappers (usage/threshold framing, trust-channel preservation,
  marker paths, read-depth enforcement, turn-boundary handshake, dedup +
  cooldown) are non-editable.
- **6-stage daemon-to-LLM lifecycle**:
  1. Pre-compact prep prompt — full-context Claude writes a mental-model
     restore map (annotated ASCII file/folder tree) before compaction
     ("save game before quit").
  2. `/compact` with operator instructions + trust-channel preservation
     embedded in args.
  3. Post-compact turn-boundary handshake — non-restorative acknowledgment
     creates an assistant-turn boundary so the subsequent restore prompt
     lands in the correct trust context.
  4. Restore prompt — explicit user-request shape; defense-in-depth
     fallback chain (marker → JSONL transcript path → session-id → generic).
  5. Compliance prompt — forces FULL/PARTIAL/NOT_READ read-depth audit
     table; counters Claude's deferred-execution + token-conservation
     instincts.
  6. Cooldown (10-minute default) — prevents re-fire while restore work
     is still consuming context.
- **PreCompact hook + SessionStart/UserPromptSubmit bridge**: the openrig-core
  plugin ships a marker-bridge that picks up pending-restore markers
  post-compaction and injects restore directives once. Templates live in
  the `claude-compaction-restore` skill and ship with the plugin.
- **Safety hardening**: SessionTransport classifies typed prompt drafts as
  attention state — auto-`/compact` retries later instead of overwriting
  human input. Send-failure does not advance dedup state (transient retry).
  Re-arm requires threshold-crossing (session must drop below threshold
  before next auto-compact).

### Library Explorer Finishing

The Library destination (skills + plugins + specs) became a fully
operator-facing surface:

- **No duplicate top-level entries**: `> SKILLS` and `> PLUGINS` rows
  removed from the top of `SpecsTreeView`. Bottom-row clicks now do
  dual-action (navigate to the matching index page + expand the tree).
- **Reorder**: Plugins above Skills.
- **OpenRig-managed skills discovery**: 32 shared skills now visible in
  the tree + on `/specs/skills` index. Previously the workspace-relative
  path lookup returned empty in production VM environments.
- **Daemon-owned library discovery API** (new):
  - `GET /api/skills/library` → consolidated `LibrarySkillPublic[]`
    (workspace + openrig-managed sources; absolute paths not leaked).
  - `GET /api/skills/:id/files/list?path=<rel>` + `/api/skills/:id/files/read?path=<rel>` —
    skill folder browse + content read.
  - `GET /api/plugins/:id/files/list?path=<rel>` + `/api/plugins/:id/files/read?path=<rel>` —
    plugin folder browse + content read.
  - `PluginEntry.skillCount` field added to plugin discovery
    serialization.
- **Real file-browser docs-browser on plugin and skill detail pages**:
  detail pages mount a `DirectoryTree` + `FileContentPanel` against the
  real plugin/skill folder. Markdown auto-renders; non-markdown files
  (e.g. `.ts`, `.json`) render as text. Folder navigation works (entering
  subfolders + listing files).
- **Rolled-up index pages**: `/specs/skills` lists all skills as flat rows
  with source label + file count + entry link. `/specs/plugins` lists all
  plugins as rows with version + runtimes + skill-count + entry link.

### Plugin Primitive v0

- **Plugin discovery**: vendored plugins under `$OPENRIG_HOME/plugins/`
  (default `~/.openrig/plugins/`) are discovered, validated, and
  surfaced through `rig plugin list` + `/api/plugins`.
- **Plugin install (v0)**: explicit operator copy or symlink to
  `$OPENRIG_HOME/plugins/<plugin-id>/`. A `rig plugin install
  <substrate-path>` verb is deferred to 0.3.2; see `OPENRIG-INSTALL.md`
  inside each plugin's source for the documented copy/symlink workflow.
- **CLI**: `rig plugin list` / `show` / `used-by` / `validate` subcommands
  available. No `install` subcommand at v0.
- **Plugins shipped as substrate references** (for plugin authors to
  copy-install): `gstack` (45 skills), `obra-superpowers` (14 skills).
  `openrig-core` ships bundled with the daemon (11 skills).

### Settings Destination Explorer

Settings became a 4-item Explorer destination matching Topology /
Project / Library / For-You pattern:

- `/settings` (general config keys form), `/settings/policies`,
  `/settings/log`, `/settings/status`.
- Old top-row tab nav removed.
- Shared `SettingsPageShell` chrome across all 4 sub-routes.
- Policies page is the home for the Claude auto-compaction policy form
  (see above).

### CMUX Launcher

- **Launch in CMUX button** on the rig-scope topology tab-bar trailing
  slot. Opens a cmux workspace for the rig with appropriate title +
  cwd parameters. Powered by new daemon route + cmux adapter
  extensions.

### Node-Page Overview + Details

- **Seat overview table** consolidated as 7-column horizontal layout with
  vertical grid lines (Claude/Codex agent + status + context + tokens +
  uptime + cwd + current-work).
- **Tab consolidation** + activity alignment on the node-detail surface.
- **Alert-only notification banner** (renders only on real-alert states:
  `failed`, `attention_required`, or `latestError !== null`); generic
  `recoveryGuidance` no longer triggers a banner on every seat.
- **cwd / current-work separation**: factored into a `SeatOverviewSecondary`
  primitive below the column table.

### Mobile Drawer Behavior

The Explorer drawer at 375px viewports now layers above the mobile rail
tray for Settings / Project / Library / For-You destinations
(previously hidden behind rail-tray; visible click path didn't register
on Explorer items). Topology mobile drawer is intentionally hidden in
0.3.1 (clicking the hamburger triggered a pre-existing
TopologyTableView renderer cascade); the topology mobile drawer is
scheduled for full restoration in 0.3.2 via a dedicated
TopologyTableView render-path slice.

### Dashboard And For You Visual Refresh

The Dashboard (`/`) and For You (`/for-you`) destinations got a coordinated
visual refresh to a "vellum" surface language — translucent stone-tinted
cards over a paper-grid background, ambient multi-stop shadow, mono+dot
kind indicators, and L-shaped corner-bracket registration marks. The
chrome vocabulary is consistent across destination cards (Dashboard) and
both feed-card systems (For You).

- **Dashboard** — full rewrite of `/` into a thin composition over new
  `dashboard/vellum/` primitives (`BackVellumSheet`, `MidLayerContent`,
  `TopLayerContent`, `DestinationsLayer`, `VellumDestinationCard`,
  `CornerBracket`, `graphics.tsx`, `marks.tsx`). Hero typography ("WELCOME
  BACK") at display-lg + headline-bold; tactical instrument-panel stats
  line with tabular numerals and a success-token active count. Six
  destination cards (Topology / Project / For You / Library / Search /
  Settings) share the same numeral-layout treatment. Real-data hooks
  thread through (`useRigSummary`, `usePsEntries`, `useSpecLibrary`,
  `window.location.hostname`).
- **For You** — both card systems unified to the same vellum recipe:
  - Storytelling band: `CardShell` rewritten to bg-stone-100/45 +
    backdrop-blur-[10px] + ambient shadow + corner brackets; design-token
    leading dots replace prior bg-emerald-50 / bg-amber-50 / etc.
    off-brand utilities. Title at 16px headline-bold; body at 12px.
  - Queue-item `FeedCard.tsx`: same outer chrome; `KIND_DOT` + `TONE_DOT`
    design-token maps; vellum bordered-no-fill action buttons
    (Approve/Deny/Route/Hold/Drop/Annotate/Handoff) with hover-invert and
    44px touch targets; `TONE_RECEIPT` strip is a subtle bg-stone-50/40
    with a leading colored dot.
- **Single source of truth** — `/dashboard` and `/lab/vellum-lab` both
  import from `packages/ui/src/components/dashboard/vellum/index.js`.
  Future visual changes hit one location.
- **Lab routes** — `/lab/card-previews`, `/lab/vellum-lab`,
  `/lab/vellum-bg/{a-large,b-small,c-allover}` are checked-in experiment
  surfaces for designer iteration. Reachable in production by direct URL;
  not linked from main nav. Useful when iterating on the visual system.

### For You Storytelling Adapter

The storytelling band (top of `/for-you`) now wires four card kinds to
real data:

- **Progress** — from `useMissionDiscovery` (first 2 active missions)
- **Shipped** — from `useSlices` (status = shipped/complete/done; capped at 3)
- **Incident** — from `useSlices` (status = blocked/failed/danger or fallback "info"; capped at 3)
- **Approval** — from `useActivityFeed` + `classifyFeed` (kind === "approval";
  capped at 2; qitemId extracted from event payload with snake_case alt
  and `FeedCard.id` fallback). Surfaces real queue items waiting on
  approval in a high-visibility band.

`ConceptCard` component is preserved in source but not emitted by the
production adapter — a deliberate data-source decision is scheduled for
0.3.2.

### Action Outcome And Inline Error Surface

Queue-item action buttons (`VerbActions` — Approve/Deny/Route/Hold/Drop/
Annotate/Handoff) now render outcomes immediately and surface failures
without silently reverting:

- **Optimistic outcome** — on mutation success, the
  `ActionOutcomePanel` ("Approved by X" / "Routed by X to Y") renders
  immediately. Audit-log roundtrip reconciles in background. Operator
  no longer waits for a query refetch to see what happened.
- **Inline error surface** — on mutation error, a tertiary-bordered
  error block renders below the verb buttons with the daemon's error
  message; verb-selection state is preserved so the operator can
  correct and retry. Replaces the prior silent-revert UX where errors
  were never displayed.
- **React-query callback discipline** — `submit()` split into separate
  `onSuccess` (optimistic outcome + reset selection) and `onError`
  (set error message; do NOT reset). Regression test guards the
  silent-revert class explicitly.

### Vendored Skill Provenance

Vendored skills shipped in `packages/daemon/specs/agents/shared/skills/`
now declare their upstream lineage via `metadata.openrig` frontmatter
and (when modifications exist) a companion `OPENRIG.md` sidecar:

- **vendoring_pattern**: `vendored-as-is` | `modify-the-file` |
  `add-supplementary-files`
- **vendored_from**: upstream source identifier
- **last_upstream_check**: most recent diff date
- **divergence_notes**: human-readable summary of OpenRig-specific changes

Applied to all 10 process-skill surfaces (agent-browser, executing-plans,
brainstorming, systematic-debugging, test-driven-development,
using-superpowers, verification-before-completion, writing-plans,
frontend-design, dogfood). `OPENRIG.md` sidecars added where the file
has been modified or supplemented (agent-browser + executing-plans +
brainstorming + using-superpowers + writing-plans). Convention is
documented in the `writing-skills-for-openrig` skill.

### Plugins And Skills On The VM (Operator Note)

Operators dogfood-testing 0.3.1 should expect:

- **Stock VM install**: only `openrig-core` plugin is bundled. The
  `/specs/plugins` UI list will show one plugin until the operator
  installs additional plugins per the v0 copy workflow.
- **Skills**: 32 OpenRig-managed shared skills ship under
  `packages/daemon/specs/agents/shared/skills/` (discovered via the
  daemon skill-library API; no operator action required).
- **User-installed skills**: skills the operator installs under
  `~/.openrig/skills/` or the workspace `.openrig/skills/` directory
  surface in the same list.

### Config + Settings

Continues from 0.3.0 with the slice 08 validation pass:

- `rig config get/set/reset/list` remains the canonical CLI surface.
- Lockstep CLI `VALID_KEYS` + daemon `SETTINGS_VALID_KEYS` byte-identical
  sets (verified in slice 08).
- Help-drift CI gate from slice 08 honored across all new keys added in
  0.3.1.

### SC-29 Exceptions

The SC-29 exception process tracks explicit scope expansions to release
contracts. Exceptions declared in 0.3.1:

- **#10 (slice 24)**: cmux launcher — `POST /api/rigs/:rigId/cmux/launch`
  + CmuxLayoutService + 4 CmuxAdapter RPC methods.
- **#10 (slice 27, numbering collision)**: Claude auto-compaction policy
  — 7 `policies.claude_compaction.*` ConfigStore keys. (Numbering
  collision with #10 above is a process-only inconsistency; both code
  scopes are correctly merged. Canonical `SC29-LEDGER.md` and ledger
  hygiene scheduled for 0.3.2.)
- **#11 (slice 28)**: Library Explorer daemon API — 5 new daemon GET
  endpoints (`/api/skills/library`, `/api/skills/:id/files/list`,
  `/api/skills/:id/files/read`, `/api/plugins/:id/files/list`,
  `/api/plugins/:id/files/read`) + 2 response shape additions
  (`PluginEntry.skillCount`, `LibrarySkillPublic`).

### Known Carry-Forwards (0.3.2 Candidates)

- **`rig plugin install <substrate-path>` verb**: explicitly deferred.
  Documented copy/symlink workflow is the v0 install path.
- **Topology mobile drawer**: hidden in 0.3.1 to avoid a pre-existing
  TopologyTableView renderer cascade at 375px viewports. Full
  restoration scheduled for 0.3.2 via dedicated render-path slice.
- **Plugin source-label taxonomy**: copy-installed plugins currently
  land in the `vendored` source kind; UI label says "No user-installed
  plugins" while listing them. Taxonomy refinement scheduled for 0.3.2.
- **`SC29-LEDGER.md`**: canonical SC-29 numbering ledger document.
  Authors currently self-assign exception numbers; documented ledger
  prevents collisions like the slice 24/27 #10.
- **VM PreCompact hook installer**: the documented install path for the
  `claude-compaction-restore` skill is operator-manual at v0; an
  automated installer is a 0.3.2 candidate.
- **`docs/DESIGN.md` docs-guard violation**: pre-existing
  `npm run test:repo` failure; tracked doc outside allowed paths;
  cleanup scheduled for 0.3.2 documentation hygiene pass.
- **Environment-dependent tests**: a small number of vitest suites fail
  on developer hosts due to port-conflicts (preflight) or live host
  Claude hook state (restore-check); focused-test gates pass these
  suites; cumulative-workspace runs surface the gaps. Isolation cleanup
  scheduled for 0.3.2.
- **Cross-daemon route awareness**: the VerbActions destination dropdown
  on `/for-you` currently lists session names without checking whether
  the local daemon can reach them. Routing to a non-local destination
  surfaces as an inline error (per the new error surface above) but the
  dropdown should ideally filter to local-daemon seats. 0.3.2 candidate.
- **ConceptCard data source**: `ConceptCard` component is preserved in
  source but not wired in the production adapter. A 0.3.2 slice will
  pick a deliberate data source (likely shaped backlog candidates or
  early-stage discovery items).
- **Warm error messages on demo surfaces**: daemon error strings (e.g.,
  "queue item not found") surface verbatim through the inline error
  surface. Demo-grade polish to humanize these on user-facing surfaces
  is scheduled for 0.3.2.

### Banked Discipline Patterns

0.3.1 surfaced a number of canonical agent-software-design patterns
during the Claude compaction iteration cycle and Library Explorer
finishing work. These are banked in operator-skill documentation for
agent-prompt design + daemon-to-LLM trust establishment:

- **Channel model**: normal user message is the only authorized action
  surface; hook stdout is informational-only; `/compact` args carry
  trust contracts that the post-compact prompt invokes.
- **Turn-boundary handshake**: when a daemon-driven action request
  would land too adjacent to local-command output, insert a
  non-committing acknowledgment message first to create an
  assistant-turn boundary.
- **Save-game-before-quit pattern**: full-context agent writes
  restoration breadcrumb before forced context loss; context-loss
  agent reads it on restore.
- **Structured-output forces completeness**: ask LLMs for explicit
  FULL/PARTIAL/NOT_READ accounting when thoroughness matters; counters
  token-conservation instincts.
- **Daemon-owned shared-resource discovery**: skill/plugin discovery
  belongs at the daemon layer with HTTP endpoint surfaces; UI consumes
  via typed API. Avoids workspace-cwd-relative path-resolution
  brittleness.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts cleanly
rig daemon start

# Confirm new Claude compaction policy keys are visible
rig config list | grep policies.claude_compaction

# Confirm plugins discoverable
rig plugin list

# Confirm skills discoverable
curl -s http://localhost:7433/api/skills/library | jq 'length'
```

---

## [0.3.0] - 2026-05-10

**Status**: release candidate for public publish. This entry documents the
changes since `0.2.0`.

### Summary For Installing Agents

- **Package version**: package metadata is still `0.2.0` until the release
  manager performs the final version bump. The release contents documented here
  are the intended `0.3.0` payload.
- **Migrations**: fresh databases apply migrations through
  `039_queue_target_repo`. Existing databases migrate by running
  `rig daemon start`.
- **Node engines**: the published CLI accepts Node `>=20`. The root package and
  private daemon package remain constrained to active even-numbered Node lines.
- **Specs and primitives**: workflow specs, context packs, agent images,
  workspace scaffolds, file browsing, queue observability, context usage, and
  runtime skill discovery are all first-class product surfaces.
- **UI shell**: the operator UI has been rebuilt around the V1 shell:
  destination rail, explorer, center workspace, detail drawer, vellum surfaces,
  topology graph/table/terminal modes, and focused project observability.
- **Starter content**: `0.3.0` ships generic starter workflows and starter rigs.
  Project-specific automation recipes are intentionally not shipped in product
  source.
- **No schema-breaking release change**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings remain
  backward compatible unless noted below.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts and migrations apply
OPENRIG_DB=/tmp/openrig-030-verify.sqlite rig daemon start

# Confirm settings are readable
rig config list --with-source

# Confirm starter specs are visible
rig specs ls --json

# Confirm runtime identity and loaded context
rig whoami --json
```

If any verification fails, see "Failure Modes And Remediation" below.

---

### V1 Shell And Operator UI

The `0.3.0` UI moves from prototype surfaces to a coherent operator shell:

- Two desktop chrome regions: destination rail and explorer.
- Center workspace for full pages.
- Default-closed detail drawer for previews and referenced content.
- Topology graph/table/terminal modes at a single topology URL.
- Settings rendered as a center workspace page, not as a sidebar panel.
- Vellum surface primitives, 1px region borders, and black-glass terminal
  preview styling.
- Shared runtime graphics marks for agent/runtime/tool identity.
- Retired legacy surfaces: old sidebar shell, legacy dashboard page, and
  rig-detail drawer patterns.

### Starter Rigs And Workflows

OpenRig now ships starter content designed to be useful on a fresh install
without exposing project-specific automation recipes.

- `product-team` is the primary human-directed starter rig.
- `conveyor` is the primary workflow-oriented starter rig.
- `conveyor` includes two generic workflow specs:
  - **Conveyor**: each stage can process queued work independently, so multiple
    packets can be in flight at once and natural queue backpressure handles slow
    stages.
  - **Basic loop**: one packet advances hop-by-hop around a small loop, useful
    when the operator wants a slower, easier-to-watch workflow.
- Generic starter workflows use the workflow runtime and queue primitives. They
  are examples and building blocks, not a hidden project workflow.
- Project-specific workflow specs can still be installed from a user workspace
  or private spec directory; they do not need to be committed to product source.

### Mission-Shaped Workspace Defaults

Fresh installs now have a coherent default workspace path and scaffold:

- `rig config init-workspace` creates the default workspace structure.
- Workspace defaults include missions, slices, specs, proof/evidence locations,
  steering files, and user-editable docs.
- Existing installs are rebased at read time so newer defaults become available
  without destructive rewrites.
- Read-only mission/slice indexing supports nested mission-shaped workspaces
  while preserving compatibility with earlier flat-root layouts.

### Project Observability

Project and queue work is now easier to inspect from the UI:

- For You cards classify queue lifecycle events, shipped work, progress,
  observations, and approvals.
- Queue cards hydrate qitem bodies and proof previews.
- Story tabs emphasize qitem body content and paginate long activity streams.
- Queue rows preview bodies and open the detail drawer with full source,
  destination, state, tags, and created-time metadata.
- Tests tabs show diagnostics and proof assets when no proof is available.
- Workspace and mission rollup pages include scoped Progress, Artifacts, Queue,
  and Topology tabs.
- Current/archive grouping separates active project work from old seed or
  completed work.

### Mission Control And Queue Actions

Mission Control remains the operator surface for queue observability and
qitem actions:

- Views include personal queue, human gate, fleet, active work, recent ships,
  recent activity, and recent observations.
- Actions include approve, deny, route, annotate, hold, drop, and handoff.
- Mission Control audit outcomes are reflected back into For You cards so
  terminal or already-actioned items show evidence instead of stale controls.
- Audit browsing and action history are read-only inspection surfaces.
- Existing daemon endpoints are reused; no extra workflow-specific endpoint is
  required for the public starter content.

### Files, Markdown, Progress, And Proofs

The file and proof surfaces were expanded:

- File browser supports allowlisted roots, safe reads, asset reads, and
  conflict-checked writes.
- Markdown rendering supports frontmatter, code blocks, tables, images, and
  raw/rendered toggles.
- Progress views render status pills, hierarchy, and next-work markers.
- Proof screenshots open in an in-page viewer.
- File drawer headers, proof rows, queue related refs, and story rows use
  shared graphics marks for faster scanning.

### Workflow Runtime And Spec Library

Workflow primitives are available as general infrastructure:

- Workflow specs are cached from markdown/YAML sources.
- Workflow instances and step trails are persisted.
- Specs library includes workflow entries and graph preview.
- Slice and project story surfaces can render spec-aware topology when a slice
  is bound to a workflow instance.
- Cycle-aware traversal prevents graph rendering from hanging on looping specs.

### Context Packs And Agent Images

OpenRig now has additional reusable primitives for context and session state:

- `context_packs` package related context files into a coherent sendable bundle.
- `agent_images` capture reusable starter state from productive sessions.
- Library review surfaces can inspect these primitives and show safe summaries.
- AgentSpec startup can reference context packs and agent images.
- Resume-token data is redacted at route boundaries.

### Topology, Activity, And Context Usage

Topology is now a working operational surface rather than a static diagram:

- Graph/table/terminal views are available at the topology route.
- Host graphs can show multiple rigs on one canvas.
- Rig groups can expand/collapse, persist that state, and auto-expand for
  current rig/pod/seat URLs.
- Agent activity, queue handoffs, token telemetry, and context usage are visible
  in topology views.
- Codex context telemetry is read from local session state and reflected in
  topology table and terminal views when available.
- Detached Codex sessions can still expose the last readable context sample;
  Claude context remains running-session based.

### Terminal Preview

Terminal preview matured across several passes:

- Preview panes use existing session capture primitives.
- Compact terminal popovers are portal-mounted, clamp to viewport edges, and
  resize/reposition on scroll or viewport changes.
- The compact view strips unnecessary chrome and uses a black-glass visual
  language.
- The proof viewer and terminal preview share consistent drawer/popover
  behavior.

### Runtime Skill Discovery

Runtime skill discovery is now part of profile resolution:

- Rig-local skill references still win first.
- Skills can be discovered from runtime-specific and shared user skill roots.
- Structurally invalid `SKILL.md` files are rejected with precise reasons.
- Profile resolution surfaces rejected-skill reasons instead of treating every
  broken skill as merely missing.
- The behavior is intentionally strict: a skill must have frontmatter, non-empty
  `name`, non-empty `description`, and non-empty body content.

### CLI And Daemon Release Hardening

Several release-blocking polish items landed in the CLI/daemon:

- Transcript capture now uses bounded `tmux capture-pane` polling instead of an
  unbounded pipe file.
- `rig send` wraps delivered messages with sender/recipient context and a reply
  hint.
- Generated setup markers use OpenRig naming.
- Original runtime environment aliases keep deprecated `RIGGED_*` fallbacks for
  compatibility; newer typed settings use `OPENRIG_*` only.
- ConfigStore and SettingsStore remain lockstep for typed settings.
- No new plugin loader ships in `0.3.0`; plugin support is planned for a later
  release.

### Removed Or Not Included

- Project-specific workflow recipes are not included in product source.
- The old `demo` rig is no longer the recommended starter; public docs point to
  `product-team` and `conveyor`.
- The legacy `mental-model-ha` skill is removed from starter guidance.
- Root runtime projections such as `CLAUDE.md` are intentionally not tracked.
- Package-local `pnpm-lock.yaml` files are intentionally not restored; this repo
  uses npm workspaces and the root `package-lock.json` for release installs.
- Internal release artifacts and local dogfood packets are not part of the
  public release notes.

---

### Failure Modes And Remediation

**`rig daemon start` fails with an ABI mismatch**

- Cause: native dependencies were compiled against a different Node version.
- Remediation: use an active even-numbered Node release, or rebuild native
  dependencies from the installed package directory.

**Files browser or Progress view appears empty on a fresh install**

- Cause: workspace scaffold has not been initialized or the configured root is
  not where the operator expects.
- Remediation: run `rig config init-workspace`, then inspect
  `rig config list --with-source`.

**Mission Control views are empty**

- Expected on a rig with no queue items.
- Remediation: create or hand off a queue item, then refresh. If still empty,
  confirm daemon status and DB path with `rig daemon status` and
  `rig config get db.path`.

**A skill reference resolves as rejected**

- Cause: the target `SKILL.md` exists but failed structural validation.
- Remediation: fix the skill frontmatter and body. It must include delimited
  YAML frontmatter with non-empty `name` and `description`, followed by non-empty
  markdown body content.

**A public starter workflow is too simple for a specialized loop**

- Expected. `0.3.0` ships reusable primitives and generic starter workflows.
  Specialized workflow specs should live in user workspace or private rig
  packages.

---

## [0.2.0] - 2026-04-22

Baseline for this changelog. Key shipped capabilities at `0.2.0`:

- Pod-aware multi-agent runtime with RigSpec, AgentSpec, pods, and seats.
- Rig-scoped environment management.
- Filesystem-backed spec library for built-in and user roots.
- Daemon-backed stream, queue, project, view, watchdog, and workflow primitives.
- Cross-runtime restore packets for Claude Code and Codex sessions.
- Communication primitives: `rig send`, `rig capture`, `rig broadcast`, durable
  rig chat, and transcript inspection.
- Identity and lifecycle commands: `rig whoami`, adoption/bind/materialize
  flows, snapshot/restore, and post-command handoff.
- Operator surfaces: `rig ps`, `rig ps --nodes`, queue inspection, and daemon
  status.
- 32 SQLite migrations.

---

*This changelog is written for agents and humans. It should describe public
release behavior without depending on local workspace paths or private project
packets.*
