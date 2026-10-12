# What changed in OpenRig 0.6.10

This note is for an agent on an install that was just upgraded to 0.6.10. It lists only what behaves differently from
0.6.9 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). Two migrations run on the first start: `099`
  adds one partial index to the queue table, and `101` adds four empty columns to `sessions`. Neither changes existing
  data. There is no migration `100`. The bundled openrig-core plugin goes from 0.1.8 to 0.1.9.

## Output that changed shape

- **`rig capture --lines N` is the last N lines,** after blank rows at the bottom are dropped. When earlier lines are
  cut, stderr says `[rig capture: <session>: N earlier lines not shown; last M shown]`. In `--json`, `lines` is then
  the count returned, and `requestedLines` and `omittedLines` are new (per seat under `--rig` or `--pod`). For the old
  output, N history lines plus the whole pane, add `--history-plus-pane`; it keeps the old JSON too, without
  `requestedLines` or `omittedLines`. Without `--lines`, or with a non-numeric or zero `--lines`, nothing changed. A
  short capture doesn't prove a seat is idle.
- **Compact `rig queue list` rows carry `summary`,** and so do `overdue` and `undelivered`. The fields they leave out
  (`body`, `evidenceRef`, `humanDetail`, `waiting`, `chainOfRecord`, `replyTo`, `humanQuestions`, `humanAnswers`) are
  now absent, not `null` or `""`, and `fieldsElided` names them. A filter that tested those fields for null must test
  for presence. Read a full row with `rig queue show <id> --full --json`.
- **`lastNudgeResult` reads `claimed`** on a claimed row whose wake was recorded as `delivered-ack-pending` or
  `indeterminate:…`. The recorded value is unchanged and shows in the new `lastNudgeWireResult`; unclaiming brings it
  back. `claimed` is never promoted to `verified`.
- **`rig chatroom history` returns the newest messages** when you give neither `--after` nor `--since`, still listed
  oldest first. Before, a room longer than the limit returned its oldest messages. `--after` and `--since` still page
  forward from that point, and `rig chatroom wait` is unchanged.

## Seats and restore

- **`rig launch <rigId> <seat>` no longer calls an exited agent running.** When a seat's kept pane is at an idle shell,
  the launch returns `attention_required` (HTTP 409, exit 1) with `Session alive, agent not running for '<seat>'` and
  the ways back: resume it with `--snapshot-id <id>` when a snapshot can, `rig seat launch <session> --fresh --stop`, or
  restart the agent in the pane. The pane and its history are kept. This covers Claude Code, Codex, Pi and OMP seats.
- **`rig up <rig> --existing` puts back the guidance `rig down` removed.** Before a resumed seat starts, the missing
  OpenRig managed blocks go back into the rig's Claude file (`CLAUDE.md`, or `CLAUDE.local.md`) or `AGENTS.md` for
  Codex. Existing blocks and the person's own text are untouched, and nothing is sent to the conversation. The
  warnings say `Restore guidance: <seat>: put back missing blocks …`. A seat still missing a block keeps running, its
  node lists `guidanceGaps`, the rig reads `partially_restored` instead of `fully_restored`, and `rig up` exits 1.
- **A resumed Claude seat whose session ID changed can prove.** When Claude continues `--resume T1` under a new ID T2,
  and the first SessionStart hook from the process OpenRig launched reports `source: "resume"`, OpenRig records T2. The
  seat restores as `resumed`, `rig seat clear-attention` can clear it, and sends stop warning that the launch identity
  differs. Resume commands now start with `OPENRIG_RESUME_LAUNCH='<T1>'`. It needs openrig-core 0.1.9; `/clear`, an
  in-process `/resume`, or a hand-started process still keep the refusal.
- **A restore no longer proves a seat from a launcher's token** when the launcher isn't Claude and the Claude it
  started names a different conversation. That seat reads `mismatch` and the restore returns `attention_required`.
- **A seat whose tmux session is confirmed gone reads `detached`,** with activity `unknown` and reason
  `session_missing`. `rig ps --nodes` shows `tmux session missing; restore or relaunch the seat`, `rig seat status`
  prints a `Reason:` line, and `--full --json` adds `storedSessionStatus`. The stored status isn't rewritten.
- **A Codex seat at its usage limit reads `unknown` with reason `usage_limit`,** not idle, when its screen ends with
  the `■ You've hit your usage limit` banner. For a seat bound to a known Codex account, `rig provider signals` can show
  a provider-event signal for that account that allows a switch decision.
- **`rig add <rig> …` takes the rig's name as well as its ID.** A name two active rigs share is refused with
  `rig_ambiguous` and the candidates. `rig launch` still takes an ID only.
- **`rig start` says why it skipped an existing kernel:** `Kernel auto-boot skipped (kernel rig already managed).` and,
  if its seats aren't running, `rig up kernel --existing`.

## Sends and wakes

- **Codex seats behind a launcher receive sends.** When a seat's `codex` is a launcher that starts Codex as a child,
  `rig send` and queue wakes used to refuse with "reports sh as the foreground command". The deepest `codex` on one
  process chain now counts as the seat. Codex processes on separate branches, or naming different conversations, are
  still refused.
- **Claude's faint suggested prompt isn't a person's draft.** A send to an idle Claude seat whose empty input box shows
  only that suggestion is no longer refused as `prompt_draft`. OpenRig takes one styled capture to tell; real typed or
  pasted text is still refused, and a suggestion that wraps onto a second row still reads as a draft.
- **`rig queue create --verify` reports a seat's wake and claim.** For an agent destination it returns as soon as a
  wake result or a claim is recorded, bounded at 30 seconds, with `receiptSource: "terminal"`, `outcome`, `wakeResult`
  and `claim {observed, claimedAt, pickup}`. An unconfirmed receipt is not a failed handoff. See the known gap below
  for a row the seat already claimed.
- **Keep agent-to-agent escalations off the person's Slack (off by default).** `rig config set queue.wake_human_rung
  explicit-only` (or `OPENRIG_QUEUE_WAKE_HUMAN_RUNG`) stops the wake ladder's last step at `rig view show escalations`
  unless the row is addressed to a person: an `@external` address or a registered human. A seat stuck at a prompt only
  a person can clear still reaches one, and an unreadable human registry posts everything. The default, `always`,
  changes nothing.

## Slack

- **A decision click that isn't recorded gets one reply in the thread** saying why: the clicker isn't registered, the
  decision was sent to someone else or is no longer waiting, the button no longer matches, or OpenRig can't find the
  decision. Where it helps, the reply asks for an answer in words. A recorded click still gets its usual reply, and a
  redelivered click gets no second one. It's best effort and needs the bot token. A successful press doesn't exercise
  these replies.

## Terminals and attach

- **Attach commands name the daemon's tmux server.** When the daemon was started inside tmux on a non-default socket,
  every attach command OpenRig prints carries `-L <name>` or `-S <path>`, including `tmuxAttachCommand` in `rig ps
  --json`. From inside tmux, run it as `env -u TMUX <tmuxAttachCommand>`. On the default server nothing changed.
- **When a caller of the daemon's terminal API names no provider, the daemon uses cmux if Herdr isn't available** and
  cmux is, and says so. A named `--provider` is used as named. `rig terminal open` without `--provider`, and the TUI's
  "Open terminals", open Herdr, or plain tmux when Herdr is missing, never cmux. The TUI's preview now asks for the
  same provider as the window it opens, so it isn't refused when cmux is running.
- **A tmux started inside a Herdr pane is recognised** by Herdr's markers (`HERDR_ENV`, `HERDR_PANE_ID`,
  `HERDR_SOCKET_PATH`), so `rig terminal open --window` opens in that Herdr.

## Setup

- **`rig setup --providers claude|codex|both`** (or a comma list) sets which harnesses it installs and checks. One not
  chosen reads `skipped` with `Not selected: …`, never failed. Without the flag, setup is unchanged. `rig doctor` still
  checks both.
- **A first `rig daemon start` after a timed-out probe goes ahead when the port is free,** as on WSL2. A port that's
  really held is refused with `Address already in use (EADDRINUSE)` and the `--port` advice.

## Teams

- **Starter and factory teams run their own first steps and checks without stopping for approval** where they can:
  plain `rig` commands, the file tool instead of a heredoc, the project's test command first. Their leads read the goal
  from `rig queue show <id> --full`.
- **The operator says what a team launch changes in the person's folder before asking** (`CLAUDE.md`, skills,
  `.mcp.json`, `.openrig/`, and an accept-edits `.claude/settings.local.json`), and offers a separate copy such as a git
  worktree. When a seat shows `needs_input`, the operator or lead tells the person which seat, what it asks, and its
  attach command.

## Smaller fixes

- `_` and `%` in a `rig view show <lens> --rig <name>` rig name are no longer wildcards, in all seven lenses that
  filter by rig.
- `rig ask` matches chat keywords such as `config.json` or `C++` literally.
- `rig heartbeat` reads CRLF queue files and reads a zone-less proof timestamp as UTC when picking the latest.
- `rig usage top` reads every sample in its window; `rig usage top|series --json` prints the daemon's error as JSON.
- A `?limit=` that isn't a number returns 400, not 500.
- `rig workflow instantiate` and `project` print the instance and packet the daemon returned.
- `rig transcript --tail` keeps a line ending in `%` and drops a repeated prompt.
- `--json` after `--` no longer turns an error into JSON; `rig env` prints the daemon's error.
- A file read over 1 MiB ends at a whole UTF-8 character, and `truncatedAtBytes` says where.
- The TUI counts CR+LF as one Enter, keeps an emoji whole at a wrap, pages Local reading directories by 10, and skips
  fenced examples when opening a file at a heading.
- Scope progress rows go only under a matching `##` heading, frontmatter updates stay inside the exact `---`
  delimiters, a capability delta expires only with a readable successor file, and fenced examples no longer count as
  slice sections or progress tasks.
- `rig package install` looks for a guidance block's closing marker only after its opening one.
- A Codex seat keeps its last context reading across quota-only usage records, and a fresh Codex launch keeps git
  metadata paths that end in whitespace.

## What to stop doing

- **Stop reading "already running" from `rig launch` as healthy** for a seat whose agent may have exited; 0.6.10 says
  `attention_required`.
- **Stop reading `rig capture --lines N` as N history lines plus the pane.** Add `--history-plus-pane` for that.
- **Stop testing compact queue rows for null fields.** They're absent; check `fieldsElided`.
- **Stop attaching to the default tmux server** when the printed command names `-L` or `-S`.

## Known gaps in 0.6.10

- **`rig queue create --verify` can report `outcome: "indeterminate"` for a row the seat already claimed,** with
  "Terminal receipt unconfirmed (claimed)." Read `claim` for pickup: neither the claim nor this outcome shows the
  message was displayed or read. It isn't a failed handoff, so don't re-run the create.
- **The latest first-install check used 0.6.9 on Linux only.** macOS was last checked with 0.6.8, and native Windows
  hasn't been checked.
- **Only one selected lifecycle-help command has been checked in a live Claude session;** source and parser coverage
  is broader. If a help command still asks, report it.
- **Codex team seats aren't asked before lifecycle commands yet.**
- **The send gate trusts the most recently recorded hook.** If hooks are recorded out of order, it can hold a send for
  a question that's already answered, or miss one that's waiting. `rig capture` shows the real screen.
- **A Codex seat whose permission request was approved automatically can still read "needs input".**
- **A launched team still writes into its working folder;** the operator now says what changes before you agree.
- **After a restart, `rig status` shows `Kernel: skipped` whatever the kernel seats' state.** Read them with
  `rig ps --nodes --rig kernel --full`.
- **`rig tui --shared` still attaches on the default tmux server,** so it can't find the dashboard when the daemon runs
  on a non-default tmux socket. Use `rig tui` there instead.
