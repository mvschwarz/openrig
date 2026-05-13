---
name: queue-handoff
description: Use when ending a turn, finishing a slice, blocked on another agent's work, or escalating to a human — durable work handoff via queue items so the system keeps moving across compactions, missed messages, and interruptions. Covers the hot-potato terminal-turn-rule (active work ends by passing the ball, not by going idle), default-nudge semantics, and when --no-nudge or --notify is required.
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Daemon-backed `rig queue` shipped in v0.2.0 (PL-004 Phase A) with handed-off-to / handed-off-from / state field shape. `rig queue` is canonical for new work; `rigx queue` is recovery-only fallback. The daemon enforces hot-potato strict-rejection at the API.
    sibling_skills:
      - workflow-runtime
      - watchdog
      - alignment-trace
      - looping-workflows
      - human-in-the-loop
      - attention-queue
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
    transfer_test: pending
---

# Queue Handoff

> **CANONICAL SURFACE NOTE (2026-05-11)** — `rig queue` (daemon-backed SQLite) is the
> canonical surface for all substantive work routing. `rigx queue` (filesystem v0
> prototype) is **recovery-only fallback**; qitems written via `rigx queue` are
> invisible to daemon-backed reads and break fleet-wide routing discipline.

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

## Default-nudge semantics (the syntax footgun)

| Command | Nudges by default? | When to use |
|---|---|---|
| `rig queue create` | yes | New qitem created from scratch |
| `rig queue handoff` | yes | Transactional close-as-handed-off + create-new |
| `rig queue handoff-and-complete` | **no — requires `--notify`** | Inside a self-driving loop where motion matters |
| `rigx queue handoff` (filesystem v0 prototype; **recovery-only fallback since 2026-05-11**) | yes | Legacy artifact; qitems invisible to daemon-backed reads. Use `rig queue handoff` for all new substantive work. |

**Footgun**: `handoff-and-complete` is cold unless `--notify` is passed.
In a self-driving loop, an agent that closes with
`handoff-and-complete` (no `--notify`) writes a durable qitem but does
NOT wake the next owner — the rig stalls silently while the qitem sits
in inbox.

**Rule**: in a live loop, use `handoff-and-complete --notify` OR send
a separate verified manual nudge. `--no-nudge` exists but should be
used intentionally (e.g., explicit park or human-gate signal), not as
an accidental stall.

## Failure modes (5; verbatim)

1. Agent ends a turn without a handoff, so the rig appears idle.
2. Agent creates a queue item but suppresses or forgets the nudge when immediate motion was intended. This includes `handoff-and-complete` without `--notify` inside a live loop.
3. Queue item is too small and turns work into bureaucracy.
4. Queue item is too broad and loses ownership, proof, or closure criteria.
5. Human escalation happens in chat but not as a durable attention item.

## Durable handoff field shape

Every qitem carries:

- `handed_off_to` — destination session (qualified `pod-member@rig` form)
- `handed_off_from` — source session
- `state` — one of: `pending | in-progress | done | blocked | failed | denied | canceled | handed-off`
- `closure_reason` + `closure_target` — set on terminal closure per hot-potato rule

The same field shape exists in legacy `rigx queue` artifacts and the daemon-shipped
`rig queue` surface, but new queue reads and writes should use `rig queue`. Watchdog
policies and workflow runtime project new owners off these fields.

## Two surfaces (same shape)

| Surface | Status | When to use |
|---|---|---|
| `rig queue ...` (daemon-shipped, v0.2.0) | Active host coordination surface | Daemon-backed PL-004 work; SQLite-canonical |
| `rigx queue ...` (filesystem v0 prototype) | Recovery-only fallback | Legacy recovery for artifacts that have not migrated; not for new substantive work because daemon-backed reads cannot see those qitems |

Default posture: prefer daemon `rig queue` for new work. If a
daemon-backed coordination command fails, debug the command/runtime/schema
edge directly — don't fall back to stale pre-upgrade assumptions.

## See also

- `looping-workflows` skill — operating discipline for self-driving rig-shaped loops; queue-handoff is its current handoff substrate
- `rig queue --help` — full CLI surface for queue items, handoffs, and closure-reason discipline
