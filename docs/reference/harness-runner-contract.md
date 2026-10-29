# Harness and runner contract (DRAFT for 0.7.6)

> **Status.** This is a draft for contributors.
> - **In the 0.7.6 candidate, not yet released:** the `runner` field and OpenRig's side of declaration, identity and activity
>   (sections 2-4).
> - **Proposed runner-author behavior:** the input, cancellation and permission recipe in sections 5-7, and the
>   runner-side shutdown obligation in section 9. A dsh port implementing this recipe is not qualified.
> - **Existing interfaces with author obligations:** launch-result identity, exact resume, first input and model
>   handoff. These interfaces do not establish that a particular runner implements them correctly.
> - **Unchanged:** plain community presets and the built-in runtimes (Claude Code, Codex, Pi, OMP, terminal).
>
> No harness has been run end to end under this contract yet. The first candidate is dsh over ACP.
>
> Candidate scope and pinned references are in the [joined author guide](author-contracts.md). The
> [community presets reference](https://github.com/mvschwarz/openrig/blob/b6bd4633fbd94634a2b4bdef2574a6880f97be63/docs/reference/community-harness-presets.md)
> describes the implemented fields at that base; this chapter also labels proposed author behavior.

This chapter covers **which agent runs in a seat and how OpenRig talks to it**. *Where* that agent runs (a host, a
sandbox, another machine) is the [execution platform chapter](execution-platform-contract.md). The two are separate on purpose:
the same harness can run in many places, and one place can host many harnesses.

## 1. Plain preset or runner preset?

| | Plain community preset | Runner preset (`runner: true`) |
|---|---|---|
| **What runs in the pane** | The harness's own terminal app | A small program you maintain, *the runner*, which hosts the agent (for example an ACP agent over stdio) |
| **How OpenRig reads activity** | From the screen: a changing screen reads working; a quiet one reads **unknown**, never idle | From the runner's reports: working, idle, needs input |
| **How input arrives** | Typed into the app's prompt | Typed into the runner, which turns each submitted message into one agent prompt |
| **Choose it when** | The harness has a usable terminal UI (Cursor, Hermes, OpenClaw examples) | The harness speaks a protocol rather than a screen (ACP, JSON-RPC, stream-JSON), or you can report turn boundaries reliably |

**If your harness works well as a terminal app, a plain preset is enough. Use a runner only when you can report state
honestly.** A runner that guesses is worse than a quiet screen read as unknown.

**Vocabulary.** "Preset", "runner preset", `launch_result`, `resume`, `first_input` and `passes_model` are existing
terms at the candidate base. Broader names you may see in design discussion, such as *HarnessSpec*, are **proposals**, not file
formats or loaders that exist.

## 2. Declare it: what the preset says, fixed at launch

```yaml
# $OPENRIG_HOME/community-harnesses/dsh.yaml
format: 1
name: dsh
command: dsh-seat              # your runner; it starts the agent itself
maintainer: <you>
runner: true                   # in the 0.7.6 candidate
launch_result: true            # required with runner
resume: true                   # only after you've checked a real reopen and a refused missing one
limits:
  - permission requests are refused (first version)
  - a prompt whose whole text is /abort can't be sent
  - fork unsupported
```

- **`runner: true` requires `launch_result: true`,** and can't be combined with `names_conversation`.
- **The declaration is fixed at launch.** Each launch, a restore's included, records what the preset declares at that
  moment. Editing the preset changes the next launch, not a running seat.
- **A preset without `runner` behaves exactly as today,** and so does a session recorded before the field existed.
- **The other fields keep their existing meanings:**
  - `first_input: true` passes the seat's first startup turn in a file named by `OPENRIG_FIRST_INPUT`;
  - `passes_model: true` passes the seat's declared model as `OPENRIG_MODEL`.

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

Post each event to `POST <base>/api/activity/hooks` with `Authorization: Bearer <token>`.
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
| You refused a permission request (section 7) | `Notification` / `permission_prompt` | needs input |
| The turn ended | `Stop` / its stop reason (`end_turn`, `cancelled`, `max_tokens`, `refusal`) | idle. While you hold attention (section 7), don't post it: OpenRig reads any non-exit `Stop` as idle and clears needs input |
| Optional idle heartbeat | `Stop` / `idle_heartbeat`, with `livenessSeconds` | idle while beats keep coming |
| The agent process ended | `Stop` / `<preset name>_exited` | unknown, **never idle** |
| Your runner or the agent hit an error | `Notification` / `runtime_error` | recorded, but not used as activity: the prior activity evidence keeps its usual lifetime. It doesn't itself request or clear attention |

- **Liveness:** state `livenessSeconds` (a whole number of seconds from 1 to 3600; any other value is ignored) on every
  idle `Stop`, the turn's end as well as each beat. OpenRig stops reading the seat idle after 2 × `livenessSeconds` without
  a newer idle report. Without it, an idle report holds until your next post, even if your runner has died. Never send a
  non-exit `Stop` or a beat while holding permission attention.
- **Exit:** post `Stop` / `<preset name>_exited` only when you observe the agent's process exit.

- **The screen still counts,** but only as evidence of work. On its own it never reads a runner seat idle.
- **"Accepted" means your runner submitted its Nth prompt.** It isn't the agent's own acknowledgement, and it isn't
  tied to a particular `rig send`.
- **The generation attributes a post; it isn't authentication.**
  - A post carrying an earlier occupant's generation never counts for the live seat.
  - The hook token is one local token, so any process holding it can post for any seat.

## 5. Input: one submitted message is one prompt

Sections 5-7 specify the proposed first dsh/ACP runner recipe. They do not change permission or input handling in
existing built-in runtimes or require every possible runner protocol to use ACP.

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

## 6. Cancel: requested isn't the same as done

- **On `/abort` or Ctrl-C:** send the agent's cancel (for ACP, the `session/cancel` notification, which has no reply),
  and record when you sent it.
- **Report "cancelled" only when the agent says so:** for ACP, when `session/prompt` returns `stopReason: "cancelled"`.
  Then post `Stop` / `cancelled`.
- **Whether the provider stopped work or spend is unknown.** Don't claim it.

## 7. Permissions: refuse every request (first version)

- **Refuse at once:** answer every permission request immediately with a refusal (for ACP,
  `{"outcome": {"outcome": "cancelled"}}`).
- **Make it visible:** show what was asked in the pane, and post `Notification` / `permission_prompt`.
- **Hold that attention** as your last post through the end of the turn, so the seat reads needs input. Don't post the
  turn's `Stop` or idle beats while holding it.
- **It clears** when your next prompt is accepted, or when an operator clears it
  (`rig seat clear-attention <session> --reason "…"`).
- **Never leave a request pending.**
- **Not in the first version:**
  - answering from the seat's permission setting;
  - answers typed into the pane;
  - routing an approval to another seat.
  - So a job that needs an edit or a command approved can't finish under this version. Agents that can run without
    asking are the best first case.
- **Unknown requests from the agent:** answer with JSON-RPC `-32601` and carry on.

## 8. Resume: exactly the same conversation, or say honestly that you couldn't

- On a resume, OpenRig passes the conversation to reopen in `OPENRIG_RESUME_REF`. Use the method your agent
  advertises: ACP's `session/load` (capability `loadSession`), or your agent's own reopen method, named with its
  capability and pinned version in your `limits`.

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
  - **Your own tests** should run against a fake agent that covers each section above.
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
- [ ] Every permission request is refused at once, shown, and held as needs input until the next accepted prompt.
- [ ] An agent exit posts `Stop` / `<preset name>_exited`, never a plain idle.
- [ ] A resume reopens the exact conversation. It reports `missing` only on the agent's word, and otherwise leaves it
      unconfirmed.
- [ ] Unknown agent requests get `-32601`.
- [ ] `limits` names the input limits, the permission limit, what keeps running after a stop, and anything not supported.

## Open questions

1. **For the dsh maintainer:** which method and capability does dsh advertise for reopening a session, at a pinned
   version: `session/load` with `loadSession`, or `session/resume`?
2. **For the dsh maintainer:** can dsh's ACP profile run with tools off? A first journey that needs no permission
   answers is the simplest to check.
3. **For OpenRig:** should a later version route permission requests to a chosen seat, as `rig acp run` already does
   with queue tasks, instead of refusing them?
4. **For OpenRig:** once a second ACP harness exists, should one shared ACP runner live in OpenRig rather than one per
   harness?
