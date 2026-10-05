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

Installing a bundle that carries a project (`rig bundle create --project-dir`)
copies the project folder to `<workspace.projects_root>/<id>/`, adds its catalog
entry, and lists the bundle's rig under that entry's `rigs` (see "Work-install
project selection"), before any seat launches. Every byte already in the
catalog stays: the entry is appended in the file's own indentation and line
endings, and a later rig joins it by a one-line edit of its `rigs: [...]`.
Reinstalling changes nothing. If the file's shape doesn't allow that (for
example a flow-style list), if the id is already taken by another root, if the
folder is registered under a different id, or if the rig is already listed
under another project, install writes nothing to the catalog and prints what to
change, and the folder isn't copied either. An existing folder at
`<workspace.projects_root>/<id>/` is never overwritten: if its files differ from
the bundle's, install keeps it and says so. Without a catalog, the one it writes
keeps an entry for the workspace root beside the bundle's, under the id from the
workspace's own `project.yaml` (`default` when it declares none); if that id is the
bundle's project id, install reports a conflict and writes no catalog.

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

A project can also name world packs to read after the System World, in order:

```yaml
install:
  worlds:
    - ref: openrig-world
    - ref: project-world
      profiles: { claude: guided }
```

Each `install.worlds` entry has the same `{ ref, profiles }` shape as a System
World `context` entry. `work-install` lists them as `context world <ref>` lines
and `worlds` in `--json`; it never delivers their content, so read each with
`rig context get <ref>`. An invalid entry, or a ref the System World or an
earlier entry already lists, is ignored with a warning. Without the key, the
output is unchanged. The list holds pack names only, resolved from the local
library when read, so naming a world copies none of its content.

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

## Work-install project selection

`rig context work-install` picks one project from the catalog at
`workspace.catalog_path` (default `workspace.yaml`), in the order below. Without a
catalog, the workspace root itself is the project (`selectedBy: workspace`), and
`--project` must match its `project.yaml` id. Operating posture uses steps 3-5
the same way when a queue row names no project (see
[scoped operating posture](scoped-operating-posture.md)).

1. `--project <id>`;
2. the only declared project;
3. the project whose entry lists the calling seat's rig under `rigs`;
4. the deepest declared project root that contains the working directory
   (`--cwd`, else the current directory);
5. the only project whose entry lists no `rigs`, so a rig that isn't listed
   anywhere keeps its project after a claimed project is added beside it;
6. otherwise it stops with `project_required` and prints each candidate's exact
   command.

```yaml
schema: openrig.workspace/v0alpha1
projects:
  - id: default
    root: .
  - id: contributor
    root: projects/contributor
    rigs: [openrig-dev]
```

`rigs` is optional. A `rigs` value that isn't a list of rig names is ignored
with a warning; the entry can still be chosen by `--project`, as the only entry
or by working directory, but never counts as unclaimed in step 5. A rig listed under two projects, or two projects sharing the
deepest root, leave the choice to `--project`. Step 3 reads the seat's
`OPENRIG_SESSION_NAME`, so a plain shell skips it. `--json` reports the step
that chose the project as `position.selectedBy`.

## TUI project selection

Open **PROJECTS** (or enter `projects`) to choose an ID and root from the
configured workspace catalog. `project <id>` selects an exact catalog entry;
`mission <directory>` then opens that project's execution view. The historical
`scopes` machine section ID remains valid. Project selection and its canonical
root travel through mission, slice, source-file and Back navigation. Changing a
catalog root requires selecting it again. Missing or malformed sources remain
unavailable; another project's matching work ID is never a fallback.

`source` opens the current project, mission or slice's actual source through the
existing file-reader allowlist. Catalog membership does not grant file-read or
execution permission. These views only read; they do not select a lifecycle
operation or activate a mission. Execution and slice queue membership require
an exact `project:<id>` tag; lifecycle instances use their authored project
identity. Unscoped historical queue rows and global review artifacts without
project binding are excluded from project-specific claims.

The read API adds `GET /api/scopes/projects` and optional `project` and
`projectRoot` parameters to scopes, execution and slice-detail reads. Slice
detail also requires the selected mission directory. Existing reads without a
project parameter keep their legacy contract.

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

A `slice:<id>` tag is the authoritative way to attach a queue item to a slice;
with a project selected, typed rows also need the `project:<id>` tag. As a
fallback, for slices with no typed rows, items attach when their body or tags
mention one of:

- the slice id;
- the mission id;
- the legacy `rail-item` value in slice frontmatter.

Once any slice in a mission has typed rows, the fallback stops matching on the
mission id (and on a `rail-item` defaulted from it) for that mission's other
slices too. For new work, tag rows with `slice:<id>` (and `project:<id>`), and
include the mission and slice ids in the body as well. Example:

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
