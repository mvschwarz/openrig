# Harness and runner contract (DRAFT, published with 0.7.6)

> **Status.** This is a draft for contributors.
> - **Released in 0.7.6:** the `runner` field and OpenRig's side of declaration, identity and activity
>   (sections 2-4).
> - **Released in 0.7.8:** seat activity grants (section 4), and OpenRig's side of the answered permission path
>   (section 7).
> - **Runner-author behavior, not yet qualified:** the input, cancellation and permission recipe in sections 5-7, and
>   the runner-side shutdown obligation in section 9. A dsh port implementing this recipe is not qualified.
> - **Existing interfaces with author obligations:** launch-result identity, exact resume, first input and model
>   handoff. These interfaces do not establish that a particular runner implements them correctly.
> - **Unchanged:** plain community presets and the built-in runtimes (Claude Code, Codex, Pi, OMP, terminal).
>
> No harness has been run end to end under this contract yet, and the native verdict is pending. The first candidate
> is dsh over ACP.
>
> Release status and pinned references are in the [joined author guide](author-contracts.md). The
> [community presets reference](community-harness-presets.md) describes the implemented fields, including the runner
> preset's exception for approvals; this chapter also labels runner-author behavior that isn't qualified.

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

## 6. Cancel: requested isn't the same as done

- **On `/abort` or Ctrl-C:** send the agent's cancel (for ACP, the `session/cancel` notification, which has no reply),
  and record when you sent it.
  - A person cancels by typing `/abort` in the seat's pane. A `/abort` sent with `rig send` arrives inside a From/To
    envelope, so it's an ordinary prompt.
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
| **No one can be asked** | **Permitted at once**, with the agent's own allow option. No ask is opened. That covers: no registered person; several and none the default; the chosen person no longer registered; the people unreadable; or options a person can't be shown (bad ids, or not 2-4). The agent's `allow_once` is used, else its `allow_always`. If the agent offers only `allow_always`, the harness then remembers a permission nobody chose. |
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
| closes it without choosing: drop, approve, or other typed words | no answer, so the default applies: **permitted** with the agent's allow |
| doesn't answer | the request **stays pending and visible** (the seat reads needs input) until the agent's turn ends. It's never timed out into a grant. |

- **An answer reaches only the live request it was asked for,** once. A request from an earlier occupant reads
  `stale`, and one withdrawn at the turn's end reads `withdrawn`. Neither can take a later answer.
- **Text typed into the runner's pane, an agent's own text, and `rig send` are never an answer.** While a request waits
  on a person, the seat reads needs input, and sends are normally refused. A send that does get through reaches the
  agent as a prompt.

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
     answered in words that were neither a choice nor a plain yes or no. It never changes the outcome.
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
| `activity_grant_revoked` | 401 | The grant was revoked while its launch generation still occupies the seat, or before it has registered, so this may still be the live request; a replaced occupant's grant reads `activity_grant_stale` instead, even once revoked. | permits |
| `activity_grant_pending` | 409 | The grant's launch hasn't registered its occupant yet. | permits |
| `duplicate_request` | 409 | This request id was already submitted in another turn; an agent may reuse an id. | permits |

**When the runner can't get an answer from OpenRig,** nobody can be asked, so it permits with the agent's own allow
option: `allow_once` when offered, else `allow_always`. Prefer `allow_once`, so the harness doesn't remember a
permission nobody chose. That covers:
- an OpenRig without this path, which answers 404;
- an OpenRig the runner can't reach, at submit or while reading (a runner may retry a read that got no answer a few
  times first);
- a refusal the table marks "permits", and any status or code this section doesn't list.

**Limits in 0.7.8:**
- **The answer owner is a registered person.** Choosing a seat (another agent) to answer is a later change.
- **A colleague's answer is followed on this host.** If the ask is handed to another host, the request waits, shown as
  needs input, until the agent's turn ends.
- **An override or `--deny` is set with the command above, never in a rig spec.** A spec field is a possible later
  change.
- **Permits and answers aren't recorded beyond the runner's pane and the ask itself.** A permit with no one to ask
  opens no ask.

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
