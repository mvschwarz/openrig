---
kind: as-built
title: As-Built Docs — Map of Territory + Module Index
status: active
topics: [knowledge-and-context, observability]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  Starting any technical task that needs the shipped OpenRig system as it
  actually is. Read this first to learn what the as-built tree contains and
  which module to open; then go to codemap.md for use-case navigation or
  straight to the named module.
siblings: [codemap.md, cli-reference.md, frontmatter-schema.md]
prerequisite-reads: []
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# OpenRig As-Built Docs

OpenRig is a local control plane for multi-agent coding topologies — a
multi-agent harness that manages your Claude Code and Codex sessions as a
single system, with a daemon (`@openrig/daemon`), a CLI (`@openrig/cli`), a UI
(`@openrig/ui`), and an MCP server all sitting on one SQLite-backed core. This
tree is the **source-verified** description of that system as it actually
ships — every load-bearing claim is grounded to `packages/*/src` at a named
commit, not to memory, chat, or older docs.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). Package version is **0.3.1** across all three
> packages; HEAD carries 6 commits of unreleased 0.3.2 work, no `v0.3.2` tag.

## How this tree is organized

The as-built corpus was modularized (slice 08, `context-architecture-v1`) from
two monolithic files into a folder of thematic modules, each independently
loadable, each frontmatter-tagged for retrieval, each ≤300 lines (author-mode
modules with no prior prose may run to ≤400 — see the slice-08 ACK).

```
docs/as-built/
├── README.md            ← you are here: map-of-territory + index
├── codemap.md           ← navigation index (use-case lookup, source-root pointers)
├── frontmatter-schema.md← the frontmatter convention these docs follow
├── cli-reference.md     ← full rig CLI surface (kept whole)
├── architecture/        ← 13 backend/runtime modules
└── ui/                  ← 4 operator-surface modules
```

`docs/DESIGN.md` (the canonical visual / brand / design-system spec) **stays
at the repo `docs/` root** by design — it is referenced by many existing
`docs/DESIGN.md` paths and carries no source drift. This tree points at it
(see `ui/library-specs-and-design-system.md`); it is not copied here.

## Module index

### `architecture/` — backend, daemon, runtime

| Module | What it covers |
|---|---|
| [daemon-core.md](architecture/daemon-core.md) | How the daemon boots, `createDaemon` wiring, the SQLite schema/40-migration set, the route-mount surface. |
| [adapters-and-runtimes.md](architecture/adapters-and-runtimes.md) | The five-method RuntimeAdapter contract, the Claude/Codex/Terminal adapters (launch/resume/fork in tmux), and the resume-honesty layer (honest resumed-vs-fresh assessment). |
| [coordination-primitive.md](architecture/coordination-primitive.md) | PL-004 Phase A stream/queue/inbox/outbox; the hot-potato closure contract; where queue closure is enforced. |
| [workflow-runtime.md](architecture/workflow-runtime.md) | PL-004 Phase D Workflow Runtime — spec cache, instance state, step trails, transactional-scribe projection, watchdog policies. |
| [mission-control.md](architecture/mission-control.md) | PL-005 queue-observability surface — seven views, seven write verbs, action audit, bearer-token middleware. |
| [agent-spec-and-startup.md](architecture/agent-spec-and-startup.md) | AgentSpec/RigSpec types, profile resolution, additive startup layering, StartupOrchestrator, whoami/materialize/bind/adopt identity. |
| [lifecycle-snapshot-restore.md](architecture/lifecycle-snapshot-restore.md) | Snapshot capture, honest restore (resume vs rebuild vs fresh), restore-honesty enforcement, restore-check / restore-packet probes. |
| [transport-and-transcripts.md](architecture/transport-and-transcripts.md) | rig send/capture/broadcast over tmux, pipe-pane transcript capture + search, durable SQLite chat, `rig ask`, MCP-name vs tmux-key distinction. |
| [workspace-primitive.md](architecture/workspace-primitive.md) | The PL-007 typed workspace declaration (root/repos/defaultRepo/knowledgeRoot), migrations 038/039, per-item repo-scope gating, file-backed missions/slices indexing. |
| [content-surfaces.md](architecture/content-surfaces.md) | The operator-allowlisted file browser, atomic conflict-checked writes + JSONL edit audit, PROGRESS.md tree indexer, the one-screen Steering composer. |
| [plugin-agent-image-context-pack.md](architecture/plugin-agent-image-context-pack.md) | The filesystem-canonical content layer — plugin discovery, agent images, context packs, the Claude auto-compaction policy enforcer. |
| [packaging-bootstrap-bundles.md](architecture/packaging-bootstrap-bundles.md) | Bundle assembly (schema-v2 pod bundles + legacy v1), bundle create/inspect/install + `/api/up`, the staged BootstrapOrchestrator, legacy install seams. |
| [architecture-rules-and-event-system.md](architecture/architecture-rules-and-event-system.md) | The cross-cutting invariants — the 25 architecture rules, the RigEvent union + SSE delivery, intentional compatibility limits. |

### `ui/` — operator surfaces

| Module | What it covers |
|---|---|
| [shell-and-routing.md](ui/shell-and-routing.md) | The UI shell (rail / Explorer / center workspace / drawer / preview stack), the actual route tree the shipped UI mounts, the shared detail drawer + event consumption. |
| [topology.md](ui/topology.md) | The topology surface — host hybrid graph, table/terminal views, activity-ring / hot-potato visual language, terminal-preview popovers, navigation/overlay contracts. |
| [project-and-for-you.md](ui/project-and-for-you.md) | The operator destination surfaces — the For-You attention feed (5-card classifier + verb actions), the Project workspace/mission/slice scope pages, the Dashboard landing on the vellum brand system. |
| [library-specs-and-design-system.md](ui/library-specs-and-design-system.md) | The Library (`/specs`) UI — specs/skills/plugins/agent-images surfaces, the spec-review + spec-library + live-identity flows, the design-system pointer. |

### Root docs

| Doc | What it covers |
|---|---|
| [codemap.md](codemap.md) | Navigation index — module map, structural relationship diagram, fast-lookup-by-use-case, source-root pointer table. Start here when you know *what* you need but not *which module*. |
| [cli-reference.md](cli-reference.md) | The full `rig` CLI surface — command groups, subcommands, flags, JSON output, cross-host, coordination primitives. Kept as one doc (slice-08 Q4). |
| [frontmatter-schema.md](frontmatter-schema.md) | Which frontmatter convention governs every doc in this tree, plus the one as-built-unique field (`last-verified-against-source`). |
| `../DESIGN.md` | The canonical visual / brand / design-system spec (lives at `docs/` root by design; pointer only — not duplicated here). |

## Source-grounding contract

Every module declares `last-verified-against-source: <commit-sha>` — the
commit its claims were checked against. Load-bearing corrections are recorded
inline with an auditable annotation (`> Drift-fix Dx — said X; corrected to Y;
slice-00 §z; re-confirmed <file:line> @HEAD`). OPEN items (counts that are
definitional or runtime-only) are carried verbatim, never smoothed. The
schema is defined in [frontmatter-schema.md](frontmatter-schema.md) and the
governing convention is `openrig-work/conventions/frontmatter-for-context/`.
