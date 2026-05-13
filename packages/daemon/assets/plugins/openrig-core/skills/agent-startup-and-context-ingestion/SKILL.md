---
name: agent-startup-and-context-ingestion
description: Use when designing or auditing how an agent becomes useful after launch — AGENTS.md overlays, role files, skills, rig specs, workflow specs, startup checklists, refocus messages, "rig context" surface. Covers the 4 failure modes that make startup context fail (old rig spec misses current operating mode; current agents never told about new guidance; startup file as dumping ground; orchestrator transmits implementation without preserving product intent).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Cross-runtime restore/reentry packet standard + externalized memory
      surfaces convention. Load at agent start; revisit after compaction.
    sibling_skills:
      - claude-compaction-restore
      - seat-continuity-and-handover
    transfer_test: pending
---

# Agent Startup and Context Ingestion

How an agent becomes useful after launch: **AGENTS.md overlays, role
files, skills, rig specs, workflow specs, startup checklists, refocus
messages**, and any future "rig context" command or skill-librarian
surface.

It is the current concrete startup path inside the broader
context-engineering-and-retrieval primitive. Startup gets a seat into
the right initial shape; context engineering is the larger question of
how a seat gets the right context for the work it is doing right now.

**Most coordination failures are not tool failures; they are context
failures.** Agents need to know their role, operating mode, coordination
convention, boundaries, and current product intent. If startup context
is scattered or stale, agents execute the wrong thing very efficiently.

## Use this when

- Authoring a new agent's startup files (role / culture / startup-context)
- Refreshing a seat that's been running on stale guidance
- Auditing whether agents got the current operating mode (not just what's in old files)
- Designing the orchestrator → next-agent context-transmission shape
- Building a startup map for OpenRig-building rigs

## Don't use this when

- The agent is being created via Agent Starter — the starter's manifest carries startup context
- The work is artifact-backed mental-model rebuild from a packet — that's `claude-compaction-restore`
- The intent is to ship reusable startup content as a skill — write the skill against the agentskills.io specification, not as inline startup prose

## Failure modes (4)

1. **A new agent starts from an old rig spec and misses the current operating mode.** Specs go stale; current state must be visible at startup, not just historical config.
2. **Guidance is written to a file that future agents read, but current agents are never told.** File edits don't propagate to running sessions. Cultural rollout (broadcast + fleet-changes-feed) is needed alongside file edits.
3. **A startup file becomes a dumping ground and loses the map-to-canonical-sources role.** Startup should point AT canonical sources; it shouldn't TRY to be one.
4. **The orchestrator transmits implementation instructions without preserving product intent.** Instructions decay; intent travels.

## Proof standard

Startup proof should:

1. **Launch or refresh** a seat
2. **Inspect** what it actually read
3. **Verify** it can state the current role, mode, active constraints, and next handoff convention **in its own words**

## Cross-runtime startup paths (5; do not collapse)

When a seat's startup is artifact-backed mental-model rebuild (active-work
reentry case, distinct from reusable Agent Starters / priming packs):

- See the **cross-runtime restore/reentry packet standard v0**
- Source-trust ranking applies: **`rig whoami` > target rigspec > bounded latest transcript > full transcript > touched-files > `restore-summary.json`**

## Memory surfaces consumed at startup

Per the externalized-memory-surfaces convention's 13-row inventory:

- **Row 7** — AGENTS/role/CULTURE/startup overlays (primary)
- **Row 3** — startup replay context (primary)
- **Row 12** — restore/reentry packets and Agent Starters (cross-runtime startup path)

The umbrella's authority-rank + read-vs-write columns govern which
surfaces a startup ingestion path can write vs only read.

## Startup files vs skills (the distinction)

Per `agent-startup-guide.md` (product reference doc) and the team handbook:

| Startup files | Skills |
|---|---|
| Rig-specific, role-specific identity | Reusable SOPs / methodology / knowledge |
| Tell agent WHO it is, WHAT it's working on, HOW this team operates | Tell agent HOW to do something (transferable across rigs) |
| Examples: `role.md`, `CULTURE.md`, `startup/context.md` | Examples: `openrig-user`, `test-driven-development`, `vault-user` |
| Authored per-rig | Authored once, used everywhere |

Don't put skill content in startup files. Don't put identity content
in skills. The 7-layer additive startup model (agent / profile / rig /
culture / pod / member / operator) handles the layering.

## See also

- `forming-an-openrig-mental-model` skill — orientation for new agents
- `claude-compaction-restore` skill — restore-time startup ingestion after compaction
- `seat-continuity-and-handover` skill — packet shape that survives seat resets
- https://agentskills.io/specification — the cross-runtime skill standard (what skill content should and shouldn't be)
