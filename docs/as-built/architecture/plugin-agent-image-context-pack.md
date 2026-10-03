---
kind: as-built
title: Content Layer — Plugins, Agent Images, Context Packs, Compaction Policy
status: active
topics: [extension-and-user-workspace, continuity, skill-management]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Locate plugin discovery and vendoring, context-pack addressing/composition,
  agent-image capture/fork/protection, or Claude guided-compaction behavior.
siblings: [packaging-bootstrap-bundles.md, agent-spec-and-startup.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 712a61fbcc5ffe5a7c786fea12132567083ab507
last-updated: 2026-10-02
---

# Content libraries and compaction

This module describes source at main commit
`712a61fbcc5ffe5a7c786fea12132567083ab507`. Source paths below are repository-relative.
Context packs, plugins and agent images have filesystem-backed content and daemon-side
discovery. Their consumers can read database identity, mutate files, deliver messages or
launch sessions; the whole layer is not a read-only catalog.

## Context packs

`packages/daemon/src/domain/context-packs/context-pack-library-service.ts` implements
`ContextPackLibraryService`. A pack contains `manifest.yaml` and declared members.
Its path-like ref is the lookup identity, independently of the manifest name/version;
the entry ID is `context-pack:<ref>`.

### Discovery and mutation

Startup in `packages/daemon/src/startup.ts` configures the shipped context-pack root,
the resolved `context.root` and its system root, followed by an existing workspace-local
`.openrig/context-packs` root. The library scans recursively, stops descending when it
finds a pack manifest, and does not follow directory symlinks.

The first configured root to encounter a physical pack owns that directory. For distinct
physical packs with the same ref, the later root wins. This distinction prevents overlapping
roots from giving the same physical pack a second address. Scan replaces the in-memory ref
index and reports malformed packs instead of indexing them.

`composeFromFiles()` creates a durable pack after validating its ref, destination and
sources. `removeByRef()` removes the selected pack directory and rescans, but refuses
shipped builtin packs. Library mutation and lookup share ref validation.

`packages/daemon/src/domain/context-packs/manifest-parser.ts` parses manifests.
Its supported file suffixes include Markdown/YAML/text and `.sh`, `.ts`, `.mjs`,
`.py` helper assets. Those assets are served as text; pack assembly does not execute them.
The parser also validates atom metadata and named profiles.

### Assembly, addresses and profiles

These are separate projections:

| Operation | Source and behavior |
|---|---|
| Framed pack preview | `packages/daemon/src/domain/context-packs/bundle-assembler.ts`, `assembleBundle()`: pack/file headers, file metadata, token estimates and `missingFiles`. Missing members are reported and skipped; a failed read of a present member raises an error. |
| Plain file composition | The same file's `assemblePlainFiles()`: present files in declared order, separated by two newlines, without framing or trimming their bytes. |
| Addressed read | `packages/daemon/src/routes/context-packs.ts`, `/library/resolve-address`: longest matching pack-ref prefix, a declared file, then optional H2/H3 heading selection through `packages/daemon/src/domain/markdown-address.ts`. |
| Situation profile | `packages/daemon/src/domain/context-packs/profile-composer.ts`, `composeProfile()`: select atoms, close dependencies, order and resolve each piece. |
| Named profile | The same file's `composeNamedProfile()`: declared phases select atoms or supplied work/seat context, preserving phase IDs in the result. |

Situation composition selects fresh atoms for `fresh`, fresh plus handover atoms for
`handover`, and post-compaction plus handover atoms for `post-compaction`. Runtime
selection is Claude or Codex, with `any` atoms applicable to either. Required atoms join
the selection; missing dependencies or runtime-incompatible dependencies fail composition.
The output is ordered by atom order, then ID. Profile-only atoms are excluded from ordinary
situation selection.

The profile route resolves configured tree sources through
`packages/daemon/src/domain/context-packs/profile-source-resolver.ts`.
Seat context requires explicit rig and seat selectors. Mission/slice selectors and named
profile context requirements are validated before reading those trees. The default
project/mission/slice walk is bounded to the conventional single-project workspace layout
and fresh situation; it is not an arbitrary project-catalog resolver.

Each resolved piece names its address/source and reports estimated tokens. A token budget
reports overage and drop candidates without silently truncating the profile. Atom
`regions` are metadata; the profile endpoint has no region-subset selector.

### HTTP and CLI boundaries

`packages/daemon/src/server.ts` mounts `contextPacksRoutes()` at
`/api/context-packs`. Its library handlers cover list, sync, compose, read/delete by ref,
preview, pieces, addressed reads and profile composition.

`packages/cli/src/commands/context.ts` implements `rig context`, including
`get`, `profile`, `compose`, `add`, `rm` and `sync`, plus work-install,
trace, source and recap operations. The library read/compose routes do not themselves send
a pack to a running seat. Delivery and installation consumers have their own behavior;
inspect the selected CLI verb before treating a context command as read-only.

## Agent images and forks

`packages/daemon/src/domain/agent-images/agent-image-library-service.ts` implements
`AgentImageLibraryService`. Startup registers the OpenRig `agent-images` root and,
when present, the workspace-local `.openrig/agent-images` root. Entries are keyed by
`agent-image:<name>:<version>`, with later discovery roots replacing identical IDs.
Content is a manifest plus optional files; `stats.json` holds usage data and `.pinned`
marks protection from ordinary deletion/pruning.

Capture and consumption depend on live identity as well as library files:

- `packages/daemon/src/domain/agent-images/resume-token-discovery.ts`:
  `discoverResumeToken()` reads session/node/binding state. It supports Claude Code and
  Codex. Claude prefers matching context-usage identity; Codex prefers the persisted resume
  token, then an external-CLI binding. Absent native identity remains absent.
- `packages/daemon/src/domain/agent-images/snapshot-capturer.ts`:
  `SnapshotCapturer.capture()` refuses unsupported or missing native identity, writes
  an image manifest/files and rescans. It records the source working directory when known.
- `packages/daemon/src/routes/agent-images.ts`:
  `POST /fork` composes native identity discovery with an add-member operation. The
  default path makes no image. The keep-image path captures and pins one before launch,
  and reports that retained image even if launch fails.

Library/snapshot responses redact `sourceResumeToken`; the fork composer builds its
native-ID session source inside the daemon rather than returning that field to the caller.
This describes these response projections, not secrecy of every field in an image manifest.

`recordConsumption()` accepts a separate fork-count flag: consumption intent can update
last-use time without incrementing successful forks. Inspect the instantiation caller as
well as library statistics when assessing whether a launch succeeded.

`packages/daemon/src/domain/agent-images/evidence-guard.ts` implements
`evaluateProtection()`: pins, parsed spec references and descendants of protected images
contribute protection reasons. The route applies the guard to deletion/pruning unless
`force` is explicit. Prune defaults to dry-run. Its protection view depends on the supplied
spec roots; it is not an inventory of every reference anywhere on the host.

The routes mount at `/api/agent-images` and expose list/sync, snapshot/fork,
entry/preview, pin/unpin, delete and prune.
`packages/cli/src/commands/agent-image.ts` owns the image library commands.

## Plugins

### Discovery and inspection

`packages/daemon/src/domain/plugin-discovery-service.ts` discovers plugins from:

| Source kind | Directory shape |
|---|---|
| `vendored` | OpenRig plugins root, one plugin directory per entry. |
| `claude-cache` | Claude cache, grouped by marketplace/plugin/version. |
| `codex-cache` | Codex cache, grouped by marketplace/plugin/version. |
| `rig-cwd` | `.claude/plugins` and `.codex/plugins` beneath supplied working-directory roots. |

Detection uses the Claude/Codex plugin manifests. `listPlugins()` returns runtime/source
metadata; `getPlugin()` adds manifests, skills, hooks and MCP detail.
`findUsedBy()` scans agent YAML in configured spec-library roots for plugin declarations
and profile references. These references describe authored specs, not proof of a running
harness loading a plugin.

The service constructor is not read-only: it retires obsolete refocus hook registrations
from the older bundled plugin and rejects duplicate vendored hook registrations across
providers. Cached plugin versions are excluded from that duplicate-provider check.

`packages/daemon/src/routes/plugins.ts` exposes GET-only inspection at `/api/plugins`:
list, detail, used-by and file list/read. The file routes use the discovered plugin root as
their path allowlist. `?cwd=` supplies rig-cwd discovery roots.
At this pin, the route's source filter accepts vendored, Claude-cache and Codex-cache only;
`source=rig-cwd` is not applied as a filter, even though the service supports that kind.

### Vendoring and projection

`packages/daemon/src/domain/plugin-vendor-service.ts` owns `PluginVendorService`.
`ensureVendored()` seeds absent plugins or advances an older numeric manifest version.
Equal/newer installed versions preserve installed bytes; equal versions can reconcile file
modes on byte-identical files. Missing target version authority is preserved rather than
overwritten; invalid or conflicting manifest versions are errors.

`ensureSkillGlobally()` projects a named plugin skill using a vendor-version marker.
An existing unversioned global skill remains externally owned. Startup wires this service
and its filesystem implementation; inspect that wiring when changing projection roots.

`ensureLatest()` performs local vendoring before `attemptAutoFetch()`. The latter
requests a release asset with a bounded timeout and logs failures; even its successful
response path does not extract/install the fetched archive at this pin. This does not
establish whether an upstream release asset currently exists.

`packages/cli/src/commands/plugin.ts` implements `rig plugin
list|show|used-by|validate`. Discovery, vendoring and a runtime's projected plugin tree
are distinct steps; see [agent-spec-and-startup.md](agent-spec-and-startup.md) for launch.

## Claude guided compaction

`packages/daemon/src/domain/claude-compaction-enforcer.ts` implements
`ClaudeCompactionEnforcer`. Startup shares one instance between `ContextMonitor`
and the manual-compaction route consumers.
`packages/daemon/src/domain/user-settings/settings-store.ts` resolves the
`policies.claude_compaction.*` settings; automatic compaction defaults to disabled.

`maybeAutoCompact()` applies the delivery guard when available. Its implementation
requires Claude Code, observed usage and a valid integer threshold. Above-threshold
automatic work additionally checks enablement, deduplication, cooldown and the
already-triggered latch. It sends prep, then compact, and queues the below-threshold
continuation: turn boundary, restore prompt, then compliance prompt.

The below-threshold continuation checks policy enablement too, except for an explicitly
operator-initiated manual sequence. A known occupant-generation mismatch invalidates the
queued stages; an unknown generation does not prove a match. Failed or retained sends
do not advance the stage. The manual trigger shares this continuation while having its
own initiation checks.

Stage, deduplication and cooldown maps are in memory. Startup supplies live generation
resolution and a post-restore callback that records a managed-width receipt, so the wider
operation also has persistent effects. Do not infer durable lifecycle completion from
a library read or one successfully queued message.

## Related maps

- [packaging-bootstrap-bundles.md](packaging-bootstrap-bundles.md): bundle export and
  routing into content libraries.
- [agent-spec-and-startup.md](agent-spec-and-startup.md): context/resource projection
  and image consumption during launch.
- [lifecycle-snapshot-restore.md](lifecycle-snapshot-restore.md): broader continuity flows.
