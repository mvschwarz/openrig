# Per-seat terminal delivery

The typing guard has six modes. `off` and `hold` are the two ends. Draft-aware adds an
opt-in check for unfinished input without a second control or daemon-owned retry
scheduler. Between off and hold, three interruption levels choose which automatic messages may
type: `openrig-urgent`, `urgent-only` and `sends-only`. Sibling seats keep their own mode.

| Mode | Terminal input | When input is unavailable |
|---|---|---|
| `off` (default) | Existing delivery and prompt checks | Existing send result |
| `draft-aware` | Paste into a recognized empty composer; check ownership again before Enter | Hold input and retain this attempt for inspection when bookkeeping is available |
| `openrig-urgent` | OpenRig's own messages (watchdogs, scheduled wakes, notices) and anything marked urgent type, never over a draft | Other agents' messages are held, the sender is told, and held messages stay readable |
| `urgent-only` | Only messages marked urgent type (`rig send --urgent`, or a queue item at priority urgent or critical), never over a draft | Everything else is held, the sender is told, and held messages stay readable |
| `sends-only` | Deliberate sends from people and agents type, as with `off`; a terminal member's typing isn't protected, because its shell input can't be read | OpenRig's own notices are held. A terminal member defaults to this level |
| `hold` | No automatic terminal input, even at an empty prompt | Retain for inspection outside the pane |

Lifecycle work is refused at `openrig-urgent` and `urgent-only`, as at `hold`.

A terminal member (`runtime: terminal`) defaults to `sends-only`, which holds OpenRig's own notices. Set one
to `off` and those notices, such as park reminders and other watchdog messages, type into whatever the pane
is running, and a shell prompt runs each line as a command, From and To lines included: OpenRig doesn't check
a terminal pane's foreground process. `openrig-urgent` and `draft-aware` type only into a recognized empty agent composer, so
a shell prompt holds them. Keep the default for a seat that may fall back to a shell.

Runtime permissions are separate. Recipient and interactive-prompt checks still
apply. `--raw` and `--force` do not bypass the typing guard. A deliberate
`--dangerously-interact --reason` remains available at every interruption level
and uses the existing-input check below. Direct human input remains available.

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

### Deliberate interaction and existing input

A managed `rig send <seat> "<answer>" --dangerously-interact --reason "<why>" can
drive a recognized native menu as before. Otherwise, with the delivery guard
attached, it reads the visible composer under the seat's lease immediately before
pasting, after buffer preparation. Empty input proceeds. A recognized dim
suggestion is displayed separately and counts as empty; typed or pasted text
(author unknown) stops the send with `override_input_present`. An unreadable input
stops with `override_input_unknown`, never an empty-input claim. Both return single-send HTTP
409, `sent: false`, and caller-only `existingInput` evidence (visible rows, suggestion
rows, cursor/dimensions and target binding). A collapsed paste shows its label,
not the hidden contents. OpenRig neither holds nor retries this stopped override.

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

Run from a seat shell with `OPENRIG_SESSION_NAME` set; the daemon derives the
audit actor from transport identity.

~~~sh
rig seat set-typing-guard dev-impl@my-rig --mode draft-aware \
  --reason "preserve my unfinished input"
rig seat status dev-impl@my-rig
rig seat held-messages dev-impl@my-rig --json
rig seat held-messages dev-impl@my-rig --id <outbox-id> --json
rig seat retire-held-message dev-impl@my-rig <outbox-id> --reason "read outside the pane"
~~~

Use exactly one of `--mode off|draft-aware|openrig-urgent|urgent-only|sends-only|hold` or the compatible
`--enabled true|false`: true selects hold, false selects off. There are no
retry settings or deadlines. Activation waits for an already-started seat operation
to finish. The API may return HTTP 202 with `pending: true`; wait for
`pending: false` before relying on the requested mode. Status reports desired
and effective modes and retains the text `Typing guard: on (hold)` for hold.

A held send immediately returns `outcome: "retained"`, `sent: false`, its exact
reason (such as `draft_input_busy`) and the saved attempt's `outboxIds`. No automatic
retry is scheduled. Each explicit draft-aware request is a new attempt, including
one with a reused `deliveryId`; the result warns older callers that this field no
longer deduplicates input. The CLI does not generate a deduplication key.

Clearing a draft, changing modes or restarting does not flush saved messages or
callbacks. To try again, send a current request: it rechecks the recipient and input.
A caller abort before paste cancels input; after a write may have started, the
result preserves that uncertainty rather than claiming nothing was sent.

Bookkeeping is observational. If its write fails, an otherwise valid input attempt
still proceeds and the response includes a warning instead of a saved receipt.
Actual transport success stays success; an unknown write stays unknown. If input
was held and no record could be saved, the response reports failure with `sent:
false` and the protection reason, rather than claiming durable custody.

Reading never sends. Retirement frees that record's active retention quota while
preserving evidence; it does not deliver a message or close queue work.

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
A held queue wake stays on the existing queue recovery path. Interrupted historical
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
`{mode, reason}` or `{enabled, reason}`. Status and held-message routes are
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

The transport still protects approval/question prompts, human drafts and recipient identity. Scheduler timing,
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
