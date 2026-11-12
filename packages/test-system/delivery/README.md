# Delivery conformance suite

This kit proves OpenRig's typed delivery against the real Claude Code and Codex terminal programs. It covers 25 cases, from idle and busy seats to drafts, dialogs, copy mode, ordering, `/clear`, compaction and restart. Quality owns the expected result for each case. This directory holds the code that drives the cases.

**Built so far:** the stand-in model servers. The case harness and the single release-run entry point come next.

## Stand-in model servers

A stand-in answers a real program the way its model service would, following a script. A case can then drive the real program with no account, no login and no spend. A stand-in never proves how a model behaves. It proves which requests the program sent, in what order and with what bytes. A case reads that request log as the receiver's side of a delivery, and joins it to OpenRig's own record of the send.

| Stand-in | Program | How the program reaches it |
|---|---|---|
| `stand-ins/messages.mjs` | Claude Code | `ANTHROPIC_BASE_URL=<url>` with `ANTHROPIC_AUTH_TOKEN=<any value>`. Use the token, not `ANTHROPIC_API_KEY`, which asks for approval in an interactive session. |
| `stand-ins/responses.mjs` | Codex | A custom provider: `model_provider = "standin"` and `[model_providers.standin]` with `base_url = "<url>/v1"`, `wire_api = "responses"` and `requires_openai_auth = false`. Codex then skips its login screen. |

A stand-in listens on loopback only (`127.0.0.1`, `::1` or `localhost`; an IPv6 address is bracketed in its URL). Its log keeps each request's parsed body, plus the raw body's size and sha256, so it's knowingly sensitive: point it only at synthetic fixtures, never at real work.

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
- **`tool`** asks for a tool call in the program's own tool shape. The script decides which tool and its input, such as a harmless command that needs approval. On Codex it's always a `function_call` item; custom-tool and local-shell calls can't be scripted yet.
- **`error`** answers with an HTTP error, such as a 429 rate limit or Codex's `usage_limit_reached`.
- **`failInStream`** fails after streaming has started.

This script is not the stub runtime's script (`packages/test-system/scenarios/scripts/`). Both use the word `say`, but here it's a rule's reply, and there it's a step (`{"kind":"say"}`) a stub seat performs. The two formats don't mix.

Optional fields on any rule:

- **`gate`** holds the answer until the case calls `POST /_stand-in/release/<gate>`, so a case controls exactly when a turn ends.
- **`delayMs`** waits before the answer starts.
- **`times`** limits how many requests the rule answers.
- **`on`** says which kind of turn the rule answers.
- **`when`** matches the turn's text.

A script is checked when it loads: `rules` must be a list (an absent one means the fallback answers everything), every rule needs exactly one action, and every `when` and `marker` pattern must compile.

### The request log

Each request is one JSON line in the log, also available at `GET /_stand-in/requests`. The request is logged when it arrives, before any gate or delay. A request to the main path whose body isn't JSON is logged as `served: "malformed"` and answered with a 400, never a scripted reply. If the stand-in can't write its log, it answers 500 and records the failure at `GET /_stand-in/errors`, so a request missing from the log reads as the stand-in's failure, not the program's. A line holds:

- the method and path.
- every header name and every query name. A value is kept only for a short list of safe names: the headers `content-type`, `accept`, `user-agent`, `anthropic-version`, `anthropic-beta` and `openai-beta`, and the query `beta`. Every other value is recorded as `(present)`, since a provider can be set up to send a credential under any name.
- the body as parsed, plus `rawBytes` and `rawSha256` of the body as received.
- the turn: its `kind` and its `parts`, the separate pieces of the last turn. A tool result whose content is a list of text blocks gives one part per block. Each part has its `source` (`text` or `tool_result`), its decoded text exactly, its UTF-8 `bytes`, its `sha256` and the markers it holds.
- `userTurns`: how many user turns the request's history holds.
- the rule that answered.

A turn holding a tool result is kind `tool_result`, and any text in it is kept beside the result. A message typed while a tool ran can arrive there.

A case joins this log to OpenRig's own record of a send by the correlation marker in the delivered text. So every message a case sends carries a distinct marker.

The parts show how a program framed what it received. A typed message is expected to arrive as one text part, context the program adds as another, and a second message merged into the same turn as a third. That is an expectation, not something recorded from the programs yet. The suite's real runs record it for each version, and a case judges an intact message, a merge or a split from the parts it actually got.

### What the wire contracts rest on

These were checked on 2026-11-12, against documents and source, not against any installed program:

- **Claude Code:** the gateway protocol at https://code.claude.com/docs/en/llm-gateway-protocol (npm's latest Claude Code that day was 2.1.322). A turn must stream through `message_delta` and `message_stop`. `count_tokens` is optional; this stand-in answers it with an estimate. The startup probe `HEAD /api/hello` may be refused.
- **Codex:** its Responses reader, `codex-rs/codex-api/src/sse/responses.rs` in openai/codex at commit `c0cc9fc` (npm's latest Codex that day was 0.167.2), since the docs are silent. Older Codex versions may differ, for example in the wire formats they accept. A turn must end with `response.completed`. Codex fetches no model list for a plain custom provider.

The contract tests in `packages/daemon/test/delivery-stand-ins.test.ts` use request shapes taken from those contracts, not recordings from the real programs. They prove the stand-ins match those documents, nothing more. The suite's real runs, pinned per version, record what each version actually sends.
