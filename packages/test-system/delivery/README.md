# Delivery conformance suite

This kit proves OpenRig's typed delivery against the real Claude Code and Codex terminal programs. The delivery measurement case list (kept outside this repository) plans 25 cases, from idle and busy seats to drafts, dialogs, copy mode, ordering, `/clear`, compaction and restart. Quality owns the expected result for each case. This directory holds the code that drives the cases.

**Registered and runnable today:** only the cases `cases/index.mjs` lists, on both programs. Those are D01 idle, D02 busy, D03 and D04 drafts, D05 permission prompt, D06 other dialog (the model picker), D08 copy mode, D09 order, D15 multi-line paste, and issue #3076's two late-gap cells (`R3076-notice`, `R3076-send`). `run.mjs` runs nothing else, and `--cases` refuses an id that isn't registered (`no case D12 in this suite yet`).

**Planned, not fixtures yet:** `cases/expected.yaml` already states the expected result for D07, D14, D18 and D19, and its `later` list names D10, D12 (a managed `/compact` with a typed draft), D16 and D25. Compaction and restart have no fixture yet.

## Running a release

One command runs every case on every listed program version and writes the result:

```sh
# Pinned installs, one at a time, each in its own prefix. This needs the package registry, so run it outside a cell.
node packages/test-system/delivery/run.mjs install --into ~/delivery-installs \
  --claude 2.1.322,2.1.311 --codex 0.167.2,0.167.1 --openrig 0.7.12

# The run: one cell at a time. --openrig is an installed version or a path to rig's dist/bin-wrapper.js.
node packages/test-system/delivery/run.mjs run --installs ~/delivery-installs --openrig 0.7.12 \
  --claude 2.1.322,2.1.311 --codex 0.167.2,0.167.1 --out ~/delivery-run [--cases D01,D09]
```

It writes `RESULT.json` and `RESULT.md`: every cell's PASS, FAIL or NOT RUN, its evidence level, every check with what was seen, and the pins. The pins name the exact OpenRig, Claude Code and Codex, tmux, node, the OS, and the sha256 of `cases/expected.yaml`. They're read when the run starts, before any cell. For each program they give:
- its version as it reports itself;
- `entryPointSha256` for the file on PATH (a launcher, for Codex and OpenRig);
- `payloads`, its native executables;
- `packageTree`, a digest of the whole installed package;
- `lockfileIntegrity`, npm's integrity, written at install.

A cell that can't run is NOT RUN with its reason, never left out. So is a cell whose evidence wasn't banked, whose bank holds credential-shaped text, whose stand-in failed, or whose seat conversation couldn't be identified: no credit without evidence. Each `--out` holds one run, and each cell has a time limit (`--cell-timeout`, 15 minutes by default) after which it closes itself and the parent reaps anything left.

**Program transforms.** A program can rewrite pasted input itself: Claude Code 2.1.322 turns a pasted tab into four spaces. Quality lists each such rewrite in `expected.yaml` (`program_transforms`), pinned to the versions it was seen on. A cell applies one only as its exact inverse: undoing it must restore bytes OpenRig itself recorded writing. The cell then reports `PASS (program transform: <id>)`, so the content limit stays visible. Any other difference, or a new unlisted rewrite, is a FAIL.

Every cell here is at the **native-standin** level: the real program, on a local stand-in model. A real-model sample and a PTY or container run are separate levels and aren't produced by this command.

### What a cell is

Each cell gets a world of its own, built from nothing and torn down after:

- **A network namespace with loopback only.** The stand-in, a private OpenRig daemon, its own tmux server and the real program all run inside it, so nothing in a cell can reach a model service, an update server or telemetry. It needs no privilege: an unprivileged user namespace maps this user to root only long enough to bring `lo` up, then a nested one maps back to this user's own ids. Linux only; without it every cell is NOT RUN.
- **A fresh home**, with its own `OPENRIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, tmux socket and `TMPDIR`. The environment is built from an allowlist, never inherited, so the person's own home, accounts, daemon and credentials never reach it. The only credential is a dummy token the stand-in accepts.
- **One seat** from a minimal rig spec. Like a normal seat, it imports the shared spec pool of the OpenRig under test and selects OpenRig's own plugin (`shared:openrig-core`) and the managed activity hooks, so Claude Code reports its prompts through the hook, as Codex does. It leaves out the shared default settings, which turn on network MCP servers a cell can't reach. Claude Code reaches its stand-in through the spec's `env:` (`ANTHROPIC_BASE_URL` and the dummy `ANTHROPIC_AUTH_TOKEN`, with updates and telemetry off). Codex reaches its stand-in through a custom provider in the cell's `config.toml`. OpenRig itself seeds Claude's onboarding and trust, and Codex's workspace trust, as it would for any seat.
- **Ready means running.** A cell starts only when OpenRig reports the seat ready and the program's own process is found under the pane. The pane's foreground command isn't enough, since a program can run under its launch script.
- **A normal stop at the end.** The rig, the daemon, the tmux server and the stand-in are stopped in that order. Anything still running with the cell's home is then sent SIGTERM, then SIGKILL, and the steps log records it. A cell that fails to open still stops what it started.

### What a case judges by

A case reads the receiver's side first: the stand-in's request log. A delivery is a **user item in the seat's own conversation** whose typed text holds the case's marker. The log is read from the history of the latest request in the seat's thread, and each item counts once however many requests repeat it. Programs repeat history all the time: each turn resends it, a retry resends a request, and Codex re-requests a running turn with a newly typed message added after it. A side request in another thread doesn't count, though Codex's task-title request quotes the typed text. A marker inside a tool's output doesn't count either. Two sends inside one item is a merge.

Beside that, each delivery reports OpenRig's own records of the same bytes, matched by sha256. Those are #2937's `transport.delivery_evidence` and the prompt hook's `transport.prompt_observation`, where the hook is installed. They're best effort, so they're reported, not judged. With the plugin selected, both programs produce both records. When the received bytes differ, the cell puts what OpenRig says it wrote beside them, which shows on which side of the pane they changed.

Each cell's bank keeps everything a reader needs to check the verdict without trusting the harness, each file pinned in `MANIFEST.json`:

- the stand-in's request log;
- every tmux call OpenRig made, from a logging `tmux` first on the daemon's PATH (`harness/tmux`; it needs python3, so it can replace itself with the real tmux);
- the screen as frames, read with `capture-pane` only, since OpenRig already pipes the pane into its transcript;
- the harness's steps;
- the daemon's delivery tables and events, exported read only, with credential-like columns dropped;
- the program's own transcript.

Every banked file is scanned for credential-shaped text.

### Issue #3076's late gap

`cases/r3076.mjs` makes a race deterministic. A person types into an empty input box after OpenRig's draft-aware read found it empty, but before OpenRig's paste. A case arms the logging tmux with a one-shot (`DELIVERY_INJECT_DIR`). On OpenRig's next `paste-buffer` to exactly that pane, from an `openrig_` buffer, the wrapper types the draft as keys, waits until a capture shows it, and only then lets the paste run. It records both screens and the timing in `fired.json`.

There are two cells, each with its own verdict: an ordinary `rig send` (the send control) and an actual watchdog `periodic-reminder` (OpenRig's own automatic notice). The cells check two things separately:
- **contamination:** anything but the draft in the input box, or the draft and OpenRig's text reaching the model together. It's FAIL even with no Enter, and a placeholder such as Claude Code's `[Pasted text #1 +6 lines]` counts.
- **draft loss:** whether the draft's own bytes are lost or changed.

This is the real TUI with timing injected at the wrapper boundary, after the guard's final check and before `paste-buffer`. Broker input on either side of the guard's final check, text already present before the read, and a real plain `tmux attach` client are separate controls, not covered here.


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
- every header name and every query name. A value is kept only for a short list of safe names: the headers `content-type`, `accept`, `user-agent`, `anthropic-version`, `anthropic-beta` and `openai-beta`, the retry count `x-stainless-retry-count`, and the conversation ids `x-claude-code-session-id`, `session-id` and `thread-id`; and the query `beta`. Every other value is recorded as `(present)`, since a provider can be set up to send a credential under any name.
- the body as parsed, plus `rawBytes` and `rawSha256` of the body as received.
- the turn: its `kind` and its `parts`, the separate pieces of the last turn. A tool result whose content is a list of text blocks gives one part per block. Each part has its `source` (`text` or `tool_result`), its decoded text exactly, its UTF-8 `bytes`, its `sha256` and the markers it holds.
- `userTurns`: how many user turns the request's history holds.
- `request`: the conversation it belongs to (`thread`: Claude Code's session id from `metadata.user_id`, Codex's `client_metadata.thread_id`; null when it names none), how many `tools` it offers, and whether it asks for a JSON-schema answer (`structuredOutput`). A program's side requests quote the delivered text too: Codex 0.167.2 asks for a task title with the typed message in its prompt. So a case counts a delivery only in the seat's own thread.
- the rule that answered.

A turn holding a tool result is kind `tool_result`, and any text in it is kept beside the result. A message typed while a tool ran can arrive there. Claude Code 2.1.322 sends its environment as a `system` message after the turn; the turn is the last message before any trailing `system` ones.

With no rule for it, a request for a JSON-schema answer gets an object of the schema's shape (strings `stand-in`), so the program isn't shown an answer it can't parse.

A case joins this log to OpenRig's own record of a send by the correlation marker in the delivered text. So every message a case sends carries a distinct marker.

The parts show how a program framed what it received. A typed message is expected to arrive as one text part, context the program adds as another, and a second message merged into the same turn as a third. That is an expectation, not something recorded from the programs yet. The suite's real runs record it for each version, and a case judges an intact message, a merge or a split from the parts it actually got.

### What the wire contracts rest on

These were checked on 2026-11-12, against documents and source, not against any installed program:

- **Claude Code:** the gateway protocol at https://code.claude.com/docs/en/llm-gateway-protocol (npm's latest Claude Code that day was 2.1.322). A turn must stream through `message_delta` and `message_stop`. `count_tokens` is optional; this stand-in answers it with an estimate. The startup probe `HEAD /api/hello` may be refused.
- **Codex:** its Responses reader, `codex-rs/codex-api/src/sse/responses.rs` in openai/codex at commit `c0cc9fc` (npm's latest Codex that day was 0.167.2), since the docs are silent. Older Codex versions may differ, for example in the wire formats they accept. A turn must end with `response.completed`. Codex fetches no model list for a plain custom provider.

The contract tests in `packages/daemon/test/delivery-stand-ins.test.ts` use request shapes taken from those contracts, not recordings from the real programs. They prove the stand-ins match those documents, nothing more. The suite's real runs, pinned per version, record what each version actually sends.
