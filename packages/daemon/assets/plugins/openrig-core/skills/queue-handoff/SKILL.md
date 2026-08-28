---
name: queue-handoff
description: Use when ending a turn, finishing a slice, blocked on another agent's work, or escalating to a human — durable work handoff via queue items so the system keeps moving across compactions, missed messages, and interruptions. Covers the hot-potato terminal-turn-rule (active work ends by passing the ball, not by going idle), default-nudge semantics, and when `--no-nudge` is appropriate for intentional cold park or human gate.
metadata:
  cli_surfaces_referenced:
    - queue
    - queue create
    - queue handoff
    - queue handoff-and-complete
  openrig:
    stage: factory-approved
    sibling_skills:
      - workflow-runtime
      - watchdog
      - refocus
      - looping-workflows
      - intake-routing
      - human-in-the-loop
      - dispatching-parallel-agents
      - subagent-driven-development
      - structured-ack-dispatch
      - control-plane-capabilities
      - status-not-chat-orchestrator
      - control-plane-queue
      - control-plane-watchdog
      - control-plane-workflows
      - control-plane-delivery-loop
      - control-plane-rollout-manager
---

# Queue Handoff

Durable work handoff via queue items. Lets the system keep moving
through compactions, missed messages, and interruptions by passing the
ball forward instead of leaving work suspended in chat or in-flight
without an owner.

## Use this when

- **Ending a turn on substantive work.** Active work should end by
  passing the ball to an owner or to the human — never by going idle
  with the rig appearing dormant.
- **Finishing a slice that has a clear next step.** Default-nudge:
  receiver gets a wake-ping plus the durable queue item.
- **Blocked on another agent's work.** Park the qitem with
  `closure_reason: blocked_on` and the blocker qitem id.
- **Escalating to the human.** Make the escalation a durable attention
  item, not just a chat message.

## Don't use this when

- The work is genuinely complete and there's no follow-on owner. Use
  `closure_reason: no-follow-on` (terminal completion) or
  `canceled`/`denied` as appropriate.
- The handoff would be too small and turn work into bureaucracy. Bundle
  the work into a coherent slice instead of decomposing every step.
- The handoff would be too broad and lose ownership/proof/closure
  criteria. Shape the qitem so the receiver knows the expected next
  action and closure evidence.

## The hot-potato terminal-turn-rule

Active work ends by passing the ball to a named next owner or to the
human. The qitem state machine enforces this:

`pending → in-progress → done` requires `closure_reason` from one of:

- `handed_off_to` — work continues at a different seat (target = new owner)
- `blocked_on` — parked pending another qitem (target = blocker qitem id)
- `denied` — receiver rejected the work
- `canceled` — sender or receiver withdrew
- `no-follow-on` — terminal completion, nothing else needed
- `escalation` — kicked up to a higher tier (target = escalation target)

Three of those (`handed_off_to`, `blocked_on`, `escalation`) additionally
require `closure_target`. The daemon enforces this at the domain layer;
every surface (CLI, MCP, future UI) inherits the same guarantee.

**The drafted-park failure (draft ≠ throw).** The rule is about the *actual* pass, not the
intention to pass. A turn that ends with a self-instruction **typed into your own prompt but left
unsent** — a drafted go-ahead, a next-atom note you never sent — has **not** handed off; it has
**parked**, and the seat sits idle for as long as nobody notices. Drafting the handoff feels like
doing it; it isn't. **Your last act on a turn must be an EDIT or a SEND** — a committed change, a
`rig send`, a `rig queue` handoff — **never a drafted prompt line left in the buffer.** If your
final output is an instruction addressed to yourself, you haven't ended the turn, you've stalled it.

**The dispatcher's other half — supersession closes your own outbox.** Ending your turn cleanly is
only half the rule; the other half fires when *you* move the world. **When a phase transition or a
fold receipt supersedes work you dispatched, close those dispatches yourself — with a citation to the
event that superseded them.** Closure-on-supersession belongs to the **dispatcher, never the
receiver.** Make it a habit: after every fold receipt / phase transition, run an **outbox audit** —
*which of my open dispatches did this just make moot?* — and close them with the citation.

*Why it must live with you:* stale dispatch-debt is **invisible to the dispatcher** because it lands
on someone else's queue — the cost is externalized, so no feedback loop ever fires to make you clean
it up. The receiver inherits debt they did not create and must burn cycles verifying it before they
can hold cleanly; a queue full of stale-pending makes *check-before-holding* — the discipline you
most want cheap — expensive, and it degrades the idle-detector's signal (a real owner looks the same
as a stale dispatch). Close it at the source: the moment your own transition mooted it.

**And after you hand off, PULL — don't idle with a stocked queue.** Handing the baton off ends the
*sequential* thread; it does not end *your* turn if your own queue still holds work. The circulation
pattern: finish → (1) hand the baton off so sequential work continues → (2) **check your OWN queue and
pull the next item** rather than going idle → (3) go truly idle only when your queue is **exhausted**,
then wait for the baton. An agent idling on top of a stocked queue is the single biggest utilization
leak (see `orchestration-team` → *queue depth is the orchestrator's product*). This is pull-not-push at
the seat level and needs no new machinery — the last act *after a handoff* is a **PULL**.

## Default-nudge semantics (the syntax footgun)

| Command | Nudges by default? | When to use |
|---|---|---|
| `rig queue create` | yes | New qitem created from scratch |
| `rig queue handoff` | yes | Transactional close-as-handed-off + create-new |
| `rig queue handoff-and-complete` | yes | Atomic close + create-new; default nudge wakes the new owner |
| `rigx queue handoff` (filesystem v0 prototype; **recovery-only fallback since 2026-05-11**) | yes | Legacy artifact; qitems invisible to daemon-backed reads; deprecation warning + removal queued at `missions/bug-fix/slices/rigx-queue-deprecation-message/`. Use `rig queue handoff` (daemon-backed) for all new substantive work. |

**Footgun**: `--no-nudge` accidentally added to a live-loop handoff.
The shipped 0.3.1 CLI nudges by default on every queue write surface
(`rig queue create`, `rig queue handoff`, AND `rig queue handoff-and-complete`).
The only suppression flag is `--no-nudge` — appropriate for intentional
cold park, human-gate signal, or a deliberate poll-driven workflow, but
NOT for live-loop handoffs where motion matters.

**Rule**: in a live loop, omit `--no-nudge` and trust the default.
`--no-nudge` is the opt-out, not the opt-in. If you find yourself
reaching for `--notify`, stop — that flag does not exist on the
shipped 0.3.1 CLI; you may be following a stale instruction that
inverted the default-nudge polarity.

## Queue-body hygiene (token + parse safety)

The qitem body is durable DATA the daemon stores and replays on every
`rig queue show <id>` / `--json` read. Keep it small and parse-safe — a
bloated or malformed body costs every future reader, not just the
recipient.

- **No large command output in bodies.** Do NOT paste `rig ps`/`--nodes`
  dumps, big JSON blobs, full proof output, diffs, or transcript chunks
  into a qitem body. **Link the artifact PATH** (e.g.
  `missions/<m>/<slice>/proof.md`) or **summarize in prose**, then point
  at the file for the detail. A pasted dump makes `rig queue show <id>
  --json` huge — a second-order token bloat: bloated DATA living in the
  queue, distinct from the command-default output bombs the token-burn
  emergency pack covers. (Sensor: guard token-burn-flag 8ea201e4,
  2026-06; operator-directed cure.)
- **Substantive bodies go through `--body-file`, not inline `--body`.**
  For anything beyond a short line, write the body to a file and pass
  `--body-file <path>` (or `-` for stdin). Inline `--body` with shell
  metacharacters is fragile.
- **No raw backticks in bodies.** Backticks in an inline body are shell
  command-substitution and corrupt the payload (or execute). If you need
  code/command spans, use `--body-file`, or drop the backticks and write
  the command in plain text.

Heuristic: if the thing you want to include is more than a few lines or
contains shell metacharacters (backticks, `$`, quotes, newlines-with-pipes),
it belongs in a file you LINK, not in the body you paste.

Product backstop (defense-in-depth, NOT a substitute for this discipline):
`rig queue show` oversized-body truncation/preview is tracked separately
as slice OPR.0.4.1.3. The behavioral rule here is the primary, durable
cure; the product truncation is the safety net.

## Failure modes (6; verbatim)

1. Agent ends a turn without a handoff, so the rig appears idle.
2. Agent creates a queue item with `--no-nudge` inside a live loop, intending suppression of attention but breaking immediate motion. `--no-nudge` is for intentional cold park / human gate, not for routine live-loop handoffs. The opposite footgun — adding a `--notify` flag that does not exist on the shipped 0.3.1 CLI — comes from following stale instructions; the default already nudges.
3. Queue item is too small and turns work into bureaucracy.
4. Queue item is too broad and loses ownership, proof, or closure criteria.
5. Human escalation happens in chat but not as a durable attention item.
6. Agent pastes a large command dump (ps/nodes, big JSON, proof blob) into the qitem body, bloating the stored DATA so every future `rig queue show --json` read is huge. Link the proof PATH or summarize in prose; substantive bodies go through `--body-file`; no raw backticks inline.

## Durable handoff field shape

Every qitem carries:

- `handed_off_to` — destination session (qualified `pod-member@rig` form)
- `handed_off_from` — source session
- `state` — one of: `pending | in-progress | done | blocked | failed | denied | canceled | handed-off`
- `closure_reason` + `closure_target` — set on terminal closure per hot-potato rule

**(0.5.0) `--body-context <ref>` — context riding the handoff.** `rig queue create … --body-context <ref>` attaches a composed context pack to the qitem. The snapshot rule: the qitem stores the **resolved content** in its body **plus the ref for provenance** — the handoff carries what was actually sent, and a later edit to the library never silently rewrites a past handoff's history. (The `rig context` noun composes the ref; the queue delivers it — the noun has no send.) See `openrig-user` → "Context packs and paced delivery."

The fields are auditable across both `rigx queue` (config-layer) and
`rig queue` (daemon-shipped) surfaces. Watchdog policies and workflow
runtime project new owners off these fields.

## Two surfaces (same shape)

| Surface | Status | When to use |
|---|---|---|
| `rig queue ...` (daemon-shipped, v0.2.0) | Active host coordination surface | Daemon-backed PL-004 work; SQLite-canonical |
| `rigx queue ...` (config-layer dogfood) | Coexists with daemon | Workflows still operating on the temporary substrate coordination layer; legacy artifacts |

Default posture: prefer daemon `rig queue` for new work. If a
daemon-backed coordination command fails, debug the command/runtime/schema
edge directly — don't fall back to stale pre-upgrade assumptions.

## See also

- `looping-workflows` skill — operating discipline for self-driving rig-shaped loops; queue-handoff is its current handoff substrate
- `intake-routing` skill — how raw signals enter the system and become routed work that flows through the queue
