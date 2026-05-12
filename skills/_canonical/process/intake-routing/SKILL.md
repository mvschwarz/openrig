---
name: intake-routing
description: |
  Use when turning raw signal (idea, bug, observation, feature request, runtime event) into durable, discoverable, selectable work — without dispatching it as an immediate task. Covers the universal-capture / dedicated-processing motion across stream/intake/queue/view/PROGRESS.md, signal-card relationship words (new, duplicate, extends, refines, conflicts-with, part-of, supersedes, blocked-by, evidence-for), spectrum defaults per signal shape, product-primitive request routing, promotion rules, and the dedicated intake seat.
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Authored 2026-05-03 as part of the convention-pointer sweep batch 2.
      Content moved verbatim from openrig-work/conventions/intake-routing/README.md
      (active, updated 2026-04-30).
    sourced_from:
      - openrig-work/conventions/intake-routing/README.md
    related_skills:
      - agent-feedback-stream (sibling — one specific channel of intake)
      - work-discovery-and-slice-shaping (downstream — how curated intake becomes work)
      - durability (companion — what it means for an artifact to be durable)
    sibling_skills:
      - workstream-operating-modes
      - workstream-continuity
      - workspace-root-and-repo-context
      - branching-orientation
      - looping-workflows
      - work-discovery-and-slice-shaping
      - feature-rollout
      - feature-lifecycle
      - config-wrapper-code-loop
      - queue-handoff
      - workflow-runtime
      - watchdog
      - alignment-trace
      - human-in-the-loop
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
    transfer_test: pending
---

# Intake Routing

Intake routing is the motion that turns raw signal into durable,
discoverable, selectable work without treating every idea as an
immediate task.

## When to use this skill

- A raw signal arrives (idea, bug observation, feature request,
  runtime event) and you need to know where to put it
- You're an intake steward processing signal cards in batches
- You're an orchestrator deciding whether to dispatch from intake
  (don't) vs route to durable shelf
- You're classifying relationship between a new signal and existing
  artifacts

NOT for: dispatching work directly (signals must be selected, not
pulled from intake). NOT for: shaping the actual slice or candidate
(that's `work-discovery-and-slice-shaping`).

## Disaster Recovery Test

A blank-slate agent that receives a raw idea, bug, observation, or
feature request should be able to start at
`openrig-work/README.md`, find this skill, preserve the signal,
classify it, route it to the right shelf, and **avoid dispatching it
until it is selected.**

## Core Motion

```text
runtime event or raw signal
  -> rigx stream when it is live/ambiguous/runtime-originated
    -> rigx project or intake steward classification
      -> curated intake when it has project meaning
  -> compare against existing shelves
    -> classify relationship and scale
      -> route to owning artifact or planning home
        -> promote only when mature enough
          -> select into PROGRESS.md only when it becomes active or next work
```

The principle is **universal capture, dedicated processing**:

- Any agent can capture a signal quickly, then return to its main flow.
- The intake steward curates intake in batches when one exists.
- Planner synthesizes ambiguous or product-sized items.
- Orch selects work into the conveyor and protects human intent.
- Human decides product direction, priority conflicts, and large bets.

If no intake steward exists, **orch owns intake processing by default**.
The intake seat is a processor, not a gate: signals should not be lost
just because the dedicated seat is offline.

## Stream, Intake, Queue, View, Progress

> **CANONICAL SURFACE NOTE (2026-05-11)** — for queue ownership and routing, use
> `rig queue` (daemon-backed SQLite). `rigx queue` is recovery-only fallback;
> qitems written via `rigx queue` are invisible to daemon-backed reads and break
> fleet-wide routing discipline.

Use the coordination layers for different jobs:

- `rigx stream` records **what happened**. Raw, append-only runtime
  intake.
- `openrig-work/intake/` records **what a signal means** for the OpenRig
  project after curation.
- `rigx queue` records **who owns the next action**.
- `rigx view` projects stream, intake, queue, and activity state for
  operators. **It is not truth.**
- `PROGRESS.md` records **selected active or next work** at the right
  hierarchy level.

Practical defaults:

- If the owner is unclear or the agent should stay in flow, emit a
  stream item.
- If the signal needs durable project meaning, create or update an
  intake signal card.
- If the next owner is known and action is needed, use queue.
- If the work is selected for the conveyor, update the relevant
  `PROGRESS.md` and slice packet.

The loop closes when proof or closeout emits back into the coordination
substrate and any follow-up signal is routed through this skill instead
of being buried in chat, transcript, or queue body.

Related queue/control-plane doctrine:

- `substrate/shared-docs/control-plane/services/queue/docs/stream-first-architecture.md`
- `substrate/shared-docs/control-plane/services/queue/docs/intake-curate-contract.md`
  — 9-field provenance contract every `rigx intake curate` outcome
  file must carry (Pilot A vertical shipped 2026-05-01 at substrate
  `454d69d`).
- `substrate/shared-docs/control-plane/services/queue/docs/intake-audit-chain.md`
  — multi-command audit-chain recipe walking L1 stream JSONL → L2
  intake YAML → L4 queue projection → L5 view → outcome inspection.

## Signal Cards

Use a lightweight signal card when a raw item needs more than one line.
Do not build a complex graph. Use a few relationship words and concrete
paths so agents can infer the right next action.

Common relationship words:

- `new` — distinct concept.
- `duplicate` — already captured; link and close.
- `extends` — builds on an existing artifact.
- `refines` — sharpens wording, scope, or doctrine.
- `conflicts-with` — contradicts an existing decision or design.
- `part-of` — belongs under a larger umbrella.
- `supersedes` — replaces an older idea or convention.
- `blocked-by` — cannot move until another primitive or decision exists.
- `evidence-for` — supports an existing idea but is not itself new work.

Prefer full paths for `Target`, `Routed-to`, and `Planning-home` unless
a relative path is intentionally showing local hierarchy.

## Spectrum Defaults

| Signal shape | Default route |
|---|---|
| Tiny bug observation | `intake/bugs-inbox.md`; promote to mission/slice only when reproducible or selected |
| Field observation | `intake/` first; promote to `field-notes/` when narrative evidence matters |
| Reusable work principle | `intake/` first; promote to `conventions/` or `doctrine/` when pattern-shaped |
| Small feature | Existing mission `planning/slice-candidates.md` when coherent; slice packet only when selected |
| Primitive-shaped idea | `primitives/<category>/<name>.md` plus mission planning candidate |
| Product-sized feature | Field note or product brief first; maybe a new mission; decompose later |
| Conflict | Route to the owning artifact and record the conflict; human/planner/orch decision before promotion |
| Part of a whole | Add to the parent artifact or planning home instead of making a top-level artifact |

## Product Primitive Requests

When a feature request is already evidence-backed and primitive-shaped,
file it as a **candidate packet** instead of leaving it only in chat or
raw intake.

Use direct candidate filing when the request has:

- a named primitive or product capability;
- evidence from a live run, dogfood pass, proof artifact, or repeated
  failure mode;
- enough current-state context that Product Lab can start a forensic
  trace or synthesis without reconstructing the idea from transcript
  memory;
- a clear relationship to existing primitives, conventions, or
  lifecycle loops.

For RSI v2, put those packets in:

`substrate/shared-docs/openrig-work/missions/recursive-self-improvement-v2/work-discovery-and-slice-shaping/candidates/`

The candidate should include frontmatter fields for status,
classification, relationship, ranking, suggested mode, validation
needs, and whether forensic trace is required. A queue notice may wake
the loop head, but **the candidate file is the durable handoff**. Do
not dispatch implementation directly from the feature request.

If the idea is still raw, ambiguous, or mostly philosophical, put it in
`intake/signals/`, `intake/ideas-inbox.md`, or `rigx stream` first and
let Discovery shape it.

## Promotion Rules

- Preserve raw input before interpreting it.
- Search existing shelves before creating a new artifact.
- Prefer extending or refining an existing artifact over creating a new
  one.
- Create a new artifact only when the idea has its own durable identity.
- **Do not dispatch from intake.**
- Do not put an item in `PROGRESS.md` until it is selected work.
- Leave a routing note so a blank-slate agent can reconstruct why it
  went there.

## Dedicated Intake Seat

A dedicated intake seat is useful when signal volume is high or
delivery agents are in flow. Its job is to process in batches:

1. read new cards and inbox entries;
2. dedupe against existing shelves;
3. classify relationship and scale;
4. route or promote with backlinks;
5. update `openrig-work/intake/PROGRESS.md`;
6. escalate only priority, conflict, or product-direction questions.

Urgent safety issues and clear active-work blockers can bypass batch
processing and go straight to orch.

## See also

- `agent-feedback-stream` — sibling for the specific feedback-stream
  channel.
- `work-discovery-and-slice-shaping` — downstream, how curated intake
  becomes shaped work.
- `durability` — what it means for an artifact (intake or otherwise) to
  be durable.
- The convention pointer at
  `intake-routing` skill.
