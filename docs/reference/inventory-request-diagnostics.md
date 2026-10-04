# Inventory request diagnostics

The private slow-operation log can correlate explicitly marked inventory reads.
This diagnoses future observations; it does not repair a timeout or establish the
cause of an earlier uncorrelated request.

Send exactly one `X-OpenRig-Diagnostic-Attempt` header containing a fresh lowercase
UUIDv4 on a `GET /api/rigs` or `GET /api/rigs/:id/nodes` request. The token is only a
correlation hint. It grants no authority, triggers no retry, and changes neither
the response nor its timeout. Invalid or duplicate tokens are ignored by the
observer. Do not copy the token to incidental identity or health checks.

Records use `schema: openrig.request-phase/v1` in the existing
`logs/slow-operations.jsonl`. Each process has an observation `epoch` and sequence
`seq`. An activation record carries the installed build stamp (null for an
unstamped development build). Each admitted request gets a distinct
`serverRequestId`, even if a caller reuses an `attemptId`. Routes are recorded as
`rigs_list` or `rig_nodes`, never a rig name or full URL.

The phases are:

- `node_arrival`: the existing Node HTTP request listener ran. This is after HTTP
  parsing and JavaScript scheduling, not a socket-arrival timestamp.
- `hono_enter` / `hono_exit`: application middleware started/finished.
- `handler_enter` / `handler_exit`: the actual inventory handler started/finished.
  Gate rejection or read-through may have no local handler entry.
- `sql_begin` / `sql_end`: the root list's SQLite prepare/read, excluding row mapping.
  Other node-inventory queries are not individually traced.
- `response_finish`: Node completed its server-side response writes; this does not
  prove that the client consumed the body.
- `response_close`: records `headersSent`, `writableFinished` and status. A normal
  close after finish is not failure. A premature close does not identify its cause.
- `request_aborted`: only when Node emits that incoming-request event. A GET client
  timeout often appears as response close instead. Handler work can finish later.
- `trace_expired`: diagnostic state expired; the request was not canceled.

`elapsedMs` is process-local monotonic time since observation activation;
`requestElapsedMs` is since the request event. `utc` is a dated anchor. Never
subtract monotonic times across processes. A client's useful counterparts are its
logical start, actual fetch invocation, headers received, body completion, signal
abort and final outcome. Fetch invocation does not prove a socket write.

The existing 250 ms event-loop tick provides bounded recent timing context and
`event_loop_gap` records for tick intervals of at least 500 ms. The gap is reported
when the loop resumes. An indefinite stall or killed process cannot report its
end. This does not change the existing lifetime histogram or health verdict.

Diagnostic limits: 128 admitted requests per monotonic minute, 128 active traces,
16 distinct phases per trace, 60-second observation lifetime, 40 recent ticks,
1 KiB per record and 1024 outstanding diagnostic writes. Overflow drops diagnostic
observations, never requests. The existing 1 MiB log plus three rotated files and
0600 file modes apply. The worker writes asynchronously; HTTP observation never
waits for fsync or the synchronous slow-operation BEGIN barrier.

Records carry cumulative admission/expiry/observer-error counters and writer
`coverage` counters (`offered`, `enqueued`, `dropped`, `acknowledged`, `failed`,
`pending`, `recorderHealthy`). Writer counters describe the state sampled for that
record, not an acknowledgment of that record itself. Retained epoch/sequence
ranges can be read from the current and rotated logs; the log is not an archive.
A missing activation/tail, sequence loss, recorder failure, overflow, expiry or
rotated-away interval makes the corresponding coverage incomplete. Source tests
without the Node raw-request binding cannot establish Node arrival.

Missing arrival is unknown by default. Even a complete covered interval only
establishes that no matching JavaScript request event was observed there; it does
not distinguish a client that never sent from network, parser or event-loop delay.
HTTP status at handler exit is a prepared response, and status at finish/close is
server-side state. Neither replaces the client's header/body receipt.

The new format contains no payloads, auth or raw identity headers, URL parameters,
SQL text, bind values, native identifiers or raw exception messages. Legacy
slow-operation records keep their existing format: their `outcome: ok` indicates
completion of the observed operation and is not an HTTP-success assertion.
