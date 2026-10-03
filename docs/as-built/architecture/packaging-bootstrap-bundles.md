---
kind: as-built
title: Packaging, Bootstrap, Bundles, Legacy Install Engine
status: active
topics: [specification-and-bundles, release-and-versioning]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Locate npm package assembly, topology-bundle creation and validation,
  source routing, bootstrap plan/apply, or the retained package install engine.
siblings: [agent-spec-and-startup.md, plugin-agent-image-context-pack.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 254122872cf477511514979a4300b695d77cd1f7
last-updated: 2026-10-03
---

# Packaging, bootstrap and bundles

This module describes source at main commit
`254122872cf477511514979a4300b695d77cd1f7`. Source paths below are repository-relative.
An npm CLI artifact and a `.rigbundle` have different builders and consumers; neither
source verification nor archive integrity establishes that a daemon has adopted an artifact.

## npm CLI assembly

`scripts/build-package.sh` builds the daemon, web UI, TUI and CLI, then assembles their
outputs under `packages/cli`. The publishable file list and binary declarations live in
`packages/cli/package.json`.

The assembler writes generated `BUILD_INFO` modules into the daemon and CLI outputs with
the package version, Git commit, dirty flag and build time. The dirty check covers tracked
and untracked inputs under `packages/` and `scripts/`; it is not a whole-worktree status
claim.

The same script:

- Generates shipped context packs through `scripts/generate-context-packs.mjs`.
- Copies daemon output, assets, specs, context packs, policies and `docs/reference/`.
- Checks the specs staging input with `scripts/check-internal-leak-guard.mjs` and writes
  the staged substance-root inventory into the package.
- Copies the web UI and TUI outputs.
- Runs `scripts/rewrite-daemon-imports.mjs` so staged CLI/TUI JavaScript resolves the
  shipped daemon output rather than an unpublished workspace package.

This is the build layout. Native dependency installation and consumer runtime behavior need
their own checks; this document does not infer them from a successful assembly.

## Topology-bundle creation

`packages/daemon/src/routes/bundles.ts` mounts create, inspect, install and history handlers
under `/api/bundles` (the mount is in `packages/daemon/src/server.ts`).

The create handler validates the source spec before comparing it with recorded live topology.
A divergent spec is refused unless the request explicitly allows drift; an allowed divergence
is recorded in the bundle's provenance notes. The exported spec is not silently rewritten
from live state.

| Source shape | Builder and output |
|---|---|
| Pod-aware rig spec | `packages/daemon/src/domain/pod-bundle-assembler.ts`: `PodBundleAssembler.assemble()` produces schema-version-2 metadata, vendors resolved agent trees, and rewrites agent references to local paths. |
| Legacy rig spec | `packages/daemon/src/domain/bundle-assembler.ts`: `LegacyBundleAssembler` (imported as `BundleAssembler` by the route) collects the referenced legacy packages and produces the legacy manifest shape. |

The pod builder collects culture, docs and startup material, preserves file bytes and available
mode metadata, and skips vendoring the terminal sentinel as an agent. Required document
collection failures stop assembly; missing declared skills can instead produce warnings.
Inspect the builder's collection helpers when changing these distinctions.

Both route branches can consume a source-root `bundle.yaml` to carry declared skills,
plugins, workflow specs, context packs and agent images into staging before computing
integrity. Manifest types, validation and serialization are in
`packages/daemon/src/domain/bundle-types.ts`. Provenance and compatibility are metadata;
provenance is not an author signature.

### Archive checks

`packages/daemon/src/domain/bundle-archive.ts` owns `pack()` and `unpack()`;
`packages/daemon/src/domain/bundle-integrity.ts` owns the per-file integrity map.

Packing sorts entries, uses portable tar metadata and a fixed tar timestamp, and writes a
sibling SHA-256 file. Unpacking checks that digest, rejects archive links and unsafe entry
paths before extraction, requires `bundle.yaml` and its integrity section, and verifies
the extracted file inventory. Hashes establish consistency with the supplied manifest and
digest; they do not authenticate whoever supplied both.

The inspect handler unpacks through this same path before reporting the appropriate manifest
shape. A syntactically valid manifest alone is not an inspected archive.

## Source routing and bootstrap

`packages/daemon/src/domain/up-command-router.ts` classifies a source as
`rig_spec`, `rig_bundle`, `rig_name` or `topology`. It recognizes named rigs,
spec paths, `.rigbundle`, `.rigtopology`, and YAML with a top-level rigs list;
extensionless paths also have content detection.

`packages/daemon/src/routes/up.ts` then selects the execution path:

| Input | Consumer |
|---|---|
| Existing rig name | Existing-rig restore path. |
| Single rig spec or bundle | `BootstrapOrchestrator.bootstrap()` in `packages/daemon/src/domain/bootstrap-orchestrator.ts`. |
| Topology manifest | `MultiRigLauncher`, with a single-rig bootstrap or remote-up leaf per entry. |

Topology plan mode is rejected. Placement belongs on the individual topology entries; a
top-level host flag is rejected. The selected topology parser/route also rejects nested
topologies and existing-rig-name entries. This is narrower than the single-rig `up` surface.

Bootstrap distinguishes pod-aware and legacy specs, and inspects a bundle manifest to choose
`PodBundleSourceResolver` or `LegacyBundleSourceResolver` from
`packages/daemon/src/domain/bundle-source-resolver.ts`. Thus the router's
`rig_bundle` kind does not imply a legacy manifest.

For pod-aware specs, plan mode validates and runs preflight probes; apply delegates to
`PodRigInstantiator`. Plan mode still records a bootstrap run/result: it is not a pure
file read. Apply reports partial completion when nodes fail or require attention, preserving
the created rig identity rather than claiming every member launched.

### Durable install target

Bundle apply requires an explicit target root at the HTTP boundary. For a pod bundle,
`materializePodBundle()` copies the verified extraction into that durable root before
instantiation, so local agent references and relative working directories survive removal
of the extraction directory. It checks destination conflicts before copying, preserves
identical files, and refuses differing files or incompatible destination types.

Pod bundles containing service definitions are refused by bootstrap; their service path
requires a stable spec directory. Direct spec bootstrap has separate service prelaunch
handling. See [agent-spec-and-startup.md](agent-spec-and-startup.md) for instantiation.

## Install checks and content routing

The install handler in `packages/daemon/src/routes/bundles.ts` obtains a source-path
lock, reads validated metadata, checks compatibility, and checks a declared rig name
against the repository's rig list before bootstrap. The compatibility override
`skipVersionCheck` and name-conflict override `force` are explicit request fields.

`packages/daemon/src/domain/bundle-conflict-detector.ts` implements the rig-name check.
It is not a complete agent, port or filesystem collision audit; a missing rig name supplies
no name comparison. Target-file conflicts are handled separately by materialization.
Skipping these prechecks does not skip archive validation in bootstrap.

After a completed bundle install, the route separately unpacks and routes declared content:

| Manifest content | Destination selected by the route |
|---|---|
| `skills` | The OpenRig `packages` cache, stripping the legacy `packages/` prefix; this does not import a complete harness skill into the managed skill catalog. |
| `plugins` | The OpenRig `plugins` root, through local plugin references. |
| `workflow_specs` | `workflows/` beneath resolved `workspaceSpecsRoot`; unresolved settings skip this routing. |
| `context_packs` | The configured `context.root`, matching context-library discovery. |
| `agent_images` | The OpenRig `agent-images` root; declarations address image directories containing a manifest. |

The individual implementations are the `bundle-skills-router.ts`,
`bundle-plugins-router.ts`, `bundle-workflow-specs-router.ts`,
`bundle-context-packs-router.ts` and `bundle-agent-images-router.ts` files under
`packages/daemon/src/domain/`. The route treats these post-bootstrap calls as best effort:
their failure does not roll back or turn an already completed rig install into failure.
Inspect their returned results and warnings separately from bootstrap success.

Install audit records are appended best effort to `bundle-audit.jsonl` under the OpenRig
home; the history endpoint reads that audit. Bootstrap run state and action journals are
separate, repository-backed records.

## Legacy package install path

The legacy path remains executable, not just an archive parser.
`packages/daemon/src/routes/packages.ts` is mounted at `/api/packages`, and legacy
bootstrap calls `PackageInstallService` in
`packages/daemon/src/domain/package-install-service.ts`.

The source chain is package resolution/manifest validation, planning and conflict policy,
then apply/verification with repository records:

- `packages/daemon/src/domain/package-resolver.ts` and `package-manifest.ts`.
- `packages/daemon/src/domain/install-planner.ts`, `conflict-detector.ts` and
  `install-policy.ts`.
- `packages/daemon/src/domain/install-engine.ts`, `install-verifier.ts`,
  `install-repository.ts` and `package-repository.ts`.

Legacy bootstrap also probes requirements and records staged outcomes before rig
instantiation. A failed package installation prevents that path from importing the rig.
This compatibility implementation does not imply that pod-aware bundles use the same
package-install stages.

## Related maps

- [plugin-agent-image-context-pack.md](plugin-agent-image-context-pack.md): content library
  consumers and their state boundaries.
- [daemon-core.md](daemon-core.md): bootstrap construction and HTTP wiring.
- [agent-spec-and-startup.md](agent-spec-and-startup.md): spec resolution, projection and launch.
