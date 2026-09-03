# Project Workspace Contract

OpenRig's Project TUI is a file-backed view over a workspace root. The folder
shape is intentionally simple so humans and agents can create or repair it
without daemon-internal knowledge.

## Default Shape

`rig config init-workspace` creates the default workspace at
`~/.openrig/workspace` unless `--root` or `workspace.root` points elsewhere.

```text
workspace/
  SPEC.md
  project.yaml
  workspace.yaml
  .gitignore
  missions/
  exhaust/
```

The scaffold is additive: it creates missing canonical entries and never
overwrites existing files, including with the deprecated `--force` flag.
`exhaust/` and local `.openrig/` runtime projections are ignored; authored
project context and mission/slice files remain versionable. `workspace.yaml`
is the project-location catalog. A project manifest may add ordered context
references and managed skill selectors, but neither skill source nor a System
World belongs in this tree.

## UI Mapping

- `workspace.root` maps to the Project workspace.
- `workspace.catalog_path` maps to the `workspace.yaml` project catalog.
- `workspace.projects_root` is the default home for catalogued project worlds.
- `workspace.root/missions/<mission-id>` maps to a Project mission.
- `workspace.root/missions/<mission-id>/slices/<slice-id>` maps to a Project slice.
- Mission `PROGRESS.md` frontmatter supplies the mission status badge when the
  file root is allowlisted.
- Mission and slice `SPEC.md` frontmatter supplies intent, advisory sibling
  build-order `depends_on`, lifecycle status, and queue linkage hints.
- Slice `PROGRESS.md` is the durable acceptance checklist; `PROOF.md` and
  `proof/` retain evidence paired to the SPEC proof contract.

Mission and slice ids should be stable kebab-case strings. Keep slice ids
unique inside the workspace so `/project/slice/<slice-id>` resolves without
ambiguity.

## Queue Mapping

Queue items attach to a slice when their body or tags mention one of:

- the slice id;
- the mission id;
- the legacy `rail-item` value in slice frontmatter.

For new work, include both mission and slice ids in the queue item body or
tags. Example:

```text
Mission: idea-ledger
Slice: capture-product-ideas
```

This makes Story, Queue, Tests, and Topology tabs line up with the filesystem
slice without adding a separate project database schema.

## Compatibility

The default discovery root is `workspace.slices_root=<workspace.root>/missions`.
The slice indexer also supports legacy flat roots such as
`workspace.slices_root=<workspace.root>/slices`, where each direct child folder
is a slice. Flat roots remain readable, but the mission-aware shape is the
default setup contract.

## Repair Checklist

If Project shows a mission discovery warning:

1. Run `rig config get workspace.root --show-source`.
2. Run `rig config get workspace.catalog_path --show-source`.
3. Run `rig config get workspace.slices_root --show-source`.
4. Confirm `workspace.slices_root` points at a folder containing mission
   directories with `slices/` children.
5. Confirm `files.allowlist` includes `workspace:<workspace.root>` so the TUI
   can read mission `PROGRESS.md`.
6. If the workspace is missing, run `rig config init-workspace` after operator
   approval.

No daemon restart is required for most config reads. Restart when changing
startup-time roots such as `files.allowlist` or progress scan roots.
