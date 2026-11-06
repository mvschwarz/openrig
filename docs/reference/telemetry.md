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

## Reference OTLP telemetry exporter

`docs/reference/telemetry-otlp.mjs` is an optional, dependency-free Node.js
reference exporter that polls one daemon source namespace's
`/api/telemetry/v1/queue-transitions` stream alongside cached rig/node inventory
(`GET /api/rigs`, `GET /api/rigs?archived=only`, and `GET /api/rigs/:rigId/nodes`)
and exports allowlisted logs, metrics, and traces to a local OTLP/HTTP JSON
receiver: logs at the configured `.../v1/logs` URL, plus metrics and traces at its
sibling `.../v1/metrics` and `.../v1/traces` URLs. It keeps one bounded
page/transaction in flight and uses only Node.js builtins.

The daemon copies `.md` files from `docs/reference/` to `$OPENRIG_HOME/reference/`
on startup; the runnable `.mjs` script is invoked from a repository checkout at
`docs/reference/telemetry-otlp.mjs` or from an installed `@openrig/cli` package at
`daemon/docs/reference/telemetry-otlp.mjs`:

```sh
# From a repository checkout (one bounded queue + seat-inventory step across all signals)
node docs/reference/telemetry-otlp.mjs \
  --source http://127.0.0.1:7433 \
  --endpoint http://127.0.0.1:4318/v1/logs \
  --checkpoint /var/tmp/openrig-telemetry-checkpoint.json \
  --namespace example-source \
  --start retained \
  --pseudonymize-seats \
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
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

### CLI flags and bounds

| Flag | Bound / default | Purpose |
| --- | --- | --- |
| `--source <url>` | Required (`http:`/`https:`, no credentials/query; default daemon port `7433`) | Daemon root URL or exact `/api/telemetry/v1/queue-transitions` URL (inventory origin derived automatically) |
| `--endpoint <url>` | Required (`http:`/`https:`, path ending in `/v1/logs`, no credentials/query) | Complete OTLP/HTTP JSON logs receiver URL (`/v1/metrics` and `/v1/traces` derived as siblings) |
| `--checkpoint <path>` | Required (regular file, compact JSON `<= 4 MiB`, one process per file) | Durable checkpoint and pending-batch file path |
| `--namespace <name>` | Required (`1..128` ASCII identifier bytes `[A-Za-z0-9._:-]`) | Source namespace bound to resource/scope and checkpoint |
| `--signals <list>` | Comma list of `logs`, `metrics`, `traces` (default all three; bound into the checkpoint) | Signals to export. With neither metrics nor traces, queue-interval state is not tracked; `--signals logs` exports queue transition, tenure-change, gap, and failure logs; `--signals traces` retains failure-ledger entries locally without draining them |
| `--rig <rigId>` | Optional, repeatable (`1..32` safe immutable rig IDs `1..256` bytes; bound into checkpoint) | Restrict seat inventory sampling to specific immutable rig IDs (default: all active rigs from `GET /api/rigs`) |
| `--pseudonymize-seats` | Optional flag (default `false`; bound into checkpoint) | HMAC-pseudonymize `openrig.seat.node_id` and tenure generation attributes using the checkpoint's persistent `hmacSalt` |
| `--start <mode>` | `latest` (default) or `retained` (bound into checkpoint config; keep same on resume) | Initial window mode when no checkpoint cursor exists |
| `--qitem <id>` | Optional (`1..256` printable bytes) | Exact source `qitemId` filter bound to the checkpoint |
| `--include-qitem-id` | Optional flag (default `false`) | Opt in to exporting `openrig.qitem.id` on transition logs and interval spans (never as a metric label) |
| `--limit <n>` | `1..128` (default `128`) | Source rows scanned per page |
| `--once` | Optional flag (default `false`) | Run exactly one bounded queue page and full configured seat-inventory cycle (or pending replay step) and exit |
| `--poll-ms <ms>` | `10..60000` (default `5000`) | Idle queue poll interval in continuous mode |
| `--seat-poll-ms <ms>` | `10..600000` (default `30000`) | Seat inventory sampling cadence in continuous mode |
| `--timeout-ms <ms>` | `50..30000` (default `5000`) | Per-request timeout for source `GET` (`<= 128 KiB` telemetry page, `<= 512 KiB` cached inventory) and OTLP `POST` (`<= 2 MiB` batch, `<= 64 KiB` response) |
| `--retry-ms <ms>` | `1..10000` (default `250`) | Base exponential backoff delay for retryable OTLP failures |
| `--max-retry-ms <ms>` | `10..60000` (default `5000`, `>= --retry-ms`) | Upper bound for backoff and `Retry-After` headers |
| `--max-retries <n>` | `0..10` (default `3`) | Retry count for `429`/`502`/`503`/`504` and network/timeout errors |
| `--on-permanent-error <mode>` | `stop` (default) or `drop` | Stop with blocked pending batch or visibly drop on non-retryable HTTP `4xx`/`5xx` |
| `--help`, `-h` | Optional flag | Print usage instructions and exit `0` without connecting |

### OTLP logs mapping and privacy allowlists

Every signal shares one stable resource: `service.name =
"openrig-telemetry-exporter"`, `service.namespace`, `openrig.source.namespace`,
`service.instance.id` (a random UUID persisted in the checkpoint; a new checkpoint is
a new instance) and an optional safe `openrig.source.host_id`. The daemon
`bootEpoch` is **not** part of resource identity, so an ordinary daemon restart does
not split metric series; it is carried as `openrig.source.boot_epoch` on every log
record. Each logs batch (`<= 2 MiB`, at most 448 records: up to 128 transitions,
33 source gap/truncation records, 256 observed seat tenure-change records, 3
interval notes, 1 ledger-overflow record, and 27 drained failure-ledger records)
emits one `resourceLogs` entry under instrumentation scope
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
    `openrig.source.boot_epoch`, and boolean `openrig.delivery.replayed`.
  - Queue bodies, transition notes, `actorSession`, `closureTarget`, raw
    `originalTimestamp`, file paths, environment variables, credentials, invented
    `traceId`/`spanId` parentage, and current-owner/seat joins are never exported or
    written to checkpoints.
- **Observed seat tenure-change records** (`body.stringValue = "openrig.seat.tenure_change.observed"`, `INFO`):
  - Derived from cached node inventory `activityState.lastSwap` (`{ generation, at } | null`).
  - The first non-null `lastSwap.generation` observed for an immutable `nodeId`
    establishes that seat's baseline in `checkpoint.seats` without emitting a
    tenure-change log (initial observation is not a handover). A `null` `lastSwap`
    is unknown: it neither clears a known baseline nor emits a log. A refreshed
    `lastSwap.at` with the same `lastSwap.generation` does not emit a log.
  - When a seat with a known baseline `generation A` is later observed with
    `generation B` (`B !== A`), the exporter emits one structured log record with
    `openrig.record.kind = "seat_tenure_change"`, `openrig.seat.node_id` (HMAC
    digest when `--pseudonymize-seats` is enabled), optional allowlisted
    `openrig.seat.runtime`, `openrig.tenure.prior_generation`,
    `openrig.tenure.new_generation`,
    `openrig.tenure.continuity = "intermediate_changes_unknown"`, and
    `openrig.tenure.intermediate_changes_unknown = true` (`timeUnixNano` set from
    `lastSwap.at` when valid UTC ISO-8601, plus `observedTimeUnixNano`). Inventory
    `lastSwap.generation` is not claimed to equal finite-tenure `generationUuid`,
    and intermediate swaps between samples are unknown. The new baseline is adopted
    only after all active signals in the transaction resolve.
- **Coverage gap records** (`body.stringValue = "openrig.telemetry.gap"`, `WARN`):
  - Carry `observedTimeUnixNano` only (no source event timestamp), with
    `openrig.record.kind = "coverage_gap"`, allowlisted `openrig.gap.code`, optional
    decimal string `openrig.gap.id`, `openrig.gap.from`, `openrig.gap.through`, and
    allowlisted `openrig.gap.field`. When `coverage.gapDetailsTruncated` is true, an
    additional `gap_details_truncated` record reports `openrig.gap.total_count` and
    `openrig.gap.omitted_count`. Unknown schema versions, stream names, or gap codes
    fail visibly (`TelemetrySourceError`) rather than silently skipping records.

### Cached seat metrics, departure reconciliation, queue metrics and spans

Metrics use scope `openrig.telemetry.metrics` and traces `openrig.telemetry.traces`
(both `version: "1"`). Queue counters and histograms are **cumulative**
(`aggregationTemporality = 2`) with decimal-string int64 values and a fixed
`startTimeUnixNano` (`metricsStartUnixNano`, set when the checkpoint is created and
never changed). Seat metrics are sampled **gauges** (`NumberDataPoint` with decimal
`asInt` strings or OTLP staleness `flags = 1`). Each metrics batch is bounded at
`<= 2 MiB` and at most `5376` dataPoints (covering up to 256 active seats and up to
256 departed/replaced or runtime-changed stale seat series at 10 points each = 5120
seat points, plus up to 122 cumulative queue metric points); each traces batch is
bounded at `<= 2 MiB` and at most `128` spans. Dimensions come only from fixed
allowlists: queue IDs, native-session IDs, mutable seat/rig names, pod placement,
model names, paths, and free text are never metric labels.

| Metric | Type / unit | Dimensions |
| --- | --- | --- |
| `openrig.seat.activity` | Gauge (4-state one-hot `0`/`1`), `{seat}` | `openrig.seat.node_id`, `openrig.seat.state` (`working`, `idle`, `needs-input`, `unknown`), optional `openrig.seat.runtime` |
| `openrig.seat.presence` | Gauge (5-state one-hot `0`/`1`), `{seat}` | `openrig.seat.node_id`, `openrig.seat.status` (`running`, `exited`, `stopped`, `detached`, `unknown`), optional `openrig.seat.runtime` |
| `openrig.seat.needs_input` | Gauge (observed count), `{request}` | `openrig.seat.node_id`, optional `openrig.seat.runtime` |
| `openrig.queue.transition.observed` | Monotonic sum, `{transition}` | `openrig.queue.state`, `openrig.queue.closure_reason` (omitted when none) |
| `openrig.queue.state.duration` | Histogram, `s`; bounds `1,5,15,60,300,900,3600,14400,86400,604800` | `openrig.queue.state` (`pending`, `in-progress`, `blocked`), `openrig.queue.departure_state` |
| `openrig.telemetry.coverage.gap` | Monotonic sum, `{gap}` | `openrig.gap.code` (source codes plus `page_intervals_suppressed`, `open_interval_evicted`, `invalid_interval_boundary`) |
| `openrig.telemetry.failure` | Monotonic sum, `{failure}` | `openrig.failure.stage` (`source`, `export`, `ledger`), `openrig.failure.category` (closed list) |

**Cached seat inventory sampling and departure reconciliation:**
- **Cached reads only**: The exporter reads `GET /api/rigs` (up to 32 rigs),
  `GET /api/rigs?archived=only` when a configured or previously known rig is absent
  from the active list, and `GET /api/rigs/:rigId/nodes` (up to 64 seats per rig,
  256 known seats overall). It **never** passes `?full=true` or `?refresh=true`.
- **Direct server display & stopped-seat guard**: `openrig.seat.activity` consumes
  `activityState.display` (`working`, `idle`, `needs-input`, `unknown`) directly
  without a client-side classifier; `null` or missing `activityState` maps to
  `unknown`. `openrig.seat.presence` maps projected `sessionStatus` (`running`,
  `exited`, `stopped`, `detached`, `unknown`), never `lifecycleState`, and claims
  projected inventory session status rather than independent OS process proof. A
  non-`running` seat (`stopped`, `exited`, `detached`, `unknown`) never emits
  `idle = 1` even if a stale cached `activityState.display` reports `idle`.
- **Evidence-backed `needs_input` count**: `openrig.seat.needs_input` emits a
  positive integer only when `arbitratedNeedsInput === true` (`count > 0`) and
  emits `"0"` only when `arbitratedNeedsInput === false` (`count === 0`). When
  `arbitratedNeedsInput` is `null`/`undefined` (default `count: 0` without
  evidence), the metric point is omitted so unsupported runtimes never report a
  false zero (`needsInput.reason` is never exported). If a seat that previously
  exported an observed `needs_input` value later becomes unsupported while still
  present, the exporter emits a single OTLP `flags = 1` (`NoRecordedValue`) point
  on `openrig.seat.needs_input` without deleting seat topology.
- **Complete-inventory departure reconciliation and OTLP `flags = 1` staleness**:
  A known seat is reconciled as departed **only** when a complete `200 OK`
  `GET /api/rigs/:rigId/nodes` array for its rig omits that `nodeId`, or when its
  rig is confirmed archived in `GET /api/rigs?archived=only`. On departure or rig
  archive, the exporter emits one final batch of OTLP `flags = 1`
  (`NoRecordedValue`, no `asInt` value) points for that seat's series and then
  removes it from `checkpoint.seats.known` so no steady samples follow. Recreating a
  seat with the same mutable name (`logicalId`) but a new `nodeId` starts a fresh
  series and tenure baseline. If a configured rig or a rig with previously known
  seats (whether scoped via `--rig` or discovered in default unscoped mode) is
  absent from **both** `GET /api/rigs` and `GET /api/rigs?archived=only`, the
  exporter does **not** infer confirmed archive or node deletion and does not query
  `/api/rigs/:rigId/nodes` for that missing rig: it retains the missing rig's seat
  baselines in `checkpoint.seats.known` (within the 256-seat cap) without emitting
  false `flags = 1` departure markers or invented idle/presence points, continues
  sampling all other healthy active rigs normally, records an allowlisted
  `source`/`configured_rig_not_found` failure in the durable ledger, and resumes
  sampling under the same seat identity and tenure baseline if the rig reappears (if
  a rig was permanently removed without archiving, start with a new `--checkpoint`
  path to clear its retained baseline). Inventory HTTP or bound failures
  (`source_http_error`, `invalid_inventory_response`, `inventory_limit_exceeded`)
  similarly record an allowlisted `source` failure in the durable ledger and
  preserve the prior `checkpoint.seats` baseline without emitting false departures.
- **Sample timestamps, freshness, and backend retention limits**: Seat gauge points
  carry the sample cycle's `timeUnixNano` (monotonic per checkpoint). First
  observation has no backfilled idle history. Because `checkpoint.seats` adopts
  `derived.seats` when a transaction resolves under `exported`, `partial_success`,
  or `dropped_permanent_rejection`, one-shot OTLP `flags = 1` (`NoRecordedValue`)
  staleness markers are **never retried** if the `/v1/metrics` batch resolves with
  `partialSuccess` (`rejectedDataPoints > 0` does not identify which specific points
  the receiver rejected) or is explicitly dropped via `--on-permanent-error drop`.
  While the OTLP Collector accepts `flags = 1` staleness markers, downstream TSDBs
  and dashboards **must** configure their own staleness/freshness TTL (for example
  Prometheus ~5m lookback delta) so series expire if the exporter stops or a final
  staleness point is partially rejected or dropped.

Counts on queue sums mean **records this exporter collected**, never lifetime
totals and never transitions that happened today: a `--start retained` run counts
historical rows when it reads them.

**Recorded state intervals.** Only `pending`, `in-progress` and `blocked` open an
interval, held in a checkpoint map of at most 512 entries keyed by a keyed hash of
the queue item ID (the raw ID is never stored). A different state with both source
timestamps valid and ordered completes the interval: one histogram observation and
one root `INTERNAL` span `openrig.queue.state` (`openrig.queue.state`,
`openrig.queue.departure_state`, decimal `openrig.transition.enter_id` and
`openrig.transition.depart_id`, opt-in `openrig.qitem.id`). Trace and span IDs are
generated once when the batch is built and persisted, so a replay re-sends the same
IDs. Spans have no parent, links or `gen_ai.*` attributes, and no seat, owner,
actor or tenure join is made: the transitions stream does not establish one. These
are recorded queue-state durations, not agent execution time.

- A repeated same-state row keeps the original entry and time.
- A null, invalid or reversed timestamp, or an unknown state, drops that item's open
  interval and raises `invalid_interval_boundary`; no duration is invented. The first
  observation of an item has no earlier boundary, so a first `done` has no interval.
- A page with any ID-range or withheld-record gap (`before_retained_floor`,
  `retained_sequence_gap`, `conflicting_transition_id`, `record_byte_limit`,
  `historical_transitions_not_read`, truncated gap details, boot/regression
  discontinuity) or an unkeyable or non-ascending row is **suppressed as a whole**:
  the open map is cleared and that page neither completes nor opens an interval, so
  no duration can span rows the source did not return. This is deliberately
  conservative and loses some valid durations. Row-local gaps
  (`oversized_field`, `invalid_type`, `invalid_timestamp`) do not suppress the page.
  Suppression is reported as `page_intervals_suppressed` only when it discarded
  something.
- When the map is full the entry with the lowest entering transition ID is evicted
  (`open_interval_evicted`); an evicted interval can never complete.

### Failure ledger

Failures are written to a bounded durable ledger in the checkpoint, even when the
receiver is down: source read/validation failures, retry exhaustion, permanent
rejections, response-uncertainty blocks, partial-success outcomes and explicit
drops. Entries hold only a closed `stage`/`category`, an optional signal and an item
count, never raw error text, HTTP bodies or `errorMessage`. The ledger keeps 32
entries; further failures increase an explicit `dropped` count (reported as
`ledger`/`diagnostic_ledger_overflow`). When `logs` or `metrics` is enabled, they are
exported on the next transaction as `openrig.telemetry.failure` logs (at most 27 per
page, the rest on later pages) and increments of `openrig.telemetry.failure`. An
entry is removed only when the transaction that reported it is adopted, and failures
observed while a transaction is pending stay for the next one, so none is lost or
counted twice. Under `--signals traces` (where neither `logs` nor `metrics` is
enabled), ledger entries remain preserved in `checkpoint.ledger` without being
silently drained. Re-running an already blocked batch is not a new failure. Local
`onDiagnostic` output is unchanged.

### Checkpoints, discontinuities, and receiver outcomes

- **Single process and supervisor model**: Run at most one exporter process per
  `--checkpoint` file (no cross-process file lock is provided). `--once` processes
  exactly one bounded page or pending replay step. Continuous mode exits with code `1`
  on source errors or after bounded OTLP retries (`--max-retries`) are exhausted; use
  an external process supervisor to restart it. Operator `SIGINT`/`SIGTERM` aborts
  in-flight HTTP requests or retry backoffs cleanly (CLI exit code `0`) without
  retrying or appending a failure-ledger entry, preserving any persisted `pending`
  transaction on disk for replay on the next start. In continuous mode, replaying a
  `pending` transaction on startup or after an outage does not consume the
  `--seat-poll-ms` seat-inventory cadence, so the exporter samples seat inventory
  immediately on the next fresh source page after recovery.
- **Atomic pending checkpoint before export**: When a cycle produces exportable batches,
  the exporter writes compact JSON (`<= 4 MiB`, `schemaVersion: 2`) containing
  `instanceId`, `metricsStartUnixNano`, a private `hmacSalt`, the derived `queue`
  and `seats` observation state, the failure `ledger`, and `pending` (proposed
  `nextCursor`, the proposed derived `derived.queue` and `derived.seats` state,
  accumulated `diagnostics`, and independent `signals.logs`, `signals.metrics`, and
  `signals.traces` entries with `itemCount`, `attempted`, `outcome`, `rejectedCount`,
  `blocked`, and payload) via `fsync` + atomic rename **before** network export. Each
  signal's `attempted` marker is persisted before its HTTP request and its resolved
  outcome is persisted before starting the next signal. The committed `cursor`,
  open intervals, seat baselines, and cumulative aggregates advance and `pending`
  clears only after all active signals in the transaction resolve; ingestion pauses
  while a transaction is pending.
- **Pause and replay on transient failure**: While `pending` is non-null, source
  polling pauses. After a transient network/timeout or retryable status failure, the
  next run replays only unresolved signals (`outcome === null`), preserving already
  accepted signals without re-sending them and marking replayed log records with
  `openrig.delivery.replayed = true`.
- **Configuration binding and receiver pipeline requirements**: By default
  (`--signals logs,metrics,traces`), the exporter posts to all three OTLP/HTTP JSON
  paths (`/v1/logs`, `/v1/metrics`, and `/v1/traces`), so the receiver/Collector must
  expose all three pipelines unless `--signals` is restricted when the checkpoint is
  first created. The checkpoint permanently binds `namespace`, `sourceUrl`,
  `endpointUrl`, `start`, `qitemId`, `includeQitemId`, `signals`, `--rig` scopes,
  and `--pseudonymize-seats` (keep the exact same bound flags when resuming an
  existing checkpoint; changing `--signals` against an existing checkpoint is
  refused with `checkpoint_config_mismatch`, even to narrow signals after a receiver
  `404` on `/v1/metrics` or `/v1/traces`). Schema version `1`, malformed, oversized,
  or mismatched checkpoints fail visibly (`TelemetryCheckpointError`) without
  resetting.
- **Empty filtered pages**: When a filtered page scans rows but produces zero
  transition and gap records, the exporter advances and persists `nextCursor`
  immediately without sending an empty OTLP batch.
- **Daemon boot and watermark discontinuities**: When the source reports
  `boot_boundary_history_unverified` or `watermark_regression_history_unverified`
  with a fresh `restartCursor`, the exporter persists and exports that named gap
  record first, then adopts `restartCursor` at the new high watermark, intentionally
  skipping the unverified missed interval while preserving
  `sequenceSpaceId: null` and `historyCompleteness: "unknown"`.
- **OTLP HTTP outcomes and blocked-batch recovery**: Both the daemon source and the
  OTLP receiver must return HTTP `200` with `Content-Type: application/json`. HTTP
  `200` `{}` resolves as `exported`. HTTP `200` with protocol `partialSuccess`
  (`rejectedLogRecords`, `rejectedDataPoints`, or `rejectedSpans` per signal)
  resolves as `partial_success` without whole-batch retry and without echoing raw
  `errorMessage` strings into diagnostics. HTTP `429`/`502`/`503`/`504` and
  network/timeout errors retry up to `--max-retries`, honoring `Retry-After` within
  `--max-retry-ms`. Per the OTLP/HTTP specification, all other HTTP `4xx` and `5xx`
  status codes (`400..599` except `429`/`502`/`503`/`504`) are non-retryable
  permanent rejections (`otlp_permanent_rejection`): they never echo raw response
  bodies, and under default `--on-permanent-error stop` they record
  `pending.signals.<signal>.blocked` so subsequent normal runs stop immediately
  without automatically resubmitting the rejected batch. To recover a batch blocked
  on a permanent rejection (such as HTTP `404`/`400` when a receiver is missing
  `/v1/metrics` or `/v1/traces`), either enable the missing pipeline on the receiver
  or run explicitly with `--on-permanent-error drop` while keeping the **same**
  bound `--signals` and checkpoint flags (already-accepted signals such as `/v1/logs`
  are not resent, and `drop` discards only the rejected signal batch to advance).
  Received nonconforming responses — unexpected non-`200` `1xx`–`3xx`
  (`otlp_unexpected_status`), non-JSON `Content-Type` on `200`
  (`otlp_invalid_content_type`), malformed `200` JSON or `partialSuccess`
  (`otlp_invalid_response`), and oversized `> 64 KiB` responses
  (`otlp_response_too_large`) — are distinguished from missing network acks: they
  also record `pending.signals.<signal>.blocked` to pause automatic resubmission
  while keeping the committed cursor unchanged, and `--on-permanent-error drop`
  never silently checkpoints uncertain response data away. To start fresh after
  response uncertainty or to change the bound `--signals` set, point `--checkpoint`
  at a new file path: note that a new checkpoint creates a new
  `service.instance.id`, `metricsStartUnixNano` cumulative series epoch, and fresh
  seat-tenure baseline, and either records `historical_transitions_not_read` at the
  current high watermark (`--start latest`) or re-reads retained transitions
  (`--start retained`).
