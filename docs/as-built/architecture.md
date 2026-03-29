# Rigged — As-Built Architecture
## Complete System Reference (as of 2026-03-27)

Status: 1329 tests (954 daemon + 150 CLI + 225 UI), 91 daemon source files, 21 CLI source files, 53 UI source files
Packages: `@rigged/daemon` + `@rigged/cli` + `@rigged/ui`

---

## 1. System Overview

Rigged is a local control plane for multi-agent coding topologies — a daemon, CLI, MCP server, and tactical React UI for managing, visualizing, snapshotting, restoring, importing, bootstrapping, discovering, and bundling multi-harness agent systems.

```
┌──────────────────────────────────────────────────────┐
│              Tactical React UI                        │
│  (Vite + TanStack Router/Query + shadcn/ui)          │
│  packages/ui — 53 source files                        │
│  18 app components + 11 shadcn primitives             │
│  13 hooks + 7 lib utilities                           │
│  10 routes: /, /rigs/$rigId, /import, /packages,     │
│  /packages/install, /packages/$packageId, /bootstrap, │
│  /discovery, /bundles/inspect, /bundles/install       │
└──────────────┬───────────────────────────────────────┘
               │ HTTP + SSE
┌──────────────┤                                        │
│  MCP Server  │ (stdio transport, 10 tools)            │
│  @modelcontextprotocol/sdk                            │
└──────────────┤                                        │
               ▼
┌──────────────────────────────────────────────────────┐
│              Hono Daemon                              │
│  packages/daemon — 91 source files                    │
│  52 domain, 7 adapters, 13 route files, 13 migrations │
│  24 AppDeps, 15 db-handle checks                     │
└──────────┬──────────┬──────────┬─────────────────────┘
           │          │          │
     ┌─────▼───┐ ┌────▼────┐ ┌──▼──────────┐
     │ SQLite  │ │  tmux   │ │    cmux      │
     │ (state) │ │  (CLI)  │ │ (CLI/socket) │
     └─────────┘ └─────────┘ └─────────────┘
               ▲
┌──────────────┘───────────────────────────────────────┐
│              CLI (rigged)                             │
│  packages/cli — 21 source files                       │
│  17 command modules + MCP server + HTTP client        │
│  Hero commands: rigged up / rigged down / rigged ps  │
└──────────────────────────────────────────────────────┘
```

---

## 2. Database Schema

13 migrations, applied in order. SQLite with WAL mode and foreign keys enabled.

### Tables

**rigs** — Top-level topology container
- `id` TEXT PK, `name` TEXT, `created_at`, `updated_at`

**nodes** — Logical identity within a rig
- `id` TEXT PK (opaque ULID), `rig_id` FK → rigs (CASCADE), `logical_id` TEXT
- `role`, `runtime`, `model`, `cwd`, `surface_hint`, `workspace`, `restore_policy` (nullable TEXT)
- `package_refs` TEXT (JSON array), UNIQUE(rig_id, logical_id)

**edges** — Relationships between nodes
- `id` TEXT PK, `rig_id` FK → rigs, `source_id`/`target_id` FK → nodes, `kind` TEXT
- Same-rig trigger enforced via BEFORE INSERT

**bindings** — Physical surface attachment
- `id` TEXT PK, `node_id` FK → nodes (UNIQUE, CASCADE)
- `tmux_session`, `tmux_window`, `tmux_pane`, `cmux_workspace`, `cmux_surface`

**sessions** — Live harness state
- `id` TEXT PK, `node_id` FK → nodes (CASCADE), `session_name`, `status` TEXT
- `resume_type`, `resume_token`, `restore_policy`, `origin` TEXT (launched/claimed)

**events** — Append-only log (no FKs — survives deletion)
- `seq` INTEGER PK AUTOINCREMENT, `rig_id`, `node_id`, `type`, `payload` JSON, `created_at`

**snapshots** — Point-in-time captures (no FK — survives deletion)
- `id` TEXT PK, `rig_id`, `kind`, `status`, `data` JSON, `created_at`

**checkpoints** — Per-agent recovery (CASCADE with nodes)
- `id` TEXT PK, `node_id` FK, `summary`, `current_task`, `next_step`, `blocked_on`, `key_artifacts` JSON, `confidence`

**packages** — Registered package manifests
- `id` TEXT PK, `name`, `version`, `source_kind`, `source_ref`, `manifest_hash` SHA-256, `summary`
- UNIQUE(name, version)

**package_installs** — Install transaction records
- `id` TEXT PK, `package_id` FK, `target_root`, `scope`, `status`, `risk_tier`, `bootstrap_id` FK (nullable)

**install_journal** — Per-file audit trail
- `id` TEXT PK, `install_id` FK, `seq` INTEGER, `action`, `export_type`, `classification`
- `target_path`, `backup_path`, `before_hash`, `after_hash` SHA-256, `status`

**bootstrap_runs** — Bootstrap execution records
- `id` TEXT PK, `source_kind`, `source_ref`, `status`, `rig_id`, `created_at`, `applied_at`

**bootstrap_actions** — Per-stage action journal
- `id` TEXT PK, `bootstrap_id` FK, `seq`, `action_kind`, `subject_type`, `subject_name`, `provider`, `command_preview`, `status`, `detail_json`

**runtime_verifications** — Runtime check results
- `id` TEXT PK, `runtime`, `version`, `capabilities_json`, `verified_at`, `status`, `error`

**discovered_sessions** — Organic session observations
- `id` TEXT PK, `tmux_session`, `tmux_window`, `tmux_pane`, `pid`, `cwd`, `active_command`
- `runtime_hint`, `confidence`, `evidence_json`, `config_json`, `status` (active/vanished/claimed)
- `claimed_node_id` FK, UNIQUE(tmux_session, tmux_pane)

---

## 3. Domain Layer (52 services)

All in `packages/daemon/src/domain/`. Zero Hono imports. Framework-agnostic.

### Core Infrastructure

**types.ts** — All entity interfaces + RigEvent discriminated union (27 event types) + RigSpec types + Package types + Bootstrap types
**errors.ts** — `RigNotFoundError extends Error` for type-safe 404 detection
**event-bus.ts** — Pub/sub with SQLite persistence. `emit()` (standalone) and `persistWithinTransaction()` + `notifySubscribers()` (transactional). `replaySince(seq, rigId)` for rig-scoped SSE. `replayAll(seq)` for global SSE.

### Rig Management (Phase 1)

**rig-repository.ts** — CRUD for rigs/nodes/edges. `getRig()` returns `RigWithRelations` with bindings per node.
**session-registry.ts** — Session lifecycle: registerSession, updateStatus, markDetached, markSuperseded, clearBinding, getSessionsForRig, updateBinding (upsert), getBindingForNode, registerClaimedSession (origin='claimed').
**node-launcher.ts** — Atomic launch: tmux session → session+binding+event in one transaction. Compensating tmux cleanup on DB failure.
**reconciler.ts** — Startup reconciliation: marks missing tmux sessions as `detached`.
**session-name.ts** — Derives + validates tmux session names from rig name + logical_id.
**graph-projection.ts** — Pure function: `RigWithRelations` + sessions → React Flow nodes/edges.

### Snapshot + Restore (Phase 2)

**snapshot-repository.ts** — CRUD for snapshots: createSnapshot, getSnapshot, getLatestSnapshot, listSnapshots (DESC, filterable by kind, optional limit), pruneSnapshots.
**checkpoint-store.ts** — Per-agent recovery: createCheckpoint, getLatestCheckpoint (by node_id, most recent), getCheckpointsForNode, getCheckpointsForRig (returns `Record<nodeId, Checkpoint|null>`).
**snapshot-capture.ts** — Gathers rig state → SnapshotData JSON. Atomic: snapshot+event in one transaction.
**restore-orchestrator.ts** — Compensating restore with per-rig concurrency lock. Topological launch order (`delegates_to`, `spawned_by`). File-based checkpoint delivery. Shell-quoted resume tokens. C-c cleanup on partial failure.

### RigSpec Import/Export (Phase 3)

**rigspec-codec.ts** — Pure YAML parse/serialize with camelCase↔snake_case mapping.
**rigspec-schema.ts** — Validation + normalization: schema_version, required fields, known runtimes/edge kinds/restore policies, duplicate detection, defaults.
**rigspec-exporter.ts** — Live rig → portable spec. Logical IDs only (no DB PKs). Excludes all live state.
**rigspec-preflight.ts** — Pre-instantiation checks: session name validity, name collision, tmux collision, cwd directory existence, runtime availability, cmux layout hints.
**rigspec-instantiator.ts** — Spec → live rig: validate, preflight, cycle detection, atomic DB materialization, topological launch, restorePolicy propagation, rig.imported event.

### AgentPackage Install (Phase 4)

**package-manifest.ts** — 501-line manifest parser/validator/serializer. Path traversal rejection on sources. Semver validation. Role cross-references.
**package-resolver.ts** — Local path resolution with SHA-256 manifest hash.
**package-resolve-helper.ts** — Shared resolve function for routes and orchestrator.
**package-repository.ts** — Package DB CRUD + `listPackageSummaries()` with install count JOIN.
**role-resolver.ts** — Role-filtered export resolution. Hooks/MCP deferred. Context ignored.
**install-planner.ts** — Classified install plan: safe_projection, managed_merge, config_mutation, external_install, manual_only. Runtime-specific paths.
**conflict-detector.ts** — Content-aware: SHA-256 hash comparison → no-op (same), conflict (different), guidance managed block detection.
**install-policy.ts** — Approval gate with dedup. safe_projection auto-approved, managed_merge requires flag.
**install-engine.ts** — Journaled apply with backup + rollback. Managed-block merge (new/append/in-place). Compensating rollback on mid-apply failure.
**install-repository.ts** — Install + journal DB CRUD with sequential ordering.
**install-verifier.ts** — Post-apply verification: target exists, content hash matches, backup integrity, managed block markers.
**package-install-service.ts** — Reusable pipeline: plan → detect → policy → dedup → apply → verify. Used by BootstrapOrchestrator. (The package HTTP routes run the same pipeline inline, not via this service.)

### Bootstrap (Phase 5)

**bootstrap-types.ts** — Status/action/runtime types for the bootstrap subsystem.
**bootstrap-repository.ts** — Bootstrap run + action journal DB CRUD.
**requirements-probe.ts** — Provider-backed probes: `command -v` for CLI tools, `brew list --versions` for system packages. Shell-quoted names. Timeout protection. installHints display-only.
**runtime-verifier.ts** — Verifies tmux (version parse), cmux (capabilities JSON), claude/codex (--version with --help fallback). Upserts to DB.
**external-install-planner.ts** — Maps missing requirements to trusted provider actions. Homebrew-only on darwin. auto_approvable/review_required/manual_only classification.
**external-install-executor.ts** — Executes approved actions via injected ExecFn. Journals everything. Partial failure continues. manual_only defense-in-depth skip.
**bootstrap-orchestrator.ts** — 8-stage pipeline: resolve spec → resolve packages → verify runtimes → probe requirements → build install plan → execute external installs → install packages → import rig. Plan mode (stages 1-5, no external installs or rig instantiation — but does create a bootstrap_runs row, persist runtime_verifications, and emit bootstrap.planned event). Apply mode (all stages). Concurrency lock via `tryAcquire`/`release`. Bundle source integration. Temp dir cleanup in finally block.

### Discovery (Discovery Sprint)

**discovery-types.ts** — RuntimeHint, Confidence, DiscoveryStatus, SessionOrigin types.
**tmux-discovery-scanner.ts** — Enumerates all tmux sessions/windows/panes with PID, cwd, active command via TmuxAdapter.
**session-fingerprinter.ts** — 4-layer pipeline: cmux agent PID (highest) → process tree (high) → pane content heuristics (medium) → cwd/config context (low). Cached cmux signals for batch use.
**session-enricher.ts** — Config sniffing from cwd: .claude/, .agents/, CLAUDE.md, AGENTS.md, package.yaml. Pure filesystem reads.
**discovery-repository.ts** — Upsert semantics preserving id + first_seen_at. markVanished, markClaimed, listDiscovered, getByTmuxIdentity.
**discovery-coordinator.ts** — Full pipeline: scan → filter managed (two-level: session + pane) → filter claimed → fingerprint → enrich → persist → vanish detection → events.
**claim-service.ts** — Atomic claim: node + binding + session(origin=claimed) + discovery.markClaimed + event in one transaction. Rollback test verified.

### RigBundle (Phase 7)

**bundle-types.ts** — BundleManifest, BundlePackageEntry, BundleIntegrity types. `isRelativeSafePath()` rejects .., ., backslashes, absolute, empty. `validateBundleManifest()` with path safety on all entries.
**bundle-assembler.ts** — Staging directory assembly: copy spec, vendor packages, dedup by name+hash, generate bundle.yaml.
**bundle-integrity.ts** — SHA-256 per-file hashing. Sensitive file blocking (.env, .key, .pem, credentials, .git/, node_modules/). Write integrity section into bundle.yaml. Verify: mismatches, missing, extra files.
**bundle-archive.ts** — Deterministic tar.gz pack (portable mode, fixed mtime, sorted files, .rigbundle extension enforced). Unpack with pre-scan (symlink/hardlink/traversal rejection BEFORE extraction) + archive digest verification + content integrity verification.
**bundle-source-resolver.ts** — Extracts bundle → verifies → maps vendored packages by original refs + vendored paths. Resolved path containment check (`startsWith(tempDir)`). Temp dir cleanup.

### Cross-Cutting CLI (Latest Sprint)

**up-command-router.ts** — Source routing: .yaml/.yml → validate as RigSpec, .rigbundle → bundle, extensionless → gzip magic detection or YAML parse. Helpful errors for mis-targeted files (bundle.yaml, package.yaml).
**ps-projection.ts** — Single SQL query: per-rig node count, running count, status (running/partial/stopped), uptime, latest snapshot. `ORDER BY created_at DESC, id DESC` tiebreaker.
**rig-teardown.ts** — Graceful shutdown: kill tmux sessions → per-node atomic cleanup (status+binding in transaction) → optional snapshot before → optional delete (blocked by kill failures, atomic with event). "Already gone" treated as success.

---

## 4. Adapter Layer (7 files)

**tmux.ts** — Read (listSessions/Windows/Panes, hasSession, getPanePid, getPaneCommand, capturePaneContent) + Write (createSession, killSession, sendKeys, sendText). All shell-quoted.
**tmux-exec.ts** — Production ExecFn via child_process.exec.
**cmux.ts** — CLI-based with capability detection. listWorkspaces, listSurfaces, focusSurface, sendText, queryAgentPIDs. Graceful degradation.
**cmux-transport.ts** — Factory producing CmuxTransport from ExecFn.
**claude-resume.ts** — Shell-quoted resume command + C-c cleanup on partial failure.
**codex-resume.ts** — codex_id + codex_last resume types. Same safety patterns.
**shell-quote.ts** — Shared POSIX single-quote utility.

---

## 5. HTTP API (13 route files, 45+ endpoints)

### Rig CRUD (`/api/rigs`)
- `GET /api/rigs/summary` — rig list with node counts + latest snapshot (registered BEFORE /:id)
- `POST /api/rigs` → 201
- `GET /api/rigs` → list
- `GET /api/rigs/:rigId` → full relations
- `DELETE /api/rigs/:rigId` → 204 (atomic event+delete if exists; idempotent 204 with no event if missing)
- `GET /api/rigs/:rigId/graph` → React Flow projection

### Sessions (`/api/rigs/:rigId/sessions`, `/api/rigs/:rigId/nodes`)
- `GET .../sessions` → session list
- `POST .../nodes/:logicalId/launch` → 201 (tmux+DB atomic)
- `POST .../nodes/:logicalId/focus` → cmux focus

### Snapshots + Restore
- `POST /api/rigs/:rigId/snapshots` → 201 (404 for missing rig via typed error)
- `GET /api/rigs/:rigId/snapshots` → list DESC
- `GET /api/rigs/:rigId/snapshots/:id` → detail (cross-rig guard)
- `POST /api/rigs/:rigId/restore/:snapshotId` → 200/404/409/500

### RigSpec Import/Export
- `GET /api/rigs/:rigId/spec` → YAML (text/yaml)
- `GET /api/rigs/:rigId/spec.json` → JSON
- `POST /api/rigs/import` → 201/400/409/500
- `POST /api/rigs/import/validate` → 200
- `POST /api/rigs/import/preflight` → 200

### Packages (`/api/packages`)
- `POST /validate` → 200/400
- `POST /plan` → 200 (classified entries with policy annotations)
- `POST /install` → 201/400/409/422/500
- `POST /:installId/rollback` → 200/404/409 (not in applied state)/500
- `GET /summary` → list with install count + latest status
- `GET /` → raw list
- `GET /installs/:installId/journal` → audit trail
- `GET /:packageId` → detail
- `GET /:packageId/installs` → install history

### Bootstrap (`/api/bootstrap`)
- `POST /plan` → 200 (planned) / 400 (invalid input) / 409 (concurrency lock or blocked stage) / 500 (internal error). Plan mode persists a bootstrap_runs row + runtime_verifications but performs no external installs or rig instantiation.
- `POST /apply` → 201 (completed) / 200 (partial) / 409 (blocked) / 500 (failed)
- `GET /:id` → run detail with actions
- `GET /` → run list

### Discovery (`/api/discovery`)
- `POST /scan` → 200 (one-shot scan, returns discovered sessions)
- `GET /` → list (filterable by status: active/vanished/claimed)
- `GET /:id` → detail with evidence + config
- `POST /:id/claim` → 201/400/404/409/500

### Bundles (`/api/bundles`)
- `POST /create` → 201 (assemble + integrity + pack)
- `POST /inspect` → 200 (extract + verify, structured result)
- `POST /install` → reuses full bootstrap lifecycle (plan/apply modes)

### Hero Commands
- `POST /api/up` → source routing + bootstrap pipeline (plan/apply)
- `POST /api/down` → teardown with optional delete/snapshot
- `GET /api/ps` → rig status projection

### Infrastructure
- `GET /healthz` → `{ status: "ok" }`
- `GET /api/events[?rigId=]` → SSE stream (optional rigId for rig-scoped, omit for global)
- `GET /api/adapters/tmux/sessions` → raw tmux list
- `GET /api/adapters/cmux/status` → cmux availability

---

## 6. CLI (17 command modules)

All in `packages/cli/src/commands/`. Commander-based with DI for testability.

### Hero Commands
| Command | Description | Exit codes |
|---|---|---|
| `rigged up <source> [--plan] [--yes] [--target] [--json]` | Bootstrap from spec or bundle. Auto-starts daemon. | 0/1/2 |
| `rigged down <rigId> [--delete] [--force] [--snapshot] [--json]` | Teardown rig. Kills sessions, clears bindings. | 0/1/2 |
| `rigged ps [--json]` | List rigs with status/uptime/snapshot. | 0/1/2 |

### Daemon Lifecycle
| Command | Description |
|---|---|
| `rigged daemon start [--port] [--db]` | Start daemon (detached, healthz poll) |
| `rigged daemon stop` | SIGTERM + wait |
| `rigged daemon status` | 3-state: running/stopped/stale |
| `rigged daemon logs [--follow]` | Show/tail daemon log |

### Rig Operations
| Command | Description |
|---|---|
| `rigged status` | Rig summary with node counts, snapshot ages, cmux status |
| `rigged snapshot <rigId>` | Create snapshot |
| `rigged snapshot list <rigId>` | List snapshots |
| `rigged restore <snapshotId> --rig <rigId>` | Restore from snapshot |
| `rigged export <rigId> [-o path]` | Export rig to YAML |
| `rigged import <path> [--instantiate] [--preflight]` | Import YAML spec |

### Package Operations
| Command | Description |
|---|---|
| `rigged package validate <path>` | Validate manifest |
| `rigged package plan <path> [--target] [--runtime] [--role]` | Preview install plan |
| `rigged package install <path> [--target] [--runtime] [--role] [--allow-merge]` | Install package |
| `rigged package rollback <installId>` | Rollback install |
| `rigged package list` | List packages |

### Bootstrap + Discovery + Bundle
| Command | Description |
|---|---|
| `rigged bootstrap <spec> [--plan] [--yes] [--json]` | Full bootstrap pipeline |
| `rigged requirements <spec>` | Check requirements only |
| `rigged discover [--json]` | Scan for unmanaged tmux sessions |
| `rigged claim <discoveredId> --rig <rigId> [--logical-id]` | Adopt session into rig |
| `rigged bundle create <spec> -o <path> [--name] [--version]` | Create .rigbundle |
| `rigged bundle inspect <path> [--json]` | Inspect bundle integrity |
| `rigged bundle install <path> [--plan] [--yes] [--target]` | Install from bundle |
| `rigged ui open` | Open dashboard in browser |

### MCP Server
| Command | Description |
|---|---|
| `rigged mcp serve [--port]` | Start MCP server (stdio transport) |

**Exit code semantics:** 0 = success, 1 = blocked/no-op (human action needed), 2 = error.

---

## 7. MCP Server (10 tools)

`packages/cli/src/mcp-server.ts`. Uses `@modelcontextprotocol/sdk`. Stdio transport. Zod schemas.

| Tool | Route | Required params |
|---|---|---|
| `rigged_up` | POST /api/up | sourceRef |
| `rigged_down` | POST /api/down | rigId |
| `rigged_ps` | GET /api/ps | — |
| `rigged_status` | GET /healthz | — |
| `rigged_snapshot_create` | POST /api/rigs/{rigId}/snapshots | rigId |
| `rigged_snapshot_list` | GET /api/rigs/{rigId}/snapshots | rigId |
| `rigged_restore` | POST /api/rigs/{rigId}/restore/{snapshotId} | rigId, snapshotId |
| `rigged_discover` | POST /api/discovery/scan | — |
| `rigged_claim` | POST /api/discovery/{id}/claim | discoveryId, rigId |
| `rigged_bundle_inspect` | POST /api/bundles/inspect | bundlePath |

Three-level error mapping: HTTP status → body `error`/`errors[]` → structural check. All tool results are JSON text.

---

## 8. UI Layer

React + Vite + TanStack Router + TanStack Query + shadcn/ui + Tailwind CSS + React Flow. Design system: `docs/design/design-system.md`.

### Routing (10 routes)
| Route | Component | Description |
|---|---|---|
| `/` | Dashboard | Rig card grid + ps data + up/down affordances |
| `/rigs/$rigId` | RigDetail | Graph + snapshot panel |
| `/import` | ImportFlow | 3-step spec import wizard |
| `/packages` | PackageList | Package grid with install status |
| `/packages/install` | PackageInstallFlow | 5-step package install wizard |
| `/packages/$packageId` | PackageDetail | Install history + journal + rollback |
| `/bootstrap` | BootstrapWizard | Multi-step bootstrap with requirements panel |
| `/discovery` | DiscoveryOverlay | Discovered sessions + claim dialog |
| `/bundles/inspect` | BundleInspector | Bundle integrity verification |
| `/bundles/install` | BundleInstallFlow | Bundle bootstrap wizard |

### Components (18 app + 11 shadcn)
**AppShell** — Header + sidebar (5 nav items) + content (dot grid + route-enter animation) + status bar.
**Dashboard** — Summary + ps data merge. Rig cards with UP/DOWN/SNAPSHOT/EXPORT/GRAPH actions. Teardown confirmation dialog. Aggregate stats header.
**RigCard** — Milled container with count-up animation, recessed telemetry, tactical buttons, ps status badge.
**RigGraph** — React Flow with custom nodes, edge styles from design system, signature entrance animation (once per navigation), click-to-focus, discovered node dashed borders.
**RigNode** — Status dot with pulse animation on change, recessed telemetry block, package badges.
**SnapshotPanel** — Glassmorphism restore confirmation dialog. Per-node status with color coding.
**ImportFlow** — 3-step: VALIDATE → PREFLIGHT → INSTANTIATE with step indicator.
**PackageList** — Package grid with install count + latest status. INSTALL + VIEW buttons.
**PackageInstallFlow** — 5-step: ENTER → VALIDATE → CONFIGURE → PLAN → APPLY with per-entry policy status table.
**PackageDetail** — Install history (reverse chronological), expandable journal entries, rollback with confirmation dialog.
**BootstrapWizard** — Multi-step: ENTER → PLAN → REVIEW → APPLY. Requirements panel. Action checkboxes with auto-approve toggle.
**RequirementsPanel** — Color-coded requirement status (installed=green, missing=red, manual=amber).
**DiscoveryOverlay** — Dashed-border cards for discovered sessions. Claim dialog with rig ID + optional logical ID.
**BundleInspector** — Integrity verification display.
**BundleInstallFlow** — Bundle bootstrap wizard.
**StatusBar** — Health dot, rig count, cmux status, activity feed toggle. TanStack Query polling (health 10s, data 30s). Reconnect pulse.
**ActivityFeed** — Fixed-position overlay. 30-event bounded list. Global SSE subscription. 15s timestamp tick. Per-event color coding + navigation.
**Sidebar** — 5 nav items: RIGS, PACKAGES, BOOTSTRAP, DISCOVERY, IMPORT. Active state with left-edge accent.

### Data Layer (TanStack Query)
**Query keys:** `["rigs","summary"]`, `["rig",rigId,"graph"]`, `["rig",rigId,"snapshots"]`, `["packages"]`, `["packages",packageId]`, `["packages",packageId,"installs"]`, `["installs",installId,"journal"]`, `["discovery"]`, `["ps"]`, `["daemon","health"]`, `["daemon","cmux"]`.
**Mutations:** useCreateSnapshot, useRestoreSnapshot, useTeardownRig, useImportRig (with typed ImportError), useClaimSession, useBootstrapPlan, useBootstrapApply, useDiscoveryScan.
**SSE:** useRigEvents (rig-scoped, debounced 100ms → graph invalidation), useActivityFeed (global, 30-event bounded, package events → ["packages"] invalidation).

### Design System
0px border-radius everywhere. Volumetric surfaces (`--background` → `--surface-low` → `--surface` → `--surface-high`). Ghost borders only. Monospace for data (JetBrains Mono + Space Grotesk). Tactical `[ ACTION ]` buttons. Dot grid + noise textures. prefers-reduced-motion respected in CSS + JS.

### Animation Contracts
Count-up: mount-only. Node entrance: once per rigId (50ms stagger, 150ms fade). Edge draw-in: 300ms after nodes. Status pulse: on change only (600ms). Route flash: 200ms. Loading pulse: 1.5s continuous.

---

## 9. Event System

The `RigEvent` TypeScript union contains 27 event types. All persisted to `events` table with monotonic `seq`. SSE supports rig-scoped (`?rigId=`) and global streams. Subscribe-before-query gap-free pattern.

### Actively emitted events (22)

| Event | Scope | Emitted by |
|---|---|---|
| `rig.deleted` | rig | Route handler (atomic with DB delete) |
| `rig.imported` | rig | RigInstantiator (best-effort) |
| `rig.stopped` | rig | RigTeardownOrchestrator |
| `node.launched` | rig | NodeLauncher (within transaction) |
| `node.claimed` | rig | ClaimService (within transaction) |
| `session.detached` | rig | Reconciler (within transaction) |
| `session.discovered` | global | DiscoveryCoordinator |
| `session.vanished` | global | DiscoveryCoordinator |
| `snapshot.created` | rig | SnapshotCapture (within transaction) |
| `restore.started` | rig | RestoreOrchestrator |
| `restore.completed` | rig | RestoreOrchestrator |
| `package.validated` | global | Package validate route |
| `package.planned` | global | Package plan route |
| `package.installed` | global | Package install route |
| `package.rolledback` | global | Package rollback route |
| `package.install_failed` | global | Package install route |
| `bootstrap.planned` | global | Bootstrap plan route |
| `bootstrap.started` | global | Bootstrap apply route (pre-orchestrator) |
| `bootstrap.completed` | global | Bootstrap apply route |
| `bootstrap.partial` | global | Bootstrap apply route |
| `bootstrap.failed` | global | Bootstrap apply route |
| `bundle.created` | global | Bundle create route |

### Union-only (not currently emitted — reserved for future use, 5)

| Event | Scope | Note |
|---|---|---|
| `rig.created` | rig | In union but POST /api/rigs does not emit |
| `node.added` | rig | In union but addNode does not emit |
| `node.removed` | rig | In union but no removal path emits |
| `binding.updated` | rig | In union but updateBinding does not emit |
| `session.status_changed` | rig | In union but updateStatus does not emit |

---

## 10. Startup Sequence

`createDaemon()` in `startup.ts`:
1. Create SQLite database (WAL mode, foreign keys ON)
2. Run all 13 migrations
3. Instantiate core: RigRepository, SessionRegistry, EventBus
4. Instantiate adapters: TmuxAdapter, CmuxAdapter
5. Instantiate NodeLauncher
6. Instantiate snapshot services: SnapshotRepository, CheckpointStore, SnapshotCapture
7. Instantiate resume adapters + RestoreOrchestrator
8. Connect cmux (graceful degradation)
9. Reconcile managed rigs
10. Instantiate Phase 3: RigSpecExporter, RigSpecPreflight, RigInstantiator
11. Instantiate Phase 4: PackageRepository, InstallRepository, InstallEngine, InstallVerifier
12. Instantiate Phase 5: BootstrapRepository, RuntimeVerifier, RequirementsProbeRegistry, ExternalInstallPlanner, ExternalInstallExecutor, PackageInstallService, BootstrapOrchestrator (with BundleSourceResolver)
13. Instantiate Discovery: TmuxDiscoveryScanner, SessionFingerprinter, SessionEnricher, DiscoveryRepository, DiscoveryCoordinator, ClaimService
14. Instantiate Cross-cutting: PsProjectionService, UpCommandRouter, RigTeardownOrchestrator
15. Create Hono app with all 24 dependencies injected (15 db-handle checks at construction)
16. Mount all 15 route groups + 3 standalone handlers (healthz, spec YAML, spec JSON)
17. Return app

---

## 11. Architecture Rules

1. **Topology ≠ bindings ≠ layout.** Nodes = identity. Bindings = operational coordinates. Layout = UI concern.
2. **Framework-agnostic domain.** Zero Hono imports in `domain/` or `adapters/`.
3. **Event bus separate from HTTP.** SSE subscribes to the bus. Bus has no HTTP concepts.
4. **cmux degraded mode.** Daemon starts and functions without cmux.
5. **Shared DB handle.** All domain services validated at construction time (15 server-level + service-internal checks).
6. **Events append-only.** Events and snapshots survive entity deletion. Checkpoints cascade.
7. **Cross-rig access control.** Snapshot/restore enforce rig boundary.
8. **Cycle detection before materialization.** RigInstantiator rejects cycles before DB writes.
9. **Compensating restore.** Failed node launches restore prior state.
10. **Shell-quoting for tmux.** All resume tokens and CLI commands POSIX shell-quoted.
11. **Per-rig concurrency lock.** RestoreOrchestrator prevents concurrent restores.
12. **File-based checkpoint delivery.** `.rigged-checkpoint.md`, not tmux sendText.
13. **Design system compliance.** 0px radius enforced at config level. Tested in build.
14. **Backup before write.** Install engine creates backups in `.rigged-backups/{installId}/`.
15. **Journaled install operations.** Append-only journal with SHA-256 hashes.
16. **Managed block isolation.** `<!-- BEGIN/END RIGGED MANAGED BLOCK: {name} -->`.
17. **Repo-first install scope.** Phase 4 = project_shared only.
18. **Path traversal rejection.** Export sources validated at parse time. Bundle paths validated at manifest + resolver level.
19. **Probe safety.** No manifest shell execution. installHints display-only. Trusted provider commands only.
20. **External install trust boundary.** commandPreview from planner (not manifest). manual_only defense-in-depth.
21. **Bundle integrity.** Two-layer: archive SHA-256 + per-file content hashes. Sensitive file blocking.
22. **Archive safety.** Pre-scan before extraction rejects symlinks, hardlinks, traversal, absolute paths.
23. **Deterministic archives.** Portable mode + fixed mtime + sorted files.
24. **Discovery is observe-only.** Separate table. Claim is adopt-only (no package reconciliation).
25. **Fingerprint layering.** cmux PID (highest) → process tree → pane content → config context. Never overrides higher-confidence signals.
26. **Claim atomicity.** 5 mutations in one transaction with rollback test.
27. **Teardown atomicity.** Per-node cleanup transactional. Delete atomic with event. Kill failure blocks delete.

---

## 12. Test Infrastructure

- **Runner:** vitest across all 3 packages
- **Daemon (954 tests, 74 files):** in-memory SQLite, mock ExecFn, Hono `app.request()`, real temp dirs for install/bundle tests, sabotaged-DB rollback tests
- **CLI (150 tests, 15 files):** mock LifecycleDeps, mock HTTP servers, Commander parseAsync with captured console, MCP InMemoryTransport
- **UI (225 tests, 19 files):** TanStack Router with memory history and real route tree, TanStack Query with isolated clients, design compliance source scans, production build verification, mock fetch + mock EventSource
- **Helpers:** `createTestApp()` (daemon), `createTestRouter()` / `createAppTestRouter()` (UI), `mockTmuxAdapter()` (shared), `createMockEventSourceClass()` (SSE)

---

## 13. What's Not Built Yet

- **Auto-snapshots** (periodic timers, topology-change triggers)
- **Hook + MCP install** (parsed and deferred — actual apply in future)
- **User-global / system scope installs** (project_shared only)
- **Remote package sources** (local_path only — git/URL deferred)
- **Agent-mediated semantic merges** (deterministic only)
- **cmux browser surface embedding** (needs cmux upgrade)
- **Organic session discovery polling** (one-shot + UI poll, no daemon background scan)
- **Resume verification** (fire-and-forget — harness status polling deferred)
- **React Hook Form + Zod** (foundation installed, not yet used)
- **RigBundle from remote URL** (local file only)
- **Package UI search/filter**
- **Multi-machine rig support**
