---
kind: as-built
title: Content Surfaces — Files, Progress, Steering, and Health
status: active
topics: [observability, specification-and-bundles]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Tracing allowlisted file access, conflict-checked writes, progress indexing,
  steering composition, or the daemon health-summary endpoints.
last-verified-against-source: 712a61fbcc5ffe5a7c786fea12132567083ab507
last-updated: 2026-10-02
---

# Content Surfaces — Files, Progress, Steering, and Health

Source snapshot: `712a61fbcc5ffe5a7c786fea12132567083ab507`. This describes the source at that commit;
it does not establish the version or behavior of a running daemon.

The daemon exposes filesystem content through the files, progress, and
steering route families. Health summaries read existing daemon state. These
are separate projections with separate configuration; configuring one root
is not a universal filesystem-access policy.

## Configuration and wiring

[`startup.ts`](../../../packages/daemon/src/startup.ts) constructs
`SettingsStore`, decodes `cfg.filesAllowlistRaw` and `cfg.progressScanRootsRaw`,
and injects `FileWriteService`, `ProgressIndexer`, and `SteeringComposer`.
The write service exists only when the decoded file allowlist is nonempty.
Its audit path is explicitly `${OPENRIG_HOME}/file-edit-audit.jsonl`.

[`SettingsStore`](../../../packages/daemon/src/domain/user-settings/settings-store.ts)
resolves environment overrides, then settings-file values, then defaults.
`files.allowlist` and `progress.scan_roots` both default to
`workspace:<resolved-workspace-root>`. Their environment overrides are
`OPENRIG_FILES_ALLOWLIST` and `OPENRIG_PROGRESS_SCAN_ROOTS`. Thus, an unset
environment variable does **not** imply an empty allowlist in normal daemon
startup. The standalone `readAllowlistFromEnv` helper has different inputs
and retains its legacy environment fallback.

Roots use comma-separated `name:/absolute/path` pairs. The decoders skip
invalid pairs, canonicalize existing paths, and let the last duplicate name
win. See [`decodeAllowlist`](../../../packages/daemon/src/domain/files/path-safety.ts)
and [`decodeProgressScanRoots`](../../../packages/daemon/src/domain/progress/progress-indexer.ts).

## Path resolution and reads

[`resolveAllowedPath`](../../../packages/daemon/src/domain/files/path-safety.ts)
requires a configured root, rejects `..` path segments and absolute relative
paths, resolves existing symlinks, and checks containment with a path-separator
boundary. An empty relative path denotes the root. If realpath fails, the
helper falls back to the resolved candidate; file/directory helpers then
perform a stat check. These are the implemented checks, not a claim of
race-free isolation against concurrent filesystem changes.

[`readAllowedFile`](../../../packages/daemon/src/domain/files/file-read.ts)
is shared by the HTTP reader and the local TUI reader. It returns content,
absolute and root-relative resolved paths, mtime, full-file SHA-256, size,
binary classification, and truncation metadata. The returned text is capped
at **1,048,576 bytes**, but the full file is read and hashed. The cap limits
the response, not the memory required to read the file.

## Writes and audit

[`FileWriteService.writeAtomic`](../../../packages/daemon/src/domain/files/file-write-service.ts)
reads the existing target and compares **both** the expected mtime and content
hash. A mismatch raises `WriteConflictError` with the current values. It then
writes a temporary file in the same directory, preserves the target's
ordinary permission bits, fsyncs the temporary file, and renames it over the
target. This is optimistic conflict detection; it does not hold a lock over
the read/compare/replace sequence.

`createAtomic` handles new files. It creates and fsyncs a temporary file, then
uses an exclusive hard link to establish the target. If the target already
exists, it returns the `target_exists` error instead of overwriting it.

Both operations append a JSONL audit record containing actor/provenance,
paths, timestamps, hashes, and byte-count delta. An audit append failure
raises `audit_write_failed` **after the content has landed**; the write is not
rolled back. The service appends records without implementing rotation.
The service's standalone default is under the user's `.openrig` directory;
daemon startup overrides it with the active OpenRig home as described above.

## HTTP surface

[`server.ts`](../../../packages/daemon/src/server.ts) mounts these families.
[`filesRoutes`](../../../packages/daemon/src/routes/files.ts) implements:

| Method and path | Result / important behavior |
|---|---|
| `GET /api/files/roots` | Configured roots; an empty list carries a setup hint. |
| `GET /api/files/list?root=…&path=…` | Directory entries with metadata, including dotfiles. |
| `GET /api/files/read?root=…&path=…` | `readAllowedFile` result. |
| `GET /api/files/asset?root=…&path=…` | Raw asset; single byte-range support (`206`, invalid range `416`), five-minute cache. HTML defaults to plain text; `render=1` opts into HTML rendering. |
| `POST /api/files/write` | Requires root, path, string content, expected mtime and hash. Stale reads return `409 write_conflict`; an absent write service returns `503`. |

Writes resolve actor/provenance through `resolveActorWithDeferral`. Missing
route dependencies return `503`; unknown roots and invalid paths return
`400`, and failed file stats return `404`. An audit failure can return `500`
even though the file write succeeded, so an error is not proof of no effect.

## Progress indexing

[`ProgressIndexer.scan`](../../../packages/daemon/src/domain/progress/progress-indexer.ts)
walks configured roots on each request, to a default maximum depth of **6**.
It skips dot-prefixed entries and named build/dependency directories, and
collects regular `PROGRESS.md` and `STEERING.md` files. Unreadable directories
and files are skipped. Consequently, an empty scan does not prove all files
were readable.

The parser skips frontmatter, takes the first H1 as the title, turns
H2–H4 headings into hierarchy rows, and reads checkbox rows as `[x]`/`[X]`
= done, `[~]` = blocked, and `[ ]` = active. Checkbox depth uses two-space
indentation; headings use heading depth. Per-file and aggregate counts cover
checkbox rows. This is a progress-text projection, not proof readiness.

[`GET /api/progress/tree`](../../../packages/daemon/src/routes/progress.ts)
returns the scan. Missing indexer or empty configured roots returns `503`.

## Steering composition

[`steeringOptsFromSettings`](../../../packages/daemon/src/domain/steering/steering-composer.ts)
combines resolved workspace settings with `OPENRIG_STEERING_WORKSPACE`,
`OPENRIG_STEERING_PATH`, `OPENRIG_ROADMAP_PATH`, and
`OPENRIG_DELIVERY_READY_DIR` overrides. `SteeringComposer.compose` reads:

| Field | Source and selection |
|---|---|
| `priorityStack` | Verbatim `STEERING.md`, mtime, and byte count. |
| `roadmapRail` | `roadmap/PROGRESS.md` checkbox rows; the first unchecked row is marked next. |
| `laneRails` | Progress files under `delivery-ready`, using a depth-3 `ProgressIndexer`; first non-done/non-blocked checkbox is next pull. Default top 3 prefers non-done rows, then fills with done rows. |

Missing/unreadable sections become `unavailableSources`. `isReady` means at
least one path resolves; it does not guarantee that every read succeeds.
[`GET /api/steering`](../../../packages/daemon/src/routes/steering.ts)
returns `503` when the composer is absent or no source path resolves.
Queue and health state are fetched through their own endpoints.

## Health summaries

[`healthSummaryRoutes`](../../../packages/daemon/src/routes/health-summary.ts)
exposes four reads under `/api/health-summary`:

| Suffix | Source |
|---|---|
| `/nodes` | `computeNodeHealthSummary`: node inventory aggregated across rigs, grouped by session/lifecycle status, with an attention-required count. |
| `/context` | `computeContextHealthSummary`: `context_usage` rows grouped by urgency and sample freshness. |
| `/version` | `getDaemonVersion`: the running daemon's version, or `unknown` on read failure. |
| `/gateway` | The injected gateway subsystem's `status()`; `503` if unavailable. |

The [context aggregation](../../../packages/daemon/src/domain/steering/health-summary.ts)
uses **80%** for critical, **60%** for warning, and **300 seconds** for
freshness. A missing usage value is unknown; a missing timestamp has no
freshness sample. The SQL read catches errors and falls back to an empty
sample set, so zero counts alone are not a database-health guarantee.

## Related source

- [Living Notes review](living-notes-review.md) composes proof and scope content.
- [Workspace primitive](workspace-primitive.md) covers workspace identity.
- [File-path tests](../../../packages/daemon/test/files-path-safety.test.ts),
  [progress tests](../../../packages/daemon/test/progress-indexer.test.ts), and
  [steering tests](../../../packages/daemon/test/steering-composer.test.ts)
  exercise these helpers; their presence is not a runtime verification claim.
