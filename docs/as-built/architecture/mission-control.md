---
kind: as-built
title: Mission Control — Queue Observability + 7-Verb Contract (PL-005)
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator, human-operator]
applies-when: |
  Need to know how the daemon-backed Mission Control surface works — the
  seven views, the seven write verbs, the action audit table, the
  bearer-token middleware, or how queue observability maps to PL-004 sources.
siblings: [coordination-primitive.md, workflow-runtime.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, coordination-primitive.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Mission Control — Queue Observability + 7-Verb Contract (PL-005)

Mission Control (PL-005) is the daemon-backed queue-observability surface: an
integrated product UI inside the existing shell (a top-level `/mission-control`
route, NOT a new managed app) over the PL-004 Phase A coordination primitive.
Per the PRD acceptance criteria: seven views, seven verbs, first-class human
seats, recent-ships=10, and a daemon-backed action audit table; no
old-dashboard migration/cutover (`architecture.md` §3 L368, L390).

> Verified against source at HEAD `7eaf524c`. Mission Control is PL-005 (an
> early-0.3.0 graft); plugins and Claude auto-compaction are 0.3.1 features
> and are NOT back-attributed here (slice-00 0.3.0-ground-truth seams a/row-7).

## 1. The seven views

`MISSION_CONTROL_VIEWS` is the canonical view list (re-confirmed at HEAD
`packages/daemon/src/domain/mission-control/mission-control-read-layer.ts:32–42`):
`my-queue`, `human-gate`, `fleet`, `active-work`, `recent-ships`,
`recently-active`, `recent-observations`.

All seven return rows in the load-bearing 9-field phone-friendly content
model (rig/mission name, current phase,
active|idle|attention|blocked|degraded, next-action,
pending-human-decision, read-cost, last-update timestamp,
confidence/freshness, evidence link). The model is non-negotiable across all
7 views; UI may render compact, JSON preserves all 9 (`architecture.md` §3
L370).

`MissionControlReadLayer` maps each view to its source-of-truth path
(`mission-control-read-layer.ts:4–14`, re-confirmed at HEAD):

- `my-queue` / `human-gate` / `active-work` / `recent-ships` query PL-004
  Phase A `queue_items` via `QueueRepository`.
- `fleet` consumes the per-rig CLI capability cache + queue summary.
- `recently-active` delegates to PL-004 Phase B
  `ViewProjector.show("recently-active")`.
- `recent-observations` reads PL-004 Phase A `stream_items` via
  `StreamStore`.

Filesystem fallbacks (`~/.openrig/stream/<date>.jsonl`, raw queue file grep)
are graceful-degradation aids, NOT the primary path (`architecture.md` §3
L378).

> Scope note (slice-00 0.3.0-ground-truth OPEN-3, carried): the exact
> For-You verb subset is an unresolved velocity slice-01 ruling. This module
> describes the **system-level** 7-verb vocabulary (proven, slice-00
> §1.6/seam-c). It does NOT enumerate a For-You-surface subset — that
> surface is described in `../ui/project-and-for-you.md` when authored.

## 2. The seven verbs (the write contract)

The seven verbs execute through the load-bearing
`MissionControlWriteContract` (re-confirmed at HEAD
`packages/daemon/src/domain/mission-control/mission-control-write-contract.ts:27–36`):

| Verb | Effect |
|---|---|
| `approve` | `state="done"`, `closure_reason="no-follow-on"` |
| `deny` | `state="done"`, `closure_reason="denied"` |
| `route` | `state="done"`, `closure_reason="handed_off_to"`, `closure_target`+`handed_off_to`=route target; creates new qitem at the route target (1-hop) |
| `annotate` | no queue mutation; audit record only |
| `hold` | `state="blocked"`, `closure_reason="blocked_on"` |
| `drop` | `state="done"`, `closure_reason="canceled"` |
| `handoff` | the 4-step shape (see below) |

Each verb is one atomic daemon transaction: queue mutation via
`QueueRepository.updateWithinTransaction()` (which preserves Phase A
hot-potato closure validation — see `coordination-primitive.md` §3) + an
audit row in `mission_control_actions` + a persisted
`mission_control.action_executed` event, all in one `db.transaction`. The
4-step `handoff` shape (source-update + destination-create + opt-in
best-effort notify + audit-record append) is verified atomic; notify failure
does NOT roll back durable mutations (PRD invariant). Failure-injection rolls
back source closure + audit row + new qitem together (`architecture.md` §3
L380; `mission-control-write-contract.ts:5,15`).

## 3. The action audit table

`mission_control_actions` (`037_mission_control_actions.ts:54` `CREATE TABLE
IF NOT EXISTS mission_control_actions`) is append-only at the API surface:
it records every operator action through Mission Control with before/after
qitem snapshots for forensic reconstruction. Columns include `action_verb`
(TEXT, app-layer enum enforcement, `:56`) and `acted_at` (TEXT NOT NULL ISO
timestamp); indexes `(acted_at DESC, action_verb)`,
`(qitem_id, acted_at DESC)`, `(actor_session, acted_at DESC)`
(`037_mission_control_actions.ts:28–44`). Phase B added NO migrations — this
Phase A table is the only data source (`architecture.md` §3 L364, L392).

## 4. PL-005 Phase B — bearer middleware, notifications, audit browse

Phase B extends the daemon Mission Control surface:

- **Bearer-token middleware** —
  `packages/daemon/src/middleware/auth-bearer-token.ts` (re-confirmed at
  HEAD: header `auth-bearer-token.ts:1–9` "PL-005 Phase B"). Constant-time
  bearer comparison via Node `crypto.timingSafeEqual`; the daemon refuses to
  start with a non-loopback bind interface AND an empty bearer config
  (startup-side check). Bearer enforced on the write verbs:
  `app.post("/action", requireAuth)` (`routes/mission-control.ts:294`) and
  `app.post("/notifications/test", requireAuth)` (`:295`). v0 is bearer-on-write;
  no OAuth/SSO/per-user model.
- **Notification dispatcher** — two adapters
  (`notification-adapter-ntfy.ts` default + `notification-adapter-webhook.ts`
  alternate; selected via `OPENRIG_NOTIFICATIONS_MECHANISM` env) plus
  `notification-dispatcher.ts` (re-confirmed in
  `domain/mission-control/`). ntfy.sh recommended for the operator's phone
  via tailnet.
- **Read-only audit-history browse** — `audit-browse.ts` over
  `mission_control_actions`, exposed at `GET /api/mission-control/audit`
  (`routes/mission-control.ts:346`) with filters and `(limit, before_id)`
  pagination cursored on SQLite `rowid` (`architecture.md` §3 L392).

## 5. Mission Control events

> Drift-fix D8 / OPEN-4 (carried verbatim, slice-00): `architecture.md` §3
> L394 says "Existing 32 PL-004 events untouched" — internally inconsistent
> with §3 L410's "20" and predates 0.3.x. **Do NOT carry either number.**
> The current `RigEvent` union (`packages/daemon/src/domain/types.ts:94`)
> has **73 members** total (slice-00 §1.8, re-confirmed at HEAD); the
> additive `mission_control.*` events are described below WITHOUT asserting
> a contested PL-004 sub-count.

Re-confirmed `domain/types.ts:212–218`: Phase A added
`mission_control.action_executed`, `mission_control.cli_drift_detected`,
`mission_control.view_refreshed`; Phase B added
`mission_control.notification_sent`, `mission_control.notification_failed`
(5 `mission_control.*` members at HEAD).

## 6. Route surface

`missionControlRoutes({ bearerToken })` is mounted at `server.ts:498`. Key
routes (`routes/mission-control.ts`): `GET /views` (`:245`),
`GET /cli-capabilities` (`:250`), `POST /action` (`:298`, auth-gated),
`GET /audit` (`:346`), `POST /notifications/test` (auth-gated), plus an SSE
surface. The integrated UI is the `/mission-control` top-level route in
`packages/ui/src/routes.tsx` mounting `MissionControlSurface`
(`architecture.md` §3 L390); UI detail lands in
`../ui/project-and-for-you.md`.

## See also

- `coordination-primitive.md` — the PL-004 Phase A `queue_items`/`stream_items`
  sources Mission Control reads, and the hot-potato closure contract verbs honor.
- `workflow-runtime.md` — PL-004 Phase D transactional-scribe runtime.
- `../ui/project-and-for-you.md` — the UI surface counterpart (authored phase).
- Source roots: `packages/daemon/src/domain/mission-control/`,
  `packages/daemon/src/middleware/auth-bearer-token.ts`,
  `packages/daemon/src/routes/mission-control.ts`,
  `packages/daemon/src/db/migrations/037_mission_control_actions.ts`.
