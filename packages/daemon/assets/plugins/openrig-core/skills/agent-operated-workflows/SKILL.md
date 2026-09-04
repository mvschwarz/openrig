---
name: agent-operated-workflows
description: >-
  Use when a bounded real-world procedure has a deterministic happy path but brownfield, variable,
  or partially knowable state; when an operation must resume from verified evidence; or when deciding
  whether agent judgment or ordinary code should own a procedure's control loop.
metadata:
  openrig:
    stage: provisional
    audience: any agent operating or designing a bounded procedure
    sibling_skills:
      - agent-operated-software
      - openrig-user
      - systematic-debugging
---

# Agent-Operated Workflows

An **Agent-Operated Workflow** is a bounded procedure whose control loop belongs to an agent. The
agent observes, interprets, sequences bounded actions, verifies their effects, adapts, and escalates
genuine ambiguity. Deterministic code remains the exact substrate; it does not pretend to understand
every state of a brownfield world.

## Name the architecture before using it

- **AI-enabled software:** application code owns the control loop and calls a model as one capability.
- **Agent-Operated Workflow:** an agent owns one bounded procedure with a start and stop condition.
- **Agent-Operated Software:** an OpenRig agent or rig participates in an ongoing application's live
  backend or control loop. It may run many workflows; see `agent-operated-software`.

Calling a model is not enough. A deterministic program that consults a model still owns its loop.

## Decide whether the agent earns the loop

Use an agent when the happy path is deterministic but the environment is brownfield, variable,
partially knowable, or disproportionately expensive to model exhaustively. The judgment is in
discovering what is true and choosing the next safe act.

Prefer ordinary code when the state space is closed and code is simpler and more reliable than
judgment. A parser, fixed data transformation, or fully enumerated state machine does not become
better because an agent drives it.

## Keep ownership explicit

| Owner | Responsibility |
|---|---|
| Runbook | owns policy, the mental model, checkpoints, stop conditions, and escalation rules |
| Deterministic tools | own context gathering and bounded exact actions |
| Agent | owns interpretation, sequencing, adaptation, and effect verification |
| Human | owns destructive ambiguity and product policy |

The runbook guides judgment; tools enforce the invariants that must not be arguable.

## Operate

1. Establish identity, durable state, the runbook, and the promised outcome.
2. Inspect with side-effect-free reads or an explicit plan mode.
3. Choose one bounded action from observed state; do not mechanically replay the happy path.
4. Verify the effect at the consumer or state surface that could prove it wrong.
5. Record an observable checkpoint before moving on, so another agent can resume.
6. Continue, stop at the declared condition, or escalate with evidence and the decision needed.

An interrupted or timed-out mutation is **indeterminate**, never failed by assumption and never safe
to retry blind. Where a compatibility period is safer, separate reversible preparation from the
destructive finalizer. Idempotence is a claim to prove per action, not a label for the whole run.

## Build

Expose composable verbs, not an optimistic end-to-end controller. Help is inert. Read and plan modes
are explicit. Mutations are narrow and independently readable. A failure should say what was
observed, why the tool stopped, what remains unchanged, the safe next choices, and where its evidence
lives. Keep checkpoints durable, effects observable, and recovery possible without private developer
knowledge.

A capability composition is a reusable recipe; this is the execution architecture that operates
capabilities toward an outcome. Promote a proven workflow to the composition shelf only after use.

**Reference implementation:** Release 0.5.9 Slice 05 is the first **Agent-Operated Migration**. Its
runbook and helpers remain there; this skill carries the reusable contract, not a duplicate procedure.
