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
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Agent/Rig Spec, Resolution, Startup, Identity

How the daemon turns authored YAML specs into a resolved, projected, launched,
and identity-addressable topology. The spec-and-startup contract: parse →
resolve → project → deliver → launch → wait → persist replay context.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). Package version is **0.3.1** across all three
> packages (slice-00 §1.1). Source feed located by `architecture.md` headings
> (§4 Canonical Reboot Types, §5 Domain Services, §6 Execution Flows, §7
> Architecture Rules) per slice-08 §10.1 — line numbers are advisory only.

## 1. Canonical spec and topology types

(`architecture.md` §4 "Spec and topology")

- **AgentSpec** — parsed from `agent.yaml`. Owns imports, defaults, startup,
  resources, and profiles. Canonical parse/normalize/validate is
  `domain/agent-manifest.ts`.
- **RigSpec** — canonical pod-aware rig topology. Uses `version: "0.2"` and
  `pods[]`; owns cross-pod `edges[]`, rig-level startup overlays, and
  `cultureFile`.

  > Drift-fix D-spec-version — `architecture.md` §4 says RigSpec
  > "Uses `version: "0.2"`". This is the **spec-schema version, NOT the
  > package version** — a different versioning axis from the 0.3.1 package
  > version. The value is NOT a code constant: `rigspec-schema.ts:52`
  > validates `version` only as a "required non-empty string"
  > (`if (!obj["version"] || typeof obj["version"] !== "string")`); `:163`
  > carries it through as `raw["version"] as string`. `"0.2"` is the
  > canonical authored value, correctly described as a schema axis. Do NOT
  > "correct" it toward 0.3.1 (slice-08 §4.6 binding). Re-confirmed
  > `rigspec-schema.ts:52,163` @HEAD.

- **RigServicesSpec** — optional `services` block on a pod-aware RigSpec.
  Shipped kind is Compose-backed env management with `composeFile`,
  `projectName?`, `profiles?`, `downPolicy?`, `waitFor?`, `surfaces?`,
  `checkpoints?`.
- **RigSpecPod** — pod-local bounded context with `members[]`, pod-local
  `edges[]`, pod startup, optional continuity policy.
- **RigSpecPodMember** — member-level runtime/startup surface: `agentRef`,
  `profile`, `runtime`, `model?`, `cwd`, `restorePolicy?`, member startup
  overlays.
- **Pod** — persisted DB entity for a pod.
- **ContinuityState** — persisted live continuity row keyed by
  `podId + nodeId`.

## 2. Execution and projection types

(`architecture.md` §4 "Execution and restore" — restore/snapshot members are
detailed in `lifecycle-snapshot-restore.md`; the spec/projection members live
here)

- **ResolvedNodeConfig** — output of profile resolution. Carries effective
  runtime/model/cwd, narrowed restore policy, selected resources, layered
  startup block, resolved spec identity.
- **ProjectionPlan** — runtime projection plan for a node: runtime, cwd,
  projection entries, startup block, diagnostics, conflict/no-op
  classifications.
- **RuntimeAdapter** — the five-method contract (adapter detail in
  `adapters-and-runtimes.md`): `listInstalled(binding)`
  (`runtime-adapter.ts:131`), `project(plan, binding)` (`:134`),
  `deliverStartup(files, binding)` (`:137`), `launchHarness(binding, opts)`
  (`:147`), `checkReady(binding)` (`:153`). Re-confirmed @HEAD — the contract
  is current.
- **HarnessLaunchResult** — `{ ok, resumeToken?, resumeType?, error? }`
  returned by `launchHarness`.
- **StartupOrchestrator** — drives the full startup sequence (§4 below).

## 3. Parsing, validation, resolution pipeline

(`architecture.md` §5 "Parsing and validation" + "Resolution pipeline"; all
under `packages/daemon/src/domain/`, zero Hono imports per Architecture Rule 1)

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

All eleven files re-confirmed present in `packages/daemon/src/domain/` @HEAD.

## 4. Startup orchestration (the spec-startup contract)

(`architecture.md` §4 "StartupOrchestrator" + §5 "Startup, runtime, and
instantiation" + §7 Architecture Rule 6)

`StartupOrchestrator` (`domain/startup-orchestrator.ts`) drives:
mark pending → project resources → deliver pre-launch files → launch harness
→ wait for ready → deliver interactive files → execute actions → persist
context → mark ready.

**Pre-launch vs interactive delivery split** — the load-bearing seam,
re-confirmed at source:

- Pre-launch (filesystem, before harness boot): `guidance_merge`,
  `skill_install` (`startup-orchestrator.ts:78,167` — "Deliver pre-launch
  files (guidance_merge, skill_install → filesystem)").
- Post-launch (TUI, after harness is ready): `send_text`
  (`startup-orchestrator.ts:82,160,263` — partition by concrete hint at
  `:141`, deliver after readiness at `:263`).

The orchestrator persists replay context including the resume token for future
restores (consumed by `lifecycle-snapshot-restore.md`).

**Architecture Rule 6 — startup layering is additive and ordered** (carried
verbatim, `architecture.md` §7): (1) agent base, (2) profile, (3) rig culture
file, (4) rig startup, (5) pod startup, (6) member startup, (7) operator debug
append. This is the spec-startup contract's invariant; the full 25-rule list
lives in `architecture-rules-and-event-system.md`.

**Startup action constraints** (`architecture.md` §7 "Current startup action
constraints"): no shell startup actions; action types are `slash_command` and
`send_text` only; non-idempotent actions must not apply on restore; retrying
failed startup is handled as restore.

**Remote import constraints** (§7): the reboot supports `local:...` and
`path:/abs/...`. Remote `agent_ref` sources remain unsupported and fail in
preflight.

## 5. Instantiation, preflight, export

(`architecture.md` §5 "Startup, runtime, and instantiation" + §6 "RigSpec
import / validate / preflight / export")

- `runtime-adapter.ts` — adapter contract + bridge types.
- `rigspec-preflight.ts` — dual-stack legacy preflight plus rebooted
  `rigPreflight(...)`.
- `rigspec-instantiator.ts` — dual-stack `RigInstantiator` plus
  `PodRigInstantiator`.
- `rigspec-exporter.ts` — dual-format live rig export to YAML/JSON.
- `pod-repository.ts` — pod CRUD plus live continuity-state CRUD.

`routes/rigspec.ts` is the dual-format seam: validate
(pod-aware → `RigSpecSchema.validate`; legacy → `LegacyRigSpecSchema.validate`),
preflight (`rigPreflight({ rigSpecYaml, rigRoot, fsOps })` vs
`RigSpecPreflight.check(spec)`), import
(`podInstantiator.instantiate(yaml, rigRoot)` vs
`RigInstantiator.instantiate(spec)`), export (pod-aware exports canonical
`version: "0.2"` RigSpec; legacy exports flat-node v1).

## 6. Identity: whoami, materialize, bind, adopt

(`architecture.md` §6 "Whoami and adopted-session parity flow" +
"Materialize / bind / adopt flow")

**Whoami resolution** — the daemon owns the truth surface through
`/api/whoami` (`routes/whoami.ts`); tmux metadata is an adopted-session
anchor, not sovereign truth. `whoami-service.ts:8` declares
`resolvedBy: "node_id" | "session_name"`. The route requires `nodeId` or
`sessionName` (`routes/whoami.ts:10-15`). Resolution order:
explicit `--node-id` → explicit `--session` → env vars → tmux metadata →
raw tmux session-name fallback.

- Managed sessions prefer projected `OPENRIG_NODE_ID` /
  `OPENRIG_SESSION_NAME`.
- Adopted sessions use tmux-owned metadata written at claim/bind time.

  > Drift-nuance D5 (the careful axis — see also `transport-and-transcripts.md`):
  > the tmux metadata keys `@rigged_node_id` / `@rigged_session_name` /
  > `@rigged_rig_id` / `@rigged_rig_name` / `@rigged_logical_id` in
  > `architecture.md` §6 are **CORRECT as-is** and were verified literally at
  > source — `claim-service.ts:77-81` writes exactly these `@rigged_*` keys;
  > `claim-service.ts` and `rig-lifecycle-service.ts` read them. This is a
  > SEPARATE axis from MCP tool names (which are `rig_*`, slice-00 §1.4). Do
  > NOT blanket-replace `rigged` → `rig` (banked
  > `feedback_release_prep_three_layer_depersonalization`: the rename was
  > scoped, not global). The tmux metadata keys were NOT renamed.
  > Re-confirmed `claim-service.ts:77-81` @HEAD.

**Materialize / bind / adopt** (`architecture.md` §6): `POST
/api/rigs/import/materialize` creates a pod-aware topology without launching
sessions; `POST /api/discovery/:id/bind` attaches a discovered live session to
an existing logical node; `POST /api/discovery/:id/adopt` is the composite
route (bind to existing node, or create a new member in a target pod and bind
immediately). CLI mirrors via `rig bind` / `rig adopt`. Authored pod namespace
is preserved through adoption so logical ids stay
`${podNamespace}.${memberName}` (Architecture Rule 24: adopted-session parity
is tmux-metadata parity, not fake env-var parity).

## OPEN / carried items

- **D-spec-version (resolved-as-correct):** RigSpec `version: "0.2"` is the
  spec-schema axis, validated only as a non-empty string in source. Documented,
  not "corrected".
- **D5 (careful, resolved-as-correct for this module):** tmux `@rigged_*`
  metadata keys are literally still `@rigged_*` at HEAD — architecture.md §6 is
  accurate. The MCP-tool-name `rigged_*` drift lands in
  `transport-and-transcripts.md`.

## See also

- `daemon-core.md` — createDaemon wiring; the migration/route surface.
- `adapters-and-runtimes.md` — the five-method RuntimeAdapter contract detail.
- `lifecycle-snapshot-restore.md` — snapshot/restore consumes persisted replay
  context.
- `architecture-rules-and-event-system.md` — the full 25 architecture rules.
- Source roots: `packages/daemon/src/domain/{agent-manifest,rigspec-schema,
  profile-resolver,startup-orchestrator,whoami-service,claim-service}.ts`,
  `packages/daemon/src/routes/{rigspec,whoami}.ts`.
