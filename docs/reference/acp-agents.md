# Handing work to an ACP agent

`rig acp run` gives one queue row's task to an agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), such as OpenClaw's `openclaw acp`, and records what
happened on that same row. The seat that runs it is the row's custodian; the agent is recorded as the executor.

```sh
rig acp run <qitemId> --cwd <work folder> -- <the agent's ACP command> [args...]
```

The row's notes get, in order:
- **the binding:** the agent's name and version, the ACP protocol version, whether it can load sessions, and the session;
- **progress,** about once a minute (tool calls so far, output so far); the full transcript is in the run's log file, named on the row;
- **each permission request and its answer** (below);
- **the outcome:** `completed`, `stopped` (for example `max_tokens`), `cancelled`, `failed` or `unknown`, with the
  agent's output and the tokens and cost it reported, each labelled with where it came from (unknown when it reported
  none);
- **what happened to the agent's processes** after the run ended.

The outcome is the agent's report, not a judgment of the work. The row stays open and yours: read the result, then
close it or hand it on with your own resolution, as you would any other.

## When the agent asks permission

OpenRig holds no permission policy of its own. The agent's own settings decide what it asks, and an owner decides
the answer. Each request becomes a queue row to `--permissions-to` (this seat by default), listing the action, its
target, the options the agent offered and the run, session and request it belongs to. Answer on that row with the
option's id:

```sh
rig queue update <permission row> --state done --closure-reason no-follow-on --resolution allow-once
```

Answer on the permission row itself; don't hand it off, because the run waits on that row. The answer goes back to
that one request, once. The turn waits for it; there's no deadline. An answer that isn't one
of the offered options is noted and the question is asked again. If the turn is cancelled first, the permission row
is closed as stale and nothing is sent. Whoever answers can follow their own written policy; that choice is theirs.

## Cancel, detach and stop

These are different things, and the row keeps them apart:
- **Cancel** (Ctrl-C, or `rig acp cancel <runId>` from another terminal) asks the agent to stop its turn. The row
  records when it was requested and when the agent acknowledged it. Whether the model provider stopped work, and what
  it cost, stays **unknown** unless you check the provider's own usage.
- **Detach** (a second Ctrl-C, or the run ending normally) closes the agent's connection. That doesn't stop
  the agent's runtime.
- **Stop:** when the run ends, it reports whether any process carrying the run's environment marker remains:
  `settled` (none), `incomplete` (with their process ids) or `unknown` (the process table couldn't be read). Only
  processes that inherited the marker are seen, so one the agent started with a cleared environment, or through a
  service manager, isn't. It never touches a process it didn't launch. To stop what's left, use the runtime's
  own stop command, through `rig acp stop <runId> -- <that command>` so the result lands on the row.

A gateway the agent connects to but didn't start, such as OpenClaw's Gateway, isn't a process of the run. Leave a
shared one running; stop your own with its own command.

## Reading the outcome

- `completed`: the agent ended its turn with output.
- `unknown`: the turn ended, but nothing shows the work happened. That covers an `end_turn` with no output and no or
  zero usage (an agent can end a turn this way after its provider refused the request), an `end_turn` whose text
  reports an interruption (OpenClaw's `[OpenClaw interruption]`), and a connection that closed before the turn ended.
  Check the agent's own log before you treat it as done.
- `failed`: the agent returned an error. The row keeps its original code, message and data.
- `cancelled`, `stopped`: as above.

## Claude Code and Codex, through their ACP adapters

Both have maintained ACP adapters. What follows was checked on 2026-11-06 with OpenRig 0.7.8: one small file task per
case, with `claude-haiku-5-5` and with `gpt-6.1-sol` at low effort. Other models weren't checked.

Install the adapters once; running them through `npx` adds about 10 seconds a turn:

```sh
npm install --prefix <dir> @agentclientprotocol/claude-agent-acp@0.101.0 @agentclientprotocol/codex-acp@2.5.0
export PATH="<dir>/node_modules/.bin:$PATH"

rig acp run <row> --cwd <work folder> -- env CLAUDE_CODE_EXECUTABLE=<your claude> ANTHROPIC_MODEL=<model> claude-agent-acp
rig acp run <row> --cwd <work folder> -- codex-acp
```

**Which versions run.** The binding note on the row names the adapter and its version.
- `claude-agent-acp` 0.101.0 runs Claude Code through the Claude Agent SDK 0.3.318. With `CLAUDE_CODE_EXECUTABLE` set,
  it runs that `claude`, with that `claude`'s own login; the check ran Claude Code 2.1.310 this way. Without it, an npm
  install runs the Claude binary from the SDK's platform package (Claude Code 2.1.318, by the SDK's package metadata),
  which wasn't checked. Installing with `--omit=optional` leaves that binary out, and then, without
  `CLAUDE_CODE_EXECUTABLE`, the adapter refuses to start; it never falls back to a `claude` on PATH. The adapter also
  loads your Claude configuration, skills included.
- `codex-acp` 2.5.0 depends on `@openai/codex` `^0.165.0`, and 0.165.0 was the only release in that range when this
  was checked. A later install can resolve a newer 0.165 release; `npm ls @openai/codex` in `<dir>` shows yours. It uses
  the machine's existing Codex login.
- `@zed-industries/claude-code-acp` and `@zed-industries/codex-acp` are deprecated on npm in favour of these. The zed
  `codex-acp` 0.16.0's Codex was too old for the model in the check.

**Permissions.** Each agent keeps its own permission mode, and OpenRig adds no restriction. In the check, neither
asked anything for file writes or shell commands: Claude started in `auto` mode and Codex in `workspace-write`. To
have the agent ask, so that each request becomes a permission row:
- **Claude:** give it a dedicated `CLAUDE_CONFIG_DIR` whose settings set `permissions.defaultMode` to `"default"`.
- **Codex:** set `INITIAL_AGENT_MODE=read-only` in its environment. Approval and sandbox keys in `CODEX_CONFIG` didn't
  make it ask.

These are the settings the check used to make the agents ask. Whether to use them is the caller's choice; they're not a
recommended default. Send permission rows to a seat that can be woken: a row to a `terminal` seat sets off the stuck
sweep.

**Answers differ between the two.**
- **Claude** offers `allow-once`, `allow-with-updates` (allow always) and `reject`. `reject` refuses that one action,
  and the turn carries on.
- **Codex** offers `allow_once`, `accept_execpolicy_amendment` (allow always) and `cancel`. Its only refusal, `cancel`,
  ends the whole turn, and the outcome is `cancelled`.

**Continuing, and a session that doesn't exist.**
- **Continuing:** `--load-session` continued an earlier session on a second row with both adapters.
- **A made-up session id:** both refused it and started nothing, but they report it differently. Claude returns
  `-32002 Resource not found`, and Codex returns `-32603 Internal error` with "no rollout found" in its data. The row
  shows `failed` with the agent's own error. Neither code by itself means a missing session, so read the message.

**A completed turn isn't finished work.** In the check, Claude was asked to run a command and wait for it. It moved the
command into a background task, said it would report when it finished, and ended the turn `completed`. The task died
with the adapter, and its file never appeared. Check the work itself before you close the row. Beyond this one case,
long and background work weren't checked.

**Cancel.** `rig acp cancel` was acknowledged in 20-30 ms for both, sent while the agent waited on a permission
answer; a cancel mid-generation or mid-tool wasn't timed. Straight after, Claude's run reported `incomplete`
with one process still running, which was gone a few seconds later; Codex's reported `settled`. An acknowledgement
isn't a finished shutdown, and it says nothing about further spend.

**Usage and cost.** Claude's adapter reports token usage and a cost in USD; Codex's reports tokens only. Both are in
the run's log file, not on the row.

**Not checked:**
- long or multi-tool tasks, and background work;
- concurrent runs;
- `rig acp stop` with a real stop command;
- an adapter that crashes mid-turn;
- continuing after a daemon restart;
- MCP servers.

## Notes for specific agents

- **OpenClaw:** `openclaw acp` is a bridge to a running OpenClaw Gateway, so start the Gateway first, then run, for
  example, `rig acp run <row> -- openclaw acp --url ws://127.0.0.1:18789 --token-file <file>`. Its permission requests
  come from the Gateway's exec approvals.
- **Continuing a session:** `--load-session <id>` continues an earlier session when the agent advertises loading. If it
  doesn't, or the load fails, the run reports that and starts nothing new.

## Running it in the background: `rig exec`

`rig exec` runs the same single turn on a named harness, `claude` or `codex`, through that harness's ACP adapter, in a
connector that outlives the command:

```sh
rig exec harnesses                               # the adapter and native versions installed here, and how each differs
rig exec run <row> --harness claude --plan       # what would run, with versions; starts nothing
rig exec run <row> --harness claude [--wait]     # start it; --wait waits here for the outcome
rig exec status <runId|row>                      # state, outcome, usage and cost, and what still runs
rig exec cancel <runId>
```

- **The connector owns the run.** Closing the terminal, or leaving `--wait` with Ctrl-C, doesn't stop it. Its record
  in `$OPENRIG_HOME/acp/runs/` holds its process and its state: `requested`, `started`, `finished` or `interrupted`.
  The row gets the same notes as with `rig acp run`.
- **One run per row.** Running it again returns the row's run, still going or ended, instead of sending the task
  twice. `--again` starts another turn once that run has ended.
- **Interrupted.** A run whose connector died without recording an outcome reads `interrupted`, outcome unknown, with
  one note on the row, the next time `status`, `run` or `--wait` looks at it. Whether any of the agent's processes
  remain is said there too.
- **Missing.** With `--load-session`, a session reads `missing` only on the adapter's own evidence: for Claude,
  `-32002` naming that session; for Codex, its "no rollout found for thread id" error for that session. Any other error
  reads `failed`, with the agent's code and message, and no new session is started either way.
- **The outcome is the agent's report.** `finished` with `completed` means the turn ended; accepting the work stays
  with you, on the row. `--wait` exits 0 for `completed`, 2 for any other outcome, and 3 when you stop waiting.
  Without `--wait`, a run that has already ended exits the same way, and one still going exits 0. Either way the code
  follows the row's run, including one another caller started.
- **Permissions:** the agent keeps its own mode, and `rig exec` adds no policy; your environment passes through.
  `rig exec harnesses` lists what each harness reads.

`rig acp run` is unchanged: it stays in your terminal for the length of the turn.

## Limits

- One run is one turn for one row.
- The client offers the agent no file-system or terminal methods; the agent works in its own environment.
- Spend is whatever the agent's provider charges. OpenRig doesn't measure it; it records only what the agent reports.

## OpenRig as an agent in ACP apps

The other direction: `rig acp serve`. An app that speaks ACP and can launch a custom agent command can offer your OpenRig team as its agent. The app starts
`rig acp serve` and talks to it on stdin and stdout:

```sh
rig acp serve --to <member@rig>
```

Without `--to`, the receiver is this machine's `acp.to` setting: `rig config set acp.to <member@rig>`, set once. An
app that starts the agent from the ACP registry passes no arguments, so that's how it reaches your team.

- **A prompt** becomes a queue row from you to `--to`, the seat that takes your team's new work. The row's body is your
  prompt, plus a line saying which app sent it and that its closing resolution is your answer.
- **Progress:** each row the work reaches shows in the app as a step (`Sent to …`, then `Handed to …` at each handoff),
  with the row's notes as they're written, each with the seat that wrote it. The step's title also shows its latest
  note, for apps that show steps collapsed.
- **The reply** is the closing resolution, with who closed the row and how (`done`, `done (canceled)`, `denied`, …). The
  turn ending says only that the turn ended: read the reply for how the work ended.
- **A follow-up** in the same session goes to `--to` as a new row whose body names the earlier rows and their states,
  and the app first shows any earlier row that's still open.
- **A question the team asks you** while a turn is open comes to the app with the ask's own choices, when its row is
  tagged for that chat (`acp-session:<id>`; the task's row tells the team how). An app that takes forms (it
  advertises ACP elicitation's form mode, as T3 Code does) gets a one-choice form with each choice by its label; any
  other app gets a permission request with one option per choice, as Zed shows them. An untagged
  question from a seat the work reached is named in the chat with where to answer it, because it could be another
  chat's. Your choice is recorded as your answer, as a click in Slack would be, and the seat that asked gets it.
  Dismissing it, or cancelling the turn, records nothing: the question stays open in the TUI and Slack, and no further
  question opens after a cancel. A question that ends unanswered here (dismissed, cancelled, closed with the work, or
  one the app couldn't show) is named in the chat as still open, as well as on its card. A question that wants an
  answer in words is shown with where to answer it.
- **Sessions are kept in the queue:** the app can list your earlier sessions (`session/list`) and reopen one
  (`session/load`). Reopening replays each prompt, its work, the questions the team asked you during it with your
  answers, and the reply, as they stand now. Nothing is asked again on reopening: a question still open comes up in
  your next prompt's turn, and a new prompt continues the session.
- **Cancel** stops `rig acp serve` waiting. The team's work carries on, and the reply says so.
- **Work handed to a seat on another machine** can't be followed from here; the reply says where it went.

**Who you are:** `--as <address>`, else `OPENRIG_SESSION_NAME`, else this machine's default person: the only
registered person, or the one chosen with `rig gateway default <id>` when there are several (the address is
`<id>@external`). The app's sign-in step, "OpenRig on this machine", checks
that the daemon answers and that you resolve to an address; until then, signing in and new sessions fail with the
reason and the fix. The agent talks to the same daemon as `rig` on this computer: the local one, so start it first
(`rig daemon start`), unless `OPENRIG_URL` names another.
The team's questions reach you only as a registered person: an `<id>@external` address needs
`rig gateway human add <id> --display-name "<your name>" --delivery-class <A|B|C|D>` first. Until then, the app says
so at your first prompt, and your work is still sent.

**In Zed**, add the agent to `settings.json`:

```json
"agent_servers": {
  "OpenRig": { "type": "custom", "command": "rig", "args": ["acp", "serve", "--to", "lead@my-team"] }
}
```

Other apps take the same command and arguments wherever they configure a custom ACP agent.

**Limits:**
- One receiver per agent command (or the `acp.to` setting); the app has no team picker.
- Questions show only while a turn is open; one asked while no turn is open waits in your usual places (the TUI, Slack).
- An app that shows a permission request's options only as fixed buttons, such as Approve and Decline, and doesn't
  take forms, can't show the choices: answer those questions in the TUI or Slack.
- Prompts are text. Links and embedded text files are passed on as written; images and audio aren't accepted.
- Progress is read every 2 seconds while a turn is open (`--poll-seconds`).
- Sessions are found among the 2,000 newest rows you've sent, and a reopened session's questions among the 2,000 newest
  sent to you, so a caller with a lot of traffic, such as a busy seat, can't list or fully reopen its oldest sessions.
