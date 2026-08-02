---
name: watchdog
description: Use when configuring `rig watchdog` policies, authoring wake/refocus/alignment-checkpoint messages, or choosing the right intervention level for a stale-owner situation. The 3-level continuity-check stack (wake / refocus / alignment-checkpoint), the discipline that prevents cadence pollution and bureaucracy theater, and the artifact-pool loop-edge pattern for evidence-aware waking.
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      # Sibling sweep 2026-07-19 audit: superseded control-plane-* family
      # dropped (control-plane-watchdog now redirects HERE); kept the
      # genuinely adjacent set.
      - queue-handoff
      - workflow-runtime
      - alignment-trace
      - looping-workflows
      - intake-routing
      - human-in-the-loop
      - status-not-chat-orchestrator
---

# Watchdog

Continuity checks are timed or evidence-triggered interventions that
keep an agent workflow from going idle, drifting, or entering needless
bureaucracy. They operationalize the alignment-trace doctrine.

## Use this when

- **Authoring a watchdog policy** for a long-running rig (artifact-pool
  edges, stale-owner detection, periodic reminders).
- **Choosing the intervention level** for a stale-owner situation: is
  this a wake, a refocus, or an alignment checkpoint?
- **Drafting wake/refocus/alignment-checkpoint message text** that
  prevents cadence pollution and bureaucracy theater.
- **Deciding cadence** — scan vs wake intervals, conservative vs
  aggressive nudging.

## Don't use this when

- The agent is actively working and closing artifacts. Prefer no-op.
- The intervention is masking bad startup or workflow design — fix the
  underlying cause, don't compensate via watchdog.
- The work has a clear next-action handoff already in queue. Use queue
  nudges instead of a watchdog policy.

## The 3-level intervention stack

| Level | Goal | When | What it does |
|---|---|---|---|
| **Wake** | Restart motion | Owner appears idle, stale, blocked, or missing a next handoff | Small liveness nudge — does NOT reframe the work |
| **Refocus** | Correct drift | Output shows mode drift, approval regression, weak stop-condition reasoning | Medium alignment nudge — re-centers on role, north star, current approved workstream, coordination mode, stop conditions; does NOT interrupt valid work |
| **Alignment checkpoint** | Rebuild shared map | Phase boundary, lifecycle mutation, product-intent decision, confusing contradiction | Larger deliberate pause — agent runs full alignment-trace before proceeding |

`cron`, timers, and `rig watchdog` are scheduling substrates. They
should NOT imply that every tick means the same semantic action. The
intervention level is chosen by evidence, not cadence.

## Current best practice for refocus message text

A well-shaped refocus message:

- Starts with: **finish current action first**.
- Names the intervention kind: wake, refocus, or alignment checkpoint.
- Names the current approved workstream or says none is known.
- Says what continuity means: continue, verify, hand off, or explicitly park.
- Names stop conditions: scope/risk/posture changes, failed gate, contradictory evidence, or no continuity chain naming a sensible next step.
- Does NOT convert itself into a fresh approval gate.
- Does NOT wake delivery seats unless an approved workflow exists and the owner is stale.

## Failure modes (7; verbatim)

1. Cadence is too frequent and pollutes the workstream.
2. Watchdog wakes the wrong seat instead of the stale owner.
3. Refocus text is too rule-shaped and creates brittle behavior.
4. Watchdog compensates for bad startup or workflow design instead of revealing it.
5. Refocus is misread as a new top-priority task and interrupts the current action.
6. Refocus becomes bureaucracy theater: an already-approved workflow stops for re-approval.
7. Repeated static nudges teach agents to answer the reminder instead of progressing the artifact.

## Artifact-pool loop edges (the first evidence-aware pattern)

The first evidence-aware watchdog use that should remain small and
explicit:

- **Consumer-pool wake**: if a ready artifact exists, wake the consumer loop head.
- **Producer-edge repair**: if upstream completion exists but the downstream artifact is missing, wake the producer loop head.

**Scan cadence and wake cadence are separate.** Worked example (from the
RSI v2 mission, now archived — the numbers are era-specific, the
scan-vs-wake separation is the durable rule): scan every 30 seconds, wake
at most every 600 seconds while work remains actionable.

This is not a generic workflow engine. It's a guardrail against cold
pools and missing edge artifacts.

## Two surfaces: rigx watchdog (config-layer) and rig watchdog (daemon-shipped)

| Surface | Status | Policies |
|---|---|---|
| `rigx watchdog` (config-layer dogfood) | Tmux-backed loops; coexists with daemon | Static periodic-reminder + artifact-pool-ready + edge-artifact-required (per-RSI-loop) |
| `rig watchdog` (daemon-shipped, v0.2.0 Phase C) | SQLite-backed scheduler; survives daemon restart | `periodic-reminder` / `artifact-pool-ready` / `edge-artifact-required` / `workflow-keepalive` (Phase D — reads workflow_instances directly) |

Daemon `rig watchdog` is the active host coordination surface for new
work. History records only loud evaluations (`sent` / `terminal`);
quiet skip reasons are NOT recorded — POC parity so agents are not
woken about scheduler polls.

## Future shape (current limit)

The mature primitive should be evidence-aware: inspect durable
queue/workflow state, pane activity, transcript/context growth, and
known workstream frontier; classify the intervention as no-op / wake /
refocus / alignment-checkpoint; prefer no-op for active owners; render
message text from the active orientation graph instead of hard-coding
static policy.

Until queue substrate, activity state, and lifecycle evidence are fully
productized at this level of granularity: keep config-layer use small
and explicit, prefer one workflow watchdog plus targeted exception
handling over many per-seat nag loops.

## See also

- `alignment-trace` skill — the doctrine this primitive operationalizes; full and light trace templates
- `queue-handoff` skill — durable handoff via queue items; watchdog is complementary (watchdog wakes; queue routes)
- `looping-workflows` skill — operating discipline for self-driving rig-shaped loops; uses watchdog policies for loop edges
