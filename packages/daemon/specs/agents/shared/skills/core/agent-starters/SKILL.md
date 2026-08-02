---
name: agent-starters
description: Use when creating, refreshing, packaging, inspecting, promoting, or deprecating a named per-seat starting point — Agent Starter manifest authoring, the 6-state lifecycle (captured → named → inspectable → used → promoted → deprecated), provenance honesty, and refusal rules. NOT a VM image; a managed starting point composed from agent role + startup context + optional native session source + provenance.
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# Agent Starters

A named, reusable per-seat starting point. Composes an agent role, startup
context, optional native session source, and provenance into something a
user or rig can choose when creating, refreshing, or packaging a seat.

"Agent image" is the analogy. **Agent Starter is the cleaner product
noun.** This is NOT a VM image — it is a managed starting point for an
agent seat, with provenance you can inspect.

## Use this when

- Creating a new seat from a known-good starting context.
- Refreshing a seat with `rig expand` and `starter_ref`.
- Authoring a new starter (registry entry).
- Inspecting an existing starter's provenance, freshness, or recommended status.
- Promoting / deprecating starters in the registry.
- Composing a starter with a Composable Priming Pack (record manifest id/version, runtime, source session id or transcript path, ready-check evidence, freshness state).

## Don't use this when

- You want VM-style deterministic state capture. Starters don't capture VM state.
- You want to copy provider auth material into a starter. **Starters refer to session sources and context; they do NOT copy credentials.**

## What makes a starter valuable

A starter is valuable when it is **functional** — it carries the context the seat needs to do its task well. Functional is the *only* measure of a good starter. Size is not: a smaller starter is not a better one, and a bigger one is not worse. Whatever it took for the seat to become genuinely capable at its job is the right starter — 80K tokens or 800K.

Capture the seat as it naturally is at a functional, proven point. Don't pad it with context the seat doesn't use, and — just as important — don't strip context out to make it smaller. Size is an *outcome* of what the seat needed, never a target.

Never compact, summarize, or shrink a seat in order to make or "lean" a starter. There is nothing valuable in "smaller," and compaction is lossy — you would trade away the exact capability the starter exists to preserve. (Compaction is a separate last-resort step for a seat genuinely near its context limit, with its own before/after plan — never part of capturing a starter.)

## State model — 6 states

1. **Captured** — a useful seat/session/context pattern is identified.
2. **Named** — it becomes an Agent Starter with stable id and owner.
3. **Inspectable** — runtime, context inputs, session source, and provenance are visible.
4. **Used** — a rig member or `rig expand` operation starts from it.
5. **Promoted** — evidence shows it is recommended for a role or bundle.
6. **Deprecated** — replaced, stale, unsafe, or incompatible.

## Failure modes (5)

1. **Overclaiming image semantics** — UI/docs imply deterministic VM-style state capture. Say "starter," name what's included, show provenance.
2. **Hidden provenance** — users can't tell what session, context, or spec a starter came from. **Refuse promotion until provenance is inspectable.**
3. **Stale starter** — points at outdated doctrine, missing files, or invalid native session source. **Inspect must report staleness honestly.**
4. **Secret leakage** — starter packages or displays provider auth material. **Refuse.** Refer to session sources and context, never copy credentials.
5. **Runtime mismatch** — starter used with unsupported runtime. **Refuse with a clear error.**

## Manifest shape (v0+v1 shipped)

```yaml
agent_starters:
  - id: velocity-reviewer-v1
    runtime: claude-code
    agent_ref: local:reviewer
    context_refs:
      - doctrine:advisor-orchestrator-mode-judgment
      - convention:workstream-continuity
    session_source:
      mode: fork
      ref:
        kind: native_id
        value: "<prior-native-session-id>"
```

Member usage:

```yaml
members:
  - id: reviewer
    starter_ref:
      name: velocity-reviewer-v1
```

When a starter points at a primed session produced from a Composable
Priming Pack, record:
- manifest id/version
- runtime
- source session id or transcript path
- ready-check evidence
- freshness state

## Proof matrix

| Surface | Test type | Authority |
|---|---|---|
| Registry schema accepts minimal starter | unit | daemon or config-layer prototype |
| Inspect shows provenance and included context | unit / snapshot | daemon or CLI |
| Member can use `starter_ref` | integration | daemon |
| Unsupported runtime or stale source refuses honestly | unit + integration | daemon |
| No secret material copied into starter artifact | grep / fixture | tester |
| Bundle can include or reference starter | package inspection | bundle layer |

## Dependencies on other primitives

- **Firm**: `session-source-fork` — native conversation-source continuity for fork-based starters
- **Firm**: `specification-system` — declarative starter and member references
- **Soft**: `rig-bundles-and-shareable-artifacts` — shareable starter packaging
- **Soft**: `context-engineering-and-retrieval` — richer declarative context assembly
- **Soft**: `seat-continuity-and-handover` — refresh and swap workflows over starters

## Required-before-RSI

Agent Starters need queryable provenance and honest inspect output before
RSI loops can rely on them for seat refresh. A workflow must be able to
answer: "what starter did this seat use, what source session or context was
included, and is that starter still recommended?"

## See also

- `session-source-fork` skill — low-level fork primitive that makes native session-based starters possible
- `composable-priming-packs` skill — manifest-driven layer for producing primed sessions starters reference
