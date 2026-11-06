# Finite telemetry metadata

`rig telemetry` reads one bounded page of retained history from the daemon. It is
useful for collectors and operators that need a cursor without reading OpenRig's
private SQLite schema. It neither watches nor automatically drains history.

```sh
rig telemetry events --json
rig telemetry events --start retained --node NODE_ID --limit 128 --json
rig telemetry events --start retained --rig RIG_ID --json
rig telemetry events --cursor CURSOR --node NODE_ID --json
rig telemetry transitions --start retained --qitem QUEUE_ITEM_ID --json
rig telemetry tenures NODE_ID --json
```

Events and transitions initially return an empty checkpoint at the current high
watermark, with `historical_events_not_read` or `historical_transitions_not_read`.
Use `--start retained` to request the retained past. Tenures start with the newest
32 records for the immutable node ID, with a descending continuation when needed.
An empty match set can still have more source records: check `page.hasMore` and
`page.nextCursor`. The cursor binds the stream and filters; retain the same filter
options when continuing. Do not use `--start` with `--cursor`.

`rig mcp serve` offers the events read as the `rig_telemetry_events` tool, with the
same parameters and envelope; its `rigId` also takes a rig name.

## HTTP and envelope

These reads use the daemon's existing browser/access boundary:

| GET path | Query parameters |
| --- | --- |
| `/api/telemetry/v1/events` | `cursor`, `limit`, `start=latest\|retained`, `nodeId`, `rigId` |
| `/api/telemetry/v1/queue-transitions` | `cursor`, `limit`, `start=latest\|retained`, `qitemId` |
| `/api/telemetry/v1/nodes/:nodeId/tenures` | `cursor`, `limit` |

The envelope contains `schemaVersion: 1`, `stream`, `observedAt`, `source`, `rows`,
`page`, and `coverage`. Integer IDs are **decimal strings**, including values larger
than JavaScript's safe integer range. `--json` preserves the complete envelope.

- Events: `seq`, `rigId`, `nodeId`, `type`, `originalTimestamp`, `createdAt`.
- Transitions: original `transitionId`, `qitemId`, `state`, `actorSession`,
  `identityProvenance`, `closureReason`, `closureTarget`, `originalTimestamp`, `createdAt`.
- Tenures: `nodeId`, `generationOrdinal`, `generationUuid`, `kind`,
  `nativeSessionIdAtBoot`, `originalTimestamp`, `bootAt`.

Normalized `createdAt` and `bootAt` are explicit UTC or null with a named gap.
SQLite timestamps without a timezone are interpreted as UTC. Original timestamps
remain available. Streams have separate sequences; their IDs do not establish
cross-stream causal ordering. Event type alone establishes no readiness, activity,
or native-exit verdict. Repeated same-state transitions remain separate records.
Null boot identity stays unknown, and a tenure has no inferred end time. Historical
records are never joined to today's owner or node name.

`page` reports the requested boundary (`requestedAfter` or `requestedBefore`),
`lastScanned`, fixed `through`, `retainedHighWatermark`, `hasMore`, `nextCursor`,
`restartCursor`, and `fetched`, `scanned`, `filtered`, `withheld`, `returned`,
`capReason`. New writes above a window's `through` wait until that window is
complete. A complete ascending checkpoint opens another finite window on its next
use. Descending tenure history ends with a null continuation.
Its cursor also retains the first observed lower ordinal, so disappearance of that
older range produces a named gap even when some records remain on the final page.

## Bounds and privacy

The default/max source page is 128 rows; tenures default to 32. Sparse filters run
**after** that bound, so matching nothing still advances over scanned records.
Transitions fetch at most 128 candidates from each of the active/archive tables
in one read snapshot, then process at most 128 distinct ordered IDs. Equal
projected duplicates collapse; conflicting IDs are withheld with a named gap.
Physical `fetched` can therefore exceed logical `scanned`.

Responses are at most 128 KiB, with a 4 KiB projected-record cap. SQL guards bound
fields before fetching them: identifiers 256 bytes, timestamps/enums 128 bytes,
and actor/closure references 512 bytes. Oversized fields become null with an
`oversized_field` gap, and non-text values become null with an `invalid_type` gap;
they are never truncated into a different identity. A record
whose JSON escaping still exceeds 4 KiB is withheld and counted. A response-byte
stop leaves the next unprocessed record for the continuation. Gap details are
capped at 32; `gapCount` and `gapDetailsTruncated` preserve the count. Cursor input
is limited to 2 KiB. These are work/size bounds, not a disk-latency guarantee.

No event payload, transition note, queue body/summary, transcript, command, path,
or environment is selected. Operational IDs, native conversation IDs and actor
addresses are intentional metadata; they can still identify people or seats.
This interface does not make that metadata public or anonymous.

## Unknown history and errors

`coverage.historyCompleteness` is always `unknown`. Coverage status is
`retained_window`, `partial`, or `unavailable`; a retained window does not prove
that older history exists or is complete. `retainedMinimum` and named gaps expose
missing retained identifiers with unknown cause, never inferred downtime. Missing
tenure history cannot distinguish node deletion from never-recorded history.

`source` contains `hostId`, `bootEpoch`, and **`sequenceSpaceId: null`**. A daemon
boot epoch is not durable store identity. On a boot change or observed watermark
regression, the API returns no old-window rows, a named unavailable-history gap,
and (for ascending streams) a separate fresh `restartCursor`. Record that gap
before explicitly adopting the fresh checkpoint. Tenures may be requested fresh
without a cursor. Do not silently reset to zero or conflate existing collector
source identity, native-tail cursors and these cursors. An arbitrary in-place
database restore/copy without an observable regression is not detected.

After **every daemon restart**, a following collector cannot continue its old
cursor. To recover available retained history, record the boot gap and start a new
read with `start=retained`, accepting possible overlap with previously read records.
Alternatively, adopting `restartCursor` observes only new records after the fresh
high watermark; it does not recover the missed interval. Neither choice proves
continuity across the restart while `sequenceSpaceId` remains null.

Malformed cursors/options return HTTP 400 `telemetry_invalid_request`.
Schema/read/source failures return HTTP 503 `telemetry_read_unavailable`, never a
successful empty history. The CLI preserves the error body in JSON mode and exits
1 for request errors, 2 for unavailable reads. Existing SSE and usage APIs retain
their behavior. Durable store epochs remain separate work.

## Reference OTLP queue-transition log exporter

`docs/reference/telemetry-otlp.mjs` is an optional, dependency-free Node.js
reference exporter that polls one daemon source namespace's
`/api/telemetry/v1/queue-transitions` stream and forwards allowlisted transition
observations and named coverage gaps to a local OTLP/HTTP JSON logs receiver
(`POST .../v1/logs`). It keeps one bounded page/batch in flight and uses only
Node.js builtins.

The daemon copies `.md` files from `docs/reference/` to `$OPENRIG_HOME/reference/`
on startup; the runnable `.mjs` script is invoked from a repository checkout at
`docs/reference/telemetry-otlp.mjs` or from an installed `@openrig/cli` package at
`daemon/docs/reference/telemetry-otlp.mjs`:

```sh
# From a repository checkout (one bounded poll/export step)
node docs/reference/telemetry-otlp.mjs \
  --source http://127.0.0.1:7433 \
  --endpoint http://127.0.0.1:4318/v1/logs \
  --checkpoint /var/tmp/openrig-telemetry-checkpoint.json \
  --namespace example-source \
  --start retained \
  --once

# From an installed @openrig/cli package
RIG_PKG_ROOT="$(dirname "$(realpath "$(command -v rig)")")/.."
node "$RIG_PKG_ROOT/daemon/docs/reference/telemetry-otlp.mjs" \
  --source http://127.0.0.1:7433 \
  --endpoint http://127.0.0.1:4318/v1/logs \
  --checkpoint /var/tmp/openrig-telemetry-checkpoint.json \
  --namespace example-source
```

### Minimal local OpenTelemetry Collector pipeline

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318

processors:
  batch: {}

exporters:
  debug:
    verbosity: detailed

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

### CLI flags and bounds

| Flag | Bound / default | Purpose |
| --- | --- | --- |
| `--source <url>` | Required (`http:`/`https:`, no credentials/query; default daemon port `7433`) | Daemon root URL or exact `/api/telemetry/v1/queue-transitions` URL |
| `--endpoint <url>` | Required (`http:`/`https:`, path ending in `/v1/logs`, no credentials/query) | Complete OTLP/HTTP JSON logs receiver URL |
| `--checkpoint <path>` | Required (regular file, compact JSON `<= 256 KiB`, one process per file) | Durable checkpoint and pending-batch file path |
| `--namespace <name>` | Required (`1..128` ASCII identifier bytes `[A-Za-z0-9._:-]`) | Source namespace bound to resource/scope and checkpoint |
| `--start <mode>` | `latest` (default) or `retained` (bound into checkpoint config; keep same on resume) | Initial window mode when no checkpoint cursor exists |
| `--qitem <id>` | Optional (`1..256` printable bytes) | Exact source `qitemId` filter bound to the checkpoint |
| `--include-qitem-id` | Optional flag (default `false`) | Opt in to exporting `openrig.qitem.id` on transition records |
| `--limit <n>` | `1..128` (default `128`) | Source rows scanned per page |
| `--once` | Optional flag (default `false`) | Run exactly one bounded page/replay step and exit |
| `--poll-ms <ms>` | `10..60000` (default `5000`) | Idle poll interval in continuous mode |
| `--timeout-ms <ms>` | `50..30000` (default `5000`) | Per-request timeout for source `GET` (`<= 128 KiB`) and OTLP `POST` (`<= 64 KiB` response) |
| `--retry-ms <ms>` | `1..10000` (default `250`) | Base exponential backoff delay for retryable OTLP failures |
| `--max-retry-ms <ms>` | `10..60000` (default `5000`, `>= --retry-ms`) | Upper bound for backoff and `Retry-After` headers |
| `--max-retries <n>` | `0..10` (default `3`) | Retry count for `429`/`502`/`503`/`504` and network/timeout errors |
| `--on-permanent-error <mode>` | `stop` (default) or `drop` | Stop with blocked pending batch or visibly drop on non-retryable HTTP `4xx`/`5xx` |
| `--help`, `-h` | Optional flag | Print usage instructions and exit `0` without connecting |

### OTLP logs mapping and privacy allowlists

Each exported batch (`<= 256 KiB`, at most 161 log records) emits one `resourceLogs`
entry with `service.name = "openrig-telemetry-exporter"`, `service.namespace`,
`openrig.source.namespace`, `openrig.source.boot_epoch`, and optional safe
`openrig.source.host_id`, under instrumentation scope
`openrig.telemetry.queue_transitions` (`version: "1"`).

- **Transition records** (`body.stringValue = "openrig.queue.transition"`, `INFO`):
  - `timeUnixNano` is set **only** when `row.createdAt` is a valid UTC ISO-8601
    timestamp; invalid source timestamps omit `timeUnixNano` and emit a separate
    `invalid_timestamp` gap record. `observedTimeUnixNano` always records the page's
    `observedAt` timestamp.
  - Attributes are restricted to `openrig.record.kind = "queue_transition"`,
    `openrig.stream = "queue-transitions"`, decimal string `openrig.transition.id`
    (never converted through `Number`), allowlisted `openrig.queue.state`,
    allowlisted `openrig.identity.provenance`, allowlisted
    `openrig.queue.closure_reason`, opt-in `openrig.qitem.id`,
    `openrig.coverage.status`, `openrig.coverage.history_completeness = "unknown"`,
    and boolean `openrig.delivery.replayed`.
  - Queue bodies, transition notes, `actorSession`, `closureTarget`, raw
    `originalTimestamp`, file paths, environment variables, credentials, invented
    `traceId`/`spanId` parentage, and current-owner/seat joins are never exported or
    written to checkpoints.
  - **Operational metadata note**: `namespace`, `source.hostId`, `source.bootEpoch`,
    and decimal `transitionId` / gap IDs remain exported in OTLP resource and record
    attributes. Raw `qitemId` is exported only when `--include-qitem-id` is set, and
    any `--qitem` filter value is stored locally inside the `0600` checkpoint file to
    verify configuration continuity.
- **Coverage gap records** (`body.stringValue = "openrig.telemetry.gap"`, `WARN`):
  - Carry `observedTimeUnixNano` only (no source event timestamp), with
    `openrig.record.kind = "coverage_gap"`, allowlisted `openrig.gap.code`, optional
    decimal string `openrig.gap.id`, `openrig.gap.from`, `openrig.gap.through`, and
    allowlisted `openrig.gap.field`. When `coverage.gapDetailsTruncated` is true, an
    additional `gap_details_truncated` record reports `openrig.gap.total_count` and
    `openrig.gap.omitted_count`. Unknown schema versions, stream names, or gap codes
    fail visibly (`TelemetrySourceError`) rather than silently skipping records.

### Checkpoints, discontinuities, and receiver outcomes

- **Single process and supervisor model**: Run at most one exporter process per
  `--checkpoint` file (no cross-process file lock is provided). `--once` processes
  exactly one bounded page or pending replay step. Continuous mode exits with code `1`
  on source errors or after bounded OTLP retries (`--max-retries`) are exhausted; use
  an external process supervisor to restart it.
- **Atomic pending checkpoint before export**: When a page produces log records, the
  exporter writes compact JSON (`<= 256 KiB`) containing `pending` (the sanitized
  OTLP batch, `recordCount`, and proposed `nextCursor`) via `fsync` + atomic rename
  **before** sending `POST /v1/logs`. The committed `cursor` advances and `pending`
  clears only after a resolved export outcome.
- **Pause and replay on transient failure**: While `pending` is non-null, source
  polling pauses. After a transient network/timeout or retryable status failure, the
  next run replays the persisted `pending` batch with
  `openrig.delivery.replayed = true`, acknowledging possible duplicate delivery after
  an ambiguous receiver ack rather than claiming exactly-once delivery.
- **Configuration binding**: The checkpoint binds `namespace`, `sourceUrl`,
  `endpointUrl`, `start`, `qitemId`, and `includeQitemId` (keep the same `--start`
  flag when resuming an existing checkpoint). Malformed, oversized, or mismatched
  checkpoints fail visibly (`TelemetryCheckpointError`) without resetting.
- **Empty filtered pages**: When a filtered page scans rows but produces zero
  transition and gap records, the exporter advances and persists `nextCursor`
  immediately without sending an empty OTLP batch.
- **Daemon boot and watermark discontinuities**: When the source reports
  `boot_boundary_history_unverified` or `watermark_regression_history_unverified`
  with a fresh `restartCursor`, the exporter persists and exports that named gap
  record first, then adopts `restartCursor` at the new high watermark, intentionally
  skipping the unverified missed interval while preserving
  `sequenceSpaceId: null` and `historyCompleteness: "unknown"`.
- **OTLP HTTP outcomes**: Both the daemon source and the OTLP receiver must return
  HTTP `200` with `Content-Type: application/json`. HTTP `200` `{}` resolves as
  `exported`. HTTP `200` with protocol `partialSuccess` resolves as `partial_success`
  without whole-batch retry and without echoing raw `errorMessage` strings into
  diagnostics. HTTP `429`/`502`/`503`/`504` and network/timeout errors retry up to
  `--max-retries`, honoring `Retry-After` within `--max-retry-ms`. Per the OTLP/HTTP
  specification, all other HTTP `4xx` and `5xx` status codes (`400..599` except
  `429`/`502`/`503`/`504`) are non-retryable permanent rejections
  (`otlp_permanent_rejection`): they never echo raw response bodies, and under default
  `--on-permanent-error stop` they record `pending.blocked` so subsequent normal runs
  stop immediately without automatically resubmitting the rejected batch (recover by
  correcting the receiver or running explicitly with `--on-permanent-error drop` to
  discard the rejected `4xx`/`5xx` batch and advance). Received nonconforming
  responses — unexpected non-`200` `1xx`–`3xx` (`otlp_unexpected_status`), non-JSON
  `Content-Type` on `200` (`otlp_invalid_content_type`), malformed `200` JSON or
  `partialSuccess` (`otlp_invalid_response`), and oversized `> 64 KiB` responses
  (`otlp_response_too_large`) — are distinguished from missing network acks: they also
  record `pending.blocked` to pause automatic resubmission while keeping the committed
  cursor unchanged, and `--on-permanent-error drop` never silently checkpoints
  uncertain response data away. To discard a batch paused on response uncertainty
  after inspecting and fixing the receiver/proxy, start with a new `--checkpoint` path
  and `--start latest` so the skipped history is recorded as an explicit
  `historical_transitions_not_read` gap.
