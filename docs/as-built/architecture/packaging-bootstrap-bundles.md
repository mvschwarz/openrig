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
last-verified-against-source: 82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d
last-updated: 2026-10-05
---

# Packaging, bootstrap and bundles

This module describes source at main commit
`82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d`. Source paths below are repository-relative.
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

The pod builder collects culture, docs and startup material, preserves file bytes, and skips
vendoring the terminal sentinel as an agent. A copied file keeps its source mode with owner
read and write added. Required document collection failures stop assembly; missing declared
skills can instead produce warnings, which are also written into the provenance notes.
Inspect the builder's collection helpers when changing these distinctions.

Both route branches can consume a source-root `bundle.yaml` to carry declared skills,
plugins, workflow specs, context packs, agent images and preconditions into staging before
computing integrity. Manifest types, validation and serialization are in
`packages/daemon/src/domain/bundle-types.ts`. Provenance and compatibility are metadata;
provenance is not an author signature.

Preconditions are carried as data. Commands containing shell operators produce a warning,
inspect reports the block, and the behaviour view lists it under needs. The install and
bootstrap code do not reference preconditions.

Two more inputs are accepted only for a pod-aware spec; the legacy branch refuses them with
a 400:

- `--context-pack <dir>` (`vendorContextPackDir()` in
  `packages/daemon/src/domain/bundle-carried-context-pack.ts`) carries a pack's
  `manifest.yaml` and its declared files to `context-packs/<manifest name>/`. The pack may
  sit outside the rig folder.
- `--project-dir <dir>` (`vendorProjectDir()` in
  `packages/daemon/src/domain/bundle-carried-project.ts`) carries a folder with a
  `project.yaml` to `project/`.

Create also refuses content it must not ship. `computeIntegrity()` in
`packages/daemon/src/domain/bundle-integrity.ts` throws on sensitive paths (`.env` files,
`*.pem`, `*.key`, `*.p12`, `credentials.*`, `tokens.*`, `.git/` and `node_modules/`).
`assertShippableSubstance()` in `packages/daemon/src/domain/agent-resolver.ts` runs on
vendored content and on the final staging tree, and refuses text containing
`substrate/shared-docs/` and files declaring `taxonomy: lore`.

### Configurations and package identity

A bundle folder may declare alternate team configurations in `configurations.yaml` beside
`rig.yaml` (`packages/cli/src/lib/bundle-configuration.ts`). `rig bundle configurations
<spec>` lists them. `rig bundle create --preset <name>` or `--seat <member=runtime>` resolves
one and stages a copy of the rig folder in a temporary directory with the chosen runtimes and
profiles, so the author's folder is never changed.

`packages/daemon/src/domain/bundle-identity.ts` defines the two identity values:

- `configurationId()`: every member's `pod.member=runtime`, sorted and joined with `,`.
  Create computes it from the normalized spec and returns a 400 if the client sent a
  different one.
- `packageDigest()`: SHA-256 over the sorted `integrity.files` entries (coverage label
  `openrig.package-digest/v1`). It covers every packaged file's bytes; it does not cover
  `bundle.yaml`, the junk files the integrity walk skips, or file modes.

Create and inspect responses carry the source, configuration ID, package digest, archive
hash and assembler version.

### Archive checks

`packages/daemon/src/domain/bundle-archive.ts` owns `pack()` and `unpack()`;
`packages/daemon/src/domain/bundle-integrity.ts` owns the per-file integrity map.

Packing requires a `.rigbundle` output path, sorts entries, uses portable tar metadata, a
fixed tar timestamp and gzip level 9, and writes a sibling SHA-256 file. Unpacking checks that
digest, rejects archive links and unsafe entry paths before extraction, requires
`bundle.yaml` and its integrity section, and verifies the extracted file inventory. Hashes
establish consistency with the supplied manifest and digest; they do not authenticate
whoever supplied both.

The inspect handler does not call `unpack()`, because it must report a broken bundle rather
than refuse it. It reports a missing or mismatched digest as `digestValid: false`, applies the
same unsafe-entry pre-scan (`collectUnsafeArchiveEntries()`) and extraction filter, and runs
`verifyIntegrity()` to report an `integrityResult`. A syntactically valid manifest alone is
not an inspected archive.

Inspect also returns a behaviour view, `describeBundleBehaviour()` in
`packages/daemon/src/domain/bundle-behaviour.ts` (schema `openrig.bundle-behaviour/v1`). It
reads the extracted archive only, through `bundle-behaviour-inspect.ts` (regular UTF-8 files,
at most 1 MiB each and 8 MiB in total, opened without following links). It lists the team,
each seat's permission posture, the files seats are told to read, what else runs, where
content is written, literal outside addresses, needs, and what can't be known before launch.
A schema-1 archive gets `state: not_generated`. Posture comes from the member's or rig's
`permission_policy`: `builtin:yolo` is full bypass and `builtin:auto` is auto, both by launch
flag; `builtin:locked`, `builtin:standard` and `builtin:open` are configuration; a policy file
is read from the archive or marked unresolved; no policy means the product default. The CLI
prints the view before `rig bundle install` and `rig up` as diagnostics only; it never changes
the request or the exit code.

## Source routing and bootstrap

`packages/daemon/src/domain/up-command-router.ts` classifies a source as
`rig_spec`, `rig_bundle`, `rig_name` or `topology`. It recognizes named rigs,
spec paths, `.rigbundle`, `.rigtopology`, and YAML with a top-level rigs list;
extensionless paths also have content detection.

`packages/daemon/src/routes/up.ts` then selects the execution path:

| Input | Consumer |
|---|---|
| Existing rig name | Existing-rig restore path; unarchived rigs of that name are preferred. |
| Single rig spec or bundle | `BootstrapOrchestrator.bootstrap()` in `packages/daemon/src/domain/bootstrap-orchestrator.ts`. |
| Topology manifest | `MultiRigLauncher`, with a single-rig bootstrap or remote-up leaf per entry. |

Topology plan mode is rejected. Placement belongs on the individual topology entries; a
top-level host flag is rejected. The selected topology parser/route also rejects nested
topologies, existing-rig-name entries and `.rigbundle` entries: topology entries are spec
paths only. This is narrower than the single-rig `up` surface.

Bootstrap distinguishes pod-aware and legacy specs, and inspects a bundle manifest to choose
`PodBundleSourceResolver` or `LegacyBundleSourceResolver` from
`packages/daemon/src/domain/bundle-source-resolver.ts`. Thus the router's
`rig_bundle` kind does not imply a legacy manifest.

For pod-aware specs, plan mode validates and runs preflight probes; apply delegates to
`PodRigInstantiator`. Plan mode still records a bootstrap run/result: it is not a pure
file read. Apply reports partial completion when nodes fail or require attention, preserving
the created rig identity rather than claiming every member launched.

### Durable install target

Bundle apply requires an explicit target root at the HTTP boundary. The CLI supplies the
current directory as the default for `rig up <file>.rigbundle` and for a GitHub link through
`rig up` or `rig bundle install`. `rig bundle install` with a local `.rigbundle` sends no
default, so apply without `--target` gets a 400. For a pod bundle,
`materializePodBundle()` copies the verified extraction into that durable root before
instantiation, so local agent references and relative working directories survive removal
of the extraction directory. It checks destination conflicts before copying, preserves
identical files, and refuses differing files or incompatible destination types.

Pod bundles containing service definitions are refused by bootstrap; their service path
requires a stable spec directory. Direct spec bootstrap has separate service prelaunch
handling. See [agent-spec-and-startup.md](agent-spec-and-startup.md) for instantiation.

## GitHub folder links and the bundle check

`packages/cli/src/lib/bundle-source.ts` lets `rig up`, `rig bundle create`, `inspect` and
`install` take a GitHub folder link (`isGitHubBundleLink()`). Only a credential-free
`https://github.com/owner/repo[/tree/<ref>/<folder>]` link is accepted. The ref is resolved to
the longest matching branch or tag, or taken as a full commit hash. The import:

- needs a healthy local daemon whose `selfHostId` matches the local origin;
- runs Git with credential helpers, hooks and non-HTTPS protocols disabled;
- shallow-fetches the exact commit into `bundle-imports/` under the OpenRig home, requires a
  `rig.yaml` in the folder, and refuses symlinks or agent and package references that resolve
  outside the checkout;
- posts the folder to `/api/bundles/create` with the source recorded in provenance, refuses a
  response without a package digest or with a different source commit, and writes
  `source.json` and `build.json` in the import folder.

`rig bundle check <folder>` (`checkBundleFolder()` in `packages/cli/src/lib/bundle-check.ts`)
is an advisory, file-read-only check against `openrig.bundle-standard/v1`; it makes no daemon,
launch or provider call. Its rules are `pod_aware_rig`, `readme_in_docs`, `referenced_files`,
`portable_agents`, `minimum_versions`, `configurations` and `credential_paths` (a filename scan
bounded at 10,000 entries that skips `.git`, `node_modules` and symlinks). `readme_coverage`
and `embedded_secrets` are always reported as not checked, and host-resolved resources are
reported as checked at launch (`host_resources`). Any finding sets exit code 1.

## Install checks and content routing

The install handler in `packages/daemon/src/routes/bundles.ts` obtains a source-path
lock, reads validated metadata, checks compatibility, and checks a declared rig name
against the repository's rig list before bootstrap. The compatibility override
`skipVersionCheck` and name-conflict override `force` are explicit request fields.

`packages/daemon/src/domain/bundle-conflict-detector.ts` implements the rig-name check.
It is not a complete agent, port or filesystem collision audit; a missing rig name supplies
no name comparison. Target-file conflicts are handled separately by materialization.
Skipping these prechecks does not skip archive validation in bootstrap.

Declared content is routed by `routeBundleContents()` in
`packages/daemon/src/domain/bundle-content-routing.ts`, which unpacks the bundle once and
routes each kind independently. When it runs depends on the bundle schema:

- **Pod-aware (schema 2):** bootstrap runs it as `PodRigInstantiator`'s prelaunch hook, after
  the rig record exists and before any seat launches, so every seat's first turn can see the
  content.
- **Legacy (schema 1):** there is no hook, so the install route routes after bootstrap, and
  only when the status is `completed`.

| Manifest content | Destination |
|---|---|
| `skills` | The OpenRig `packages` cache, stripping the legacy `packages/` prefix; this does not import a complete harness skill into the managed skill catalog. |
| `plugins` | The OpenRig `plugins` root, through local plugin references. |
| `workflow_specs` | `workflows/` beneath the resolved `workspaceSpecsRoot`. If that setting is empty, this kind is recorded as a routing failure. |
| `context_packs` | The configured `context.root`, matching context-library discovery. |
| `agent_images` | The OpenRig `agent-images` root; declarations address image directories containing a manifest. |
| `project` | Registered in the workspace catalog (`workspace.catalog_path`) with the rig associated, and its files placed under `workspace.projects_root/<id>` (`registerBundleProject()` in `packages/daemon/src/domain/workspace/project-registration.ts`). A conflict changes nothing and is a routing failure. |

Context packs are never merged into an installed pack of the same name: an identical one is
reported as `already_installed`, a different one is kept unchanged as `kept_existing`. After
routing, the live context library rescans, and a routed pack it can't load becomes a routing
failure.

The per-kind implementations are the `bundle-skills-router.ts`, `bundle-plugins-router.ts`,
`bundle-workflow-specs-router.ts`, `bundle-context-packs-router.ts` and
`bundle-agent-images-router.ts` files under `packages/daemon/src/domain/`. Routing is best
effort in both cases: the hook always lets the launch continue, and a failure never rolls back
or fails the install. Failures appear in the result's `routingFailures` and `warnings`, in a
`route_bundle_contents` stage for the hook, and in the install audit record.

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

- `resolvePackage()` in `packages/daemon/src/domain/package-resolve-helper.ts`, which reads
  and validates through `package-manifest.ts`. `package-resolver.ts` supplies the types; its
  `PackageResolver` class has no production caller.
- `packages/daemon/src/domain/install-planner.ts`, `conflict-detector.ts` and
  `install-policy.ts`. The planner refuses any planned destination outside the install
  target.
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
