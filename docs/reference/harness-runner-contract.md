# Harness and runner contract (DRAFT, published with 0.7.6)

> **Status.** This is a draft for contributors.
> - **Released in 0.7.6:** the `runner` field and OpenRig's side of declaration, identity and activity
>   (sections 2-4).
> - **Released in 0.7.8:** seat activity grants (section 4), and OpenRig's side of the answered permission path
>   (section 7).
> - **Runner-author behavior, not yet qualified:** the input, cancellation and permission recipe in sections 5-7, and
>   the runner-side shutdown obligation in section 9. Two runners have shown parts of it natively (below); no
>   runner is qualified beyond that.
> - **Existing interfaces with author obligations:** launch-result identity, exact resume, first input and model
>   handoff. These interfaces do not establish that a particular runner implements them correctly.
> - **Current source:** per-launch credentials for managed Pi/OMP, Pi-RPC presets and declared community runners (section 4).
>   Optional run-bound observations retain receipts and project current runner-reported context/community model facts.
>   Credentials and reports do not qualify new native input, cancellation or independently verified program identity.
>   Managed OMP and hosted Pi-RPC additionally implement optional input-only channel delivery; their wake/cancel remain unavailable.
> - **Unchanged:** Claude Code/Codex raw TUI and historical headless wakes, plain preset interaction, terminal typing,
>   OMP approval/provider/state policy, and contained execution's legacy activity/lifecycle boundaries.
>
> **What has run natively, in 0.7.8's release testing, against a Claude Haiku model:**
> - **dsh-seat 0.3.0**, an outside runner for dsh 0.2.1-rc.2 over ACP: launch and first input, useful queue work, a
>   multiline message with a `/abort` line inside it delivered as one prompt, activity that stayed working through a
>   52-second quiet tool interval and then read idle, cancel by a bare `/abort` typed in the pane, and the same
>   conversation resumed by `session/resume` after `rig down --snapshot` and `rig up`, with the runner and its child
>   gone after the managed down.
> - **The dsh example runner** (`community-harness-examples/dsh/`): dsh's native `session/request_permission` reached
>   a person, whose allow-once took effect and whose reject-once didn't.
>
> **Not shown natively:** a DeepSeek model, the example runner's own resume (its preset declares none), the default
> permit when nobody can be asked (checked without a model only), a typed or Slack answer, a second person's
> answer, reboot recovery, and the model OpenRig observes. Any other runner, provider or path is unqualified until
> it's shown.
>
> **Since 0.7.8, on one stack:** the dsh example runner has run with a real dsh 0.2.1-rc.2 on dsh's pi-ai OpenRouter
> chat-completions profile with `deepseek/deepseek-v4-flash`: queue work, activity, an allow-once and a reject-once
> answered by an automated test operator, cancel, and an exact return with resume added to a copy of the preset. A
> missing conversation's refusal hasn't been run, and the preset still declares no resume.
>
> Release status and pinned references are in the [joined author guide](author-contracts.md). The
> [community presets reference](community-harness-presets.md) describes the implemented fields, including the runner
> preset's exception for approvals; this chapter also labels runner-author behavior that isn't qualified.

This chapter covers **which agent runs in a seat and how OpenRig talks to it**. *Where* that agent runs (a host, a
sandbox, another machine) is the [execution platform chapter](execution-platform-contract.md). The two are separate on purpose:
the same harness can run in many places, and one place can host many harnesses.

## 1. Plain preset, runner preset, or OpenRig-hosted protocol runner?

| | Plain community preset | Runner preset (`runner: true`) | OpenRig-hosted protocol runner (`protocol: pi-rpc`) |
|---|---|---|---|
| **What runs in the pane** | The harness's own terminal app | A small program you maintain, *the runner*, which hosts the agent (for example an ACP agent over stdio) | OpenRig's own Pi runner, which starts your binary (`command`) in Pi's RPC mode |
| **How OpenRig reads activity** | From the screen: a changing screen reads working; a quiet one reads **unknown**, never idle. A preset that declares the hooks its own script posts (`activity_hooks`) reads from those instead | From the runner's reports: working, idle, needs input | From the Pi runner's reports, through the same channel as built-in Pi; identity is the session file Pi's `get_state` reports |
| **How input arrives** | Typed into the app's prompt | Typed into the runner, which turns each submitted message into one agent prompt; a message sent mid-turn waits | Pi's input: a submitted block is a prompt, a message sent while busy steers the current turn, `/followup` queues after it and `/abort` cancels it |
| **Choose it when** | The harness has a usable terminal UI (Cursor, Hermes, OpenClaw examples) | The harness speaks a protocol rather than a screen (ACP, JSON-RPC, stream-JSON), or you can report turn boundaries reliably | Your harness is a Pi fork, or speaks Pi's CLI and JSONL RPC protocol |

**For the third shape, you promise your binary's Pi-RPC compatibility at a version you name in `limits`.** OpenRig doesn't
test each fork. It can't be combined with `runner`, `launch_result`, `names_conversation`, `startup_assisted` or
`first_input`. The flags it must accept are in
[Pi-compatible RPC harnesses](community-harness-presets.md#pi-compatible-rpc-harnesses-protocol-pi-rpc).

**If your harness works well as a terminal app, a plain preset is enough. Use a runner only when you can report state
honestly.** A runner that guesses is worse than a quiet screen read as unknown.

**Vocabulary.** "Preset", "runner preset", `launch_result`, `resume`, `first_input` and `passes_model` are existing
terms in 0.7.6. Broader names you may see in design discussion, such as *HarnessSpec*, are **proposals**, not file
formats or loaders that exist.

## 2. Declare it: what the preset says, fixed at launch

```yaml
# $OPENRIG_HOME/community-harnesses/dsh.yaml
format: 1
name: dsh
command: dsh-seat              # your runner; it starts the agent itself
maintainer: <you>
runner: true                   # since 0.7.6
launch_result: true            # required with runner
resume: true                   # only after you've checked a real reopen and a refused missing one
limits:
  - permission requests go to a person through OpenRig (section 7), and are permitted when no one can be asked
  - a prompt whose whole text is /abort can't be sent
  - fork unsupported
```

- **`runner: true` requires `launch_result: true`,** and can't be combined with `names_conversation`.
- **The declaration is fixed at launch.** Each launch, a restore's included, records what the preset declares at that
  moment. Editing the preset changes the next launch, not a running seat.
- **A preset without `runner` behaves exactly as today,** and so does a session recorded before the field existed.
- **The other fields keep their existing meanings:**
  - `first_input: true` passes the seat's first startup turn in a file named by `OPENRIG_FIRST_INPUT`;
  - `passes_model: true` passes the seat's declared model as `OPENRIG_MODEL`;
  - `launch_wrapper: true` declares that the runner applies a member's configured wrapper to its native child.

**Launch wrapper.** `launch_wrapper` is an optional boolean in format 1 and requires `runner: true`. When the member
has a wrapper and its runner preset declares `launch_wrapper: true`, OpenRig passes `OPENRIG_LAUNCH_WRAPPER` as a JSON array of resolved argv strings.
The runner must exec its native child as `<argv...> <agent> <args>`, preserving argument boundaries, and keep its own
process outside the wrapper. The runner must remove `OPENRIG_LAUNCH_WRAPPER` from the environment it passes to the wrapper
and native child; the handoff belongs to the runner only. The wrapper must `exec` the agent in place. If wrapping fails,
the runner must never fall back to an unwrapped spawn. A runner preset without the flag is refused at preflight and launch (not schema validation) when a wrapper is
configured: `launch_wrapper unsupported: the community preset "<runtime>" runs a runner without launch_wrapper: true; no agent started. Add launch_wrapper: true to the preset if its runner applies OPENRIG_LAUNCH_WRAPPER, or remove launch_wrapper from this member.`
A plain preset needs no flag: OpenRig prefixes its command
immediately before the preset's native command, after OpenRig's launcher assignments (for example,
`/usr/bin/env OPENRIG_LAUNCH_RESULT=… <wrapper> <preset.command>`), at the same seam as Codex. OpenRig never sets
`OPENRIG_LAUNCH_WRAPPER` for a plain preset and removes any inherited value.

## 3. Identity: report the conversation once, in the launch record

- **When:** after the agent has opened or reopened its conversation (for ACP: after `session/new`, `session/load` or
  `session/resume`).
- **How:** write the attempt's launch record to the path in `OPENRIG_LAUNCH_RESULT`, with the attempt from
  `OPENRIG_LAUNCH_ATTEMPT`. The record is either the conversation:

  ```json
  {"format": 1, "attempt": "<OPENRIG_LAUNCH_ATTEMPT>", "harness": "dsh", "nativeRef": "<conversation id>", "producer": "dsh-seat 0.3.0; dsh 0.2.1-rc.2; ACP 1"}
  ```

  or the agent's own word that it doesn't exist:

  ```json
  {"format": 1, "attempt": "<OPENRIG_LAUNCH_ATTEMPT>", "harness": "dsh", "error": "missing", "producer": "dsh-seat 0.3.0"}
  ```

- **`producer` is free text** for your versions. There are no structured version or capability fields.
- **The launch record is the only identity channel.** Don't report identity on the activity endpoint.
- **No record means attention.** For a runner preset:
  - **a new launch** with no usable record within OpenRig's wait leaves the seat needing attention, not ready. So does a
    new launch where OpenRig can't create the record's folder: the runner still starts, without `OPENRIG_LAUNCH_RESULT`;
  - **on a resume,** a folder OpenRig can't create means nothing starts, because the launcher can't be told what to
    reopen. When the folder exists but no usable record arrives, the resume command has already been sent, and the
    resume reads unconfirmed (section 8).
- **OpenRig shows this identity as launcher-reported.** It doesn't observe the conversation itself.

## 4. Activity: report turn boundaries

Managed hosted Pi and OMP, Pi-RPC presets and declared community runners can receive an actual-launch credential in
`OPENRIG_ACTIVITY_HOOK_TOKEN`, with their attempt in `OPENRIG_RUN_ID`.
It is delivered through tmux's private environment, never as a literal launch argument or launch-result field.

Give the launch credential to the component that reports this launch's activity. That component can be a runner or the harness's own lifecycle hooks. Reports must describe events and observations from the seat and launch they name; a tool command or generated message is not evidence that a turn ended, a permission prompt opened or a model changed. The credential identifies the reporting launch, not an independently verified native conversation or model. Keep credential values out of command arguments, launch records and logs. See the [author guide's trust model](author-contracts.md#trust-model) for the scope of local cooperation and configured isolation.

A report carrying runId still uses the credential bound to that run. Generation, sequence, freshness and lifecycle checks continue to determine which reports apply to the current seat. The existing install-token path remains a separate source of reports; it does not acquire run-bound provenance by naming a run.

Issuing or delivering this optional credential never blocks an otherwise supported launch or restore. If the launch
anchor, PID, generation or private credential channel is unavailable, the existing unbound install-token path remains;
that path adds no new run-authority claim and is not attributed to a selected run. A refused bound report stays
refused: it is never silently retried with the install token. If native dispatch already occurred before activation
failed, Core preserves the dispatched outcome and does not replay input; cleanup addresses only that launch's grant.
Unreadable observations cannot revoke a grant. Confirmed exit/replacement or intentional lifecycle cleanup still can.
For builtin Pi/OMP, a foreground shell proves exit only after a current-attempt runner sidecar is ready or exited.
Missing, unreadable, stale or pending launch evidence retains the grant; this limits cleanup, not launch or report admission.

Core activates a pending credential after dispatch against its selected session, pane and recorded runner. A staged
successor waits for the existing binding cutover; pending posts receive `activity_grant_pending` and must retry.
An unreadable binding is `activity_grant_unverified` (409, retryable): it could not be verified now, not proven stale.
Nothing is recorded and the grant is retained; retry when its binding can be checked again.
Failed launches revoke their own credential. Relaunch replaces the active run; an explicit no-launch adoption can
retain it only with the original concrete pane/process evidence and an adoption-only tenure continuation. These
checks bind a runner's reports to its launch; they do not independently verify its claimed native identity. Existing
host hooks, contained guest grants and install-token Pi usage keep their legacy behavior. Pi usage also accepts a
current bound Pi credential. No native input channel or cancellation capability is implied by this credential.

Post each event to `POST <base>/api/activity/hooks` with `Authorization: Bearer <token>`.

A plain preset needs no runner to report: its harness's own hook script can post on the install-token path, and the preset
lists the events it posts (`activity_hooks`). Those posts carry the same fields a runner's do, `occurredAt` and an
increasing `sequence` included, and are ordered the same way; a turn start decides whether its idle holds. See
[Hook-reporting presets](community-harness-presets.md#hook-reporting-presets-activity_hooks). A runner's preset that also
declares `activity_hooks` keeps its runner's reports.

The same endpoint accepts an observation-only report from a current run-bound credential:

```json
{"runId":"<OPENRIG_RUN_ID>","sequence":1,"occurredAt":"2026-11-12T00:00:00Z",
 "observations":{"model":{"id":"provider/model"},"context":{"usedTokens":1000,"windowTokens":10000}}}
```

Send this separately from activity and identity posts, without `hookEvent` or `eventFamily`. It records no activity
or verified identity. Core stores a receipt with the authenticated run/session binding in its existing event log;
retrying the same observation sequence and payload returns that receipt, while conflicting reuse returns 409.
Observation ordering is separate from activity/turn ordering. Omitted components keep their own ages; a new run
cannot inherit an earlier run's reports. Counts without capacity or an explicit percentage remain reported counts,
not an inferred context occupancy (`availability: unknown`, `reason: window_capacity_unknown`). A valid
`usedTokens/windowTokens` pair or explicit percentage supplies reported occupancy. The current context reader
uses accepted events, rechecking run/binding, sequence and the existing ten-minute freshness policy; it never
revives a runner sample from the context cache. Community model reads use the same current-report boundary.
Observation model IDs and session references retain Unicode format characters (`\p{Cf}`), including bidi formatting,
zero-width joiners and non-joiners, where the existing identifier/path format permits. CLI/UI displays escape these
characters visibly in human CLI model output and UI event previews. These display boundaries use the existing terminal
JSON escape set: DEL/C1 controls, format characters, line/paragraph separators and default-ignorable code points.
Stored values, JSON/API payloads and identity
comparisons retain the original spelling. Observation Pi paths opt into format characters without changing ordinary
launch/resume validation; their absolute-path, traversal, length and `.jsonl` checks remain.
Their source is `runner_reported`, displayed as “runner-reported”; existing Claude/Codex/Pi native model
readers retain their evidence paths and labels. Omitted components retain their own sample times.
An unreadable binding or report is unknown (`binding_unverified`), not evidence of replacement. The grant and
existing receipt remain intact; retrying after verification recovers the same accepted receipt. A standing that becomes
unverified during observation admission, including a failed standing read, returns retryable `409 runner_observation_unverified`.
`runner_observation_unavailable` remains for a positively stale/revoked run or no bound session; invalid reports and
conflicting sequence reuse retain their existing refusal codes. No refusal revokes credentials or fabricates observed state.

Report changed components rather than repeating unchanged high-rate samples. Retry the same report with its original
sequence, timestamp and payload. If unchanged facts must remain current, renew them deliberately with a new sequence
and sample time before the existing freshness window expires; change-only reporting without renewal eventually becomes
stale. This reduces unnecessary event growth, but does not bound retention or worst-case history query cost. No default
physical pruning of observation events is provided.

A fresh current session component can fill an absent resume reference through the existing report-only
persistence path with `launcher` provenance, below Core scrape/adoption evidence. Pi and Pi-based community references
are promoted only if the adapter's default session-file check accepts them. A reference outside that resume format stays
in the accepted observation, with model/context facts and its receipt intact, but writes no resume token or identity event.
Generic community harnesses retain their pass-through reference behavior. A promoted reference emits the existing session-identity event once after
commit; it does not stamp independent verification or resumability. A known conflicting Core reference stays
unchanged and makes current observations unknown. A retry returns its original receipt without repeating
identity effects. Community process identity remains unconfirmed without independent Core evidence.
Runner context does not provision a collector or enable legacy watchdog/compaction enforcement; that
watchdog's raw cache path excludes runner-reported entries.

Core observes launch-recorded community runners independently of session reports. Once the existing startup
readiness is committed, a concrete foreground shell with no live child can establish the existing process
mismatch and end only the sampled run credential, even before any native reference was reported. A shell
wrapper with a live descendant, incomplete/unreadable census or changed pane/binding stays unconfirmed;
unknown evidence never ends a run. On Linux, a permission-hidden process (`EPERM`/`EACCES` reading its stat)
makes this absence check unconfirmed, even when the hidden process might be unrelated: its parent cannot be read.
Processes that disappeared (`ENOENT`/`ESRCH`) do not mark the census permission-incomplete; macOS retains its existing
`ps` listing. Other process-table consumers retain their row-only listing behavior. Pending launch remains unconfirmed until readiness. Explicit same-process
adoption retains the observed pane anchor and its existing ready state. Native Claude/Codex/Pi checks and
Pi-RPC report routing keep their existing paths. A report plus a live Node process does not independently
verify the native conversation.
- **Finding the base and token:** take them from `OPENRIG_URL` (or `OPENRIG_PORT`, with `OPENRIG_HOST` defaulting to
  `127.0.0.1`) and `OPENRIG_ACTIVITY_HOOK_TOKEN`, or else from `$OPENRIG_HOME/activity-endpoint.json`.
- **Posting:** post one at a time, in order, with a short timeout. Never make the agent wait on a post.

```json
{"sessionName": "dev-builder@my-rig", "nodeId": "<node id>", "runtime": "dsh",
 "generation": "<OPENRIG_OCCUPANT_GENERATION>", "sequence": 42, "occurredAt": "2026-10-29T12:00:00Z",
 "hookEvent": "UserPromptSubmit", "subtype": "accepted", "turnId": "7"}
```

| When | `hookEvent` / `subtype` | The seat reads |
|---|---|---|
| You gave the agent the prompt for a submitted message | `UserPromptSubmit` / `accepted`, `turnId` = your prompt number | working |
| The agent is working (message chunks, tool calls) | `active` / `agent_message`; `PreToolUse` / `<tool kind>` | working |
| Optional working beat, from 0.7.9: the turn is still outstanding and the agent alive, with nothing new to report (a long tool or model call) | `active` / `liveness`, with `turnId`, `sequence` and `livenessSeconds` | working while beats keep coming |
| From 0.7.9: you delivered an answer or permit to a request OpenRig had shown as needing input, and the agent continues the same turn (section 7) | `active` / `permission_resolved`, with `turnId` and `askId` | working |
| You refused a permission request (section 7) | `Notification` / `permission_prompt` | needs input |
| The turn ended | `Stop` / its stop reason (`end_turn`, `cancelled`, `max_tokens`, `refusal`) | idle. While you hold attention (section 7), don't post it: OpenRig reads any non-exit `Stop` as idle and clears needs input |
| Optional idle heartbeat | `Stop` / `idle_heartbeat`, with `livenessSeconds` | idle while beats keep coming |
| The agent process ended | `Stop` / `<preset name>_exited` | unknown, **never idle** |
| Your runner or the agent hit an error | `Notification` / `runtime_error` | recorded, but not used as activity: the prior activity evidence keeps its usual lifetime. It doesn't itself request or clear attention |

- **Liveness:** state `livenessSeconds` (a whole number of seconds from 1 to 3600; any other value is ignored) on every
  idle `Stop`, the turn's end as well as each beat. OpenRig stops reading the seat idle after 2 × `livenessSeconds` without
  a newer idle report. Without it, an idle report holds until your next post, even if your runner has died. Never send a
  non-exit `Stop` or a beat while holding permission attention.
- **Working evidence lasts 15 seconds.** A working post (`UserPromptSubmit`, `active`, `PreToolUse`) decides the seat's
  activity for 15 s. After that the seat reads from its other evidence: the screen can still show work, but it never
  reads a runner seat idle, so with nothing else the seat reads unknown.
- **The working beat (from 0.7.9)** keeps a long, quiet turn reading working. It says only that this turn's prompt is
  outstanding and the agent process you started is alive. It isn't progress.
  - **When to beat:** only while a prompt is outstanding and the agent is alive, more often than every
    `livenessSeconds` ÷ 2.
  - **When to stop:** stop at once on the turn's `Stop`, on a permission request that needs a person, or on the agent's
    exit, and post that boundary first.
  - **`livenessSeconds`** is how long one beat counts as working. OpenRig clamps it to 5-60 s, and uses 30 s when a beat
    has none. After that the beat stops counting, and the seat reads from its other evidence, as a working post's does.
  - **A beat counts only when all of these hold:**
    - it carries `generation`, equal to the seat's live occupant generation, and so did the `UserPromptSubmit` /
      `accepted` post that opened its turn;
    - its `turnId` is your latest `UserPromptSubmit` / `accepted` turn, and you haven't posted that turn's `Stop` or an
      exit;
    - it carries a `sequence`, greater than every earlier post's in the same generation that OpenRig counted, beats
      included;
    - the seat has no attention outstanding, such as a permission request waiting on a person.

    So number every post with one `sequence` that rises across your whole runner process, beats included. OpenRig
    orders your posts by `occurredAt`, then `sequence`. A post older than one OpenRig already counted changes nothing:
    a late `Stop` for an earlier turn doesn't end the current one, and an older beat doesn't count. A post without a
    valid `occurredAt` is dated when it arrives, by OpenRig's clock, so it can read older than it is when your clock
    runs ahead. Give every post its `occurredAt`.
  - **After you deliver an answer or permit** to a request OpenRig had shown as needing input (section 7; it created an
    ask, and a permit at submit opens none), post `active` / `permission_resolved` with the turn's `turnId` and the
    `askId`, before your next beat. That clears the seat's attention. So does any other working or idle post OpenRig
    counts, and an operator's `rig seat clear-attention`. OpenRig doesn't match `permission_resolved` to its `askId`.
    Beats are ignored until attention clears.
  - **A beat that fails any of these is ignored.** The seat reads as it would without it. A beat never starts or extends
    a turn, never clears attention, and never stands in for a `Stop`.
  - **OpenRig keeps what it needs to judge beats in memory.** After a daemon restart, a beat already counted keeps its
    lifetime, but new beats are ignored until your next accepted prompt, and the seat reads as it would without them.
  - **A runner that sends no beats** behaves as before.
- **Exit:** post `Stop` / `<preset name>_exited` only when you observe the agent's process exit.

- **The screen still counts,** but only as evidence of work. On its own it never reads a runner seat idle.
- **"Accepted" means your runner submitted its Nth prompt.** It isn't the agent's own acknowledgement, and it isn't
  tied to a particular `rig send`.
- **The generation attributes a post; it isn't authentication.**
  - A post carrying an earlier occupant's generation never counts for the live seat.
  - The hook token is one local token, so any process holding it can post for any seat.
- **A seat activity grant** is what a runner in another environment, such as a sandbox guest, receives instead of the
  local token. It arrives in the same `OPENRIG_ACTIVITY_HOOK_TOKEN`, with an `OPENRIG_URL` the guest can reach, and it
  speaks only for its own seat and launch generation:
  - with a grant, the generation is authenticated, and you may leave out `nodeId` and `generation`;
  - a post for another seat is refused with `403 activity_grant_wrong_seat`;
  - a post claiming another generation, or from an occupant that has since been replaced, is refused with
    `409 activity_grant_stale`;
  - a post before the launch has registered its occupant is refused with `409 activity_grant_pending`;
  - a post with a revoked grant is refused with `401 activity_grant_revoked`, including a post whose grant was revoked
    while its body was arriving.

  A refused post records nothing, so the seat's activity stays as it was, or unknown.

  **The guest's boundary is its listener, not the grant.** A guest reaches OpenRig only through a guest-only listener that
  serves this route and section 7's three permission-request routes, and accepts only a grant. It must never reach the
  daemon's main port. The grant scopes activity posts and permission requests, and the main port's other routes don't
  check it.
  - The listener is off by default. Turn it on with `OPENRIG_GUEST_ACTIVITY_PORT`, which must differ from the daemon's
    main port or the daemon refuses to start.
  - It binds `OPENRIG_GUEST_ACTIVITY_HOST`, default `127.0.0.1`: set it to an address the guest can reach.

## 5. Input: one submitted message is one prompt

Sections 5-7 specify the first dsh/ACP runner recipe; no runner has been qualified against it yet. They do not change
permission or input handling in existing built-in runtimes or require every possible runner protocol to use ACP.

- **Set up the pane:** put your TTY in raw mode and turn on bracketed paste (`\e[?2004h`).
- **What arrives:** `rig send` and queue reminders paste the whole message, then press Enter. Everything up to that Enter
  is **one block**, newlines included. Send it to the agent as **one** prompt (for ACP, one `session/prompt`).
- **Never split a block,** and never act on lines inside it.
- **Control input:** the only control is a block that is exactly `/abort`, or Ctrl-C typed outside a paste.
  - Ordinary sends and reminders arrive inside a From/To envelope, so they never equal `/abort`, whatever lines they
    contain.
- **A message that arrives mid-turn** waits for the next turn. Report it as queued, never as steering the current turn.
- **Limits to keep and to list under `limits`:**
  - a prompt whose whole text is `/abort` can't be sent as a prompt;
  - a Ctrl-C byte inside a paste also aborts;
  - without a TTY, input is read line by line;
  - this isn't a binary-safe channel.

### Optional run-bound native input and wake (version 1)

The optional native-channel implementation uses the launch's `OPENRIG_RUN_ID` and private `OPENRIG_ACTIVITY_HOOK_TOKEN` grant. Give the launch credential to the component that reports this launch's activity. That component can be a runner or the harness's own lifecycle hooks. `GET /api/activity/runner-channel` is run-filtered SSE, and one `POST` resource at that same path carries hello, acceptance, submitted and result messages. There is no command file or global event-feed subscription.

Hello supplies `{type:"hello", version:1, runId, retained, capabilities:{input,wake,cancel}}`. Capabilities are explicit booleans intersected with the recorded runner kind and Core implementation availability. They describe this live implementation, not native identity or program qualification. Core selects generic recorded runner kinds, never a community app-name whitelist. Builtin Pi/OMP remain kind0, preset-owned runners kind1, and OpenRig-hosted Pi-RPC kind2. A shared protocol or wrapper does not qualify a program or confer another runtime's invocation mapping.

#### Runtime coverage and qualification

| Runtime class | Existing behavior and optional native-channel limits |
|---|---|
| Builtin managed Pi | Existing input/wake/named-cancel implementation and its own invocation mapping; each live capability still requires current authority and implementation evidence. |
| Builtin OMP | Input-only shared RPC implementation with its own tests. Keeps `omp_session_file`, OMP approval/provider/HOME/state and protocol-v2 behavior; wake/cancel remain false without a proven OMP invocation mapping. |
| Hosted Pi-RPC community programs | Input-only shared RPC implementation, recorded kind2 and `community:<runtime>` reference. Each executable must satisfy the declared protocol; no inherited Pi qualification or wake/cancel capability. |
| Preset-owned runner (`runner: true`) | Its actual implemented and declared operations intersect with Core support. The independent dsh consumer has its own mapping; another ACP or stream-JSON program does not inherit it. |
| Claude Code | Typed interaction and saved-session bounded headless wake remain. The separate opt-in launch-owned hook bridge supports live ordinary delivery and wake through its existing lease; it is not this structured runner channel or named cancellation. |
| Codex raw TUI | Existing typed interaction and saved-session bounded headless wake remain. Those headless commands are not this live native input/wake/cancel channel. |
| Cursor / Hermes / Pi TUI | Maintained TUI launchers have no live native consumer; new native operations are unavailable. Pi TUI is distinct from managed Pi RPC. |
| OpenClaw local / gateway | Same TUI limit. Client exit does not prove native turn cancellation, stopped gateway work or gateway custody. |
| OpenShell owned / attached | Existing scoped guest activity/work and operation/resource/native identity remain. They do not provide the hosted pane/PID run binding; no new native channel is advertised. |
| Terminal / stub | Existing shell or scripted-test interaction remains. No native program capability is inferred from builtin kind0 or a stub fixture. |
| Other external consumers | Generic contract eligibility is program-independent; actual consumer implementation and separate evidence are required for each operation. |

All classes retain typed default. Unsupported native requests refuse before a native or typed effect; absence of an active consumer is not permission to fall back after uncertainty. OMP/hosted2 input acceptance uses the correlated prompt response and does not fabricate a native invocation ID or model-work result. Optional observations remain `runner_reported`; neither reported session/model/context nor a common ABI independently verifies native identity. No new telemetry collector is installed.

The maintained TUI launchers and bounded headless wake child remove the run-ID/hook-token pair when a run ID is present, while legacy hook-only environments and required identity/provider metadata remain unchanged. The caller retains its authority; native children receive none of the new run credential. These controls do not add a native consumer to a TUI launcher.

#### Native delivery and named commands

Every seat still defaults to `typed`. `rig seat set-input-route <seat> --route native --reason ...` saves the native input preference even without a connected runner, and reports live input/wake capability separately. Saving the preference does not launch a runner, deliver or replay input, or establish a capability; native sends and wakes remain not offered while no capable runner is available. Native requests retain the existing sender, original-conversation constraint and interruption/held policy. The saved request ID's route is immutable: a preference change applies to a new ID. A native refusal or uncertain effect never types a fallback, and `--verify` never invokes a terminal-pane verifier for a native receipt.

Explicit terminal interaction, submit-only Enter, exact terminal text and OpenRig's reserved Pi compaction control keep their existing guarded typed path. They are not native model prompts and cannot reuse an ID already bound to native input. Ordinary OpenRig notices still follow the seat's selected input route.

Each request SSE event is preceded by the standard SSE comment `: runner-frame-chars=<n>`, where `<n>` is the exact JavaScript string length (UTF-16 code units) of the complete serialized receipt in its `data` field, including payload and ordered member IDs. Readers use this per-event length plus a bounded SSE envelope allowance instead of assuming a single-message quota bounds a composed group; without the comment, the existing bounded frame allowance applies. The comment is only framing metadata: it changes neither admission nor custody, and legacy SSE consumers ignore it.

A request frame contains `{version:1, runId, requestId, sequence, kind, payload}`. Input payload is `{text}`; wake payload is `{question}`. The request ID is its existing outbox operation ID. A combined send retains one primary ID plus its ordered source-member links. Sequence is run-local and ordered; an SSE cursor is not acceptance. The live receiver retains every immutable ID/payload and result for its process lifetime, acknowledges custody by POST, and waits for Core's durable acceptance response before writing the native prompt. It retries saved HTTP receipts after lost replies; it never repeats a native write to repair HTTP delivery. Restarting a runner creates a new run, not a persistent receiver command journal. At a committed Core run replacement, the earlier run's offered/accepted receipts and unanswered submitted wakes become `receiver_state_lost`/indeterminate. Never-offered requests become rejected/failed with “not offered: its run ended”; they are not replayed into the new run. Known ordinary-input submissions and terminal results keep their recorded outcomes.

An unreadable binding, including a failed grant-standing read, returns retryable `409 runner_grant_unverified`.
It does not revoke authority, clear the live receiver map or discard retained receipts. The existing consumers retry
those saved HTTP posts after verification recovers; they do not repeat native work. Positive stale/revoked authority
keeps its existing refusal. A new native request still requires a currently capable runner.

After native protocol submission/acceptance the runner posts `submitted`; native delivery is not model-work completion. A terminal result whose submission could not be established may instead carry `{completion:"unknown", submissionUnknown:true}` from accepted custody. Core retains that terminal uncertainty as outbox `indeterminate`, never `delivered`; it cannot include a successful wake answer or an acceptance claim. Known pre-effect native rejection is separate. Erased native content remains an unavailable opaque custody tombstone, not an executable request.

`POST /api/seat/command/:seatRef` accepts `{requestId,type:"wake",question}` and returns its saved custody stage. `GET` at the same resource with `?requestId=...` reads its result. `rig ask <rig> <question> --wake <seat>` uses this live path only when the seat explicitly selects `native`; unavailable native capability is a refusal. Historical Claude/Codex one-shot wakes and raw session tokens retain their existing semantics.

A wake waits for the current execution to finish and then gets its own native prompt. Pi's ordinary busy input continues to steer; dsh's ordinary busy input continues to queue. During the dedicated wake, later managed input waits. Pi gates the dedicated prompt on native control-state evidence and pending person/startup preflight, not on a guessed idle flag. Person controls remain usable; a person steering into the wake makes its attribution unknown. Only that prompt's actual assistant text and terminal native outcome become `{kind:"wake",answer:string|null,nativeTurnId,completion:"completed"|"interrupted"|"failed"|"unknown"}`. Tools, old output and partial streaming text are not substituted for an answer. Known terminal native outcomes release the managed barrier. Pi waits for the authoritative prompt disposition before committing any answer: only a dedicated `started` invocation can answer. A queued or otherwise uncorrelated execution reports `{completion:"unknown",answer:null,ownershipUnknown:true}` and quarantines all managed input for that run as `native_ownership_unknown`. Core persists that fence atomically with the result; reconnect, restart and content erasure cannot clear it. A handled command with no execution evidence returns no answer and can release normally. A caller timeout returns the request ID and latest saved stage for lookup; it neither clears the native barrier nor cancels the prompt.

Consumer fixtures exercise Pi RPC shapes from the installed Pi 1.5.0 SDK and dsh's ACP implementation at 0.2.1-rc.2. Stand-in native backends prove the runner/Core plumbing, not actual program or provider qualification. Separate opt-in tests execute installed Pi 1.5.0 and dsh 0.2.1-rc.2 against a loopback fake Anthropic provider with scratch homes and dummy keys. They exercise actual idle/busy input and dedicated wake sequencing, not a real vendor backend, named cancellation or other versions/forks; no program default is promoted. Set `OPENRIG_NATIVE_PROGRAM_PROOF=1`, `OPENRIG_NATIVE_PI_BIN` and `OPENRIG_NATIVE_DSH_BIN` to explicit installed executables, then run the existing `runner-conformance-real-routes.test.ts` in a private network namespace with loopback enabled.

The existing `tmux-server-isolation-daemon.test.ts` also launches managed Pi and a declared dsh preset through the built CLI and daemon with offline native backends. It kills only its scratch daemon with SIGKILL during a wake and restarts it through the normal daemon startup. It checks retained run authority, receiver/native-child and pane process lineage, the recovered answer, duplicate-ID retry and a subsequent wake without repeated native prompts. This covers daemon OS-process recovery with a live receiver map; it does not establish receiver-map persistence after the runner itself dies or combine the crash with the installed-program provider test.

Managed Pi and dsh additionally post `{type:"turn",runId,sequence,nativeTurnId,state:"opened"|"closed",acceptedTurnIds}` through the authenticated channel. Core retains these as `agent.runner_turn` events and exposes the latest open bound invocation in seat status. This sequence belongs to the turn-report family, independently of observation samples and outbox delivery sequences. Identical retries are idempotent; conflicting sequence reuse, closed-epoch reuse and regressing accepted mappings are refused. Missing evidence provides no target and never proves idle.

Pi's native scope is an agent invocation from `agent_start` (or `turn_start` when closed) to `agent_end`; steers have distinct accepted IDs inside that invocation. dsh's native scope is its one outstanding prompt RPC, not the ACP session. The foundation retains Pi followups at the runner and supports internal successor/permission preparation fences. Native permission metadata requires a bound run grant and matching authenticated turn evidence; legacy install authority cannot authenticate these additional fields. A committed turn withdrawal blocks later submissions and decisions, and remains unconfirmed while an existing submission is still in flight or its handoff cannot be followed locally. Managed Pi and the dsh example implement named cancellation when their live capabilities declare it. Other implementations must declare only operations they actually implement and qualify.

### Named managed cancellation

`POST /api/seat/command/:seatRef` accepts `{type:"cancel",requestId,target:{runId,nativeTurnId}}`. Obtain the exact target from `rig seat status <seat> --json` (`nativeInput.target`), then freeze it. `rig seat cancel <seat> --run-id <run> --native-turn-id <epoch> --request-id <id>` sends that explicit target; repeating the same command reconciles its retained receipt. Missing target is invalid. Neither an accepted-input ordinal nor a native session ID substitutes for the native invocation ID. This operation does not change the seat's typed/native input preference or synthesize typed controls.

Cancellation shares the existing outbox and run-bound stream, with `kind:"cancel",payload:{target}`. Control can overtake an unacknowledged ordinary input, while ordinary input/wake FIFO and immutable identities remain intact. Reconnect may replay an older unacknowledged frame even after a higher control cursor; the receiver's retained map reconciles that ID without a repeated native effect.

Temporary connection or grant-standing uncertainty refuses fresh cancellation with a retryable response before consuming its ID. A declared unsupported operation remains `not-supported`. Missing invocation ownership is unknown, never proof of `not-this-turn`; a lost receiver map keeps that target refusal for the rest of the run, cleared only by a new run. It does not make unrelated input unavailable merely because a cancellation needs reconciliation. Original input/wake uncertainty and no-replay guards still apply. Legacy install-token reporting cannot claim native authority. An authenticated permission ask without verified invocation correlation is accepted with a diagnostic; claimed invocation tags are denial-only hints, so withdrawal still rejects late permissions for that named turn.

The runner posts `{type:"cancel-prepare",runId,requestId,sequence}` on the existing channel. Core derives the immutable target from its receipt and withdraws its asks before confirming preparation. `receipt.withdrawal` keeps pending/confirmed stage, counts and timestamps, including partial failure. No native abort is written until permission submission/callback drain and an exact target recheck. A legitimate pending drain can continue; person input remains usable and may supersede unsubmitted local preparation. Actual failed preparation is retired by the runner as `stage:"rejected",result:{kind:"cancel",reason,applied:false}`, with no outcome. Withdrawn approvals stay withdrawn. Core receipt acceptance alone never proves that no native operation was written.

The four effect outcomes remain `requested`, `cancelled`, `not-this-turn`, and `not-supported`. Submitted cancellation is `requested,confirmed:false`; native operation acceptance is separate evidence. Pi records its correlated abort acknowledgement as `operationAccepted`. For a Pi cancellation whose target ended during preparation or after submission, its agent_settled event releases the cancellation hold, without waiting for an abort ACK or another cancellation state query. Person prompts entered before settlement stay in the existing held prompt queue and are sent afterward; agent_end alone is not native readiness. A correlated abort ACK is not a settlement fallback. Normal input/wake readiness still applies: Pi can retain native queued words after abort, and a dedicated wake still waits for native idle with an empty queue. In that case an explicit person continuation can let those words run before the dedicated wake. This is a disclosed limitation, not automatic successor progress. A bare agent_settled releases the hold too: aborted is optional evidence, not a continuation requirement. Pi may use agent_settled.aborted when present, or prior native abort evidence, with known-safe empty-queue evidence; a retained or unknown queue stays requested/unconfirmed. A late ACK does not revise the immutable final result. Continuing is not cancellation proof and never restores withdrawn approvals; dsh uses its exact outstanding prompt's cancelled response. Normal end or process exit never invents cancellation proof. Before submission, a positively ended/replaced target is not-this-turn. Requested work with unknown native acceptance retains indeterminate custody.

Pi never clears queued words for managed cancellation. Unknown or person-owned native queues reject only that local preparation without disabling ordinary input. Person prompts and native controls remain usable. dsh sends managed `session/cancel` once for the exact outstanding prompt; a person's repeated `/abort` remains available. A person abort before prompt write suppresses it as a local interruption without sending a premature native cancel. Opened/closed report retries remain ordered but do not gate ordinary dsh prompts or terminal progress; shutdown retains its existing total two-second drain bound.

`rig seat status <seat> --json` projects body-free `nativeInput.unresolved` evidence across current and older runs: request/target/member IDs, sender/destination, stage, withdrawal, reconciliation and uncertain requested outcomes. Historical evidence does not imply all current work is held. The pane and status identify the person operating the seat or its responsible agent as reconciler. A submitted Pi cancellation waits for native agent_settled; ordinary native readiness and dedicated-wake queue ownership requirements still apply. The supported continuation is a new plain prompt in that pane, without resending retained words, distinct from /abort and rig seat stop. Known retained input IDs and waiting managed IDs are reported in the authenticated cancellation result. Existing responsible-agent work uses the ordinary queue route to a different bound node, with quoted nonerased words read from the same node/run Outbox owner. Existing owner/escalation and receiving-agent settings supply routing; missing or unavailable owners leave visible concrete guidance rather than another wake behind the stranded queue. This work is a captured report, not proof of delivery, pickup or automatic progress. Erasure and immutable queue-ID retries retain their existing ownership rules. If ownership cannot be recovered, an explicit scoped manual choice is `rig seat stop <seat> --reason <text>`; nothing restarts, replays, or releases on a timer. A cancel request carries no fallback words. Erasure preserves opaque custody/target evidence and rejects reuse/late results while removing content and free-form detail; unresolved erased IDs remain inspectable. Fixture tests prove protocol plumbing; installed-program qualification is recorded separately.

## 6. Cancel: requested isn't the same as done

- **On `/abort` or Ctrl-C:** send the agent's cancel (for ACP, the `session/cancel` notification, which has no reply),
  and record when you sent it.
  - **Sending it:** a person types `/abort` in the seat's pane. From another seat or a script,
    `rig send <seat> "/abort" --raw` pastes exactly `/abort`, with no From/To envelope, and presses Enter, so a runner
    that follows section 5 gets the control. 0.7.8's native runs typed it in the pane; a raw send hasn't been run
    natively. An ordinary `rig send` wraps its text in a From/To envelope, so there `/abort` is an ordinary prompt.
  - **Not while the seat needs input:** a raw send is still refused while the seat reads needs input
    (`target_needs_input`), for example while the runner holds a permission request for a person (section 7). Type
    `/abort` in the pane then.
  - **A sent `/abort` is a request.** A typed control can't name the turn it was meant for: the runner cancels whatever
    turn is running when it reads it. Whether a turn was cancelled is the runner's `Stop` / `cancelled` below.
- **Report "cancelled" only when the agent says so:** for ACP, when `session/prompt` returns `stopReason: "cancelled"`.
  Then post `Stop` / `cancelled`.
- **Whether the provider stopped work or spend is unknown.** Don't claim it.

## 7. Permissions: a person answers, and the default is permit

### The first version: refuse every request (history; still what `--deny` does)

- **Refuse at once:** answer every permission request immediately with a refusal (for ACP,
  `{"outcome": {"outcome": "cancelled"}}`).
- **Make it visible:** show what was asked in the pane, and post `Notification` / `permission_prompt`.
- **Hold that attention** as your last post through the end of the turn, so the seat reads needs input. Don't post the
  turn's `Stop` or idle beats while holding it.
- **It clears** when your next prompt is accepted, or when an operator clears it
  (`rig seat clear-attention <session> --reason "…"`).
- **Never leave a request pending.**
- **What it couldn't do:**
  - answer from the seat's permission setting;
  - take answers typed into the pane;
  - route an approval to another seat.

  So a job that needed an edit or a command approved couldn't finish. The answered path below, added in 0.7.8,
  replaces this as the default.
- **Unknown requests from the agent:** answer with JSON-RPC `-32601` and carry on.

### The answered path (0.7.8)

**Only requests the agent actually makes reach anyone.** The harness's own permission mode decides that, and a harness
that runs without asking gains no approval step. Ordinary conversation and `rig send` are unchanged.

**What happens to a request, in the person's terms:**

| Situation | What happens |
|---|---|
| **There's a default person** (chosen with `rig gateway default`, or the only registered person), and no override | They get an ordinary ask in the Feed and on Slack. No setup is needed. |
| **The seat's operator chose someone** (`rig seat set-permissions-to <seat> --to <person> --reason "…"`) | That person gets the ask instead. |
| **No one can be asked** | **Permitted at once**, with the agent's own allow option. No ask is opened, and OpenRig records the permit (below). That covers: no registered person; several and none the default; the chosen person no longer registered; the people unreadable; or options a person can't be shown (bad ids, or not 2-4). The agent's `allow_once` is used, else its `allow_always`. If the agent offers only `allow_always`, the harness then remembers a permission nobody chose. |
| **The seat's operator opted in to refusal** (`rig seat set-permissions-to <seat> --deny --reason "…"`) | Refused at once and held as needs input, as in the first version. |

**What the ask shows:**
- the seat and the conversation;
- the tool call, as the agent described it;
- why this person was asked;
- every option the agent offered, each with its native meaning. `allow_always` means the agent's harness remembers
  the choice and allows similar requests without asking. OpenRig doesn't record or revoke that.

**How a person answers, and what the agent gets:**

| The person… | The agent gets |
|---|---|
| clicks an option: the asked person, any other registered person, or the primary user in the TUI | that option |
| replies with just a yes ("yes", "ok", "allow", "go ahead" …) | the agent's allow (`allow_once`, else `allow_always`) |
| replies with just a no ("no", "deny", "reject", "stop" …), or denies it in the Feed | the agent's reject (`reject_once`, else `reject_always`), or, with no reject option, cancelled. A person's no is never a grant |
| routes or hands it to another person | the ask waits for that person, who gets the same options; their answer counts as if they'd been asked. The handoff itself never permits |
| routes or hands it to an agent seat | that seat gets no options. The request waits until that row is closed, by the seat or a person. Closed as done without a choice (including a drop), or as failed, is no answer, so it's permitted. Closed as denied (the Feed's deny, `--closure-reason denied`, or the state `denied`) is a no. A row set to the state `canceled` cancels the request, and a further handoff is followed; a person it reaches gets the same options. Or the request waits until the agent's turn ends |
| closes it with no answer at all (a drop) | no answer, so the default applies: **permitted** with the agent's allow, and OpenRig records the permit (below) |
| answers in other words that nobody decides on | after 0.7.11, **the request waits**: the words are kept, never the default permit, until an explicit decision (`rig seat decide-permission`) or the turn's end |
| doesn't answer | the request **stays pending and visible** (the seat reads needs input) until the agent's turn ends. It's never timed out into a grant. |

**After 0.7.11, a person's answer goes to an agent that decides, or waits:**
- **Who decides:** this host's receiving agent (`agents.operator_session`, else the kernel operator
  `operator-agent@kernel`), unless it's the runner that asked (the request's first row, however it was handed on) or
  a seat this host doesn't have; then the kernel operator, unless it's the runner that asked.
- **What happens to the answer:** a click, a plain yes or no, other words, or Steering's Approve or Deny on the request
  (a yes or a no) is kept on the row it was given on. The request is handed to that agent with the person's whole
  answer, the question and the options, and the person is told once who decides and in what recorded state.
- **The runner keeps reading `pending`.** The agent decides with `rig seat decide-permission <askId> --option <id>
  --reason "…"` (`POST <base>/api/activity/permission-requests/<askId>/decide` with `{"optionId", "reason"}`).
  - A team seat named as `agents.operator_session` runs it with no prompt. Any other team Claude seat asks its person
    first, so a seat can't approve its own waiting tool call.
  - It accepts only an option the agent offered.
  - It records an agent's decision: who decided, why, and the person's words.
  - A request that's no longer pending comes back as it is, and nothing is written.
- **A kept answer counts only through an explicit decision.** If the row is closed without one (an agent's or a
  person's ordinary close), the answer stays kept and the request waits; `rig seat decide-permission` still settles it.
  A refusing close (denied) is still a no.
- **With no agent that can decide,** any answer is kept, the request waits, and the person is told once that the tool
  hasn't run and how to decide directly (`rig seat decide-permission`) or set up a receiving agent. A handoff that fails
  leaves the request waiting the same way.
- **No timeout refuses a request.** If the turn ends first, nothing is sent.
- **The default permit stays** for a request nobody can be asked about (above), and one closed with no answer at all.

- **An answer reaches only the live request it was asked for,** once. A request from an earlier occupant reads
  `stale`, and one withdrawn at the turn's end reads `withdrawn`. Neither can take a later answer.
- **Text typed into the runner's pane, an agent's own text, and `rig send` are never an answer.** While a request waits
  on a person, the seat reads needs input, and sends are normally refused. A send that does get through reaches the
  agent as a prompt.
- **From 0.7.9, each permit OpenRig decides by default is recorded,** once, as a stream item from the seat. That covers
  no one to ask, and an ask closed without a choice (the row passed to an agent seat included). The record names:
  - the tool call;
  - why no person answered, including, for a closed ask, who closed which row and how;
  - the option the agent got, with its kind. An `allow_always` option is marked as remembered by the agent's harness;
  - the conversation and request, or the ask.

  For an ask opened before 0.7.9, the record may omit the option kind and whether the harness remembers it.

  Read the records with `rig stream list --tag runner-permission-permit`, or `--source <seat>`. A record wakes no one,
  and one that can't be written doesn't change the permit.

**The runner's protocol:**
1. **Submit** the agent's live request to `POST <base>/api/activity/permission-requests`, with the same token or seat
   grant as section 4:

   ```json
   {"sessionName": "dev-builder@my-rig", "nodeId": "<node id>", "generation": "<OPENRIG_OCCUPANT_GENERATION>",
    "nativeRef": "<the conversation>", "turnId": "7", "requestId": "<the agent's JSON-RPC id>",
    "toolCall": {"title": "Edit src/app.ts", "kind": "edit"},
    "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"}],
    "occurredAt": "2026-10-30T12:00:00Z"}
   ```

   - **A person is asked:** the reply is `{"ok": true, "askId": "…", "created": true}`. OpenRig records the seat's
     `permission_prompt`, so it reads needs input. Don't post it yourself.
   - **No one can be asked:** the reply is `{"ok": true, "state": "permitted", "optionId": "…", "reason": "…"}`.
     Deliver that option.
   - **`requestId` and `turnId`** may be strings or numbers. Pass the agent's id unchanged: a number is read as its
     decimal string, so `7` and `"7"` are the same request.
   - **Resubmitting** the same generation, conversation and request id returns the same `askId`.
2. **Read** the answer with `GET <base>/api/activity/permission-requests/<askId>?waitSeconds=25` (25 at most), and read
   again until the agent's turn ends.
   - **The `state`** is `pending` (read again, don't cancel), `answered` or `permitted` (each with `optionId`),
     `refused` (with `reason`: `said_no` when the person said no and the agent offered no reject option, or
     `no_allow_offered` when it was closed without a choice and the agent offered no allow option), `withdrawn` or
     `stale`.
   - **From 0.7.9, `said`,** with `permitted` or `refused` (`no_allow_offered`), is the person's own words, when they
     answered in words that were neither a choice nor a plain yes or no. It never changes the outcome. After 0.7.11, words are never
     answered with the default permit (they keep the request waiting), so `said` no longer arrives. A runner that handles
     it keeps working.
   - **A seat grant reads and withdraws only its own launch's requests.** Once its occupant is replaced, the grant is
     refused (`409 activity_grant_stale`), even during a read's wait.
3. **Deliver** `{"outcome": {"outcome": "selected", "optionId": "<optionId>"}}` to the agent once, and only while that
   request is still its live one. For `refused`, `withdrawn` or `stale`, answer `cancelled` and hold no attention: no
   person is still waiting. A refusal of the read itself follows the refusals below. From 0.7.9, when the read carries
   `said`, queue those words for the agent as an ordinary prompt: they reach it after the current turn, behind any prompt
   already waiting. They're never the answer. A runner that drops them still keeps this contract.
4. **Withdraw** when the turn is cancelled or ends, or the agent exits:
   `POST <base>/api/activity/permission-requests/<askId>/withdraw` with
   `{"reason": "turn_cancelled" | "turn_ended" | "exited"}`.
   - A later answer isn't sent.
   - A relaunch makes the earlier occupant's open requests stale on its own.

**Refusals, at submit or while reading.** One rule covers both. Cancel only a request that certainly isn't the current
occupant's live one, and hold no attention. Anything that may still be a live request permits, as when OpenRig can't
answer. Only the seat's opt-in refuses and holds attention.

| Code | Status | Meaning | The runner |
|---|---|---|---|
| `denied_by_seat` | 409 | The seat's operator opted in to refusal (`--deny`). | refuses and holds attention |
| `options_unsupported` | 422 | No one can be asked, and the agent offered no allow option to permit. | refuses and holds attention |
| `stale_generation` | 409 | With the activity token: the post isn't from the seat's current occupant. | answers `cancelled` |
| `activity_grant_wrong_seat` | 403 | The grant speaks for another seat. | answers `cancelled` |
| `activity_grant_stale` | 409 | The grant's launch generation no longer occupies the seat. | answers `cancelled` |
| `activity_grant_unverified` | 409 | The binding could not be verified now; this is retryable, not evidence of replacement or cancellation. | permits under the existing unavailable-answer policy |
| `activity_grant_revoked` | 401 | The grant was revoked while its launch generation still occupies the seat, or before it has registered, so this may still be the live request; a replaced occupant's grant reads `activity_grant_stale` instead, even once revoked. | permits |
| `activity_grant_pending` | 409 | The grant's launch hasn't registered its occupant yet. | permits |
| `duplicate_request` | 409 | This request id was already submitted in another turn; an agent may reuse an id. | permits |

**When the runner can't get an answer from OpenRig,** nobody can be asked, so it permits with the agent's own allow
option: `allow_once` when offered, else `allow_always`. Prefer `allow_once`, so the harness doesn't remember a
permission nobody chose. Such a permit is the runner's own, so OpenRig has no record of it: the runner prints it in
its pane. That covers:
- an OpenRig without this path, which answers 404;
- an OpenRig the runner can't reach, at submit or while reading (a runner may retry a read that got no answer a few
  times first);
- a refusal the table marks "permits", and any status or code this section doesn't list.

**Limits of this path:**
- **The answer owner is a registered person.** Choosing a seat (another agent) to answer is a later change.
- **A colleague's answer is followed on this host.** If the ask is handed to another host, the request waits, shown as
  needs input, until the agent's turn ends.
- **An override or `--deny` is set with the command above, never in a rig spec.** A spec field is a possible later
  change.
- **A person's answer is recorded on the ask itself,** and a default permit as the stream item above. That item lasts as
  long as stream retention keeps it. A permit the runner decides on its own is in its pane only.

### A seat's own Claude Code prompt (native asks)

A Claude Code seat that loads the `openrig-core` plugin answers its own permission prompt through the same route. The
plugin's `permission-answer.cjs` is a synchronous `PermissionRequest` hook, separate from the passive relay. It submits
the prompt as a native ask (`"nativeHook": "claude-code"`, with the tool and its exact input as `action`) and waits for an
answer for as long as the prompt is open, up to 24 hours.

Claude Code's own dialog stays open in the terminal the whole time (checked on Claude Code 2.1.330), and whichever answer
comes first counts. So waiting costs the person at the terminal nothing, and a person's answer to a prompt that's still
open is carried however long it took to reach them. The hook ends sooner whenever the prompt does (below), and when the
Claude Code that started it is gone. Claude Code 2.1.330 caps a hook's `timeout` only at 2^31-1 ms (about 24 days); the
plugin's is 24 hours and 30 seconds. A native ask differs from a runner's request only where a default would decide for
the person:

| Situation | What happens |
|---|---|
| **Someone can be asked** | In order: the person chosen for the seat (`rig seat set-permissions-to`); else the return route of the work the seat is running (the person's own conversation, as `rig queue create --return-route auto` issued it): the one route its open work carries or, when that work comes from several conversations, the route of its newest in-progress work, else of its newest open work, when that route is on this host; else the default person. The reply is `{"ok": true, "askId", "created", "askedOf", "answerBy"}`. |
| **No one can be asked**, or the seat chose `--deny` | `{"ok": true, "state": "not_asked", "reason"}`. Nothing is decided: no permit, no refusal, and the prompt carries on in the terminal. |
| **A person picks an offered option, or replies just yes or no** (Feed, Steering's Approve or Deny, the TUI, Slack) | Their own answer. It closes the ask as theirs, with no receiving agent in between and no second confirmation. |
| **A person answers in other words** | The receiving agent judges the exact action against them, as for a runner: allow when it meets them, deny with their words when it doesn't, recorded as its judgment, not their no. Words it can't read are asked back. |
| **The person's own conversation owns the ask** | Its agent shows them the exact action, then runs `rig seat decide-permission <askId> --option allow\|deny` (or calls the MCP tool `rig_seat_decide_permission`, which takes the same answer), never typing into the seat for it. A plain yes or no takes `--relay --person-said "<their words>"` and is recorded as relayed by that agent, with their words as it reports them: unconfirmed, since OpenRig didn't get that answer from the person. Words or a condition take `--reason` and `--person-said`, and are recorded as the agent's judgment. The decider is the conversation's address: `OPENRIG_SESSION_NAME=<address>` in a shell, and, through the MCP tool with no seat, the address OpenRig issued under that conversation's own key. |
| **Closed without an answer** | `unanswered`: never a permit. A queue close is never an approval. |
| **The prompt is answered in the terminal** | A No or Esc ends the hook, which withdraws the ask (`answered_in_terminal`). A Yes lets the tool run; when its exact call completes (the relay's `PostToolBatch` fingerprints), the ask is withdrawn the same way. A later answer through OpenRig reads as too late. |
| **The window ends, or the seat restarts** | After 24 hours the hook withdraws the ask (`answer_window_ended`), and the prompt waits in the terminal. A Claude Code that's gone without ending the hook (killed, say) makes it withdraw the ask as `answered_in_terminal`. An earlier occupant's ask reads `stale`. An answer after either is too late, and nothing is sent. |
| **The hook was killed outright** (an OOM kill, say) while Claude Code lives on | Nothing withdraws the ask, so it stays open until its window ends, and nothing takes an answer to the prompt. An answer is still recorded, and nothing is refused, but the reply says plainly that it hasn't reached the prompt (`native.notReached`), because the hook hasn't read the ask for a minute. The prompt may still be open in the terminal: check the seat. |

- **The first answer wins.** A second `rig seat decide-permission` on an answered ask returns it as it is, with
  `native.unchanged: true`, and writes nothing.
- **What reaches Claude Code:** `allow` for Allow once, or `deny` with a one-line `message`. The message says whose answer
  it is (a relay reads unconfirmed) and whose words it carries. A remembered choice ("don't ask again") is only in the terminal. The hook never
  sends `updatedPermissions`, `updatedInput`, `interrupt` or a mode change, and it has no `onFailure`.
- **The exact action** is shown on the ask before anything is stored. A command appears as its text, any other tool's
  input as JSON. Text matching the transcript route's credential patterns is shown as `[REDACTED]`, and the display is cut
  at 4000 characters, with the ask saying so when either happens. The request Claude Code runs is unchanged.
- **The record keeps four things apart:**
  - the answer (the decision on the ask);
  - the hook taking it (`runner-permission-taken-by-hook`, recorded before the hook returns it);
  - Claude Code applying it, which OpenRig doesn't see;
  - the tool call completing (`runner-permission-tool-completed`).

  A completion is matched by content: the conversation, the actor, the tool and the exact input. Claude Code's permission
  request has no tool-call id, so an identical call in the same conversation can't be told apart.
- **A read** of a native ask adds `native`, which can hold:
  - `hook`;
  - `answeredAs` and `by`, who decided. `person` is the person's own answer as OpenRig received it from them (Feed,
    Steering, the TUI, Slack). `relayed` is an agent's `--relay`: its report that this is the person's answer, which
    OpenRig didn't get from them, so it stays unconfirmed. `agent` is an agent's judgment on their words. Neither `--relay`
    nor the caller's session (attribution, not proof of a person) ever makes an answer read `person`, and a relay of an
    answer already recorded changes nothing. An ask closed as denied any other way has no `answeredAs`, only who closed it;
  - `said`, the person's words as OpenRig received them, and `reported`, the words the deciding agent says they gave
    (`--person-said`), kept apart when they differ;
  - `message`, what a deny tells Claude;
  - `why`, why it ended;
  - `taken` and `toolCompleted`;
  - on an answer the hook hasn't taken, `hookLastRead`, when the hook last read the ask (it reads again at least every
    25 seconds while it waits), and, once it hasn't for a minute, `notReached`: the plain words saying the answer hasn't
    reached the prompt. `rig seat decide-permission` prints them, the MCP tool returns them, and a person's own answer
    in Steering or the TUI gets them in its receipt. The daemon notes the reads in memory, so a restarted daemon knows
    only those since it started.
- **While a native ask is taking an answer** (up to 24 hours), the wake ladder holds that seat's permission-prompt alert
  and its relay task to the routed conversation. The ask is already that conversation's question about the prompt. The
  alert's relay would put the same question there a second time, with text telling it to type keys into the seat, and
  keys typed there answer the prompt in the terminal and end the ask. Once the ask ends (its prompt ended in the
  terminal, the seat restarted, or 24 hours passed), they go on as before. A hook killed outright leaves its ask open, so
  the hold lasts until the window ends; an answer meanwhile says it hasn't reached the prompt.
- **A conversation that isn't listening:** an ask to the person's own conversation reaches it through the `openrig`
  plugin's waiter, which listens for about two hours after each of its turns (its hooks' 7200-second timeout). A prompt
  after that waits for the person's next turn there, with the seat's prompt alert held, until they come back or the ask's
  24 hours end. The prompt stays open in the seat's terminal throughout.
- **Runner and ACP requests are unchanged:** their defaults, reads and decisions are exactly as above.

## 8. Resume: exactly the same conversation, or say honestly that you couldn't

- On a resume, OpenRig passes the conversation to reopen in `OPENRIG_RESUME_REF`. Use the method your agent
  advertises: ACP's `session/load` (capability `loadSession`), ACP's `session/resume` (capability
  `sessionCapabilities.resume`, which dsh `0.2.1-rc.2` uses), or your agent's own reopen method, named with its
  capability and pinned version in your `limits`.
- **Telling "missing" from "won't reopen":** an agent may answer one error for both. dsh `0.2.1-rc.2` answers `-32602`
  for a conversation it doesn't have and for one already active elsewhere. So don't read an error's code or text as
  missing unless the agent defines it that way, as ACP's not-found `-32002` is.
  - **Report missing only on the agent's own not-found,** and leave anything else unconfirmed.
  - **When the agent advertises `sessionCapabilities.list`,** its `session/list` can show that a conversation exists:
    one it lists but won't reopen is unconfirmed, even on a not-found. Follow `nextCursor` (an opaque string, possibly
    empty), and treat a page you can't read as deciding nothing.
  - **A list doesn't show that a conversation is gone,** unless your agent guarantees it lists every conversation. An
    agent may leave out one that another running process holds unsaved; dsh `0.2.1-rc.2` can. So still try the reopen
    for a conversation the list doesn't name.

| What happened | Write in the launch record | What OpenRig does |
|---|---|---|
| The same conversation reopened | the same `nativeRef` | resumed |
| The agent says it doesn't exist | `error: "missing"` | reports it missing; nothing new starts |
| Anything else: a timeout, an error, or the working folder no longer matches the conversation's | no record, or an error other than `missing` | **unconfirmed**: the seat keeps its conversation and needs attention |
| A different conversation opened | the other id | a mismatch; OpenRig doesn't switch to it |
| OpenRig couldn't create the record's folder | (nothing to write) | nothing starts |

- **Never start a new conversation on a resume.**
- A conversation saved under another harness's runtime is never handed to your launcher.

## 9. Context, model and shutdown: whose job is what

| Responsibility | OpenRig does | Your preset or runner does |
|---|---|---|
| **First startup turn** | Writes it to a private file and passes `OPENRIG_FIRST_INPUT` (with `first_input: true`) | Gives those exact bytes to the agent through its own first-prompt route |
| **Guidance, skills, startup files** | Doesn't place them for community harnesses; a launch warns that they weren't delivered | Puts whatever the agent needs where *your* harness reads it, or says in `limits` that it isn't supported |
| **Model** | Passes the seat's declared model as `OPENRIG_MODEL` (with `passes_model: true`); never substitutes one | Maps it to the harness's own setting. OpenRig shows the effective model as unknown |
| **Placing the agent somewhere else** (a sandbox, another machine) | See the [execution platform chapter](execution-platform-contract.md) | Keeps the runner independent of where it runs |
| **Shutdown** | `rig seat stop` and `rig down` end the seat's tmux session at once: no graceful stop handshake reaches the runner, its pane just closes. OpenRig ends nothing outside that session, and does no external provider cleanup | **(Proposed)** When the runner's pane closes (a hangup) or it's asked to stop, it attempts where possible to cancel any running turn and end the agent process it started, and lists in `limits` anything that may keep running. Cleanup of external compute needs the platform owner to reconcile it |

## 10. What counts as evidence

- **Keep three things separate:**
  - **`rig send --verify`** checks the pane before and after a send. It's pane evidence, not proof the agent received
    or finished anything. Mirror each accepted prompt in your pane (for example `you ▸ …`); OpenRig doesn't yet promise
    that `--verify` recognises it.
  - **A turn ending isn't the work being done.** Task completion is whatever the work's own record says: a queue task
    marked done, or an artifact written.
  - **Your own tests** should run against a fake agent that covers each section above. The
    [runner conformance check](runner-conformance/README.md) does that for you: point it at your runner, and it reports
    which promises your runner keeps.
- **The useful real check** for a maintainer:
  - a seat starts and reads ready only after the handshake;
  - one multi-line message becomes one prompt;
  - the seat reads working, then idle;
  - a refused permission reads needs input;
  - `/abort` ends a turn as cancelled;
  - a resume reopens the same conversation, and a missing one is refused, never replaced.

  That's the same promotion test the presets reference describes, applied to these declarations. Passing it is
  compatibility evidence for the versions you name, not certification.

## Contributor checklist

- [ ] The preset sets `runner: true` and `launch_result: true`, and not `names_conversation`.
- [ ] After the agent opens or reopens its conversation, the runner writes the launch record, with versions in `producer`.
- [ ] Activity posts carry `sessionName`, `nodeId`, `runtime`, `generation`, `sequence`, `occurredAt`, `hookEvent` and
      `subtype`. They're sent in order and never block the agent.
- [ ] One submitted message becomes exactly one prompt. Only a bare `/abort` block, or Ctrl-C outside a paste, is control.
- [ ] Cancel records "requested" when sent, and "cancelled" only on the agent's own stop reason.
- [ ] Every permission request goes to OpenRig's answered path, and the runner delivers the option that comes back: the
      person's, or OpenRig's permit. When OpenRig can't answer (404, unreachable, or a refusal section 7's table marks
      "permits"), the runner permits with the agent's `allow_once`, else `allow_always`. A refusal that says the request
      isn't the current occupant's, or a `refused` answer, means answer `cancelled` and hold nothing. Only
      `denied_by_seat`, or no allow option to permit, means refuse at once, show it, and hold needs input until the next
      accepted prompt.
- [ ] An agent exit posts `Stop` / `<preset name>_exited`, never a plain idle.
- [ ] A resume reopens the exact conversation. It reports `missing` only on the agent's word, and otherwise leaves it
      unconfirmed.
- [ ] Unknown agent requests get `-32601`.
- [ ] `limits` names the input limits, the permission limit, what keeps running after a stop, and anything not supported.

## Open questions

1. **Answered:** which method and capability does dsh advertise for reopening a session, at a pinned version? dsh
   `0.2.1-rc.2` advertises `sessionCapabilities` `{close, list, resume}`, without `loadSession`, and reopens with
   `session/resume` (section 8). This was observed with a stand-in model, not a real one.
2. **For the dsh maintainer:** can dsh's ACP profile run with tools off? A first journey that needs no permission
   answers is the simplest to check.
3. **For OpenRig:** should a later version route permission requests to a chosen seat, as `rig acp run` already does
   with queue tasks? 0.7.8 routes them to the default person, or to a person chosen for the seat (section 7). A chosen
   seat is still open.
4. **For OpenRig:** once a second ACP harness exists, should one shared ACP runner live in OpenRig rather than one per
   harness?
