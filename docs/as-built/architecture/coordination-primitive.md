---
kind: as-built
title: Coordination Primitive — Stream/Queue/Inbox/Outbox (PL-004 Phase A)
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator]
applies-when: |
  Need to know how the daemon-backed coordination primitive works — the
  stream/queue/inbox/outbox tables, the hot-potato closure contract, the
  transactional handoff guarantee, or where queue closure is enforced.
siblings: [workflow-runtime.md, mission-control.md, daemon-core.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Coordination Primitive — Stream/Queue/Inbox/Outbox (PL-004 Phase A)

The PL-004 Phase A coordination primitive is the SQLite-canonical
durable-work layer the daemon exposes through `/api/stream` and `/api/queue`.
It replaces the POC filesystem `rigx queue` / `rigx stream` path for
daemon-backed work; the POC filesystem path remains untouched and the daemon
`rig queue` / `rig stream` write only to SQLite (`architecture.md` §5 L651).

> Verified against source at HEAD `7eaf524c`.

## 1. The five host-scoped tables

Five host-scoped tables back the primitive (`architecture.md` §3 L416–438;
migrations re-confirmed at HEAD `packages/daemon/src/db/migrations/`):

- **`stream_items`** (`023_stream_items.ts`) — L1 append-only intake/audit
  root. Columns: `stream_item_id` (ULID PK), `ts_emitted`,
  `stream_sort_key`, `source_session`, `body`, `format` (default `text`),
  `hint_type`, `hint_urgency`, `hint_destination`, `hint_tags` (JSON),
  `interrupt`, `archived_at`. Items immutable after emit (only `archived_at`
  may be set).
- **`queue_items`** (`024_queue_items.ts`) — L3 owned-work queue. `qitem_id`
  is TEXT PK preserving the POC `qitem-YYYYMMDDHHMMSS-<hex>` shape. State
  enum (8 values): `pending | in-progress | done | blocked | failed |
  denied | canceled | handed-off`. Carries `closure_reason`,
  `closure_target`, `closure_required_at`, `chain_of_record` (JSON),
  `blocked_on`, `handed_off_to`/`handed_off_from`, nudge/heartbeat fields.
- **`queue_transitions`** (`025_queue_transitions.ts`) — L3 append-only
  transition log; authoritative audit trail for state evolution. No
  UPDATE/DELETE from domain code.
- **`inbox_entries`** (`026_inbox_entries.ts`) — mailbox-style asynchronous
  deposit; idempotent on `inbox_id`. State: `pending | absorbed | denied`.
- **`outbox_entries`** (`027_outbox_entries.ts`) — sender-side audit;
  symmetric to inbox; idempotent on `outbox_id`. Delivery state:
  `pending | delivered | failed`.

> Drift-fix D3 — `architecture.md` §3 L243 frames the schema as "27
> migrations (22 existing plus 5 added by PL-004 Phase A)". The 5 PL-004
> Phase A coordination tables (`023`–`027`) are still correct as a *range*,
> but the headline migration count is **40**, not 27 (slice-00 §1.3,
> re-confirmed at HEAD: `startup.ts:206` 40-element `migrate()` array; full
> drift-fix authority and the correction live in `daemon-core.md`).

## 2. The six host-scoped services

Six host-scoped domain services implement the layer (`architecture.md` §5
L649–658; files re-confirmed in `packages/daemon/src/domain/` at HEAD).
Routes import these; services are Hono-free:

- **`stream-store.ts`** — L1 stream: idempotent emit (on `stream_item_id`),
  chronological list with cursor pagination, soft archive.
- **`queue-repository.ts`** — L3 queue: create, claim/unclaim, update
  (general state mutator with hot-potato strict-rejection on `done`),
  transactional handoff (close source as `handed-off` plus create new owned
  qitem in a single transaction), pod-fallback rerouting, overdue lookup,
  nudge/heartbeat tracking. Cross-rig validation hook exposed as
  `validateRig` constructor option.
- **`queue-transition-log.ts`** — append-only state-transition log; used by
  `queue-repository.ts`, exposed read-only on
  `queue_repository.transitionLog`.
- **`hot-potato-enforcer.ts`** — pure validator for the load-bearing API
  contract (see §3).
- **`inbox-handler.ts`** — mailbox handler: authenticated drop (idempotent
  on `inbox_id`), absorb (promotes a pending entry to a `queue_item`,
  idempotent), deny (records reason). Auth check is a pluggable constructor
  hook.
- **`outbox-handler.ts`** — sender-side outbox: idempotent record, mark
  delivered/failed, list. Emits no event-bus events (pure audit).

## 3. The hot-potato closure contract (where queue closure is enforced)

`hot-potato-enforcer.ts` is the pure validator for the load-bearing API
contract. Re-confirmed at HEAD (`hot-potato-enforcer.ts:10–24`):

`state=done` requires `closure_reason ∈ {handed_off_to, blocked_on, denied,
canceled, no-follow-on, escalation}`. The reasons
`handed_off_to | blocked_on | escalation` additionally require
`closure_target`:

- `handed_off_to` — work continues with a different seat (`closure_target` =
  new owner).
- `blocked_on` — work is parked pending another qitem (`closure_target` =
  blocker `qitem_id`).
- `denied` — receiver rejected the work (`closure_target` = reason text).
- `canceled` — sender or receiver withdrew (`closure_target` = note).
- `no-follow-on` — terminal completion, nothing else needed.
- `escalation` — kicked up to a higher tier (`closure_target` = escalation
  target).

Tier→SLA mapping for `closure_required_at` also lives in
`hot-potato-enforcer.ts`. This validator is invoked by
`QueueRepository.update()` (and `updateWithinTransaction()`), so closure is
enforced at the daemon transaction boundary — the workflow runtime
*projects* on closure but does not gate it (see `workflow-runtime.md`).

## 4. Coordination events

> Drift-fix D8 / OPEN-4 (carried verbatim, slice-00): `architecture.md`
> §3 L394 says "Existing 32 PL-004 events untouched" and L410 says "Existing
> 20 PL-004 events are unchanged" — these two body claims are internally
> inconsistent with each other and predate 0.3.x. **Do NOT carry either
> number.** The current `RigEvent` union (`packages/daemon/src/domain/types.ts:94`)
> has **73 union members** total (slice-00 §1.8, re-confirmed at HEAD:
> `grep -cE '^\s*\| \{ type: ' = 73`). A precise PL-004-only vs PL-005-only
> sub-partition is not reconcilable from static inspection without
> classifying all 73 members by introducing slice; slice-00 OPEN-4 flags
> this and it is carried, not smoothed.

Coordination events emitted by these services (re-confirmed in
`domain/types.ts` at HEAD): `stream.emitted` (StreamStore.emit,
`types.ts:155`); `queue.created` / `queue.handed_off` / `queue.claimed` /
`queue.unclaimed` / `qitem.fallback_routed` / `qitem.closure_overdue`
(QueueRepository); `inbox.absorbed` (`types.ts:162`) / `inbox.denied`
(InboxHandler). `architecture.md` §8 L987–990 listed these as "9
coordination events"; the count of the broader `stream|queue|inbox|qitem`
event family at HEAD is 10 (`stream` 1 + `queue` 5 + `inbox` 2 + `qitem` 2)
— stated as a re-derived family count, not as a contested PL-004 sub-count
(OPEN-4).

Two SSE surfaces stream coordination events: `/api/stream/watch`
(aliased `/api/stream/sse`, `routes/stream.ts:117–118`) for new stream
items, and `/api/queue/watch` for queue/inbox events. The event log remains
append-only and SQLite-backed.

## 5. Route surface

- `/api/stream` (`server.ts:489`) — `POST /emit` (`routes/stream.ts:24`),
  `GET /list` (`:56`), `GET /watch` + `/sse` SSE (`:117`),
  `GET /:streamItemId` (`:121`), `POST /:streamItemId/archive` (`:130`).
- `/api/queue` (`server.ts:490`) — `POST /create` (`routes/queue.ts:99`),
  `POST /:qitemId/claim` (`:144`), `POST /:qitemId/unclaim` (`:157`),
  `POST /:qitemId/update` (`:170`), plus handoff/list/watch surfaces.

## See also

- `daemon-core.md` — daemon wiring, the 40-migration set, route surface.
- `workflow-runtime.md` — PL-004 Phase D runtime that projects on closure.
- `mission-control.md` — PL-005 queue observability over `queue_items`.
- Source roots: `packages/daemon/src/domain/{stream-store,queue-repository,
  queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`,
  `packages/daemon/src/routes/{stream,queue}.ts`.
