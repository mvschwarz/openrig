# Per-seat terminal delivery

The existing typing guard supports three modes. Before draft-aware mode,
automatic input either used the ordinary delivery path or was held unconditionally.
Draft-aware adds an opt-in check for unfinished input without a second control or
daemon-owned retry scheduler. Sibling seats keep their own mode.

| Mode | Terminal input | When input is unavailable |
|---|---|---|
| `off` (default) | Existing delivery and prompt checks | Existing send result |
| `draft-aware` | Paste into a recognized empty composer; check ownership again before Enter | Hold input and retain this attempt for inspection when bookkeeping is available |
| `hold` | No automatic terminal input, even at an empty prompt | Retain for inspection outside the pane |

Runtime permissions are separate. Recipient and interactive-prompt checks still
apply. `--raw`, `--force` and `--dangerously-interact` do not bypass the typing guard.
Direct human input remains available.

## Configure and inspect

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

Use exactly one of `--mode off|draft-aware|hold` or the compatible
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
A recorded success to the same known occupant waits for a change in its obligations. Rotation includes retained attempts,
so a held input cannot starve another owner. Interactive prompts stay with the existing prompt-refusal recovery.
Its own reminders wait while managed compaction owes the turn boundary, restore or audit, including a fresh check
at the paste and Enter boundary. A stage that begins after paste leaves an honest partial-input result; OpenRig
does not erase or replay that text. Peer messages and unrelated reminder policies keep their existing behavior.
