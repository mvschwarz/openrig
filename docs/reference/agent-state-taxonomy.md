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
`context_walled`, `compacted`, `crashed`, `unknown`).

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
  the seat parked.
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
- **r2 — lifecycle hooks** (Claude SessionStart/UserPromptSubmit/Stop/Notification;
  Codex SessionStart/UserPromptSubmit/Stop/PermissionRequest): standing for Claude; Codex's
  hook rung starts at trial and is promoted after 50 agreeing observations over at least an
  hour. Exactly-once turn boundaries; SubagentStop filtered (it
  can fire post-turn and must never revive an idle seat). Hook-rung authority is
  TIME-BOUNDED: the hook rung is the only rung that does not self-date its evidence, so
  persistent cross-rung contradiction degrades it to identity-only, visibly, with a
  rung-health event.
- **r4 — visible needs-input chrome**: standing; outranks self-report for the
  needs-input signal only (a dialog you can see beats a hook that said working).
- **r1 — window-activity sampling** (today's oracle): the fallback tier. Retires
  PER-HARNESS when that harness's hook rung earns trust through a measured agreement
  window in production — never by fixture pass alone (symmetric admission: a fixture
  pass admits a rung to TRIAL, where it is measured but not consulted; production agreement
  promotes it). Undeclared and partial-coverage rungs are identity-only, which is also where
  a degraded rung goes.

Partial-coverage honesty: a source with partial lifecycle coverage gets identity-only
trust. The ladder is also the migration path — new oracles slot in above existing
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
  `mcp_gate`, `bypass_consent_gate`, `codex_auth_refusal`, `codex_client_incompatible`.
- **Restore outcome:** `resumed`, `fresh-primed`, `awaiting-decision`, `attention_required`,
  `failed` (plus `rebuilt`, `operator_recovered` and the legacy `fresh`).

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
