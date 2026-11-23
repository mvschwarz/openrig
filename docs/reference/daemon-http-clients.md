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
starts a daemon. A supervisor that keeps the daemon running reads it as described in
[Run the daemon under a supervisor](getting-started.md#run-the-daemon-under-a-supervisor).

The CLI itself finds the daemon in these orders:

- **Data commands** (everything that sends a request): `OPENRIG_URL` (or the legacy `RIGGED_URL`); else
  `$OPENRIG_HOME/daemon.json` when it holds a valid `pid` and `port`; else the config keys `daemon.host` and
  `daemon.port` (environment `OPENRIG_HOST` and `OPENRIG_PORT`), which default to `127.0.0.1:7433`.
- **Status** (`rig status`, `rig daemon status`): `OPENRIG_URL` (or `RIGGED_URL`) first, probed directly; else
  the state file below. If no state is read, probe the configured `daemon.host` and `daemon.port` instead (defaulting
  to `127.0.0.1:7433`).
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
| `stuckSweep`, `wakeLadder` | The heartbeats of the stuck sweep and the wake ladder, when they run. In `stuckSweep`, `findingsRouted` counts the findings created since the daemon started (an open finding a later pass finds again is not counted again), `findingsOpen` is how many finding rows were still open after the last pass, and `lastOutcome` is `findings` when the last pass created, found again or closed one. |
| `terminals` | Whether the daemon reaches its tmux server, from what it last observed (healthz doesn't call tmux). `state` is `ok`, `degraded` (a server doesn't answer) or `unknown` (none observed yet, or a server's last reading couldn't be made); each entry of `servers` has `socket`, `state` (`reachable`, `unreachable`, or `unknown` when the return probe couldn't be read: not held, with the loss it was watching in `lastLoss`), `since` (when that state began), `lastCheckedAt`, `transitions`, and in `cause` the tmux diagnostic while unreachable or why the reading is unknown. `status` stays `"ok"`: the daemon is up even when its terminals can't be reached. |

## Bearer tokens

The daemon reads these two bearer-token settings from its environment at start:

- **`OPENRIG_AUTH_BEARER_TOKEN`** checks Mission Control's write routes (`POST /api/mission-control/action` and
  `/notifications/test`), the `/api/hosts` writes (`add`, `update`, `remove`, `pair`, `pair-decision`) and `GET /api/hosts/pair/<pairId>`, the `/api/rig-mode`
  binding writes, the `/api/network` writes (`POST /bindings`, `POST /installations` and `POST /bindings/<id>/disconnect`;
  `GET /bindings` checks no token), `POST /api/apps/v1/credentials` and `DELETE /api/apps/v1/credentials/<id>`, and
  `POST /api/gateway/slack/forwarded`, a shared Slack app's relay. The other `/api/apps/v1` routes take a Core app
  credential instead; see [Core app](core-app.md). `rig host pair` hands this token to the paired machine, so a daemon
  that will be paired with needs it set (see `rig host pair` in [the command reference](../as-built/cli-reference.md)).
- **`OPENRIG_TERMINAL_BEARER_TOKEN`** checks every `/api/transport`, `/api/compaction` and `/api/startup` route, `POST
  /api/terminal/follow`, `/viewer/ensure`, `/open-all` and `/close-all`, and every `GET /api/terminal/<name>` route, the terminal websocket
  included. It also checks these seat routes:
  - `GET /api/rigs/<rigId>/nodes/<logicalId>/preview` and `POST /api/rigs/<rigId>/nodes/<logicalId>/open-cmux`;
  - under `/api/sessions/<session>`: `GET /preview`, `/generation-record` and `/generation-record-expected`, and `POST
    /reconcile`, `/repair-missing-pane`, `/clear-attention`, `/resume-token` and `/unclaim`.

  When the daemon is bound to an explicit address (`rig daemon start --host`) that isn't loopback or a tailnet
  address, and this token isn't set, these routes check `OPENRIG_AUTH_BEARER_TOKEN` instead.

The `/api/transcripts` routes (`GET /api/transcripts/<session>/tail`, `/grep` and `/full`) do not check either
of these bearer tokens. On the default binds (loopback, and the tailnet address when Tailscale is active),
a client that can reach the daemon can read them. The [Browser access](browser-access.md) boundary still applies.

Pairing-request routes `POST /api/hosts/pair-request`, `GET /api/hosts/pair-requests` and
`GET /api/hosts/pair-request/<pairId>` do not check the operator bearer. They are open by design: a requester
does not yet have the paired machine's token. They remain subject to their pairing workflow and the
[Browser access](browser-access.md) boundary.

When one of the two bearer checks has no configured token, that check passes the request through. Other
route-specific requirements still apply. Send a token as `Authorization: Bearer <token>`; the
`GET /api/terminal/<name>` routes, the websocket included, also take `?token=<token>`. The CLI sends the terminal token from `OPENRIG_TERMINAL_BEARER_TOKEN`,
or else from the file `$OPENRIG_HOME/terminal-token`, which the person writes; the daemon doesn't create it. `rig host
approve|deny`, the TUI's answers to asks and the MCP tool `rig_question_answer` (on the answer's writes only) send
`OPENRIG_AUTH_BEARER_TOKEN` from their environment (`rig host` also takes `--bearer`), and otherwise the terminal token;
refused for want of it, `rig host` and the TUI say what to set.

A configured bearer check rejects a wrong or missing token with HTTP 401. The shared bearer middleware returns
`{ "error": "unauthorized", "message", "what_failed", "why_it_matters", "what_to_do" }`; the seat routes above
use this shared body. The Core app API also has its own credential errors; see [Core app](core-app.md).
`/api/startup` replaces an authentication failure with `{ "ok": false, "code": "terminal_auth_unavailable",
"freshAllowed": false, "message" }`.
The `GET /api/terminal/<name>` routes, the websocket included, answer `{ "error": "unauthorized", "hint" }`. A valid configured bearer token in the Authorization header can pass the browser boundary's target-name check
for a well-formed but unaccepted Host. It cannot pass a malformed Host or a refused Origin; see
[Browser access](browser-access.md).

## Event streams

All of them are server-sent events (`text/event-stream`):

- **`GET /api/events`**: the daemon's event log, stored events only. `?rigId=` limits it to one rig. Each event
  carries `id: <seq>`. `view.changed` is not stored, so it does not appear here, live or replayed; `view.changed`
  rows stored by older versions still replay until an events retention (a separate change) removes them.
  Without `Last-Event-ID`, `?replay=<n>` first sends the newest `n` stored events (`0`: none, live events only);
  `?replay=all`, no `replay`, or any other value sends the whole log first. A `Last-Event-ID` header (what
  `EventSource` sends when it reconnects) sends the events after that id instead, whatever `replay` says.
  Live events that arrive during the replay follow it, without duplicates.
  When a person clicks an answer on an ask with questions (in Steering, the Feed, Slack or an MCP client), the stream
  carries `queue.answer_recorded`: `{ qitemId, actorSession, questionId, answered, questions, complete, summary }`.
  `complete: false` means the set is still partial: the ask stays open, and its answers haven't gone back yet. The
  event carries ids and counts, not the choice; read the ask for its `humanAnswers`. A click that changes nothing (the
  same option again) has no event, and neither does a typed reply, which settles the ask through its own
  `queue.updated`. The event is recorded after the answer: if it can't be recorded, the answer still stands, so a
  client that re-reads the ask after a gap still sees it.
  A queue create the daemon refuses leaves `queue.create_refused`: `{ sourceSession, destinationSession, reason, status,
  hostId }`, where `reason` is the response's own error code or text. A send to a destination that doesn't resolve, when
  nothing is kept in the sender's outbox, leaves `transport.send_refused`: `{ senderSession, session, reason, status }`.
  A forwarded create whose result is unknown (it timed out, so the remote may still commit it) leaves
  `queue.create_remote_unknown`: `{ qitemId, sourceSession, destinationSession, hostId, failureClass }`; reconcile by
  `qitemId` before retrying. A send kept as a failed message in the sender's outbox is none of these: read it with
  `GET /api/queue/outbox/list`. The events carry no message body and are never written for an accepted request; the
  refused command's own response is unchanged. Read the reason and the parties from this stream or the `GET /api/events`
  replay; `rig telemetry events` shows event metadata only, with no payload and no filter by type.
- **`GET /api/activity/events`**: live only, no replay or ids. Each message is named after its event type:
  `seat.activity_changed`, `seat.rung_health`, `proof.judged` or `proof.sources_changed`. It tells a view to read
  again; it carries no derived state.
- **`GET /api/views/sse`** (alias `/api/views/watch`) and **`GET /api/views/<viewName>/sse`**: `view.changed`, live
  only. Its `id:` is the `seq` of the stored event that caused it, so it can repeat across views and is not a replay
  cursor.
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

The queue and outbox lists are bounded snapshots, not subscriptions. A queue list cut at its `limit` says so in its
`X-OpenRig-Truncated: 1` response header; read it again with a larger `limit`.
An outbox entry's `deliveryState` reports the send attempt; only `delivered` confirms delivery. A queue transition,
an open FYI, or a closed ask is not that receipt. The rig-wide reads and their limits are described below; the existing
`outbox/list?senderSession=<session>` read remains available.

### What needs a person, and how their answers link back (`team-operations.v1`)

`GET /api/team-operations/capabilities` says which team-operations jobs this daemon supports, separately from its
build:

```json
{ "contract": "team-operations.v1",
  "capabilities": { "needs-me.read": "supported", "needs-me.answer": "not-supported", "needs-me.follow": "not-supported" },
  "build": { "semver": "…", "commit": "…" } }
```

A capability reads `supported`, `not-supported` or `unknown`, and a missing key means `unknown`. A daemon without the
route (HTTP 404) predates the contract: keep reading what it already returns. In a source run, `build` is
`{ semver: null, commit: null }`.

With `needs-me.read` supported:

- **What needs the person:** `GET /api/attention?view=<person-id>` (the same read as the Feed). Each queue item adds
  `revision` and `about`. `revision` is the request's opaque decision revision: the same value as that row's
  `decisionRevision`, and what an answer can name as `expectedRevision` so it applies only to the version the person
  read. `about` lists the requests it concerns by id: a row parked on the person is itself the request, and an ask is
  about the open rows blocked on it (the newest 100, with `aboutTruncated: true` when there are more). An empty `about`
  isn't proof that it's about nothing: a request that names it only in its text isn't counted.
- **Only the asks, for a badge you poll:** add `kind=action`
  (`GET /api/attention?view=<person-id>&kind=action`). It reads only the queue's asks and parks, the items with
  `kind: "action"`, and gives exactly the ones the full read gives for that view, with the same `revision` and `about`.
  It skips the updates, proof judgments, mission outcomes and health the full read also builds, and `sources` says so
  with a `kind` entry marked `partial`. `kind=update` reads the rest. A `view` naming no registered person returns its
  `perspective` with no items, without reading anything else.
- **A snapshot watermark:** the response's `watermark` is the newest event `seq` read before the snapshot. Follow
  `GET /api/events` from it with `Last-Event-ID: <watermark>`: every event after the snapshot is replayed, some possibly
  already reflected in it. A click that records or changes an answer emits `queue.answer_recorded` even while the set
  is partial. An identical repeated choice, or a later click after a pending ask's answer set is complete, records
  nothing new and emits none. Events are best effort; re-read the snapshot or row after a stream gap.
- **The answers returned to a request:** `GET /api/queue/<qitemId>` adds `answers`, oldest first, each
  `{ qitemId, by, at, text, episode, recordedIdentity }`. They are found by the answer row's link to the request, not
  by its text, so don't parse the `In reply to:` line in an answer's body. `text` is the person's answer without that
  footer. `episode` names the park an answer belongs to, or is null. `recordedIdentity` is the identity provenance
  recorded when the answer row was created. An answer row's own read has `replyTo`, the request it answers. A partial
  set of choices stays on the request's `humanAnswers` until the whole set is returned. A runner's permission request
  or a host pairing request is answered in place, with no answer row. `answersFrom: "this-daemon"` says where they were
  read: an answer another host holds isn't among them, so an empty list isn't proof that nobody answered.

### A companion app that shows a person what needs them and answers as them

An app for the person a team asks questions, such as a phone app for reviewing and steering, can be built on the
existing [Core app job](core-app.md). In that page's words, `/api/apps/v1` is "an instance-local, versioned facade for one
job: see a structured human question, answer as a registered person, recover that submission, and follow its actual
recorded answer and linked work". The steps below add no route and no promise; each inherits that page's rules and limits.

1. **Reach the daemon.** Find it as in [Finding the daemon](#finding-the-daemon). A browser app also needs its exact
   origin in `OPENRIG_ALLOWED_ORIGINS` in the daemon's environment, then a daemon restart. "A bearer token does not
   override this" ([Browser access](browser-access.md)). An app that reaches the daemon by a name it doesn't recognise,
   such as a custom DNS name or a proxy's domain, also needs that name in `OPENRIG_ALLOWED_HOSTS`; the machine's own
   name, its IP addresses and its Tailscale name are recognised already.
2. **Get the app its own credential.** The owner issues it for the registered people the app answers as:
   `POST /api/apps/v1/credentials` with `{"appId", "actors": ["<person>@external"], "job": "human-answer",
   "attribution": "app-attributed"}`, through the same owner gate as `/api/mission-control/action`. With no owner
   bearer configured, that gate admits any request the daemon accepts, so on a tailnet bind any peer that passes
   Host/Origin can issue one ([Access and identity](core-app.md#access-and-identity)). Store the one-time
   `orapp_…` token as [Access and identity](core-app.md#access-and-identity) says. The credential "is not human login":
   Core's claim is "person attributed by authenticated app X, never independent human authentication", and any
   credential can read any person's questions and their linked results. Every read and write names one of the
   credential's own actors (`?actor=`, or `actor` in an answer), and another returns 403: that says who's acting, not
   what's visible.
3. **Check support, then read what needs the person.** Every app call sends `Authorization: Bearer orapp_…`.
   `GET /api/apps/v1/capabilities` returns `contract: openrig.core-app` and `version: 1`. An older daemon may return an
   ordinary 404, which means the job is unavailable. `GET /api/apps/v1/needs-me?actor=<person>` lists the current
   structured asks in that person's Feed perspective. `GET /api/apps/v1/requests/<requestId>?actor=<person>` gives one
   in full: its body, the actual question and option ids, the answers so far, the opaque `decisionRevision` and the
   episode. Show the options as they are: an ask with no structured questions has `answer: null` and an
   `unsupportedReason`, and no questions are inferred from its text.
4. **Submit the person's exact answer.** Save a random answer id and the exact payload first, then
   `POST /api/apps/v1/answers/<answerId>` with `job`, `actor`, `requestId`, `questionId`, `episodeKey`,
   `expectedRevision` and an `answer` of `{"kind": "option", "optionId"}` or `{"kind": "typed-reply", "text"}`
   ([Discover, read and answer](core-app.md#discover-read-and-answer)). It goes "through the existing Mission Control
   answer owner".
   - **What the receipt says happened:** `outcome: recorded` is a partial choice. `outcome: answered` means the existing
     answer owner accepted the whole answer. Read the receipt's `submission.replyQitemId` first, then its optional
     `message`:
     - **`replyQitemId` names a row, with no `message`:** the answer was returned to the asking agent as that new row,
       which wakes it the way any new row does (a hosted member with no wake trigger reads it only when it next checks
       its queue).
     - **`replyQitemId` names a row, and `message` says "Already answered":** that row is the original return, and no
       new reply was sent.
     - **`replyQitemId` is null:** a runner's permission request, answered in place. Its `message` says whether the
       answer went to the receiving agent, or is kept on the request, which is still waiting because no agent could read
       it or the handoff couldn't complete. Show the kept one to the person: their answer is saved, and no agent has it
       yet. A request the answer closed, with no receiving agent here, has no `message`.

     Either way, `answered` "never proves a native effect".
   - **Retries:** after an uncertain response, retry the same id and payload. Each 503 in
     [the 503 table](core-app.md#discover-read-and-answer) says what's known about persistence, and
     `app_job_unavailable` with no `submission` says nothing about an earlier attempt.
5. **Follow it to its actual result.** `GET /api/apps/v1/requests/<requestId>/result?actor=<person>` reads the actual
   return, permission and linked-work facts, separately from the receipt
   (`GET /api/apps/v1/answers/<answerId>?actor=<person>`, the receipt's `links.self`).
   `GET /api/apps/v1/events` carries only invalidations; reread on each one, and follow
   [Refresh and interruption recovery](core-app.md#refresh-and-interruption-recovery) for polling and after a gap.
   - "Never invent a revision or infer completion from an absent card."
   - "A queue closure is that record's closure, never a claim of mission or product success."
   - It's instance-local: another host's asks and answers aren't in it.

**Read only, without an app credential:** `GET /api/attention?view=<person-id>&kind=action`
([above](#what-needs-a-person-and-how-their-answers-link-back-team-operationsv1)) shows that person's asks with `revision`
and `about`. It's a view, not proof of who's using the client, and it doesn't answer: `needs-me.answer` reads
`not-supported` in `GET /api/team-operations/capabilities`.

### What a connection supports, and what happened to a delivery (`member-connection.v1`)

`GET /api/member-connection/capabilities` lists each delivery route this daemon declares, with what it supports in four
groups: `observe` (`dialog`, `turnStart`), `control` (`submit`), `nativeIdentity` (`sessionId`, `resume`) and
`continuity` (`managedCompaction`, `restorePacketConfirmation`, `fork`). The routes are `typed` (OpenRig types into the
member's terminal; capabilities by runtime, with `*` for any other), `codex-queue` (Codex's own queue command), a hosted
member's `hosted-trigger`, and a person's `gateway`. A route with `armed: false` is declared but not used: nothing is
delivered on it until a setting arms it.

Each capability reads `supported`, `not-supported`, `unavailable` (the route has it, but this member can't use it now,
such as a seat with no session recorded as current), `not-applicable` (it means nothing on this route) or `unknown`. A
missing key means `unknown`. None of them means idle or success, and a declaration isn't readiness: whether a seat has a
current session comes from what OpenRig has recorded, not from looking at its pane or process. A daemon without the route (HTTP 404) predates the contract: treat
every capability as unknown and keep using what works today.

`?session=<address>` adds `member`: `{ member, route, runtime, capabilities, reason? }` for the member that address
names: a person the human registry resolves (or the terminal person's own `human@host`), a hosted member, or a seat. An
address shaped like a person's, such as `<id>@external`, is a person only when the registry resolves it. A person is
resolved first, so when the registry can't be read, any address it could resolve to a person (`<id>@external`, or any
`member@rig`, since a person's id can be spelled that way) comes back unknown, even if a seat or hosted member has that name. That
answer, and an address none of them has, comes back with `route: null`, every capability `unknown`, and the reason.

Each typed send also records what happened to it, in the daemon's `transport.delivery_evidence` event, as
`outcome: { fact, reporter, route }`. `fact` is `accepted` (typed and submitted, with `renderVerified: true` when
the screen showed it), `held`, `not-delivered`, `failed-effect-unknown` or `unknown`. A prompt answer typed without Enter on a send that
succeeded is `unknown`: whether the prompt took it isn't known; if the send failed after typing, it's
`failed-effect-unknown`. `reporter` says who established it.
None of them means the member read the work: picking it up is a claim on the row.

What reads these declarations:
- **A handover's packet.** Only a runtime declared with `continuity.restorePacketConfirmation` has its input box read
  until the restore or priming packet leaves it. On any other runtime the handover's result carries
  `restorePacket: { status: "accepted", reason }`: typed and submitted, not seen consumed. `sideEffects.startupContextDelivered`
  stays `true` there for existing readers and means the same thing, accepted; read `restorePacket` for what was seen.
- **A send's dialog check.** After a fresh hook, the dialog and picker checks run before typing only on a runtime
  declared with `observe.dialog`. The other screen checks before a send don't read the declaration.
- **A watchdog's history.** When a send returns, the watchdog's history records its `deliveryFact` and, when the screen
  showed it, `deliveryRenderVerified: true`. Exceptions and receipt reconciliation may have no fact; absence of a fact
  or render flag establishes no positive delivery or verification claim. These are outcome words, not a capability
  gate: the reminder's status, receipts and retries don't change with them.

## Route details

- **A rig's queue history:** `GET /api/queue/list?rig=<rig>&updatedSince=<ISO time>&sort=updated` returns the
  rig's queue items (any whose source or destination seat is in the rig) updated at or after that time: open items
  (`pending`, `in-progress`, `blocked`) first, then the rest by latest update. `limit` defaults to 100 and has no
  upper cap. The list is cut after `limit` rows in that order. The body stays a bare array; the response headers
  carry `X-OpenRig-Limit` (the limit applied) and `X-OpenRig-Truncated`, `1` when more rows matched than were
  returned and `0` when they all fit, so a full page that holds every match isn't mistaken for a cut one. When it
  says `1`, raise `limit` to read them all. A negative `limit` doesn't bound the read, and the response has neither
  header. With `attention=1`, when the read reaches its limit but the attention check leaves `limit` rows or fewer,
  the response has neither header either; read again with a larger `limit` to know. `rig queue list` prints a line on
  stderr when the page was cut, and the `rig_queue_list` MCP tool adds `limit` and `truncated` beside `items`. Both
  rely on these headers: from an older daemon that doesn't send them, or when `X-OpenRig-Truncated` isn't an
  explicit `0` or `1`, the CLI prints no line and the MCP result has no `limit` or `truncated`. Each item's own
  history is
  `GET /api/queue/<qitemId>/transitions`. This read scans the queue table, so read it occasionally rather than
  polling it. For live changes, treat `GET /api/queue/sse` events as hints to read
  `queue/list?rig=` again. Not every event names both seats (`queue.claimed` and `queue.unclaimed` carry only the
  destination), and not every state change is on that stream, so the events alone don't track a rig's items.
- **A rig's messages:** `GET /api/queue/outbox/list?rig=<rig>` returns the messages sent from or to the rig's
  seats, newest first; `?senderSession=<session>` still returns one sender's. One of the two is required; with
  both, `senderSession` is used and `rig` is ignored. `limit` defaults to 100. No event is sent when a message is delivered, so read this list to see delivery
  states.
- **`GET /api/queue/recent-transitions`** returns at most 1,000 rows. A positive `limit` above 1,000 is capped at 1,000;
  a missing, zero, negative or unparseable `limit` defaults to 20.
- **A watchdog job's quiet count:** `GET /api/watchdog/<jobId>/status` (what `rig watchdog status` prints) returns
  `quiet` beside `job` and `recentHistory`: `{ since, total, byReason, lastReason }`. It counts the quiet decisions
  the engine made for that job: a policy's skip whose reason is in the engine's quiet set (a policy's own `not_due`
  included) and the active-wake throttle's `active_wake_not_due`. It doesn't count scheduler ticks, loud skips,
  delivered work, or the other evaluations that end without a history row (a job no longer active, a rig delivery
  drain, a wake-accounting retry, a reminder held for its pass). It is kept in memory: `since` is when the daemon
  started, and a restart counts again from zero. A job with no quiet decision yet reads `total: 0` and
  `lastReason: null`. Two reads give a rate of quiet decisions; that rate alone doesn't show the scheduler's cadence
  or health, and the loud outcomes stay in `recentHistory`.
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
  `scopeIgnored` when a scope wasn't applied. The instance keeps `rootObjective`, which every instance read returns
  (`/api/workflow/list`, `/api/workflow/<id>` and its `trace`). An instance started before it was kept reads `null`.
- **`GET /api/workflow/list`** accepts exact `project`, `mission`, `slice`, `rig` (the bound rig), and `name` (the workflow name) filters, repeatable `tag` filters on the instance's free-form scope tags, and `limit` from 1 to 10,000. Filters combine with AND and apply before the limit; results keep their existing oldest-first order. Instances without the requested scope or binding do not match. Without these filters, existing list behavior is unchanged.
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
- **Queue state counts on `GET /api/slices`:** every list row has `queueCounts`, a current, uncapped count by
  `pending`, `in-progress`, `done`, `blocked`, `failed`, `denied`, `canceled` and `handed-off`; it is `null` when
  the row's project/mission scope cannot be resolved or catalog/candidate-root discovery is incomplete. This is
  separate from the existing `qitemCount` display membership field. Counts match exact typed `project:`,
  `mission:` and `slice:` tags in one shared queue scan. A `project:` tag naming a former id a project declares
  under `aliases:` counts as that project ([Project workspace](project-workspace.md#renaming-a-project)).
  Physical candidates include configured indexer roots and every catalog project's missions root. A row may omit
  `project:` or `mission:` only when its remaining tags identify exactly one physical slice with a resolved project
  and mission. Ambiguous matches count nowhere,
  even if first-wins discovery or a list filter leaves only one row visible; an explicit mismatched project or
  mission never counts. Several `slice:` or `mission:` tags on one row count only when they all name the same
  physical slice or mission (a slice's folder name and its frontmatter `id:`, say); a row that names two distinct
  slices, missions or projects counts nowhere, while `qitemCount` can include it under several tagged slices,
  subject to the existing project filter and the newest 500 rows per slice. Counts are recomputed on every list
  request. `?refresh=1|true` invalidates the separate listing cache, not a stored queue-count snapshot. This
  resolution does not change the returned slice list or filters.
- **A terminal viewer's pane size:** add `?geometry=1` to the terminal websocket (`GET /api/terminal/<name>`) to
  learn the pane's columns and rows, so a browser terminal wraps lines where the agent's pane does. The size arrives
  as a binary frame holding UTF-8 JSON, `{"type":"geometry","cols":<n>,"rows":<n>}`: once when the viewer joins,
  before any output, and again whenever the pane's size changes (checked about every two seconds). Terminal output
  is always a text frame, so set `binaryType = "arraybuffer"` and read only binary frames as size frames. xterm.js's
  `AttachAddon` writes every frame to the terminal, binary ones included, so a viewer using it should leave
  `?geometry=1` off or read the socket's messages itself. With `terminal.fixed_geometry` on, the frame reports the
  pinned 90 by 27, or the window's own size when OpenRig didn't pin it: someone fixed its size by hand, or its sizing
  couldn't be read. When the size can't be read, no frame is sent
  and the socket stays open. The viewer is told the size and never sets it: the socket still has no resize message.
  Without the flag, the socket's frames are unchanged.


## Resume one banked original conversation

The opt-in original-only operation reuses `startup-history.v1`. It targets one exact rig and node,
with a retained snapshot and captured history. Platform boot enrollment remains an operator step.
These routes use the existing terminal bearer token.

1. Read `GET /api/startup/<rigId>/nodes/<nodeId>/original?snapshotId=<id>&historySessionId=<id>`.
   The preview uses that explicitly retained usable snapshot, even when a newer snapshot exists.
   It returns `revision`, the selected history and current model, effort, cwd and permission.
   `settingsSource.accountHome` describes the seat's current effective home configuration;
   `settingsSource.runtimeHome.uses` describes the home bound to this reviewed attempt, which can differ.
   Neither home selection proves an authenticated account; `accountHome.authentication` remains
   `"unconfirmed"`. A `daemon_environment` home is the daemon fallback, not a seat setting;
   `native_default` means the runtime default.
2. POST to the same `/original` path, without query fields, with `action: "resume"`, `snapshotId`,
   `historySessionId`, that `revision`, an `operationId` UUID, and `expectedOriginal` containing the banked
   `nodeId`, `sessionName`, `runtime` (`claude-code` or `codex`) and `nativeId`.
   Keep native conversation IDs in the private bank and request body. They are not returned in diagnostics.

It resumes only while the seat's recorded session still names the banked conversation. A `/clear`, `/resume`
or new conversation in that seat normally records a different one, and so does a changed resume type or
restore policy. After that, the preview answers `selection_changed` with "This seat's record changed since it
was saved", naming `rig snapshot <rig>` to save the current conversation, and a resume request returns a
partial `selection_changed` result. The preview compares the seat's current conversation, not only the saved
history row: a current session that names another conversation, or a present agent (behind a prompt or not)
whose proved native identity is another one, also answers `selection_changed`. Otherwise it answers as before
and adds `currentConversation`: `{ "state": "same", "basis": "record" | "running_agent" }`, or, when the
current conversation can't be established, `{ "state": "unknown", "reason": … }`, with `identityEvidence` for a
present agent. An unknown one is reported, not refused, and its diagnostics carry no native IDs. A changed runtime is refused earlier: the preview answers
`source_unavailable`, also naming `rig snapshot <rig>`, and a resume request returns a partial
`original_changed` result.

The operation keeps the current model, cwd, effort and permission choices. The reviewed
`settingsSource.runtimeHome.uses` plan can first apply the selected original's recorded home as a new
revision before launch, rather than using the current home reported by `settingsSource.accountHome`.
Its original-only native effect uses the retained history and existing selected-history ownership checks.
A positively established matching original already running returns `code: "already_running_original"`
and `nativeEffect: false`. A confirmed resume returns
`code: "resumed"`, with `sourceSessionId`, `resultSessionId` and `operationId`.

An unavailable source, changed selection, different occupant, restoring-only result or unconfirmed native
identity returns a partial result. Existing occupants stay in place. This selected operation never substitutes
a fresh conversation. Its current-original check needs the existing qualified occupant, pane and native-record
evidence; a stored resume token by itself is insufficient. A legacy named history that cannot establish the
banked native identity remains partial. For Codex, the PID/start-time log and transcript are resolved in the
current selected runtime home used for launch. With no explicit home, the existing default-home and PID-bound
process-HOME reader supplies the home; the transcript lookup uses that same positively resolved home. Another
home's copy of the same thread UUID is not selected. These checks also serve conditional sends and record reads.
If a recorded explicit home changes before its running process is relaunched, its record may be unavailable;
the check does not borrow another home's copy or change the running process's account.

Retain the operation ID after a timeout. Repeating that same request first reconciles current native identity;
it reports a matching running original or `operation_unconfirmed`, and never dispatches that operation again.
The correlation survives daemon restart. An operation ID reused with different input returns
`operation_conflict`. Inspect the recorded operation and seat before selecting any new attempt.

A source-level fixture pass establishes the tested ownership, selection and reporting paths. Actual native
conversation usefulness and authenticated-account continuity need a qualified runtime observation.

## Per-rig delivery drain

A maintenance owner can hold automatic queue wakes, watchdog delivery and stuck-sweep findings directed to one rig:

- `GET /api/rigs/:rigId/delivery-drain` reads its current control and retained-notice counts.
- `POST /api/rigs/:rigId/delivery-drain` begins a window, or renews the same window's review deadline:

  ```json
  {"drainId":"maintenance-window-1","owner":"maintainer@example","reviewAt":"2026-12-01T12:30:00Z"}
  ```

- `POST /api/rigs/:rigId/delivery-drain/end` with `{"drainId":"maintenance-window-1"}` explicitly ends that window.

Status includes the owner, start, review deadline and drain ID, `retainedWorkCount`, and `nativeStartsDeferred: false`.
The retained count is pending queue-wake intents plus due watchdog jobs, excluding maintenance review jobs; it is a count of notifications, not unique tasks. Work keeps its existing queue/outbox/job identities. Other destination rigs continue normally; a row's source rig and a watchdog's registering rig are provenance, not drain admission criteria.

A deadline prompts the recorded owner through the existing watchdog; it never ends a drain automatically. Review checks and repeat prompts have a five-minute minimum interval, including a past or near deadline. Its review job remains usable even if its owner's rig also has a delivery drain. Repeating BEGIN with the same ID and settings keeps the same window and job; renewal preserves the start. An active window is returned as status if a different ID is requested. A completed window's ID never starts it again.

END changes only the named current window and schedules one existing recovery pass for its pending queue notices. Repeating END does not schedule another pass. A delayed END for an earlier window cannot end a later one. `releaseScheduled` reports scheduling, not successful delivery: notices still use current queue state, recipient checks and normal receipts. The END pass adds no retry of failed, uncertain, in-flight, delivered or manually retained input. Completed work reconciles normally; existing failed or uncertain outcomes keep their ordinary recovery and visibility.

This is delivery-only maintenance. Direct sends, control/END requests and ordinary reads stay usable. Automatic native starts are **not deferred**, and input already in flight can finish. Coordinate native or daemon lifecycle work separately; this control does not promise all-activity quiet or graceful stop.

The automatic wake ladder also waits before attempt budgets, rung markers and escalation for work whose destination rig is drained, including a held escalation target. It resumes at the retained rung after END. Legacy workflow packets without outbox intents remain owed: their existing keepalive resumes after END, and the sweep reports them if they stay unclaimed. END's scoped recovery pass covers pending intents. Diagnosis re-presentations wait before spending their presentation receipt. An explicit resolve notification remains an explicit action and can pass through the delivery hold.

All watchdog evaluation for the held rig waits, including the context-usage watchdog's managed-compaction action. This does not add a native-start hold. If a drain admission read fails, automatic delivery proceeds and reports the uncertainty. Control/status failures remain errors, and failed BEGIN/END writes never report success.
