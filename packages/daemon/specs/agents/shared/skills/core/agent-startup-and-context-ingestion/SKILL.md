---
name: agent-startup-and-context-ingestion
description: Use when designing or auditing how an agent becomes useful after launch — AGENTS.md overlays, role files, skills, rig specs, workflow specs, startup checklists, refocus messages, "rig context" surface. Covers the 4 failure modes that make startup context fail (old rig spec misses current operating mode; current agents never told about new guidance; startup file as dumping ground; orchestrator transmits implementation without preserving product intent).
metadata:
  cli_surfaces_referenced:
    - context
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - session-compaction-and-restore
      - agent-starters
      - session-source-fork
      - seat-continuity-and-handover
---

# Agent Startup and Context Ingestion

How an agent becomes useful after launch: **AGENTS.md overlays, role
files, skills, rig specs, workflow specs, startup checklists, refocus
messages**, and the current `rig context` retrieval and profile surface.

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
- The work is artifact-backed mental-model rebuild from a packet — that's `session-compaction-and-restore`
- The intent is to ship reusable startup content as a skill

## Failure modes (4)

1. **A new agent starts from an old rig spec and misses the current operating mode.** Specs go stale; current state must be visible at startup, not just historical config.
2. **Guidance is written to a file that future agents read, but current agents are never told.** File edits don't propagate to running sessions. Cultural rollout (broadcast + fleet-changes-feed) is needed alongside file edits.
3. **A startup file becomes a dumping ground and loses the map-to-canonical-sources role.** Startup should point AT canonical sources; it shouldn't TRY to be one.
4. **The orchestrator transmits implementation instructions without preserving product intent.** Instructions decay; intent travels.

## Task-scoped startup

Run `rig whoami --json`, then resolve `project.yaml -> mission.yaml -> active
slice.yaml -> selected component or wave map -> addressed context`. The complete
lookup and precedence rule is `docs/reference/product-journey-sdlc.md#resolve-the-selected-path`
(installed: `$OPENRIG_HOME/reference/product-journey-sdlc.md#resolve-the-selected-path`).
Read the selected addresses and source needed for this task; skills available in
your profile are capabilities, not a mandatory reading list. No composition means
light Part A. Role names and idle seats add no gates. Explicit rigor and authored
wave boundaries retain their named checks.

Startup files are address maps, not universal reading mandates. Do not preload
unrelated planning/review doctrine or require per-file ACKs and quizzes. Skill
availability is distinct from loading its full body. An old packet does not choose
the current work. Missing selected context is a named gap to resolve.

## Proof standard

In a disposable fresh session, observe the actual reads and resulting next action.
Test no-selection, explicit rigor, and wave-boundary cases. An edit is not evidence
that an already-running seat adopted it; adoption needs an authorized refresh or
next-launch observation. Do not clear or re-prime a live seat merely to test prose.

## Cross-runtime startup paths (5; do not collapse)

When a seat's startup is artifact-backed mental-model rebuild (active-work
reentry case, distinct from reusable Agent Starters / priming packs):

- See the **cross-runtime restore/reentry packet standard v0**
- Source-trust ranking applies: **`rig whoami` > target rigspec > bounded latest transcript > full transcript > touched-files > `restore-summary.json`**

## Memory surfaces consumed at startup

Inventory the selected startup inputs: AGENTS/role/CULTURE overlays, replay
context, and any declared restore packet or starter. Record where each comes
from, whether it is current, and why this task needs it. An available skill or
old packet does not select the work.

Use the task-scoped startup path above to resolve current authority. Permission
to read an input is not permission to rewrite its source; writes follow the
active project/rig policy and assignment. Load
`skills/openrig-operating-model/SKILL.md` with `rig context get` when deciding
where durable context belongs.

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

- `mission-slice-sop` — load when starting assigned mission/slice work; the light artifact and handoff procedure for SPEC.md, NOTES.md, PROGRESS.md and proof. It does not choose the SDLC for the task.
- `forming-an-openrig-mental-model` skill — orientation for new agents
- `session-compaction-and-restore` skill — restore-time startup ingestion
- `agent-starters` skill — reusable starter manifests that compose startup context
- `openrig-operating-model` skill — placement and authority of durable context
- `openrig/docs/reference/agent-startup-guide.md` (product reference doc; not a skill) — the 7-layer additive startup model + delivery hints
