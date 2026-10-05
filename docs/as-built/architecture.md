---
kind: as-built
title: Architecture — Module Navigation
status: superseded
topics: [knowledge-and-context]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  Following an older link to docs/as-built/architecture.md. Use the repository
  overview or the current as-built module index linked here.
siblings: [README.md, codemap.md, arteries.md, test-layers.md, ui.md]
prerequisite-reads: []
last-verified-against-source: a350c59b5a5fb37ee4a21b1026b595068b603df1
last-updated: 2026-10-05
---

# Architecture module navigation

This compatibility page points to the modular documentation. Its links were checked against main
`a350c59b5a5fb37ee4a21b1026b595068b603df1`; the linked pages retain their own source stamps.

- [Repository architecture](../../ARCHITECTURE.md): package boundaries, request flow, derived
  source counts and contributor recipes.
- [As-built index](README.md): the complete module inventory, including the existing web UI references.
- [Codemap](codemap.md): questions mapped to modules and source entry points.
- [Arteries](arteries.md): dependencies to inspect before changing shared runtime paths.
- [Test layers](test-layers.md): the checks available and what they establish.

## Daemon and runtime starting points

| Topic | Module |
|---|---|
| Boot, HTTP services and database wiring | [Daemon core](architecture/daemon-core.md) |
| Harness adapters and native session continuity | [Adapters and runtimes](architecture/adapters-and-runtimes.md) |
| Spec resolution, projection and launch | [Agent spec and startup](architecture/agent-spec-and-startup.md) |
| Durable queue and messaging state | [Coordination](architecture/coordination-primitive.md) |
| Workflow execution and watchdog policies | [Workflow runtime](architecture/workflow-runtime.md) |
| Queue observations and operator actions | [Mission control](architecture/mission-control.md) |
| Snapshot and restore | [Lifecycle](architecture/lifecycle-snapshot-restore.md) |
| Messaging, capture and transcripts | [Transport and transcripts](architecture/transport-and-transcripts.md) |
| Project and repository scope | [Workspace](architecture/workspace-primitive.md) |
| Files, progress and steering | [Content surfaces](architecture/content-surfaces.md) |
| Review, proof and approvals | [Living notes and review](architecture/living-notes-review.md) |
| Plugin discovery, images and context | [Plugins, agent images and context packs](architecture/plugin-agent-image-context-pack.md) |
| Distribution, bundles and bootstrap | [Packaging and bundles](architecture/packaging-bootstrap-bundles.md) |
| Events and cross-cutting invariants | [Architecture rules and events](architecture/architecture-rules-and-event-system.md) |

Older web UI links continue through [ui.md](ui.md). For terminal UI source, use the
[package entry points in the codemap](codemap.md#package-entry-points).
