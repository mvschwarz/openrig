# Runner conformance check

A runnable check for runner authors. Point it at your runner and it reports which promises of the
[harness and runner contract](../harness-runner-contract.md) your runner keeps. It needs Node and tmux, and no OpenRig
daemon, model, credentials or network.

```sh
node check-runner.mjs --runner 'my-runner --agent-command {agent}' --name my-harness --resume --first-input
```

- **`{agent}`** is replaced with the path of the fake ACP agent beside this file. Your runner starts it where it would
  start your real agent. It accepts any arguments your runner adds.
- **`--name`** is your preset's name, which your posts carry as `runtime`.
- **`--resume` and `--first-input`** say your preset declares `resume: true` and `first_input: true`. Without them,
  those cases are skipped, because OpenRig wouldn't pass that input.
- **`--answered`** says your runner implements section 7's answered path (0.7.7), asking the person the seat's operator
  chose. Without it, case 4b is skipped.
- **`--cases 2,4`** runs only some cases. `--json` prints a machine-readable report. `--keep` keeps each launch's
  folder: the agent's message log, the launch record and the scenario.
- **`--wait-ms 20000`** waits longer for each step (default 8000), for a runner whose agent takes a while to start. The check's shorter settling times grow in proportion.
- **`--pass-env NAME`** passes one more variable through. Otherwise the runner gets only `PATH`, `HOME`, `USER`,
  `SHELL`, `LANG` and `TMPDIR`, plus the OpenRig variables.
- **The exit status** is 0 when nothing fails, 1 when a case fails, and 2 for a usage or setup problem. An advisory result (7c) never changes it.

In an installed OpenRig, the check is at `$(npm root -g)/@openrig/cli/daemon/docs/reference/runner-conformance/`.

## How it runs

- **Your runner** starts in a private tmux server, with the environment a runner-preset launch gives it:
  `OPENRIG_URL`, `OPENRIG_ACTIVITY_HOOK_TOKEN`, `OPENRIG_SESSION_NAME`, `OPENRIG_NODE_ID`, `OPENRIG_RUNTIME`,
  `OPENRIG_OCCUPANT_GENERATION`, `OPENRIG_LAUNCH_RESULT` and `OPENRIG_LAUNCH_ATTEMPT`, plus `OPENRIG_RESUME_REF` or
  `OPENRIG_FIRST_INPUT` when a case needs them. `OPENRIG_HOME` is an empty folder, so nothing reaches a real OpenRig.
- **The fake agent** speaks ACP v1 over stdio. Each case gives it a scenario, such as a slow handshake, a permission
  request, a turn that ends cancelled, or an exit mid-turn. It logs every message in both directions. Its own request
  ids are numbers, as JSON-RPC agents commonly use.
- **A local endpoint** stands in for `POST /api/activity/hooks`. It records each post, and refuses one without the
  launch's bearer token, as OpenRig does.
  - **In case 4b,** it also stands in for the answered path's three routes: submit, read with `waitSeconds`, and withdraw.
    It checks a submit the way OpenRig does: the seat and generation, `nativeRef`, `turnId` and `requestId` as non-empty
    strings, and 2-4 answerable options. Each launch scripts the answer or the refusal it gives.
  - **Elsewhere,** those routes answer 404, as an OpenRig without the answered path does, so the runner refuses as in
    case 4.
- **Input arrives the way `rig send` delivers it:** the text is pasted as one bracketed paste with raw newlines, then
  Enter is pressed. Ordinary messages carry a From/To envelope.

## The cases

| Case | Contract section | What it checks |
|---|---|---|
| 1 | 3 | No launch record until `session/new` is answered. Then a record holding format 1, this attempt, the preset's name, the agent's conversation id and a `producer` |
| 1b | 3, 4 | A handshake that fails at `initialize` or `session/new` (an error or an exit) writes no conversation in a launch record, and posts no accepted prompt or idle report |
| 2 | 5, 6 | One pasted block becomes exactly one `session/prompt`, byte for byte. A line reading `/abort` inside a block isn't control. A block sent mid-turn waits for the next turn. A block that is exactly `/abort`, or Ctrl-C outside a paste, sends one `session/cancel`. `Stop/cancelled` is posted only when the agent itself returns `cancelled` |
| 3 | 4 | `UserPromptSubmit/accepted` with a `turnId`, then `Stop/end_turn`. Every post carries the contract's fields, the hook token, this seat's identity and a rising `sequence`. `livenessSeconds`, when given, is from 1 to 3600 |
| 4 | 7 | A permission request is answered at once, with a refusal and never an allow option. `Notification/permission_prompt` is posted, and the pane shows what was asked. No idle `Stop` or beat is posted while that attention is held. The next prompt is accepted as usual |
| 4b | 7 | **With `--answered`.** The live request is submitted with the hook token, its `requestId` as the agent's JSON-RPC id in string form, the accepted prompt's `turnId`, this conversation and generation, and the agent's options as offered. The runner doesn't post `permission_prompt` itself for a created ask, and each read waits at most 25 s. The chosen option, allow or deny, reaches the agent once, and the turn then reports as usual. An option the request didn't offer, a refused, stale or withdrawn ask, and each refusal at submit (`route_unsupported`, `options_unsupported`, `duplicate_request`, `stale_generation`) all give the agent `cancelled`, never an allow option, and hold attention; after a refusal at submit the runner posts `permission_prompt` itself. With no answer, the request stays pending with no idle report, and a pasted message isn't an answer. `/abort` withdraws it with `turn_cancelled`, and an answer after that isn't delivered. A turn's end or the agent's exit while it waits withdraws it with `turn_ended` or `exited` |
| 5 | 4 | Every post carries `OPENRIG_OCCUPANT_GENERATION` |
| 6 | 8 | A resume asks the agent to reopen `OPENRIG_RESUME_REF` in the launch's working folder, and records that conversation. The agent's own not-found becomes `error: "missing"`. Any other failure is neither missing nor resumed. No case starts a new conversation |
| 7 | 4 | An agent that dies mid-turn gets `Stop/<preset>_exited`, and no idle report after it |
| 7b | 4 | A failed `session/prompt` posts `Notification/runtime_error`, not a permission request |
| 7c | 9 | **Advisory.** Closing the pane ends the agent process. Section 9 marks this duty as proposed, and lets a runner list in `limits` what may keep running, so this result is shown as met or not met and never counts as a pass or a fail, or toward the exit status. The fake agent outlives a hangup here, so the runner has to end it |
| 8 | 7 | An unknown request from the agent gets JSON-RPC `-32601`, and the next prompt still goes through |
| 9 | 9 | `OPENRIG_FIRST_INPUT`'s exact bytes, newlines and spaces included, are the first prompt |

## What it doesn't check

- **How OpenRig reads your posts:** working, idle, needs input, unknown after an exit, a send refused while a
  permission waits, and an earlier generation not counting. That's OpenRig's side of the contract, and its own tests
  cover it.
- **Your real agent:** a passing check isn't a run with your agent. Section 10's real check, with your agent under a
  runner preset, is still the useful evidence. Passing this is evidence for the versions you ran, not certification.
- **The model handoff:** `OPENRIG_MODEL` is mapped to your harness's own setting, with no wire this check can see.
- **A resume for a preset without `resume`:** OpenRig doesn't pass `OPENRIG_RESUME_REF` to it.
- **Restarting the agent after a failed handshake:** the contract doesn't rule on that.
- **The chosen person's side of an ask:** who may answer, the Feed and Slack, and refusing another person's click or typed
  words are OpenRig's side, and its own tests cover them. Routing an ask to a seat is a later change.
