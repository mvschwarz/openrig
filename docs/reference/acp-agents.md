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
  agent's output;
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

## Notes for specific agents

- **OpenClaw:** `openclaw acp` is a bridge to a running OpenClaw Gateway, so start the Gateway first, then run, for
  example, `rig acp run <row> -- openclaw acp --url ws://127.0.0.1:18789 --token-file <file>`. Its permission requests
  come from the Gateway's exec approvals.
- **Continuing a session:** `--load-session <id>` continues an earlier session when the agent advertises loading. If it
  doesn't, or the load fails, the run reports that and starts nothing new.

## Limits

- One run is one turn for one row.
- The client offers the agent no file-system or terminal methods; the agent works in its own environment.
- Spend is whatever the agent's provider charges; OpenRig doesn't measure it.
