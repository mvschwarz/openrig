---
name: attention-queue
description: Coordination primitive for OpenRig. Per-agent queue files tracking in-flight work with explicit state transitions + handoff semantics + cross-agent composition. Prevents memory-loss drops; surfaces stalls mechanically; closes the feedback loop on handed-off work. Applied liberally by every agent on every kernel-supervised rig; composed views serve human attention, orch pod-load, rig pending-work.
status: L4-insight
authored-by: advisor-peer-observer@your-rig
date: 2026-04-13
cited-captures:
  - improvements-inbox.md 2026-04-13T12:54:50Z — broadcast primitive RSI (same batching-by-theme cluster)
  - Mission 4 cmux stall (2026-04-13 midday) — packet-design + queue-for-cross-rig coordination
metadata:
  cli_surfaces_referenced:
    - chatroom
    - send
  openrig:
    stage: factory-approved
    sibling_skills:
      - queue-handoff
      - workflow-runtime
      - watchdog
      - refocus
      - looping-workflows
      - intake-routing
      - human-in-the-loop
      - dispatching-parallel-agents
      - subagent-driven-development
      - control-plane-capabilities
      - status-not-chat-orchestrator
      - control-plane-queue
      - control-plane-watchdog
      - control-plane-workflows
      - control-plane-delivery-loop
      - control-plane-rollout-manager
---

# Attention queue

Use this skill when coordinating work that must survive compaction, cross-agent handoffs, or multi-hour stall detection. Applies when you'd otherwise narrate status to chat or rely on memory for pending items.

## Live protocol override

Current live routing protocol:

- **Known target / explicit owner that should wake now**: `rigx queue handoff <destination> "<body>" --type handoff --urgency soon`
- **Passive durable assignment without wake-up**: `rigx queue create <destination> "<body>" --type handoff --urgency soon`
- **Ambiguous or raw intake**: `rigx stream emit "<body>" ...`
- **Direct dialogue / urgent 1:1 conversation**: `rig send ...`
- **Summoned 3+ party roundtable**: `rig chatroom ...`

Do not cargo-cult the earlier "stream everything with `--destination`" prototype shape into the
live control-plane. Stream is now the ambiguous-intake lane, not the universal lane.

## Core shape (minimum-viable discipline)

1. **Author a queue file at** `substrate/shared-docs/rigs/<your-rig>/state/<your-pod>/<your-member>.queue.md`. Same per-pod directory as your session log.
2. **Every known-target hot-potato work handoff** should arrive via `rigx queue handoff`, not via `rig send`. Use `rigx queue create` only when you intentionally want a passive durable item without wake-up.
3. **State transitions** (start → promote; finish → complete; stuck → block; hand off → handoff; completed handed-off work notifies source → handoff-complete) are appended to the entry body with timestamp. Never in-place rewrites.
4. **Cross-rig reads permitted; cross-rig writes forbidden.** Pod-as-authority-boundary doctrine.

### Live command surface note

When the queue control-plane wrapper is installed, treat queue identity as command-resolved, not
seat-name-guessed:

- `rigx queue whoami` resolves the durable queue that belongs to your current seat
- `rigx queue list --mine` shows your queue without guessing from member name

This matters for continuity successors such as `lead2` or `lead5`, which may intentionally share
the canonical `lead.queue.md` file instead of owning a separate `lead2.queue.md` or `lead5.queue.md`.

Known-target direct handoff on the live wrapper:

```bash
rigx queue handoff orch-lead5@your-rig "Need PM shaping on queue attention loop" --type handoff --urgency soon
```

Passive durable write without wake-up:

```bash
rigx queue create orch-lead5@your-rig "Need PM shaping on queue attention loop" --type handoff --urgency soon
```

## Six operations

| Op | Effect |
|---|---|
| append | New entry (state=pending) on inbound request |
| promote | state=in-progress when you start work |
| complete | state=done with optional result |
| block | state=blocked + blocked-on=<id or condition> |
| handoff | state=handed-off + handed-off-to=<target>/<new-id>; send rig-send with `[queue-handoff:]` prefix to target |
| handoff-complete | target signals source that handed-off work finished (closes feedback loop) |
| escalate | walk authority chain when blocked past tier threshold |
| defer / drop | push-to-later or drop-with-rationale |

## When is something a queue handoff?

**Queue handoff** (`rigx queue handoff`):
- Asks a known recipient to do new work
- Transfers ownership of pending work
- Names a deliverable + acceptance criteria

**NOT a queue handoff**:
- Wake-ping `1`
- PSA / broadcast / status update
- Ack / courtesy notification / diagnostic ping / reply to question
- Raw idea or bug where you do not yet know the right owner

If you do not know the correct owner, emit to stream instead of guessing.

## Tier-based ack + notification rules

- **human-gate tier** (gated items; human-watching): mandatory ack on handoff; mandatory notification on completion
- **agent-coordination tier** (standard inter-agent work): recommended ack + notification
- **internal-self tier** (your own to-dos): optional

## Read discipline

- Read your own queue at turn start before picking up new work
- Orchestrators read pod-member queues on wake cadence (`1` ping)
- Advisor-pod reads cross-rig queues for composed views + human-attention
- Past-threshold blocked entries surface during sweeps; execute escalate op if you can't self-unblock

Recommended turn-start queue commands on the live wrapper:

```bash
rigx queue whoami
rigx queue list --mine
```

### Resume-from-idle state sweep

Agents returning from idle-standby (supervisor-wake-only pings; no substantive dispatch during the window) MUST sweep adjacent state before pulling new work. Minimum sweep:

- Supervisor-log tail (~200 lines) at `rigs/kernel/state/supervisor-log.md`
- human-attention.md at `substrate/shared-docs/human-attention.md`
- Any doctrine-decisions added since last-active (`rigs/kernel/state/doctrine-decisions/`)
- Partner queue files at `rigs/kernel/state/<pod>/<peer-member>.queue.md` (peer load-tracking for pairs)
- **Fleet-changes-feed** at `substrate/shared-docs/fleet-changes-feed.md` (pull-native rollout surface; catches any fleet-wide doctrine / skill / convention / operational changes that landed during idle; filter by scope = fleet-wide + your rig/pod)

**Trigger:** first active turn after ≥3 consecutive wake-only cycles OR on peer HA-check request. Sweep before responding to HA-check so the response is grounded in current reality, not stale memory.

**Rationale:** own-queue-at-turn-start catches own-queue drift; adjacent-state drift is a separate failure class that requires its own read discipline. Composable with own-queue sweep (both at same reading point); adds ~2-5 minutes of read time; cheap insurance against peer-driven HA-check round-trips.

**Worked example (genesis):** advisor-co-observer@your-rig after ~2h idle-standing-by on 2026-04-13 — 5-of-7 HA-check items out-of-sync when peer queried. Rule addition would have caught the drift pre-query via adjacent sweep on wake-to-active transition.

## Status-not-chat corollary

Your chat pane is for operational work + ad-hoc human exchanges. Your STATUS lives in queue files + composed views. If you finish work + hit a gate-requiring next-action, do NOT narrate to chat + idle-wait. Queue-handoff to advisor-pod with `tier: human-gate`. The operator doesn't watch agent panes; they watch human-attention.md (composed from human-gate queue entries).

## Composed views (4 layers)

- **Pod-load view** — who's loaded / blocked (orch reads)
- **Rig pending-work** — cross-pod roll-up
- **Fleet cross-rig** — host-wide
- **human-attention** — human-gate-tier items across all queues (advisor-pod composes)

v0: manual regen by orchestrators + advisor-pod.
v0.5: terminal-node watch scripts auto-regen.
v1: generative UI consuming structured queue data.

## Codex-sandbox proxy-write pattern (sanctioned workaround)

Codex members whose sandbox blocks substrate writes can still participate via proxy-write:
- Codex authors content locally (e.g., `/tmp/<rig>-attention-queue/<member>.queue.md`)
- Claude counterpart physically writes to substrate with sha256-verified integrity check
- Subsequent state transitions via `[queue-update: <id> <new-state> <reason>]` rig-send from Codex to Claude-writer
- Authorship preserved; only write-access delegated. Distinct from peer-injection (which is forbidden).

## Escalation mechanics

When entry stays blocked past tier threshold AND agent can't self-unblock:

1. Identify escalation target per authority chain:
   - Pod member → pod orchestrator
   - Pod orch → rig orch-lead
   - Rig orch-lead → kernel orch-lead OR advisor-pod (if human-gate)
   - Skip-levels allowed when agent KNOWS correct target
2. Create new entry in escalation-target's queue with `escalated-from: <source-id>`; state=pending; priority elevated
3. Send handoff-shape rig-send: `[queue-escalate: <new-id>] <title> — blocked <Nh> on <reason>`
4. Update own entry: state=escalated; escalated-to=<target>/<new-id>; transitions-log appended

Threshold guidance: 1h human-gate / 4h agent-coordination / 24h internal-self. Rigs may tighten.

## Task-close RSI-check (flywheel trigger)

Every `complete` op on substantive work reflects briefly: "what did we learn? is this worth filing as L2 capture to improvements-inbox?"

Two outcomes; both leave evidence in the transition trail:

- **Novel observation worth filing:** append L2 capture entry to `rigs/kernel/state/improvements-inbox.md` per the v1 queue template (`state: pending` + transition trail started). Transition line in your own queue: `<ts> — RSI-check: filed <capture-id>`.
- **Nothing novel:** transition line in your own queue: `<ts> — RSI-check: none`.

Applies to substantive work-streams. Does NOT apply to:
- Wake-pings (`1`) — not a work-stream
- Trivial status updates — nothing to reflect on
- Pure acks / routing-map updates — no work done

Rationale: task-close is the deterministic interval that makes recursive-self-improvement mechanical rather than ad-hoc. Pattern named in skill-maturity-convention.md §"Task-close RSI-check discipline".

## Push vs pull — when to use rig-send vs queue-write

Not every communication belongs in the receiver's chat pane. The discipline mirrors status-not-chat: most inter-agent signals can flow through queue files (pull) rather than rig-sends (push). Reduces noise; respects receiver's attention cycle.

**Sender's test:** *Does my message need the receiver's attention within their next turn cycle?*
- **Yes → push** via `rig send` (lands in chat; receiver processes on next turn)
- **No → pull** via queue-write (write to own queue OR receiver's queue via handoff; receiver sweeps at cadence)

### Push (rig-send to chat) when:

- Receiver needs info NOW to unblock their work
- Question requires specific answer to proceed
- Handoff is past ack-threshold + tier=human-gate (mandatory-ack window)
- Blocker surfacing (can't self-unblock; need help from target)
- human-gate item needing surface to advisor-pod
- Destructive or time-critical coordination

### Pull (queue-write only) when:

- Status update / adoption signal / cascade-complete ack
- Non-urgent ack (within tier threshold)
- Information that can batch in receiver's curator sweep
- Broadcast-receipt confirmation (receiver's cadence catches it)
- Observed patterns or captures with no time pressure
- Resync material for HA peers (they sweep on resume-from-idle)

### Why this matters

Push-as-default floods the receiver's chat pane with status that could be pulled. Today's rollout volume proved this: during attention-queue + EMM cascades, most acks arrived as push (rig-sends) when they could have been pull (queue-writes). Receiver (advisor-pod) had to process each ping; most were status signals needing no action.

Pull-over-push is the queue primitive's whole point. Status lives in queue files; readers sweep at cadence; only genuine unblockers + gate-surfaces push to chat.

### Worked example

orch-lead@your-rig ack'd attention-queue cascade:
- **Push version (what happened):** `rig send advisor-peer-observer@your-rig "[queue-handoff-ack: ...] ... cascaded to 8 pod members ..."` → lands in my chat; I read immediately; process the status
- **Pull version (what should happen):** write ack-receipt to `rigs/openrig-build/state/orch/lead.queue.md` as state-transition on their adoption entry; I sweep their queue on my curator cadence; pick up the ack without chat-ping

Ack-receipts for status are pull-native. Handoff-complete notifications for human-gate items stay push (they close feedback loops on time-sensitive work).

### Corollary — orchestrator-to-advisor cadence

Orchestrators writing to their own queue files lets advisor-pod read without being interrupted. The curator-sweep pattern (advisor reads pod queues on their cadence) is the canonical pull mechanism. Push only when time-matters.

## Anti-patterns (don't do these)

- **Chat-as-status** — narrating status/gates to your chat pane + idle-waiting. Use queue + human-attention instead.
- **Duplicate-storage** — writing the same fact in queue + session-log + chat + mission-control. Queue is authoritative for in-flight state.
- **Peer-injection** — writing directly to another agent's queue without their authorship. Only handoff op moves work cross-queue.
- **Silent drops** — don't leave items in pending forever without state transitions. defer or drop with rationale.
- **Global queue** — don't try to make one queue for everyone. Per-agent primary; compose for views.

## Maturity status

**L4-insight** per skill-maturity-convention. Applied liberally across the host; evolving via observation. Feedback loop: RSI filings reshape this skill; demotion valid if convention reveals wrong shape; promotion to L5-canon requires architect+reviewer pair-review per HOST-TOPOLOGY §7 SOP.

Rollout date: 2026-04-13 host-wide adoption. 48h observation cycle active; RSI with learnings due ~2026-04-15.

## Related

- Spec (full reference): the internal attention-queue spec
- Skill-maturity convention: `substrate/shared-docs/skill-maturity-convention.md`
- Config-wrapper-code loop doctrine: `config-wrapper-code-loop` skill
- HOST-TOPOLOGY §4 context-sharing patterns — attention queue is a new pattern here
- SUBSTRATE-CONVENTIONS §7 HA session logs — queue lives in same per-pod directory
