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
| Activity | partly | Read from the screen only; there are no activity hooks. Work and attention the screen shows are kept, but a screen that looks idle reads `unknown`, never idle, because a quiet prompt can be an approval or a pause. A [runner preset](#runner-presets-runner-true)'s own reports decide it instead. |
| Attention | partly | Read from the screen: a permission question or numbered choice that OpenRig recognizes reads as needing attention, and `rig send` won't type into it. A prompt it doesn't recognize reads `unknown`. |
| Approval | no | Approvals stay in the harness's own pane. OpenRig relays none, so a person answers them there. |
| Cancel | no | OpenRig has no verb that cancels a running turn. `rig seat stop` and `rig down` end the seat's tmux session; anything the harness runs outside its pane, such as a gateway, is its own, and the preset's `limits` should say what keeps running. Restarting in place and switching harness are refused. |
| Transport | yes | The seat is a tmux pane like any other, so `rig capture`, `rig send` and `--host` work as they do for any seat. |

**Not placed:** guidance, skills and startup files (a launch warns that they weren't delivered), and the model: set it in the harness's own
configuration, or let a launcher that opts in take the seat's declared model (`passes_model`, below).

**Check that the harness answers on its own first.** Before writing a preset, start the harness in a terminal outside OpenRig, with the
same configuration and credentials your launcher will give it, and send it one prompt. Use the folder your launcher gives the seat, not
the harness's default one: the example launchers keep one per seat under `$OPENRIG_HOME/state/<harness>/` (`HERMES_HOME`,
`OPENCLAW_STATE_DIR` or `CURSOR_CONFIG_DIR`), so a check with your own defaults can pass while the seat's setup fails. If no answer comes
back, the problem is in the harness's own setup, such as its model, provider or login, and relaunching an OpenRig seat won't fix it. Fix
it in the harness, then connect it.

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
# runner: true                  # optional, needs launch_result: the launcher reports the seat's activity (below)
# passes_model: true            # optional: the launcher takes the seat's declared model from OPENRIG_MODEL (below)
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

## Runner presets (`runner: true`)

A plain preset's seat reads its activity from the screen. A **runner** preset is for a launcher that hosts the agent itself
and reports what it's doing, as OpenRig's own Pi runner does. The seat's activity then follows those reports.

- **It needs `launch_result: true`.** A runner reports the conversation it opened in its launch record, so `runner: true`
  without `launch_result` is refused.
- **The declaration is fixed at launch.** Each launch, a restore's included, records on the session what the preset
  declares at that moment. Editing the preset changes the next launch, not a running seat. A session recorded before this
  field existed reads as plain.
- **No record means attention.** When a runner's launch record doesn't arrive within the wait, or its folder can't be
  made, the seat needs attention instead of reading ready. A plain `launch_result` preset still starts, with its identity
  unavailable.
- **Input is as for any seat.** A send pastes the text and presses Enter, so a runner should submit everything up to that
  Enter as one prompt.

**What the runner posts.** The runner posts each event to `POST /api/activity/hooks` with the local activity hook token,
one at a time and in order, without making the agent wait. It finds the address and token in `OPENRIG_URL` (or
`OPENRIG_PORT`) and `OPENRIG_ACTIVITY_HOOK_TOKEN`, or else in `$OPENRIG_HOME/activity-endpoint.json`. Every post names:
- the seat, as `sessionName` and `nodeId`;
- `runtime`, the preset's name;
- `generation`, from `OPENRIG_OCCUPANT_GENERATION`;
- an increasing `sequence`, and `occurredAt`;
- `hookEvent` and `subtype`, as in the table.

| The runner posts | When | The seat reads |
|---|---|---|
| `UserPromptSubmit` | it gave the agent a prompt | working |
| `active` or `PreToolUse` | the agent is working | working |
| `Notification` / `permission_prompt` | the agent asked for a permission | needs input |
| `Stop` / the turn's stop reason | the turn ended | idle |
| `Stop` / `<preset name>_exited` | the agent's process ended | unknown, never idle |

- **The screen still counts,** but only as evidence of work: on its own it never reads the seat idle.
- **The generation attributes a post; it isn't authentication.** A post with an earlier occupant's generation doesn't
  count for the live seat. The hook token is one local token, so any process that holds it can post for any seat.

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
  accepted. Whether the seat's gateway then exits once idle hasn't been checked: check with `ps` that a stopped seat's
  gateway has gone before relying on it. The preset says so in its limits.

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
processes, a gateway say, may keep running after it. OpenRig doesn't stop them, and whether they survive isn't exercised
by OpenRig's tests, so check the harness's own processes after `rig down`. Each preset's limits say what to expect.

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

## An example: Pi's terminal UI

[`community-harness-examples/pi-tui/`](community-harness-examples/pi-tui/) has a preset and a small launcher that run Pi's
own terminal UI as a community harness. `pi` is the built-in managed Pi runtime, so the preset is named `pi-tui`. OpenRig
delivers to this seat as to any community seat (the Delivery row above), not as to a plain `runtime: terminal` seat, which
queue wakes don't reach. Checked once, on Pi 1.4.0 with OpenRig 0.7.4 and one model: a parked row's wake reached Pi in
the same session (the same session file) and Pi resumed the work, and a handoff reached a second `pi-tui` seat, which
picked it up unattended. The first seat's task named the commands to use, so this shows a wake reaching Pi and Pi acting
on it, not Pi choosing by itself to park or hand work on.
- **The launcher:** each seat gets its own Pi agent folder (`$OPENRIG_HOME/state/pi-tui/<node>/agent`, unless
  `PI_CODING_AGENT_DIR` is set) and its own session folder. At each launch it copies the installed `openrig-core` skills
  it's given (`queue-handoff` by default) into that agent folder. A new launch starts `pi --session-id <the name OpenRig
  gave>` and passes the first input as Pi's first prompt, byte for byte.
- **Resume isn't declared.** The launcher can reopen a named session: it opens the one session file whose header has that
  id, and starts nothing when there isn't exactly one, because Pi's own `--session-id` creates a session for an id it
  doesn't find. Declare `resume: true` only after a real Pi has reopened a named session and refused a missing one.
- **Its limits:** run a `pi-tui` seat unattended, not where a person also types into it.
  - With the seat's [typing guard](seat-delivery.md) at its default, a wake submits a person's half-typed draft in Pi's
    editor together with the wake. The guard's draft-aware mode isn't a known fix for this.
  - A send while a Pi dialog OpenRig doesn't recognize is open, such as `/settings`, types into the dialog.
  - Not shown: how Pi takes a wake that arrives while it's busy (a message sent during a busy turn was answered after
    it), and other Pi versions.
- **Give the seat a model** before its first start: its provider key in its environment, or its login and settings in its
  agent folder.

Copy both and maintain them as your own.

The launcher is the contributor's code, in the contributor's package. OpenRig runs no code from a preset and loads no
module into its daemon. A preset that sets `launch_result`, `names_conversation`, `startup_assisted`, `first_input`, `runner` or `passes_model` is refused by an older
OpenRig that doesn't know the field.

## Pass the first startup input at launch

A format-1 preset may set `first_input: true` (a boolean, default false). OpenRig composes the same initial identity turn it would otherwise paste, including the first merged text file, durable-obligation guidance and any selected orientation challenge. Before launch it writes that text to a per-attempt 0600 file under its own `state/first-input/` folder and passes the path as `OPENRIG_FIRST_INPUT`. The typed launch command carries the path, not the text; an argument-based launcher still puts the text in the native harness’s argv.

The contributor-owned launcher reads the file and uses its harness’s supported initial-prompt route: the Cursor example passes one positional prompt; OpenClaw uses `--message`. Core knows neither flag. If no initial identity turn is due (an ordinary resume, for example), the variable is absent and the launcher starts without a first message. Later startup files and actions use their existing delivery paths; they are not folded into the launch file.

OpenRig records `node.startup_first_input_passed` with the path and `submission: unconfirmed`. This says the input was passed at launch, not that the native harness submitted or read it. An uncertain launch is not permission to replay it. Readiness remains process-only. `startup_assisted` is independent: when declared, startup still requires a person’s acknowledgement, including when the first input was passed at launch.

Presets without `first_input` and built-in runtimes keep their existing behavior. Older OpenRig versions reject this new field as unknown. The private input file remains for diagnostics; it can contain private startup context. A launcher that turns its contents into one argument is subject to the platform’s argument-size limit; the launcher must report a launch error rather than silently truncate the turn. The examples’ argument transport is covered with stand-ins; native unattended startup still requires qualification with the installed harness.

## Pass the seat's declared model at launch

A format-1 preset may set `passes_model: true` (a boolean, default false). Then a model declared for the seat (in the rig
spec, or set later with `rig seat set-model`) reaches its launcher as `OPENRIG_MODEL`, on new and resumed launches alike. A seat that declares no model gets none,
and an inherited `OPENRIG_MODEL` is cleared. The launcher maps it into its harness's own setting; Core knows no harness's
model flag or config key.

OpenRig keeps three things apart:
- **requested:** the declared model, as `rig ps --nodes` shows it ("configured", or "not-declared");
- **passed:** the launcher was handed the model. OpenRig records `node.startup_model_passed` with the model and whether the
  launch was a resume only when the launch command's send succeeded, and a later failure of the launch doesn't undo that.
  It never says passed from the declaration alone or for a launch that failed before anything was typed. When typing
  began and the send then failed, the model's dispatch is uncertain: it isn't recorded as passed, and it isn't retyped;
- **effective:** the model that actually runs. OpenRig doesn't observe it for a community harness, so it reads UNKNOWN.

Passing a model never makes OpenRig pick a default, substitute another model, or retry with one. A model the harness
refuses is the harness's own error.

The examples apply the request for a new session only; on a resume, the example launcher doesn't apply it, and which
model a resumed session runs stays unknown unless the harness's own evidence says otherwise:
- **Cursor:** `--model "$OPENRIG_MODEL"` for a new chat. What a resumed chat runs hasn't been checked: the launcher leaving
  out `--model` doesn't show that it keeps its earlier model.
- **Hermes:** Hermes takes its model only from the seat's `config.yaml`, so for a new session the launcher writes
  `model: "<id>"` there only when that file is absent or empty. A seat that has its own `config.yaml` keeps it
  byte-for-byte, and the launcher says the model wasn't applied: set it in that file. A seat set up from
  `config.yaml.example` already has a config, so set its model there. Hermes v0.22.4 fixes a session's
  launch settings when it creates it (its own source), so a resumed Hermes session runs with what it was created with.

Both example presets ship with `passes_model: false` until that mapping has been checked with the real harness. Presets
without the field and built-in runtimes are unchanged, and older OpenRig versions reject it as unknown.

## Interactive Pi in a terminal seat: the coordination skills

This is for a seat that runs interactive `pi` from a `runtime: terminal` member's startup, or from a community preset's
launcher. It isn't for a managed `runtime: pi` seat, which already copies its selected skill directories into the seat's own
Pi agent directory (`$OPENRIG_HOME/state/pi/<session>/agent/skills/`), or for Workshop, whose Pi profiles carry pinned skill
copies (openrig-world's `PI-SKILLS.md`). The [`pi-tui` example](#an-example-pis-terminal-ui) above does step 1 for its
seats in its launcher.

OpenRig installs no skills for a terminal or community seat: it skips their resources and startup files, and `rig skill
loadout` covers Claude Code and Codex only. Without the coordination skills, the agent there doesn't know the queue's habits,
such as parking a row that waits on CI instead of leaving it in progress, or handing work on so the next row names its
source. The seat's setup does two things.

1. **Make the released skills readable.** The installed OpenRig's own plugin carries them, matching the installed release:
   `rig plugin list` shows `openrig-core` and its path (usually `$OPENRIG_HOME/plugins/openrig-core`), and the skills are in
   its `skills/` folder. Copy whole skill directories, keeping their helper files and modes, into the `skills/` folder of the
   Pi agent directory that seat uses (`PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default). At least `queue-handoff`:

   ```bash
   CORE="$(rig plugin list | awk '$1 == "openrig-core" {print $NF}')"
   PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
   mkdir -p "$PI_AGENT_DIR/skills"
   cp -Rp "$CORE/skills/queue-handoff" "$PI_AGENT_DIR/skills/"
   ```

   Copy again after each OpenRig upgrade: a copy doesn't follow the plugin.
2. **Point the agent at it when it starts.** Don't count on Pi finding the skill by itself; name it in the seat's first turn.
   For example:

   > Before you work your queue, read `<Pi agent directory>/skills/queue-handoff/SKILL.md` in full: it's how this team hands
   > work on, parks it and waits. When you wait on CI or a long job, park the row with `rig queue block <id> --on
   > external:<what> --wake-after <duration> --continuation "<what resumes>"`.

   - A community preset with `first_input: true` carries it in the seat's first input when the file is declared with
     `delivery_hint: send_text` (see "Pass the first startup input at launch" above). A `.md` file left at the `auto` hint
     counts as guidance, which a community seat doesn't take.
   - A plain terminal seat can pass it as Pi's initial message in the command its startup runs. Check `pi --help` for that
     argument in your Pi version.
   - `first_input` carries text, not files: it doesn't install the skills.

**In a plain terminal seat, a queue wake doesn't reach Pi.** OpenRig doesn't treat a `runtime: terminal` seat as an agent
seat. When a parked row's wake fires, OpenRig doesn't type it into Pi, and a handoff to that seat records a failed wake
(`failed:terminal-seat`). Parking still records the wait, but `--wake-after` won't bring Pi back. Check the seat's parked
rows yourself (`rig queue whoami --session <seat>`, or `rig queue show <id>`), or tell Pi to continue the named row.

**What this shows, and what it doesn't.** A copied folder and a startup line put the text in front of the agent. They don't
show that Pi discovered the skill by itself, or that the agent follows it. Check those separately: that the agent read the
whole file (its tool trace), and what its rows record, such as a CI wait parked on `external:` with a wake, and a handoff
made with `handoff-and-complete`, whose next row names it as its source.

## Write your own

Start from the example closest to your harness, and change it. First check that the harness answers a prompt on its own
([above](#what-a-community-harness-gets)).

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
