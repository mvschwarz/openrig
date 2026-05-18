---
kind: as-built
title: Content Surfaces — Files Browser, Atomic Write, Progress Tree, Steering Composer
status: active
topics: [observability, specification-and-bundles]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the operator-allowlisted file browser enforces path
  safety, how atomic conflict-checked writes + the JSONL edit audit work,
  how the workspace PROGRESS.md tree is indexed, or how the one-screen
  Steering surface (priority stack + roadmap rail + lane rails + health
  gates) is composed. Author-mode module — no prior architecture.md prose;
  every load-bearing claim is sourced to file:line at HEAD.
siblings: [workspace-primitive.md, daemon-core.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, workspace-primitive.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Content Surfaces — Files Browser, Atomic Write, Progress Tree, Steering Composer

The **content surfaces** are the operator-allowlisted, filesystem-canonical
read/write layer that the Project / Steering UI sits on: a fail-closed file
browser, an atomic conflict-checked write service with a JSONL edit audit,
the recursive PROGRESS.md tree indexer, and the one-screen Steering composer
(+ its compact health-summary gates). None adds SQLite state.

> **AUTHOR-FROM-SOURCE module.** No prior `architecture.md` prose exists for
> this. Every load-bearing claim carries `> Source: <file:line> @HEAD`;
> ambiguity is declared as an OPEN item, never smoothed. Paths are relative
> to `packages/daemon/src/` unless prefixed `packages/` or `docs/`.
>
> Verified at HEAD `7eaf524c` (`git describe` → `v0.3.1-6-g7eaf524c`).
> Package version **0.3.1**; HEAD carries 6 unreleased release-0.3.2
> commits; no `v0.3.2` tag (daemon-core.md; slice-00 §1.1).
>
> **SPLIT NOTE (§10.6).** This is the content-surfaces half of the
> `workspace-and-content-primitives` SPLIT (sibling `workspace-primitive.md`
> carries the workspace primitive + migrations 038/039 +
> missions/projects/slices). See `workspace-primitive.md` § header SPLIT
> NOTE for the §10.6 rationale and the transparent-noted-deviation
> disclosure.

## 0. Release attribution (forensic proof — read first)

Per §10.8, re-verified at HEAD via `git cat-file -e <tag>:<path>`:

| Subsystem | Release | Forensic proof @HEAD |
|---|---|---|
| `domain/files/{path-safety,file-write-service}.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| `domain/progress/progress-indexer.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| `domain/steering/{steering-composer,health-summary}.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |
| `routes/{files,progress,steering,health-summary}.ts` | **≤0.3.0** | `v0.3.0:<path>` → present |

> Source: §10.8 proof re-run at HEAD `7eaf524c` — every listed path
> resolves at `v0.3.0` (no failures). All content surfaces are
> **≤0.3.0** features (UI Enhancement Pack v0 + Operator Surface
> Reconciliation v0; slice-00 0.3.0-GT §1.7 "Files / Markdown /
> Progress / Proofs" confirms the cluster shipped 0.3.0). Do **not**
> back-attribute any of these to 0.3.1 — the gap is missing
> architecture.md prose, not a new feature.

## 1. Path safety — the fail-closed allowlist (UI Enhancement Pack v0)

The file browser is gated by a daemon-enforced, **fail-closed** allowlist.
Roots are decoded from `OPENRIG_FILES_ALLOWLIST` (env), comma-separated
`<name>:<absolute-path>` pairs (legacy fallback `RIGGED_FILES_ALLOWLIST`
via `||` so an empty string falls through). Invalid pairs (no colon, empty
name, non-absolute path) are **silently skipped**; duplicate names →
last-wins. Empty/unset → no roots → routes return an empty list with a
structured "configure OPENRIG_FILES_ALLOWLIST" hint. The safe default after
a fresh install is **nothing allowlisted**.

> Source: `domain/files/path-safety.ts:50-51` (env vars),
> `:60-93` (`decodeAllowlist` / `readAllowlistFromEnv`; silent-skip
> L67-71, last-wins L78, `||` fallback comment L89-91) @HEAD.

`resolveAllowedPath(allowlist, rootName, relativePath)` is the load-bearing
guard. Algorithm: (1) reject unknown root (`root_unknown`); (2) reject
expressed-intent `..` segments **before** filesystem resolution
(`path_escape`) — segment-split so `foo..bar` is not a false positive;
(3) reject an absolute `relativePath` (`path_invalid`); (4) resolve
symlinks via `fs.realpathSync` and reject when the realpath does not start
with `<canonicalRoot><sep>` (`path_escape`) — a `path.sep` boundary so
`/foo/bar` does not match `/foo/bar-other`; (5) `path === ""` resolves to
the root itself (so callers can list the root). Symlinks **inside** the
tree resolve normally; symlinks pointing **outside** are escape attempts.
A non-existent candidate falls back to the unresolved path so the
subsequent stat surfaces the absence with a specific code.
`resolveAllowedFile` / `resolveAllowedDirectory` add a stat assertion
(`not_a_file` / `not_a_directory`).

> Source: `domain/files/path-safety.ts:95-171` (`resolveAllowedPath`;
> `..`-before-fs L124-140, absolute-reject L141-147, sep-boundary
> L158-169, empty-path base case in the doc-comment L108-110),
> `:173-225` (file/dir convenience asserts) @HEAD.

## 2. Atomic write + JSONL audit (UI Enhancement Pack v0 item 4)

`FileWriteService.writeAtomic(req)` is the operator-actionable write surface
for `STEERING.md` / `PROGRESS.md` / spec YAML / any allowlisted file.
Sequence: (1) resolve target under allowlist (reuses §1 path-safety);
(2) re-stat + re-hash the target — if `mtime !== expectedMtime` OR
`contentHash !== expectedContentHash`, throw `WriteConflictError` carrying
the **current** mtime + hash for the UI to surface (optimistic-concurrency,
not a lock); (3) write to a temp file in the **same directory** (PID +
random suffix so concurrent writes don't collide); (4) `fsync` the temp fd
for durability before the rename; (5) atomic `renameSync` over the target
(single inode swap on POSIX — readers see old or new, never partial);
(6) recompute mtime + hash + byte delta; (7) append one JSONL audit row.

> Source: `domain/files/file-write-service.ts:9-25` (documented
> atomic-write semantics), `:111-212` (`writeAtomic`; conflict-detect
> L129-135, same-dir temp L137-141, fsync L146, atomic rename L161)
> @HEAD.

The audit file is `~/.openrig/file-edit-audit.jsonl` by default
(`HOME`/`USERPROFILE` → `/tmp` fallback). **Append-only; never rotates at
v0.** A failed audit append throws `FileWriteError("audit_write_failed")`
but does **NOT** undo the landed write — the user's edit succeeded; an
audit-system flake must not silently revert canon. (The route still
surfaces it as a 500 so the failure is honest, not swallowed.)

> Source: `domain/files/file-write-service.ts:87-91` (default path +
> fallback), `:24-25` (never-rotates-at-v0), `:182-204` (audit append;
> "does NOT undo the write" comment L183-184) @HEAD.

## 3. Files routes — browse + read + asset + write

`filesRoutes()` (mounted `server.ts:507` as `/api/files`). All routes are
**literal** (no `/:param` catchall) so order doesn't matter for shadowing
(Phase A R1 SSE lesson):

- `GET /roots` — allowlist root list (or `{roots:[], hint}` when none).
- `GET /list?root&path` — directory entries (dirs first, then files,
  name-sorted; dotfiles always included — allowlisting a root expresses
  inspection intent).
- `GET /read?root&path` — file content + `mtime` + `contentHash` (SHA-256)
  + `size`. **Content is capped at `FILE_READ_TRUNCATION_BYTES` (1 MB)** but
  the hash is computed over the **FULL** file so atomic-write conflict
  detection stays honest even on a truncated read; response carries
  `truncated` / `truncatedAtBytes` / `totalBytes`.
- `GET /asset?root&path` — raw bytes for embedded images/video/pdf (inferred
  `Content-Type`, 5-min cache).
- `POST /write` — atomic write (§2); 503 when no write service
  (`OPENRIG_FILES_ALLOWLIST` empty); 409 `write_conflict` on stale
  mtime/hash with the current values for the UI's refresh prompt.

503 `files_routes_unavailable` when the allowlist dep is unwired.
Path-safety errors map to HTTP per code (`root_unknown`/`path_*` → 400,
`stat_failed` → 404).

> Source: `routes/files.ts:51-242` (handlers; route-order comment
> L17-19, truncation L139-154, write 503/409 L187-191/L225-231,
> path-safety→HTTP `:61-69`); `FILE_READ_TRUNCATION_BYTES = 1_048_576`
> `:49`; mounted `server.ts:507`; CLI: no `rig files` verb — files are
> a UI-only surface @HEAD.

> **§10.7 route-reality (source-verified at `packages/ui/src/routes.tsx`):**
> `/files` is a **REAL route** (`FilesWorkspace`) the Phase-8.1 survey
> MISSED. There is **NO `/markdown` route** — markdown rendering is a
> *component* inside file / drawer surfaces, not a navigable destination.
>
> Source: `packages/ui/src/routes.tsx:192-195` (`path: "/files"` +
> `FilesWorkspace`); grep-confirmed no `path: "/markdown"` declaration
> anywhere in routes.tsx @HEAD.

## 4. Progress tree indexer (UI Enhancement Pack v0 item 1B)

`ProgressIndexer` walks operator-allowlisted scan roots
(`OPENRIG_PROGRESS_SCAN_ROOTS`, same `<name>:<abs-path>` shape as the file
allowlist; legacy `RIGGED_PROGRESS_SCAN_ROOTS`), finds **`PROGRESS.md` AND
`STEERING.md`** files (STEERING.md is anchored as the constraint-frame node
per OSR v0 Item 2; the row-machinery is filename-agnostic), and parses each
into a checkbox-hierarchy tree. Recursion is depth-bounded (default 6 —
enough for mission/lane/slice nesting without descending into
`node_modules`/`.git`/`.worktrees`/`dist`/`build`/`.turbo`/`.next` or
dotfiles). Checkbox status: `[x]` → `done`, `[~]` → `blocked`, `[ ]` →
`active`; headings (`##`–`####`) become hierarchy rows; depth from
2-space indent or heading level. Per-file `counts` + a scan-wide
`aggregate`. **In-memory walk per request; no caching at v0** (bounded by
the operator's allowlist scope).

> Source: `domain/progress/progress-indexer.ts:79-84` (STEERING anchor +
> env vars), `:81` (SKIP_DIRS), `:71` (`DEFAULT_MAX_DEPTH = 6`),
> `:218-235` (checkbox status mapping), `:204-215` (heading rows),
> `:21-23` (no-caching-at-v0) @HEAD.

`progressRoutes()` (mounted `server.ts:508` as `/api/progress`):
`GET /tree` — the indexed hierarchy; 503 `progress_indexer_unavailable`
when unwired; 503 `progress_scan_roots_not_configured` + setup hint when
no roots.

> Source: `routes/progress.ts:18-40` (handler; 503s L29-35); mounted
> `server.ts:508` @HEAD.

> **§10.7 route-reality:** `/progress` is a **`<Navigate to="/project" />`
> redirect-stub** — the progress system lives at the daemon
> `/api/progress` route, but the UI URL folds into Project tabs (Phase 3).
>
> Source: `packages/ui/src/routes.tsx:464-468` ("folds into Project tabs
> (Phase 3) — redirect to /project") @HEAD.

## 5. Steering composer (Operator Surface Reconciliation v0 item 1)

`SteeringComposer.compose()` is the **one-screen composed steering surface**.
It is deliberately narrow: it composes only the **filesystem-derived**
pieces; the UI fetches PL-005 queue views (in-motion / loop-state) and
health gates via their own existing endpoints so the composer stays
testable. Three sources, all resolved from a single workspace root
(`OPENRIG_STEERING_WORKSPACE`; per-piece overrides
`OPENRIG_STEERING_PATH` / `OPENRIG_ROADMAP_PATH` /
`OPENRIG_DELIVERY_READY_DIR` trump the root-derived defaults; legacy
`RIGGED_STEERING_WORKSPACE`):

- **priorityStack** — verbatim `STEERING.md` content + mtime + byteCount.
- **roadmapRail** — `roadmap/PROGRESS.md` checkbox rows; detects `PL-XXX`
  rail-item codes; marks the **first unchecked** item as `isNextUnchecked`.
- **laneRails** — `delivery-ready/mode-{N}/PROGRESS.md` per-lane: reuses
  `ProgressIndexer` (maxDepth 3) for identical checkbox semantics to the
  Progress view; "next pull" = first non-done, non-blocked row (Priority
  Rail Rule — shelf/queue recency does NOT override); top-N (default 3)
  prefers active+blocked, falls back to done only to fill N.

Missing sources are reported in `unavailableSources` (each names the env
var that would resolve it) rather than failing the whole payload.
`isReady()` is true when **at least one** source resolves.

> Source: `domain/steering/steering-composer.ts:1-25` (narrow-by-design
> rationale + 3-source list), `:103-119` (env vars +
> `steeringOptsFromEnv`), `:155-169` (`isReady` / `compose`), `:198-250`
> (roadmap rail; next-unchecked L231-235), `:282-316` (lane next-pull
> L288-289, top-N L293-296), `RAIL_CODE_REGEX` `:346` @HEAD.

`steeringRoutes()` (mounted `server.ts:510` as `/api/steering`):
`GET /` — the composed payload; 503 `steering_composer_unavailable` when
unwired; 503 `steering_workspace_not_configured` + a hint pointing at
`rig config init-workspace` / `workspace.steering_path` /
`OPENRIG_STEERING_PATH` when no source resolves.

> Source: `routes/steering.ts:18-34` (handler; 503s L23-29); mounted
> `server.ts:510` @HEAD.

> **§10.7 route-reality:** `/steering` is a **`<Navigate to="/project" />`
> redirect-stub** — the composer lives at daemon `/api/steering`; the UI
> URL folds into the Project workspace overview tab (Phase 3).
>
> Source: `packages/ui/src/routes.tsx:470-474` ("folds into Project
> workspace overview tab (Phase 3) — redirect to /project") @HEAD.

## 6. Health-summary aggregator (OSR v0 item 1F)

`computeNodeHealthSummary` / `computeContextHealthSummary` are the compact
health gates on the steering surface — **daemon-side aggregation, not a CLI
shell-out** (no per-request subprocess). Node summary: cross-rig roll-up of
`sessionStatus` + `lifecycleState` via `getNodeInventory` per rig, with an
`attentionRequired` tally. Context summary: reads `context_usage` directly
(ContextUsageStore exposes per-node accessors only; listing all rows is a
steering-surface concern) and buckets by urgency
(`usedPercentage` ≥80 critical / ≥60 warning / else low / null unknown) +
freshness (`sampledAt` age vs 300 s → fresh/stale/none). A missing
`context_usage` table (test harness without the migration) yields an empty
summary, not an error.

> Source: `domain/steering/health-summary.ts:44-46` (thresholds:
> `FRESHNESS_THRESHOLD_S=300`, `URGENCY_CRITICAL_PCT=80`,
> `URGENCY_WARNING_PCT=60`), `:48-66` (node roll-up), `:75-117`
> (context roll-up; table-absent → empty L81-84) @HEAD.

`healthSummaryRoutes()` (mounted `server.ts:511` as `/api/health-summary`):
`GET /nodes`, `GET /context`; 503 `health_summary_unavailable` when the
rigRepo dep is unwired.

> Source: `routes/health-summary.ts:23-44` (handlers; 503 L33,L40);
> mounted `server.ts:511` @HEAD.

## 7. Cross-cutting properties

- **Filesystem-canonical, no new SQLite:** all four surfaces read/write the
  filesystem + the JSONL audit; health-summary reads existing
  `context_usage` only. No content-surface migration
  (`progress-indexer.ts:21-23`; `health-summary.ts:81-84`) @HEAD.
- **Fail-closed, honest errors:** path-safety rejects every escape attempt
  before fs resolution; write conflicts surface the current mtime/hash for
  an explicit refresh; missing config returns 503 + a setup hint naming the
  exact env var — never a silent empty success
  (`path-safety.ts:124-169`; `file-write-service.ts:129-135`;
  `routes/steering.ts:25-29`) @HEAD.
- **Atomic-or-nothing writes:** same-directory temp + fsync + atomic rename;
  a rename failure leaves the target untouched (never a partial write)
  (`file-write-service.ts:160-172`) @HEAD.
- **Composer narrowness is deliberate:** the steering composer owns only
  filesystem-derived pieces; queue/health come from their own endpoints —
  keeps it testable (`steering-composer.ts:6-16`) @HEAD.

## OPEN items (carried, not smoothed)

- **OPEN-A** — the JSONL edit audit at `~/.openrig/file-edit-audit.jsonl`
  **never rotates at v0** by explicit design
  (`file-write-service.ts:24-25`); unbounded growth is a known accepted v0
  state (PRD § Item 4 defers rotation), stated here rather than smoothed.
- **OPEN-B** — `OPENRIG_FILES_ALLOWLIST` vs `OPENRIG_PROGRESS_SCAN_ROOTS`
  vs `OPENRIG_STEERING_WORKSPACE` are three independent operator-config
  surfaces with the same encoding but separate resolution; there is no
  single "workspace allowlist" that unifies them at v0. Source-real;
  noted, not reconciled.
- No slice-00 numeric-drift OPEN (1–5) applies — this module carries no
  migration-count / route-group / PL-004-event-count claim.
