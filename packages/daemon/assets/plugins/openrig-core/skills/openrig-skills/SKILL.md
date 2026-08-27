---
name: openrig-skills
description: "Use when you're operating OpenRig and need the right skill or context for fleet recovery, seat handover, new-seat orientation, a watchdog wake, cross-host reach to an agent on another machine, rig packaging, an OpenRig upgrade, systematic debugging, queue triage, or implementation planning; also use when you don't know what applies or nothing is projected on cold boot."
allowed-tools: Bash(rig:*)
metadata:
  openrig:
    stage: shipped
---

# OpenRig skills — the index (start here)

You're running inside OpenRig. OpenRig ships a set of **skills** — small documents that tell you *when* to do something and *how*. This file is the map: what ships, when to reach for each, and how to load it. If you don't know which skill applies, or nothing is projected into your context, **start here.**

## How OpenRig context works (30 seconds)

Skills are **progressive disclosure**: a skill's *name + description* sit in your context ambiently (the "hot tier"); its *body* loads only when you open it. So you don't pre-read everything — you pattern-match a skill's "when" to your moment, then open just that one. This file is the index over the whole shipped set. (For the full model of building/operating agent software, open `software-for-agents`.)

Every row below names **how to reach the skill** — already-hot, or an exact load path. No row is a dead end.

## Loading an entry on demand — `rig context get`

Don't guess a file path or a name. Go **ask → ref → load** in three steps:

1. **Discover** — run `rig context list` for every shipped entry's **ref** and name. The *when* for
   each is the index below (or `rig context list --json`, which carries each entry's purpose) — match
   your moment there.
2. **Select** — match your moment to a row's *when* and take its **ref**. Refs are canonical full paths
   that mirror the library layout — `skills/<namespace>/<name>` (e.g. `skills/core/rig-lifecycle`,
   `skills/process/systematic-debugging`). A unique bare name (e.g. `watchdog`) also resolves; any
   slash-bearing ref is an exact lookup and fails loud if it does not exist.
3. **Load** — `rig context get skills/<namespace>/<name>`:

```
rig context get skills/core/rig-lifecycle
```

The content is served **from the installed CLI**, so what you load always matches your running version —
no path-guessing, no frozen-fork drift. (The daemon assembles the same bundle `rig context preview`
shows an operator — `get` is the agent-facing pull.)

## The index

### Always loaded — the universal spine (open its body when its moment hits)
These are auto-delivered to every rig; their name+description are already in your context. Open the body when the "when" matches.

- **forming-an-openrig-mental-model** — first boot, or you're unsure how the pieces fit. The runtime mental model.
- **openrig-operating-model** — you do not know where context or work belongs, or you are about to duplicate knowledge. The two-tree placement and trace-to-root model.
- **openrig-user** — you need a `rig` CLI command (send / queue / ps / whoami / scope / broadcast). The daily CLI surface.
- **claude-compaction-restore** — you just compacted (Claude). Restore from durable evidence before resuming real work.
- **session-compaction-and-restore** — preparing for, or recovering from, compaction (any runtime). The write- and read-side protocol.
- **queue-handoff** — you're passing durable work to another seat or ending your turn. The queue is the work ledger, not chat.
- **refocusing** — a long-running seat may have lost the product outcome, crossed a major boundary, or compacted and needs a fresh path-based trace.
- **seat-continuity-and-handover** — handing your seat's work across a restart or to another owner.
<!-- Territory amended 2026-08-26 by desk ruling qitem-20260826080800-r054-s9a-scope-ruling. -->
- **orienting-to-an-inherited-seat** — you just inherited an existing seat through a planned handover and need to verify its identity, state, and testimony.
- **retiring-and-inheriting-a-seat** — you're planning a seat transition and need to retire the current occupant into a fresh successor without losing continuity.
- **mission-slice-sop** — you're working a mission/slice (the SDLC: intent → mini-requirements + proof contract → build → QA → proof). The operating manual.
- **messaging-the-human** — composing a message to the human. Plain language, no insider jargon.
- **software-for-agents** — you want the full first-load model of how agent software is built and operated here.
- **openrig-skills** — this index (you're reading it). Always loaded; the entry point to everything below.

### Load when your role or task calls for it (repo-shipped, profile-selected)
These ship in the OpenRig repo and reach a seat when its profile selects them. To use one, select it in your profile's `uses.skills`, or open it directly at `packages/daemon/specs/agents/shared/skills/core/<skill>/SKILL.md`.

- **openrig-architect** — authoring a rig or topology (NOT for changing OpenRig itself — that's `openrig-builder`).
- **openrig-cmux** — driving the `cmux` terminal provider.
- **openrig-herdr** — opening/managing seat terminals via the default proof-gated provider.
- **agent-startup-and-context-ingestion** — a seat is booting and ingesting its startup context.
- **topology-mutation-and-seat-management** — adding, removing, renaming seats or otherwise mutating rig topology.
- **rig-lifecycle** — rig up / down / pause / resume lifecycle operations.
- **applying-a-permission-policy** — a rig/seat has a permission policy attached, or you're setting one up (Locked / Standard / Open): translate it into the live harness config (Claude `settings.json` / Codex `config.toml`), agent-driven + interactive. Reached at onboarding and at rig setup/preflight. (YOLO / bypass is a launch-flag OpenRig sets, not this skill.)
- **rig-bundles-and-shareable-artifacts** — packaging or installing a rig bundle / shareable artifact.
- **cross-host-rig-commands** — reaching seats or queues on another host (`--host`).
- **openrig-upgrade** — upgrading OpenRig or the daemon.
- **agent-starters** — composing an agent's starter context / priming packs.
- **specification-system** — authoring or reading AgentSpecs and rig specs.
- **attention-queue** — managing the attention / needs-attention surface.
- **human-in-the-loop** — deciding when to involve the human vs. proceed on your own authority.
- **delegating-work** — deciding WHO does a task: yourself, a spawned subagent, or another agent that already holds the context (the when/whether decision, not the fan-out mechanics).
- **watchdog** — monitoring or recovering a seat (health, restore, stuck state).
- **session-source-fork** — forking a session's source/context.

Pod handbooks (load when you're in that pod):
- **orchestration-team** — you're orchestrating a rig: dispatching, monitoring, keeping the loop moving.
- **development-team** — you're on the dev pod: building and shipping product changes.
- **review-team** — you're reviewing: fresh scrutiny, anti-slop, empirical verification.

Product-management craft (load when shaping/reviewing work):
- **requirements-writer** — turning intent into clear requirements.
- **plan-review** — reviewing a plan before it's built.
- **exec-summary** — writing a decision-ready summary for a human.
- **office-hours** — running a structured advisory / decision session.
- **context-builder** — assembling the context a task or seat needs.
- **backlog-capture** — capturing and shaping backlog items.
- **ui-mockup** — producing a UI mockup for a slice.

### Vendored craft — load when you're coding (ships with upstream provenance)
General engineering skills OpenRig ships as vendored copies. Open when the task matches; they carry "modified by OpenRig" provenance.

- **test-driven-development** — implementing a feature or bugfix: write the failing test first.
- **verification-before-completion** — about to claim done / passing / fixed: run the check and read the output first.
- **systematic-debugging** — debugging: find the root cause before the fix.
- **writing-plans** — writing an implementation plan.
- **executing-plans** — working through a written plan.
- **brainstorming** — divergent ideation before converging.
- **using-superpowers** — discovering and using the vendored "superpowers" skill set.
- **agent-browser** — driving a browser (screenshot / screencast) from an agent.
- **frontend-design** — designing frontend / UI.
- **dogfood** — web-QA / dogfooding a shipped UI.

## Need more than what ships here?

This index covers the **shipped** surface. A dev host carries far more (factory, architecture, PM-craft, studio skills) reached through the host's own routers/codemaps — if you're on a builder host and need something not listed above, that deeper routing is the next hop, not a wall. (Host-scale routing is the subject of the context-routing architecture doc; at product scale, this one file is the whole map.)

> Membership note: this index lists exactly the skills that ship with OpenRig. When a skill graduates into the shipped set it joins this index — the index and the shipped set stay one scope.
