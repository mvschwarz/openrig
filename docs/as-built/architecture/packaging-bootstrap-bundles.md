---
kind: as-built
title: Packaging, Bootstrap, Bundles, Legacy Install Engine
status: active
topics: [specification-and-bundles, release-and-versioning]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how rig/pod bundles are assembled (schema-version-2 vs legacy
  v1), how bundle create/inspect/install and /api/up route across source kinds,
  the staged BootstrapOrchestrator plan/apply flow, or which legacy install-
  engine seams still ship for pre-reboot data.
siblings: [agent-spec-and-startup.md, plugin-agent-image-context-pack.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Packaging, Bootstrap, Bundles, Legacy Install Engine

How OpenRig packages a topology into a shareable bundle and reconstitutes it
on another host. Fully dual-format: schema-version-2 pod bundles plus legacy
v1 artifacts, routed deterministically by the bootstrap orchestrator.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). Package version **0.3.1** (slice-00 §1.1). Source
> located by `architecture.md` headings (§5 Bundles/bootstrap/legacy
> compatibility, §6 Bundle create/inspect/install + /api/up, §11 Compat
> note 3) per slice-08 §10.1 — line numbers advisory only.

## 1. Bundle, bootstrap, legacy domain services

(`architecture.md` §5 "Bundles, bootstrap, and legacy compatibility")

- `pod-bundle-assembler.ts` — schema-version-2 bundle assembler.
  Re-confirmed: emits `schemaVersion: 2` (`pod-bundle-assembler.ts:167`).
- `bundle-types.ts` — v1 and v2 manifest types plus parse/validate/serialize.
  Re-confirmed: v2 `PodBundleManifest` type carries `schemaVersion: 2`
  (`:23`); `validatePodBundleManifest` rejects unless `schema_version === 2`
  (`:38`); `serializePodBundleManifest` writes `schema_version: 2` (`:62`);
  `parsePodBundleManifest` (`:87`); legacy path
  `validateLegacyBundleManifest` (`:143`) — both formats live in one file.
- `bundle-source-resolver.ts` — `LegacyBundleSourceResolver`
  (`bundle-source-resolver.ts:25`) plus `PodBundleSourceResolver` (`:132`).
- `bootstrap-orchestrator.ts` — staged bootstrap flow with direct pod-aware
  rig and v2 bundle delegation. `BootstrapMode = "plan" | "apply"`
  (`bootstrap-orchestrator.ts:26`).
- `up-command-router.ts` — spec/bundle source classification for `/api/up`.
  `SourceKind = "rig_spec" | "rig_bundle" | "rig_name"`
  (`up-command-router.ts:6`).

All re-confirmed present in `packages/daemon/src/domain/` @HEAD.

## 2. Bundle create / inspect / install

(`architecture.md` §6 "Bundle create / inspect / install")

`routes/bundles.ts` is fully dual-format:

- **create** — detects a pod-aware RigSpec and uses `PodBundleAssembler`
  (accepts an optional `rigRoot`); legacy create still uses
  `LegacyBundleAssembler`.
- **inspect** — safely extracts the archive, detects `schema_version`; v2
  returns `schemaVersion: 2`, `agents[]`, and integrity data; v1 returns the
  legacy manifest shape.
- **install** — uses the full bootstrap plan/apply; bootstrap peeks the
  manifest and routes deterministically to `pod_bundle` or `rig_bundle`.
  Re-confirmed at source: `bootstrap-orchestrator.ts:134-143` — when
  `sourceKind === "rig_bundle"` it unpacks to a temp peek dir, reads
  `bundle.yaml`, and calls `parsePodBundleManifest(...)` to detect the
  schema version before routing.

## 3. `/api/up` source routing

(`architecture.md` §6 "`/api/up`")

`UpCommandRouter` + `BootstrapOrchestrator` own:

- direct pod-aware rig specs,
- legacy rig specs,
- v1 bundle installs,
- v2 pod-bundle installs.

Plan mode and apply mode both work across those source kinds.

> Definitional note (carried, not a numeric drift) — `architecture.md` §6
> describes bootstrap routing to `pod_bundle` / `rig_bundle`. The
> `UpCommandRouter` *classification* enum is `SourceKind = "rig_spec" |
> "rig_bundle" | "rig_name"` (`up-command-router.ts:6`); the
> `pod_bundle`-vs-`rig_bundle` distinction is resolved one layer deeper in
> `bootstrap-orchestrator.ts` by peeking the manifest schema version
> (`:134-143`). Both statements are accurate at different layers; documented
> here so the layering is explicit rather than appearing contradictory.

## 4. Legacy install engine (still ships)

(`architecture.md` §5 "Legacy systems that still ship" + §11 compat note 3)

These pre-reboot seams remain active for backward compatibility:

- package install engine: `package-install-service.ts`,
  `package-manifest.ts`, `package-repository.ts`, `install-engine.ts`,
  `conflict-detector.ts`, `role-resolver.ts` (all re-confirmed present
  @HEAD).
- bootstrap and requirement-probe support.
- discovery and claim services.
- tmux/cmux adapters and resume adapters.

> Drift-check D-pkg — `architecture.md` §5/§6 carries no slice-00 numeric
> drift in this content; the v2 bundle-assembler + dual-format flows were
> verified accurate at HEAD (§1–§3 above). The footprint/migration counts
> that ARE stale land in `daemon-core.md`, not here.

Compat note 3 (carried verbatim, `architecture.md` §11): "Legacy
compatibility seams still ship for pre-reboot data and v1 artifacts." (The
full §11 list lives in `architecture-rules-and-event-system.md`.)

> Provenance note (carried, not asserted): `bootstrap-orchestrator.ts:3-5`
> still imports `LegacyRigSpec` / `LegacyRigSpecCodec` / `LegacyRigSpecSchema`
> with in-source `TODO: AS-T08b — migrate to pod-aware RigSpec` markers, and
> `:16` `TODO: AS-T12 — migrate to pod-aware bundle source resolver`. The
> legacy seam is intentional, in-progress migration scaffolding — recorded
> as-is, not smoothed.

## OPEN / carried items

- **D-pkg (resolved-as-current):** no slice-00 numeric drift in this
  module's split content; v2 assembler + dual-format flows verified accurate
  at HEAD. Bundle-routing layering documented explicitly to pre-empt an
  apparent §6-vs-source contradiction.
- Legacy-migration TODOs carried from source verbatim (AS-T08b / AS-T12).

## See also

- `agent-spec-and-startup.md` — `RigInstantiator` / `PodRigInstantiator` and
  the dual-format spec seam that bundles wrap.
- `plugin-agent-image-context-pack.md` — the 0.3.0/0.3.1 reusable
  starter-state / content-provenance cluster (authored separately in 8.4b).
- `daemon-core.md` — `/api/up` + `/api/bundles` are among the 49 route
  mounts; `BootstrapOrchestrator` is constructed in the createDaemon
  sequence.
- Source roots: `packages/daemon/src/domain/{pod-bundle-assembler,
  bundle-types,bundle-source-resolver,bootstrap-orchestrator,
  up-command-router}.ts`, `packages/daemon/src/routes/{bundles,up}.ts`.
