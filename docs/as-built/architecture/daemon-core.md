---
kind: as-built
title: Daemon Core — Wiring, DB, Migrations, Startup
status: active
topics: [runtime-control, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the daemon boots, how createDaemon wires the dependency
  graph, the SQLite schema/migration set, or the route-mount surface.
siblings: [coordination-primitive.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Daemon Core — Wiring, DB, Migrations, Startup

OpenRig is a local control plane for multi-agent coding topologies. The daemon
(`@openrig/daemon`) is the framework-free SQLite-backed core that the CLI
(`@openrig/cli`), UI (`@openrig/ui`), and MCP server all sit on top of.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). Current package version is **0.3.1** across all three
> packages (`package.json` root `"version": "0.3.1"`; slice-00 §1.1). HEAD
> carries 6 commits of unreleased release-0.3.2 work; no `v0.3.2` tag exists.

## 1. System overview

The system has six architectural layers (`architecture.md` §1 L23–30):

1. **AgentSpec / pod-aware core** — spec parsing, resolution, precedence,
   startup orchestration, snapshot/restore, bundles.
2. **Operator and topology layer** — harness auto-launch, node inventory,
   session naming, infrastructure nodes, explorer UI, existing-rig power-on,
   auto-snapshot, post-command handoff.
3. **Communication and history layer** — transcript capture (pipe-pane),
   communication primitives (send/capture/broadcast), config/preflight,
   `rig ask` context packs, durable rig chat.
4. **Authoring and identity layer** — spec review + spec library, `whoami`,
   adopted-session tmux-metadata parity, bind/materialize/adopt workflows.
5. **Rig environment layer** — rig-scoped services records, Compose-backed
   service orchestration, readiness gates, env snapshot/restore integration.
6. **Agent-managed software layer** — managed-app classification, app-focused
   browse/review/runtime UI, and the canonical `secrets-manager` example.

Legacy flat-node/package flows remain for backward compatibility.

### Verified source footprint at HEAD `7eaf524c`

> Drift-fix D1/D6 — `architecture.md` L6,11 said `OpenRig v0.2.0` /
> "Current v0.2.0 release verification" and L7 said `376` source files. Both
> are a frozen pre-v0.2.0-era header (slice-00 §1.9 — last edited `72982bb2`,
> 2026-03-30). Corrected to the values below.

| Metric | Value @ HEAD | Source (independently re-confirmed) |
|---|---|---|
| Package version | **0.3.1** (HEAD +6 unreleased 0.3.2 commits) | slice-00 §1.1; `package.json:version` |
| Total source footprint | **601** files | slice-00 §1.6; `find packages/*/src` non-test = 279+87+235 |
| Daemon footprint | **279** total / **173** domain / **49** route mounts (46 route files) / **11** adapters / **40** migrations | slice-00 §1.5/§1.6; `find packages/daemon/src` non-test |
| CLI footprint | **87** files | slice-00 §1.6; `find packages/cli/src` non-test |
| UI footprint | **235** files | slice-00 §1.6; `find packages/ui/src` `.ts`+`.tsx` non-test |

> Footprint counts use the `find packages/*/src -type f \( -name '*.ts' -o
> -name '*.tsx' \) ! -name '*.test.*'` predicate (tests live in separate
> `packages/*/test/` dirs). Counts are reproducible with that predicate; a
> different counting convention shifts absolute numbers (slice-00 OPEN-5).

### The stack

> Drift-fix D2 — `architecture.md` L37,125 said `CLI (53 command groups)`.
> Corrected to **58** at HEAD (slice-00 §1.2: 53 at v0.2.0 tag, 56 at v0.3.0,
> 57 at v0.3.1, **58 at HEAD** — the 58th is `scopeCommand()` added post-0.3.1
> by `0b77cba4`, re-confirmed `index.ts:20,187`).
>
> Drift-fix D4 — `architecture.md` L40 said `31 route groups` and L76 said
> "`createApp()` now mounts 22 route groups". Corrected to **49 `app.route()`
> mounts + 4 dedicated handlers** (slice-00 §1.5; re-confirmed `server.ts`
> 49×`app.route(` L450–513, plus `app.get("/healthz")` :446,
> `handleExportYaml` :461, `handleExportJson` :462, `app.get("*")` :519).
> Carry slice-00 **OPEN-2**: "route-group count is definitional" — there is
> no single canonical "route group" definition in source; reported as mount
> count + dedicated handlers.
>
> Drift-fix D3 — `architecture.md` L54 said `SQLite state (36 migrations)`.
> Corrected to **40** (slice-00 §1.3; re-confirmed below).

```text
CLI (58 command groups) / UI (explorer + workspace + drawer) / MCP (17 tools)
      |
      v
Hono daemon routes (49 app.route() mounts + 4 dedicated health/export/static handlers)
      |
      +-- dual-format route adapters (legacy v1 + rebooted v0.2)
      +-- env routes (status / logs / down)
      +-- transport routes (send/capture/broadcast)
      +-- transcript routes (tail/grep)
      +-- ask routes (context evidence packs)
      +-- chat routes (durable rig messaging + SSE)
      +-- spec review/library routes (managed-app enrichment + compose preview)
      +-- whoami identity + context-usage route
      +-- coordination routes (stream / queue / workflow / mission-control)
      |
      v
Framework-free domain services (173 daemon domain files)
      |
      +-- SQLite state (40 migrations)
      +-- tmux / cmux / resume adapters
      +-- runtime adapters (Claude Code / Codex / Terminal)
      +-- RigEnv substrate (compose adapter, readiness, orchestrator)
      +-- transport / transcript / chat / ask layers
      +-- whoami identity service
```

The core product loop: `down (auto-snapshot) → up <rig-name> (auto-restore) →
handoff → inspect/attach → work → repeat`.

> MCP tool count is **17** (`rig_*`) — slice-00 §1.4 confirms the count is
> correct and the names are `rig_*` (NOT `rigged_*`; the `rigged_*` text in
> `architecture.md` §2 is stale — the rename predates v0.2.0). Per-occurrence
> verification of any `rigged_*` reference lands in `transport-and-transcripts.md`
> (D5); the tmux `@rigged_*` metadata keys are a separate axis, not blanket-replaced.

## 2. Database schema

> Drift-fix D3 — `architecture.md` L243 said "27 migrations (22 existing plus
> 5 added by PL-004 Phase A)" and L1002 repeated "27 migrations"; the §1 stack
> diagram L54 said "36 migrations". All corrected to **40** migrations
> (`001`–`040`). Triangulated (slice-00 §1.3, re-confirmed at HEAD): (1)
> filesystem `packages/daemon/src/db/migrations/[0-9][0-9][0-9]_*.ts` → 40
> files, `001_core_schema.ts` … `040_workflow_specs_diagnostic.ts`; (2)
> `startup.ts:206` `migrate(db, [...])` passes a 40-element schema array
> (`coreSchema` … `workflowSpecsDiagnosticSchema`); (3) `migrate.ts:13`
> applies them sorted by name, tracked in `schema_migrations`.

### Core state tables (`001_core_schema.ts`)

`rigs` (topology container, `001_core_schema.ts:7`), `nodes` (logical node
identity, `:17`), `edges` (logical topology relationships, `:30`), plus
`bindings` (physical tmux/cmux surface attachment), `sessions` (live execution
state), `events` (append-only event log), `snapshots` (serialized rig state),
`checkpoints` (per-node recovery state). `architecture.md` §3 L247–289.

### Reboot-era schema

- `014_agentspec_reboot.ts` — reboot schema shape; adds `pods`,
  `continuity_state`, and reboot columns on `nodes`/`sessions`/`checkpoints`
  (`pod_id`, `agent_ref`, `resolved_spec_*`, `startup_status`,
  `continuity_source`). `architecture.md` §3 L253–289.
- `015_startup_context.ts` — persisted startup replay context for restore.
- `016_chat_messages.ts` — durable rig-scoped chat (SQLite-backed; transcripts
  remain filesystem-backed via pipe-pane).
- `017_pod_namespace.ts` — first-class authored pod namespace for export/adoption.
- `018_context_usage.ts` — per-node context-usage snapshots.
- `019_external_cli_attachment.ts` — binding-row extension for external CLI attach.
- `020_rig_services.ts` — rig-scoped environment record for service-backed rigs.
- `021_seat_handover_observability.ts`, `022_node_codex_config_profile.ts`.

### Coordination / PL-004 / PL-005 / workspace migrations

- `023_stream_items.ts` … `027_outbox_entries.ts` — PL-004 Phase A
  coordination tables (detail in `coordination-primitive.md`).
- `028_project_classifications.ts`, `029_classifier_leases.ts`,
  `030_views_custom.ts` — PL-004 Phase B classifier + view tables. (Note:
  `architecture.md` L361 said "028 through 030"; the middle migration is
  literally `029_classifier_leases.ts` — re-confirmed at HEAD.)
- `031_watchdog_jobs.ts`, `032_watchdog_history.ts` — PL-004 Phase C watchdog.
- `033_workflow_specs.ts`, `034_workflow_instances.ts`,
  `035_workflow_step_trails.ts` — PL-004 Phase D Workflow Runtime tables
  (detail in `workflow-runtime.md`). `036_watchdog_policy_enum_extension.ts`
  is a documenting no-op.
- `037_mission_control_actions.ts` — PL-005 Phase A audit table
  (`037_mission_control_actions.ts:54` `CREATE TABLE … mission_control_actions`;
  detail in `mission-control.md`).
- `038_workspace_primitive.ts`, `039_queue_target_repo.ts` — PL-007 typed
  workspace primitive (`bab24bf7`).
- `040_workflow_specs_diagnostic.ts` — slice-11 (`f68f453a`); an
  `ALTER TABLE ADD COLUMN` adding parser/validator diagnostic columns to
  `workflow_specs` (no new table). **Net-new since `architecture.md` was last
  edited** — slice-00 §1.3 provenance; carried into `workflow-runtime.md`.

Legacy package/bootstrap/discovery tables (`packages`, `package_installs`,
`install_journal`, `bootstrap_runs`, `bootstrap_actions`,
`runtime_verifications`, `discovered_sessions`) remain active.

## 3. Route-mount surface

`createApp(deps)` (`packages/daemon/src/server.ts:295`) mounts **49**
`app.route()` route-group mounts (`server.ts` L450–513) plus 4 dedicated
non-route handlers: `GET /healthz` (`:446`), `GET /api/rigs/:rigId/spec`
(`handleExportYaml`, `:461`), `GET /api/rigs/:rigId/spec.json`
(`handleExportJson`, `:462`), and the static/deep-link `app.get("*")`
catch-all (`:519`).

> OPEN-2 (carried verbatim, slice-00): the route-group "count" is definitional
> — "49" is the count of `app.route()` mounts in `server.ts`. The older
> "31 route groups" / "createApp now mounts 22 route groups" framing
> (`architecture.md` L40,76) used a different, smaller accounting. Independent
> corroboration: `packages/daemon/src/routes/` has 46 non-test route `.ts`
> files (some groups composed from shared modules; the 49 mounts are the
> authoritative count of mounted groups — slice-00 §1.5).

Mount families include reboot-era rig/session/spec routes plus the coordination
routes (`/api/stream` `server.ts:489`, `/api/queue` `:490`,
`/api/workflow` `:495`, `missionControlRoutes(...)` `:498`),
`/api/health-summary` (`:511`), `/api/rigs/:rigId/env` (`:512`), and
`/api/restore-check` (`:513`).

## 4. Startup sequence (`createDaemon`)

`createDaemon(opts?)` is `packages/daemon/src/startup.ts:203` (async,
returns `DaemonResult`). It returns `{ app, db, deps, contextMonitor }`
(`startup.ts:1204`). The sequence (`architecture.md` §9 L1000–1028,
corrected against source):

1. Open SQLite and run **all 40 migrations** (`startup.ts:206`
   `migrate(db, [coreSchema … workflowSpecsDiagnosticSchema])` — a 40-element
   array; `architecture.md` L1002 said "27 migrations (22 existing plus the 5
   PL-004 Phase A coordination tables)" — corrected to 40, drift-fix D3).
2. Construct core repositories and legacy services.
3. Construct package/bootstrap/discovery services.
4. Construct rebooted startup/runtime services: `StartupOrchestrator`,
   `ClaudeCodeAdapter`, `CodexRuntimeAdapter`, `TerminalAdapter`,
   `PodRigInstantiator`, `PodBundleSourceResolver`.
5. Construct rig environment services: `ComposeServicesAdapter`,
   `ServiceOrchestrator`.
6. Construct operator/transport/history services: `TranscriptStore`,
   `SessionTransport`, `ChatRepository`, `AskService` (with `HistoryQuery`),
   `ResumeMetadataRefresher`, `ContextUsageStore`, `ContextMonitor`,
   `NodeInventory`.
7. Construct authoring/identity/managed-app services: `SpecReviewService`,
   `SpecLibraryService`, `WhoamiService`.
8. Construct `BootstrapOrchestrator` with both legacy and rebooted seams.
9. Construct PL-004 Phase A coordination services from a shared
   `QueueRepository` instance (so `InboxHandler.absorb()` and `/api/queue`
   write to the same repo): `StreamStore`, `QueueRepository`, `InboxHandler`,
   `OutboxHandler`.
10. Build `AppDeps`, enforce shared-DB invariants, and call
    `createApp(deps)` (`startup.ts:1202`) to mount the full route tree.

The daemon entrypoint `packages/daemon/src/index.ts:36` calls
`createDaemon({ dbPath, bearerToken })`.

## 5. Test and verification state

> Drift-fix D7 / OPEN-3 (carried verbatim, slice-00): `architecture.md` L12,13
> and §10 L1036–1046 assert daemon `2561/2561` / CLI `794/794` / total
> `2422/2422` test pass counts and per-package file counts (`127`/`37`/`37`).
> **These are runtime claims and are NOT re-run here** — a read-only static
> trace counted `*.test.ts` files only: daemon **255**, cli **234**
> (slice-00 §1.7; ui test-file count not separately gathered). Pass tallies
> are marked `unverified-runtime-claim`; do not assert them as current. To
> assert pass counts, run `pnpm/npm test` and re-verify.

## See also

- `coordination-primitive.md` — PL-004 Phase A stream/queue/inbox/outbox.
- `agent-spec-and-startup.md` — spec parsing/resolution/startup contract.
- `lifecycle-snapshot-restore.md` — snapshot/restore/continuity.
- Source roots: `packages/daemon/src/{startup.ts,server.ts,index.ts}`,
  `packages/daemon/src/db/migrations/`, `packages/cli/src/index.ts`.
