# Edge Types Reference

Last validated against code: 2026-10-07, at the 0.6.6 cut `2620dea8` (whole document at `fcaf1f8e`; its sources unchanged in edge behaviour since then)
Source of truth: `packages/daemon/src/domain/rigspec-schema.ts`, `packages/daemon/src/domain/rigspec-instantiator.ts`, `packages/daemon/src/domain/queue-owner.ts`

---

## Overview

Edges define relationships between members in a rig topology. They appear in two places:

- **Pod-local edges** — between members in the same pod (use unqualified member IDs)
- **Cross-pod edges** — between members in different pods (use `pod.member` format)

See `docs/reference/rig-spec.md` for the YAML syntax.

## Edge Kinds

Five edge kinds are accepted by the pod-aware validator (the legacy flat-node format accepts only `delegates_to`,
`spawned_by` and `can_observe`):

| Kind | Accepted | Has Runtime Behavior | Description |
|------|----------|---------------------|-------------|
| `delegates_to` | yes | **yes — launch order and queue escalation** | Source delegates work to target |
| `spawned_by` | yes | **yes — affects launch order** | Source was spawned by target |
| `can_observe` | yes | no | Source can observe target's output |
| `collaborates_with` | yes | no | Peer collaboration |
| `escalates_to` | yes | no | Source escalates to target |

## What Edges Actually Do Today

### Launch ordering

Only `delegates_to` and `spawned_by` affect runtime behavior. They constrain the order in which nodes are launched:

- **`delegates_to`**: source launches BEFORE target. The delegator must be up before the delegate.
- **`spawned_by`**: target (parent) launches BEFORE source (child). The parent must be up before the child it spawned.

This ordering is enforced in both `PodRigInstantiator` (initial launch) and `RestoreOrchestrator` (restore from snapshot). The code uses topological sort over the dependency graph — if there's a cycle, instantiation fails with `cycle_error` before the rig is created. A `delegates_to` or `spawned_by` edge from a member to itself counts as a cycle. Restore uses the same sort but has no cycle check of its own.

All other edge kinds (`can_observe`, `collaborates_with`, `escalates_to`) do NOT constrain launch order.

### Queue escalation

`delegates_to` also names a seat's orchestrator for the queue: the source of the `delegates_to` edge into a seat. The
wake ladder escalates an unacknowledged row to that orchestrator, and stuck-row findings and recovery go to it. A seat
with no incoming `delegates_to` edge has no default orchestrator. `spawned_by` plays no part here.

### Graph visualization

All edges are rendered in the UI topology graph. They create visual connections between nodes, helping the operator understand the team structure. Pod-local edges appear within the pod group; cross-pod edges connect across groups.

### Identity projection

All edges appear in `rig whoami --json` output under `edges.outgoing` and `edges.incoming`, with their kind and the connected peer's identity. This lets an agent know its relationship to other members — but the agent interprets this information, it's not enforced by the runtime.

### Attach hint heuristic

The post-command handoff (the "Attach:" line after `rig up` and `rig restore`) doesn't use edges. It names the first
node, in creation order, whose session is running, or else the first node with a session name.

## What Edges Do NOT Do Today

Edges do NOT currently:

- **Route messages** — `rig send` can target any session, regardless of edges (queue escalation, above, is the one
  daemon path that follows `delegates_to`)
- **Enforce delegation** — an agent can communicate with any peer, not just its edge targets
- **Control permissions** — there's no edge-based access control
- **Affect transport** — `rig capture`, `rig broadcast`, etc. work based on session identity, not edge topology

These are aspirational capabilities. The edge vocabulary is intentionally richer than the current runtime behavior so that the topology captures design intent even before the runtime enforces it.

## Design Intent (Why We Have Five Kinds)

The five kinds represent a taxonomy of how agents relate to each other in a working team:

**`delegates_to`** — the most common edge. An orchestrator delegates to an implementer. A lead delegates to a worker. This is the primary workflow direction. When an orchestrator sends a task, it uses `rig send` to the session it `delegates_to`.

**`spawned_by`** — for hierarchical launch relationships. A subagent spawned by a parent process. Less common in current topologies.

**`can_observe`** — the review/oversight relationship. A reviewer observes an implementer's work. The reviewer can `rig capture` and `rig transcript` the implementation session. This edge communicates intent: "I'm watching your output."

**`collaborates_with`** — peer relationships. Two agents working side-by-side at the same level of the hierarchy. Neither delegates to the other.

**`escalates_to`** — the reverse of delegation. When a worker hits a decision it can't make, it escalates to a lead. This is less common in current topologies but represents a real coordination pattern.

## Choosing Edge Kinds

### Common Patterns

**Orchestrator → workers:**
```yaml
edges:
  - kind: delegates_to
    from: orch.lead
    to: dev.impl
```

**Reviewer → implementer:**
```yaml
edges:
  - kind: can_observe
    from: rev.r1
    to: dev.impl
```

**Implementation pair:**
```yaml
edges:
  - kind: delegates_to
    from: impl
    to: qa
```

### When You're Not Sure

If you're unsure which edge kind to use:

1. Does one agent give work to the other? → `delegates_to`
2. Does one agent watch the other's output? → `can_observe`
3. Are they equals working together? → `collaborates_with`
4. Does one report problems up? → `escalates_to`
5. Did one create the other? → `spawned_by`

If none fit, `can_observe` is the safest default — it documents the relationship without implying a workflow direction and doesn't affect launch ordering.

## Validation Rules

1. Edge kinds must be one of: `delegates_to`, `spawned_by`, `can_observe`, `collaborates_with`, `escalates_to`
2. Pod-local edges use unqualified member IDs — both `from` and `to` must exist in the same pod
3. Cross-pod edges use `pod.member` format — both endpoints must resolve to actual members
4. Cross-pod edges must reference different pods (same-pod edges should use the pod-local syntax)
5. Self-edges are not validated at the schema level but are not meaningful
