---
kind: as-built
title: architecture.md — Reorganized into the Modular As-Built Tree (Redirect Stub)
status: superseded
topics: [knowledge-and-context]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  You followed an old reference to docs/as-built/architecture.md. The monolith
  was reorganized (slice-08, context-architecture-v1) into a folder of thematic
  modules. Go to README.md (map of territory) or codemap.md (use-case lookup),
  then the named module.
siblings: [README.md, codemap.md, ui.md]
prerequisite-reads: []
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# architecture.md was reorganized into the modular as-built tree

This single-file monolith was split into a folder of independently-loadable,
frontmatter-tagged thematic modules (slice-08, `context-architecture-v1`). The
canonical as-built description of the shipped daemon/runtime now lives in
`architecture/`. This stub is a forwarding pointer so old references still
resolve.

**Start here:**

- [`./README.md`](./README.md) — the map of territory and full module index.
- [`./codemap.md`](./codemap.md) — navigation index: use-case lookup table and
  source-root pointers. Use this when you know *what* you need but not *which*
  module.

## Where the major content went

The architecture content is now the **13 modules under `architecture/`**:

| Module | What moved here |
|---|---|
| [`architecture/daemon-core.md`](architecture/daemon-core.md) | Daemon boot, `createDaemon` wiring, the SQLite schema/migration set, the route-mount surface, system overview, package boundaries. |
| [`architecture/adapters-and-runtimes.md`](architecture/adapters-and-runtimes.md) | The five-method RuntimeAdapter contract; Claude/Codex/Terminal adapters; the **Resume honesty** layer (§ Resume honesty). |
| [`architecture/coordination-primitive.md`](architecture/coordination-primitive.md) | PL-004 Phase A stream/queue/inbox/outbox; the hot-potato closure contract; durable handoff. |
| [`architecture/workflow-runtime.md`](architecture/workflow-runtime.md) | PL-004 Phase D Workflow Runtime — spec cache, instance state, step trails, transactional-scribe, watchdog policies. |
| [`architecture/mission-control.md`](architecture/mission-control.md) | PL-005 Mission Control / Queue Observability — the `/api/mission-control/*` surface, seven views, seven write verbs, action audit, bearer-token middleware. |
| [`architecture/agent-spec-and-startup.md`](architecture/agent-spec-and-startup.md) | AgentSpec/RigSpec types, profile resolution, additive startup layering, StartupOrchestrator, whoami/materialize/bind/adopt. |
| [`architecture/lifecycle-snapshot-restore.md`](architecture/lifecycle-snapshot-restore.md) | Snapshot capture, honest restore (resume vs rebuild vs fresh), the verbatim restore-honesty rules, restore-check / restore-packet probes. |
| [`architecture/transport-and-transcripts.md`](architecture/transport-and-transcripts.md) | rig send/capture/broadcast over tmux, transcript capture + search, durable SQLite chat, `rig ask`, MCP-name vs tmux-key. |
| [`architecture/workspace-primitive.md`](architecture/workspace-primitive.md) | The PL-007 typed workspace declaration, migrations 038/039, per-item repo-scope gating, file-backed missions/slices indexing. |
| [`architecture/content-surfaces.md`](architecture/content-surfaces.md) | The operator-allowlisted file browser, atomic conflict-checked writes + edit audit, the PROGRESS.md tree indexer, the Steering composer. |
| [`architecture/plugin-agent-image-context-pack.md`](architecture/plugin-agent-image-context-pack.md) | Plugin discovery, agent images, context packs, the Claude auto-compaction enforcer. |
| [`architecture/packaging-bootstrap-bundles.md`](architecture/packaging-bootstrap-bundles.md) | Bundle assembly (schema-v2 + legacy v1), bundle create/inspect/install + `/api/up`, the staged BootstrapOrchestrator, legacy install seams. |
| [`architecture/architecture-rules-and-event-system.md`](architecture/architecture-rules-and-event-system.md) | The cross-cutting invariants — the 25 architecture rules (incl. **rule 15**, restore honesty), the RigEvent union + SSE delivery, intentional compatibility limits. |

The UI half of the old `### UI architecture` section is now the **4 modules
under `ui/`** (see [`ui.md`](ui.md), also a redirect stub, and the `ui/` index
in [`./README.md`](./README.md)).
