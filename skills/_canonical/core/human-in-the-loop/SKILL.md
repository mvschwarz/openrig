---
name: human-in-the-loop
description: Use when classifying a slice closeout (auto-continue / human gate / park), routing a real decision to a human, or designing a human queue/dashboard surface. Treats humans as durable network participants with attention surfaces, queues, and decision records — escalation lands as a durable attention item, not a chat message. Approval is NOT required for every clean closeout; the default RSI conveyor continues unless an explicit human gate is reached.
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - queue-handoff
      - workflow-runtime
      - watchdog
      - alignment-trace
      - looping-workflows
      - intake-routing
      - attention-queue
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

# Human In The Loop

The primitive that treats humans as **durable network participants** —
attention surfaces, queues, decision records, routing semantics — not
as ad-hoc chat receivers.

**Autonomy is not the absence of humans; it is knowing when human
judgment is needed and making that handoff crisp.**

## Use this when

- A slice closeout needs classifying: auto-continue, human gate, or park
- A real decision needs to land in front of a human (usage limits, provider auth, roadmap tradeoff, product-intent ambiguity)
- Designing a human queue/dashboard surface
- Returning a hot potato to orchestration after human approval

## Don't use this when

- The slice closeout is clean and `PROGRESS.md` already names the next safe slice. **Default RSI conveyor continues; do NOT manufacture a human gate.**
- The escalation is just a status update. Humans are participants for *decisions*, not narration.
- The next owner is another agent. Use queue-handoff, not human-in-the-loop.

## The 3-class closeout classification

In a productized daemon-backed version, closeout classifies the next
step BEFORE touching the human queue:

| Class | When | Action |
|---|---|---|
| **auto-continue** | Slice closes cleanly, next named slice in workstream plan | Mark closed; create next-owner qitem from plan |
| **human gate** | Genuine decision needed (usage limits, provider auth, product-intent ambiguity, roadmap tradeoff) | Create human queue item with proof + decision text + recommended default + action outcomes |
| **park** | Intentionally stop the conveyor (e.g., waiting on external) | Stop with reason + resumption path |

## Failure modes (5)

1. **Human decision needed, but the rig only mentions it in chat.** Decisions belong as durable attention items, not chat messages.
2. **Human queue item lacks enough plain-English context for a decision.** Include proof + decision text + recommended default + action outcomes.
3. **Human response updates a file but does not wake the next owner.** Approval should return the hot potato; feedback should create the next durable qitem.
4. **The dashboard shows too much raw rig state and hides the actual decision queue.** Decision queue is the primary surface; rig state is secondary.
5. **A clean closeout is parked on the human even though `PROGRESS.md` already names the next safe slice.** Don't manufacture human gates.

## Proof standard (both paths)

A trustworthy human-in-the-loop system proves both directions:

- **Blocking gate path**: real item routed to human → human decision recorded through UI → resulting hot-potato handoff wakes correct next owner
- **Non-blocking closeout path**: proof inspectable by human, but orchestrator continues to next named slice without manufacturing a human gate

A primitive that only wakes humans is not trustworthy. It must also know when NOT to.

## Product shape (SHIPPED — Mission Control, PL-005)

This surface has shipped as **Mission Control** (product UI, `/mission-control`
route; actions via `POST /api/mission-control/action`). The seven verbs the
human acts with:
- **approve** (returns the hot potato to orchestration or the chosen owner)
- **deny** (reject the item)
- **route** (send to a different owner)
- **annotate** (add context without action)
- **hold** (intentional pause with reason)
- **drop** (mark not-actionable)
- **handoff** (hand to a specific next owner — creates the next durable qitem)

**Approval returns the hot potato to orchestration or the chosen owner;
feedback creates the next durable qitem rather than only mutating the source
queue file** — enforced by the shipped verbs (handoff/route create qitems).
See `docs/as-built/architecture/mission-control.md`.

## Long-term shape

Likely needs **multiple humans with different scopes**, not a singleton
human attention feed. Different humans own different decision
domains; queue items route by scope.

## See also

- `queue-handoff` skill — durable handoff via queue items; human-in-the-loop is the human-side complement
- `watchdog` skill — when to wake (humans included) vs no-op
- `looping-workflows` (convention) — the looping-workflows convention covers loop closeouts; human-in-the-loop is the escape hatch
