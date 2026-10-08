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
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Daemon Core — Wiring, DB, Migrations, Startup

OpenRig is a local control plane for multi-agent coding topologies. The daemon
(`@openrig/daemon`) is the framework-free SQLite-backed core that the CLI
(`@openrig/cli`), the terminal UI (`@openrig/tui`), the web UI (`@openrig/ui`)
and the MCP server all sit on top of.

> Verified against source at main `e8f0ab340db773392ec8be75b072d1c0f3068a50`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. System overview

For what OpenRig is and how its packages fit together, read `ARCHITECTURE.md` at
the repository root. This module covers the daemon's own wiring.

### Source footprint at `e8f0ab340db773392ec8be75b072d1c0f3068a50`

The footprint counts use non-test TypeScript files under each package's `src/`
(tests live in separate `packages/*/test/` directories):
`find <dir> -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' | wc -l`.

| Metric | Count | Directory or command |
|---|---|---|
| All packages | **1203** | `packages/*/src` |
| Daemon | **659** (**430** under `domain/`, **29** under `adapters/`) | `packages/daemon/src`, `…/src/domain`, `…/src/adapters` |
| CLI | **173** | `packages/cli/src` |
| Web UI | **304** | `packages/ui/src` |
| TUI | **67** | `packages/tui/src` |
| Database migrations | **96** (`001_core_schema.ts` … `097_thread_part_map.ts`; no `093`) | `git ls-files packages/daemon/src/db/migrations \| wc -l` |
| Files in `routes/` | **68**, of which **65** create a Hono router | `git ls-files packages/daemon/src/routes \| wc -l`; `git grep -l 'new Hono' -- packages/daemon/src/routes \| wc -l` |
| `app.route(...)` mounts in `server.ts` | **69** | `grep -c 'app.route(' packages/daemon/src/server.ts` |
| Top-level `rig` commands | **87** | `grep -c 'program.addCommand(' packages/cli/src/index.ts` |
| MCP tools | **18**, all named `rig_*` | `grep -c 'server.tool(' packages/cli/src/mcp-server.ts` |
| Runtime adapter classes | **5**: Claude Code, Codex, Pi, Stub, Terminal | `git grep -l 'implements RuntimeAdapter' packages/daemon/src \| wc -l` |

`OmpRuntimeAdapter` (Oh My Pi) extends `PiRuntimeAdapter`, so the daemon wires
six runtime keys — `claude-code`, `codex`, `pi`, `omp`, `stub`, `terminal`
(`startup.ts:989`).

### The stack

```text
CLI (87 top-level commands) / TUI / web UI / MCP (18 tools)
      |
      v
Hono daemon routes (69 app.route() mounts + direct handlers for /healthz,
                    spec export, unknown /api paths and the static UI)
      |
      +-- rigspec routes (pod-aware and legacy spec formats)
      +-- env routes (status / logs / down)
      +-- transport routes (send / capture / broadcast)
      +-- transcript routes (tail / grep)
      +-- ask routes (context evidence)
      +-- chat routes (durable rig messaging + SSE)
      +-- spec review / spec library routes
      +-- whoami identity route
      +-- coordination routes (stream / queue / workflow / mission control)
      |
      v
Framework-free domain services (430 files under packages/daemon/src/domain)
      |
      +-- SQLite state (96 migrations)
      +-- tmux / cmux / resume adapters
      +-- runtime adapters (Claude Code / Codex / Pi / Oh My Pi / Stub / Terminal)
      +-- rig environment services (compose adapter, service readiness, orchestrator)
      +-- transport / transcript / chat / ask layers
      +-- whoami identity service (including context usage)
```

The core product loop: `down (auto-snapshot) → up <rig-name> (auto-restore) →
handoff → inspect/attach → work → repeat`.

## 2. Database schema

The migrations live in `packages/daemon/src/db/migrations/` (96 files,
`001_core_schema.ts` … `097_thread_part_map.ts`, with no `093`).
`ALL_MIGRATIONS` (`packages/daemon/src/db/all-migrations.ts:107`) lists all 96, and `createDaemon`
applies them with `migrate(db, ALL_MIGRATIONS)` (`startup.ts:298`). `migrate.ts`
sorts them by name (`:29`) and records each applied name in `schema_migrations`
(`:15`).

### Core state tables

`rigs` (topology container, `001_core_schema.ts:7`), `nodes` (logical node
identity, `:17`) and `edges` (logical topology relationships, `:30`); then
`bindings` (physical tmux/cmux surface attachment) and `sessions` (live
execution state) in `002_bindings_sessions.ts`, `events` (append-only event log)
in `003_events.ts`, `snapshots` (serialized rig state) in `004_snapshots.ts`, and
`checkpoints` (per-node recovery state) in `005_checkpoints.ts`.

### Pod-aware schema

- `014_agentspec_reboot.ts` — the pod-aware schema; adds the `pods` and
  `continuity_state` tables and pod-aware columns on `nodes`, `sessions` and
  `checkpoints`.
- `015_startup_context.ts` — persisted startup replay context for restore.
- `016_chat_messages.ts` — durable rig-scoped chat (SQLite-backed; transcripts
  remain filesystem-backed, written by bounded periodic `capture-pane` snapshots;
  see `transport-and-transcripts.md`).
- `017_pod_namespace.ts` — first-class authored pod namespace for export/adoption.
- `018_context_usage.ts` — per-node context-usage snapshots.
- `019_external_cli_attachment.ts` — binding-row extension for external CLI attach.
- `020_rig_services.ts` — rig-scoped environment record for service-backed rigs.
- `021_seat_handover_observability.ts`, `022_node_codex_config_profile.ts`.

### Coordination, workflow, mission control and workspace migrations

- `023_stream_items.ts` … `027_outbox_entries.ts` — the coordination tables
  (stream, queue, queue transitions, inbox, outbox; detail in
  `coordination-primitive.md`).
- `028_project_classifications.ts`, `029_classifier_leases.ts`,
  `030_views_custom.ts` — classifier and view tables.
- `031_watchdog_jobs.ts`, `032_watchdog_history.ts` — watchdog tables.
- `033_workflow_specs.ts`, `034_workflow_instances.ts`,
  `035_workflow_step_trails.ts` — workflow runtime tables (detail in
  `workflow-runtime.md`). `036_watchdog_policy_enum_extension.ts` runs no DDL (its
  SQL is a no-op `SELECT 1 WHERE 0`); it documents an enum extension.
- `037_mission_control_actions.ts` — the mission control audit table
  (`037_mission_control_actions.ts:58`; detail in `mission-control.md`).
- `038_workspace_primitive.ts`, `039_queue_target_repo.ts` — the typed workspace
  primitive.
- `040_workflow_specs_diagnostic.ts` — `ALTER TABLE workflow_specs ADD COLUMN`
  for parser/validator diagnostics (no new table).

Migrations `041`–`092` and `094`–`097` continue in the same directory; list them with
`git ls-files packages/daemon/src/db/migrations`. `095_rig_non_interruptive.ts` adds
`rigs.non_interruptive` (0 or 1, default 0), the saved per-rig choice behind
`rig up --non-interruptive`; `096_rig_install_root.ts` adds `rigs.install_root`, the rig's
bundle materialization folder (`rig-repository.ts:169`). The newest, `097_thread_part_map.ts`,
adds `thread_part_map`, which maps each message OpenRig posts into an ask's Slack thread to
that ask and its seat.

The package, bootstrap and discovery tables remain: `packages`
(`008_packages.ts`), `package_installs` and `install_journal`
(`009_install_journal.ts`), `bootstrap_runs`, `bootstrap_actions` and
`runtime_verifications` (`011_bootstrap.ts`), and `discovered_sessions`
(`012_discovery.ts`).

## 3. Route-mount surface

`createApp(deps)` (`packages/daemon/src/server.ts:442`) mounts **69**
`app.route()` route groups (`server.ts:723`–`839`) plus direct handlers:
`GET /healthz` (`:664`), `GET /api/rigs/:rigId/spec` (`handleExportYaml`,
`:735`), `GET /api/rigs/:rigId/spec.json` (`handleExportJson`, `:736`), a JSON
`404 not_found` for any other `/api/*` path (`:844`), and the static/deep-link
`app.get("*")` catch-all (`:853`).

The 69 is the count of `app.route(` lines in `server.ts`; `packages/daemon/src/routes/`
has 68 files, 65 of which create a Hono router.

Mount families include the rig, session and spec routes plus the coordination
routes (`/api/stream` `server.ts:783`, `/api/queue` `:784`, `/api/workflow`
`:789`, `missionControlRoutes(...)` `:792`), `/api/seat` (`:781`, the seat
lifecycle verbs such as handover, launch, continue, stop and the typing guard),
`/api/startup` (`:747`), `/api/terminal` (`:809`), `/api/telemetry` (`:822`),
`/api/health-summary` (`:829`), `/api/rigs/:rigId/env` (`:835`) and
`/api/restore-check` (`:836`). List every mount with
`grep -n 'app.route(' packages/daemon/src/server.ts`.

Before the routes, `createApp` installs middleware in this order: the request-phase
observer (`:497`), JSON body-parse error tracking, which turns a malformed body into
`400 invalid_json` (`:499`), dependency injection, route timing, slow-operation
recording, the browser boundary on `/api/*` (`:647`, Host and Origin checks; see
`OPENRIG_ALLOWED_HOSTS` and `OPENRIG_ALLOWED_ORIGINS`), and host read-through.

`createAppWithWebSocket(deps)` (`server.ts:893`) sets `enableNodeWebSocket` and
calls `createApp`; the terminal WebSocket is registered only when the web UI is
also enabled (`server.ts:756`). Otherwise only its bearer-auth handler is
registered (`registerTerminalAuthOnly`, `:762`).

## 4. Startup sequence (`createDaemon`)

`createDaemon(opts?)` is `packages/daemon/src/startup.ts:287` (async, returns
`DaemonResult`). It returns `{ app, db, deps, contextMonitor, eventLoopMonitor,
injectWebSocket }` (`startup.ts:2506`). In source order, it:

1. Opens SQLite and applies all 96 migrations (`migrate(db, ALL_MIGRATIONS)`,
   `startup.ts:298`).
2. Constructs the coordination stores early: `StreamStore` (`:330`),
   `QueueRepository` (`:428`) and `OutboxHandler` (`:443`).
3. Constructs `TranscriptStore` (`:555`) and the rig environment services
   `ComposeServicesAdapter` and `ServiceOrchestrator` (`:644`–`645`).
4. Constructs `StartupOrchestrator` (`:776`) and the runtime adapters:
   `ClaudeCodeAdapter` (`:778`), `CodexRuntimeAdapter` (`:779`),
   `PiRuntimeAdapter` (`:782`), `OmpRuntimeAdapter` (`:783`) and
   `StubRuntimeAdapter` (`:788`); the terminal adapter is created inline in the
   runtime adapter maps (`:989`, `:1259`).
5. Constructs `PodRigInstantiator` (`:985`), `PodBundleSourceResolver` (`:1014`)
   and `BootstrapOrchestrator` (`:1016`).
6. Constructs `ContextUsageStore` (`:1095`), `ResumeMetadataRefresher`
   (`:1129`), `SpecReviewService` (`:1154`) and `WhoamiService` (`:1157`).
7. Builds `AppDeps` (`const deps: AppDeps`, `:1191`). `SessionTransport`
   (`:1262`), `ChatRepository` (`:1296`), `InboxHandler` (`:1300`), `AskService`
   (`:1349`) and `SpecLibraryService` (`:1387`) are constructed inside that
   object literal. `InboxHandler` receives the same queue repository instance
   (`queueRepoInstance`) that serves `/api/queue`, so absorbed inbox items and the
   queue route write to one store.
8. Constructs `ContextMonitor` (`:2407`), then assigns later fields onto `deps`
   (among them the terminal service, the request-phase observer and the gateway
   subsystem).
9. Calls `createAppWithWebSocket(deps)` (`startup.ts:2504`) to mount the full
   route tree.

Node inventory is a set of functions (`getNodeInventory` and friends in
`domain/node-inventory.ts`), imported where needed rather than constructed at
startup.

The daemon entrypoint `packages/daemon/src/index.ts:306` calls
`createDaemon({ dbPath, bearerToken, terminalBearerToken, … })`.

## 5. Test files

A static count of tracked test files at `e8f0ab340db773392ec8be75b072d1c0f3068a50` (no pass counts are claimed
here; CI runs the suites in `.github/workflows/tests.yml`): daemon **923**,
CLI **260**, web UI **198**, TUI **103**
(`git ls-files 'packages/<package>/**/*.test.ts' 'packages/<package>/**/*.test.tsx' | wc -l`).

## See also

- `ARCHITECTURE.md` (repository root) — what OpenRig is and where to add things.
- `coordination-primitive.md` — the stream/queue/inbox/outbox coordination layer.
- `agent-spec-and-startup.md` — spec parsing/resolution/startup contract.
- `lifecycle-snapshot-restore.md` — snapshot/restore/continuity.
- Source roots: `packages/daemon/src/{startup.ts,server.ts,index.ts}`,
  `packages/daemon/src/db/{all-migrations.ts,migrate.ts}`,
  `packages/daemon/src/db/migrations/`, `packages/cli/src/index.ts`.
