---
kind: as-built
title: Workspace Primitive — RigSpec.workspace, Migrations 038/039, Missions/Projects/Slices
status: active
topics: [specification-and-bundles, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how a rig declares a typed workspace (workspaceRoot / repos /
  defaultRepo / knowledgeRoot), how that block is persisted and resolved into
  whoami / node-inventory, how per-item target_repo scope is validated, or how
  the file-backed missions/slices tree is indexed and projected into the
  Project UI.
siblings: [content-surfaces.md, daemon-core.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 2caac7dd1bb16585138a6f7c1dd8b1f0752c49f7
last-updated: 2026-10-05
---

# Workspace Primitive — RigSpec.workspace, Migrations 038/039, Missions/Projects/Slices

The **workspace primitive** is the typed declaration that lets a rig name
*where its work lives* — a workspace root, a set of named repos with kinds, an
optional default repo, and an optional knowledge root — and have that surface
through `whoami` / node-inventory and gate per-item repo scope. Alongside it, a
**file-backed missions/slices tree** is indexed read-only and projected into
the Project UI's mission / slice surfaces.

> Paths are relative to `packages/daemon/src/` unless prefixed `packages/` or
> `docs/`. Verified against source at main `2caac7dd1bb16585138a6f7c1dd8b1f0752c49f7`. Each count sits beside
> the command that produces it; run the commands from the repository root.
> The files / markdown / progress / steering surfaces are in the sibling
> `content-surfaces.md`.

## 0. Release attribution

Checked with `git cat-file -e <tag>:packages/daemon/src/<path>`. The table
records when each file first appeared; most have changed since.

| Subsystem | First release | Check |
|---|---|---|
| `domain/workspace/{workspace-resolver,frontmatter-validator,default-workspace-scaffold}.ts` | **≤0.3.0** | present at `v0.3.0` |
| migrations `038_workspace_primitive.ts`, `039_queue_target_repo.ts` | **≤0.3.0** | present at `v0.3.0` |
| `domain/slices/{slice-indexer,slice-detail-projector}.ts` | **≤0.3.0** | present at `v0.3.0` |
| `routes/{workspace,slices,projects}.ts` | **≤0.3.0** | present at `v0.3.0` |
| `domain/workspace/getting-started-narrative.ts` | **0.3.1** | absent at `v0.3.0`; present at `v0.3.1` |
| `routes/missions.ts` | **0.3.1** | absent at `v0.3.0`; present at `v0.3.1` |
| `domain/workspace/workspace-doctor.ts` | **0.3.2** | absent at `v0.3.1`; present at `v0.3.2` |

The workspace primitive itself (declaration, resolver, validator, migrations
038/039) is a **0.3.0** feature — do not back-attribute it to 0.3.1. The
`missions` route and the getting-started narrative are **0.3.1** additions;
the workspace doctor is **0.3.2**.

`getting-started-narrative.ts` is still in the tree, but nothing imports it:
**0** files reference it (`git grep -l 'workspace/getting-started-narrative' -- packages | wc -l`).
Workspace initialization no longer seeds a getting-started mission (§3).

## 1. The typed workspace declaration — 0.3.0

`RigSpec.workspace` is an **optional** typed block. Rigs without it stay valid;
`whoami` / node-inventory return a null workspace block in that case.

> Source: `domain/types.ts:1163–1170` (`WorkspaceSpec`), `:1153–1159`
> (`WorkspaceRepoSpec`), `:1188` (`RigSpec.workspace?`).

| Field | Shape | Notes |
|---|---|---|
| `workspaceRoot` | string | Verbatim from spec |
| `repos[]` | `{ name, path, kind }[]` | `path` resolved to absolute at parse time (`domain/rigspec-schema.ts:361–363`); authors may declare it relative to `workspaceRoot` in YAML |
| `defaultRepo?` | string | active repo when no env override / cwd match |
| `knowledgeRoot?` | string | treated as `kind=knowledge` when surfaced |

`WorkspaceKind` is a closed union of **5** members
(`grep '^export const WORKSPACE_KINDS' packages/daemon/src/domain/types.ts | grep -o '"[a-z]*"' | wc -l`):
`user`, `project`, `knowledge`, `lab`, `delivery`.

> Source: `domain/types.ts:1149–1150` (`WORKSPACE_KINDS` / `WorkspaceKind`).

In YAML the block is spelled `workspace: { workspace_root, repos: [{ name,
path, kind }], default_repo?, knowledge_root? }`. Validation requires a
non-empty `workspace_root`, a `repos` array whose names are unique and whose
`kind` is one of the five kinds, a `default_repo` that names a declared repo,
and a non-empty `knowledge_root` when present.

> Source: `domain/rigspec-schema.ts:288–347`.

### 1.1 Persistence — migration 038 + RigRepository

Migration **038** adds `workspace_json TEXT` to the `rigs` table. It holds the
typed `RigSpec.workspace` block as JSON when a rig declares one; NULL for rigs
without a workspace block.

> Source: `db/migrations/038_workspace_primitive.ts:16–21`
> (`ALTER TABLE rigs ADD COLUMN workspace_json TEXT` at `:19`); doc comment
> `:3–15`.

`RigRepository.setRigWorkspace(rigId, workspace)` persists it (UPDATE
`workspace_json` + `updated_at`); `getRigWorkspace(rigId)` reads it back,
JSON-parsing to `WorkspaceSpec` and returning `null` on parse failure. Both
are **defensive no-ops** when the column is absent (`hasRigColumn` probe) —
older test fixtures that bypass the canonical migration list don't have the
column; the setter's contract is "best-effort persistence".

> Source: `domain/rig-repository.ts:184–189` (setter; column probe `:185`),
> `:192–202` (getter; probe `:193`; parse failure → null `:199–201`);
> `hasRigColumn` `:347`.

The block is written only when declared. **3** call sites write it
(`git grep -n 'setRigWorkspace(' -- packages/daemon/src | grep -v 'rig-repository.ts' | wc -l`):
the instantiator's two rig-persist paths, `materializeValidatedSpec` and
`instantiateOnce`, each guarded by `if (rigSpec.workspace)`; and the
workspace-only import route `POST /api/rigs/import/workspace`
(`rig import --workspace-only --target-rig <rigId>`), which validates and
normalizes the block and writes it only when it differs from the stored one.

> Source: `domain/rigspec-instantiator.ts:619` (`materializeValidatedSpec`),
> `:655–657`; `:1260` (`instantiateOnce`), `:1349–1351`;
> `routes/rigspec.ts:134–173` (validation `:158`; compare-and-write
> `:168–170`), mounted `server.ts:734`; CLI
> `packages/cli/src/commands/import.ts:82`.

### 1.2 Runtime resolution — workspace-resolver

`resolveWorkspaceContext({ spec, cwd, envOverride })` (consumed by
`whoami-service`) returns the `WhoamiWorkspaceBlock` or `null` when no spec.
`activeRepo` resolution: a non-blank `envOverride` wins **verbatim** — even an
unknown repo name is honored, because operators set `OPENRIG_TARGET_REPO`
consciously (the comment at `workspace-resolver.ts:35–36`); otherwise `defaultRepo` is used **only
if it names a declared repo**. `knowledgeKind` is `"knowledge"` when
`knowledgeRoot` is declared, else `null`. The resolver accepts `cwd` but does
not use it (`workspace-resolver.ts:31`), so `rig whoami` reports the env
override or the declared `defaultRepo`, never the repo containing the seat's
working directory; node-inventory's per-node `activeRepo` (below) is the one
that follows cwd.

> Source: `domain/workspace/workspace-resolver.ts:26–52` (resolver; null
> without a spec `:32`; env override `:39–40`; declared `defaultRepo`
> `:41–42`; `knowledgeKind` `:50`).

`whoami-service` reads the persisted spec and resolves with the query's
`targetRepoOverride`, falling back to the daemon's own
`process.env["OPENRIG_TARGET_REPO"]`. `rig whoami` forwards the caller's
`OPENRIG_TARGET_REPO` as `?targetRepo=`, which the route passes on as
`targetRepoOverride`.

> Source: `domain/whoami-service.ts:333–338` (`getRigWorkspace` +
> `resolveWorkspaceContext`, env fallback `:337`); `whoami` returns
> `workspace` in its payload `:350`; `routes/whoami.ts:29`;
> `packages/cli/src/commands/whoami.ts:281–282`.

`resolveNodeWorkspace({ spec, cwd })` (consumed by `node-inventory`) derives a
per-node `NodeWorkspaceInfo` by picking the **longest declared repo path that
contains** the node's `cwd`. When no repo contains it, `kind` falls back to
`knowledge` if cwd is under `knowledgeRoot`; `activeRepo` then falls back to
the rig's `defaultRepo` (taking that repo's kind if `kind` is still unset).
Containment uses a `path.relative` boundary check (not a string `startsWith`)
so `/foo/bar` does not match `/foo/bar-other`. Node-inventory reads
`workspace_json` with its own queries rather than through `RigRepository`.

> Source: `domain/workspace/workspace-resolver.ts:57–95` (longest match
> `:67–73`; knowledge fallback `:77–79`; default-repo fallback `:82–88`),
> `isInside` `:97–103`; `domain/node-inventory.ts:705`
> (`workspace: resolveNodeWorkspace(...)`), readers `:790–799`
> (`readRigWorkspaceJson`) and `:716–726` (`readAllRigWorkspaceJson`,
> batched); `NodeWorkspaceInfo` `domain/types.ts:795–799`.

### 1.3 Per-item repo scope — migration 039 + queue validation

Migration **039** adds `target_repo TEXT` to `queue_items` plus
`idx_queue_items_target_repo`. Per the migration's comment it carries the
per-item typed repo scope when an operator passes `--target-repo <name>`; it
is NULL when the item is unambiguous against the rig's `default_repo` or no
workspace is declared, and Mission Control views surface the field for
cross-rig handoff clarity. At M nothing in the daemon's Mission Control code
reads it; the UI shows it as "Target repo" in the queue item viewer's full
detail (`packages/ui/src/components/drawer-viewers/QueueItemViewer.tsx:157`).

> Source: `db/migrations/039_queue_target_repo.ts:16–22`
> (`ALTER TABLE queue_items ADD COLUMN target_repo TEXT` at `:19`;
> `CREATE INDEX … idx_queue_items_target_repo` at `039_queue_target_repo.ts:20`); doc comment
> `:3–15`; CLI flag `packages/cli/src/commands/queue.ts:461`.

`validateTargetRepo` checks an explicit `targetRepo` against the **source
rig's** `RigSpec.workspace.repos[]`: it parses the source session with
`parseSessionName`, looks the rig up by name, reads `getRigWorkspace`, and
rejects an unknown repo with 400 `unknown_target_repo` plus the `knownRepos`
list. It **fails open** (`{ ok: true }`) when there is no rigRepo, the session
is not a canonical `<member>@<rig>` name, the rig is unknown, or no workspace
is declared — validation only bites when a workspace actively declares repos.

It runs on **3** routes (`grep -c 'validateTargetRepo(c,' packages/daemon/src/routes/queue.ts`):
`POST /create` (through the shared `createInputRefusal` check, which also
requires `destinationSession` and `body`), `POST /:qitemId/handoff` and
`POST /:qitemId/handoff-and-complete`, each before any cross-host forwarding,
because the source rig's workspace lives on the source host.
`createInputRefusal` also runs in the in-process create that finishes a
handoff an earlier self-forward started (a `hostId` equal to this daemon's own
id). A handoff that inherits the source row's `targetRepo` without an override
is not re-validated.

`--target-repo` is accepted by `rig queue create`, `handoff` and
`handoff-and-complete`. `rig queue list --target-repo <name>`
(`GET /api/queue/list?targetRepo=`) filters rows by exact `target_repo`
match; the filter is skipped when the column is absent.

> Source: `routes/queue.ts:96–123` (fail-open guards `:102`, `:106`, `:109`,
> `:112`; `getRigWorkspace` `:111`; `unknown_target_repo` + `knownRepos`
> `:114–120`); `createInputRefusal` `:128–141` (call `:136`), used by
> `/create` `:490` and the self-forward create `:436`; handoff calls `:679`,
> `:758` in handlers `:650`, `:732` (`/create` handler `:450`); ordering note
> `:482–489`; inherited value `:676–677`, `domain/queue-repository.ts:1681`,
> `:1858`; list filter `routes/queue.ts:906`,
> `domain/queue-repository.ts:3226–3228`, CLI
> `packages/cli/src/commands/queue.ts:1143`; mounted `server.ts:784`.

## 2. Workspace HTTP route — frontmatter validator and doctor

`workspaceRoutes()` (mounted `server.ts:785` as `/api/workspace`) exposes **2**
endpoints (`grep -c -E 'app\.(get|post)\(' packages/daemon/src/routes/workspace.ts`).
**Neither mutates the filesystem.**

- `POST /api/workspace/validate` — body `{ root, workspaceKind?, recursive?,
  requireFrontmatter?, maxFiles? }`; returns a `FrontmatterValidationReport`.
  `root` is required (400 `root_required`); an out-of-vocabulary
  `workspaceKind` is rejected 400 `invalid_workspace_kind`; validator throws →
  500 `validate_failed`.
- `POST /api/workspace/doctor` — runs `runWorkspaceDoctor` against the
  daemon's resolved `workspace.root`, or a `workspaceRoot` given in the body,
  and returns its report. 503 `settings_unavailable` without a settings
  store; 500 `doctor_failed` when it throws. The doctor runs **8** checks in
  order (root reachable, missions folder, file allowlist, daemon points at
  this workspace, config changed since start, optional slice docs, mission
  notes, SDLC convention sections), each `ok`/`warn`/`fail` with a fix hint,
  plus a summary count. With a body `workspaceRoot`, missions are checked at
  `<workspaceRoot>/missions`. (The orchestrator's own doc comment still says
  7.)

> Source: `routes/workspace.ts:16` (no mutation), `:37–74` (validate;
> root-required `:46–48`; kind check `:50–58`; 500 `:72`), `:85–160`
> (doctor; 503 `:87`; missions root from the body `:115–118`;
> `runWorkspaceDoctor` call `:145`; 500 `:158`);
> `domain/workspace/workspace-doctor.ts:643–685` (the 8 checks; comment
> `:636`); mounted `server.ts:785`.

`validateWorkspaceFrontmatter()` walks a root, parses each `.md` file's YAML
frontmatter (delimited `---` on the first line), and emits a structured gap
report — **advisory only, never modifies files**. There are **4** gap kinds
(`sed -n '/^export type FrontmatterGapKind/,/;$/p' packages/daemon/src/domain/workspace/frontmatter-validator.ts | grep -c '^  | '`):
`missing-required-field`, `unrecognized-status-value`, `parse-error`,
`missing-frontmatter`. Per-kind required fields (checked only when a kind is
given): `user`/`project` → `["doc"]`; `knowledge`/`lab`/`delivery` →
`["doc","status","created","owner"]`. The `status` enum has **4** values
(`grep '^const VALID_STATUS_VALUES' packages/daemon/src/domain/workspace/frontmatter-validator.ts | grep -o '"[a-z]*"' | wc -l`):
`active|draft|archived|superseded`. Default behavior skips files without
`---` silently (informal notes) unless `requireFrontmatter`; recurses by
default; skips `node_modules` / `.git` / `.worktrees` / `dist` / `build`;
hard cap `maxFiles` default 10000.

> Source: `domain/workspace/frontmatter-validator.ts:12` (advisory), `:23–27`
> (gap kinds), `:53` (status enum), `:56–62` (per-kind required), `:81–83`
> (defaults), `:90–121` (walk; skip-dirs `:105–111`), `:160–172`
> (missing-frontmatter behavior), `:201–226` (required + status check), `:239`
> (opening delimiter).

CLI surface: `rig workspace validate [root]` and `rig workspace doctor`.

> Source: `packages/cli/src/commands/workspace.ts:86` (`validate`), `:146`
> (`doctor`); `docs/as-built/cli-reference.md#workspace`.

## 3. Default project-workspace scaffold

`workspaceScaffoldDirs()` / `workspaceScaffoldFiles()` produce the repo-ready
default workspace (`~/.openrig/workspace/`, the default `workspace.root`, or
`--root`). It emits exactly **2** directories
(`grep '^const WORKSPACE_DIRS' packages/daemon/src/domain/workspace/default-workspace-scaffold.ts | grep -o '"[a-z]*"' | wc -l`):
`missions/`, `exhaust/`; and **4** files
(`sed -n '/^export function workspaceScaffoldFiles/,/^}/p' packages/daemon/src/domain/workspace/default-workspace-scaffold.ts | grep -c 'relPath: "'`):
`SPEC.md`, `project.yaml`, `workspace.yaml`, `.gitignore`. The catalog
(`workspace.yaml`) points its single `default` project at `.`; `project.yaml`
names `SPEC.md` as project intent, roots mission discovery at `missions`, and
exposes empty `install.context` / `install.skills` selectors. The ignore file
excludes `exhaust/` and local `.openrig/` projection state while keeping
authored project context versionable.

`ensureDefaultWorkspace()` applies the scaffold additively: it creates only
missing paths and never deletes or overwrites an existing file. It checks
every managed path first; if one exists with the wrong kind (a file where a
directory belongs, or the reverse) it writes nothing and returns `ok: false`
with the conflicts. Its callers are the shared instance initializer
`ensureOpenRigInstance()`, which both CLI daemon start and direct daemon start
run (so the scaffold is reconciled on every start); `rig config
init-workspace`; and `POST /api/config/init-workspace` (409
`init_workspace_conflict`). The retained `--force` spelling is a
compatibility no-op. The CLI command re-exports the daemon's owner from
`@openrig/daemon/instance-initialization` rather than keeping its own copy,
and a parity test pins the CLI and daemon layouts as byte-identical. Mission
and slice content is created explicitly through `rig scope`, not seeded by
workspace initialization. Instance context, System World, skill source,
runtime state, and the retired `artifacts/`, `evidence/`, `progress/`,
`field-notes/`, `dogfood-evidence/`, `README.md`, and `STEERING.md` entries
are not emitted.

> Source: `domain/workspace/default-workspace-scaffold.ts:7` (dirs),
> `:20–30` (`project.yaml`), `:32–36` (`workspace.yaml`), `:38–41`
> (`.gitignore`), `:43–54` (`workspaceScaffoldDirs`,
> `workspaceScaffoldFiles`), `:100–153` (`ensureDefaultWorkspace`; conflicts
> checked before writes `:117–135`; write-if-missing `:140`);
> `domain/instance-initialization.ts:39` (`ensureOpenRigInstance`; default
> workspace root `:44`; dry-run plan `:83`; apply `:103`); default
> `workspace.root` `domain/user-settings/settings-store.ts:28–31`; daemon
> `index.ts:250`; CLI `packages/cli/src/daemon-lifecycle.ts:658`;
> `packages/cli/src/commands/config-init-workspace.ts:10` (import), `:13`
> (re-export), `:28` (`--force`), `:56–67` (`runInitWorkspace`);
> `routes/config.ts:56–65`, mounted `server.ts:772`; `rig scope`
> `packages/cli/src/commands/scope.ts:2071`; parity
> `packages/daemon/test/getting-started-narrative-parity.test.ts:15–25`,
> retired entries `:43–57`.

### 3.1 The workspace catalog and project selection

`workspace.yaml` at `workspace.catalog_path` (default
`<workspace.root>/workspace.yaml`) lists `projects[]`, each with a string `id`,
a `root` relative to the catalog file, and an optional `rigs` list naming the
rigs that work in that project. With one entry, that project is selected
implicitly. With several, `rig context work-install` and the daemon's
operating posture use an explicit `--project` first, then the calling rig's
`rigs` association, then the unique deepest project root that contains the
working directory, then the only entry no rig claims; otherwise they stop with
`project_required` and the candidate ids. Duplicate ids are refused
(`project_identity_ambiguous`), and a root that does not exist gives
`project_root_missing`.

Installing a bundle that carries a project places it at
`<workspace.projects_root>/<id>/` (default `<workspace.root>/projects`) and
records it in the catalog before the rig's seats launch: a new entry is
appended as text, or the rig is added to an entry's `rigs` list. Existing
catalog bytes are never rewritten; a conflict writes nothing for that part and
reports the exact line to add.

Daemon reads accept `?project=<id>`, resolved by `selectedProject()`: the id
must be in the catalog (or be the single uncatalogued workspace project, whose
id comes from its `project.yaml` or defaults to `workspace`), the project's
`project.yaml` `missions.root` must stay inside the project, and a supplied
`?projectRoot` must still match. Every failure answers 409 with its code.
`GET /api/scopes/projects` lists the projects with their missions roots.

> Source: `domain/workspace/project-catalog.ts:16–25` (`readProjectCatalog`),
> `:26–37` (`selectCatalogProject`), `:66–79` (`inferCatalogProject`, steps
> 3–5); `domain/user-settings/settings-store.ts:489–490`
> (`workspace.projects_root`, `workspace.catalog_path`);
> `domain/workspace/project-registration.ts:6–29` (rules), `:36–37`
> (projects root), `:181` (`registerBundleProject`), called from
> `domain/bundle-content-routing.ts:184`; `domain/workspace/project-read.ts:44–60`
> (`projectEntry`), `:61–69` (`listProjects`), `:70–81` (`selectedProject`),
> `:83–84` (409); `routes/scopes.ts:34`, mounted `server.ts:820`.

## 4. File-backed missions / slices tree

### 4.1 SliceIndexer — 0.3.0

`SliceIndexer` reads slice folders from configured filesystem roots. The
**default workspace contract** is `workspace/missions/<mission>/slices/<slice>`;
flat roots (`workspace/slices/<slice>`) remain supported for compatibility.
A nested `slices/` child folder makes the parent a mission
(`missionId = <mission-folder>`); a bare folder is a flat slice
(`missionId = null`). Startup builds the indexer on `workspace.slices_root`
(default `<workspace.root>/missions`) and adds `<workspace.root>/missions` and
`<workspace.root>/slices` as extra roots. NO new SQLite migration, NO new event
type: read-only projection over existing tables (`queue_items`,
`queue_transitions`, `mission_control_actions`) + dogfood-evidence
directories. Listing, detail and mission-status caches are time-bounded (60 s
default); `invalidate()` drops all three plus the queue-membership index.
Besides the TTL, every unscoped list or detail read first compares a basis
built from each mission's `mission.yaml` text and `slices/` listing and drops
the caches when it changes. When the indexer is ready, startup also watches the
workspace and invalidates the indexer when proof sources change, emitting
`proof.sources_changed`.
`isReady()` is true when any configured slice root exists on disk. A set
`OPENRIG_SLICES_ROOT` still takes precedence over `workspace.slices_root`.

Slices are keyed by folder name alone: when two missions (or two roots) hold a
slice with the same name, only the first one walked is indexed, and
`/api/slices/:name` and `/project/slice/$sliceId` address it by that bare
name. The project-scoped read (`?project=…&mission=…`, §4.3) is the one path
that selects by mission. A slice's `qitemIds` come first from rows tagged
`slice:<id>`, then from the legacy match on the rail item or slice name; in a
project-scoped indexer only rows tagged `project:<id>` count, so untagged
historical rows are not attributed to a selected project.

> Source: `domain/slices/slice-indexer.ts:2–15` (contract + no new state),
> `:238` (TTL), `:297–299` (`isReady`), `:331–336` (`invalidate`),
> `:457–472` (`reconcileComposition`), `:476–521` (`readSliceLocations`;
> first name wins `:478–483`; nested-vs-flat `:495–517`), `:61–88`
> (`SliceRecord`: `missionId` `:65`, `slicePath` `:67`, `qitemIds` `:77`,
> `proofPacket` `:81`), `:90–111` (`SliceListEntry`, which carries
> `qitemCount` / `hasProofPacket` instead), `:865–875` and `:936–946` (queue
> membership; project filter `:870`, `:942`); `domain/workspace/project-catalog.ts:132–138`
> (`belongsToProject`); startup `startup.ts:1705`, `:1718` (`OPENRIG_SLICES_ROOT`
> first), `:1725–1730`, `:1743–1748`, proof-source watch `:1762–1765`
> (`domain/proof/source-watch.ts:16`); default
> `domain/user-settings/settings-store.ts:486`.

### 4.2 SliceDetailProjector — 0.3.0

Given a `SliceRecord`, the projector assembles the full per-slice payload
across six tabs (Story, Acceptance, Decisions, Docs, Tests/Verification,
Topology) — **6** tab keys in `SliceDetailPayload`
(`sed -n '/^export interface SliceDetailPayload/,/^}/p' packages/daemon/src/domain/slices/slice-detail-projector.ts | grep -c -E '^  (story|acceptance|decisions|docs|tests|topology):'`),
plus a `readiness` field. Read-only; composes already-shipped tables +
`workflow_specs`/`workflow_instances`/`workflow_step_trails` + slice docs on
disk + dogfood-evidence. **v1 removed the v0 hardcoded legacy phase taxonomy**
(`discovery`/`product-lab`/`delivery`/…): `StoryEvent.phase` is now an
open-ended string-or-null — the spec-defined `step.id` when bound to a
`workflow_instance`, else `null` (UI groups under "Untagged"). When no
workflow runtime is constructed the projector silently degrades to v0
behavior (`workflowBinding`, `specGraph`, `phaseDefinitions` and
`currentStep` all `null`).

> Source: `domain/slices/slice-detail-projector.ts:1–20` (six-tab contract +
> v1 enrichment), `:16–20` (v0 phase taxonomy removed), `:64`
> (`StoryEvent.phase`), `:177–203` (`SliceDetailPayload`), `:205–213`
> (optional `workflowSpecCache`); startup degrade path
> `startup.ts:1749–1760` (comment `:1749–1755`;
> `workflowSpecCache: workflowRuntime?.specCache` `:1759`).

### 4.3 Slices routes — 0.3.0

`slicesRoutes()` (mounted `server.ts:803` as `/api/slices`) registers **5**
handlers (`grep -c -E 'app\.(get|post)\(' packages/daemon/src/routes/slices.ts`):

- `GET /` — filter `all|active|done|blocked` (default `all`; anything else is
  400 `filter_invalid`); `?refresh=1` (or `true`) invalidates first; optional
  `?boundToWorkflow=<name>:<version>` lens narrows to slices bound to a
  workflow instance (400 `boundToWorkflow_invalid` without the colon). Each
  slice row carries `readiness`, and a `missions` sidecar carries authored
  mission status and readiness. Rows sort by last activity, newest first.
- `POST /refresh` — drops the indexer caches, no daemon restart.
- `GET /:name/proof-asset/*` — serves a proof asset from the slice's matched
  dogfood-evidence directory; rejects `..` (400); `Cache-Control: public,
  max-age=86400`; byte ranges (206 / 416).
- `GET /:name/doc/*` — markdown for the Docs tab; rejects `..`.
- `GET /:name` — full per-tab payload. With `?project=<id>` it also requires
  `?mission=<id>` (400 `exact_mission_and_slice_required`) and reads through
  an indexer scoped to that project's missions root.

503 `slices_indexer_unavailable` when unwired; on `GET /`, 503
`slices_root_not_configured` + setup hint when not ready. **Route-order
discipline:** literal `/` / `/refresh` / `/:name/proof-asset/*` /
`/:name/doc/*` are registered BEFORE the dynamic `/:name` so they are not
shadowed.

> Source: `routes/slices.ts:33–198` (handlers; route-order comments
> `:36–37`, `:118`, `:126–127`, `:175`; 503s `:40–46`; filters `:31`,
> `:47–53`; refresh `:54–57`; `boundToWorkflow` `:67–93`; readiness +
> `missions` sidecar `:99–110`; `/refresh` `:119–124`; proof asset
> `:131–154`, cache header `:235`, ranges `:237–266`; doc `:158–173`;
> project scope `:180–190`); mounted `server.ts:803`.

### 4.4 Missions route — 0.3.1

`missionsRoutes()` (mounted `server.ts:814` as `/api/missions`) is the
mission scope data layer, with **2** handlers
(`grep -c -E 'app\.(get|post)\(' packages/daemon/src/routes/missions.ts`).

`GET /:missionId` returns
`{ missionId, missionPath, readiness, slices, workflow_spec, topology, status }`:

- `slices` — filtered from the SliceIndexer by `missionId`, each with its
  `readiness`;
- `missionPath` — two levels up from any slice's `slicePath`;
- `workflow_spec` — parsed from the frontmatter of the mission's node file
  (`SPEC.md`, else legacy `README.md`) with the same `parseWorkflowSpecRef`
  helper the slice-indexer exports;
- `topology.specGraph` — projected via `projectSpecGraph(spec, null)` when the
  spec is cached; `{ specGraph: null }` when declared but not cached (or no
  cache is wired); `null` when nothing is declared;
- `readiness` — the mission's proof readiness;
- `status` — `metadata.status` from `mission.yaml` when present, else the
  node file's `status` frontmatter.

`POST /:missionId/complete` sets the mission status to `complete`:
`metadata.status` in `mission.yaml` when the manifest exists (other fields and
comments kept), otherwise the `status` line in the node file's frontmatter
(creating `SPEC.md` when the mission has no node file). It is idempotent.
After a successful write it drops the indexer's mission-status cache so the
next `/api/slices` read sees the new status. The daemon is the audit-trail surface; the UI keeps an
optimistic localStorage mirror. 404 `mission_not_found` when no slices match;
500 `mission_complete_write_failed` on a write error.

> Source: `routes/missions.ts:45–88` (GET; 503s `:46–64`; 404 `:68–70`;
> readiness + status `:77–78`; response `:79–87`), `:95–125` (complete; 500
> `:110–117`; cache drop `:123`), `:132–163` (`writeMissionStatusComplete`;
> manifest `:133–141`; node file `:145–162`), `:169–171`
> (`computeMissionPath` up two levels), `:179–186` (`readMissionStatus`),
> `:192–198` (`readMissionWorkflowSpec`), `:226–236`
> (`computeMissionTopology`); node-file precedence
> `domain/scope/node-file.ts:17`; readiness
> `domain/proof/judgments.ts:288–295`; UI mirror
> `packages/ui/src/hooks/useCompletedMissions.ts:15`; mounted `server.ts:814`;
> §0: `routes/missions.ts` absent at `v0.3.0` ⇒ **0.3.1**.

### 4.5 Projects route — stream classifier — 0.3.0

`projectsRoutes()` (mounted `server.ts:786` as `/api/projects`) backs the
`rig project` CLI verb — the **stream-item classifier** (lease lifecycle +
idempotent classify + operator-verb reclaim + attempt ledger + SSE), NOT the
Project *workspace UI* (that is the slices/missions surface above; the naming
overlap is a documented seam). Endpoints:

- `GET /worker-sources` — requires `?project=<id>`, a workspace catalog
  project;
- `GET /shadow`, `POST /shadow/drain`, `POST /shadow/stop` (the last two take
  an optional body `{ actor }`);
- `POST /lease/acquire` (optional `evaluateDeadnessFirst` clears stale/dead
  leases first), `POST /lease/heartbeat`, `POST /reclaim-classifier`;
- `POST /project` (idempotent on `stream_item_id`);
- `POST /attempts/begin`, `POST /attempts/:attemptId/abstain`,
  `POST /attempts/:attemptId/fail`, `GET /eligible`;
- `GET /lease`, `GET /list`, `GET /sse` + `GET /watch` (SSE);
- `GET /:projectId`.

**Route-order discipline:** every literal path is registered BEFORE the bare
`/:projectId` catchall, which comes last.

> Source: `routes/projects.ts:27–375` (handlers; route-order notes `:25`,
> `:240`, `:309`, `:322`, `:339–340`, `:366`); worker sources `:98–109`;
> shadow `:111–127`; lease / reclaim / project `:129–237`
> (`evaluateDeadnessFirst` `:142–144`); attempts and eligible `:239–306`;
> lease and list `:308–336`; SSE `:338–364`; `/:projectId` `:366–372`;
> error-code → HTTP mapping `:58–95`; CLI
> `packages/cli/src/commands/project.ts:46`; mounted `server.ts:786`.

## 5. UI route reality — source-verified at routes.tsx

`packages/ui/src/routes.tsx` is **605** lines (`wc -l < packages/ui/src/routes.tsx`)
and uses TanStack Router (`createRoute({ path, component })` objects), NOT JSX
`<Route>` (**0** matches: `grep -c '<Route' packages/ui/src/routes.tsx`). The
mission / project / slice destinations as they exist:

| Path | routes.tsx reality | routes.tsx:NN |
|---|---|---|
| `/project` (workspace) | **REAL route** — `WorkspaceScopePage` | `:136–140` |
| `/project/mission/$missionId` | **REAL route** — `MissionScopePage` | `:142–146` |
| `/project/slice/$sliceId` | **REAL route** — `SliceScopePage` | `:148–152` |
| `/files` | **REAL route** — `FilesWorkspace` (see content-surfaces.md) | `:248–252` |
| `/mission-control` | **`<Navigate to="/for-you" />`** redirect-stub (the Mission Control *system* lives in the daemon at `/api/mission-control`, not as a UI destination) | `:496–500` |
| `/slices` | **`<Navigate to="/project" />`** redirect-stub | `:503–507` |
| `/slices/$name` | **`<Navigate to="/project/slice/$sliceId" />`** redirect-stub | `:509–516` |
| `/progress` | **`<Navigate to="/project" />`** redirect-stub (folds into Project tabs) | `:519–523` |
| `/steering` | **`<Navigate to="/project" />`** redirect-stub (folds into the Project workspace overview tab) | `:526–530` |
| `/missions` (top-level) | **NO route** — missions are reached only via `/project/mission/$missionId` | absent: **0** (`grep -c 'path: "/missions"' packages/ui/src/routes.tsx`) |
| `/markdown` | **NO route** — markdown is a component in file/drawer surfaces, not a destination (see content-surfaces.md) | absent: **0** (`grep -c 'path: "/markdown"' packages/ui/src/routes.tsx`) |

> Source: `packages/ui/src/routes.tsx:136–152` (project routes), `:248–252`
> (`/files`), `:484–530` (redirect block, which also redirects `/context` to
> `/topology`), `:539–597` (route tree); `/api/mission-control` mounted
> `packages/daemon/src/server.ts:790–793`.

Net: the daemon `/api/missions` + `/api/slices` + `/api/projects` routes are
real. The **operator-facing UI** consumes the missions and slices routes
through the `/project*` destinations; it does not call `/api/projects`
(**0** files: `git grep -l '/api/projects' -- packages/ui/src | wc -l`).
`/mission-control`, `/slices`, `/progress`, `/steering` are redirect-stubs
(the systems exist at the daemon layer; the URLs were collapsed into
`/project` / `/for-you`).

> Source: `packages/ui/src/hooks/useMission.ts:51` (`/api/missions`),
> `packages/ui/src/hooks/useSlices.ts:84` (`/api/slices`).

## 6. Cross-cutting properties

- **Optional + valid-without:** rigs without a `workspace` block stay valid;
  whoami / node-inventory return null and queue target-repo validation fails
  open (`workspace-resolver.ts:32`, `:62`; `rig-repository.ts:185`, `:193`;
  `routes/queue.ts:112`).
- **Defensive column access:** `RigRepository` probes for `workspace_json`
  (`rig-repository.ts:185`, `:193`), node-inventory's own reads fall back to
  null on error (`node-inventory.ts:724`, `:796–798`), and the queue
  repository detects `target_repo` (`queue-repository.ts:752`), so partial
  test fixtures don't crash. Migrations 038/039 ship separately so a fixture
  can apply only the half it needs (`038_workspace_primitive.ts:12–14`).
- **Read-only projection, no new state for the tree:** SliceIndexer /
  SliceDetailProjector add NO migration / event type; only the workspace
  declaration (038) + per-item scope (039) touch SQLite
  (`slice-indexer.ts:14–15`).
- **Advisory, never deletes:** the frontmatter validator never modifies files
  (`frontmatter-validator.ts:12`), and the workspace scaffold never deletes or
  overwrites operator content (`default-workspace-scaffold.ts:140`;
  `packages/cli/src/commands/config-init-workspace.ts:18`).

## Open items

- `resolveWorkspaceContext` honors an `envOverride` **verbatim even when it
  names no declared repo** (`workspace-resolver.ts:39–40`), whereas the queue
  route **rejects** an unknown `target_repo` against the same `repos[]`
  (`routes/queue.ts:114–120`). These two surfaces apply opposite policies to
  an unknown repo name (whoami trusts the operator; queue validates). The
  resolver's comment at `workspace-resolver.ts:35–36` states the verbatim behavior is intended, but
  the comment line before it (`workspace-resolver.ts:34`) and `whoami-service.ts:331–332` describe
  a repo-name check that the code does not perform. Stated as-is; the
  divergence is not reconciled in source.
- The `/api/projects` *classifier* and the `/project*` *workspace UI*
  (slices/missions) share the word "project" but are different subsystems.
  Both accept a workspace catalog project as `?project=<id>`
  (`routes/projects.ts:105`; `routes/slices.ts:181`). Documented as a naming
  seam; no source defect.
