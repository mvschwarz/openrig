# Community harness presets

A community harness is a coding harness an outside contributor maintains. You install it as one small data file, and a
rig member runs it by naming it as its `runtime`. OpenRig doesn't test these harnesses. It shows them as community
harnesses, and it reads their activity only from what the screen shows.

## What a community harness gets

What OpenRig does for a community-harness seat, capability by capability. **Partly** and **no** mean OpenRig shows that it doesn't know;
it never reads an unsupported capability as idle, working, ready or verified.

| Capability | Supported | How it works, or what you see instead |
|---|---|---|
| Launch | yes | OpenRig types the preset's `command` into the seat's pane, with its variables passed through `/usr/bin/env`. The seat reads as ready once something other than a shell runs in the pane; that's a process check, not proof of which conversation it runs. With `startup_assisted`, the seat reports attention required until a person checks it. |
| Delivery | yes | `rig send` and queue wakes paste the text into the pane and press Enter, as for any seat. A pane that's back at a shell is refused (`target_runtime_unverified`) and nothing is typed. OpenRig doesn't confirm the harness took the message; `rig send --verify` checks the pane afterwards. |
| Identity | when declared | With `launch_result`, the conversation is shown as reported by its launcher; with `names_conversation`, as named by OpenRig. Neither is observed by OpenRig. Without either, the identity is unavailable. |
| Resume | when declared | `resume: true` with one of the two above (see [Reopening a conversation](#reopening-a-conversation-resume-true)). Without it, a resume says `Resume is unsupported: community harness "<name>" is launch-only`, and a restore stops and asks. |
| Activity | partly | Read from the screen only; there are no activity hooks. Work and attention the screen shows are kept, but a screen that looks idle reads `unknown`, never idle, because a quiet prompt can be an approval or a pause. |
| Attention | partly | Read from the screen: a permission question or numbered choice that OpenRig recognizes reads as needing attention, and `rig send` won't type into it. A prompt it doesn't recognize reads `unknown`. |
| Approval | no | Approvals stay in the harness's own pane. OpenRig relays none, so a person answers them there. |
| Cancel | no | OpenRig has no verb that cancels a running turn. `rig seat stop` and `rig down` end the seat's tmux session; anything the harness runs outside its pane, such as a gateway, is its own, and the preset's `limits` should say what keeps running. Restarting in place and switching harness are refused. |
| Transport | yes | The seat is a tmux pane like any other, so `rig capture`, `rig send` and `--host` work as they do for any seat. |

**Not placed:** guidance, skills and startup files (a launch warns that they weren't delivered), and the model: set it in the harness's own
configuration.

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
startup_assisted: true           # optional: startup submission needs a person's check (below)
first_input: true                # optional: launcher takes the first turn from OPENRIG_FIRST_INPUT (below)
```

- **`command`** is a single program and its arguments. Shell syntax such as `|`, `&&`, `;`, redirections or `$(…)`
  is refused: put it in a script and name the script.
- **Built-in runtime names are reserved.** A preset can't replace `claude-code`, `codex` or the other built-ins.
- **Unknown fields are refused,** so a preset written for a newer OpenRig says so instead of half-working.
- **Fork isn't supported, and resume only as described below.** Neither is placing skills, guidance or startup files. Except
  for assisted startup below, the seat is called ready while something other than a shell runs in its pane, which says
  nothing about which conversation it is.

### Assisted startup

Set `startup_assisted: true` when startup submission needs a person's check. The seat may start its first turn
automatically, including from input passed at launch with `first_input: true`. This declaration requires a check after
the submission attempt; it does not hold the agent back. Without `first_input`, OpenRig pastes the startup text and
presses Enter once.

After attempting startup input, OpenRig reports **attention required**: check the pane and submit any text still in the
composer. OpenRig does not resend the identity prompt. Once the seat responds, use the reported
`rig seat clear-attention <session> --reason "Startup submission checked; seat responded"` command to acknowledge the
check. A launch with no startup text needs no such check. Other presets keep their existing behavior.

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
- **Let Hermes run `rig` as the seat:** Hermes runs every tool command in its gateway, one per Hermes home, so with
  this launcher one per seat (a two-seat run showed separate gateways, homes and sockets, and stopping one seat left
  the other's running). It runs them with that gateway's
  environment, and swaps in a session's own values only for its toolchain names and the names its profile lists in
  `terminal.client_env_passthrough`. So put the seat's OpenRig variables in that list, in each seat's `config.yaml`
  ([`config.yaml.example`](community-harness-examples/hermes/config.yaml.example)). Without it, `rig` inside Hermes
  runs as whichever seat started the gateway, or as no seat; with it, each seat runs `rig` as itself. To check, ask the
  seat's Hermes to run `rig whoami --json`. The launcher warns when a seat's `config.yaml` doesn't pass
  `OPENRIG_SESSION_NAME`. This covers Hermes's CLI and TUI, whose clients pass their environment; its ACP clients pass
  none.
- **The preset:** it declares `names_conversation` but not `resume`, until reopening a named session, and a missing one,
  have been checked with a real Hermes.
- **Stopping:** Hermes's CLI is a client of a gateway, so closing a seat's pane detaches it. Hermes finishes any turn it
  accepted, and the seat's gateway exits once idle. The preset says so in its limits.

Copy them and maintain them as your own.

## An example: OpenClaw

[`community-harness-examples/openclaw/`](community-harness-examples/openclaw/) has a preset and a small launcher for
OpenClaw's CLI.
- **Choose the mode:** `openclaw.yaml` runs an embedded agent with `tui --local`. `openclaw-gateway.yaml` runs a TUI client of an existing Gateway. Configure that client's Gateway route and authentication through `OPENCLAW_CONFIG_PATH`; the launcher never starts or stops the Gateway.
- **The conversation:** both examples use only agent `main`, mapping OpenRig's name to the full native key `agent:main:<OpenRig name>`. Each seat has its own client state folder.
- **Its resume check:** local mode checks `sessions --agent main --json --limit all`; Gateway mode calls the selected Gateway's `sessions.describe`. Both require the exact canonical key. An unavailable lookup stops the launch; a confirmed missing key is never recreated. A client's local cache cannot authorize Gateway resume.
- **Stopping:** a Gateway client's pane closing detaches it. The Gateway and an accepted turn can keep running; stopping that service is separate. Local mode runs its embedded agent in the pane.
- **Unattended seats:** prefer Gateway mode within the capabilities qualified for your installed version. Local interrupted-turn recovery is not supported by these launchers.
- **Local interruption:** Finish the current local turn before stopping; an interrupted local turn may retain native recovery work and refuse the next request. This launcher does not repair or retry it. OpenRig recognizes the recorded local “changed while starting work” error frame as needing attention: “OpenClaw turn not recovered; inspect the pane before retrying”. Use `rig capture <session>` to inspect the native conversation. An ordinary send still submits a new turn, with an advisory that the last local turn was not recovered; it is not an automatic replay of that turn. It does not clear native recovery records, repeat the request or start a fresh conversation; a successful process launch is not proof that the turn recovered.
- **Local startup after resume:** OpenClaw may run its database integrity check during startup. A reported resumed process does not confirm readiness for the next request; check that the TUI has finished starting before sending work.
- **Resets must stay off:** automatic session resets can create a new conversation under the same key. Typing `/new` also moves to a fresh key while the seat keeps the name OpenRig gave it.
- **The presets:** both declare `names_conversation`, `resume` and `first_input`. The launcher passes the generated first startup text through OpenClaw's `--message` option. OpenRig labels the saved name as passed, not observed by its adapter.

Copy the launcher and the preset for your mode, and maintain them as your own.

**Stopping a community seat stops its pane.** `rig down` names those seats ("Pane stopped: …"), since a harness's own
processes, a gateway say, may keep running after it. OpenRig doesn't stop them; each preset's limits say what to expect.

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
- **First input at launch:** the preset declares `first_input: true` and `startup_assisted: false`. The launcher passes
  the generated startup text as Cursor's positional first prompt. This route and same-chat resume were checked with
  Cursor Agent 2026.10.22-27dcf5f. Later tool approvals use Cursor's native prompts; startup submission does not answer them.
- **Sender names come from the sending session.** A command run from an unattached operator shell can arrive as
  `<unknown sender>`; that doesn't mean the receiving Cursor seat lost its identity.

Copy both and maintain them as your own.

The launcher is the contributor's code, in the contributor's package. OpenRig runs no code from a preset and loads no
module into its daemon. A preset that sets `launch_result`, `names_conversation`, `startup_assisted` or `first_input` is refused by an older
OpenRig that doesn't know the field.

## Pass the first startup input at launch

A format-1 preset may set `first_input: true` (a boolean, default false). OpenRig composes the same initial identity turn it would otherwise paste, including the first merged text file, durable-obligation guidance and any selected orientation challenge. Before launch it writes that text to a per-attempt 0600 file under its own `state/first-input/` folder and passes the path as `OPENRIG_FIRST_INPUT`. The typed launch command carries the path, not the text; an argument-based launcher still puts the text in the native harness’s argv.

The contributor-owned launcher reads the file and uses its harness’s supported initial-prompt route: the Cursor example passes one positional prompt; OpenClaw uses `--message`. Core knows neither flag. If no initial identity turn is due (an ordinary resume, for example), the variable is absent and the launcher starts without a first message. Later startup files and actions use their existing delivery paths; they are not folded into the launch file.

OpenRig records `node.startup_first_input_passed` with the path and `submission: unconfirmed`. This says the input was passed at launch, not that the native harness submitted or read it. An uncertain launch is not permission to replay it. Readiness remains process-only. `startup_assisted` is independent: when declared, startup still requires a person’s acknowledgement, including when the first input was passed at launch.

Presets without `first_input` and built-in runtimes keep their existing behavior. Older OpenRig versions reject this new field as unknown. The private input file remains for diagnostics; it can contain private startup context. A launcher that turns its contents into one argument is subject to the platform’s argument-size limit; the launcher must report a launch error rather than silently truncate the turn. The examples’ argument transport is covered with stand-ins; native unattended startup still requires qualification with the installed harness.

## Write your own

Start from the example closest to your harness, and change it.

1. **Choose how the conversation is named.**
   - **Your harness creates an id you can read before it starts,** as Cursor's `create-chat` does: declare `launch_result: true`, and the
     launcher writes the record.
   - **Your harness takes a name from its caller and creates or reopens it,** as Hermes's `-c <name>` and OpenClaw's session key do: declare
     `names_conversation: true`, and the launcher passes `OPENRIG_CONVERSATION` on.
   - **Neither:** leave both out. The seat starts and works, its identity shows as unavailable, and it can't be resumed.
2. **Write the launcher:** a small script your package installs on the seat's `PATH`. It reads OpenRig's variables, starts the harness with
   `exec`, and does nothing else.
   - `OPENRIG_CONVERSATION` with `names_conversation`, or `OPENRIG_LAUNCH_RESULT` and `OPENRIG_LAUNCH_ATTEMPT` with `launch_result`.
   - **On a resume,** `OPENRIG_RESUME_REF`: reopen exactly that conversation. Check that it exists first, and when it doesn't, end with an
     error (or report `error: "missing"`) instead of creating one.
   - **With `first_input: true`,** `OPENRIG_FIRST_INPUT`: pass the file's exact bytes through your harness's own first-prompt route.
   - **Keep each seat's harness state apart** (Cursor's config folder, Hermes's home, OpenClaw's state folder), so two seats never share a
     conversation.
3. **Write the preset** at `$OPENRIG_HOME/community-harnesses/<name>.yaml`, and check it with `rig community-harness list`.
   - Declare `resume` only after checking, with the real harness, that a reopen works and that a missing conversation is refused.
   - List what doesn't work under `limits`.
4. **Try it in a rig:** give a member `runtime: <name>`, then go through the checks in the promotion test below.
5. **Publish the preset and the launcher in your own package,** and maintain them. OpenRig runs no code from a preset, so the launcher is
   yours.

## The promotion test

A community harness stays a community harness: you maintain it, and OpenRig shows it as one. **Promotion** means OpenRig takes a harness on
as a built-in runtime that it maintains and tests itself. **Promotion is decided by the OpenRig maintainers, on evidence from OpenRig's own
testing.** Passing these checks isn't automatic promotion, and it isn't a promise of upstream support.

What the maintainers look at:
1. **Everything the preset declares works on a real install,** end to end through OpenRig:
   - a seat starts and takes its first turn (`rig up`);
   - a message arrives (`rig send`), and the reply can be read (`rig capture`);
   - the seat stops (`rig down`) without leaving work running that the person can't see, or the preset's `limits` say what keeps running;
   - with `resume`, `rig up <rig> --existing` reopens the same conversation, and a missing one is refused, never replaced.
2. **What it doesn't support reads as not known,** never as idle, working, ready or verified.
3. **Its `limits` are true,** and name anything a person would otherwise be surprised by.
4. **The built-in runtimes are unchanged.**
5. **It's maintained:** a named maintainer, and a launcher that keeps working with the harness's current release.

There's no score or threshold. The maintainers weigh the evidence.
