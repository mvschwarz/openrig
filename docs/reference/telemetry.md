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
their behavior. Collector deployment, exporters and durable store epochs are
separate work.

## Independent exporter mapping and limits

OpenRig's telemetry guarantee ends at the finite HTTP/CLI read envelope above. Any
projection of those finite reads (or of cached rig/node inventory) into
OpenTelemetry logs, custom metrics, or spans is defined and owned by an external
consumer or exporter—not guaranteed by OpenRig's core API.

The external OTLP exporter at `smota/openrig-telemetry` applies the following
exporter-specific mapping choices to OpenRig's source facts (other consumers may
make different choices):

- **Recorded queue-state intervals (not execution time)**: In OpenRig, queue
  transition rows record state changes (`pending`, `in-progress`, `blocked`, and
  departure states), not agent execution duration or model latency; the first
  observation of an item has no prior boundary; repeated same-state rows remain
  distinct source records; and any page carrying an ID-range or withheld-record gap
  (`before_retained_floor`, `retained_sequence_gap`, `conflicting_transition_id`,
  `record_byte_limit`, `historical_transitions_not_read`, truncated gap details, or
  a boot/watermark discontinuity) cannot prove what happened in the missing range.
  In `smota/openrig-telemetry`, the exporter pairs an entering state with a later
  departure state to measure only the recorded interval between two observed rows
  with valid, ordered UTC timestamps, suppresses or drops open intervals across gap
  boundaries rather than inventing durations, and reports cumulative transition
  counts only for rows observed from its checkpoint (including historical rows when
  started with `start=retained`), never lifetime daemon totals.
- **No current-owner, seat, tenure, or native-session join**: In OpenRig's finite
  API, the `queue-transitions` stream does not join transition rows to current seat
  owners, mutable node or rig names, occupant tenures (`tenures`), or native
  harness sessions, and it never selects queue bodies or transition notes; each
  transition row does include `qitemId`, `actorSession`, `closureTarget`, and
  `originalTimestamp`. In its exported OTLP output, `smota/openrig-telemetry`
  chooses to emit derived queue spans as root/internal observations without
  invented parent/child trace hierarchy, cross-stream causal links, or `gen_ai.*`
  model/token/cost attributes; places `qitemId` only on opt-in log/span attributes
  rather than metric dimensions; and omits the source fields `actorSession`,
  `closureTarget`, and raw `originalTimestamp` from exported OTLP logs, metrics,
  and spans.
- **Sampling unknowns on cached seat inventory**: OpenRig's cached rig and seat
  inventory endpoints (`GET /api/rigs`, `GET /api/rigs?archived=only`,
  `GET /api/rigs/:rigId/nodes`) return point-in-time daemon projections
  (`activityState.display`, `sessionStatus`, `arbitratedNeedsInput`, and
  `activityState.lastSwap`), not a continuous event stream or independent OS
  process probe; intermediate activity changes or multiple occupant handovers
  between polls are not observable from those snapshots, and initial
  observation has no backfilled history. In OpenRig source,
  `arbitratedNeedsInput` is a tri-state boolean (`true`, `false`, or `null`):
  `true` means the seat needs input, `false` means it was observed clear of
  needing input, and `null` means no evidence exists either way (it does not
  indicate `false`). Separately, external consumers or metric mappings must
  choose how to interpret or project this tri-state value into their own
  metrics or counters. `smota/openrig-telemetry` polls these snapshots as
  point-in-time observations and relies on downstream metric storage to enforce
  freshness/staleness TTL when polling stops or a seat departs.

### External OTLP exporter repository and version compatibility

An independent, standalone OTLP/HTTP exporter is maintained outside OpenRig core at:

- **Repository**: <https://github.com/smota/openrig-telemetry>

Its repository documents installation, configuration, and supported OpenRig versions; OpenRig does not test or guarantee the exporter.

OpenRig's finite telemetry reads are versioned (`schemaVersion: 1`), while cached rig and node inventory endpoints are operational projections rather than a versioned telemetry contract.
