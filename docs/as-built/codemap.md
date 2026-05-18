---
kind: as-built
title: OpenRig Codemap — Navigation Index / Map of Territory
status: active
topics: [knowledge-and-context, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  You know what you need to learn about the shipped OpenRig system but not
  which as-built module holds it. Use the module map, the use-case lookup,
  or the source-root table to route to the right doc — or jump straight to
  the source root the codemap points at.
siblings: [README.md, cli-reference.md]
prerequisite-reads: [README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# OpenRig Codemap — Navigation Index

This is a **map of territory**, not a content dump. It tells you which
as-built module answers a question and which `packages/*/src` root that
module is grounded in. The deep content lives in the modules; the code lives
in the source roots; this file points at both.

> The old codemap was a 425-line file-by-file `Exports:`/`Related:` flat dump
> that drifted fastest (its own header carried a stale v0.2.0 footprint and an
> internally-contradictory command-group count) and never fit a context
> window. That anti-pattern is retired (slice-08 Q5, founder-ratified). The
> genuinely-useful part — the source-root index — is preserved below as the
> source-root pointer table; the per-file transcription is not.

## (a) Product frame

OpenRig is a local control plane for multi-agent coding topologies — a
multi-agent harness that manages your Claude Code and Codex sessions as a
single system. The daemon (`@openrig/daemon`) is the framework-free
SQLite-backed core; the CLI (`@openrig/cli`), UI (`@openrig/ui`), and MCP
server all sit on top of it.

> Source-verified at HEAD `7eaf524c` (`v0.3.1-6-g7eaf524c`); package version
> **0.3.1**, 6 unreleased 0.3.2 commits on HEAD, no `v0.3.2` tag. Frame
> sentence triangulated against `architecture/daemon-core.md` §1 +
> `openrig-internal/product/positioning.md` ("a multi-agent harness, a local
> control plane that manages your Claude Code and Codex sessions as a single
> system").

## (b) Module map

One row per module. "Reach for this when…" mirrors each module's actual
`applies-when` frontmatter.

### architecture/

| Module | One-sentence summary | Reach for this when… |
|---|---|---|
| `daemon-core.md` | The framework-free SQLite-backed core the CLI/UI/MCP all sit on. | You need to know how the daemon boots, how `createDaemon` wires the dependency graph, the SQLite schema/migration set, or the route-mount surface. |
| `adapters-and-runtimes.md` | The five-method runtime-adapter contract + the resume-honesty layer. | You need the runtime-adapter contract, how OpenRig launches/resumes a Claude Code, Codex, or terminal harness inside tmux, or how the daemon honestly assesses whether a harness actually resumed vs fresh-launched. |
| `coordination-primitive.md` | PL-004 Phase A: the SQLite-canonical durable-work layer (`/api/stream`, `/api/queue`). | You need the stream/queue/inbox/outbox tables, the hot-potato closure contract, the transactional handoff guarantee, or where queue closure is enforced. |
| `workflow-runtime.md` | PL-004 Phase D: turns an intended sequence of work into durable SQLite state. | You need workflow specs cache, instance state, step trails, the transactional-scribe projection contract, or the watchdog policy set including workflow-keepalive. |
| `mission-control.md` | PL-005: the daemon-backed queue-observability surface inside the existing shell. | You need the seven views, the seven write verbs, the action audit table, the bearer-token middleware, or how queue observability maps to PL-004 sources. |
| `agent-spec-and-startup.md` | How authored YAML specs become a resolved, launched, identity-addressable topology. | You need the AgentSpec/RigSpec/pod-aware reboot types, profile resolution + additive startup layering, the StartupOrchestrator delivery split, or how whoami/materialize/bind/adopt resolve identity. |
| `lifecycle-snapshot-restore.md` | The durable-state half of `down → up → handoff`. | You need how OpenRig captures a snapshot, restores a rig (resume vs rebuild vs fresh), enforces restore honesty, consults live continuity, or how restore-check / restore-packet readiness probes work. |
| `transport-and-transcripts.md` | The communication-and-history layer; tmux is transport, not truth. | You need how rig send/capture/broadcast works, pipe-pane transcript capture + search, durable SQLite chat, what `rig ask` gathers, or the MCP-tool-name vs tmux-metadata-key distinction. |
| `workspace-primitive.md` | PL-007: the typed declaration of where a rig's work lives. | You need how a rig declares a typed workspace (root/repos/defaultRepo/knowledgeRoot), how it persists/resolves into whoami / node-inventory, how per-item `target_repo` scope is validated, or how the file-backed missions/slices tree is indexed and projected into Project. |
| `content-surfaces.md` | The operator-allowlisted, filesystem-canonical read/write layer Project/Steering sits on. | You need how the file browser enforces path safety, how atomic conflict-checked writes + the JSONL edit audit work, how the PROGRESS.md tree is indexed, or how the one-screen Steering surface is composed. |
| `plugin-agent-image-context-pack.md` | Four filesystem-canonical content primitives the daemon discovers and serves. | You need how OpenRig discovers plugins, captures/forks agent images, assembles/sends context packs, or how the Claude auto-compaction enforcer decides to send `/compact`. |
| `packaging-bootstrap-bundles.md` | How a topology is packaged into a shareable bundle and reconstituted elsewhere. | You need how rig/pod bundles are assembled (schema-v2 vs legacy v1), how bundle create/inspect/install + `/api/up` route across source kinds, the staged BootstrapOrchestrator flow, or which legacy install-engine seams still ship. |
| `architecture-rules-and-event-system.md` | The cross-cutting invariants that belong to no single subsystem. | You need the 25 architecture rules + startup/import constraints, the shape of the RigEvent union and its SSE delivery, or the intentional compatibility limits that still describe the shipped system. |

### ui/

| Module | One-sentence summary | Reach for this when… |
|---|---|---|
| `shell-and-routing.md` | The shell-first, route-first, primitive-driven operator surface. | You need how the UI shell (rail / Explorer / center workspace / drawer / preview stack) is assembled, the actual route tree the shipped UI mounts, or how the shared detail drawer and event consumption work. |
| `topology.md` | The operator's live picture of host → rig → pod → seat. | You need how the topology surface is built — the host hybrid graph, the table/terminal views, the activity-ring / hot-potato visual language, terminal-preview popovers, and the navigation/overlay contracts. |
| `project-and-for-you.md` | The three operator-facing destination surfaces (For You / Project / Dashboard). | You need how the For-You attention feed (5-card classifier + verb actions), the Project workspace/mission/slice scope pages, and the Dashboard landing on the vellum brand system are built. |
| `library-specs-and-design-system.md` | The Library (`/specs`) destination + the design-system pointer. | You need how the Library UI is assembled — the spec/skills/plugins surfaces, the spec-review + spec-library + live-identity flows that feed it — or where the canonical visual/design-system spec lives. |

### root

| Doc | One-sentence summary | Reach for this when… |
|---|---|---|
| `cli-reference.md` | The full `rig` CLI surface, kept as one doc. | You need the exact rig CLI surface — command groups, subcommands, flags, JSON output, cross-host, coordination primitives. |
| `frontmatter-schema.md` | The frontmatter convention these docs follow + the as-built-unique field. | You are authoring or updating a doc under `docs/as-built/`. |
| `../DESIGN.md` | The canonical visual / brand / design-system spec (repo `docs/` root). | You need the visual system, brand identity, or design-system tokens. (Stays at root by design; pointer only.) |

## (c) Structural relationship diagram

Built from each module's `siblings` / `prerequisite-reads` frontmatter.
`daemon-core.md` is the spine (prerequisite for almost every architecture
module); `shell-and-routing.md` is the UI spine.

```
                         README.md  (entry — prerequisite for all)
                              │
              ┌───────────────┴───────────────┐
              ▼                                ▼
        architecture/                         ui/
              │                                │
   daemon-core.md ◀── (prerequisite spine for the column below)
      │   │   │  │
      │   │   │  └──▶ adapters-and-runtimes.md
      │   │   │         (five-method contract + resume honesty;
      │   │   │          consumed by agent-spec startup orchestration)
      │   │   └────────────────────────────┐
      │   └──────────────┐                  │
      ▼                  ▼                  ▼
 coordination-      agent-spec-and-    transport-and-
 primitive.md        startup.md         transcripts.md
   │     │              │  │
   ▼     ▼              │  ▼
 workflow-  mission-    │  lifecycle-snapshot-restore.md
 runtime.md control.md  │     ▲ (consumes persisted replay context)
   │          │         │
   └────┬─────┘         ├──▶ packaging-bootstrap-bundles.md
        ▼               │        ▲
 architecture-rules-    │        │ (0.3.x reusable starter-state cluster)
 and-event-system.md    │        ▼
 (consumes all          └──▶ plugin-agent-image-context-pack.md
  PL-004/005 events)

 workspace-primitive.md ──▶ content-surfaces.md
   (PL-007 declaration)      (filesystem read/write layer on top)
        │                          │
        └──────────┬───────────────┘
                   ▼  (UI counterpart)
            ui/project-and-for-you.md

 shell-and-routing.md ──▶ topology.md
        │             └──▶ project-and-for-you.md ◀──▶ architecture/mission-control.md
        └──────────────▶ library-specs-and-design-system.md ──▶ ../DESIGN.md (pointer)
```

Reading-order rule: open a module's `prerequisite-reads` first
(`README.md`, then `daemon-core.md` for most architecture modules;
`README.md` then `shell-and-routing.md` for most ui modules).

## (d) Fast lookup by use-case

| I need to know… | → see |
|---|---|
| How the daemon boots / `createDaemon` wiring / migration set / route mounts | `architecture/daemon-core.md` |
| The runtime-adapter contract / how a harness is launched or resumed in tmux | `architecture/adapters-and-runtimes.md` |
| Where Claude resume honesty lives / resumed-vs-fresh assessment | `architecture/adapters-and-runtimes.md` |
| Where queue closure is enforced / hot-potato contract / durable handoff | `architecture/coordination-primitive.md` |
| How workflow specs project on closure / transactional-scribe / watchdog policies | `architecture/workflow-runtime.md` |
| The Mission Control views/verbs / queue-observability / action audit | `architecture/mission-control.md` |
| AgentSpec/RigSpec types, profile resolution, startup layering, whoami/bind/adopt | `architecture/agent-spec-and-startup.md` |
| Snapshot/restore, restore honesty, restore-check / restore-packet probes | `architecture/lifecycle-snapshot-restore.md` |
| rig send/capture/broadcast, transcripts, durable chat, `rig ask`, MCP-name vs tmux-key | `architecture/transport-and-transcripts.md` |
| The workspace primitive (root/repos), `target_repo` scope gating, missions/slices indexing | `architecture/workspace-primitive.md` |
| The file browser path safety, atomic writes + edit audit, PROGRESS tree, Steering composer | `architecture/content-surfaces.md` |
| Plugin discovery / agent images / context packs / Claude auto-compaction enforcer | `architecture/plugin-agent-image-context-pack.md` |
| Bundle assembly, bundle install / `/api/up`, BootstrapOrchestrator, legacy install seams | `architecture/packaging-bootstrap-bundles.md` |
| The 25 architecture rules / RigEvent union / SSE delivery / compatibility limits | `architecture/architecture-rules-and-event-system.md` |
| The UI shell, the real route tree, the shared detail drawer | `ui/shell-and-routing.md` |
| The topology graph/table/terminal views, activity-ring / hot-potato visuals | `ui/topology.md` |
| The For-You attention feed, Project scope pages, the Dashboard landing | `ui/project-and-for-you.md` |
| The vellum brand system on the destination surfaces (0.3.1 brand identity) | `ui/project-and-for-you.md` (vellum brand = **0.3.1** per slice-00 0.3.0-GT seam (b); slice-00 §2 row 1 = vellum-primitives → brand-identity, row 2 = destination-model → polished-destinations) |
| The Library `/specs` UI + spec-review/spec-library/live-identity flows | `ui/library-specs-and-design-system.md` |
| The full `rig` CLI surface | `cli-reference.md` |
| The visual / brand / design-system spec | `../DESIGN.md` (repo `docs/` root) |
| Which frontmatter these docs use + the as-built-unique field | `frontmatter-schema.md` |

## (e) Source-root pointer table

Module → primary `packages/*/src/...` roots. This replaces the old per-file
`Exports:`/`Related:` dump: it points at the code, it does not transcribe it.
Source-grounding for each claim lives inside the module with file:line cites.

| Module | Primary source roots |
|---|---|
| `architecture/daemon-core.md` | `packages/daemon/src/{startup.ts,server.ts,index.ts}`, `packages/daemon/src/db/migrations/`, `packages/cli/src/index.ts` |
| `architecture/adapters-and-runtimes.md` | `packages/daemon/src/domain/runtime-adapter.ts`, `packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,terminal-adapter}.ts`, `packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id}.ts` |
| `architecture/coordination-primitive.md` | `packages/daemon/src/domain/{stream-store,queue-repository,queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`, `packages/daemon/src/routes/{stream,queue}.ts` |
| `architecture/workflow-runtime.md` | `packages/daemon/src/domain/{workflow-projector,workflow-runtime,workflow-instance-store,workflow-spec-cache,workflow-step-trail-log,workflow-validator}.ts`, `packages/daemon/src/domain/policies/workflow-keepalive.ts`, `packages/daemon/src/routes/workflow.ts` |
| `architecture/mission-control.md` | `packages/daemon/src/domain/mission-control/`, `packages/daemon/src/middleware/auth-bearer-token.ts`, `packages/daemon/src/routes/mission-control.ts`, `packages/daemon/src/db/migrations/037_mission_control_actions.ts` |
| `architecture/agent-spec-and-startup.md` | `packages/daemon/src/domain/{agent-manifest,rigspec-schema,profile-resolver,startup-orchestrator,whoami-service,claim-service}.ts`, `packages/daemon/src/routes/{rigspec,whoami}.ts` |
| `architecture/lifecycle-snapshot-restore.md` | `packages/daemon/src/domain/{restore-orchestrator,snapshot-capture,snapshot-repository,checkpoint-store}.ts`, `packages/daemon/src/routes/restore-check.ts`, `packages/cli/src/commands/restore-packet.ts` |
| `architecture/transport-and-transcripts.md` | `packages/daemon/src/domain/{session-transport,transcript-store,history-query,ask-service,chat-repository}.ts`, `packages/daemon/src/routes/{transport,transcripts,ask,chat}.ts`, `packages/cli/src/mcp-server.ts` |
| `architecture/workspace-primitive.md` | `packages/daemon/src/domain/workspace/`, `packages/cli/src/commands/config-init-workspace.ts`, `packages/daemon/src/db/migrations/{038,039}*`, `packages/ui/src/routes.tsx` |
| `architecture/content-surfaces.md` | `packages/daemon/src/domain/{files,progress,steering}*`, `packages/daemon/src/routes/{files,progress,steering}.ts`, `packages/ui/src/routes.tsx` |
| `architecture/plugin-agent-image-context-pack.md` | `packages/daemon/src/domain/plugin-discovery-service.ts`, `packages/daemon/src/domain/{agent-images,context-packs}/`, `packages/daemon/src/domain/claude-compaction-enforcer.ts` |
| `architecture/packaging-bootstrap-bundles.md` | `packages/daemon/src/domain/{pod-bundle-assembler,bootstrap-orchestrator,bundle-*,package-*,install-*}.ts`, `packages/daemon/src/routes/{bundles,up}.ts` |
| `architecture/architecture-rules-and-event-system.md` | `packages/daemon/src/domain/types.ts` (RigEvent union), `packages/daemon/src/routes/{stream,queue}.ts` (SSE watch), `packages/daemon/src/server.ts` (`/api/events`) |
| `ui/shell-and-routing.md` | `packages/ui/src/routes.tsx`, `packages/ui/src/components/AppShell.tsx` |
| `ui/topology.md` | `packages/ui/src/components/topology/`, `packages/ui/src/lib/{graph,hybrid,multi-rig}-layout.ts` |
| `ui/project-and-for-you.md` | `packages/ui/src/routes.tsx`, `packages/ui/src/components/dashboard/vellum/` |
| `ui/library-specs-and-design-system.md` | `packages/ui/src/components/specs/`, `packages/daemon/src/domain/{spec-review-service,spec-library-service}.ts`, `../DESIGN.md` (pointer) |
| `cli-reference.md` | `packages/cli/src/index.ts`, `packages/cli/src/commands/*` |

> No per-file flat dump. File-level detail belongs in the code; this codemap
> points at the source root and the module that explains it. The per-file
> index anti-pattern (old codemap) is retired, not relocated.
