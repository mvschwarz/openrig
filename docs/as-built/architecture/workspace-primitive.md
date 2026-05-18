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
  Project UI. Author-mode module — no prior architecture.md prose; every
  load-bearing claim is sourced to file:line at HEAD.
siblings: [content-surfaces.md, daemon-core.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Workspace Primitive — RigSpec.workspace, Migrations 038/039, Missions/Projects/Slices

The **workspace primitive (PL-007)** is the typed declaration that lets a rig
name *where its work lives* — a workspace root, a set of named repos with
kinds, an optional default repo, and an optional knowledge root — and have
that surface through `whoami` / node-inventory and gate per-item repo scope.
Alongside it, a **file-backed missions/slices tree** is indexed read-only and
projected into the Project UI's mission / slice surfaces.

> **AUTHOR-FROM-SOURCE module.** No prior `architecture.md` prose exists for
> this. Every load-bearing claim carries `> Source: <file:line> @HEAD`;
> ambiguity is declared as an OPEN item, never smoothed. Paths are relative to
> `packages/daemon/src/` unless prefixed `packages/` or `docs/`.
>
> Verified at HEAD `7eaf524c` (`git describe` → `v0.3.1-6-g7eaf524c`).
> Package version **0.3.1**; HEAD carries 6 unreleased release-0.3.2 commits;
> no `v0.3.2` tag (daemon-core.md; slice-00 §1.1).
>
> **SPLIT NOTE (§10.6).** The honest source-grounded scope of
> `workspace-and-content-primitives` (proposed-structure.md §4.9 / D13)
> exceeds ~400 lines across two distinct subsystem clusters with distinct
> source roots. Per the §10.6 SPLIT DIRECTIVE it is split by subsystem
> cluster into this module (workspace primitive + migrations 038/039 +
> missions/projects/slices) and the sibling `content-surfaces.md`
> (files/markdown/progress/steering). This is a transparent noted deviation
> from ratified Q7 "18", a faithful application of the founder's own
> ratified Q3 principle ("distinct primitive / distinct source root →
> split"); surfaced at the slice-08 review gate, not a mid-execution
> interrupt.

## 0. Release attribution (forensic proof — read first)

Per §10.8, re-verified at HEAD via `git cat-file -e <tag>:<path>`:

| Subsystem | Release | Forensic proof @HEAD |
|---|---|---|
| `domain/workspace/{workspace-resolver,frontmatter-validator,default-workspace-scaffold}.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| migrations `038_workspace_primitive.ts`, `039_queue_target_repo.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| `domain/slices/{slice-indexer,slice-detail-projector}.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| `routes/{workspace,slices,projects}.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| `domain/workspace/getting-started-narrative.ts` | **0.3.1** | `v0.3.0:` → **ABSENT**; `v0.3.1:` → present |
| `routes/missions.ts` | **0.3.1** | `v0.3.0:` → **ABSENT**; `v0.3.1:` → present |

> Source: §10.8 proof re-run at HEAD `7eaf524c` —
> `git cat-file -e v0.3.0:packages/daemon/src/domain/workspace/getting-started-narrative.ts`
> and `...routes/missions.ts` both fail ("exists on disk, but not in
> 'v0.3.0'"); all other listed paths resolve at `v0.3.0`. The workspace
> primitive itself is a **0.3.0** feature (slice-00 0.3.0-GT §1.4, PL-007,
> migrations 038/039) — do not back-attribute it to 0.3.1. The
> `missions` route + the getting-started narrative scaffold are the
> **0.3.1** additions layered on top (slice 12 mission scope; slice 21
> onboarding-conveyor).

slice-00 0.3.0-GT §1.4 independently confirms the primitive shipped 0.3.0:
workspace-primitive merge `2ce54abc` (PL-007) with migrations
`038_workspace_primitive` + `039_queue_target_repo`, "fresh databases apply
migrations through `039_queue_target_repo`".

## 1. The typed workspace declaration (PL-007) — 0.3.0

`RigSpec.workspace` is an **optional** typed block. Rigs without it stay valid;
`whoami` / node-inventory return a null workspace block in that case.

> Source: `domain/types.ts:762-770` (`WorkspaceSpec`), `:751-758`
> (`WorkspaceRepoSpec`), `:780` (`RigSpec.workspace?`) @HEAD.

| Field | Shape | Notes |
|---|---|---|
| `workspaceRoot` | string | Verbatim from spec |
| `repos[]` | `{ name, path, kind }[]` | `path` resolved to absolute at parse time; authors may declare relative to `workspaceRoot` in YAML |
| `defaultRepo?` | string | active repo when no env override / cwd match |
| `knowledgeRoot?` | string | treated as `kind=knowledge` when surfaced |

`WorkspaceKind` is a closed 5-member union: `user`, `project`, `knowledge`,
`lab`, `delivery`.

> Source: `domain/types.ts:748-749` (`WORKSPACE_KINDS` /
> `WorkspaceKind`) @HEAD.

### 1.1 Persistence — migration 038 + RigRepository

Migration **038** adds `workspace_json TEXT` to the `rigs` table. It holds the
typed `RigSpec.workspace` block as JSON when a rig declares one; NULL for rigs
without a workspace block.

> Source: `db/migrations/038_workspace_primitive.ts:16-21`
> (`ALTER TABLE rigs ADD COLUMN workspace_json TEXT`); doc-comment
> `:3-14` @HEAD.

`RigRepository.setRigWorkspace(rigId, workspace)` persists it (UPDATE
`workspace_json` + `updated_at`); `getRigWorkspace(rigId)` reads it back,
JSON-parsing to `WorkspaceSpec` and returning `null` on parse failure. Both
are **defensive no-ops** when the column is absent (`hasRigColumn` probe) —
older test fixtures that bypass the canonical migration list don't have the
column; the setter's contract is "best-effort persistence".

> Source: `domain/rig-repository.ts:98-105` (setter, column probe
> L99), `:106-117` (getter; parse-fail → null L114-116) @HEAD.

The instantiator persists the block at rig-create time **only when declared**:

> Source: `domain/rigspec-instantiator.ts:653-655` (`if
> (rigSpec.workspace) … setRigWorkspace(rigId, rigSpec.workspace)`) @HEAD.

### 1.2 Runtime resolution — workspace-resolver

`resolveWorkspaceContext({ spec, cwd, envOverride })` (consumed by
`whoami-service`) returns the `WhoamiWorkspaceBlock` or `null` when no spec.
`activeRepo` resolution: an `envOverride` (non-empty, trimmed) wins
**verbatim** — even an unknown repo name is honored, because operators set
`OPENRIG_TARGET_REPO` consciously (PL-007 PRD § Item 3); otherwise
`defaultRepo` is used **only if it names a declared repo**. `knowledgeKind`
is `"knowledge"` when `knowledgeRoot` is declared, else `null`.

> Source: `domain/workspace/workspace-resolver.ts:26-52` (resolver;
> env-override-verbatim L34-43, including the "honored verbatim"
> comment L35-36) @HEAD.

`whoami-service` reads the persisted spec and resolves with the query's
`targetRepoOverride`, falling back to `process.env["OPENRIG_TARGET_REPO"]`:

> Source: `domain/whoami-service.ts:319-324` (`getRigWorkspace` +
> `resolveWorkspaceContext`, env fallback L323); `whoami` returns
> `workspace` in its payload `:335` @HEAD.

`resolveNodeWorkspace({ spec, cwd })` (consumed by `node-inventory`) derives a
per-node `NodeWorkspaceInfo` by walking the node's `cwd` up the directory
tree for the **longest-prefix repo path** that contains it; falls back to
`knowledge` when cwd is under `knowledgeRoot`, then to the rig's
`defaultRepo` when cwd doesn't resolve. Containment uses a `path.relative`
boundary check (not a string `startsWith`) so `/foo/bar` does not match
`/foo/bar-other`.

> Source: `domain/workspace/workspace-resolver.ts:57-95`
> (longest-prefix L67-73; knowledge fallback L77-79; default-repo
> fallback L82-88), `isInside` `:97-103`;
> `domain/node-inventory.ts:397` (`workspace: resolveNodeWorkspace(...)`),
> `:434-437` (`NodeWorkspaceInfo`) @HEAD.

### 1.3 Per-item repo scope — migration 039 + queue validation

Migration **039** adds `target_repo TEXT` to `queue_items` plus
`idx_queue_items_target_repo`. It carries the per-item typed repo scope when
an operator passes `--target-repo <name>`; NULL when the qitem is
unambiguous against the rig's `default_repo` or no workspace is declared.
Mission Control views surface the field for cross-rig handoff clarity.

> Source: `db/migrations/039_queue_target_repo.ts:16-22`
> (`ALTER TABLE queue_items ADD COLUMN target_repo TEXT` +
> `CREATE INDEX … idx_queue_items_target_repo`); doc-comment
> `:3-14` @HEAD.

The queue route validates `target_repo` at the route layer against the
**source rig's** `RigSpec.workspace.repos[]`: it parses the rig name out of
`source_session` (`<member>@<rig>`), looks up the rig, reads
`getRigWorkspace`, and rejects an unknown repo with `unknown_target_repo` +
the known-repo list. It **fails open** (`{ ok: true }`) when there is no
rigRepo, no parseable rig, the rig is unknown, or no workspace is declared —
validation only bites when a workspace actively declares repos.

> Source: `routes/queue.ts:49-57` (fail-open guards), `:55`
> (`getRigWorkspace`), `:58-66` (`unknown_target_repo` +
> `knownRepos`) @HEAD.

## 2. Workspace HTTP route — frontmatter validator (0.3.0)

`workspaceRoutes()` (mounted `server.ts:491` as `/api/workspace`) exposes a
**single read-only endpoint** at v0:

`POST /api/workspace/validate` — body `{ root, workspaceKind?, recursive?,
requireFrontmatter?, maxFiles? }`; returns a `FrontmatterValidationReport`.
`root` is required (400 `root_required`); an out-of-vocabulary
`workspaceKind` is rejected 400 `invalid_workspace_kind`; validator throws
→ 500 `validate_failed`. **No filesystem mutation.**

> Source: `routes/workspace.ts:23-65` (handler; root-required L35-37;
> kind-enum L39-47; 500 L59-62); mounted `server.ts:491` @HEAD.

`validateWorkspaceFrontmatter()` walks a root, parses each `.md` file's
YAML frontmatter (delimited `---` on the first line), and emits a structured
gap report — **advisory only, never modifies files**. Gap kinds:
`missing-required-field`, `unrecognized-status-value`, `parse-error`,
`missing-frontmatter`. Per-kind required fields: `user`/`project` →
`["doc"]`; `knowledge`/`lab`/`delivery` → `["doc","status","created","owner"]`.
Valid `status` enum: `active|draft|archived|superseded`. Default behavior
skips files without `---` silently (informal notes) unless
`requireFrontmatter`; recurses by default; skips `node_modules` / `.git` /
`.worktrees` / `dist` / `build`; hard cap `maxFiles` default 10000.

> Source: `domain/workspace/frontmatter-validator.ts:53` (status enum),
> `:56-62` (per-kind required), `:23-27` (gap kinds), `:90-122` (walk;
> skip-dirs L105-111), `:160-172` (missing-frontmatter behavior),
> `:201-226` (required + status check) @HEAD.

CLI surface: `rig workspace validate [root]` — v0 is intentionally narrow
(`validate` only); future versions add typed-kind authoring on the same
walker.

> Source: `docs/as-built/cli-reference.md:931-941` @HEAD.

## 3. Default workspace scaffold (0.3.0 spine; 0.3.1 narrative layer)

`workspaceScaffoldDirs()` / `workspaceScaffoldFiles()` produce the
mission-aware default workspace (`~/.openrig/workspace/` or `--root`). The
same scaffold is used **idempotently by daemon startup** so a fresh install
has a browsable Project workspace before the operator discovers
`rig config init-workspace`. Canonical subdirs: `missions/`, `artifacts/`,
`evidence/`, `progress/`, `field-notes/`, `specs/`, `dogfood-evidence/`,
plus per-mission `missions/<id>/slices/<slice-id>` folders. Drops
`README.md` + `STEERING.md` (placeholder) + per-mission `README.md` /
`PROGRESS.md` + per-slice `README.md` / `PROGRESS.md` /
`IMPLEMENTATION-PRD.md`.

> Source: `domain/workspace/default-workspace-scaffold.ts:44-59`
> (`workspaceScaffoldDirs`), `:247-283` (`workspaceScaffoldFiles`),
> `WORKSPACE_README` `:82-94`, `STEERING_PLACEHOLDER` `:96-120`;
> CLI `packages/cli/src/commands/config-init-workspace.ts:1-16`
> (idempotent; `--dry-run`/`--force`; never deletes operator
> content L12-16); cli-reference workspace note "See `rig config
> init-workspace`" `:939` @HEAD.

**0.3.1 narrative layer (slice 21 onboarding-conveyor).** The
`getting-started` mission's two slices ship rich teaching content from
`GETTING_STARTED_NARRATIVE` (the click-through-to-learn surface) including a
`timeline.md` the slice Story tab renders via slice-06's
`useSliceTimelineMarkdown` hook; other slices keep the boilerplate.

> Source: `domain/workspace/default-workspace-scaffold.ts:1-4`
> (slice-21 header), `:153-190` (narrative branch in `sliceReadme`),
> `:192-200` (`sliceTimeline`), `:270-279` (timeline emit); §0 proof:
> `getting-started-narrative.ts` ABSENT@v0.3.0 ⇒ **0.3.1** @HEAD.

## 4. File-backed missions / slices tree

### 4.1 SliceIndexer (Slice Story View v0) — 0.3.0

`SliceIndexer` reads slice folders from a configured filesystem root. The
**default workspace contract** is
`workspace/missions/<mission>/slices/<slice>`; explicitly configured flat
roots (`workspace/slices/<slice>`) remain supported for compatibility.
A nested `slices/` child folder makes the parent a mission
(`missionId = <mission-folder>`); a bare folder is a flat slice
(`missionId = null`). NO new SQLite migration, NO new event type: read-only
projection over existing tables (`queue_items`, `queue_transitions`,
`mission_control_actions`) + dogfood-evidence directories. Time-bounded
listing + detail caches (`invalidate()` drops both). `isReady()` is true
when any configured slice root exists on disk.

> Source: `domain/slices/slice-indexer.ts:1-14` (contract + no-new-state),
> `:174-176` (`isReady`), `:179-182` (`invalidate`), `:212-256`
> (`readSliceLocations`; nested-vs-flat L233-253), `:62-89`
> (`SliceListEntry` shape: `missionId` / `slicePath` / `qitemIds` /
> `proofPacket`) @HEAD.

### 4.2 SliceDetailProjector (Slice Story View v0 + v1) — 0.3.0

Given a `SliceRecord`, the projector assembles the full per-slice payload
across six tabs (Story, Acceptance, Decisions, Docs, Tests/Verification,
Topology). Read-only; composes already-shipped tables +
`workflow_specs`/`workflow_instances`/`workflow_step_trails` + slice docs on
disk + dogfood-evidence. **v1 removed the v0 hardcoded legacy phase enum**
(`discovery`/`product-lab`/`delivery`/…): `StoryEvent.phase` is now an
open-ended string-or-null — the spec-defined `step.id` when bound to a
`workflow_instance`, else `null` (UI groups under "Untagged"). When no
workflow runtime is constructed the projector silently degrades to v0
behavior (`workflowBinding=null`, `specGraph=null`).

> Source: `domain/slices/slice-detail-projector.ts:1-21` (six-tab
> contract + v1 enrichment), `:18-21` (v0 phase enum REMOVED at v1);
> startup degrade-path `startup.ts:1063-1076` (projector built with
> `workflowRuntime?.specCache`; comment L1064-1071) @HEAD.

### 4.3 Slices routes — 0.3.0

`slicesRoutes()` (mounted `server.ts:501` as `/api/slices`):
`GET /` (filter `all|active|done|blocked`, default `all`; `?refresh=1`
invalidates; optional `?boundToWorkflow=<name>:<version>` lens narrows to
slices bound to a workflow instance), `POST /refresh` (drops both indexer
caches — no daemon restart), `GET /:name/proof-asset/*` (path-traversal
guarded; immutable 1-day cache), `GET /:name/doc/*` (markdown for the Docs
tab; traversal guarded), `GET /:name` (full per-tab payload). 503
`slices_indexer_unavailable` when unwired; 503 `slices_root_not_configured`
+ setup hint when not ready. **Route-order discipline:** literal `/` /
`/refresh` / `/:name/proof-asset/*` / `/:name/doc/*` are registered BEFORE
the dynamic `/:name` so they are not shadowed.

> Source: `routes/slices.ts:31-177` (handlers; route-order L34-35,
> L101-102, L109-113, L166-167; 503s L38-44; `boundToWorkflow`
> L60-86); mounted `server.ts:501` @HEAD.

### 4.4 Missions route — **0.3.1** (slice 12 + slice 13 + slice 18)

`missionsRoutes()` (mounted `server.ts:505` as `/api/missions`) is the
mission scope data layer. `GET /:missionId` returns
`{ missionId, missionPath, slices, workflow_spec, topology, status }` —
slices filtered from the SliceIndexer by `missionId`; `missionPath` derived
by going up two levels from any slice's `slicePath`; `workflow_spec` parsed
lazily from `<missionPath>/README.md` frontmatter (same `parseWorkflowSpecRef`
helper the slice-indexer uses); `topology.specGraph` projected via
`projectSpecGraph(spec, null)` when the spec is cached, `{ specGraph: null }`
when declared-but-not-cached, `null` when nothing declared; `status` read
from README frontmatter. `POST /:missionId/complete` writes
`status: complete` to the mission README frontmatter (idempotent; preserves
unrelated fields) — the daemon is the audit-trail surface, the UI keeps an
optimistic localStorage mirror. 404 `mission_not_found` when no slices match.

> Source: `routes/missions.ts:39-118` (handlers), `:124-142`
> (`writeMissionStatusComplete`), `:148-150` (`computeMissionPath`
> up-two-levels), `:171-177` (`readMissionWorkflowSpec`), `:205-215`
> (`computeMissionTopology`); mounted `server.ts:505`; §0 proof:
> `routes/missions.ts` ABSENT@v0.3.0 ⇒ **0.3.1** @HEAD.

### 4.5 Projects route — Coordination L2 classifier (PL-004 Phase B) — 0.3.0

`projectsRoutes()` (mounted `server.ts:492` as `/api/projects`) backs the
`rig project` CLI verb — this is the **PL-004 Phase B project *classifier***
(lease lifecycle + idempotent classify + operator-verb reclaim + SSE), NOT
the Project *workspace UI* (that is the slices/missions surface above; the
naming overlap is a documented seam). Endpoints: `POST /lease/acquire`
(optional `evaluateDeadnessFirst` clears stale/dead leases first),
`POST /lease/heartbeat`, `POST /reclaim-classifier`, `POST /project`
(idempotent on `stream_item_id`), `GET /lease`, `GET /list`,
`GET /sse` + `GET /watch` (SSE), `GET /:projectId`. **Route-order
discipline:** literal `/lease`, `/list`, `/sse`, `/watch` are registered
BEFORE the bare `/:projectId` catchall (Phase A R1 SSE lesson).

> Source: `routes/projects.ts:18-194` (handlers; route-order note
> L15-17, L140-141, L158-159, L185); error-code → HTTP mapping
> `:31-52`; mounted `server.ts:492` @HEAD.

## 5. UI route-reality (§10.7 — source-verified at routes.tsx@HEAD)

`packages/ui/src/routes.tsx` is **542 lines** and uses TanStack Router
(`createRoute({ path, component })` objects), NOT JSX `<Route>`. The
Phase-8.1 survey's grep-derived missions/projects expectations are
corrected here against routes.tsx reality:

| Survey expectation | routes.tsx@HEAD reality | routes.tsx:NN |
|---|---|---|
| `/project` (workspace) | **REAL route** — `WorkspaceScopePage` | `:128-131` |
| `/project/mission/$missionId` | **REAL route** — `MissionScopePage` | `:134-137` |
| `/project/slice/$sliceId` | **REAL route** — `SliceScopePage` | `:140-143` |
| `/files` | **REAL route** — `FilesWorkspace` (see content-surfaces.md) | `:192-195` |
| `/mission-control` | **`<Navigate to="/for-you" />`** redirect-stub (DELETED per SC-18; the Mission Control *system* lives at daemon/PL-005, not a UI destination) | `:440-444` |
| `/slices` | **`<Navigate to="/project" />`** redirect-stub (DELETED per project-tree.md) | `:447-451` |
| `/slices/$name` | **`<Navigate to="/project/slice/$sliceId" />`** redirect-stub | `:453-460` |
| `/progress` | **`<Navigate to="/project" />`** redirect-stub (folds into Project tabs, Phase 3) | `:464-468` |
| `/steering` | **`<Navigate to="/project" />`** redirect-stub (folds into Project workspace overview tab, Phase 3) | `:470-474` |
| `/missions` (top-level) | **NO route** — missions are reached only via `/project/mission/$missionId` | (absent) |
| `/markdown` | **NO route** — markdown is a component in file/drawer surfaces, not a destination (see content-surfaces.md §4) | (absent) |

> Source: `packages/ui/src/routes.tsx:90-195` (real routes),
> `:435-474` (redirect-stub block; each `<Navigate>` + DELETED/folds
> comment), `:476-490` (route tree) @HEAD. Grep-confirmed absent:
> no `path: "/missions"` / `path: "/markdown"` declaration anywhere
> in routes.tsx @HEAD.

Net §10.7 ruling: the daemon `/api/missions` + `/api/slices` +
`/api/projects` routes are real and load-bearing; the **operator-facing UI**
consumes them through `/project*` destinations only. `/mission-control`,
`/slices`, `/progress`, `/steering` are redirect-stubs (the systems exist at
the daemon layer, the URLs were collapsed into `/project` / `/for-you`).

## 6. Cross-cutting properties

- **Optional + valid-without:** rigs without a `workspace` block stay valid;
  whoami / node-inventory / queue-target-repo all return null / fail-open
  (`workspace-resolver.ts:32`; `rig-repository.ts:99,107`;
  `routes/queue.ts:55`) @HEAD.
- **Defensive column probes:** every `workspace_json` / `target_repo` access
  guards on column presence so partial test fixtures don't crash
  (`rig-repository.ts:99,107`; migrations 038/039 ship separately so a
  fixture can apply only the half it needs — `038.ts:11-14`) @HEAD.
- **Read-only projection, no new state for the tree:** SliceIndexer /
  SliceDetailProjector add NO migration / event type; only the workspace
  declaration (038) + per-item scope (039) touch SQLite
  (`slice-indexer.ts:12-14`) @HEAD.
- **Advisory, never mutates:** the frontmatter validator and the
  init-workspace scaffold never delete operator content
  (`frontmatter-validator.ts:12-13`; `config-init-workspace.ts:12-16`) @HEAD.

## OPEN items (carried, not smoothed)

- **OPEN-A** — `resolveWorkspaceContext` honors an `envOverride`
  **verbatim even when it names no declared repo** (`workspace-resolver.ts:34-43`,
  by explicit PL-007 PRD § Item 3 design), whereas the queue route
  **rejects** an unknown `target_repo` against the same `repos[]`
  (`routes/queue.ts:58-66`). These two surfaces apply opposite policies to
  an unknown repo name (whoami trusts the operator; queue validates). Stated
  as-is — the asymmetry is source-real and intentional per the cited
  comments, but the divergence is not reconciled in source.
- **OPEN-B** — the `/api/projects` *classifier* (PL-004 Phase B) and the
  `/project*` *workspace UI* (slices/missions) share the word "project" but
  are unrelated subsystems. Documented as a naming seam; no source defect.
- No slice-00 numeric-drift OPEN (1–5) applies — this module carries no
  migration-count / route-group / PL-004-event-count claim (those land in
  daemon-core / coordination-primitive / architecture-rules).
