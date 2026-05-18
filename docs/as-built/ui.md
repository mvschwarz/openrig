---
kind: as-built
title: ui.md — Reorganized into the Modular As-Built Tree (Redirect Stub)
status: superseded
topics: [knowledge-and-context]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  You followed an old reference to docs/as-built/ui.md. The monolith was
  reorganized (slice-08, context-architecture-v1) into the ui/ module folder.
  Go to README.md (map of territory) or codemap.md (use-case lookup), then the
  named ui/ module.
siblings: [README.md, codemap.md, architecture.md]
prerequisite-reads: []
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# ui.md was reorganized into the modular as-built tree

This single-file UI monolith was split into a folder of independently-loadable,
frontmatter-tagged thematic modules (slice-08, `context-architecture-v1`). The
canonical as-built description of the shipped operator UI now lives in `ui/`.
This stub is a forwarding pointer so old references still resolve.

**Start here:**

- [`./README.md`](./README.md) — the map of territory and full module index.
- [`./codemap.md`](./codemap.md) — navigation index: use-case lookup table and
  source-root pointers. Use this when you know *what* you need but not *which*
  module.

## Where the major content went

The UI content is now the **4 modules under `ui/`**:

| Module | What moved here |
|---|---|
| [`ui/shell-and-routing.md`](ui/shell-and-routing.md) | Package shape, the `AppShell` shell model (rail / Explorer / center workspace / drawer / preview stack), the route tree, design primitives, the shared detail-drawer/viewer system, event/activity consumption. |
| [`ui/topology.md`](ui/topology.md) | The topology surface — host hybrid graph, table/terminal views, the activity-ring / hot-potato visual language, terminal-preview popovers, navigation/overlay contracts. |
| [`ui/project-and-for-you.md`](ui/project-and-for-you.md) | The operator destination surfaces — Project observability (workspace/mission/slice scope tabs), the For-You attention feed (5-card classifier + queue actions), the Dashboard landing on the vellum brand system. |
| [`ui/library-specs-and-design-system.md`](ui/library-specs-and-design-system.md) | The Library (`/specs`) UI — specs/applications/skills surfaces, the graphics layer, the current design constraints, and the design-system pointer to `../DESIGN.md`. |

The brand/design rules still live at `docs/DESIGN.md` (repo `docs/` root, by
design — see `ui/library-specs-and-design-system.md`).
