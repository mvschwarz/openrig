# Writing a daemon client

What a program that talks to the OpenRig daemon over HTTP needs and can't read from `rig --help`: how to find the
daemon, its health route, which bearer token each route family checks, the event streams, and some route
details. It describes the daemon as it is. It adds no promise beyond what each section says, and route shapes not
listed here can change.

## Finding the daemon

`rig status --json` is the discovery surface. Its `daemon` object gives `state` and `reachable`, and `pid` and
`port` when they are known: a stopped daemon's response has no `port`, and a running daemon found through
`OPENRIG_URL` has no `pid`. `reachable` is `true` when the daemon answered its health probe, `false` when it is
positively down, and `null` when that isn't confirmed (see `rig status` in
[the command reference](../as-built/cli-reference.md#status)). It reads the recorded state and probes; it never
starts a daemon.

The CLI itself finds the daemon in these orders:

- **Data commands** (everything that sends a request): `OPENRIG_URL` (or the legacy `RIGGED_URL`); else
  `$OPENRIG_HOME/daemon.json` when it holds a valid `pid` and `port`; else the config keys `daemon.host` and
  `daemon.port` (environment `OPENRIG_HOST` and `OPENRIG_PORT`), which default to `127.0.0.1:7433`.
- **Status** (`rig status`, `rig daemon status`): `OPENRIG_URL` (or `RIGGED_URL`) first, probed directly; else
  the state file below.
- **Start and stop** (`rig daemon start`, `stop`): the state file, `$OPENRIG_HOME/daemon.json`, then the legacy
  `~/.rigged/daemon.json`.

`daemon.json` holds `pid`, `port`, `host`, `db` and `startedAt`. `rig daemon start` writes a new daemon's record
only after its health check passes, so while a start is pending, the file holds no record of the new daemon: it
may be missing, or hold an earlier daemon's stale record. It is the CLI's own state file, not a published
contract: prefer `rig status --json`.

## `GET /healthz`

The liveness and identity read. It always returns `status: "ok"` and `pid`. Every other field is present only
in the case named:

| Field | When it is present |
| --- | --- |
| `euid` | On platforms with effective user ids. A self-report for the CLI's owner check, not authentication. |
| `databaseWarnings` | When the daemon opened its database with warnings. |
| `semver`, `commit`, `dirty`, `builtAt` | On a stamped (released) build; a development run has none. |
| `selfHostId`, `selfHostIdSource` | After the boot reconcile has set this host's id. |
| `eventLoop` | When the event-loop monitor runs: `lagMeanMs`, `lagP99Ms`, `utilization` (0 to 1), `lastTickAgeMs` and `healthy`. |
| `routeTimings` | With `eventLoop`. |
| `slowOperations` | When the slow-operation recorder runs. |
| `bind` | The bind plan: `mode` (`explicit` or `default`), `hosts` (the addresses bound), `tailscaleDetected`, and `ignoredRoutingHost` when a routing value was ignored. |
| `stuckSweep`, `wakeLadder` | The heartbeats of the stuck sweep and the wake ladder, when they run. |

## Bearer tokens

The daemon reads two tokens from its environment at start:

- **`OPENRIG_AUTH_BEARER_TOKEN`** checks Mission Control's write routes (`POST /api/mission-control/action` and
  `/notifications/test`), the `/api/hosts` writes (`add`, `update`, `remove`, `pair`), and the `/api/rig-mode`
  binding writes. `rig host pair` hands this token to the paired machine, so a daemon that will be paired with
  needs it set (see `rig host pair` in [the command reference](../as-built/cli-reference.md)).
- **`OPENRIG_TERMINAL_BEARER_TOKEN`** checks every `/api/transport` and `/api/compaction` route, `POST
  /api/terminal/follow` and `/viewer/ensure`, and every `GET /api/terminal/<name>` route, the terminal websocket
  included. When the daemon is bound to an explicit address (`rig daemon start --host`) that isn't loopback or a
  tailnet address, and this token isn't set, these routes check `OPENRIG_AUTH_BEARER_TOKEN` instead.

A route whose token isn't set lets every request through. Send a token as `Authorization: Bearer <token>`; the
`GET /api/terminal/<name>` routes, the websocket included, also take `?token=<token>`. The CLI sends the terminal token from `OPENRIG_TERMINAL_BEARER_TOKEN`,
or else from the file `$OPENRIG_HOME/terminal-token`, which the person writes; the daemon doesn't create it.

A wrong or missing token gets HTTP 401. The routes that check `OPENRIG_AUTH_BEARER_TOKEN`, and `/api/transport`
and `/api/compaction`, answer `{ "error": "unauthorized", "message", "what_failed", "why_it_matters", "what_to_do" }`.
The `GET /api/terminal/<name>` routes, the websocket included, answer `{ "error": "unauthorized", "hint" }`. A token
doesn't get past the browser boundary's 403 refusals, which [Browser access](browser-access.md) describes.

## Event streams

All three are server-sent events (`text/event-stream`):

- **`GET /api/events`**: the daemon's event log. `?rigId=` limits it to one rig. Each event carries `id: <seq>`.
  Without `Last-Event-ID`, `?replay=<n>` first sends the newest `n` stored events (`0`: none, live events only);
  `?replay=all`, no `replay`, or any other value sends the whole log first. A `Last-Event-ID` header (what
  `EventSource` sends when it reconnects) sends the events after that id instead, whatever `replay` says.
  Live events that arrive during the replay follow it, without duplicates.
- **`GET /api/activity/events`**: live only, no replay or ids. Each message is named after its event type:
  `seat.activity_changed`, `seat.rung_health`, `proof.judged` or `proof.sources_changed`. It tells a view to read
  again; it carries no derived state.
- **`GET /api/queue/sse`** (alias `/api/queue/watch`): live only, with `id: <seq>`, for `queue.created`,
  `queue.handed_off`, `queue.claimed`, `queue.unclaimed`, `qitem.fallback_routed`, `qitem.closure_overdue`,
  `inbox.absorbed` and `inbox.denied`.

## People, asks and updates without Slack

`GET /api/gateway/participants` returns the same JSON projection as `rig gateway participants --json`:
`{ ok, participants, default, organizations, groups, warnings, participantFile }`. Pick a person by `kind: "person"`
and use their `id` for a Feed `view`, or their `address` for the queue's `destinationSession`. The effective
`default` is `{ id, source }`, or `{ id: null, reason }`; it does not establish who is using the client.
Participant records omit connector credential pointers. Check `warnings` and `participantFile.error` for a partial
registry read; an unreadable human registry returns HTTP 503. See [Gateway participants](gateway-participants.md).

| Read | Meaning |
| --- | --- |
| `GET /api/queue/list?destinationSession=<address>&state=pending,in-progress,blocked&limit=100` | Open rows for exactly that address. `humanIntent: "update"` identifies an FYI; other values are asks. Each row has `qitemId`, `state`, `summary` and `body`. |
| `GET /api/queue/open-human-updates?view=<person-id>&limit=20` | Open human FYIs, even when no Slack delivery receipt exists. Returns `{ items, limit, truncated, perspective? }`. |
| `GET /api/queue/<qitemId>` and `/<qitemId>/transitions` | The current row and its history, including closed state and recorded outcome. Closing or acknowledging a row is different from delivering it. |
| `GET /api/queue/human-updates?view=<person-id>&limit=20` | Existing delivered-update history: explicit FYIs with a recorded Slack posting receipt, including closed rows. Items add `deliveredAt` and `deliveryReceipt`. It is not the open-update inbox. |

Both update lists accept integer `limit` values from 1 to 100 (default 20); invalid values return HTTP 400.
Open FYIs are ordered by priority, then newest first. `view=all` (also the default) shows all perspectives;
`view=default` selects the effective default person, or all when no default is available. A named view that cannot
resolve a person has `perspective.basis: "unknown"` and no items when a registry is available. With no registered
people there is no perspective filter: inspect `perspective` rather than assuming the requested view was applied.
A person's view also includes instance or unassigned items when that person is the default. These are views on a
trusted daemon, not per-person authentication or access control; existing daemon and browser access rules still apply.

Always display `truncated: true` as incomplete, even if fewer than `limit` items arrive. A person-view scan examines
at most 1,001 open updates (101 for delivered history) before filtering; older matching items may be outside that
window. These endpoints have no pagination cursor. Reading an open update never posts it to Slack, acknowledges it,
or manufactures a delivery receipt.

For example, this Node client takes a daemon URL, a registered person id and a rig name. It uses no Slack API and
makes only reads; use the daemon discovery and access rules above. In an ES module, `process.argv.slice(1)` is the
argument list for `node --input-type=module -e '<code>' <url> <person-id> <rig>`:

```js
// client-people-example
const [base, personId, rig] = process.argv.slice(1);
async function get(path) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const registry = await get("/api/gateway/participants");
const person = registry.participants.find(p => p.kind === "person" && p.id === personId);
if (!person) throw new Error("Choose a registered person id");
const rows = await get(`/api/queue/list?destinationSession=${encodeURIComponent(person.address)}&state=pending,in-progress,blocked&limit=100`);
const updates = await get(`/api/queue/open-human-updates?view=${encodeURIComponent(person.id)}&limit=20`);
const receipts = await get(`/api/queue/human-updates?view=${encodeURIComponent(person.id)}&limit=20`);
const rigHistory = await get(`/api/queue/list?rig=${encodeURIComponent(rig)}&limit=100`);
const messages = await get(`/api/queue/outbox/list?rig=${encodeURIComponent(rig)}&limit=100`);
console.log(JSON.stringify({ participants: registry.participants, default: registry.default,
  warnings: registry.warnings, participantFile: registry.participantFile,
  asks: rows.filter(row => row.humanIntent !== "update"), updates, receipts, rigHistory, messages }, null, 2));
```

The queue and outbox lists are bounded snapshots, not subscriptions. A full queue list may need a larger `limit`.
An outbox entry's `deliveryState` reports the send attempt; only `delivered` confirms delivery. A queue transition,
an open FYI, or a closed ask is not that receipt. The rig-wide reads and their limits are described below; the existing
`outbox/list?senderSession=<session>` read remains available.

## Route details

- **A rig's queue history:** `GET /api/queue/list?rig=<rig>&updatedSince=<ISO time>&sort=updated` returns the
  rig's queue items (any whose source or destination seat is in the rig) updated at or after that time: open items
  (`pending`, `in-progress`, `blocked`) first, then the rest by latest update. `limit` defaults to 100 and has no
  upper cap. The list is cut after `limit` rows in that order, so when it comes back full, raise `limit` to read
  them all. Each item's own history is `GET /api/queue/<qitemId>/transitions`. This read scans the queue table, so
  read it occasionally rather than polling it. For live changes, treat `GET /api/queue/sse` events as hints to read
  `queue/list?rig=` again. Not every event names both seats (`queue.claimed` and `queue.unclaimed` carry only the
  destination), and not every state change is on that stream, so the events alone don't track a rig's items.
- **A rig's messages:** `GET /api/queue/outbox/list?rig=<rig>` returns the messages sent from or to the rig's
  seats, newest first; `?senderSession=<session>` still returns one sender's. One of the two is required; with
  both, `senderSession` is used and `rig` is ignored. `limit` defaults to 100. No event is sent when a message is delivered, so read this list to see delivery
  states.
- **`GET /api/queue/recent-transitions`** returns at most 20 rows. A positive `limit` above 20 is capped at 20;
  a missing, zero, negative or unparseable `limit` means 20.
- **`POST /api/transport/send`** takes `urgent: true`, the same as `rig send --urgent`. The daemon records who
  marked it from the sender identity, not from the body.
- **`POST /api/scope/approve`** is what `rig scope slice approve` and `rig scope mission approve` call. The body
  takes `scopeTier` (`slice` or `mission`), `scopePath`, and optionally `approvalScope` (`spec` or `delivery`, the
  default), `missionsRoot`, `onBehalfOf`, `reApprove`, `reason` and `lockedArtifacts`. The approver is the
  request's sender identity (`actorSession` in the body is recorded beside it, and a different value is
  superseded). Success is 201 with `scopeTier`, `scopeId`, `scopePath`, `approvalScope`, `approvedBy`,
  `approvedAt`, `onBehalfOf`, `actionId`, `freezeFired` and `reApproved`. Refusals include 400 for an invalid
  `scopeTier`, `scopePath` or `approvalScope`, or a missing actor (`actor_required`); 503 `action_log_unavailable`;
  and, from the approval itself, 404 `scope_not_found`, 409 `already_approved` or `nothing_to_reapprove`, 503
  `workspace_not_configured`, 500 `audit_write_failed`, and 400 for its other refusals. An unexpected error is 500
  `internal`.
- **`POST /api/proof/judge`** is what `rig proof judge` calls. The body takes `scope`, `item`, `verdict`
  (`accept`, `reject` or `withdraw`), `reason`, `expectedRevision` and `expectedPrevious` (a judgment id or
  `null`), and optionally `evidence`, `expectedEvidence`, `subject`, `operationId`, `replace`, `project` and
  `projectRoot`. The judge is the request's sender identity. The response is `judgment`, the slice's `readiness`,
  `replayed` and `notification`: 201 for a new judgment, 200 when an `operationId` replays an earlier one.
- **`POST /api/workflow/instantiate`** requires `specPath`, `rootObjective` and `createdBySession`, and takes
  `entryOwnerSession`, `targetRig` and `scope` (see [Project workspace](project-workspace.md) for `scope`).
  Success is 201 with `instance`, `spec`, `entryQitemId` and `entryOwnerSession`, any `advisories`, and
  `scopeIgnored` when a scope wasn't applied.
- **`GET /api/provider/usage`** returns `{ hostUsage }`, this host's usage rows (`host: "local"`, a `provider`
  and a `state`). A Claude row's `windows` are the seats' status-line readings, one entry per reading, each with
  its `window`, `usedPercent`, `resetsAt`, `asOf` and `seatSession`. A Codex row has `windows: []`. Treating the
  readings as one account rests on the deployment assumption the row's `provenance` names (one account per
  host), not on a measured identity. Readings whose reset times disagree are reported as `anomalies`, and the
  row's `state` can then be `explicit_unknown`. Show the row's `state`, `anomalies` and each reading's seat and
  `asOf` as reported, rather than merging readings that happen to match.
- **Slack channels and people:** `GET /api/gateway/slack/channels` and `GET /api/gateway/slack/users` each return
  one page from Slack, read with the daemon's configured bot token, which never leaves the daemon. Channels are
  public and unarchived, as `{ id, name, isMember }`; people are `{ id, name, realName, displayName, isBot,
  deleted }`, with no email. Pass `cursor` (the previous page's `nextCursor`, `null` on the last page) and
  `limit` (default 100, at most 200). Inbound delivery needn't be enabled. Failures: 503 `slack_not_configured`
  when no bot token resolves, which is different from an empty list; 403 `slack_missing_scope` with the scope
  Slack names in `needed` (an older app may lack `users:read`); 429 `slack_rate_limited` with Slack's
  `Retry-After`; otherwise 502. Each request is a live Slack call, so page through a list when someone opens a
  chooser rather than polling it. Private channels and direct messages aren't listed.
- **Slices are found by folder name alone.** `GET /api/slices/:name`, `/:name/doc/*`, `/:name/proof-asset/*` and
  `GET /api/review/slice/:name` take only the name; the detail route reads `?mission` only together with
  `?project`. When two missions have a slice folder of the same name, the daemon keeps the first one it finds:
  that one is listed and served, and the other doesn't appear in `GET /api/slices` at all. Keep slice names unique
  across missions, as [Project workspace](project-workspace.md) says.
