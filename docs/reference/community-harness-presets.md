# Community harness presets

A community harness is a coding harness an outside contributor maintains. You install it as one small data file, and a
rig member runs it by naming it as its `runtime`. OpenRig doesn't test these harnesses. It shows them as community
harnesses, and it reads their activity only from what the screen shows.

## The preset

One YAML file per harness: `$OPENRIG_HOME/community-harnesses/<name>.yaml`. `rig community-harness list` shows what's
installed.

```yaml
format: 1
name: example-harness           # must match the file name: lowercase letters, digits and hyphens
command: example-launch         # one program and its arguments, typed into the seat's pane
maintainer: Example Maintainer
limits:                         # what the maintainer says doesn't work
  - fork unsupported
launch_result: true             # optional: the launcher reports the conversation it created (below)
# names_conversation: true      # optional, instead of launch_result: OpenRig names the conversation (below)
resume: true                    # optional, needs one of those two; declare it only once your harness's resume is checked
```

- **`command`** is a single program and its arguments. Shell syntax such as `|`, `&&`, `;`, redirections or `$(…)`
  is refused: put it in a script and name the script.
- **Built-in runtime names are reserved.** A preset can't replace `claude-code`, `codex` or the other built-ins.
- **Unknown fields are refused,** so a preset written for a newer OpenRig says so instead of half-working.
- **Fork isn't supported, and resume only as described below.** Neither is placing skills, guidance or startup files. The seat is
  called ready while something other than a shell runs in its pane, which says nothing about which conversation it is.

## Reporting the conversation a launch created (`launch_result: true`)

Some harnesses create their own conversation id before they start. Cursor's `cursor-agent create-chat` is one. With
`launch_result: true`, the harness's launcher tells OpenRig that id for each launch.

1. **OpenRig names one file per launch attempt.** It starts `command` with two variables:
   - `OPENRIG_LAUNCH_RESULT`, a new file path inside `$OPENRIG_HOME/state/launch-results/`;
   - `OPENRIG_LAUNCH_ATTEMPT`, this attempt's id.
2. **The launcher writes one JSON record to that path,** then starts the harness:
   ```json
   { "format": 1, "attempt": "<OPENRIG_LAUNCH_ATTEMPT>", "harness": "cursor", "nativeRef": "<the conversation id>", "producer": "openrig-cursor-launch 1.0" }
   ```
3. **OpenRig reads that attempt's record once,** waiting up to 20 seconds for it. It records `nativeRef` on the session,
   and the seat shows its identity as **reported by its launcher, not observed**. That's what the launcher says, not
   proof that the harness used it.

The seat still starts, with its identity **unavailable** and the reason named, when the record:
- wasn't written;
- belongs to another attempt or another harness;
- isn't JSON, isn't format 1, or is larger than 64 KiB;
- has an unusable `nativeRef` (empty, too long, or containing spaces or control characters);
- names no producer;
- or is reached through a link.

None of these means the conversation is gone.

A reported id doesn't make the harness resumable on its own. Without `resume: true`, nothing resumes it: a restore
stops and asks, as it did before (re-run it with `--fresh <seat>` only if you want a new conversation), and elsewhere a
resume says it's unsupported, and a new conversation starts only where the caller allows a fresh start.

**Good to know:**
- **The variables are passed with `/usr/bin/env`,** so `launch_result` needs a POSIX system.
- **A launcher that never writes its record** adds up to 20 seconds to each launch, while OpenRig waits for it.
- **Records are kept,** one small file per attempt, under `$OPENRIG_HOME/state/launch-results/<session>/`. A record
  larger than 64 KiB isn't read.

## Letting OpenRig name the conversation (`names_conversation: true`)

Some harnesses take a conversation name from the caller and create that conversation, or reopen it. Hermes's
`hermes chat -c <name> --create-if-missing` is one. With `names_conversation: true`, OpenRig names each new conversation
and the harness uses that name, so no record is needed.
- **A new launch:** OpenRig starts `command` with `OPENRIG_CONVERSATION` set to a new name, `openrig-<seat>-<8 hex digits>`
  (at most 100 characters). Each launch gets its own name, so two seats never share a conversation.
- **What the seat shows:** OpenRig records that name on the session, and the seat shows its identity as **named by
  OpenRig, not observed**. That's the name OpenRig passed, not proof that the harness used it.
- **Not with `launch_result`:** a preset declares one or the other. Either the launcher reports the conversation, or
  OpenRig names it.

## Reopening a conversation (`resume: true`)

**A named conversation:** with `names_conversation`, a resume starts `command` with `OPENRIG_RESUME_REF` set to the saved
name. The harness reopens it and must never create one under that name. Nothing reports back, so:
- **readiness is process-only:** the seat reads as ready while something other than a shell runs in its pane. That
  doesn't show the named conversation exists: a harness (or a launcher's own check) that hasn't yet found it gone reads
  as ready, and the saved name stays unverified until something observes it;
- **never creating one is the launcher's job:** a resume must not create a conversation under the saved name. When it's
  gone, the harness or launcher ends with its error and the pane is back at a shell; the seat keeps its saved name, and
  OpenRig starts nothing new, though the seat may already have read as ready;
- **a former runtime's id** isn't passed to the harness, as below.

**A reported conversation:** with `launch_result`, a resume (a restore included) starts the launcher with `OPENRIG_RESUME_REF` set to the
conversation to reopen. The launcher reports what happened in the same attempt's file:
- **Reopened:** the usual record, with that conversation as `nativeRef`.
- **Gone:** `{ "format": 1, "attempt": "…", "harness": "cursor", "error": "missing", "producer": "…" }`. The launcher
  starts nothing. OpenRig reports the conversation missing and starts nothing either: it never replaces it with a new one.

For a reported conversation, OpenRig also says so plainly when:
- **no usable record is written:** the resume isn't confirmed. The seat needs attention and keeps the conversation it
  asked for; nothing is restarted;
- **the record names a different conversation:** the seat needs attention and keeps the conversation it asked for.
  OpenRig doesn't switch it to the reported one;
- **the saved conversation isn't this harness's own** (a former runtime's id, say): it isn't passed to the launcher. A restore stops and asks, and elsewhere the resume says it isn't possible;
- **the record's folder can't be made:** the launcher couldn't be told what to reopen, so nothing starts.

## An example: Hermes

[`community-harness-examples/hermes/`](community-harness-examples/hermes/) has a preset and a small launcher for Hermes
Agent's CLI.
- **The launcher:** it creates the session OpenRig named (`-c <name> --create-if-missing`), and on a resume reopens it
  without `--create-if-missing`, with its own Hermes home per seat. A name that matches nothing ends with Hermes's own
  "No session found" error.
- **Settings go in the seat's Hermes `config.yaml`, not in flags:** Hermes's CLI creates a named session with no launch
  flags and then reopens it, refusing any creation flag (model, provider, `--max-turns`) that differs. So the preset's
  command carries none, and each seat's `config.yaml`, in its Hermes home, sets them before the seat's first start:
  the model and provider, and `agent.max_turns` if you want a cap (nothing else sets it once the flag is gone).
- **The preset:** it declares `names_conversation` but not `resume`, until reopening a named session, and a missing one,
  have been checked with a real Hermes.
- **Stopping:** Hermes's CLI is a client of a gateway, so closing a seat's pane detaches it. Hermes finishes any turn it
  accepted, and the seat's gateway exits once idle. The preset says so in its limits.

Copy both and maintain them as your own.

**Not supported for community harnesses:** restarting a seat in place (`rig seat restart` is for Codex seats) and
switching harness on a running seat. Each says so before anything changes.

## An example: Cursor

[`community-harness-examples/cursor/`](community-harness-examples/cursor/) has a preset and a small launcher for Cursor's
CLI.
- **The launcher:** it reports the chat `cursor-agent create-chat` makes, then reopens it. Each seat gets its own Cursor
  config folder unless `CURSOR_CONFIG_DIR` is already set. Cursor keeps its chats and `cli-config.json` there, and its
  login elsewhere.
- **The preset:** it declares `launch_result` and `resume`. Cursor's `--resume` with an id it doesn't hold starts a new,
  empty chat without saying so, so on a resume the launcher first checks that the chat's store exists. When it doesn't, the
  launcher reports `error: "missing"` and starts nothing.

Copy both and maintain them as your own.

The launcher is the contributor's code, in the contributor's package. OpenRig runs no code from a preset and loads no
module into its daemon. A preset that sets `launch_result` or `names_conversation` is refused by an older OpenRig, which doesn't know the field.
