# Delivery conformance suite

This kit proves OpenRig's typed delivery against the real Claude Code and Codex terminal programs. It covers 25 cases, from idle and busy seats to drafts, dialogs, copy mode, ordering, `/clear`, compaction and restart. Quality owns the expected result for each case. This directory holds the code that drives the cases.

**Built so far:** the stand-in model servers. The case harness and the single release-run entry point come next.

## Stand-in model servers

A stand-in answers a real program the way its model service would, following a script. A case can then drive the real program with no account, no login and no spend. A stand-in never proves how a model behaves. It proves which requests the program sent, in what order and with what bytes. A case reads that request log as the receiver's side of a delivery, and joins it to OpenRig's own record of the send.

| Stand-in | Program | How the program reaches it |
|---|---|---|
| `stand-ins/messages.mjs` | Claude Code | `ANTHROPIC_BASE_URL=<url>` with `ANTHROPIC_AUTH_TOKEN=<any value>`. Use the token, not `ANTHROPIC_API_KEY`, which asks for approval in an interactive session. |
| `stand-ins/responses.mjs` | Codex | A custom provider: `model_provider = "standin"` and `[model_providers.standin]` with `base_url = "<url>/v1"`, `wire_api = "responses"` and `requires_openai_auth = false`. Codex then skips its login screen. |

Start one from the command line. It prints `READY <url>` once it's listening:

```sh
node packages/test-system/delivery/stand-ins/responses.mjs --script script.json --log requests.jsonl [--port 0]
```

You can also start one in-process with `startMessagesStandIn({ script, logPath, port })` or `startResponsesStandIn(...)`. Both return `{ url, requests(), release(gate), close() }`.

### The script

Each request is answered by the first rule that fits it, matched against the request's last turn. That turn is either what was typed (`user`) or a tool's output (`tool_result`). When no rule fits, a user turn gets `ok {{marker}}` and a tool result gets `done`.

```json
{ "rules": [
  { "when": "DLV-D02", "times": 1, "tool": { "name": "Bash", "input": { "command": "sleep 5; echo done" } } },
  { "on": "tool_result", "gate": "d02-turn", "say": "finished {{marker}}" },
  { "when": "DLV-D16", "error": { "status": 429, "headers": { "retry-after": "120" }, "body": { "type": "error", "error": { "type": "rate_limit_error", "message": "throttled" } } } },
  { "say": "got {{marker}}", "chunks": 4, "chunkDelayMs": 500 }
] }
```

A rule has exactly one action:

- **`say`** streams a text reply. `{{marker}}` becomes the first correlation marker in the turn; the default pattern is `DLV-…`, and `marker` at the script's top level replaces it. Use `chunks` and `chunkDelayMs` for a long turn.
- **`tool`** asks for a tool call in the program's own tool shape. The script decides which tool and its input, such as a harmless command that needs approval.
- **`error`** answers with an HTTP error, such as a 429 rate limit or Codex's `usage_limit_reached`.
- **`failInStream`** fails after streaming has started.

Optional fields on any rule:

- **`gate`** holds the answer until the case calls `POST /_stand-in/release/<gate>`, so a case controls exactly when a turn ends.
- **`delayMs`** waits before the answer starts.
- **`times`** limits how many requests the rule answers.
- **`on`** says which kind of turn the rule answers.
- **`when`** matches the turn's text.

### The request log

Each request is one JSON line in the log, also available at `GET /_stand-in/requests`. The request is logged when it arrives, before any gate or delay. A line holds:

- the method, path and headers. A token or key is recorded as `(present)`, never its value.
- the full body.
- the turn: its `kind` and its `parts`, the separate text pieces of the last turn exactly as sent. Each part has its UTF-8 `bytes`, `sha256` and the markers it holds.
- `userTurns`: how many user turns the request's history holds.
- the rule that answered.

A typed message arrives as one part. Context the program adds is another part, and a second message merged into the same turn is a third. A case can therefore tell an intact message from a merge of two, or from one message split across turns.

### What the wire contracts rest on

These were checked on 2026-11-12:

- **Claude Code:** the gateway protocol at https://code.claude.com/docs/en/llm-gateway-protocol. A turn must stream through `message_delta` and `message_stop`. `count_tokens` is optional; this stand-in answers it with an estimate. The startup probe `HEAD /api/hello` may be refused.
- **Codex:** its Responses reader, `codex-rs/codex-api/src/sse/responses.rs` in openai/codex, since the docs are silent. A turn must end with `response.completed`. Codex fetches no model list for a plain custom provider.

The contract tests in `packages/daemon/test/delivery-stand-ins.test.ts` use request shapes taken from those contracts, not recordings from the real programs. Recordings come when the suite runs the real programs.
