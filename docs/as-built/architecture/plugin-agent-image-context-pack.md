---
kind: as-built
title: Content Layer — Plugins, Agent Images, Context Packs, Compaction Policy
status: active
topics: [extension-and-user-workspace, continuity, skill-management]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how OpenRig discovers plugins, captures/forks agent images,
  assembles/sends context packs, or how the Claude auto-compaction enforcer
  decides to send /compact. Author-mode module — no prior architecture.md
  prose; every claim is sourced to file:line at HEAD.
siblings: [packaging-bootstrap-bundles.md, agent-spec-and-startup.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Content Layer — Plugins, Agent Images, Context Packs, Compaction Policy

Four filesystem-canonical content primitives the daemon discovers and
serves: **plugins**, **agent images**, **context packs**, and the **Claude
auto-compaction policy enforcer**. None adds SQLite state — all are
filesystem-canonical with in-memory daemon caches.

> **AUTHOR-FROM-SOURCE module.** No prior `architecture.md` prose exists
> for this. Every load-bearing claim carries `> Source: <file:line>
> @HEAD`; ambiguity is declared as an OPEN item, never smoothed. Paths are
> relative to `packages/daemon/src/` unless prefixed `docs/`.
>
> Verified at HEAD `7eaf524c` (`git describe` → `v0.3.1-6-g7eaf524c`).
> Package version **0.3.1**; HEAD carries 6 unreleased release-0.3.2
> commits; no `v0.3.2` tag (daemon-core.md; slice-00 §1.1).

## 0. Release attribution (forensic seam — read first)

Re-verified at HEAD via `git cat-file -e <tag>:<path>`:

| Subsystem | Release | Forensic proof @HEAD |
|---|---|---|
| Context packs | **0.3.0** | `v0.3.0:domain/context-packs/context-pack-library-service.ts` → present (slice-00 0.3.0-GT §1.9) |
| Agent images | **0.3.0** | `v0.3.0:domain/agent-images/agent-image-library-service.ts` → present (slice-00 0.3.0-GT §1.9) |
| Plugins | **0.3.1, NOT 0.3.0** | `v0.3.0:domain/plugin-discovery-service.ts` → **ABSENT**; `v0.3.1:` → present (slice-00 0.3.0-GT seam (a); map row 5) |
| Claude auto-compaction | **0.3.1 headline, no 0.3.0 antecedent** | `v0.3.0:domain/claude-compaction-enforcer.ts` → **ABSENT**; `v0.3.1:` → present (slice-00 0.3.0-GT map row 7) |

> Source: re-run at HEAD `7eaf524c` —
> `git cat-file -e v0.3.0:packages/daemon/src/domain/plugin-discovery-service.ts`
> and `...claude-compaction-enforcer.ts` both fail ("exists on disk, but
> not in 'v0.3.0'"); the two 0.3.0 library services resolve at `v0.3.0`.
> Code present on disk at HEAD does NOT make plugins/compaction a 0.3.0
> feature — ancestry is truth; the same-calendar-day commit date is the
> forensic trap slice-00 0.3.0-GT seam (a) warns about.

**Do not back-attribute plugins or compaction to 0.3.0.** The CLI
reference already encodes this ("## Plugin Inspection (v0.3.1)").

> Source: `docs/as-built/cli-reference.md:943` @HEAD.

## 1. Context packs (PL-014) — 0.3.0

A **context pack** is a directory of `manifest.yaml` + included markdown /
yaml / txt files: operator-authored, library-discoverable, reviewable,
sendable. No SQLite tables; in-memory cache at daemon scope.

> Source: `domain/context-packs/context-pack-types.ts:1-11` @HEAD.

`ContextPackLibraryService.scan()` walks roots, parses each
`manifest.yaml`, replaces the in-memory index; collisions are
**last-wins** in discovery order (workspace > user_file > builtin).
Startup wires three roots: builtin (`../context-packs`, first), user-file
(`~/.openrig/context-packs`), and workspace-local
`<workspaceRoot>/.openrig/context-packs` when present + distinct. Stable
id `context-pack:<name>:<version>`.

> Source: `domain/context-packs/context-pack-library-service.ts:59-94`
> (scan; last-wins L79-81), `:31-33` (id); `startup.ts:481-502` (3-root
> IIFE; builtin `unshift` L497, workspace L491-493) @HEAD.

The parser is pure (no fs; caller passes raw YAML). It rejects malformed
YAML, missing `name`/`version`, non-array `files`, per-file path traversal
(`..`/leading `/`), and unsupported suffixes (`.md .markdown .yaml .yml
.txt`); `version` coerced to string. Per-file token estimate is
`ceil(bytes/4)`.

> Source: `domain/context-packs/manifest-parser.ts:11` (suffixes),
> `:13-121` (rejects; traversal `:83-89`); token estimate
> `context-pack-library-service.ts:46-48` @HEAD.

`assembleBundle` concatenates files into one paste-ready string framed
`# OpenRig Context Pack: <name> v<version>` + optional purpose + `## File:
<path> (role: <role>)` headers. Missing files are **skipped and surfaced
in `missingFiles`** (operator repair), not a hard fail; a present-but-
unreadable file throws `file_read_failed`.

> Source: `domain/context-packs/bundle-assembler.ts:38-39` (prefixes),
> `:73-100` (missing skip L74-76; read-fail throw L81-87) @HEAD.

`contextPacksRoutes()` (mounted `server.ts:482`): `GET /library`,
`POST /library/sync`, `GET /library/:id`, `GET /library/:id/preview`
(assembled, no send), `POST /library/:id/send`
(`{ destinationSession, dryRun }`; dry-run returns text without
`SessionTransport`; real send → 502 on transport failure). `id==="sync"`
→ 404 so it cannot shadow the sync route; 503 when unprovisioned. CLI:
`rig context-pack list|show|preview|sync|add|send` (`send --dry-run`).

> Source: `routes/context-packs.ts:25-138` (table; sync-guard L51; 503
> L31; dry-run L121-123; 502 L126-133); `server.ts:482`;
> `docs/as-built/cli-reference.md:914-929` @HEAD.

## 2. Agent images (PL-016) — 0.3.0

An **agent image** is a snapshot bundle of a productive seat's resumable
state: runtime-specific resume token (Claude `resume_token` / Codex
`thread_id`), source-seat lineage, optional cwd-deltas + notes. Consumable
by AgentSpec `session_source: mode: agent_image`. Filesystem-canonical at
`~/.openrig/agent-images/<name>/` + workspace-local; **no SQLite tables**.

> Source: `domain/agent-images/agent-image-types.ts:1-13` @HEAD.

`AgentImageLibraryService` mirrors `ContextPackLibraryService` (scan / list
/ get / last-wins) with three source-stated differences: `sourceResumeToken`
passes through to consumers (instantiator consumes; operator surfaces
redact); `stats.json` is a separate mutable file updated atomically on
fork-count increment; a `.pinned` sentinel pins from prune. Id
`agent-image:<name>:<version>`.

> Source: `domain/agent-images/agent-image-library-service.ts:5-14`
> (3-difference comment), `:38-41` (id) @HEAD.

`discoverResumeToken(db, sourceSession)` queries `sessions` then `nodes`
and returns a typed failure (`session_not_found`/`runtime_unsupported`)
rather than fabricating a token; only `claude-code`/`codex` have a native
fork primitive. Claude prefers `context_usage.session_id` over persisted
`sessions.resume_token`; Codex uses `resume_token`, falling back to a
binding's `external_session_name` for `external_cli` seats; returns
`nativeId: null` honestly when none.

> Source: `domain/agent-images/resume-token-discovery.ts:37-85` (honest
> null L84; Claude pref L64-69; external_cli L78-83); honesty comment
> `:9-10` @HEAD.

`SnapshotCapturer.capture()` routes through `discoverResumeToken`, throws
`AgentImageError` on failure or missing native id (no fabricated token, no
auto-fallback to fresh), writes manifest + empty `stats.json` via
`install()`, re-scans. Captured `nodeCwd` → manifest `source_cwd` so the
Use-as-starter snippet emits `cwd:` (fork starts in the parent's directory
where Claude's project-dir-scoped jsonl lives); the daemon does NOT
override cwd at fork dispatch.

> Source: `domain/agent-images/snapshot-capturer.ts:60-104` (throw
> L65-79; source_cwd L88-93; install+scan L101-102);
> `routes/agent-images.ts:256-265` (no-cwd-override contract) @HEAD.

**Evidence guard (CATASTROPHIC-bounce; fails closed).**
`evaluateProtection()` protects an image from deletion if ANY: pinned;
referenced by an active `agent.yaml`; referenced by a rig spec; or a
lineage descendant of a protected image (transitive, fixed-point
iteration). Spec-root scanning parses YAML structure (not string-grep)
and is deliberately conservative — false positives (over-protection)
acceptable; false negatives = catastrophic data loss. `--force` /
`?force=true` overrides.

> Source: `domain/agent-images/evidence-guard.ts:1-16` (bounce +
> fail-closed), `:53-115` (direct + transitive; fixed point L92-112),
> `:117-122` (conservative) @HEAD.

**Resume-token redaction at route boundary (LOAD-BEARING).**
`/api/agent-images` redacts `sourceResumeToken` → `"(redacted)"` on every
operator-facing path; tokens are **never returned over the wire**; only
the in-process rigspec-instantiator consumes the real token.

> Source: `routes/agent-images.ts:15-17` + `:44-46` (`redactResumeToken`),
> applied `:60`,`:67`,`:94`,`:161`; slice-00 0.3.0-GT §1.9 flags this
> LOAD-BEARING @HEAD.

`agentImagesRoutes()` (mounted `server.ts:483-485`): `GET /library`,
`POST /library/sync`, `GET /library/:id`, `GET /library/:id/preview`,
`POST /library/:id/pin`, `POST /library/:id/unpin`,
`DELETE /library/:id` (evidence-guarded unless `force=true`),
`POST /snapshot`, `POST /prune` (**dry-run by default**,
`dryRun !== false`); guard `specRoots` injected via
`deps.agentImageSpecRoots`. CLI: `rig agent-image
list|show|preview|create|delete|pin|unpin|prune|sync`.

> Source: `routes/agent-images.ts:54-250` (table; prune default L112;
> delete-guard L224-239); `server.ts:483-485`;
> `docs/as-built/cli-reference.md:895-912` @HEAD.

## 3. Plugins (plugin-primitive Phase 3a) — **0.3.1, NOT 0.3.0**

> **Forensic trap (slice-00 0.3.0-GT seam (a)):** the plugin-discovery
> file's first-creating commit is dated the same day as the 0.3.0 release
> commit but is NOT an ancestor of `v0.3.0`. Plugins are **0.3.1**.
> Re-confirmed at HEAD by the §0 tag-presence test.

`PluginDiscoveryService` is a read-only filesystem aggregator — no SQLite,
no mutation routes (SC-29 EXCEPTION #8, declared verbatim in the source
header). It scans four source kinds, unioned with provenance labels:
vendored (`~/.openrig/plugins/<id>/`), Claude cache
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`), Codex cache
(same under `~/.codex`), and rig-cwd (`<cwd>/.claude/plugins/*` +
`<cwd>/.codex/plugins/*`). Detection = presence of
`.claude-plugin/plugin.json` and/or `.codex-plugin/plugin.json` (declares
`runtimes`). Slice 28 added `skillCount` (readdir of `<plugin>/skills/`)
to the list response so the index page avoids an N+1 detail fetch
(SC-29 EXCEPTION #11, verbatim).

> Source: `domain/plugin-discovery-service.ts:1-29` (SC-29 #8 + scan
> desc), `:39` (4-kind `PluginSourceKind`), `listPlugins` `:205-276`
> (4 scan blocks), `scanCwdBundledPlugins` `:283-307`, `detectPlugin`
> `:393-453` (marker rule L399-404; `skillCount` L433-451 + #11
> L75-80) @HEAD.

`getPlugin(id)` returns detail (manifests + skills + hooks + MCP servers);
`rig-cwd:` ids are self-resolvable (parses the cwd out of the id prefix
and re-scans so `/api/plugins/:id` does not 404 on an id `?cwd=`
returned). `findUsedBy(id)` walks `agent.yaml` files parsing YAML
structure (not string-grep — comments don't false-positive) to collect
`resources.plugins[].id` + referencing profiles.

> Source: `domain/plugin-discovery-service.ts:309-369` (getPlugin;
> rig-cwd self-resolve L310-321), `extractCwdFromRigCwdId` `:466-479`,
> `findUsedBy` `:371-389`, `readResourcesPlugins` `:599-615`,
> `readProfilesUsingPlugin` `:617-633` (structure-not-grep `:20-23`)
> @HEAD.

`PluginVendorService.ensureLatest()` runs `ensureVendored` (hash-skip
idempotent copy from `packages/daemon/assets/plugins/<name>/` to
`~/.openrig/plugins/<name>/`) then `attemptAutoFetch`
(`github.com/mvschwarz/openrig-plugins`, 5s timeout,
**404/network/timeout tolerated silently** — vendored is ALWAYS the
fallback; upstream repo intentionally empty at v0 so 404 is normal-state;
NO tarball extraction at v0). Wired at startup for `openrig-core`.

> Source: `domain/plugin-vendor-service.ts:1-24`, `ensureVendored`
> `:80-103` (hash-skip L97-99), `attemptAutoFetch` `:111-131`
> (404-tolerant L116-117; no-extract L123-125), `ensureLatest`
> `:138-141`; `startup.ts:434-472` @HEAD.

`pluginsRoutes()` (mounted `server.ts:478`, read-only): `GET /` (filters
`?runtime=`, `?source=`, `?cwd=`), `GET /:id/used-by`,
`GET /:id/files/list?path=`, `GET /:id/files/read?path=` (slice 28
docs-browser), `GET /:id`. Literal sub-paths are mounted **before** the
bare `/:id` catchall (route-order discipline). The files endpoints reuse
the path-safety machinery with the discovered plugin's absolute path as a
synthetic single-root allowlist (operator need not declare plugin paths
in `OPENRIG_FILES_ALLOWLIST`; plugin folders read-only at v0 so the
content hash is informational). CLI: `rig plugin
list|show|used-by|validate`; no `install` verb at v0 (deferred to 0.3.2).

> Source: `routes/plugins.ts:29-39` + `:107-231` (table; before-catchall
> L128-130/L141-142; `pluginRootAllowlist` :74-92; read-only-hash
> L182-184); `server.ts:478`;
> `docs/as-built/cli-reference.md:943-963` @HEAD.

> **OPEN-A** — `parseSourceFilter` (`routes/plugins.ts:69-72`) accepts
> only `vendored|claude-cache|codex-cache`; it does NOT accept `rig-cwd`
> though `PluginSourceKind` (`domain/plugin-discovery-service.ts:39`) and
> `ListPluginsOpts.sourceFilter` include it. `?source=rig-cwd` is
> silently dropped at the route while `?cwd=` still surfaces rig-cwd
> entries unfiltered. Stated as-is; intent (rig-cwd reachable only via
> `?cwd=`) vs filter-gap is not resolvable from source alone.

## 4. Claude auto-compaction enforcer (slice 27) — **0.3.1 headline**

> **No 0.3.0 antecedent (slice-00 0.3.0-GT map row 7).** The enforcer
> file is absent at `v0.3.0`, present at `v0.3.1` (§0).

`ClaudeCompactionEnforcer.maybeAutoCompact()` decides per seat whether
`ContextMonitor` should send `/compact`, driven by operator
`policies.claude_compaction.*` settings. Decoupled from `ContextMonitor`
scheduling; `ContextMonitor` is constructed with the enforcer at startup.

> Source: `domain/claude-compaction-enforcer.ts:7-12`, `maybeAutoCompact`
> `:205-331`; `startup.ts:1191-1199` (enforcer →
> `new ContextMonitor(db, contextUsageStore, claudeAdapter,
> compactionEnforcer)`) @HEAD.

**Defensive contract** (source classifies compaction lifecycle as
load-bearing per the banked permission-layer foot-gun rule):

- **Opt-in, default-off:** `enabled=false` → never triggers.
- **Runtime filter:** triggers only when `runtime === "claude-code"`.
- **Invalid-policy = disabled:** a hand-edited non-integer / out-of-
  `[1,100]` `thresholdPercent` is treated as disabled (safer-failure).
- **Re-arm via threshold crossing:** session must drop below threshold
  before another auto-compact fires; window state NOT persisted (restart
  resets — safer-failure direction).
- **Send-failure graceful-degrade:** returns `{ triggered: false,
  reason: "send_failed" }`, never throws; dedup timestamp set only on
  successful send so a transient failure retries next tick.

> Source: `domain/claude-compaction-enforcer.ts:14-44` (risk-class +
> contract), runtime `:206-208`, invalid-policy `:224-232`,
> dedup/threshold `:285-300`, send-fail `:312-314`/`:323-325` @HEAD.

**Active handshake state machine** (Claude hooks can supply context but
do not create a new assistant turn): (1) **pre-compact prep** — first
eligible above-threshold tick sends a normal user-channel prep prompt;
state → `prep_prompt_sent`. (2) **/compact** — next eligible tick sends
`/compact <instruction> + trust-channel bridge note`; sets dedup
timestamp + `triggeredAboveThreshold`; queues post stage
`turn_boundary`. (3) **post-compact, below threshold** — staged sends
`turn_boundary` (ack-only) → `restore_prompt` (points at the pending
marker `<openrigHome>/compaction/restore-pending/<key>.json`, transcript
/ session-id fallbacks) → `compliance_prompt` (read-depth audit); final
stage sets post-restore cooldown + clears the above-threshold latch.

> Source: `domain/claude-compaction-enforcer.ts:71-77` (compact+bridge),
> `:79-98` (prep), `:108-145` (restore + marker path), `:147-163`
> (compliance), `:165-171` (turn boundary), state machine `:233-330`
> (below-threshold L233-283; above-threshold L302-330) @HEAD.

Policy fields via `SettingsStore.resolveClaudeCompactionPolicy()`:
`enabled`, `thresholdPercent`, `preCompactInstruction`,
`compactInstruction`, `messageInline`, `messageFilePath`,
`postRestoreAuditInstruction` — each backed by a
`policies.claude_compaction.*` key + `OPENRIG_POLICIES_CLAUDE_COMPACTION_*`
env override. Defaults: dedup `60_000` ms; post-compact restore cooldown
`10 * 60_000` ms.

> Source: `domain/user-settings/settings-store.ts:553-565` (resolver),
> keys `:97-103`, env `:145-151`;
> `domain/claude-compaction-enforcer.ts:45-46` (default windows) @HEAD.

## 5. Cross-cutting properties

- **Filesystem-canonical, no new SQLite** across all four; daemon caches
  in-memory; compaction window state intentionally not persisted
  (context-pack-types.ts:8-11; agent-image-types.ts:12-13;
  routes/plugins.ts:6; claude-compaction-enforcer.ts:26-29) @HEAD.
- **Honest failure, no fabrication** — discovery returns null; capturer
  throws; enforcer degrades + never throws; evidence guard fails closed
  (resume-token-discovery.ts:9-10; snapshot-capturer.ts:11-12;
  claude-compaction-enforcer.ts:30-33; evidence-guard.ts:16) @HEAD.
- **503-when-unprovisioned** is the uniform route pattern when the
  backing service is absent from context (routes/context-packs.ts:31;
  routes/agent-images.ts:59; routes/plugins.ts:113) @HEAD.

## OPEN items (carried, not smoothed)

- **OPEN-A** — plugin `?source=` filter omits `rig-cwd` (§3); intent vs
  filter-gap unresolvable from source.
- No slice-00 numeric-drift OPEN (1–5) applies — this module carries no
  migration / route-group / PL-004-event counts. Slice-00 0.3.0-GT
  OPEN-3 (For-You verb subset) is out of scope (UI surface, not
  content-layer).
