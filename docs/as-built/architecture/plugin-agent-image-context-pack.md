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
last-verified-against-source: 82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d
last-updated: 2026-10-05
---

# Content libraries and compaction

This module describes source at main commit
`82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d`. Source paths below are repository-relative.
Context packs, plugins and agent images have filesystem-backed content and daemon-side
discovery. Their consumers can read database identity, mutate files, deliver messages or
launch sessions; the whole layer is not a read-only catalog.

## Context packs

`packages/daemon/src/domain/context-packs/context-pack-library-service.ts` implements
`ContextPackLibraryService`. A pack contains `manifest.yaml` and declared members.
Its path-like ref is the lookup identity, independently of the manifest name/version;
the entry ID is `context-pack:<ref>`.

### Discovery and mutation

Startup in `packages/daemon/src/startup.ts` configures the shipped context-pack root (when
it exists), the resolved `context.root` and its `system` root, followed by the
workspace-local `.openrig/context-packs` root. The workspace root is registered even before
it exists, so a folder created later is found by the next sync; it is left out only when it
is the same path as one of the other two. The library scans recursively, stops descending
when it finds a pack manifest, skips `.tmp-add-*` staging folders, and does not follow
directory symlinks.

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
situation selection, but the dependency closure doesn't check that flag, so one can still join
as a dependency of a selected atom. Post-compaction composition skips an absent
`seat:RECAP.md` and reports it as skipped instead of failing.

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

`packages/cli/src/commands/context.ts` implements `rig context`, including `list`, `show`,
`preview`, `get`, `profile`, `compose`, `add`, `rm` and `sync`, plus `work-install`, `trace`,
`source inspect|update` and `recap-write`. The library read/compose routes do not themselves
send a pack to a running seat. Several verbs write: `add` installs into `context.root` (from
a folder, a URL, or Git with `--git`), `source update` fetches and merges a Git-installed pack
and resyncs, `work-install --apply-skills` reconciles skill projections, and `recap-write`
writes a seat recap. Inspect the selected CLI verb before treating a context command as
read-only. `rig context work-install` resolves a project position and its declared context
without the daemon; [workspace-primitive.md](workspace-primitive.md) covers project
resolution.

On a profile read, the route adds each piece's `sha256` and provenance, with a warning when a
piece's bytes come from outside the granted folder. Rig and seat selectors grant the seat's
folder as a source root and supply a default `seat:LEARNED.md` atom to named profiles whose
phases request seat context. An ordinary situation profile includes that file only when the
pack authors a seat atom; the selectors alone don't add it.

### System World, seat recaps and skill loadouts

`packages/daemon/src/domain/system-world.ts` reads the System World manifest (schema
`openrig.system-world/v0alpha1`): an id, a version, the context packs every seat starts from,
and system skills. The `context.system_world` setting selects the default manifest at
`system/system-world.yaml` under `context.root`, disables it, or names another manifest file.
The default (`openrig-default`) names the `onboarding-width` and `world-public` packs and no
skills; it is seeded when missing.

`rig context recap-write --rig <rig> --seat <seat> --file <file>` writes the seat's
`RECAP.md` through `packages/daemon/src/domain/context-packs/seat-recap-store.ts`. The previous
recap is kept byte-for-byte under `recap-superseded/`. A recap that isn't addressable Markdown
is refused; the other content checks are advisory.

`packages/daemon/src/domain/skill-catalog.ts` resolves a seat's skill loadout from the
catalog at `skills.root` (`catalog.yaml`, schema `openrig.skill-catalog/v1`) and the system,
topology and project selections. It projects skills into `<cwd>/.claude/skills` or
`<cwd>/.agents/skills` and tracks what it owns in
`<cwd>/.openrig/skill-loadouts/<runtime>.json`. Each projection reports `current`, `missing`,
`shadowed`, `stale` or `conflicting`. `rig skill loadout --runtime <runtime>` inspects the
composed projection and reconciles it only with `--apply`; `rig skill audit` is a separate
read-only provenance and freshness audit. Launch applies the selected loadout per seat.

For a Claude Code or Codex seat, the profile resolver also adds each selected plugin's skills to
that loadout (`packages/daemon/src/domain/profile-resolver.ts:287–308`, with
`resolvePluginSkills()` at `skill-catalog.ts:368`). Neither runtime reads skills from the plugin
folder projected into the working directory. The skills are projected under their plain names,
and a skill the profile already selects keeps its source. A kept plugin copy (an edited or
user-owned one) gives a `plugin_skill_kept` warning, and an unreadable one gives
`plugin_skill_skipped`. If plugin skills can't be projected at all, the seat starts without them
and gets a `plugin_skills_not_projected` warning (`rigspec-instantiator.ts:2044`).

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

The guard keys its result by image name, not version: every version of one name gets the
status computed for the last-listed version, carrying that version's image ID. The delete
route looks up by image ID, so on delete only that last-listed version of a name is matched,
and its other versions are deleted without `force` even when pinned. `rig agent-image prune`
sends a dry run unless `--force` is given, and `--force` also overrides the guard, so a
guarded real prune is reachable only through the HTTP route.

The routes mount at `/api/agent-images` and expose list/sync, snapshot/fork,
entry/preview, pin/unpin, delete and prune.
`packages/cli/src/commands/agent-image.ts` owns the image library commands. The top-level
`rig fork` verb (`packages/cli/src/commands/fork.ts`) drives `POST /fork`; `--keep-image`
also captures a pinned image.

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
providers. Cached plugin versions are excluded from that duplicate-provider check. Startup
constructs the service while building the daemon's dependencies and doesn't catch that
rejection, so a duplicate vendored hook stops daemon creation.

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
overwritten; invalid or conflicting manifest versions are errors. Advancing a version writes
changed files but never deletes files the new version dropped.

`ensureSkillGlobally()` projects a named plugin skill using a vendor-version marker.
An existing unversioned global skill remains externally owned. Startup wires this service
and its filesystem implementation; inspect that wiring when changing projection roots. At
startup only `openrig-core` is vendored, and it is projected globally as `openrig-skills` into
`~/.claude/skills` and `~/.agents/skills`.

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

`maybeAutoCompact()` applies the delivery guard when one exists and the runtime is Claude
Code. Its implementation requires Claude Code, observed usage and a valid integer threshold
(default 80). Above-threshold automatic work additionally checks enablement, the
post-restore cooldown (10 minutes), the deduplication window (60 seconds) and the
already-triggered latch; an active manual attempt also blocks it.

`/compact` is held behind a preparation attempt:

1. The first above-threshold tick starts an attempt with its own ID, the seat's occupant
   generation, a restore-map path and a completion marker, then sends only the prep prompt.
   An unknown occupant generation stops the attempt at once.
2. Later ticks return `preparation_pending` until the attempt's `RESTORE-MAP.md` exists and
   ends with that exact marker. The map path is under the seat's working directory
   (`.openrig/compaction/preparation/<session>/<attempt>/`, with a `.gitignore` of `*`) when
   that is writable, otherwise under `compaction/preparation/` in the OpenRig home.
3. Only then is `/compact` sent, with the map path appended to the compact instruction.
4. The continuation then runs below the threshold: turn boundary, restore prompt, then a
   read-depth audit prompt (each item marked `FULL`, `PARTIAL` or `NOT_READ`).

An automatic attempt has a 25-minute ceiling that starts once the prep is delivered. A stale
occupant generation, the policy becoming disabled, or the deadline passing stops it. A prep
that clearly wasn't sent is retried at most three times; an uncertain prep or `/compact` is
never replayed.

The restore prompt names a restore-pending marker at
`compaction/restore-pending/<session>.json` in the OpenRig home, which the `openrig-core`
PreCompact hook writes. A per-seat `compaction/post-compact-extra/<session>.md` is preferred
over the global extra file, and an extra file that declares a different seat is refused.

`rig compact <session>` (`packages/cli/src/commands/compact.ts`) runs the same sequence
manually through `/api/compaction/trigger`, `cancel` and `state`, which use the terminal
bearer-token middleware; it passes every request through when no token is configured.
`--skip-map` skips the map requirement once, `--cancel` ends the preparation, and `--state`
shows the attempt, its expected map and its deadline. A manual attempt has 120 seconds for
preparation and the idle wait.

The below-threshold continuation checks policy enablement too, except for an explicitly
operator-initiated manual sequence. A known occupant-generation mismatch invalidates the
queued stages; an unknown generation does not prove a match. Failed or retained sends
do not advance the stage. The manual trigger shares this continuation while having its
own initiation checks.

Stage, deduplication, cooldown and preparation-attempt maps are in memory; the restore maps
are files. Startup supplies live generation
resolution and a post-restore callback that records a managed-width receipt, so the wider
operation also has persistent effects. Do not infer durable lifecycle completion from
a library read or one successfully queued message.

## Related maps

- [packaging-bootstrap-bundles.md](packaging-bootstrap-bundles.md): bundle export and
  routing into content libraries.
- [agent-spec-and-startup.md](agent-spec-and-startup.md): context/resource projection
  and image consumption during launch.
- [lifecycle-snapshot-restore.md](lifecycle-snapshot-restore.md): broader continuity flows.
