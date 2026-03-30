# Rigged — As-Built Architecture
## Complete Reboot Snapshot (as of 2026-03-30)

Status:
- Reboot scope landed: all 16 implementation tasks (`AS-T00` through `AS-T14`, with split `AS-T08a` and `AS-T08b`) plus the Checkpoint 2 and Checkpoint 3 fix cycles.
- Shipped source footprint: 185 source files across the three packages.
- Daemon footprint: 109 source files total, including 65 domain files, 14 route files, 9 adapters, and 15 migrations.
- CLI footprint: 23 source files.
- UI footprint: 53 source files total (`52` TypeScript/TSX files plus `globals.css`).
- Current test footprint at `HEAD`: 127 Vitest files containing 1,558 tests (`90/1153` daemon, `17/168` CLI, `20/237` UI).
- Current full-suite verification during this refresh:
  - daemon: `1153/1153` passing
  - CLI: `168/168` passing
  - UI: `236/237` passing, with 1 Tailwind foundation assertion failing

Packages: `@rigged/daemon`, `@rigged/cli`, `@rigged/ui`

---

## 1. System Overview

Rigged is a local control plane for multi-agent coding topologies. The shipped architecture is now a real dual-stack:

1. Legacy flat-node/package flows remain for compatibility with pre-reboot data and v1 artifacts.
2. The canonical shipped path is the AgentSpec + pod-aware RigSpec reboot:
   - AgentSpec parsing and validation
   - pod-aware RigSpec parsing, preflight, instantiation, export
   - layered startup resolution and runtime projection
   - continuity-aware snapshot/restore replay
   - schema-version-2 bundle create/inspect/install

The stack is:

```text
CLI / UI / MCP
      |
      v
Hono daemon routes
      |
      +-- dual-format route adapters
      |     - legacy v1 rigs / package bundles
      |     - rebooted v0.2 rigs / v2 pod bundles
      |
      v
Framework-free domain services
      |
      +-- SQLite state
      +-- tmux / cmux / resume adapters
      +-- runtime adapters (Claude Code / Codex)
```

Architecturally, the reboot is complete at the public surface: the route layer, CLI, MCP wrappers, and UI all speak the rebooted vocabulary, while legacy seams continue to exist for compatibility.

---

## 2. Current Public Surface

### HTTP routes

`createApp()` mounts the following public route groups:

- `GET /healthz`
- `/api/rigs`
- `/api/rigs/:rigId/sessions`
- `/api/rigs/:rigId/nodes`
- `/api/adapters`
- `/api/events`
- `/api/rigs/:rigId/snapshots`
- `/api/rigs/:rigId/restore`
- `/api/rigs/import`
- `GET /api/rigs/:rigId/spec`
- `GET /api/rigs/:rigId/spec.json`
- `/api/packages`
- `/api/agents`
- `/api/bootstrap`
- `/api/discovery`
- `/api/bundles`
- `/api/ps`
- `/api/up`
- `/api/down`

Important rebooted route behavior:

- `/api/agents/validate` is the canonical AgentSpec validation endpoint.
- `/api/rigs/import`, `/validate`, and `/preflight` are dual-format.
- Pod-aware import and preflight require `X-Rig-Root`.
- `/api/bundles/create`, `/inspect`, and `/install` are dual-format.
- `/api/up` accepts both direct pod-aware rig specs and schema-version-2 bundles through the bootstrap orchestrator.

### CLI commands

The shipped CLI command groups are:

- `daemon`
- `status`
- `snapshot`
- `restore`
- `export`
- `import`
- `ui`
- `package`
- `bootstrap`
- `requirements`
- `discover`
- `claim`
- `bundle`
- `up`
- `down`
- `ps`
- `mcp`
- `agent`
- `rig`

Reboot-era additions and changes:

- `rigged agent validate <path> [--json]`
- `rigged rig validate <path> [--json]`
- `rigged rig preflight <path> [--rig-root <path>] [--json]`
- `rigged import ... --rig-root <path>` for pod-aware import/preflight flows
- `rigged bundle create ... --rig-root <path>` for pod-aware bundle assembly
- `package` remains mounted as the legacy package-management surface

### MCP tools

The CLI-hosted MCP server exposes 12 tools:

1. `rigged_up`
2. `rigged_down`
3. `rigged_ps`
4. `rigged_status`
5. `rigged_snapshot_create`
6. `rigged_snapshot_list`
7. `rigged_restore`
8. `rigged_discover`
9. `rigged_claim`
10. `rigged_bundle_inspect`
11. `rigged_agent_validate`
12. `rigged_rig_validate`

### UI screens

The current UI route tree exposes:

- dashboard
- rig topology
- import flow
- package/spec list and package detail
- bootstrap wizard
- bundle inspector
- bundle install flow
- discovery overlay
- snapshot panel

Terminology is rebooted on the main authoring/install surfaces:
- RigSpec / AgentSpec vocabulary in validation and import
- `SPECS` in navigation
- legacy labeling on the old package surfaces

---

## 3. Database Schema

The daemon now has 15 migrations.

### Core state tables

**rigs**
- Top-level topology container.

**nodes**
- Logical node identity inside a rig.
- Legacy columns remain (`logical_id`, `runtime`, `model`, `cwd`, `restore_policy`, `package_refs`).
- Reboot additions from migration 014:
  - `pod_id`
  - `agent_ref`
  - `profile`
  - `label`
  - `resolved_spec_name`
  - `resolved_spec_version`
  - `resolved_spec_hash`

**edges**
- Logical topology relationships.

**bindings**
- Physical surface attachment: tmux/cmux coordinates.

**sessions**
- Live execution state.
- Reboot additions from migration 014:
  - `startup_status`
  - `startup_completed_at`
- Restore still reads the newest session row, so narrowed restore policy must be propagated to both node and session rows.

**events**
- Append-only event log.

**snapshots**
- Serialized rig state.

**checkpoints**
- Per-node recovery state.
- Reboot additions from migration 014:
  - `pod_id`
  - `continuity_source`
  - `continuity_artifacts_json`

### Legacy package / bootstrap / discovery tables

These remain active:
- `packages`
- `package_installs`
- `install_journal`
- `bootstrap_runs`
- `bootstrap_actions`
- `runtime_verifications`
- `discovered_sessions`

### Reboot-specific tables

**pods** (`014_agentspec_reboot.ts`)
- Persisted pod record containing label, summary, and serialized continuity policy.

**continuity_state** (`014_agentspec_reboot.ts`)
- Live per-`pod_id` / `node_id` operational continuity state.
- Current statuses:
  - `healthy`
  - `degraded`
  - `restoring`

**node_startup_context** (`015_startup_context.ts`)
- Persisted startup replay context for restore.
- Stores:
  - classification-free projection intent
  - resolved startup files with owner-root provenance
  - startup actions
  - runtime

Migration boundary:
- `014_agentspec_reboot.ts` adds the reboot schema shape.
- `015_startup_context.ts` adds only persisted startup replay context.

---

## 4. Canonical Reboot Types

### Spec and topology

**AgentSpec**
- Parsed from `agent.yaml`.
- Owns imports, defaults, startup, resources, and profiles.

**RigSpec**
- Canonical pod-aware rig topology.
- Uses `version: "0.2"` and `pods[]`.
- Owns cross-pod `edges[]`, rig-level startup overlays, and `cultureFile`.

**RigSpecPod**
- Pod-local bounded context with `members[]`, pod-local `edges[]`, pod startup, and optional continuity policy.

**RigSpecPodMember**
- Member-level runtime and startup surface:
  - `agentRef`
  - `profile`
  - `runtime`
  - `model?`
  - `cwd`
  - `restorePolicy?`
  - member startup overlays

**Pod**
- Persisted DB entity for a pod.

**ContinuityState**
- Persisted live continuity row keyed by `podId + nodeId`.

### Execution and restore

**ResolvedNodeConfig**
- Output of profile resolution.
- Carries effective runtime/model/cwd, narrowed restore policy, selected resources, layered startup block, and resolved spec identity.

**ProjectionPlan**
- Runtime projection plan for a node.
- Carries runtime, cwd, projection entries, startup block, diagnostics, and conflict/no-op classifications.

**RuntimeAdapter**
- Four-method contract:
  - `listInstalled(binding)`
  - `project(plan, binding)`
  - `deliverStartup(files, binding)`
  - `checkReady(binding)`

**StartupOrchestrator**
- Takes session/binding, adapter, projection plan, resolved startup files, startup actions, and restore/fresh context.
- Persists replay context after successful startup.

**SnapshotData**
- Current serialized snapshot payload.
- Reboot extensions are optional for compatibility with older snapshots:
  - `pods?`
  - `continuityStates?`
  - `nodeStartupContext?`

**NodeStartupSnapshot**
- Persisted restore replay input:
  - classification-free projection entries
  - resolved startup files
  - startup actions
  - runtime

**PersistedProjectionEntry**
- The classification-free restore replay seam.
- Persists only entry identity and source metadata, not stale `classification`, `conflicts`, or `noOps`.

---

## 5. Domain Services

All rebooted services live under `packages/daemon/src/domain/`. The rule remains: zero Hono imports in domain code.

### Parsing and validation

- `agent-manifest.ts`: canonical AgentSpec parse/normalize/validate
- `rigspec-schema.ts`: dual-format RigSpec validation
- `rigspec-codec.ts`: dual-format YAML codec
- `startup-validation.ts`: shared startup block validation
- `path-safety.ts`: shared relative-path safety checks
- `spec-validation-service.ts`: pure raw-YAML validation helpers

### Resolution pipeline

- `agent-resolver.ts`: resolves `agent_ref`, imports, and collision metadata
- `agent-preflight.ts`: single-agent resolution/preflight
- `profile-resolver.ts`: applies defaults, profile uses, resource selection, startup layering, and restore-policy narrowing
- `startup-resolver.ts`: additive startup layering
- `projection-planner.ts`: runtime resource projection planning

### Startup, runtime, and instantiation

- `runtime-adapter.ts`: adapter contract and bridge types
- `startup-orchestrator.ts`: startup projection, delivery, actions, readiness, and replay persistence
- `rigspec-preflight.ts`: dual-stack legacy preflight plus rebooted `rigPreflight(...)`
- `rigspec-instantiator.ts`: dual-stack `RigInstantiator` plus `PodRigInstantiator`
- `rigspec-exporter.ts`: dual-format live rig export back to YAML/JSON
- `pod-repository.ts`: pod CRUD plus live continuity-state CRUD

### Runtime adapters

The shipped runtime adapters now own projection, startup-file delivery, installed-resource listing, and readiness checks.

**ClaudeCodeAdapter**
- projects Claude-facing resources into `.claude/...`
- merges guidance into `CLAUDE.md`

**CodexRuntimeAdapter**
- preserves Codex-facing target conventions:
  - skills -> `.agents/skills/{id}/`
  - guidance -> `AGENTS.md`
  - subagents -> `.agents/{id}.yaml`
  - hooks -> `.agents/hooks/`
  - runtime resources -> `.agents/extensions/{id}/`

### Snapshot, restore, and continuity

- `checkpoint-store.ts`: checkpoint persistence with pod/continuity context
- `snapshot-capture.ts`: captures pods, continuity state, and startup replay context
- `snapshot-repository.ts`: snapshot CRUD
- `restore-orchestrator.ts`: resume, checkpoint delivery, startup replay, live continuity consultation, and topology ordering

### Bundles, bootstrap, and legacy compatibility

- `pod-bundle-assembler.ts`: schema-version-2 bundle assembler
- `bundle-types.ts`: v1 and v2 manifest types plus parse/validate/serialize
- `bundle-source-resolver.ts`: `LegacyBundleSourceResolver` plus `PodBundleSourceResolver`
- `bootstrap-orchestrator.ts`: staged bootstrap flow with direct pod-aware rig and v2 bundle delegation
- `up-command-router.ts`: spec/bundle source classification for `/api/up`

### Legacy systems that still ship

- package install engine (`package-*`, `install-*`, `conflict-detector.ts`, `role-resolver.ts`)
- bootstrap and requirement probe support
- discovery and claim services
- tmux/cmux adapters and resume adapters

---

## 6. Current Execution Flows

### RigSpec import / validate / preflight / export

`routes/rigspec.ts` is the main dual-format seam:

- validate:
  - pod-aware -> `RigSpecSchema.validate`
  - legacy -> `LegacyRigSpecSchema.validate`
- preflight:
  - pod-aware -> `rigPreflight({ rigSpecYaml, rigRoot, fsOps })`
  - legacy -> `RigSpecPreflight.check(spec)`
- import:
  - pod-aware -> `podInstantiator.instantiate(yaml, rigRoot)`
  - legacy -> `RigInstantiator.instantiate(spec)`
- export:
  - pod-aware rigs export canonical `version: "0.2"` RigSpec YAML/JSON
  - legacy rigs export flat-node v1 YAML/JSON

### Bundle create / inspect / install

`routes/bundles.ts` is fully dual-format:

- create:
  - detects pod-aware RigSpec and uses `PodBundleAssembler`
  - accepts optional `rigRoot`
  - legacy create still uses `LegacyBundleAssembler`
- inspect:
  - safely extracts the archive
  - detects `schema_version`
  - v2 returns `schemaVersion: 2`, `agents[]`, and integrity data
  - v1 returns the legacy manifest shape
- install:
  - uses full bootstrap plan/apply
  - bootstrap peeks the manifest and routes deterministically to `pod_bundle` or `rig_bundle`

### `/api/up`

`UpCommandRouter` and `BootstrapOrchestrator` now own:

- direct pod-aware rig specs
- legacy rig specs
- v1 bundle installs
- v2 pod-bundle installs

Plan mode and apply mode both work across those source kinds.

### Snapshot / restore

Restore now:

- reads the newest session by monotonic ULID, not timestamp alone
- consults live `continuity_state`
- preserves state when a node is already `restoring`
- replays restore-safe startup using persisted startup context
- prefilters missing optional artifacts into warnings
- hard-fails a node if a required startup file is missing

---

## 7. Architecture Rules

1. Zero Hono in `domain/` and `adapters/`.
2. Routes depend on the domain; the domain never depends on routes.
3. Shared DB-handle invariants are enforced at construction time.
4. The reboot is engine-first: domain services land before public-surface rewiring.
5. Runtime is member-authoritative in the pod-aware model.
6. Startup layering is additive and ordered:
   1. agent base
   2. profile
   3. rig culture file
   4. rig startup
   5. pod startup
   6. member startup
   7. operator debug append
7. Restore-policy narrowing is one-way only:
   - `resume_if_possible`
   - `relaunch_fresh`
   - `checkpoint_only`
8. Base/import collisions warn; ambiguous import/import unqualified refs fail loudly.
9. Bundle assembly and startup-file resolution use containment checks rooted in the owning artifact.
10. Restore replay uses classification-free projection intent, not stale startup-time `no_op` / conflict classifications.
11. Startup status is explicit session state: `pending`, `ready`, `failed`.
12. Session recency depends on monotonic ULIDs:
    - `session-registry.ts` uses `monotonicFactory()`
    - restore selects the newest session by max ULID
13. Current readiness checking is still a single poll, not a retry loop.

### Current startup action constraints

- no shell startup actions
- action types are `slash_command` and `send_text` only
- non-idempotent actions must not apply on restore
- retrying failed startup is handled as restore

### Remote import constraints

The reboot currently supports:
- `local:...`
- `path:/abs/...`

Remote `agent_ref` sources remain unsupported and fail in preflight.

---

## 8. Event System

The `RigEvent` union now includes reboot-era signals.

Currently emitted in production code:
- `node.startup_pending`
- `node.startup_ready`
- `node.startup_failed`

Present in the union but not yet emitted by production code:
- `pod.created`
- `pod.deleted`
- `continuity.sync`
- `continuity.degraded`

The event log remains append-only and SQLite-backed.

---

## 9. Startup Sequence (`createDaemon`)

`createDaemon()` now does the following:

1. Open SQLite and run all 15 migrations.
2. Construct core repositories and legacy services.
3. Construct package/bootstrap/discovery services.
4. Construct rebooted startup/runtime services:
   - `StartupOrchestrator`
   - `ClaudeCodeAdapter`
   - `CodexRuntimeAdapter`
   - `PodRigInstantiator`
   - `PodBundleSourceResolver`
5. Construct `BootstrapOrchestrator` with both legacy and rebooted seams.
6. Build `AppDeps`, enforce shared-DB invariants in `createApp()`, and mount the full route tree.

This is no longer a daemon that only "knows about" the rebooted engine. The public app wiring now includes the rebooted seams.

---

## 10. Test And Verification State

### Test footprint

- daemon: 90 Vitest files / 1,153 tests
- CLI: 17 Vitest files / 168 tests
- UI: 20 Vitest files / 237 tests

### Verified during this doc refresh

- `npm test -- -w @rigged/daemon`
  - result: `1153/1153` passing
- `npm test -- -w @rigged/cli`
  - result: `168/168` passing
- `npm test -- -w @rigged/ui`
  - result: `236/237` passing
  - known failure: 1 Tailwind foundation assertion (`.bg-card` emission)

### Reboot-heavy suites

Representative rebooted coverage now includes:

- `agent-manifest.test.ts`
- `agent-resolver.test.ts`
- `profile-resolver.test.ts`
- `projection-planner.test.ts`
- `startup-resolver.test.ts`
- `startup-orchestrator.test.ts`
- `agentspec-startup.integration.test.ts`
- `pod-rigspec-instantiator.test.ts`
- `pod-bundle-assembler.test.ts`
- `bundle-source-resolver.test.ts`
- `rigspec-preflight.test.ts`
- `agentspec-restore.integration.test.ts`
- `pod-repository.test.ts`
- `spec-validation-service.test.ts`
- `agent-preflight.test.ts`
- CLI tests for `agent`, `rig`, bundle, MCP, export/import, and daemon lifecycle
- UI tests for import flow, bundle install/inspect, dashboard, topology, discovery, and legacy package surfaces

### Dogfood status

Checkpoint 3 Round 2 dogfood verified:

- CLI pod-aware import, `up`, export, bundle create/inspect/install, `ps`, and `down`
- MCP all 12 tools
- browser import flow, topology view, bundle inspector, bundle install flow, and dashboard

---

## 11. Remaining Compatibility Notes

These are the main intentional limits that still describe the shipped system:

1. Readiness polling is still a single `checkReady()` pass.
2. Remote `agent_ref` imports remain unsupported.
3. Startup actions remain intentionally constrained (`slash_command`, `send_text`).
4. Legacy compatibility seams still ship for pre-reboot data and v1 artifacts.

---

## 12. Cross-References

This document is the architecture-level source of truth.

For file-by-file structure across daemon, CLI, and UI, use:
- [codemap.md](/Users/mschwarz/code/rigged/docs/as-built/codemap.md)
