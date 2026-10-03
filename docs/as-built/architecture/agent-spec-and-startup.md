---
kind: as-built
title: Agent/Rig Spec, Resolution, Startup, Identity
status: active
topics: [specification-and-bundles, agent-runtime]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know the canonical AgentSpec/RigSpec/pod-aware reboot types, how
  profile resolution and additive startup layering work, the StartupOrchestrator
  pre-launch-vs-interactive delivery split, or how whoami/materialize/bind/adopt
  resolve and preserve identity.
siblings: [daemon-core.md, adapters-and-runtimes.md, lifecycle-snapshot-restore.md, packaging-bootstrap-bundles.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: b6d37bfadcc189be8fd61e35abfc09676437bf48
last-updated: 2026-10-03
---

# Agent/Rig Spec, Resolution, Startup, Identity

How the daemon turns authored YAML specs into a resolved, projected, launched,
and identity-addressable topology. The spec-and-startup contract: parse →
resolve → project → deliver pre-launch files → persist replay context → launch
→ wait → deliver post-launch files.

> Verified against source at main `b6d37bfadcc189be8fd61e35abfc09676437bf48`. `domain/…` and `routes/…` paths
> are under `packages/daemon/src/`; a bare file name such as
> `rigspec-schema.ts:115` is in `packages/daemon/src/domain/`. Each count sits
> beside the command that produces it; run the command from the repository
> root to refresh it.

## 1. Canonical spec and topology types

- **AgentSpec** (`types.ts:938`) — parsed from `agent.yaml`
  (`agent-resolver.ts:150`). Owns imports, defaults, startup, resources, and
  profiles. Canonical parse/normalize/validate is `domain/agent-manifest.ts`.
- **RigSpec** (`types.ts:1169`) — canonical pod-aware rig topology. Uses
  `version: "0.2"` and `pods[]`; owns cross-pod `edges[]`, rig-level startup
  overlays, and `cultureFile`, plus the optional `summary`, `permissionPolicy`,
  `managedBlocks`, `docs`, `services` and `workspace` fields.

  `version` is the spec-schema version, not the package version. It is not a
  code constant: `RigSpecSchema.validate` requires only a non-empty string
  (`rigspec-schema.ts:115`) and `RigSpecSchema.normalize` carries the authored
  value through (`rigspec-schema.ts:243`). `"0.2"` is the canonical authored
  value, and the pod-aware exporter writes it (`rigspec-exporter.ts:223`).

- **RigServicesSpec** (`types.ts:1216`) — optional `services` block on a
  pod-aware RigSpec. Shipped kind is Compose-backed env management
  (`kind: "compose"`) with `composeFile`, `projectName?`, `profiles?`,
  `downPolicy?`, `waitFor?`, `surfaces?`, `checkpoints?`.
- **RigSpecPod** (`types.ts:1125`) — pod-local bounded context with
  `members[]`, pod-local `edges[]`, pod startup, optional continuity policy.
- **RigSpecPodMember** (`types.ts:1069`) — member-level runtime/startup
  surface: `agentRef`, `profile`, `runtime`, `model?`, `effort?`, `cwd`, `restorePolicy?`,
  member startup overlays (`startup?`), plus `label?`, `codexConfigProfile?`,
  `role?`, `permissionPolicy?`, `compactionStrategy?`, `mechanic?`,
  `sessionSource?` and `starterRef?`.
- **Pod** (`types.ts:8`) — persisted DB entity for a pod.
- **ContinuityState** (`types.ts:18`) — persisted live continuity row keyed by
  `podId + nodeId` (`PRIMARY KEY (pod_id, node_id)`,
  `packages/daemon/src/db/migrations/014_agentspec_reboot.ts:24`).

## 2. Execution and projection types

Restore/snapshot types are detailed in `lifecycle-snapshot-restore.md`; the
spec/projection types live here.

- **ResolvedNodeConfig** (`profile-resolver.ts:31`) — output of profile
  resolution. Carries effective runtime/model/effort/cwd, narrowed restore policy,
  selected resources, layered startup block, resolved spec identity.
- **ProjectionPlan** (`projection-planner.ts:41`) — runtime projection plan for
  a node: runtime, cwd, projection entries, startup block, diagnostics,
  conflict/no-op classifications.
- **RuntimeAdapter** (`runtime-adapter.ts:134`) — the five-method contract
  (adapter detail in `adapters-and-runtimes.md`): `listInstalled(binding)`
  (`runtime-adapter.ts:144`), `project(plan, binding)` (`:147`),
  `deliverStartup(files, binding)` (`:150`), `launchHarness(binding, opts)`
  (`:160`), `checkReady(binding)` (`:166`). The interface also declares one
  optional method, `skillTargetPath?(...)` (`:141`). Required methods: **5**
  (`sed -n '/^export interface RuntimeAdapter /,/^}/p' packages/daemon/src/domain/runtime-adapter.ts | grep -c -E '^  [a-zA-Z]+\('`).
- **HarnessLaunchResult** (`runtime-adapter.ts:88`) — returned by
  `launchHarness`: either `{ ok: true, resumeToken?, resumeType?,
  appliedLaunch? }` or `{ ok: false, error, recovery?, evidence? }`, where
  `recovery` is `"retry_fresh"` or `"attention_required"` (`:86`).
- **StartupOrchestrator** (`startup-orchestrator.ts:107`) — drives the full
  startup sequence (§4 below).

## 3. Parsing, validation, resolution pipeline

All of the files below are under `packages/daemon/src/domain/`, and none of
them imports Hono: **0**
(`git grep -l '"hono' -- packages/daemon/src/domain/{agent-manifest,rigspec-schema,rigspec-codec,startup-validation,path-safety,spec-validation-service,spec-review-service,agent-resolver,agent-preflight,profile-resolver,startup-resolver,projection-planner}.ts | wc -l`).

**Parse / validate:**

- `agent-manifest.ts` — canonical AgentSpec parse/normalize/validate.
- `rigspec-schema.ts` — dual-format RigSpec validation.
- `rigspec-codec.ts` — dual-format YAML codec.
- `startup-validation.ts` — shared startup-block validation.
- `path-safety.ts` — shared relative-path safety checks.
- `spec-validation-service.ts` — pure raw-YAML validation helpers.
- `spec-review-service.ts` — daemon-owned structured review model for
  RigSpec/AgentSpec YAML, incl. topology preview, provenance state, managed-app
  services metadata (`waitFor`, `surfaces`, `composePreview`).

**Resolve:**

- `agent-resolver.ts` — resolves `agent_ref`, imports, collision metadata.
- `agent-preflight.ts` — single-agent resolution/preflight.
- `profile-resolver.ts` — applies defaults, profile uses, resource selection,
  startup layering, restore-policy narrowing.
- `startup-resolver.ts` — additive startup layering.
- `projection-planner.ts` — runtime resource projection planning.

## 4. Startup orchestration (the spec-startup contract)

`StartupOrchestrator.startNode` (`startup-orchestrator.ts:129`) drives, in
source order: mark pending (`:156`) → project resources (`:167`) → deliver
pre-launch files (`:207`) → persist startup context (`:222`) → launch harness,
recording any resume token (`:237`) → wait for ready (`:322`) → deliver
interactive files (`:403`) → execute `after_files` then `after_ready` actions
(`:426`, `:432`) → mark ready (`:466`). The class doc comment
(`startup-orchestrator.ts:90`–`101`) still lists persistence as step 9, after
the actions; the code persists the startup context before the harness launch.

**Pre-launch vs interactive delivery split** — the load-bearing seam:

- Pre-launch (filesystem, before harness boot): `guidance_merge`,
  `skill_install` (`startup-orchestrator.ts:93` — "Deliver pre-launch files
  (guidance_merge, skill_install → filesystem)"; delivered at `:207`).
- Post-launch (TUI, after harness is ready): `send_text`
  (`startup-orchestrator.ts:97`; partition by concrete hint at `:182`,
  `send_text` files held for post-launch at `:200`, delivered after readiness
  at `:403`).

The orchestrator persists replay context for future restores (consumed by
`lifecycle-snapshot-restore.md`): the projection entries, resolved startup
files and startup actions go to `node_startup_context`
(`startup-orchestrator.ts:225`), and a resume token returned by the launch is
written to the session row (`updateResumeToken`, `:254`).

**Startup layering is additive and ordered** (`resolveStartup`,
`startup-resolver.ts:15`–`22`): (1) agent base, (2) profile, (3) rig culture
file, (4) rig startup, (5) pod startup, (6) member startup, (7) operator debug
append. Files and actions are concatenated in that order with no
deduplication (`startup-resolver.ts:24`). This is the spec-startup contract's
invariant; the cross-cutting architecture rules are collected in
`architecture-rules-and-event-system.md`.

**Startup action constraints** (`startup-validation.ts`): no shell startup
actions (`:65`); action types are `slash_command`, `send_text` and
`startup_proof` (`:7`); non-idempotent actions must not apply on restore
(`:100`). Retrying a failed startup is handled as a restore, which is why the
orchestrator skips non-idempotent actions on restore
(`startup-orchestrator.ts:556`, "retry-as-restore safety"). The exception is
`PodRigInstantiator.retryFirstStart` (`rigspec-instantiator.ts:1146`), which
re-runs a first start that failed at projection, before any harness launch.

**Remote import constraints**: `agent_ref` and AgentSpec imports accept
`local:<relative path>` and `path:<absolute path>` only
(`rigspec-schema.ts:41`, `agent-manifest.ts:40`); a terminal member uses the
`builtin:terminal` sentinel (`rigspec-schema.ts:519`). Remote `agent_ref`
sources remain unsupported: RigSpec validation rejects them
(`rigspec-schema.ts:550`), `rigPreflight` runs that validation
(`rigspec-preflight.ts:249`), and the resolver refuses a remote import again
(`agent-resolver.ts:203`).

## 5. Instantiation, preflight, export

- `runtime-adapter.ts` — adapter contract + bridge types.
- `rigspec-preflight.ts` — dual-stack legacy preflight (`RigSpecPreflight`,
  `rigspec-preflight.ts:25`) plus rebooted `rigPreflight(...)` (`:241`).
- `rigspec-instantiator.ts` — dual-stack `RigInstantiator`
  (`rigspec-instantiator.ts:33`) plus `PodRigInstantiator` (`:474`).
- `rigspec-exporter.ts` — dual-format live rig export to YAML/JSON.
- `pod-repository.ts` — pod CRUD plus live continuity-state CRUD.

`routes/rigspec.ts` is the dual-format seam; a parsed spec with a `pods` array
takes the pod-aware path (`routes/rigspec.ts:83`): validate
(pod-aware → `RigSpecSchema.validate`; legacy → `LegacyRigSpecSchema.validate`),
preflight (`rigPreflight({ rigSpecYaml, rigRoot, … })` vs
`RigSpecPreflight.check(spec)`), import
(`podInstantiator.instantiate(yaml, rigRoot, …)` vs
`RigInstantiator.instantiate(spec)`), export (pod-aware exports canonical
`version: "0.2"` RigSpec; legacy exports flat-node `schemaVersion: 1`,
`rigspec-exporter.ts:105`).

The import validation route delegates to `validateRigSpecImport`
(`routes/rigspec.ts:214–222`, `spec-validation-service.ts:10–19`). The same
helper powers local `rig spec validate` without contacting the daemon
(`packages/cli/src/commands/rig.ts:204–207`); it selects the pod-aware or legacy
validator and distinguishes YAML parse failures from validator exceptions.

## 6. Identity: whoami, materialize, bind, adopt

**Whoami resolution** — the daemon owns the truth surface through
`/api/whoami` (`routes/whoami.ts`); tmux metadata is an adopted-session
anchor, not sovereign truth. `whoami-service.ts:8` declares
`resolvedBy: "node_id" | "session_name"`. The route requires `nodeId` or
`sessionName` (`routes/whoami.ts:19`–`23`). The CLI resolves identity
(`packages/cli/src/commands/whoami.ts:142`–`148`) in this order: explicit
`--node-id` → explicit `--session` → env vars → tmux metadata → raw tmux
session-name fallback.

- Managed sessions prefer projected `OPENRIG_NODE_ID` /
  `OPENRIG_SESSION_NAME`, set when the tmux session is created
  (`node-launcher.ts:143`–`144`).
- Adopted sessions use tmux-owned metadata written at bind time.

  The tmux metadata keys use the `@rigged_` prefix:
  `ClaimService.setRiggedMetadata` writes `@rigged_node_id` /
  `@rigged_session_name` / `@rigged_rig_id` / `@rigged_rig_name` /
  `@rigged_logical_id` (`claim-service.ts:180`–`184`), called from `bind`,
  `reconcileSession` and `createAndBindToPod`;
  `RigLifecycleService.unclaimSession` clears the same five keys
  (`rig-lifecycle-service.ts:209`–`213`); and `rig whoami` reads
  `@rigged_node_id` and `@rigged_session_name`
  (`packages/cli/src/commands/whoami.ts:173`, `:179`). MCP tool names use a
  different prefix, `rig_*` (`packages/cli/src/mcp-server.ts`).

**Materialize / bind / adopt**: `POST /api/rigs/import/materialize`
(`routes/rigspec.ts:174`) creates a pod-aware topology without launching
sessions and refuses a legacy spec (`routes/rigspec.ts:187`);
`POST /api/discovery/:id/bind` (`routes/discovery.ts:77`) attaches a
discovered live session to an existing logical node (`logicalId`), or creates
a member in a pod (`podNamespace` + `memberName`) and binds it;
`POST /api/discovery/:id/adopt` (`routes/discovery.ts:139`) is the composite
route (bind to existing node, or create a new member in a target pod and bind
immediately). On the CLI, `rig bind` calls the bind route
(`packages/cli/src/commands/bind.ts:56`), and `rig adopt` materializes the
topology and then calls the bind route for each session
(`packages/cli/src/commands/adopt.ts:163`, `:212`). Authored pod namespace is
preserved through adoption so logical ids stay `${podNamespace}.${memberName}`
(`claim-service.ts:661`). Adopted-session parity is tmux-metadata parity, not
fake env-var parity.

## See also

- `daemon-core.md` — createDaemon wiring; the migration/route surface.
- `adapters-and-runtimes.md` — the five-method RuntimeAdapter contract detail.
- `lifecycle-snapshot-restore.md` — snapshot/restore consumes persisted replay
  context.
- `architecture-rules-and-event-system.md` — the cross-cutting architecture
  rules.
- Source roots: `packages/daemon/src/domain/{agent-manifest,rigspec-schema,
  profile-resolver,startup-orchestrator,whoami-service,claim-service}.ts`,
  `packages/daemon/src/routes/{rigspec,whoami}.ts`.
