---
kind: as-built
title: Coordination Primitive — Stream/Queue/Inbox/Outbox
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator]
applies-when: |
  Need to know how the daemon-backed coordination primitive works — the
  stream/queue/inbox/outbox tables, the hot-potato closure contract, the
  transactional handoff guarantee, or where queue closure is enforced.
siblings: [workflow-runtime.md, mission-control.md, daemon-core.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: fcaf1f8ee8f09bfc6388b937ea426e3d9496bb05
last-updated: 2026-10-05
---

# Coordination Primitive — Stream/Queue/Inbox/Outbox

The coordination primitive is the SQLite-canonical durable-work layer the
daemon exposes through `/api/stream` and `/api/queue`. It replaces the POC
filesystem `rigx queue` / `rigx stream` path for daemon-backed work; the POC
filesystem path remains untouched, and the daemon-backed `rig queue` /
`rig stream` commands operate only through the daemon HTTP API, so they write
only to SQLite (`packages/cli/src/commands/queue.ts:19`,
`packages/cli/src/commands/stream.ts:11`).

> Verified against source at main `fcaf1f8ee8f09bfc6388b937ea426e3d9496bb05`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The five host-scoped tables

Five host-scoped tables back the primitive, one per migration `023`–`027` in
`packages/daemon/src/db/migrations/` (**5** tables:
`cat packages/daemon/src/db/migrations/02[3-7]_*.ts | grep -c 'CREATE TABLE'`):

- **`stream_items`** (`023_stream_items.ts`) — L1 append-only intake/audit
  root. Columns: `stream_item_id` (TEXT PK; a ULID unless the caller supplies
  one, `packages/daemon/src/domain/stream-store.ts:88`), `ts_emitted`,
  `stream_sort_key`, `source_session`, `body`, `format` (default `text`),
  `hint_type`, `hint_urgency`, `hint_destination`, `hint_tags` (JSON),
  `interrupt`, `archived_at`, and `identity_provenance` (added by
  `067_i3_identity_provenance.ts`). Items immutable after emit (only
  `archived_at` may be set, `stream-store.ts:217`).
- **`queue_items`** (`024_queue_items.ts`) — L3 owned-work queue.
  Unless `--id` is supplied, the CLI generates the create request's `qitem_id` (TEXT PK) before sending as `qitem-<UTC YYYYMMDDHHMMSS>-<16 hex>` (64 random bits) and prints it to stderr as a request identity, not proof of persistence; reuse that ID with `--id` and the unchanged payload after an unknown outcome, while daemon callers without an ID still use `newQitemId()` and its `qitem-<UTC YYYYMMDDHHMMSS>-<8 hex>` form.
  State enum (**8** values, `QUEUE_STATES` at `queue-repository.ts:32`;
  `sed -n '/^export const QUEUE_STATES/,/] as const/p' packages/daemon/src/domain/queue-repository.ts | grep -c '^  "'`):
  `pending | in-progress | done | blocked | failed | denied | canceled |
  handed-off`. Carries `closure_reason`, `closure_target`,
  `closure_required_at`, `chain_of_record` (JSON), `blocked_on`,
  `handed_off_to`/`handed_off_from`, nudge/heartbeat columns.
- **`queue_transitions`** (`025_queue_transitions.ts`) — L3 append-only
  transition log; authoritative audit trail for state evolution. Domain code
  never updates its rows. The one delete is the retention runner, which moves
  every transition of a terminal item whose last transition is older than the
  retention window into `queue_transitions_archive`
  (`054_queue_transitions_archive.ts`), insert and delete in one transaction
  (`packages/daemon/src/domain/queue-retention.ts:203`). Only `done` and
  `handed-off` items are archived; the default window is 30 days, and items
  still on a live workflow frontier are skipped (`queue-retention.ts:69`–`75`,
  `:158`–`171`).
- **`inbox_entries`** (`026_inbox_entries.ts`) — mailbox-style asynchronous
  deposit; idempotent on `inbox_id`. State: `pending | absorbed | denied`
  (`INBOX_STATES`, `inbox-handler.ts:5`).
- **`outbox_entries`** (`027_outbox_entries.ts`) — sender-side record;
  symmetric to inbox; idempotent on `outbox_id`. Delivery state (**7** values,
  `OUTBOX_DELIVERY_STATES` at `outbox-handler.ts:28`;
  `grep '^export const OUTBOX_DELIVERY_STATES' packages/daemon/src/domain/outbox-handler.ts | grep -o '"[a-z]*"' | wc -l`):
  `pending | sending | delivered | failed | indeterminate | retained |
  retired`.

These five are migrations `023`–`027` of the daemon's **94**
(`git ls-files packages/daemon/src/db/migrations | wc -l`), applied in the
order of `ALL_MIGRATIONS` (`packages/daemon/src/db/all-migrations.ts:105`).
Later migrations add columns to these tables; `daemon-core.md` covers the
migration set.

## 2. The six host-scoped services

Six host-scoped domain services in `packages/daemon/src/domain/` implement the
layer (**6** files:
`ls packages/daemon/src/domain/{stream-store,queue-repository,queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts | wc -l`).
Routes import these; services are Hono-free:

- **`stream-store.ts`** — L1 stream: idempotent emit (on `stream_item_id`),
  chronological list with cursor pagination plus source, destination, exact-tag,
  and inclusive time-window filters, soft archive. `direction=latest` applies
  every filter before taking the newest bounded page, then returns that page
  chronologically.
- **`queue-repository.ts`** — L3 queue: create (`:1391`), claim/unclaim
  (`:2186`, `:2268`), update (general state mutator with hot-potato
  strict-rejection on `done`, `:2331`), transactional handoff (close source as
  `handed-off` plus create new owned qitem in a single transaction, `:1656`;
  `handoffAndComplete`, `:1833`, closes the source as `done` instead),
  pod-fallback rerouting (`routeToFallback`, `:3653`), overdue lookup
  (`findOverdue`, `:3354`), nudge-result tracking (`recordNudgeAttempt`,
  `:3638`). Nothing in the daemon writes the `last_heartbeat` column
  (`queue-pickup.ts:16`). Cross-rig validation hook exposed as `validateRig`
  constructor option (`queue-repository.ts:711`).
- **`queue-transition-log.ts`** — append-only state-transition log; used by
  `queue-repository.ts`, exposed as the read-only property
  `QueueRepository.transitionLog` (`queue-repository.ts:660`).
- **`hot-potato-enforcer.ts`** — pure validator for the load-bearing API
  contract (see §3).
- **`inbox-handler.ts`** — mailbox handler: drop (idempotent on `inbox_id`,
  `:99`), absorb (promotes a pending entry to a `queue_item`, idempotent,
  `:154`), deny (records reason, `:214`). The handler has no auth hook
  (`inbox-handler.ts:71`); identity comes from the route. `POST /inbox/drop`
  takes the sender only from the `X-OpenRig-Session` header through
  `requireSenderIdentity` (`routes/queue.ts:1094`) and answers 400
  `actor_required` without it. Absorb and deny (`:1121`, `:1135`) use the
  header when present; otherwise they accept the body's `receiverSession` and
  record it as `claimed:v1` (`routes/require-sender-identity.ts:83`–`92`).
- **`outbox-handler.ts`** — sender-side outbox: idempotent record (`:130`),
  delivery-state marks (`markDelivered` `:239`, `markFailed` `:256`,
  `markIndeterminate` `:280`), list (`listForSender` `:339`). It also holds the
  queue's durable wake intents (ids prefixed `wake-intent-`, `:15`) and the
  messages the seat delivery guard retains (`retain` `:181`, `retire` `:217`),
  so it is not audit-only. Emits no event-bus events.

Create, handoff and handoff-and-complete return the committed row without
waiting for terminal delivery. Each stages a deterministic
`wake-intent-<qitem>` outbox row in its transaction and delivers it after
commit (`queue-repository.ts:1404`–`1416`, `:1467`–`1475`). The returned
`lastNudgeResult` is therefore normally null; `rig queue show <id>` reads the
wake result later. If create cannot retain the intent, the task is still saved
and the row records `failed:wake not retained: <reason>`. Startup reconciles
and drains intents left pending by a crash once (`startup.ts:2334`–`2335`).
`maybeNudge` remains only as the path for a repository with no outbox.

The standing detector in `queue-stuck-sweep.ts` creates findings through the
queue repository, with `evidenceRef: rig queue show <source-qitem-id>`
(`queue-stuck-sweep.ts:605`) pointing to the underlying durable work row. This
satisfies the existing human-route evidence contract without changing
destination resolution: a finding goes to the destination's orchestrator when
one is derivable, otherwise to the destination itself, and that seat may be
dead. Repeated detections refresh the existing finding; when the source
condition resolves, the sweep closes its own finding (`:612`–`637`). The sweep
reports six finding kinds (`:50`). Its custody check covers closures that name
a successor qitem or a seat (`closure_reason = handed_off_to`) in the last 24
hours; a seat target is satisfied by a local successor carrying this row's
lineage, and any target by a `custody-verified: <target> …` note on the closed
row (`:168`–`244`, `:519`–`554`).

## 3. The hot-potato closure contract (where queue closure is enforced)

`hot-potato-enforcer.ts` is the pure validator for the load-bearing API
contract. `validateClosure` (`hot-potato-enforcer.ts:59`) checks a transition
against `CLOSURE_REASONS` (`:18`; **7** values:
`sed -n '/^export const CLOSURE_REASONS/,/] as const/p' packages/daemon/src/domain/hot-potato-enforcer.ts | grep -c '^  "'`):

`state=done` requires `closure_reason ∈ {handed_off_to, blocked_on, denied,
canceled, no-follow-on, escalation, superseded}`. The reasons
`handed_off_to | blocked_on | escalation` additionally require
`closure_target` (`:86`):

- `handed_off_to` — work continues with a different seat (`closure_target` =
  new owner).
- `blocked_on` — work is parked pending another qitem (`closure_target` =
  blocker `qitem_id`).
- `denied` — receiver rejected the work (`closure_target` = reason text).
- `canceled` — sender or receiver withdrew (`closure_target` = note).
- `no-follow-on` — terminal completion, nothing else needed.
- `escalation` — kicked up to a higher tier (`closure_target` = escalation
  target).
- `superseded` — the row was replaced by cancel-and-replace
  (`closure_target` = the successor qitem). The update path records it on
  `state=canceled` and refuses it there without a `closure_target`
  (`queue-repository.ts:2597`).

Tier→SLA mapping for `closure_required_at` also lives in
`hot-potato-enforcer.ts` (`TIER_SLA_SECONDS`, `:114`). This validator is
invoked by `QueueRepository.update()` (and `updateWithinTransaction()`), both
through the call at `queue-repository.ts:2505`, so closure is enforced at the
daemon transaction boundary — the workflow runtime *projects* on closure but
does not otherwise gate it (see `workflow-runtime.md`). The one
workflow-aware check is in the queue: `update()` refuses a terminal close of a
live workflow frontier packet from a non-workflow verb
(`workflow_frontier_packet`, `queue-repository.ts:2531`), through a predicate
startup injects. "Terminal" there is the queue's terminal set, `done` and
`handed-off` (`queue-repository.ts:51`).

Closure fields are stored only on `state=done`, the park record (`blocked`
with `blocked_on`), the handoff close (`handed-off` with `handed_off_to`) and
the superseded cancel; any other transition carrying them is refused with
`closure_fields_not_admitted`, and `blocked_on` outside `blocked` with
`blocked_on_not_admitted`. A `done`, `canceled` or `handed-off` row accepts a
note without a state change as an append-only transition; moving it to
another state requires an explicit reopen with a note. A `qitem-` blocker must
exist and be live on this daemon; when a blocker leaves the active states,
each row parked on it follows the blocker's handoff successor or returns to
`pending` with a durable wake (`queue-repository.ts:2384`–`2503`,
`:2580`–`2624`, `:2903`–`2980`). `human-route-enforcer.ts` is a second pure
validator at the same boundary: a `human-gate` row, a row addressed to a human
seat, or a park on one must carry `summary` and `evidence_ref`.

## 3b. Cross-host queue routing

Three queue write routes are host-aware — `POST /create`,
`POST /:qitemId/handoff` and `POST /:qitemId/handoff-and-complete` (**3**:
`grep -c '!resolvesToLocalHost(body.hostId, getSelfHostId())' packages/daemon/src/routes/queue.ts`):
a write body may carry an out-of-band `hostId` envelope. The destination
session stays `member@rig`; the 3-part `agent@rig@host` form is CLI input
sugar that `resolveQueueHostDestination`
(`packages/cli/src/commands/queue.ts:391`) splits into the destination and
`hostId` before the request leaves the CLI. The same split applies to
`--host <id>`; queue verbs never follow `rig host select`, and naming two
different hosts is refused with `host_qualifier_conflict`. The mechanism
follows the forward-then-strip shape of mission-control's remote action
(`routes/mission-control.ts:352`): one shared route-layer helper
(`forwardQueueWrite`, `routes/queue.ts:214`) resolves the host registry
daemon-side (bearers never reach the caller), rejects ssh-declared hosts
(`unsupported-transport` — the daemon→daemon path is http-only), and forwards
the whole body, with `hostId` stripped, via `remoteJsonRequest` (`:248`) under
a named write-class deadline (`QUEUE_FORWARD_TIMEOUT_MS`, `:41`). The origin's
response returns verbatim; failures map to a structured host-named error
(`remote_queue_write_failed`, HTTP 502, `:234`) whose `failureClass` is one of
registry / unknown-host / unsupported-transport / unreachable / auth-failed /
remote-error. No local row is ever written on the cross-host path.

**The model: origin-owns-the-record, at-least-once + idempotent,
message-passing closure (never 2PC).**

- **Origin-owns-the-record.** The qitem lives in the TARGET host's DB; that
  row is THE record. The target daemon wakes the destination on ITS local
  tmux: its own `create` stages a durable wake intent and delivers it after
  commit (§2; the forwarded body carries the `nudge` flag) — the sending
  daemon never reaches across a host boundary. Before forwarding, the
  forwarding daemon stamps its own host id, when it has one, onto the source
  session (`stampSelfHostSuffix`, `queue-repository.ts:542`; called at
  `routes/queue.ts:378` and `:509`), so the target row records the sender as
  `member@rig@<forwarding host>`.
- **Idempotency.** On create, the forwarding daemon mints the `qitemId` before
  the forward unless the caller supplied one (`routes/queue.ts:501`). The
  forward is a single request, so a retry dedups only when it carries the same
  id (a caller re-sending `--id`, or a handoff re-drive, whose successor id is
  derived). Dedup rides the existing `qitem_id TEXT PRIMARY KEY`. On PK
  conflict the origin returns the stored row when destination and source
  match (idempotent absorb) and a structured `qitem_id_reuse` error (409) when
  they differ (`QueueRepository.create()` catch path,
  `queue-repository.ts:1423`–`1464`, with `isQitemPrimaryKeyConflict`,
  `:455`). When destination and source match but the body differs, the stored
  row is returned unchanged with `createWarning: qitem_body_not_saved`; the
  supplied body is not saved (`:1442`–`1446`).
- **Cross-host handoff choreography.** The local atomic close+create cannot
  span two DBs, so the route-layer choreography (`crossHostHandoff`,
  `routes/queue.ts:316`) runs: successor-create on the target host FIRST (via
  the one forward helper, `:397`), local source-close SECOND
  (`QueueRepository.closeCrossHostHandoffSource`, `queue-repository.ts:2021`)
  — never the reverse. A crash between the two leaves a live duplicate that
  the idempotent re-drive converges; the reverse order would leave a closed
  source pointing at a successor that does not exist (a dropped potato — the
  one forbidden outcome). The successor id is DERIVED, not minted:
  `deriveCrossHostSuccessorId(source, destination, host)`
  (`queue-repository.ts:483`) → `qitem-xh-<sha256[:16]>` — a pure stateless
  function, so a re-drive re-derives the same id across daemon restarts and
  absorbs on the target PK. *(Residual, inherent to at-least-once delivery
  without 2PC: a re-drive naming a DIFFERENT destination derives a different
  id and cannot absorb the earlier successor — that orphan stays visible via
  the chain + provenance tags; the source-close conflict check surfaces the
  disagreement.)*
- **Closure across the boundary.** The source closes with
  `closure_reason=handed_off_to` and
  `closure_target=<successor qitem id>@<host>` (`routes/queue.ts:351`); a
  source already closed with the older `member@rig@<host>` target keeps it,
  and a re-drive matches against it (`:352`–`356`). `closure_target` is OPAQUE
  audit metadata, never parsed for routing; the standing stuck sweep reads it
  only to check successor custody (`queue-stuck-sweep.ts:519`–`554`). The
  host-qualified key appears only in the `closure_target` column on
  `queue_items` and its verbatim mirror on `queue_transitions`: the minted
  cross-host close note names the 2-part `toSession` only
  (`queue-repository.ts:2077`), and `handed_off_to` and the
  `queue.handed_off` event stay 2-part.
  Re-drive semantics: already-terminal + MATCHING `closure_target` = absorb;
  MISMATCH = structured `cross_host_close_conflict` (409), checked in the route
  before any forward (`routes/queue.ts:359`) and again in the repository. The
  successor carries `chain_of_record = [...source.chain, source.qitemId]`
  (`routes/queue.ts:384`) — A-side ids are opaque lineage identifiers on B
  (they do not dereference in B's DB) — plus provenance tags `cross-host` +
  `from-host:<self-declared name>` (the forwarding daemon's OS hostname,
  `routes/queue.ts:54`; honest best-effort, not authenticated identity).
- **Boundary discipline.** Claim, update and inbox routes take no `hostId` and
  stay local (after a cross-host handoff the successor lives where its worker
  lives). Without a `hostId`, with `local`, or with this daemon's own resolved
  host id (an exact, case-sensitive match), create and handoff take the
  local path; a self-addressed handoff whose deterministic cross-host
  successor an earlier self-forward already created runs that cross-host
  create and close in process. The
  hot-potato validation contract (§3) is unweakened across the boundary: the
  cross-host close always records `handed_off_to` with a target.

## 4. Coordination events

The `RigEvent` union (`packages/daemon/src/domain/types.ts:108`) has **98**
members
(`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "'`);
this module covers only the coordination families below.

Coordination events emitted by these services: `stream.emitted`
(`StreamStore.emit`, declared at `types.ts:245`); `queue.created` /
`queue.handed_off` / `queue.claimed` / `queue.unclaimed` / `queue.updated` /
`qitem.fallback_routed` / `qitem.closure_overdue` (QueueRepository); `inbox.absorbed` (`types.ts:255`) /
`inbox.denied` (InboxHandler). `qitem.closure_overdue` (`types.ts:254`) is
emitted by `QueueRepository.recordClosureOverdue` when swept by `queue-stuck-sweep`
and passed through the queue watch filter (**2** files contain its literal:
`git grep -l -F 'type: "qitem.closure_overdue"' -- packages/daemon/src | wc -l`).
The `stream|queue|inbox|qitem` families declare **10** event types (`stream` 1
+ `queue` 5 + `inbox` 2 + `qitem` 2;
`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"(stream|queue|inbox|qitem)\.[a-z_]+"' | sort -u | wc -l`).

Two SSE surfaces stream coordination events (**2**:
`cat packages/daemon/src/routes/stream.ts packages/daemon/src/routes/queue.ts | grep -c 'return streamSSE('`):
`/api/stream/watch` (aliased `/api/stream/sse`, `routes/stream.ts:194`–`195`),
which first replays up to 50 unarchived items in chronological order (the
oldest, `:174`–`181`) and then streams new items, and `/api/queue/watch`
(aliased `/api/queue/sse`, `routes/queue.ts:1054`–`1055`) for queue/inbox
events — every coordination type except `stream.emitted` and `queue.updated`
(filter at `routes/queue.ts:1031`–`1038`). The event log remains append-only and
SQLite-backed. `rig stream watch` is a thin, single-connection consumer of
`/api/stream/sse` (`packages/cli/src/commands/stream.ts:191`); it does not add
a daemon route or reconnect policy.

## 5. Route surface

- `/api/stream` (`server.ts:783`) — `POST /emit` (`routes/stream.ts:56`),
  `GET /list` (`:91`, including `sourceSession`, `hintDestination`, `hintTag`,
  `since`, `until` and `direction` filters), `GET /watch` + `/sse` SSE
  (`:194`), `GET /:streamItemId` (`:198`), `POST /:streamItemId/archive`
  (`:207`).
- `/api/queue` (`server.ts:784`) — `POST /create` (`routes/queue.ts:450`),
  `POST /:qitemId/claim` (`:545`), `POST /:qitemId/unclaim` (`:561`),
  `POST /:qitemId/update` (`:600`), plus handoff (`:650`, `:732`),
  `POST /:qitemId/fallback` (`:808`), list (`:902`) and watch (`:1054`)
  surfaces; reads `GET /whoami`, `/attention-aggregate`, `/human-updates`,
  `/overdue`, `/undelivered`, `/recent-transitions`, `/:qitemId/transitions`
  and `/:qitemId` (`:822`–`1067`); inbox routes `POST /inbox/drop`,
  `/inbox/:id/absorb`, `/inbox/:id/deny` and `GET /inbox/pending`,
  `/inbox/list` (`:1076`–`1152`); outbox routes `POST /outbox/record` and
  `GET /outbox/list` (`:1161`, `:1190`).

Every write route derives its actor through `requireSenderIdentity`
(`routes/require-sender-identity.ts:76`): the `X-OpenRig-Session` header wins
over a body actor. On a direct request from a known origin it is recorded as
`transport:v1`; `resolveRecordedProvenance` (`:199`) instead records
`origin-unknown:v1` when the origin-unknown marker is set, `relay:v1` for a
relayed request that carried `transport:v1`, and `claimed:v1` for other relayed
requests. Without the header, the
body actor is recorded as `claimed:v1`; with neither (or, for inbox drop,
without the header) the route answers 400 `actor_required`. The stamp lands in
`identity_provenance` on transitions, inbox, outbox and stream rows
(migrations `067`, `082`).

## See also

- `daemon-core.md` — daemon wiring, the migration set, route surface.
- `workflow-runtime.md` — the workflow runtime that projects on closure.
- `mission-control.md` — queue observability over `queue_items`.
- Source roots: `packages/daemon/src/domain/{stream-store,queue-repository,
  queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`,
  `packages/daemon/src/routes/{stream,queue}.ts`.
