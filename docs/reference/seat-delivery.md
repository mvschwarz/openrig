# Per-seat terminal delivery

The typing guard has seven modes. `off` and `hold` are the two ends. Draft-aware adds an
opt-in check for unfinished input without a second control or daemon-owned retry
scheduler. Between off and hold, four interruption levels choose which automatic messages may
type: `openrig-urgent`, `urgent-only`, `sends-only` and `queue-only`. Sibling seats keep their own mode.

| Mode | Terminal input | When input is unavailable |
|---|---|---|
| `off` (default) | Existing delivery and prompt checks | Existing send result |
| `draft-aware` | Paste into a recognized empty composer; check ownership again before Enter | Hold input and retain this attempt for inspection when bookkeeping is available |
| `openrig-urgent` | OpenRig's own messages (watchdogs, scheduled wakes, notices) and anything marked urgent type, never over a draft | Other agents' messages are held, the sender is told, and held messages stay readable |
| `urgent-only` | Only messages marked urgent type (`rig send --urgent`, `urgent: true` on `POST /api/transport/send`, or a queue item at priority urgent or critical), never over a draft | Everything else is held, the sender is told, and held messages stay readable |
| `sends-only` | Deliberate sends from people and agents type, as with `off`; a terminal member's typing isn't protected, because its shell input can't be read | OpenRig's own notices are held. A terminal member defaults to this level |
| `queue-only` | For a seat a person types in. Deliberate sends from people and agents type, urgent or not, never over a draft; OpenRig's own notices never type, urgent ones included | A watchdog reminder reaches the seat's queue instead (below); other notices from OpenRig are held with their urgency, and held messages stay readable |
| `hold` | No automatic terminal input, even at an empty prompt | Retain for inspection outside the pane |

For a Claude seat you type in, the opt-in [hook bridge](#claude-hook-bridge-opt-in) can deliver ordinary messages at a turn boundary without typing into its input box; it takes effect at the next launch or restore.

Lifecycle work is refused at `openrig-urgent` and `urgent-only`, as at `hold`. At `queue-only` it goes ahead: the
level only changes how OpenRig's notices reach the seat, so managed compaction and its restore still run there, and the
seat still compacts when its context runs out. Each write they make is checked as at `draft-aware`, so it never types
over a person's draft or an input it can't read (it waits for a later attempt), but an active seat isn't refused the
way `draft-aware` refuses lifecycle work. Binding reconciliation stays refused, as at every level but `off`.

At `queue-only` a watchdog reminder never types. One about the seat's parked rows (a park timer, a wait, a
`--wake-watchdog` attachment) is noted on each row of the seat whose current park that job wakes, with the reminder's
own text unless it is the park's default wake (`park wake noted on this row: …`). The note is written before the
delivery is recorded; a row that left its park meanwhile isn't noted, and the reminder stays due. A row of another
seat attached to the same job gets its usual park record, naming what the reminder became. Any other reminder becomes
one cold row in the seat's queue, from `watchdog@system`, tagged `watchdog`, `queue-only` and `watchdog-job:<job>`,
created with no nudge; its id comes from the reminder's occurrence. A later occurrence of the same job, or a retry,
while that row is still open (pending, or claimed and not yet closed), is recorded on it rather than making a second
row; once it's closed the occurrence gets a new row with a derived id (`<id>-2`, `<id>-3`, …), never the closed one. A
cold row wakes nobody: a person, or the seat's next ordinary turn, picks it up, and its waiting view says so, with no
timed sweep promised. The stuck sweep doesn't report it as
unclaimed, nor a wait whose notice was noted or queued as unconsumed. The parked-owner reminder isn't typed either
(the seat's open rows already are the reminder): it's skipped, recorded once on the row as `parked-owner wake held: …;
code queue_only_seat`, and stays out of the job's history until the seat's open rows or occupant change. An idle seat
isn't woken for a pending gate row either. The job's history records these with the outcome `sent` and the status
`queued_as_row`, `noted_on_parked_row` or `noted_on_queued_row`, never `ok`: in the queue, not typed. Wakes of rows
that agents and people create and send are deliberate sends: they type, never over a draft. Wakes of rows OpenRig
creates are OpenRig's own and are held. An older daemon reads `queue-only` as `hold`, lifecycle work included.

A terminal member (`runtime: terminal`) defaults to `sends-only`, which holds OpenRig's own notices. Set one
to `off` and those notices, such as park reminders and other watchdog messages, type into whatever the pane
is running, and a shell prompt runs each line as a command, From and To lines included: OpenRig doesn't check
a terminal pane's foreground process. `openrig-urgent` and `draft-aware` type only into a recognized empty agent composer, so
a shell prompt holds them. Keep the default for a seat that may fall back to a shell.

Runtime permissions are separate. Recipient and interactive-prompt checks still
apply. `--raw` and `--force` do not bypass the typing guard. A deliberate
`--dangerously-interact --reason` remains available in every mode, `hold` included,
and uses the existing-input check below. Direct human input remains available.

An ordinary `rig send` types the message inside its From/To envelope, whose first
line is `From:`, so a message that starts with `/` stays literal text rather than
running as the agent's slash command. `--raw` and `--dangerously-interact` type the
exact text, with no envelope. Claude Code (2.1.322) turns a pasted tab into four
spaces, so tabs reach a Claude Code seat as spaces.

A message sent to a busy Codex seat joins its running turn and may redirect it.
For separate work, create a queue row instead:
`rig queue create --destination <seat> --summary "<one line>" --body-file <file>`.
A row that's saved keeps the work apart from its wake, the short pointer typed
into the seat. The wake is still typed input, and it isn't proof that the seat
claimed or finished the work: the row's state says that.

`rig send <seat> "<message>" --wait-for-idle <seconds>` suits a sender who
watches the result. If the seat is still busy, or its activity is unknown, when
the wait ends, nothing is sent (exit 1, "No text was sent.") and OpenRig keeps
nothing to send later.

## Configure and inspect

### Latest permission observation

`rig seat status <seat>` can show the latest observed harness permission request,
with a fixed tool descriptor, source time and actor category. This is one latest
observation across actors, not an aggregate of pending prompts. `request_observed`
leaves the displayed actor's pending state unknown. `completed` applies only to
that actor's later tool batch; other actors' pending state is still unknown. An
unavailable observation proves neither a permission stop nor the absence of a
waiting native prompt. With no observation, human status omits this section;
JSON keeps the explicit unavailable state. The JSON field is `permission_stop`,
and its `pending` value has the same observation-only scope.

An observation may also carry Claude's **suggested rules** as `suggested_rules`.
These are read-only evidence, not applied or approved, not guaranteed effective,
not the exact command, and not a complete list of dialog options. The supported
subset of [Claude's permission update schema](https://code.claude.com/docs/en/hooks#permission-update-entries)
is `addRules`, `replaceRules` and `removeRules`, preserving type, ordered rules
(`toolName`, optional `ruleContent`), behavior and destination exactly. Strings
are neither trimmed nor broadened; absent `ruleContent` remains distinct from
an empty string. Mode/directory updates and malformed entries are withheld.

The envelope distinguishes a missing native field from a present empty array;
`unsupported` and `size_cut` mark incomplete evidence. An older relay without
this field, or a failed formatter, is unavailable rather than proof of native
absence. Bounds are eight entries, sixteen rules per entry, 128 UTF-16 code
units per tool name, 2,048 per rule-content string, and 16,384 UTF-8 bytes of
serialized evidence. Oversized whole entries are dropped with `size_cut`,
never shortened into different plausible rules. Both producer and ingress
validate these bounds independently. Terminal JSON escapes controls and
nonprinting format/separator characters while preserving decoded string values;
its representation can expand, so the byte bound applies to stored/transported
evidence, not the entire formatted status output.

**Suggested rule strings can contain sensitive values.** The relay sends only
this bounded rule subset alongside the fixed descriptor. Rule content can itself
contain sensitive command-like text; raw `tool_input`, arguments outside that
suggestion, and provider reasons are not forwarded. It posts to `/api/activity/hooks` at the
configured `OPENRIG_URL` (or host/port), or the discovered endpoint in
`OPENRIG_HOME/activity-endpoint.json`. Both `GET /api/seat/status/:seatRef` and
`GET /api/seat/status/node/:nodeId` can return the evidence. The daemon adds no
event, log, queue or telemetry persistence for it; a caller can still capture
status output in a transcript or file. Evidence shares the observation's
five-minute lifetime and existing seat/actor limits, is discarded lazily on the
next observation/status read after expiry, and is lost on restart. No rule,
permission/configuration write, hook decision, edited input, prompt submission
or new attention or delivery behavior is produced. Its one other use follows.

**Send context.** When a direct send starts and the seat's main session has a
request newer than its latest activity hook, not yet settled by that session's
later tool batch, the send's result carries an `inputRequest` notice saying so,
and `rig send` and `rig broadcast` print it. The send goes exactly as it would
without the request: the notice changes no readiness, refusal or timing, and a
prompt answer (`--dangerously-interact`) gets none. The request isn't evidence
that a dialog is open: a hook or host can decide a permission request, or
answer an MCP elicitation, with nothing displayed, and the notice says so. A
subagent's request, a settled or expired observation and a replaced occupant
give no notice. Claude's `Elicitation` hook works the same way, settled by
`ElicitationResult` or a later tool batch. Neither event changes activity or
attention, and only the actor and time are kept: no server message, form field
or response.

Actor attribution is a convention derived from the [Claude hook schema](https://code.claude.com/docs/en/hooks#common-input-fields): an omitted or null `agent_id`
is treated as main, a valid ID identifies a subagent or in-process teammate, and
an invalid ID is dropped rather than inferred as main. The fixtures are synthetic;
no live PermissionRequest capture qualifies that convention on an installed native
version. A hook denial without a source-bound guard receipt has unknown origin.
This diagnostic adds no guard collector, permission decision or attention policy.

The PermissionRequest diagnostic and the `Elicitation`/`ElicitationResult` pair
are optional for activity-hook readiness.
Every preexisting required event, relay asset and explicit hook-disable check
still applies. An older installed plugin at the same manifest version retains
its bytes and may not send these events: plugin-only delivery needs a future normal
maintainer release refresh, and managed delivery needs normal reprojection. A
manifest or green readiness check does not prove live hook execution. Raw tool
arguments and provider reason text are withheld; diagnostic evidence is bounded,
memory-only and expires after five minutes.

### Who may intervene

`rig seat status <seat>` shows the seat's terminal interaction account alongside
its native permissions and interruption level. These choices are independent.
The presets `no-peer-interventions`, `help-within-instructions` and `full-control`
set the peer row. Self and OpenRig retain their existing authority unless an
explicit exception changes it. Named helpers and the delegating instruction are
shown; OpenRig does not interpret free-text instructions as executable rules.

~~~sh
rig seat set-terminal-policy reviewer@my-rig --preset help-within-instructions \
  --helper lead@my-rig --peer-model deny \
  --reason "Help with compaction; keep the review model"
rig seat status reviewer@my-rig
~~~

Each `--peer-compaction`, `--self-compaction`, `--openrig-compaction`,
`--peer-model`, `--self-model` or `--openrig-model` exception takes `allow` or
`deny`. Model includes reasoning effort. Exceptions apply to the whole actor
row: `--peer-compaction allow` also allows unnamed peers. A choice with
exceptions reads as Custom. The setter replaces the complete choice; omit
exceptions to return to the preset's defaults. Outside a managed seat, use `--operator <address>` for
audit attribution. This does not establish an authenticated identity.

Enforcement covers managed compaction and saved model/effort changes only.
The latter take effect at the next managed continuation, not in the current
process. Other interventions remain guidance-only. Managed compaction applies
to Claude seats; it is not offered for Codex or Pi. A policy change during
preparation is checked before further input. It does not undo a submitted
`/compact` or abandon an already-owed restore/audit.

Existing seats retain current behaviour on upgrade. To choose a default for
newly added seats in a rig, add `--rig-default` to the setter above: existing
seats keep their own copied choices. OpenRig's standing managed-compaction
authority stays active unless its exception is deliberately changed.

Caller attribution is cooperative. An unattributed caller retains current
behaviour rather than being labelled the person or a peer. The existing
`rig send --dangerously-interact --reason` path remains available; this policy
adds no restriction there. Its existing-input check applies independently of the
typing mode. Plain tmux is not prevented.

### Files read during managed restore

A managed restore no longer stops at a permission prompt to read OpenRig's own
role file or other shipped spec files. A role file from your own spec root still
asks.

The launch settings OpenRig builds for a Claude seat allow reading its restore
files. They also allow reading Markdown files under the installed daemon's own
`specs` directory, where a restore map can name a seat's role file. OpenRig grants
the directory both where it's named and where it resolves, when the install uses a
symlink. It doesn't move the files or rewrite saved restore maps.

These allowances are reads only. The seat's native mode and its existing deny and
ask rules still apply, and custom spec roots aren't included. A Claude seat that's
already running gets this at its next fresh launch, resume or fork. A continuation
that keeps its captured native arguments keeps the earlier allowances.

### Deliberate interaction and existing input

A managed `rig send <seat> "<answer>" --dangerously-interact --reason "<why>" can
drive a recognized native menu as before. Otherwise, with the delivery guard
attached, it reads the visible composer under the seat's lease immediately before
pasting, after buffer preparation. Empty input proceeds. A recognized dim
suggestion is displayed separately and counts as empty; typed or pasted text
(author unknown) stops the send with `override_input_present`: single-send HTTP
409, `sent: false`, and caller-only `existingInput` evidence (visible rows, suggestion
rows, cursor/dimensions and target binding). A collapsed paste shows its label,
not the hidden contents. OpenRig neither holds nor retries this stopped override.

An input that can't be read doesn't stop the override. The answer is typed and
nothing is cleared. The result reports `existingInput` with classification
`unreadable`, never empty, and a warning that the answer may join or submit
existing text.

Inspect the shown input in the native terminal, deliberately clear the prompt with
native/tmux controls, then issue the send again. Manual clearing runs outside
OpenRig's lease and observation checks and is not recorded. For a deliberate
unchecked write, add `--type-without-checking` to that same command. It skips the
read and does **not** clear input: the text may join or submit what is already there.
The result names that choice. It requires `--dangerously-interact` and `--reason`.

Observed input is returned only to the caller, never saved in an outbox, held
message, capture-observer record or override audit. The audit keeps classifications,
counts and the choice, without input contents. The lease serializes OpenRig writes;
human typing can still race the capture and paste. Ordinary sends and wakes keep
their existing behaviour.

### Terminal delivery

`rig seat set-typing-guard` works from an ordinary terminal as well as from a
seat's shell. The daemon takes the recorded actor from transport identity only:

- From a managed seat's shell (`OPENRIG_SESSION_NAME` set), the preference and
  its audit entry name that seat.
- From a terminal with no seat identity, the change applies the same way, and
  the preference and its audit entry record the actor as
  `unattributed (no seat identity)`.

Neither case takes an actor from the request body or from the target seat's name.
`rig seat retire-held-message` uses the same transport-derived attribution: a
managed seat's identity, or `unattributed (no seat identity)` from an ordinary
terminal. Its actor never comes from the request body or the target's name.
A reason is required. Retirement only frees active quota and preserves evidence;
it does not deliver the message, claim native consumption or close work.

~~~sh
rig seat set-typing-guard dev-impl@my-rig --mode draft-aware \
  --reason "preserve my unfinished input"
rig seat status dev-impl@my-rig
rig seat held-messages dev-impl@my-rig --json
rig seat held-messages dev-impl@my-rig --id <outbox-id> --json
rig seat retire-held-message dev-impl@my-rig <outbox-id> --reason "read outside the pane"
~~~

Use exactly one of `--mode off|draft-aware|openrig-urgent|urgent-only|sends-only|queue-only|hold` or the compatible
`--enabled true|false`: true selects hold, false selects off. There are no
retry settings or deadlines. Activation waits for an already-started seat operation
to finish. The API may return HTTP 202 with `pending: true`; wait for
`pending: false` before relying on the requested mode. Status reports desired
and effective modes and retains the text `Typing guard: on (hold)` for hold.

A held send immediately returns `outcome: "retained"`, `sent: false`, its exact
reason and the saved attempt's `outboxIds`. No automatic
retry is scheduled, except for a message held only for a draft (see "Messages held
for a draft" below). `rig send` to several seats and `rig broadcast` print a held
recipient as `retained, not delivered; inspect with rig seat held-messages`, never
as sent, and their summary adds the held count (`1/3 delivered, 1 held`). A held
recipient alone doesn't make the command fail. The reasons are:

- `typing_guard_enabled`: the seat's mode holds this send (`hold`, or a level that
  holds this kind of message).
- `runtime_switch_in_progress`: the seat is switching runtime.
- In `draft-aware` mode, a refusal before any input was written:
  `draft_input_busy` (the input holds unsubmitted text), `draft_input_unknown` (the
  input can't be read), `draft_input_changed` (the input or its target changed during
  the delivery), `draft_wake_superseded`, `target_needs_input`,
  `wait_for_idle_timeout`, `target_activity_unknown`, `target_runtime_unverified`,
  `target_runtime_not_running`, `target_runtime_conflict`, `invalid_wait_for_idle`,
  `invalid_dangerously_interact`, `dangerously_interact_requires_reason`,
  `prompt_override_audit_unavailable`, `transport_unavailable`, `session_missing` or
  `tmux_unavailable`. Each explicit draft-aware request is a new attempt, including
one with a reused `deliveryId`; the result warns older callers that this field no
longer deduplicates input. The CLI does not generate a deduplication key.

The last recorded managed-compaction input refusal appears as `inputReadFailure` in the attempt
record and `rig compact --state`: the preparation or compact stage, `composer`
(the explicit composer hold) or `draft-aware` check, reader status, confidence,
a fixed read-failure reason and cursor flags. An owed restore step reports it in
`owedRestore.lastDelivery`. These fields contain no input text, suggestions,
terminal frames or exception messages. Confidence and timeout fields are `null`
when that reader does not supply them; a known composer read timeout reports
`timedOut: true`. A generic `capture_unavailable` does not identify the failed
capture operation. Older records lack this diagnostic. It neither changes the
refusal nor retries an attempt; missing metadata cannot establish which check
caused a historical refusal.

Clearing a draft, changing modes or restarting does not flush saved messages or
callbacks, except a message held only for a draft (below). To try again, send a current request: it rechecks the recipient and input.
A caller abort before paste cancels input; after a write may have started, the
result preserves that uncertainty rather than claiming nothing was sent.

Bookkeeping is observational. If its write fails, an otherwise valid input attempt
still proceeds and the response includes a warning instead of a saved receipt.
Actual transport success stays success; an unknown write stays unknown. If input
was held and no record could be saved, the response reports failure with `sent:
false` and the protection reason, rather than claiming durable custody.

Reading never sends. Retirement frees that record's active retention quota while
preserving evidence; it does not deliver a message or close queue work.

A seat holds one message per sender, so one sender can't fill its held quota and
drop everyone else's messages. A sender's newest held message retires its earlier
ones at that seat into itself (`retired_by: outbox@system`, reason `coalesced into
<id>`), in every mode, `draft-aware` included, except a message held only for a
draft, which keeps its own outcome (below). The newest names them: `rig seat
held-messages` shows `coalesced: { count, outboxIds }` on it, and each coalesced
record stays readable with `--id`. Held messages are never replayed, except a message
held only for a draft (below), and a `draft-aware` queue wake's bounded retry, below,
delivers only an entry still held, so this changes
no delivery. A `draft-aware` attempt takes its sender's place only once it settles
as held; one that is then delivered leaves the held messages as they are. A queue
wake to a `draft-aware` seat counts its sender's held message there as room, by the
same rule. At a full quota, a sender with nothing held there is still refused, and
nothing from another sender is touched. A committed wake is never refused, and the
sender's next held message coalesces it like any other. A message that settles as
held late, behind a newer held send, folds into that send's newest part and leaves
its other parts held. An urgent message coalesced under a routine one passes its
marking to the newest. Never coalesced: the other parts of the same send, a
watchdog's reminders (one per job), and an unattributed sender.

A backlog held before this change clears at that sender's next held message to the
seat, or at once with `rig seat retire-held-message`.

**Messages held for a draft.** In `draft-aware` mode, a plain message from an agent
or a person that is held only because the input showed a draft (`draft_input_busy`,
`draft_input_unknown` or `draft_input_changed`) is marked when it's first held, and
its result says it goes once the input is clear.

- When the seat is idle with `draft-aware` still on, marked messages are sent oldest
  first, each through the same guarded delivery. That delivery reads the input again
  and holds the message again if it still isn't clear.
- A try runs when the seat's activity changes, and the seat-activity check offers it
  again when the state stays the same: about every 4.5 seconds after a try that met
  recent typing, a drain or a restore, and at once for a newly held message. A draft
  still in the input after two tries waits until the pane changes.
- Each message keeps its own outcome, and the pass stops at the first one that isn't
  delivered, except one whose own paste was just refused, which it goes past (below).
  A delivered or uncertain message is never sent again. A drain, a pending
  restore or leaving `draft-aware` stops the pass until it clears, including one that
  takes effect while the message waits for its turn to type; nothing is typed then.
- Order holds per sender: while a sender's marked message is still owed at the seat
  (held, or being tried again), that sender's later plain message is held behind it
  (`draft_held_behind_earlier`), marked too, and typed after it, even with the input
  clear or with the seat's hook bridge live. Other senders' messages aren't held behind
  it. This holds for messages that are saved with room in the seat's held quota; one
  that can't be saved goes as it would without it.
- A marked message whose own paste is then refused (control characters, a long Codex
  paste, the viewport) is no longer owed: it stays held and readable, its result says to
  send it again changed, and later messages stop waiting behind it: the same pass goes
  on to them.
- A marked message being tried again when the daemon stopped, including one the hook
  bridge had handed back for typing, reads uncertain after the restart: it isn't typed
  again, and later messages don't wait behind it. One that was only queued for the bridge
  stays queued and still owed, and the bridge delivers it (below).
- A message held for an earlier occupant of the seat stays held and listed. Later
  messages for the current occupant still go.
- Marked messages aren't coalesced by the one-per-sender rule above. Instead, one
  sender keeps at most five at a seat. Past that, its oldest is coalesced into the
  newest (`coalesced into <id>`, readable with `--id`), and the sender's result names
  it.
- At a full quota, a new message takes its sender's place as above. A message that
  can't be held at all says the seat's held quota is full.
- Not marked, so held as above:
  - messages held before this behaviour;
  - `hold`-mode messages;
  - other held reasons;
  - queue wakes, which have their own retry;
  - messages from OpenRig's own senders (the daemon, `system:*` actors, watchdogs).
- Leaving `draft-aware` (to `off` or `hold`) leaves marked messages held until it's on
  again.
- Releasing `hold` tells the seat once what was held, with `rig seat held-messages`.
  Nothing held is typed. That notice is one best-effort attempt when the release takes
  effect: a daemon restart before then, or the notice itself being held, leaves no
  notice. `rig seat held-messages` always lists what's held.

### Claude hook bridge (opt-in)

A Claude seat can opt in to receiving messages through its own launch-owned hooks instead of typed input. OpenRig then
doesn't type into the seat's input box or touch a dialog to deliver.

```bash
rig seat set-hook-bridge dev-impl@my-rig --enabled true --reason "wake at turn boundaries"
rig seat hook-bridge dev-impl@my-rig
```

**Who can opt in.** Anyone who can run the command, with a reason. From a terminal with no seat identity, the change is recorded as unattributed, as the typing guard records it.

**When it takes effect.** At the seat's next launch or restore, if its Claude Code is 2.1.287 or later (the first version whose changelog shows the `asyncRewake` hooks; 2.1.306's and 2.1.322's own schemas carry them). An older Claude, or one whose version can't be read, launches unchanged with typed delivery, and `rig seat hook-bridge` says why. The launch adds three hooks to its `--settings`:
- SessionStart and Stop run one waiter for the seat, as `asyncRewake` command hooks. Exiting 2 wakes Claude with the
  waiter's output. The hook timeout is 7200 s.
- UserPromptSubmit runs a quick marker that tells OpenRig a turn started.

The bridge is used only for an occupant launched with it, once its waiter has armed. Until then delivery is typed as before.

**Delivery at a turn boundary.**
- A message to an opted-in seat is queued as an outbox row (result `outcome: "bridged"`). The waiter armed at the last
  turn boundary takes the queued messages, oldest first, and writes them into the seat's context.
- A seat mid-turn, including one at a permission prompt, gets its messages when that turn ends, or after 15 minutes, whichever comes first: a turn that ends without a Stop (an interrupt, an API error), or one running when the daemon restarted, can't hold messages longer than that, even while a waiter polls. That includes a turn the bridge's own wake started: Claude Code reports the woken input as a prompt, and the bridge counts that prompt as part of the same turn.
- Only a plain message is bridged. A send that carries a check or action at the moment of writing (managed compaction's `/compact` and its stages, a parked-owner reminder's checks, staged or exact text, an idle or draft rule), one bound to an original conversation (an expected identity), a slash command, and every watchdog reminder are typed as before, where those checks run. A watchdog reminder stays typed until its receipts can represent a queued message.
- Each poll checks again that the seat is still opted in, that a message was queued for that same occupant, and that the typing guard wouldn't hold it now. A message the bridge can't deliver to this occupant (the seat opted out, or the guard holds it now) is typed at once, with the admission it was queued with, and the guard then decides (a hold retains it). One queued for an occupant who has gone isn't typed (below).
- A message queued for an occupant who has since gone isn't typed into the seat's new occupant: it ends `failed`, with `guard_delivery.state` `not-delivered` and the reason, a `transport.hook_bridge_fallback` event says so, and `rig seat hook-bridge` lists it with its reason. Its sender isn't told; a fresh send reaches the current occupant.
- A send whose id is already settled (delivered, failed, held) isn't queued again or reported queued: it goes on as it would without the bridge.
- What the model receives is each message exactly as OpenRig addressed it (its `From:` line names the sender), after
  one line saying they're ordinary messages that the delivery adds no authority to.

**Handed over is not read or acted on.**
- The waiter's acknowledgement marks the row `delivered`, with `guard_delivery.state` `handed-to-hook`. It wrote the message to its hook's output and is exiting 2. Claude Code reports nothing back, so that Claude read it isn't observed.
- A queue wake records `bridged:queued`, then how it ended at the bridge: `bridged:handed-to-hook`, the typed fallback's own result (so a refusal at a prompt is retried when the prompt clears, as for a typed wake), `failed:hook_bridge_not_delivered`, or `indeterminate:hook_bridge_claimed_unacked`.
- The row's claim and result stay with what the agent actually does.
- A batch whose answer was lost is handed to the same waiter, for the same seat and occupant, again at its next poll, unless the typing guard holds it by then: then it's left `indeterminate` (`claimed-unacked`), never handed out or requeued.
- The waiter acknowledges a batch only once it has written all of it to the hook's output; a write that fails isn't acknowledged, and the batch becomes uncertain as below.
- A batch whose waiter stopped without acknowledging it (its arm replaced, or not polled for 20 s) becomes `indeterminate`, with `guard_delivery.state` `claimed-unacked`. The bridge never resends it: it may or may not have reached the seat. `rig seat hook-bridge` lists those rows, and a `transport.hook_bridge_uncertain` event names each. A queue wake's own recovery may still send it again, saying delivery may repeat: the queue's rule for an uncertain wake.

**When the bridge isn't available** (never armed, expired, or its waiter gone):
- Messages are typed instead, as before, and the sender's result says the bridge wasn't available.
- A waiter is live while it has polled within 20 s and its seat is idle or within 15 minutes of its turn's start; with no waiter polling, while the seat is in a turn the bridge waits on, for at most 15 minutes.
- A new message goes behind messages already queued for the seat, even after the seat opts out, so they're typed in order. A send cancelled while it waits for the seat's lease isn't queued.
- Messages already queued are typed in order, by one sweep at a time (every 5 s) once they've waited 20 s without a live waiter. The sweep takes back each message under the seat's delivery lease, just before typing it; one the bridge took first isn't typed, and nothing behind it overtakes it. A waiter's poll takes the same lease, so it can't take the next message while an earlier one is being typed.
- A daemon restart leaves messages that were only queued for the bridge queued; they aren't marked indeterminate, and the bridge delivers each once, by the rules above: to a waiter at the seat's next turn boundary, or typed after the bound. Restart recovery runs before the bridge's sweep can take one. A batch a waiter had taken before the restart reads uncertain after it, and a message the bridge had handed back for typing isn't sent again.
- A waiter exits by itself shortly before its hook timeout and reports that it expired. The next turn re-arms it.

**What still decides first.** The typing guard: hold and the interruption levels hold or refuse as for typed delivery. A rig's delivery drain holds the bridge's automatic deliveries (queue wakes) as it holds typed ones: while the seat's rig is drained, no waiter takes them and no fallback types them, at any point up to the moment of typing, and they're delivered in their order once the drain ends. A direct send and an explicit queue notification pass a drain, and pass any held wakes, as on the typed path. A queue wake whose row no longer wants it (claimed, closed or moved on) isn't handed over: it ends `failed` (`not-delivered`), as the typed path refuses it. If the drain can't be read, delivery goes ahead and the daemon log says so.
The bridge only replaces how an admitted message reaches the seat. Watchdog reminders and queue wakes take the same path.

**Cost.** Each wake is one model turn on the seat's own login. A burst of messages to an idle seat can cost several.
`rig seat hook-bridge` shows the wakes since the daemon started.

**Scope.**
- Claude Code seats managed by OpenRig. Codex isn't covered.
- Measured on Claude Code 2.1.319 to 2.1.323. Its `rewakeMessage` and `rewakeSummary` fields are internal and unused.
- A guest-only listener doesn't serve the bridge.

## Input evidence and outcomes

The cursor-aware reader lives in `session-transport.ts` and shares the composer
matchers with ordinary delivery. It recognizes framed Claude input and Codex input
with a known footer. The visible input containing the cursor is checked independently
of activity hooks, again after buffer preparation, and immediately before Enter.
Copy mode, an unreadable capture and an unsupported layout cannot authorize input.

The final check preserves authored whitespace: the cursor distinguishes trailing
spaces from screen padding or omitted blank capture cells. A numbered message is
recognized as this operation's own text only within its previously empty composer;
a newly observed numbered menu is still refused. Human edits after paste stay
visible and Enter is refused.

Faint placeholders and autocomplete suffixes are display hints only when the
capture preserves their styling. Typing the same words and moving the cursor to
the start still counts as a draft. Current footer and indentation anchor the
Claude frame, so quoted prompt/frame examples inside a draft do not become proof
of empty input.

A large paste can appear as several labels plus a literal tail. The existing
`hasExpectedStagedText` check validates the tail and the labels' combined source
boundary. That complete rendering must be observed after this operation's paste
and remain unchanged before Enter. Labels alone do not prove arbitrary content.

| Historical delivery state | Meaning |
|---|---|
| `sending` | This saved attempt has an unresolved write outcome |
| `held` | No input was written; this attempt remains retained or has been retired |
| `complete` | Transport execution succeeded, including render verification if requested; native consumption is not asserted |
| `indeterminate` | Input may have occurred or requested render verification failed |
| `failed` | A definite failure before input, such as caller cancellation |

Migration `100_typing_guard_modes` extends the existing guard/audit rows and
adds receipt metadata to the original outbox rows; it creates no tables, retry
indexes or executable requests. Combined wakes retain each original ID and body.
A held queue wake stays on the existing queue recovery path. A row created straight to
a `draft-aware` seat, or handed to it with `rig queue handoff`, is tried again when the
seat next reports idle while it's still in `draft-aware` mode, through the same guarded
delivery and within `queue.wake_retry_cap`. A held wake not tried yet, and each try the guard
held, gets one more offer while the seat stays idle with nothing new to report, so a draft
deleted or left with no report doesn't strand it: after about 4.5 s, and not before the
guard's quiet window for activity at the seat's own terminal has ended. An offer that
couldn't try (a drain, an owed restore, the seat not idle) is offered again later. The
wake ladder doesn't also retry these rows on its own timer; a handed-off row at a seat
that isn't in `draft-aware` mode keeps the ladder's retry.
Switching modes alone replays nothing; a retry already admitted while the seat was
`draft-aware` goes once. Still held past that cap or
`queue.wake_unconfirmed_window_minutes`, or held in `hold` mode past the window, the row
gets the wake ladder's one escalation to its owner and one notice to its sender, once
per held episode. Nothing is typed into the held seat. The sender's notice is recorded in
the outbox (`held-sender-notice-<qitem>-<episode>`) before the owner's escalation is
marked. If the daemon stops before sending it, or the send definitely wrote nothing, it
stays owed, and the ladder sends it on a later tick: a failed one after the retry
interval, up to the retry cap. One that may have reached the sender isn't sent again, and
one being sent when the daemon stopped reads unknown at the next start. A notice whose
row is no longer held is retired, not sent. Interrupted historical
writes become indeterminate at startup. That history never suppresses a current
explicit request and is not consulted to determine its result.

At startup, the queue recovery pass retries still-current failed or unconfirmed
wake notifications. It preserves their original envelopes and warns that delivery
may repeat. Each notification is attempted once per pass, including coalesced
wakes; a failed attempt cannot spin in that pass. A no-write failure on a later
retry does not resolve an earlier unknown delivery. Prior-process claims are
reconciled before new startup sends can begin. Known deliveries and held or
retired messages stay untouched. Closed, claimed or reassigned work is not woken,
and the retry never repeats the queue mutation or a lifecycle action.

The existing retention limits apply: 100 records and 8 MiB per seat, with a 1 MiB
message limit. Hold mode cannot retain another message at capacity. Draft-aware
input attempts continue with a bookkeeping warning if a record cannot be saved;
already-committed queue intent remains durable.

## Rollback and lifecycle

Persisted legacy guard bits are on for both hold and draft-aware, so an older
daemon holds messages instead of typing into a protected seat. On re-upgrade,
the most recent guard audit row and change timestamp determine whether the saved
mode is still authoritative. A later boolean write by the older daemon takes
precedence, including a same-value on-to-on write in the same clock tick.
Without a later setting change, the draft-aware mode survives re-upgrade.
Held and uncertain deliveries are never replayed by this reconciliation.

Current API `desired` and `effective` booleans continue to describe hold-all;
mode fields describe draft-aware protection. Storage's fail-safe legacy bits
are deliberately broader.

With hold, writing lifecycle operations refuse before effects. With draft-aware,
an active seat requires an explicit switch to off before writing lifecycle work.
Fresh startup is exempt only after creating a new pane or successfully respawning
a dead pane within the same lifecycle operation. Adopting or rebinding an existing
pane grants no such exemption.

Terminal capture is observational, not an atomic editor API. A direct tmux writer
can still act between the last observation and paste. The resulting changed input
refuses Enter and is not replayed. Unsupported provider layouts remain held.
Use off when that tradeoff is unsuitable.

HTTP configuration uses `POST /api/seat/set-typing-guard/:seatRef` with
`{mode, reason}` or `{enabled, reason}`. The `X-OpenRig-Session` header, when
present, is the recorded actor; without it the change is recorded as
`unattributed (no seat identity)`. Status and held-message routes are
unchanged; no RigSpec field is required.

## Verification scope

Regression tests exercise rollback/re-upgrade, same-value legacy writes, exact
retained outcomes, current requests after restart, coalesced queue bodies, trailing
spaces, numbered bodies, real-menu refusals and multi-placeholder ownership. Native tests
use private real tmux panes with scripted editable composers. These verify the
transport mechanics; they are not live Claude/Codex provider sessions.

## Watchdog reminders

A currently due watchdog reminder makes a new delivery attempt, including after an interrupted attempt or job
accounting. Historical outbox receipts do not suppress a lone reminder or prevent it from joining a digest. The
message tells its recipient that delivery may repeat after an unconfirmed attempt. Its job history records the
current transport result; an unknown write is not proof that nothing arrived.

The transport still protects approval/question prompts and recipient identity. Under the default
`transport.draft_delivery` (`deliver`), an ordinary send or work notice that meets a person's draft at a Claude Code or
Codex prompt is pasted into it and the combined input is submitted, unless the seat's typing guard holds input
(`draft-aware`, `openrig-urgent`, `urgent-only`, `queue-only` or `hold`). With `refuse`, a draft refuses the send. Scheduler timing,
current parked-row eligibility and stop checks still apply. This changes message retries, not the idempotence of
structured continuity actions such as creating a cutover baton.

The parked-owner supervisor also retries current obligations despite an earlier failed, unknown or unrecorded attempt.
Its first reminder to a seat waits until the seat's waiting state has been unchanged for 5 minutes, then goes on the next
watchdog tick, so a seat that just handed work off or asked a person isn't interrupted; a seat still holding the work after
that is reminded as before. A seat at an approval or question prompt gets no grace, so the prompt-blocked alert isn't delayed.
A recorded success to the same known occupant waits for a change in its obligations. Rotation includes retained attempts,
so a held input cannot starve another owner. Interactive prompts stay with the existing prompt-refusal recovery.
Its own reminders wait while managed compaction owes the turn boundary, restore or audit, including a fresh check
at the paste and Enter boundary. A stage that begins after paste leaves an honest partial-input result; OpenRig
does not erase or replay that text. Peer messages and unrelated reminder policies keep their existing behavior.
