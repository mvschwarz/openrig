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
last-verified-against-source: 254122872cf477511514979a4300b695d77cd1f7
last-updated: 2026-10-03
---

# Coordination Primitive — Stream/Queue/Inbox/Outbox

The coordination primitive is the SQLite-canonical durable-work layer the
daemon exposes through `/api/stream` and `/api/queue`. It replaces the POC
filesystem `rigx queue` / `rigx stream` path for daemon-backed work; the POC
filesystem path remains untouched, and the daemon-backed `rig queue` /
`rig stream` commands operate only through the daemon HTTP API, so they write
only to SQLite (`packages/cli/src/commands/queue.ts:19`,
`packages/cli/src/commands/stream.ts:11`).

> Verified against source at main `254122872cf477511514979a4300b695d77cd1f7`. Each count below sits beside the
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
  (`packages/daemon/src/domain/queue-retention.ts:203`).
- **`inbox_entries`** (`026_inbox_entries.ts`) — mailbox-style asynchronous
  deposit; idempotent on `inbox_id`. State: `pending | absorbed | denied`
  (`INBOX_STATES`, `inbox-handler.ts:5`).
- **`outbox_entries`** (`027_outbox_entries.ts`) — sender-side record;
  symmetric to inbox; idempotent on `outbox_id`. Delivery state (**7** values,
  `OUTBOX_DELIVERY_STATES` at `outbox-handler.ts:28`;
  `grep '^export const OUTBOX_DELIVERY_STATES' packages/daemon/src/domain/outbox-handler.ts | grep -o '"[a-z]*"' | wc -l`):
  `pending | sending | delivered | failed | indeterminate | retained |
  retired`.

These five are migrations `023`–`027` of the daemon's **92**
(`git ls-files packages/daemon/src/db/migrations | wc -l`), applied in the
order of `ALL_MIGRATIONS` (`packages/daemon/src/db/all-migrations.ts:101`).
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
  (`:2165`, `:2247`), update (general state mutator with hot-potato
  strict-rejection on `done`, `:2310`), transactional handoff (close source as
  `handed-off` plus create new owned qitem in a single transaction, `:1634`;
  `handoffAndComplete`, `:1811`, closes the source as `done` instead),
  pod-fallback rerouting (`routeToFallback`, `:3580`), overdue lookup
  (`findOverdue`, `:3333`), nudge-result tracking (`recordNudgeAttempt`,
  `:3565`). Nothing in the daemon writes the `last_heartbeat` column
  (`queue-pickup.ts:16`). Cross-rig validation hook exposed as `validateRig`
  constructor option (`:711`).
- **`queue-transition-log.ts`** — append-only state-transition log; used by
  `queue-repository.ts`, exposed as the read-only property
  `QueueRepository.transitionLog` (`queue-repository.ts:660`).
- **`hot-potato-enforcer.ts`** — pure validator for the load-bearing API
  contract (see §3).
- **`inbox-handler.ts`** — mailbox handler: drop (idempotent on `inbox_id`,
  `:99`), absorb (promotes a pending entry to a `queue_item`, idempotent,
  `:154`), deny (records reason, `:214`). The handler has no auth hook: the
  inbox routes take the sender or receiver from the `X-OpenRig-Session` header
  through `requireSenderIdentity` (`routes/queue.ts:1026`), never from the body
  (`inbox-handler.ts:71`).
- **`outbox-handler.ts`** — sender-side outbox: idempotent record (`:130`),
  delivery-state marks (`markDelivered` `:239`, `markFailed` `:256`,
  `markIndeterminate` `:280`), list (`listForSender` `:339`). It also holds the
  queue's durable wake intents (ids prefixed `wake-intent-`, `:15`) and the
  messages the seat delivery guard retains (`retain` `:181`, `retire` `:217`),
  so it is not audit-only. Emits no event-bus events.

The standing detector in `queue-stuck-sweep.ts` creates findings through the
queue repository, with `evidenceRef: rig queue show <source-qitem-id>`
(`queue-stuck-sweep.ts:523`) pointing to the underlying durable work row. This
satisfies the existing human-route evidence contract without changing
destination resolution: an admitted finding can still be unroutable. Repeated
detections refresh the existing finding; when the source condition resolves,
the sweep closes its own finding (`:549`).

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
  (`queue-repository.ts:2566`).

Tier→SLA mapping for `closure_required_at` also lives in
`hot-potato-enforcer.ts` (`TIER_SLA_SECONDS`, `:114`). This validator is
invoked by `QueueRepository.update()` (and `updateWithinTransaction()`), both
through the call at `queue-repository.ts:2484`, so closure is enforced at the
daemon transaction boundary — the workflow runtime *projects* on closure but
does not otherwise gate it (see `workflow-runtime.md`). The one
workflow-aware check is in the queue: `update()` refuses a terminal close of a
live workflow frontier packet from a non-workflow verb
(`workflow_frontier_packet`, `queue-repository.ts:2510`), through a predicate
startup injects.

## 3b. Cross-host queue routing

Three queue write routes are host-aware — `POST /create`,
`POST /:qitemId/handoff` and `POST /:qitemId/handoff-and-complete` (**3**:
`grep -c 'body.hostId !== LOCAL_HOST_ID' packages/daemon/src/routes/queue.ts`):
a write body may carry an out-of-band `hostId` envelope. The destination
session stays `member@rig`; the 3-part `agent@rig@host` form is CLI input
sugar that `resolveQueueHostDestination`
(`packages/cli/src/commands/queue.ts:364`) splits into the destination and
`hostId` before the request leaves the CLI. The mechanism follows the
forward-then-strip shape of mission-control's remote action
(`routes/mission-control.ts:353`): one shared route-layer helper
(`forwardQueueWrite`, `routes/queue.ts:195`) resolves the host registry
daemon-side (bearers never reach the caller), rejects ssh-declared hosts
(`unsupported-transport` — the daemon→daemon path is http-only), and forwards
the whole body, with `hostId` stripped, via `remoteJsonRequest` (`:229`) under
a named write-class deadline (`QUEUE_FORWARD_TIMEOUT_MS`, `:39`). The origin's
response returns verbatim; failures map to a structured host-named error
(`remote_queue_write_failed`, HTTP 502, `:215`) whose `failureClass` is one of
registry / unknown-host / unsupported-transport / unreachable / auth-failed /
remote-error. No local row is ever written on the cross-host path.

**The model: origin-owns-the-record, at-least-once + idempotent,
message-passing closure (never 2PC).**

- **Origin-owns-the-record.** The qitem lives in the TARGET host's DB; that
  row is THE record. The target daemon's OWN `maybeNudge` fires on ITS local
  tmux (the forwarded body includes the `nudge` flag) — the sending daemon
  never reaches across a host boundary. Before forwarding, the forwarding
  daemon stamps its own host id, when it has one, onto the source session
  (`stampSelfHostSuffix`, `queue-repository.ts:542`; called at
  `routes/queue.ts:357` and `:463`), so the target row records the sender as
  `member@rig@<forwarding host>`.
- **Idempotency.** On create, the forwarding daemon mints the `qitemId` before
  the forward unless the caller supplied one (`routes/queue.ts:455`). The
  forward is a single request, so a retry dedups only when it carries the same
  id (a caller re-sending `--id`, or a handoff re-drive, whose successor id is
  derived). Dedup rides the existing `qitem_id TEXT PRIMARY KEY`. On PK
  conflict the origin returns the stored row when destination and source
  match (idempotent absorb) and a structured `qitem_id_reuse` error (409) when
  they differ (`QueueRepository.create()` catch path,
  `queue-repository.ts:1440`, with `isQitemPrimaryKeyConflict`, `:455`).
- **Cross-host handoff choreography.** The local atomic close+create cannot
  span two DBs, so the route-layer choreography (`crossHostHandoff`,
  `routes/queue.ts:297`) runs: successor-create on the target host FIRST (via
  the one forward helper, `:376`), local source-close SECOND
  (`QueueRepository.closeCrossHostHandoffSource`, `queue-repository.ts:2000`)
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
  `closure_target=<successor qitem id>@<host>` (`routes/queue.ts:330`); a
  source already closed with the older `member@rig@<host>` target keeps it,
  and a re-drive matches against it (`:331`). `closure_target` is OPAQUE
  audit metadata, never parsed for routing; the standing stuck sweep reads it
  only to check successor custody (`queue-stuck-sweep.ts:468`). The
  host-qualified key appears only in the `closure_target` column on
  `queue_items` and its verbatim mirror on `queue_transitions`: the minted
  cross-host close note names the 2-part `toSession` only
  (`queue-repository.ts:2056`), and `handed_off_to` and the
  `queue.handed_off` event stay 2-part.
  Re-drive semantics: already-terminal + MATCHING `closure_target` = absorb;
  MISMATCH = structured `cross_host_close_conflict` (409), checked in the route
  before any forward (`routes/queue.ts:341`) and again in the repository. The
  successor carries `chain_of_record = [...source.chain, source.qitemId]`
  (`routes/queue.ts:363`) — A-side ids are opaque lineage identifiers on B
  (they do not dereference in B's DB) — plus provenance tags `cross-host` +
  `from-host:<self-declared name>` (the forwarding daemon's OS hostname,
  `routes/queue.ts:52`; honest best-effort, not authenticated identity).
- **Boundary discipline.** Claim, update and inbox routes take no `hostId` and
  stay local (after a cross-host handoff the successor lives where its worker
  lives). Without a `hostId` (or with `local`), create and handoff take the
  local path. The hot-potato validation contract (§3) is unweakened across the
  boundary: the cross-host close always records `handed_off_to` with a target.

## 4. Coordination events

The `RigEvent` union (`packages/daemon/src/domain/types.ts:106`) has **99**
members
(`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "'`);
this module covers only the coordination families below.

Coordination events emitted by these services: `stream.emitted`
(`StreamStore.emit`, declared at `types.ts:243`); `queue.created` /
`queue.handed_off` / `queue.claimed` / `queue.unclaimed` / `queue.updated` /
`qitem.fallback_routed` (QueueRepository); `inbox.absorbed` (`types.ts:253`) /
`inbox.denied` (InboxHandler). `qitem.closure_overdue` is declared
(`types.ts:252`) and the queue watch filter lets it through, but nothing emits
it: `types.ts` is the only file that contains its `type:` literal (**1** file:
`git grep -l -F 'type: "qitem.closure_overdue"' -- packages/daemon/src | wc -l`).
The `stream|queue|inbox|qitem` families declare **10** event types (`stream` 1
+ `queue` 5 + `inbox` 2 + `qitem` 2;
`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"(stream|queue|inbox|qitem)\.[a-z_]+"' | sort -u | wc -l`).

Two SSE surfaces stream coordination events (**2**:
`cat packages/daemon/src/routes/stream.ts packages/daemon/src/routes/queue.ts | grep -c 'return streamSSE('`):
`/api/stream/watch` (aliased `/api/stream/sse`, `routes/stream.ts:194`–`195`)
for new stream items, and `/api/queue/watch` (aliased `/api/queue/sse`,
`routes/queue.ts:986`–`987`) for queue/inbox events — every coordination type
except `stream.emitted` and `queue.updated` (filter at
`routes/queue.ts:963`–`970`). The event log remains append-only and
SQLite-backed. `rig stream watch` is a thin, single-connection consumer of
`/api/stream/sse` (`packages/cli/src/commands/stream.ts:191`); it does not add
a daemon route or reconnect policy.

## 5. Route surface

- `/api/stream` (`server.ts:784`) — `POST /emit` (`routes/stream.ts:56`),
  `GET /list` (`:91`, including `sourceSession`, `hintDestination`, `hintTag`,
  `since`, `until` and `direction` filters), `GET /watch` + `/sse` SSE
  (`:194`), `GET /:streamItemId` (`:198`), `POST /:streamItemId/archive`
  (`:207`).
- `/api/queue` (`server.ts:785`) — `POST /create` (`routes/queue.ts:400`),
  `POST /:qitemId/claim` (`:499`), `POST /:qitemId/unclaim` (`:515`),
  `POST /:qitemId/update` (`:554`), plus handoff (`:604`, `:680`), list
  (`:834`) and watch (`:986`) surfaces.

## See also

- `daemon-core.md` — daemon wiring, the migration set, route surface.
- `workflow-runtime.md` — the workflow runtime that projects on closure.
- `mission-control.md` — queue observability over `queue_items`.
- Source roots: `packages/daemon/src/domain/{stream-store,queue-repository,
  queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`,
  `packages/daemon/src/routes/{stream,queue}.ts`.
