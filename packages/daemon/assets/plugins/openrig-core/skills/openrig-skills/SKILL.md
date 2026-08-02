---
name: openrig-skills
description: "Use when you're operating OpenRig and don't know which skill or context applies — this is the index of what ships with OpenRig, when to reach for each, and how to load it. Start here from a cold boot when nothing else is projected."
metadata:
  openrig:
    stage: shipped
---

# OpenRig skills — the index (start here)

You're running inside OpenRig. OpenRig ships a set of **skills** — small documents that tell you *when* to do something and *how*. This file is the map: what ships, when to reach for each, and how to load it. If you don't know which skill applies, or nothing is projected into your context, **start here.**

## How OpenRig context works (30 seconds)

Skills are **progressive disclosure**: a skill's *name + description* sit in your context ambiently (the "hot tier"); its *body* loads only when you open it. So you don't pre-read everything — you pattern-match a skill's "when" to your moment, then open just that one. This file is the index over the whole shipped set. (For the full model of building/operating agent software, open `software-for-agents`.)

Every row below names **how to reach the skill** — already-hot, or an exact load path. No row is a dead end.

For repo-shipped skills, resolve the installed CLI package root once:

```sh
OPENRIG_CLI_ROOT="$(dirname "$(dirname "$(realpath "$(command -v rig)")")")"
```

Paths below use that variable. Tier-A skills live in the daemon-vendored plugin at
`~/.openrig/plugins/openrig-core/skills/`; selected and vendored skills live in the installed CLI package.

## The index

### Always loaded — the universal spine (open its body when its moment hits)
These are auto-delivered to every rig; their name+description are already in your context. Open the body when the "when" matches.

- **forming-an-openrig-mental-model** — first boot, or you're unsure how the pieces fit. The runtime mental model. Load: `~/.openrig/plugins/openrig-core/skills/forming-an-openrig-mental-model/SKILL.md`.
- **openrig-user** — you need a `rig` CLI command (send / queue / ps / whoami / scope / broadcast). The daily CLI surface. Load: `~/.openrig/plugins/openrig-core/skills/openrig-user/SKILL.md`.
- **claude-compaction-restore** — you just compacted (Claude). Restore from durable evidence before resuming real work. Load: `~/.openrig/plugins/openrig-core/skills/claude-compaction-restore/SKILL.md`.
- **session-compaction-and-restore** — preparing for, or recovering from, compaction (any runtime). The write- and read-side protocol. Load: `~/.openrig/plugins/openrig-core/skills/session-compaction-and-restore/SKILL.md`.
- **queue-handoff** — you're passing durable work to another seat or ending your turn. The queue is the work ledger, not chat. Load: `~/.openrig/plugins/openrig-core/skills/queue-handoff/SKILL.md`.
- **seat-continuity-and-handover** — handing your seat's work across a restart or to another owner. Load: `~/.openrig/plugins/openrig-core/skills/seat-continuity-and-handover/SKILL.md`.
- **mission-slice-sop** — you're working a mission/slice (the SDLC: intent → mini-requirements + proof contract → build → QA → proof). The operating manual. Load: `~/.openrig/plugins/openrig-core/skills/mission-slice-sop/SKILL.md`.
- **messaging-the-human** — composing a message to the human operator. Plain language, no insider jargon. Load: `~/.openrig/plugins/openrig-core/skills/messaging-the-human/SKILL.md`.
- **software-for-agents** — you want the full first-load model of how agent software is built and operated here. Load: `~/.openrig/plugins/openrig-core/skills/software-for-agents/SKILL.md`.
- **openrig-skills** — this index (you're reading it). Always loaded; the entry point to everything below. Load: `~/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md`.

### Load when your role or task calls for it (repo-shipped, profile-selected)
These ship in the installed OpenRig CLI and reach a seat when its profile selects them. To use one, select it in your profile's `uses.skills`, or open the exact installed path below.

- **openrig-architect** — authoring a rig or topology (NOT for changing OpenRig itself — that's `openrig-builder`). Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/openrig-architect/SKILL.md`.
- **openrig-cmux** — driving the `cmux` terminal provider. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/openrig-cmux/SKILL.md`.
- **openrig-herdr** — opening/managing seat terminals via the default proof-gated provider. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/openrig-herdr/SKILL.md`.
- **agent-startup-and-context-ingestion** — a seat is booting and ingesting its startup context. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/agent-startup-and-context-ingestion/SKILL.md`.
- **topology-mutation-and-seat-management** — adding, removing, renaming seats or otherwise mutating rig topology. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/topology-mutation-and-seat-management/SKILL.md`.
- **rig-lifecycle** — rig up / down / pause / resume lifecycle operations. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/rig-lifecycle/SKILL.md`.
- **rig-bundles-and-shareable-artifacts** — packaging or installing a rig bundle / shareable artifact. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/rig-bundles-and-shareable-artifacts/SKILL.md`.
- **cross-host-rig-commands** — reaching seats or queues on another host (`--host`). Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/cross-host-rig-commands/SKILL.md`.
- **openrig-upgrade** — upgrading OpenRig or the daemon. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/openrig-upgrade/SKILL.md`.
- **agent-starters** — composing an agent's starter context / priming packs. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/agent-starters/SKILL.md`.
- **specification-system** — authoring or reading AgentSpecs and rig specs. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/specification-system/SKILL.md`.
- **attention-queue** — managing the attention / needs-attention surface. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/attention-queue/SKILL.md`.
- **human-in-the-loop** — deciding when to involve the human vs. proceed on your own authority. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/human-in-the-loop/SKILL.md`.
- **watchdog** — monitoring or recovering a seat (health, restore, stuck state). Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/watchdog/SKILL.md`.
- **session-source-fork** — forking a session's source/context. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/core/session-source-fork/SKILL.md`.

Pod handbooks (load when you're in that pod):
- **orchestration-team** — you're orchestrating a rig: dispatching, monitoring, keeping the loop moving. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pods/orchestration-team/SKILL.md`.
- **development-team** — you're on the dev pod: building and shipping product changes. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pods/development-team/SKILL.md`.
- **review-team** — you're reviewing: fresh scrutiny, anti-slop, empirical verification. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pods/review-team/SKILL.md`.

Product-management craft (load when shaping/reviewing work):
- **requirements-writer** — turning intent into clear requirements. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/requirements-writer/SKILL.md`.
- **plan-review** — reviewing a plan before it's built. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/plan-review/SKILL.md`.
- **exec-summary** — writing a decision-ready summary for a human. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/exec-summary/SKILL.md`.
- **office-hours** — running a structured advisory / decision session. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/office-hours/SKILL.md`.
- **context-builder** — assembling the context a task or seat needs. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/context-builder/SKILL.md`.
- **backlog-capture** — capturing and shaping backlog items. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/backlog-capture/SKILL.md`.
- **ui-mockup** — producing a UI mockup for a slice. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/pm/ui-mockup/SKILL.md`.

### Vendored craft — load when you're coding (ships with upstream provenance)
General engineering skills OpenRig ships as vendored copies. Open when the task matches; they carry "modified by OpenRig" provenance.

- **test-driven-development** — implementing a feature or bugfix: write the failing test first. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/test-driven-development/SKILL.md`.
- **verification-before-completion** — about to claim done / passing / fixed: run the check and read the output first. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/verification-before-completion/SKILL.md`.
- **systematic-debugging** — debugging: find the root cause before the fix. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/systematic-debugging/SKILL.md`.
- **writing-plans** — writing an implementation plan. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/writing-plans/SKILL.md`.
- **executing-plans** — working through a written plan. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/executing-plans/SKILL.md`.
- **brainstorming** — divergent ideation before converging. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/brainstorming/SKILL.md`.
- **using-superpowers** — discovering and using the vendored "superpowers" skill set. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/using-superpowers/SKILL.md`.
- **agent-browser** — driving a browser (screenshot / screencast) from an agent. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/agent-browser/SKILL.md`.
- **frontend-design** — designing frontend / UI. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/frontend-design/SKILL.md`.
- **dogfood** — web-QA / dogfooding a shipped UI. Load: `${OPENRIG_CLI_ROOT}/daemon/specs/agents/shared/skills/process/dogfood/SKILL.md`.

## Need more than what ships here?

This index covers the **shipped** surface. A dev host carries far more (factory, architecture, PM-craft, studio skills) reached through the host's own routers/codemaps — if you're on a builder host and need something not listed above, that deeper routing is the next hop, not a wall. (Host-scale routing is the subject of the context-routing architecture doc; at product scale, this one file is the whole map.)

> Membership note: this index lists exactly the approved product-public oracle set (45 skills as of 2026-08-02: 10 Tier-A + 25 Tier-B + 10 vendored). Skills graduated but not yet in the oracle (e.g. `culture-drift`, `triple-gate-verification`, `reference-first-verification`) join this index when they land in `conventions/product-public-skills.yaml` — index and shipped set stay one scope.
