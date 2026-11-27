# Agent state taxonomy

The formal activity language OpenRig's surfaces render from — the TUI and the `rig ps`
ACTIVITY column. One oracle computes it; surfaces render it. Two exceptions remain: the web
UI's graph node still derives its own running/needs-input/idle/unknown from the legacy
`agentActivity`, and `rig ps --active` / `--filter agentActivity.state` filter on that legacy
field. Startup, orientation, restore and attention states are separate vocabularies, listed
under "Other state on the same surfaces" below.

**This document is the canonical text for the shipped taxonomy** and adds the
engineering reconciliation; it never forks a second vocabulary. Its typed source of
truth is `packages/daemon/src/domain/activity-taxonomy.ts`.

## The three orthogonal axes

| axis | values | question it answers |
|---|---|---|
| session | `present` · `detached` · `exited` · `absent` | does a process exist |
| activity | `working` · `idle-at-prompt` · `unknown` (+ needs-input as count+reason, below) | what a present agent is doing |
| resumability | `live` · `resumable` · `context-walled` | what a non-present agent can come back as |

Only the activity axis is served today. The session and resumability values are declared in
`activity-taxonomy.ts` but no surface reads them: `rig ps --nodes --full` shows the raw session
STATUS, both node views show a LIFECYCLE of `running`, `detached`, `recoverable` or `attention_required` (`run`, `det`, `rec`,
`att`), and node inventory serves `occupantLifecycle` (`active`, `retiring`, `retired`,
`context_walled`, `compacted`, `crashed`, `unknown`). Node inventory's `sessionStatus` is the
recorded session status, with two observed corrections: a running session whose pane is verified
to have exited (identity reason `pane_exited`) reads `exited`, with `startupStatus:
"attention_required"`, and a running session confirmed missing reads `detached`.
`rig seat status` serves the same LIFECYCLE as `lifecycle_state` beside `session_status`. When the session
record is running but the LIFECYCLE is `attention_required` (for example, the seat's startup or restore needs
attention, or OpenRig can't confirm the pane's process as the seat's runtime, such as a bare shell), its human
output reads `Session: needs attention`, as `rig ps` reads `att`.
Beside the LIFECYCLE, a recorded-running agent seat whose current identity check saw a shell as the pane's foreground
command, without verifying the seat's agent there, serves `agentLiveness` (`agent_liveness` in `rig seat status`):
`{ state: "not_verified", reason: "shell_foreground", command, observedAt }`, once its startup is no longer pending. It
shows a stored shell observation; delivery checks the target again and applies its runtime's own policy. A community
harness's seat can read it with its LIFECYCLE still `running`, because OpenRig can't prove that harness's process. `rig ps --nodes` shows `agent not verified` as the REASON and a `Liveness` line, and
`rig seat status` shows an `Agent:` line. It isn't proof the agent stopped, since an agent can run behind a wrapper.
Otherwise the field is absent, which claims nothing. It's read from the identity check's stored verdict, so showing it
reads nothing new.

The axes never blend. Reachability is strict; revival optimism is a different field
(omnigent's strict-liveness split). `unknown` is a first-class honest value — the oracle
saying it cannot tell. Unknown beats a confident wrong answer.

### needs-input is a count + reason, never a status value

Blocked-on-input rides as `{ count, reason }` — the number of outstanding prompts plus a
short phrase naming why nothing is moving ("permission prompt", "usage limit",
"classifier hold" — provider chrome and usage limits are explicitly in-axis: they are
the second cause of production-observed parks). Human surfaces may *display* "needs-input"
(the four-value human list) via the one bridge `deriveDisplayActivity`, which
renders needs-input whenever `count > 0`; no store or transition ever holds it as a
state. Attention/alarm values likewise stay in their own machinery (`attentionCount`).
Both herdr and omnigent converged on this exclusion, with warning comments on the
collision in both codebases.

The legacy `agentActivity` field distinguishes a typed provider interruption from
a request for a person: fresh Codex `at_limit` and Claude `StopFailure/rate_limit`
events carry `state: unknown` and `reason: usage_limit`, never a `needs_input`
hook. A permission prompt can independently supply human-input evidence. See
[Claude usage-limit detection](claude-status-line.md#claude-usage-limit-detection)
for the separate provider signal and queue timer.

The arbitrated state holds Claude's typed limit too. After `StopFailure/rate_limit`, `activity` reads `unknown`, never
working or idle, and `usageLimit` carries when the limit was seen and the reset it stated. Both hold until a strictly
newer turn starts, from a hook or Claude's own status. An idle prompt, a redraw or the limit's menu doesn't clear them.

### Per-seat attention in the node inventory

`rig ps --nodes` carries the daemon's `needsAttention` result, using the same predicate
as the rig's `attentionCount`. It also serves `arbitratedNeedsInput`: `true` for observed
input, `false` for an observed clear, and `null` when no authoritative needs-input source
answered. `needsInputEvidence` retains that source's rung and observation time, or `null`.
A zero prompt count alone is not an observed clear. Absent arbitration evidence leaves
the existing live-hook fallback in effect; lifecycle, startup, held and error signals
can independently raise attention. A false attention flag means no known trigger, not
proof that an unobserved input box is clear.

Claude's other `StopFailure` errors keep a typed reason in the legacy `agentActivity`
field, with `state: unknown` and the raw `error` value in `rawSubtype`.
`authentication_failed`, `oauth_org_not_allowed` and `cloud_credential_error` read
`provider_auth_error`; `billing_error` and `account_on_hold` read
`provider_billing_error`. The current occupant's last such failure raises attention
until a hook shows a newer turn (a prompt, a question to a person, a `Stop` or
`PostToolBatch`, or another `StopFailure`) or another occupant takes the seat; as for any
hook, an occupant that can't be told shows nothing.
Retention is bounded to the node's newest 200 activity records: a failure followed by 200 records that
show no newer turn stops showing, even without a newer turn or occupant; this does not mean the account recovered.
Claude's idle notification and the
five-minute hook freshness window alone don't end it, and hook freshness is unchanged
for everything else. The row serves that failure, with its original event time, over the cached pane
reading, and the reason column names it. It says the last reported failure hasn't been
superseded, not that OpenRig checked the account; a newer turn doesn't certify a repair.
A newer picker or permission prompt in the pane outranks it, and a draft in the input box
doesn't. These failures aren't a question, so they hold no send or wake. Any other value,
documented or not, reads `provider_error`, stays with the pane reading and raises no
attention.

A handover whose successor started without a required file also raises attention. That's
a projected guidance file or a guidance startup file marked `required` still missing from
the guidance file, or, for a fresh or rebuild successor, a required `send_text` startup
file that's missing. The seat serves `startedWithoutRequired` with each file's path, the
table's reason column names each file, and the handover's own output says it's degraded.
The mark belongs to that successor's session, so the seat's next launch or handover
clears it. Time alone never does. Repairing the file in place doesn't clear it either,
because no route delivers guidance into a running conversation.

A fresh or rebuild successor's first turn opens with the seat's `send_text` startup files,
the ones a fresh start delivers, as absolute paths with the role first. A pointer asks the
successor to read the file; it isn't the pasted text a start sends. A fork successor
carries its parent's conversation and gets no list. `send_text` startup actions, such as
an `after_ready` preload, aren't run for a successor.

The compact human table's ATTN column renders `yes`, `no`, or `?` when the flag is
unavailable. Compact JSON retains `needsAttention`; use `--full` or
`--fields needsAttention,arbitratedNeedsInput,needsInputEvidence` with `--json` for the
provenance. The TUI uses the served flag for attention glyphs and totals, and shows the
needs-input evidence in seat detail, including a hook-only prompt. With an older daemon,
attention stays unknown while its existing prompt, startup and error hints remain visible.

## Derived diagnoses — computed at read time, never stored

- **PARKED** — the disease: `(activity = idle-at-prompt OR needs-input pending) ×
  (open obligations OR unhealthy HELD rows)`. A dropped baton or an unanswered block. When
  activity is `unknown` the verdict is `indeterminate`, never parked or not-parked. Queryable
  at rig and seat level with `rig parked [seat] [--rig <name>] [--json]`; the join lives in the
  parked query, never inside the oracle (the oracle's non-inference contract: it never reads
  queue state).
- **HELD** — the deliberate counterpart: a queue-level hold with a named owner and an
  armed wake (`rig view show held`). Stopping on purpose is HELD; stopping by accident is
  PARKED. A HELD row is healthy only while its wake is live, and not fired-but-unconsumed
  unless the stuck sweep owns its recovery; an unhealthy HELD row on a stopped seat makes
  the seat parked. One exception: a row held on a named `external:` gate (`external:<name>`,
  with a non-blank name) and no recorded wake is an event-only HELD. Its owner chose to wait on something outside, so it is healthy:
  it stays on the held view and in `rig parked` with its blocker and last update, and no
  reminder fires for it. `rig queue resolve <id> --decision "<what happened>"` ends it.
  Other typed gates, custom blockers and plain holds read as before.
- **DONE-UNSEEN** — finished work whose completion nobody consumed (herdr derives it as
  idle ∧ unseen). Declared as a concept only; no surface computes it yet.

## Reconciliation with prior art

| ours | herdr (`src/detect/mod.rs:11`) | omnigent (`schemas.py:2767`) |
|---|---|---|
| `working` | `Working` | `running` |
| `idle-at-prompt` | `Idle` | `idle` |
| needs-input count+reason | `Blocked` + `visible_blocker` override | `pending_elicitations_count` + `blocked_on` phrase — **not** a status |
| `unknown` | `Unknown` ("plain shell or unrecognized program") | — |
| derived DONE-UNSEEN | derived `Done` = idle ∧ unseen (`src/ui/sidebar.rs:186`) | — |
| session axis | server owns the PTY (presence direct) | `runner_online` × `host_online` × `host_resumable` |
| — (rejected) | — | `waiting` (turn parked on async drain — collides with Claude's dialog `waiting`; both codebases carry warning comments) |

## The evidence ladder (rung inventory and retirement conditions)

State is computed by ONE arbitration point (`SeatActivityService`) from ranked,
time-bounded evidence. Rungs, top down, with each rung's retirement condition:

- **r3 — Claude `sessions/<pid>.json` self-report** (busy/shell/idle/waiting, since
  v2.1.139): standing, above hooks for working/idle. Undocumented internal — unreadable
  means fall down the ladder, never error.
- **r2 — lifecycle hooks** (Claude SessionStart/UserPromptSubmit/PostToolBatch/Stop/StopFailure/Notification;
  Codex SessionStart/UserPromptSubmit/Stop/PermissionRequest): standing for Claude; Codex's
  hook rung starts at trial and is promoted after 50 agreeing observations over at least an
  hour. Exactly-once turn boundaries; SubagentStop filtered (it
  can fire post-turn and must never revive an idle seat). Working and idle posts are taken
  in the emitter's own order (event time, then its sequence), so a turn's Stop arriving after
  the next turn's UserPromptSubmit doesn't win. Attention posts (a permission request,
  needs-input, a usage limit) are applied as they arrive. Hook-rung authority is
  TIME-BOUNDED: the hook rung is the only rung that does not self-date its evidence, so
  persistent cross-rung contradiction degrades it to identity-only, visibly, with a
  rung-health event.
- **r4 — visible needs-input chrome**: standing; outranks self-report for the
  needs-input signal only (a dialog you can see beats a hook that said working).
- **r1 — window-activity sampling** (today's oracle): the fallback tier. Retires
  PER-HARNESS when that harness's hook rung earns trust through a measured agreement
  window in production — never by fixture pass alone (symmetric admission: a fixture
  pass admits a rung to TRIAL, where it is measured but not consulted; production agreement
  promotes it). For Codex, this fallback also accepts a fresh working status adjacent to
  the composer, or an advancing counter across two fresh captures when output separates
  them. This positive evidence expires after five seconds; unrecognized, frozen, old or
  pre-occupant frames add nothing. It uses the existing pane capture. Undeclared and partial-coverage rungs are identity-only, which is also where
  a degraded rung goes, with one declared exception: for a pi or omp seat or a community
  harness, sampling is positive-only: a changing pane reads working, and a quiet one never reads idle on its
  own, since the pane can be quiet mid-turn.
- **pi and omp runner hooks**: OpenRig's runner reads the child's RPC event stream and posts
  each turn boundary (`agent_start`, `turn_start`, tool calls, `agent_end`; attention). These
  decide working, idle and needs-input. Unlike Claude and Codex hooks, an idle or attention
  boundary holds until the next one instead of expiring after 15 s; a working boundary still
  expires, so a turn whose end was lost reads unknown, not working forever. Posts are taken
  in the runner's own order (time, then its sequence), so an older boundary arriving late
  doesn't win. The runner's report that its child
  exited reads unknown, not idle. A boundary the runner didn't see (if a runtime ended a turn
  without `agent_end`) leaves the seat working up to the 15 s window, then unknown, never idle. After a
  daemon restart, a runner seat takes its last recorded boundary from the hook store, for its
  current session and occupant generation only, so an idle seat still reads idle before it
  posts again, provided that report is fresh: a pi runner's idle boundary states an interval
  (below) and lapses to unknown once it is older than two of them.
  A pi runner also posts an idle `Stop` (`idle_heartbeat`) every three minutes while it waits, and states that
  interval as `livenessSeconds` on every `Stop`: a newly ready runner reads idle at once, and an idle boundary that
  carries an interval holds for two of them, then lapses to unknown, so a runner killed without saying so stops reading
  idle. Silence never clears a pending attention prompt, and a runner that states no interval (omp, an older pi
  runner) keeps the hold-until-the-next-boundary behaviour.
- **A plain community preset's declared hooks** (`activity_hooks`, recorded at launch): the hook events the
  harness's own script posts decide working, idle and needs-input, taken in their own order (time, then sequence)
  as a runner's are, so a delayed older `Stop` that carries its `occurredAt` doesn't read a working seat idle. A post
  without `occurredAt` is stamped at arrival and ordered by it. Only a declared turn start (`UserPromptSubmit` or `active`) makes an idle
  boundary hold until the next post; without one it lasts the 15 s hook window, then positive-only sampling decides
  (working or unknown). A dialog the structural recognizer reads on screen (the `needs-input-chrome` rung, source
  `community:structural-prompt`) raises needs-input while its frame is fresh (5 s), captured after the inventory
  began, from the seat's pane where that's known, and started after the seat's latest hook; the next hook, a frame
  with no dialog or a failed read ends it. The trust rests on the installed preset's declaration, and nothing
  demotes it automatically. A runner preset ignores the declaration.

Claude permission notifications raise needs-input immediately. A visible permission can clear
after it has been observed and then disappears. A notification whose dialog was never observed
can also clear when Claude reports `PostToolBatch`: every tool in that actor's batch has resolved,
so its earlier permission requests are no longer pending. The relay carries the native actor
identity; a subagent or in-process teammate finishing its batch cannot clear the main session's
request, and overlapping actors remain separate. An individual `PostToolUse` is insufficient
because another tool in the batch may still be waiting for permission.

Batch completion must come from the current occupant and have a later source timestamp than
the matching notification. Missing actor attribution from an older relay, equal or older
timestamps, and another actor's completion retain attention. An unrecognized or missing screen
does not expire attention by age. `Stop` and `UserPromptSubmit` remain the turn-boundary fallback.
The oracle remembers each actor's latest completed batch for the current occupant, so a strictly
earlier notification arriving late cannot restore the mark, even if the completion arrived first.
A notification with an equal or later timestamp remains eligible; swapping or retiring the
occupant discards its remembered completions.
Completing a batch changes the needs-input signal without inferring that the seat is idle or
overwriting a later elicitation. The hook contract is documented in
[Claude's hooks reference](https://code.claude.com/docs/en/hooks#posttoolbatch).

Partial-coverage honesty: a source with partial lifecycle coverage gets identity-only
trust, unless its inventory declares it positive-only. A positive-only source can report
working and nothing else; its silence reads unknown, never idle. The ladder is also the migration path — new oracles slot in above existing
heuristics, lower rungs retire a release at a time, consumers never see a flag day.

Seat-keyed: state attaches to the durable seat nodeId, never the occupant. A handover or
generation swap is its own visible event — never an activity transition — and triggers
rung-inventory re-declaration: a successor never inherits its predecessor's rung
authority (hooks live in occupant config while the pane is seat-persistent).

## Other state on the same surfaces

These are separate vocabularies, not activity values. `rig ps --nodes --full` shows them in
its STARTUP, ORIENTED, LIFECYCLE and RESTORE columns (the default compact view shows only
LIFECYCLE); see the
[startup guide](agent-startup-guide.md) for how each arises.

- **Startup status:** `pending`, `ready`, `attention_required`, `failed`. `ready` means
  startup finished, never that the seat is oriented, and a seat isn't marked `ready` while
  its startup context is still pending for `rig seat continue`.
- **Oriented:** `verified`, `missing`, `rejected`, `n-a`, from the startup proof.
- **Attention codes:** `trust_gate`, `hook_trust_gate`, `update_gate`, `login_required`,
  `mcp_gate`, `bypass_consent_gate`, `claude_resume_selection_prompt`,
  `claude_gated_grants_gate`, `codex_auth_refusal`, `codex_client_incompatible`.
- **Restore outcome:** `resumed`, `fresh-primed`, `awaiting-decision`, `attention_required`,
  `failed` (plus `rebuilt`, `operator_recovered` and the legacy `fresh`). A seat joined with
  `rig attach` as an external CLI reads `left_attached`: restore leaves it as it is.
  An `attention_required` outcome, or `failed` with a running session, makes the seat's
  lifecycle `attention_required`, whatever its startup status, so it raises `needsAttention`.
  After a full restore, the daemon reconciles it to `operator_recovered` when the seat's
  activity next turns to running or idle (or reads so when the restore completes) and the
  live seat passes its check, and `rig seat clear-attention <seat>` runs that check on
  demand; `rig seat continue` doesn't change it
  ([startup guide](agent-startup-guide.md#after-a-restored-seats-prompt)).
- **Stop request:** `stopRequested: true` in node inventory is a `rig seat stop` or `rig down`
  that was recorded and isn't confirmed yet, for example after a timeout or a partial kill. The
  seat isn't reported as exited until it's confirmed, and observing the session doesn't clear
  the request ([checked seat stop](checked-seat-stop.md#the-stop-request)).
- **Keep-alive:** `keepAlive: true` marks a seat that declares `keep_alive`, and
  `keepAliveIncident` (`attempts`, `exhausted`, `lastError`, `lastAttemptAt`) its current
  recovery after a fall. An exhausted incident makes the seat's lifecycle `attention_required`
  while it isn't running, so it raises `needsAttention` until someone starts or stops it (a stop
  request, pending or confirmed, ends that at once, and the daemon's next check ends the incident)
  ([keep a seat running](rig-spec.md#keep-a-seat-running-keep_alive)).

## Rejected oracles — dated receipts (2026-08-26), so nobody re-derives them expensively

- **transcript-quiescence as an activity oracle: REJECTED.** omnigent's 1-second version
  oscillated on mid-turn lulls and idempotently locked out real completions; its
  surviving 5-second variant is annotated a stopgap awaiting a hook replacement.
  Distinction held: transcript growth remains FINE as the refocus hook's cadence
  trigger — a different purpose, and the one permitted consumer.
- **pane-scraping as primary truth: REJECTED.** herdr — whose TOML screen manifests are
  the state of that art — subordinates them to hooks wherever hooks cover the lifecycle,
  and marks viewer screens `skip_state_update` because scrollback lies. Pane reading
  stays fallback-tier only.
