# Project Workspace Contract

OpenRig's Project TUI is a file-backed view over a workspace root. The folder
shape is intentionally simple so humans and agents can create or repair it
without daemon-internal knowledge.

This subtree is part of the wider [OpenRig Instance Layout](instance-layout.md).
The instance initializer delegates these exact workspace bytes to this owner.

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
is the project-location catalog. The project manifest exposes empty
`install.context` and `install.skills` selectors for ordered Markdown
addresses and stable managed-catalog skill IDs, but neither skill source nor a
System World belongs in this tree.

## Project-world install

`project.yaml` may select project context and managed skills together:

```yaml
schema: openrig.project/v0alpha1
kind: project
install:
  intent: SPEC.md
  context:
    - conventions.md
  skills:
    - repository-maintenance
```

`install.context` contains project-relative Markdown addresses. `install.skills`
contains stable skill identities only. Skill source bytes live in the single
configured managed catalog (`skills.root`, default `$OPENRIG_HOME/skills`),
never under the project or workspace. `rig context work-install --runtime
<claude-code|codex>` resolves both parts; add `--apply-skills` to reconcile the
selected exact bytes into `.claude/skills/` or `.agents/skills/` under the
caller's current working directory. Use `--cwd` when the receiving agent works
somewhere else; the project-world metadata root is never assumed to be its code
working directory.

The generated harness directories and `.openrig/skill-loadouts/` ownership
receipts are projections, not source. Product repositories should ignore them.
Reconciliation removes a deselected entry only when its current bytes still
match OpenRig's last owned projection; unrelated and locally modified entries
are preserved or reported as conflicts.

Seats of the same runtime commonly share one working directory. Their topology
selectors are retained per canonical seat identity and projected as a union, so
starting one role cannot remove another role's skill. A changed projection is
visible only to a fresh harness process; reconciliation reports that boundary
instead of claiming a running seat hot-reloaded it.

An installed project selection is also retained in that working directory's
ownership receipt. A later seat start with no project-world input preserves it;
an explicit install whose `install.skills` is empty clears it. This keeps
"project not supplied" distinct from "project deliberately selects no skills."

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
