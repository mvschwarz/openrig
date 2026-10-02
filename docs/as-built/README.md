---
kind: as-built
title: As-Built Docs — Module Index
status: active
topics: [knowledge-and-context, observability]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  Starting a technical task and choosing the as-built module or source entry
  point to read. This index describes the document tree; each module carries
  its own source-verification stamp.
siblings: [codemap.md, arteries.md, test-layers.md, cli-reference.md, frontmatter-schema.md]
prerequisite-reads: []
last-verified-against-source: 712a61fbcc5ffe5a7c786fea12132567083ab507
last-updated: 2026-10-02
---

# OpenRig as-built docs

These pages describe the code and point to its owning files. This index was checked against
main commit `712a61fbcc5ffe5a7c786fea12132567083ab507`. A linked module's
`last-verified-against-source` is its own verification boundary; updating this index does not
revalidate that module or identify a running daemon or published package.

For the repository overview and contributor recipes, start with [ARCHITECTURE.md](../../ARCHITECTURE.md).
Use [codemap.md](codemap.md) to locate source, [arteries.md](arteries.md) to identify dependent
paths before a change, and [test-layers.md](test-layers.md) to choose checks.

## Repository surfaces

The npm workspaces are `packages/daemon`, `packages/cli`, `packages/tui`, and `packages/ui`
([root package manifest](../../package.json)). The daemon provides the SQLite-backed HTTP
services; CLI, TUI and MCP clients consume them. Runtime adapters include Claude Code, Codex,
Pi, terminal and stub implementations under `packages/daemon/src/adapters/`.

The CLI package contains the assembled daemon, TUI and web UI. User reference documents ship
from `docs/reference/`; this as-built tree is developer documentation. The assembly is in
[scripts/build-package.sh](../../scripts/build-package.sh), with the published file list in
[packages/cli/package.json](../../packages/cli/package.json).

## Module index

### Daemon and runtime

| Module | Read for |
|---|---|
| [daemon-core.md](architecture/daemon-core.md) | Process startup, service wiring, database migrations and HTTP mounts. |
| [adapters-and-runtimes.md](architecture/adapters-and-runtimes.md) | Runtime adapter methods, harness launch/resume and native-session checks. |
| [agent-spec-and-startup.md](architecture/agent-spec-and-startup.md) | Spec resolution, resource projection, startup delivery and identity. |
| [coordination-primitive.md](architecture/coordination-primitive.md) | Stream, queue, inbox/outbox, handoff and closure. |
| [workflow-runtime.md](architecture/workflow-runtime.md) | Workflow specifications, instances, projection, trails and watchdog policies. |
| [mission-control.md](architecture/mission-control.md) | Queue observations, actions and their audit records. |
| [lifecycle-snapshot-restore.md](architecture/lifecycle-snapshot-restore.md) | Snapshot capture, restore decisions and continuity checks. |
| [transport-and-transcripts.md](architecture/transport-and-transcripts.md) | Session messaging, capture, transcripts, chat and ask. |
| [workspace-primitive.md](architecture/workspace-primitive.md) | Workspace and repository declarations, project resolution and scope. |
| [content-surfaces.md](architecture/content-surfaces.md) | File reads/writes, path checks, progress indexing and steering composition. |
| [living-notes-review.md](architecture/living-notes-review.md) | Review gathering/composition, proof records, approvals, export and media. |
| [plugin-agent-image-context-pack.md](architecture/plugin-agent-image-context-pack.md) | Plugin discovery, agent images, context packs and compaction policy. |
| [packaging-bootstrap-bundles.md](architecture/packaging-bootstrap-bundles.md) | Package assembly, reusable topology bundles and bootstrap/install paths. |
| [architecture-rules-and-event-system.md](architecture/architecture-rules-and-event-system.md) | Cross-cutting invariants, events and compatibility notes. |

### Navigation, checks and reference

| Document | Read for |
|---|---|
| [codemap.md](codemap.md) | Question-to-module navigation and source entry points. |
| [arteries.md](arteries.md) | Code paths where changes affect several subsystems. |
| [test-layers.md](test-layers.md) | Test scope, isolation, scenarios and hosted CI. |
| [cli-reference.md](cli-reference.md) | CLI commands and options; confirm changing details in `packages/cli/src/index.ts` and command help. |
| [frontmatter-schema.md](frontmatter-schema.md) | Metadata fields used by these documents. |
| [architecture.md](architecture.md) | Compatibility pointer from the former monolithic architecture page. |
| [DESIGN.md](../DESIGN.md) | Visual and design-system specification. |

### Web UI reference

The following pages remain discoverable at their own historical stamps. Their contents are not
reverified by this index update.

| Document | Topic |
|---|---|
| [ui.md](ui.md) | Compatibility pointer to the UI modules. |
| [shell-and-routing.md](ui/shell-and-routing.md) | Web UI shell and routing. |
| [topology.md](ui/topology.md) | Web topology views. |
| [project-and-for-you.md](ui/project-and-for-you.md) | Project and attention surfaces. |
| [library-specs-and-design-system.md](ui/library-specs-and-design-system.md) | Library/spec views and design-system pointers. |

For the terminal UI, start at `packages/tui/src/main.ts`, its HTTP client
`packages/tui/src/daemon-client.ts`, and the TUI sections of [test-layers.md](test-layers.md).

## Derive the document inventory

At the named commit there are **26 Markdown files**: **14** under `architecture/`, **4** under
`ui/`, and **8** at the root of this tree (including both compatibility pointers). Reproduce
these counts from the repository root:

```bash
source_commit=712a61fbcc5ffe5a7c786fea12132567083ab507
git ls-tree -r --name-only "$source_commit" -- docs/as-built | rg '\.md$' | wc -l
git ls-tree -r --name-only "$source_commit" -- docs/as-built/architecture | rg '\.md$' | wc -l
git ls-tree -r --name-only "$source_commit" -- docs/as-built/ui | rg '\.md$' | wc -l
git ls-tree -r --name-only "$source_commit" -- docs/as-built | rg '^docs/as-built/[^/]+\.md$' | wc -l
```

Read a module's source stamp and prerequisite pointers before relying on it. Source code at the
named commit is the authority when prose disagrees; [frontmatter-schema.md](frontmatter-schema.md)
describes how the stamp is represented.
