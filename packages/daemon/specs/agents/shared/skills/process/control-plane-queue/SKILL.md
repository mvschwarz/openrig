---
name: control-plane-queue
description: Operational skill for the queue control-plane. Use when you need durable known-target handoff, stream intake, queue identity resolution, or the queue/view command surfaces.
status: L4-insight
authored-by: orch-peer@openrig-pm
date: 2026-04-21
canonical-artifact: substrate/shared-docs/control-plane/services/queue/README.md
---

# Control-plane queue

> **CANONICAL SURFACE NOTE (2026-05-11)** — `rig queue` (daemon-backed SQLite) is the
> canonical surface for all substantive work routing since the 2026-05-11 host-CLI
> fix landed. `rigx queue` (filesystem v0 prototype) is **recovery-only fallback**.
> Where this skill says `rigx queue`, prefer `rig queue` — the command shape is
> identical (`rig queue create`, `rig queue handoff`, `rig queue update`,
> `rig queue show`, `rig queue list`, etc.). qitems written via `rigx queue` are
> invisible to daemon-backed reads (`rig queue show <id>` returns `qitem_not_found`);
> fleet-wide routing discipline requires the daemon surface.

Use this skill when you need the queue control-plane as an operational surface rather than just the doctrine of attention queues.

This skill is about the command surface and service boundary.
If you need the broader coordination doctrine, also read:

- `skills/WIP/attention-queue/SKILL.md`

## What this service owns

The queue service owns:

- `rigx stream ...` for ambiguous/raw intake
- `rigx project ...` for intake-worker classification
- `rigx queue ...` for direct handoff, queue identity, and queue inspection
- `rigx view ...` for aggregate or composed views such as `recently-active`

Canonical artifact:

- `control-plane/services/queue/README.md`

New contributor architecture primer:

- `control-plane/services/queue/docs/stream-first-architecture.md`

## Stream-first mental model

Use this rule before choosing a command:

- `rigx stream` is the immutable intake/audit root for ambiguous observations.
- `rigx project` is the classifier/projection worker lane.
- `rigx queue` is durable owned work and known-target handoff.
- `rigx view` is an operator projection, not a new source of truth.

Do not send known-owner work to stream just because stream is easy. Use `rigx queue handoff`
when a hot potato should wake the next owner.

## Use the right lane

### Known owner

If you know who should own the work:

```bash
rigx queue handoff orch-lead@openrig-pm "Need PM shaping on this finding" --type handoff --urgency soon
```

Passive durable write without wake-up:

```bash
rigx queue create orch-lead@openrig-pm "Need PM shaping on this finding" --type handoff --urgency soon
```

### Consumed passive report

If the queue item was informational only and you have already read and absorbed it, do not leave
it `pending`.

Use:

```bash
rigx queue update <id> \
  --state done \
  --transition "<timestamp> — absorbed; no further action"
```

This applies to things like:

- loop reports
- observational updates
- routing confirmations

`done` is the right state here. The item has been truthfully discharged; it just did not create
follow-on work.

### Unknown owner

If the correct owner is not yet clear:

```bash
rigx stream emit "Queue attention still feels too manual" --type idea --urgency normal
```

To move old daily stream files out of the hot path without deleting the audit root:

```bash
rigx stream archive --older-than 7 --dry-run
rigx stream archive --older-than 7 --apply
```

Always dry-run first. Archive moves whole `YYYY-MM-DD.jsonl` files into
`~/.openrig/stream/archive/` and refuses overwrite conflicts.

### Worker-only lane

`rigx project` is the intake-worker/classifier lane.
Do not use it casually for normal coordination unless you are explicitly doing classifier work.

## Identity resolution

Do not guess your queue file from your seat name if continuity successors are in play.

Use:

```bash
rigx queue whoami
rigx queue list --mine
```

This matters for seats like `lead2` or `lead5` that intentionally resolve to a canonical base queue file.

## When you need recency, not backlog

If the question is "what moved recently?" rather than "what is pending on one queue?", use:

```bash
rigx view show recently-active
rigx view show recently-active --rig openrig-pm --limit 20
```

This is the queue-based recent-live-work surface.

Do not confuse it with:

- `rigx queue list --rig <rig> --state pending` — broad backlog scan
- `rigx view show activity` — intake-processing activity, not live queue work
- `rigx view show recently-active --rig <rig> --limit N` — focused recency scan for one topology

Built-in `rigx view` scans exclude obvious fixture/test rigs by default. If you are debugging
fixture state on purpose, opt in explicitly:

```bash
OPENRIG_VIEW_INCLUDE_FIXTURES=1 rigx view show recently-active
```

## When this composes with attention-queue

Use this skill for:

- command choice
- queue service boundaries
- queue identity
- direct handoff mechanics

Use `attention-queue` as well for:

- state transitions
- handoff-complete discipline
- escalation rules
- queue-as-status doctrine

## Reachability

If `rigx` is not resolving, use:

- `docs/setup/rigx-host-setup.md`
- repo-local diagnostic path: `control-plane/commands/rigx/bin/rigx`

Do not silently fall back to older wrappers without understanding the environment.

## Honest limits

- current routing is durable-first and still somewhat permissive
- strict topology-aware validation remains a future daemon-backed step
- queue is the durable work surface, not the same thing as the broader attention doctrine
- the queue surface does not have a special `acknowledged` state today; absorbed informational
  items should be closed with `state=done` plus an explicit transition note
