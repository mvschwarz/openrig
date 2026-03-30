# Rigged — As-Built Architecture
## AgentSpec Reboot Snapshot (as of 2026-03-29)

Status:
- Current audited daemon count: 1153 tests across 90 Vitest files.
- Current audited CLI count: 168 tests across 17 Vitest files.
- Daemon footprint: 109 source files total, including 65 domain files, 14 route files, 9 adapters, and 15 migrations.
- CLI footprint: 23 source files (added agent.ts, rig.ts commands).
- UI footprint: 53 source files including `globals.css` (`52` TypeScript/TSX files plus `1` CSS entrypoint).
- Reboot status: all 16 tasks (AS-T00 through AS-T14) plus three checkpoint fix rounds are landed. The full surface — engine, routes, CLI, and UI — is rebooted.

Packages: `@rigged/daemon` + `@rigged/cli` + `@rigged/ui`

---

## 1. System Overview

Rigged is still a local control plane for multi-agent coding topologies, but the daemon now has two architectural layers in parallel:

1. A legacy flat-node / package-ref path that still serves much of the current HTTP surface.
2. A rebooted AgentSpec / pod-aware engine that already owns parsing, resolution, startup, continuity, restore replay, bundle assembly, and pod-aware instantiation.

Current shape:

```
CLI / UI / MCP
      |
      v
Hono daemon routes
      |
      +-- Legacy route surface still active for many endpoints
      |
      +-- Rebooted engine already active in:
          - UpCommandRouter source detection
          - BootstrapOrchestrator direct pod-aware rig path
          - PodRigInstantiator
          - StartupOrchestrator
          - Pod bundle assembly / pod bundle resolution
          - AgentSpec validation / preflight domain services
      |
      v
Domain services (framework-agnostic)
      |
      +-- SQLite state
      +-- tmux / cmux adapters
      +-- runtime adapters (Claude Code / Codex)
```

The reboot is complete across all layers:
- The engine, route surface, CLI, and UI are all rebooted.
- Legacy compatibility seams remain for pre-reboot data but all new flows use the canonical pod-aware model.

---

## 2. Database Schema

The daemon now has 15 migrations.

### Core state tables

**rigs**
- Top-level topology container.

**nodes**
- Logical node identity within a rig.
- Legacy fields still exist: `logical_id`, `runtime`, `model`, `cwd`, `restore_policy`, `package_refs`.
- Reboot additions from migration 014:
  - `pod_id`
  - `agent_ref`
  - `profile`
  - `label`
  - `resolved_spec_name`
  - `resolved_spec_version`
  - `resolved_spec_hash`

**edges**
- Logical relationships between nodes.

**bindings**
- Physical surface attachment: tmux/cmux coordinates.

**sessions**
- Live harness execution state.
- Reboot additions from migration 014:
  - `startup_status` (`pending | ready | failed`)
  - `startup_completed_at`
- Resume metadata and restore policy still live here because restore reads the newest session row, not the node row.

**events**
- Append-only event log.

**snapshots**
- Point-in-time serialized rig state.

**checkpoints**
- Per-node recovery state.
- Reboot additions from migration 014:
  - `pod_id`
  - `continuity_source`
  - `continuity_artifacts_json`

### Package / bootstrap / discovery tables

These remain from the pre-reboot system:
- `packages`
- `package_installs`
- `install_journal`
- `bootstrap_runs`
- `bootstrap_actions`
- `runtime_verifications`
- `discovered_sessions`

### Reboot-specific tables

**pods** (migration 014)
- Bounded context grouping inside a rig.
- Stores `label`, `summary`, and serialized continuity policy.

**continuity_state** (migration 014)
- Live per-`pod_id` / `node_id` operational continuity state.
- Current statuses:
  - `healthy`
  - `degraded`
  - `restoring`

**node_startup_context** (migration 015)
- Persisted startup replay context for restore.
- Stores:
  - classification-free projection intent
  - resolved startup files with owner-root provenance
  - startup actions
  - runtime

This table is the bridge between the startup engine and restore replay.

Migration boundary:
- `014_agentspec_reboot.ts` adds the reboot schema shape: pods, continuity state, node/session/checkpoint reboot columns.
- `015_startup_context.ts` adds only `node_startup_context`, the persisted startup replay payload used by restore.

---

## 3. Rebooted Core Types

The reboot introduced a second canonical topology and execution vocabulary.

### Spec / topology types

**AgentSpec**
- Parsed from `agent.yaml`.
- Owns:
  - imports
  - defaults
  - startup
  - resources
  - profiles

**RigSpec** (pod-aware)
- No longer a flat `nodes[]`-only contract.
- Owns:
  - `pods[]`
  - cross-pod `edges[]`
  - `cultureFile`
  - rig-level startup overlays

**RigSpecPod**
- Bounded pod with:
  - `members[]`
  - pod-local `edges[]`
  - optional continuity policy
  - pod-level startup overlays

**RigSpecPodMember**
- Member-authoritative runtime surface:
  - `agentRef`
  - `profile`
  - `runtime`
  - `model?`
  - `cwd`
  - `restorePolicy?`
  - member-level startup overlays

**Pod**
- Persisted DB record for a pod.

**ContinuityState**
- Persisted live continuity row keyed by `podId + nodeId`.

### Execution / restore types

**ResolvedNodeConfig**
- Output of profile resolution.
- Carries:
  - effective runtime / model / cwd
  - narrowed restore policy
  - selected resources
  - layered startup block
  - resolved spec identity

**ProjectionPlan**
- Output of projection planning for one node.
- Carries:
  - runtime
  - cwd
  - projection entries
  - startup block
  - diagnostics
  - conflict / no-op classification output

**RuntimeAdapter**
- Four-method contract:
  - `listInstalled(binding)`
  - `project(plan, binding)`
  - `deliverStartup(files, binding)`
  - `checkReady(binding)`

**StartupOrchestrator**
- Takes:
  - session + binding
  - runtime adapter
  - projection plan
  - resolved startup files
  - startup actions
  - restore/fresh context
- Returns `ready` or `failed`.

**SnapshotData**
- Has optional reboot-specific extensions:
  - `pods?`
  - `continuityStates?`
  - `nodeStartupContext?`

Those fields are optional because restore/snapshot code must still accept legacy snapshots that predate the rebooted capture payload.

**NodeStartupSnapshot**
- Persisted restore replay input:
  - projection entries
  - resolved startup files
  - startup actions
  - runtime

---

## 4. Rebooted Domain Services

All rebooted services live under `packages/daemon/src/domain/`. They continue the existing rule: zero Hono imports in domain code.

### Spec parsing and validation

**agent-manifest.ts**
- Canonical AgentSpec parser / normalizer / validator.

**rigspec-schema.ts**
- Now contains both:
  - legacy flat-node RigSpec validation
  - canonical pod-aware RigSpec validation

**startup-validation.ts**
- Shared startup validation / normalization:
  - validates startup files
  - validates startup actions
  - rejects unsupported shell startup actions in v1
  - enforces restore-safety rules for non-idempotent actions

**path-safety.ts**
- Shared relative-path validation used by AgentSpec, RigSpec, package manifests, and startup config.
- Centralizes path traversal rejection for user-authored manifest paths.

**spec-validation-service.ts**
- Pure YAML validation service for:
  - AgentSpec YAML
  - pod-aware RigSpec YAML

### Resolution pipeline

**agent-resolver.ts**
- Resolves `agent_ref` plus flat imports.
- Builds collision diagnostics across:
  - base resources
  - imported resources
- Enforces source resolution rules:
  - `local:...`
  - `path:/abs/...`
- Rejects unsupported remote import behavior in the current v1 reboot.

**profile-resolver.ts**
- Resolves profile-selected resources against the base/import pool.
- Produces `ResolvedNodeConfig`.
- Owns:
  - missing-profile failure
  - ambiguous unqualified import/import failure
  - restore-policy narrowing
  - runtime/model/cwd precedence

**startup-resolver.ts**
- Builds effective startup in fixed additive order:
  1. agent base startup
  2. profile startup
  3. rig culture file
  4. rig startup
  5. pod startup
  6. member startup
  7. operator debug append

### Projection and startup

**projection-planner.ts**
- Converts `ResolvedNodeConfig` plus collision diagnostics into a runtime projection plan.
- Filters runtime resources by member runtime.
- Produces projection diagnostics and conflict/no-op classification.

**runtime-adapter.ts**
- Defines the runtime adapter contract and resolved startup file shape.

**startup-orchestrator.ts**
- Drives the startup sequence:
  1. mark session `startup_status = pending`
  2. project resources
  3. deliver startup files
  4. run `after_files` actions
  5. `checkReady`
  6. run `after_ready` actions
  7. mark `startup_status = ready`
- Persists startup context to `node_startup_context` for restore replay.

### Validation / preflight

**agent-preflight.ts**
- Agent-only resolution/preflight.
- No runtime check.

**rigspec-preflight.ts**
- Still contains the legacy `RigSpecPreflight` class.
- Also now exports rebooted `rigPreflight(...)`, which validates:
  - pod-aware RigSpec YAML
  - all `agent_ref`s
  - profile selection
  - ambiguity rules
  - restore-policy narrowing
  - runtime and cwd requirements

### Instantiation / continuity / restore

**rigspec-instantiator.ts**
- Still contains the legacy `RigInstantiator`.
- Also now contains `PodRigInstantiator`.
- Pod-aware instantiation owns:
  - parse + validate
  - preflight
  - pod creation
  - node creation with resolved spec identity
  - topological member launch ordering
  - cycle rejection
  - startup orchestration

**pod-repository.ts**
- CRUD for pods.
- Also owns continuity-state CRUD:
  - query continuity for a rig
  - update per-node continuity state

**checkpoint-store.ts**
- Evolved to carry pod / continuity context on checkpoints.

**snapshot-capture.ts**
- Now captures pods, continuity state, and startup replay context.

**restore-orchestrator.ts**
- Now mixes legacy restore mechanics with rebooted replay:
  - reads newest session
  - consults live `continuity_state`
  - preserves state on `restoring`
  - replays restore-safe startup when persisted startup context exists
  - prefilters missing optional artifacts into warnings
  - hard-fails a node if a required startup file is missing

### Bundles

**pod-bundle-assembler.ts**
- Canonical schema-version-2 bundle walker.
- Walks pod members via `agent_ref`.
- Vendors referenced AgentSpecs plus imports.
- Produces the rebooted `agents[]` bundle manifest shape.

**bundle-types.ts**
- Now contains both:
  - canonical pod-aware bundle types / parse / validate
  - legacy bundle types / parse / validate

**bundle-source-resolver.ts**
- Now contains both:
  - `LegacyBundleSourceResolver`
  - `PodBundleSourceResolver`

### Current dual-stack reality

The daemon currently has a real dual-stack:
- legacy domain seams still exist for the old route surface
- canonical rebooted seams already exist and are used by the rebooted engine

That duality is intentional at current `HEAD`.

---

## 5. Adapter Layer

The adapter layer grew from tmux/cmux/resume support into a harness-delivery abstraction.

**tmux.ts**
- Still the command surface for tmux enumeration, session creation, and `sendText`.

**cmux.ts**
- Still optional / degraded.

**claude-resume.ts / codex-resume.ts**
- Still own resume behavior.

**claude-code-adapter.ts**
- Runtime adapter for Claude Code.
- Projects to `.claude/...` targets and merges into `CLAUDE.md`.

**codex-runtime-adapter.ts**
- Runtime adapter for Codex.
- Preserves existing Codex-facing target conventions:
  - skills -> `.agents/skills/{id}/`
  - guidance -> `AGENTS.md`
  - subagents -> `.agents/{id}.yaml`
  - hooks -> `.agents/hooks/`
  - runtime resources -> `.agents/extensions/{id}/`

Current runtime adapters own file projection, startup file delivery, installed-resource listing, and readiness checks.
They do not execute startup actions directly.

---

## 6. Bootstrap and Bundle State

The bootstrap subsystem is now partially reboot-aware.

### What is already rebooted

**up-command-router.ts**
- Accepts both pod-aware and legacy rig specs.

**bootstrap-orchestrator.ts**
- Detects pod-aware direct rig specs before legacy validation.
- Supports pod-aware plan/apply for direct `rig_spec` sources via `PodRigInstantiator`.

### What was hybrid (now resolved)

AS-T12 closed the route/app wiring gap. The pod bundle assembler, pod bundle source resolver, and PodRigInstantiator are now fully wired into the public route surface. Bundle create, inspect, and install all support schemaVersion 2. Legacy v1 bundles continue to work through the existing path.

---

## 7. Current HTTP / App Wiring State

The route layer is fully rebooted.

### Rebooted route surface

- `routes/rigspec.ts` — dual-format import/validate/preflight with auto-detection
- `routes/agents.ts` — `POST /api/agents/validate` for AgentSpec validation
- `routes/bundles.ts` — dual-format create/inspect/install (v1 + v2 bundles)
- `routes/up.ts` — handles pod-aware specs and bundles via bootstrap orchestrator
- `server.ts` — `podInstantiator` and `podBundleSourceResolver` in `AppDeps`
- `startup.ts` — constructs all rebooted services including `PodBundleSourceResolver`

### Legacy compatibility

Legacy routes remain functional for pre-reboot data. The dual-format detection pattern (`Array.isArray(raw.pods)`) routes pod-aware specs to the new engine and legacy specs to the existing path.

### CLI / UI cross-reference

This document focuses on the daemon architecture because that is where the reboot landed.

For file-by-file CLI and UI structure, use:
- [codemap.md](/Users/mschwarz/code/rigged/docs/as-built/codemap.md)

That codemap is the companion artifact for:
- CLI command/module layout
- UI route tree, shell, hooks, and component inventory
- exact source-file entrypoints across all three packages

---

## 8. Startup / Restore Rules

These are now core architectural rules, not incidental behavior.

### Startup file ordering

Effective startup is additive and ordered:
1. agent base
2. profile
3. rig culture file
4. rig startup
5. pod startup
6. member startup
7. operator debug append

No layer removes earlier files or actions.
No deduplication happens in the resolver.

### Restore policy narrowing

The narrowing direction is one-way:
- `resume_if_possible`
- `relaunch_fresh`
- `checkpoint_only`

Members may narrow the policy selected by the AgentSpec defaults/profile.
They may not broaden it.

### Import collision handling

Base/import collision:
- warning only
- base keeps the unqualified id
- import remains reachable through a qualified id

Import/import collision:
- unqualified reference is ambiguous
- profile resolution fails loudly
- qualified references remain valid

### Startup action constraints

Current v1 reboot constraints:
- no shell startup actions
- action types are `slash_command` and `send_text` only
- non-idempotent actions must not apply on restore
- retrying failed startup is handled as restore

### Restore replay constraints

Restore replay uses persisted startup context:
- classification-free projection intent
- resolved startup files with owner roots
- startup actions
- runtime

“Classification-free projection intent” is concrete:
- restore persists only the projection entry identity and source metadata:
  - category
  - effective id
  - source spec
  - source/resource paths
  - absolute source path
  - merge target / strategy
- restore does **not** persist `classification`, `conflicts`, or `noOps`
- on replay, every surviving entry is treated as projectable intent and the runtime adapter re-applies its own idempotency checks against the live filesystem

Missing optional artifacts become warnings.
Missing required startup files fail that node before startup replay begins.

### Session recency rule

Newest-session restore depends on monotonic ULIDs:
- `session-registry.ts` uses `monotonicFactory()` from `ulid`
- restore chooses the newest session by max ULID, not by second-resolution `created_at` alone
- this avoids restore selecting the wrong session when multiple sessions are created within the same timestamp bucket

---

## 9. Architecture Rules

1. Zero Hono in `domain/` and `adapters/`.
2. The route layer depends on the domain; the domain never depends on routes.
3. Shared DB handle invariants are enforced at construction time.
4. The reboot is engine-first: domain services land before route rewiring.
5. Runtime is member-authoritative in the pod-aware model.
6. Startup layering is additive and ordered.
7. Restore-policy narrowing is one-way only.
8. Ambiguous import/import references fail loudly; base/import collisions warn.
9. Bundle assembly and startup file resolution use containment checks rooted in the owning artifact.
10. Restore replay uses classification-free projection intent, not stale startup-time no-op/conflict classifications.
11. Startup status is explicit session state: `pending`, `ready`, `failed`.
12. Current readiness checking is still a single poll, not a retry loop.

---

## 10. Event System

The event union now includes reboot-specific signals in addition to the earlier rig/package/bootstrap/discovery events.

Reboot-era events currently emitted in production code:
- `node.startup_pending`
- `node.startup_ready`
- `node.startup_failed`

Reboot-era events present in the `RigEvent` union but not yet emitted by production code:
- `pod.created`
- `pod.deleted`
- `continuity.sync`
- `continuity.degraded`

The event system remains append-only and SQLite-backed.

---

## 11. Startup Sequence (`createDaemon`)

Current `startup.ts` now does more than the pre-reboot system:

1. Open SQLite and run all 15 migrations.
2. Construct legacy core services.
3. Construct legacy install/bootstrap/discovery services.
4. Construct rebooted startup execution services:
   - `StartupOrchestrator`
   - runtime adapters
   - `PodRigInstantiator`
5. Pass `podInstantiator` into `BootstrapOrchestrator`.
6. Build `AppDeps` and create the Hono app.

Important current limitation:
- `createDaemon()` already knows about the rebooted engine.
- `createApp()` and many routes still expose the older surface.

---

## 12. Test Infrastructure

### Audited in this branch

**Daemon**
- 1135 tests across 90 Vitest files.
- 90 test files in `packages/daemon/test`.

### Reboot-heavy test areas now present

- `agent-manifest.test.ts`
- `agent-resolver.test.ts`
- `profile-resolver.test.ts`
- `projection-planner.test.ts`
- `startup-resolver.test.ts`
- `startup-orchestrator.test.ts`
- `agentspec-startup.integration.test.ts`
- `pod-rigspec-instantiator.test.ts`
- `pod-bundle-assembler.test.ts`
- `bundle-source-resolver.test.ts` schema-version-2 coverage
- `rigspec-preflight.test.ts` rebooted preflight coverage
- `agentspec-restore.integration.test.ts`
- `pod-repository.test.ts`
- `spec-validation-service.test.ts`
- `agent-preflight.test.ts`

### Notes

- The daemon test count has materially grown since the pre-reboot as-built.
- CLI and UI file structure are tracked in [codemap.md](/Users/mschwarz/code/rigged/docs/as-built/codemap.md); this refresh did not re-audit a separate CLI/UI test total.

---

## 13. What Is Still Not Done

These are the most important outstanding gaps at current `HEAD`:

1. **Readiness polling is still a single check.**
   - No backoff/timeout loop yet.

2. **Remote import sources remain unsupported in the rebooted v1 constraints.**

3. **Startup actions remain intentionally constrained.**
   - No shell actions.

4. **Legacy compatibility seams still exist for pre-reboot data.**
   - The dual-format detection handles this transparently.
