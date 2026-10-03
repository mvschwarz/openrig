---
kind: as-built
title: Mission Control — Queue Observability + Verb Contract
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator, human-operator]
applies-when: |
  Need to know how the daemon-backed Mission Control surface works — the
  seven views, the eight write verbs, the action audit table, the
  bearer-token middleware, or how queue observability maps to the
  coordination primitive's sources.
siblings: [coordination-primitive.md, workflow-runtime.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, coordination-primitive.md]
last-verified-against-source: 254122872cf477511514979a4300b695d77cd1f7
last-updated: 2026-10-03
---

# Mission Control — Queue Observability + Verb Contract

Mission Control is the daemon's queue-observability and operator-action
surface, mounted at `/api/mission-control` over the coordination primitive's
`queue_items` and `stream_items` (see `coordination-primitive.md`). It has
seven views, eight verbs, a recent-ships cap of 10
(`mission-control-read-layer.ts:107`), and a daemon-backed action audit
table. In the web UI the old `/mission-control` page now redirects to
`/for-you`, and the For You feed carries the verb actions (§6).

> Verified against source at main `254122872cf477511514979a4300b695d77cd1f7`. A bare file name such as
> `mission-control-read-layer.ts:31` is in
> `packages/daemon/src/domain/mission-control/`; `domain/…`, `routes/…`,
> `middleware/…`, `db/…`, `index.ts`, `server.ts` and `startup.ts` are under
> `packages/daemon/src/`. Each count sits beside the command that produces
> it; run the command from the repository root to refresh it.

## 1. The seven views

`MISSION_CONTROL_VIEWS` is the canonical view list
(`mission-control-read-layer.ts:31–39`): `my-queue`, `human-gate`, `fleet`,
`active-work`, `recent-ships`, `recently-active`, `recent-observations`.

Views: **7** — `sed -n '/^export const MISSION_CONTROL_VIEWS = \[/,/\] as const;/p' packages/daemon/src/domain/mission-control/mission-control-read-layer.ts | grep -c '^  "'`

All seven return rows in the 9-field phone-friendly content model,
`CompactStatusRow` (`mission-control-read-layer.ts:60`): rig/mission name,
current phase, active|idle|attention|blocked|degraded, next-action,
pending-human-decision, read-cost, last-update timestamp,
confidence/freshness, evidence link. The type's doc comment
(`mission-control-read-layer.ts:43–59`) makes the model non-negotiable across
all seven views: UI may render compact, JSON preserves all nine. Four further
optional fields carry the queue item's id and context.

Required row fields: **9** — `sed -n '/^export interface CompactStatusRow {/,/^}/p' packages/daemon/src/domain/mission-control/mission-control-read-layer.ts | grep -c -E '^  [a-zA-Z]+:'`

`MissionControlReadLayer.readView` (`mission-control-read-layer.ts:143`) maps
each view to its source:

- `my-queue` / `human-gate` / `active-work` / `recent-ships` query
  `queue_items` via `QueueRepository`.
- `fleet` calls `MissionControlFleetCliCapability.rollupFleet()`
  (`mission-control-read-layer.ts:197`;
  `mission-control-fleet-cli-capability.ts:109`), which walks the rig
  registry (`:110`), summarises each rig's `queue_items` (`:135`), and runs a
  per-rig CLI capability probe (`makeLocalCliCapabilityProbe`, `:77`, wired
  at `startup.ts:1547`).
- `recently-active` delegates to the view projector's built-in
  `ViewProjector.show("recently-active")` (`mission-control-read-layer.ts:246`).
- `recent-observations` reads the latest 50 `stream_items` via `StreamStore`
  with `direction: "latest"` (`mission-control-read-layer.ts:265–268`).

There is no filesystem fallback. When no `StreamStore` is wired,
`recent-observations` returns no rows with
`sourceFallback: "stream-store-not-wired"`
(`mission-control-read-layer.ts:258–262`), and `fleet` always reports
`sourceFallback: "daemon-internal-projection"`
(`mission-control-fleet-cli-capability.ts:156`).

> Scope note: this module describes the daemon's verb vocabulary. It does
> NOT enumerate which verbs the For You cards offer; that surface is
> described in `../ui/project-and-for-you.md`.

## 2. The eight verbs (the write contract)

`MISSION_CONTROL_VERBS` (`mission-control-action-log.ts:14–26`) is the verb
list. The verbs execute through `MissionControlWriteContract.act`
(`mission-control-write-contract.ts:131`); the closure mapping is
`verbToClosure` (`:509`).

Verbs: **8** — `sed -n '/^export const MISSION_CONTROL_VERBS = \[/,/\] as const;/p' packages/daemon/src/domain/mission-control/mission-control-action-log.ts | grep -c '^  "'`

| Verb | Effect |
|---|---|
| `approve` | `state="done"`, `closure_reason="no-follow-on"` |
| `deny` | `state="done"`, `closure_reason="denied"` |
| `route` | `state="handed-off"`, `closure_reason="handed_off_to"`, `closure_target`+`handed_off_to`=route target; creates a new queue item at the route target (1-hop) |
| `annotate` | no queue mutation; audit record only |
| `hold` | `state="blocked"`, `closure_reason="blocked_on"` |
| `drop` | `state="done"`, `closure_reason="canceled"` |
| `handoff` | same closure and new destination item as `route`; the 4-step shape (see below) |
| `resolve` | only for a `blocked` item parked on a human seat: moves it to `in-progress` with the required decision text as the transition note; no closure and no new item (`:369`, `:386`, `:410–411`) |

Each verb is one atomic daemon transaction: the queue mutation via
`QueueRepository.updateWithinTransaction()` (`domain/queue-repository.ts:2337`,
which keeps the hot-potato closure validation — see
`coordination-primitive.md` §3), an audit row in `mission_control_actions`
(`mission-control-write-contract.ts:207`), and a persisted
`mission_control.action_executed` event (`:225`), all in one
`db.transaction`. For every verb except `annotate`, that transaction is
opened by `EventBus.withNotifyEnvelope` (`:157`; `domain/event-bus.ts:112`,
`:126`); `annotate` opens `db.transaction` itself
(`mission-control-write-contract.ts:308`).

The 4-step `handoff` shape (source-update + destination-create + best-effort
notify + audit-record append) is shared by `route`. The destination item is
created in the same transaction (`createWithinTransaction`, `:173`), along
with the successor's wake intent (`stageWakeIntent`, `:195`, checked by
`assertTerminalClosureHasIntent`, `:242`). The wake itself runs after commit
(`deliverWakeForSuccessor`, `:264`). It is on unless the caller passes
`notify: false` (`domain/queue-repository.ts:1174`), and a notify failure
does NOT roll back durable mutations (`mission-control-write-contract.ts:272–275`).
A failed destination create rolls back the source closure, the audit row and
the new item together
(`packages/daemon/test/mission-control-write-contract.test.ts:220`).

## 3. The action audit table

`mission_control_actions` (`db/migrations/037_mission_control_actions.ts:58`
`CREATE TABLE IF NOT EXISTS mission_control_actions`) is append-only at the
API surface: `record()` is the only writer `MissionControlActionLog` exposes
(`mission-control-action-log.ts:113`). It records every operator action
through Mission Control with before/after queue item snapshots for forensic
reconstruction. Columns include `action_verb` (TEXT, app-layer enum
enforcement, `037_mission_control_actions.ts:60`) and `acted_at` (TEXT NOT
NULL ISO timestamp, `037_mission_control_actions.ts:63`);
indexes `(acted_at DESC, action_verb)`, `(qitem_id, acted_at DESC)`,
`(actor_session, acted_at DESC)` (`037_mission_control_actions.ts:72–77`).
One later migration adds a nullable `identity_provenance` column
(`db/migrations/065_identity_provenance.ts:18`). The audit browse (§4) reads
only this table.

## 4. Bearer middleware, notifications, audit browse

- **Bearer-token middleware** — `middleware/auth-bearer-token.ts`.
  Constant-time comparison via Node `crypto.timingSafeEqual`
  (`constantTimeEqual`, `:36`, `:50`). `authBearerTokenMiddleware` (`:93`)
  passes every request through when no token is configured (`:98`). The
  token comes from `OPENRIG_AUTH_BEARER_TOKEN` (`index.ts:280`). The daemon
  refuses to start when the bind host is set explicitly, is neither loopback
  nor Tailscale (a hostname is resolved first), and no bearer token is set
  (`assertBindAuthInvariant`, `auth-bearer-token.ts:240`, called at
  `index.ts:288`). Bearer enforced on the write routes:
  `app.post("/action", requireAuth)` (`routes/mission-control.ts:307`) and
  `app.post("/notifications/test", requireAuth)` (`:308`). Reads are not
  gated. It is one static token; no OAuth/SSO/per-user model
  (`auth-bearer-token.ts:11–14`).
- **Notification dispatcher** — two adapters
  (`notification-adapter-ntfy.ts`, `notification-adapter-webhook.ts`) plus
  `notification-dispatcher.ts`. `OPENRIG_NOTIFICATIONS_MECHANISM` selects
  `ntfy`, `webhook` or `none`, and the default is `none`
  (`startup.ts:1592`). A dispatcher starts only when
  `OPENRIG_NOTIFICATIONS_TARGET` is also set (`:1593`, `:1600`) and the
  target URL passes validation (`:1611`). The ntfy adapter posts to a topic
  URL that the ntfy phone app subscribes to
  (`notification-adapter-ntfy.ts:1–6`).

  Adapters: **2** — `git grep -l 'implements NotificationAdapter' -- packages/daemon/src | wc -l`
- **Read-only audit-history browse** — `MissionControlAuditBrowse.query`
  (`audit-browse.ts:78`) over `mission_control_actions`, exposed at
  `GET /api/mission-control/audit` (`routes/mission-control.ts:441`) with
  filters and `(limit, before_id)` pagination cursored on SQLite `rowid`
  (`audit-browse.ts:134`).

## 5. Mission Control events

The `RigEvent` union starts at `domain/types.ts:106`; its four
`mission_control.*` members are at `domain/types.ts:306–311`.

`RigEvent` members: **98** — `sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "'`

`mission_control.*` members: **4** — `sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "mission_control\.'`

- `mission_control.action_executed` — written by the write contract
  (`mission-control-write-contract.ts:225`).
- `mission_control.cli_drift_detected` — emitted by the fleet capability
  probe (`mission-control-fleet-cli-capability.ts:171`).
- `mission_control.notification_sent` / `mission_control.notification_failed`
  — emitted by the notification dispatcher (`notification-dispatcher.ts:174`,
  `:184`).
- *(retired)* `mission_control.view_refreshed` — retired per #490; views are
  read-on-demand queries without background refresh caching.

## 6. Route surface

`missionControlRoutes({ bearerToken })` is mounted at `/api/mission-control`
(`server.ts:791–794`). Routes (`routes/mission-control.ts`): `GET /views`
(`:259`), `GET /cli-capabilities` (`:264`), `GET /destinations` (`:276`),
`GET /sse` and its alias `GET /watch` (`:303–304`; they forward
`action_executed` and `cli_drift_detected` events,
`:289–291`), `POST /action` (`:314`, auth-gated), `GET /audit` (`:441`),
`POST /notifications/test` (`:481`, auth-gated), and `GET /views/:view-name`
(`:509`).

In the web UI (`packages/ui/src/routes.tsx`), `/mission-control` is a
redirect to `/for-you` (`:495–500`). `/for-you` renders the For You `Feed`
(`:130–134`), whose cards call `POST /action` through `VerbActions`
(`packages/ui/src/components/for-you/FeedCard.tsx:13`), and `/search` renders
`AuditHistoryView` over `GET /audit` (`routes.tsx:304–308`).
`MissionControlSurface`
(`packages/ui/src/components/mission-control/MissionControlSurface.tsx:9`)
still exists and renders the same `Feed`, but nothing imports it. UI detail
lands in `../ui/project-and-for-you.md`.

## See also

- `coordination-primitive.md` — the `queue_items`/`stream_items` sources
  Mission Control reads, and the hot-potato closure contract verbs honor.
- `workflow-runtime.md` — the workflow transactional-scribe runtime.
- `../ui/project-and-for-you.md` — the For You feed that carries the verb
  actions in the web UI.
- Source roots: `packages/daemon/src/domain/mission-control/`,
  `packages/daemon/src/middleware/auth-bearer-token.ts`,
  `packages/daemon/src/routes/mission-control.ts`,
  `packages/daemon/src/db/migrations/037_mission_control_actions.ts`.
