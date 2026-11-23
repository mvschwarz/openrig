# Hosted members: a tool outside the terminal on your team

A hosted member is a tool that lives outside a terminal, such as an assistant, a chat bot or a cloud routine, and works as a member of a rig. You
address work to it like any seat. It reaches the team through OpenRig's MCP server under a grant you issue and can revoke. It never gets a pane.

Assistants that run on your machine can reach OpenRig's MCP server locally. Many assistants live in a vendor's cloud, and those can only reach a server on the internet.

> **Experimental and unsupported. Off by default.** Nothing in OpenRig listens on the internet unless you set it up yourself. You serve `rig mcp serve --http`, put it behind your own TLS tunnel or proxy, and issue a token. Doing that is like opening a port in your firewall. Anyone with the URL and a valid token can act as that member within its grant. Treat the token like a password, give the member the narrowest grant, and revoke it when you're done (`rig mcp token revoke <name>`). We don't support, and take no responsibility for, an OpenRig reachable from the internet, just as with running OpenRig itself on the open internet. Use at your own risk.

## Set one up

1. **Pick its address** on an existing rig: `<member>@<rig>`, for example `grok@research`. No node is added; the queue takes rows for it.
2. **Say what it's good at, and its limits,** in a roster: an entry in `<workspace.root>/rosters/<file>.json` with its seat, this machine's host id
   (`hostSelfId` from `rig ps --nodes -A --json`), `capabilities`, `use_when`, `why`, a `caveat` for its limits, and `"hosted": true` (see
   [Rosters](rosters.md)).
3. **Issue its grant:**

   ```sh
   rig mcp token add grok --seat grok@research --rig research
   ```

   It prints the token once. The member acts as `grok@research`: every row it creates or changes is attributed to that seat, and it reaches only
   that rig's seats and work.
4. **Serve the MCP server over HTTP** behind a tunnel or proxy that adds TLS: `rig mcp serve --http`. See `rig mcp serve --help` for binding and
   for how authentication works. If the proxy runs browser checks (such as Cloudflare's Browser Integrity Check), skip them for `/mcp`:
   MCP clients aren't browsers.
5. **Add the server in the tool:** its `https://…/mcp` URL and the token as a bearer credential.

## How it works its rows

- **Hand it work** as you would any seat: `rig queue create --destination grok@research …`.
- **The member works it** through the MCP tools:
  - `rig_queue_list` with `owned` lists its rows;
  - `rig_queue_claim` takes one;
  - `rig_queue_update` closes it done with the answer in `resolution`, or `rig_queue_handoff` hands it on to a seat in its rig.
- **It can send work too:** `rig_queue_create` to its rig's seats.
- **Its rows outlive the conversation.** A new conversation with the same grant reaches the same work.
- **`rig_whoami`** answers the seat its grant names, though the member has no session.

To wait for one task's answer in the same read, call `rig_queue_show` with its `qitemId` and optional `waitSeconds`
(an integer from 0 to 50). Omitted or zero keeps today's immediate read. A positive wait holds only while that item
is `pending` or `in-progress`; a claim, progress note or another item's change does not finish it. It returns at once
when the item leaves those states, including `blocked`, `done`, `handed-off`, `failed`, `denied` or `canceled`.
State, closure reason, resolution, transitions and any visible successor keep their usual meaning; no successor is
automatically followed. At the bound the current item returns with an additive top-level
`waited: { outcome: "timeout", seconds: <requested bound> }`. A timeout is not an answer or completed work.
Cancellation or a disconnected HTTP call releases the wait without changing the durable task. The read uses the
same grant scope as an immediate read; another member's private task is still refused. Keep the caller's MCP timeout
above the requested bound (the usual SDK default is 60 seconds); only this daemon call gets a longer timeout, not
ordinary requests. `GET /api/queue/:qitemId?waitSeconds=<bound>` offers the same wait to daemon API callers.

## Asking a person while keeping the work

When a row needs a person's approval before the member can finish it, the member keeps the row and asks:
- **The row came from a person:** the member sets it `blocked` with `blockedOn` that person, and puts the question, with a short form of
  what it will do, in the row's `summary`. The person is asked with the summary and the row; a transition note stays in the row's history
  and isn't part of the ask. A longer draft goes at an https link in `evidenceRef`, which the ask carries. The person's answer returns the
  row to the member in progress.
- **The row came from a seat, or from a shared channel:** the member asks as a new row, to that seat, or for a channel's row to its rig's
  lead (a shared channel takes correspondence and can't answer an ask). Then it sets its own row `blocked` on the new row's id. When the
  question closes, the member's row returns to pending.
- **Keep the question and action summary short.** A long row body continues as numbered thread replies, within the existing delivery
  limits. Use an https `evidenceRef` for a longer approval draft. The summary and framing can still be too large, so nothing promises
  unlimited delivery.

Either way the row reads blocked, not done, while it waits, and the member finishes that same row. Nothing promises to wake the
member, so it checks its rows again.

The server tells the member this in its MCP instructions. The text is versioned, so you can check which version a tool received:

> Member workflow (member-workflow/v3). Your inbox is the items addressed to your seat: rig_queue_list with owned set. It's yours, not the team's queue. A wake, a ring or a message only points at it: list your inbox, then act. For each item: claim it (rig_queue_claim), do it, then close it done with closure reason no-follow-on and the answer in resolution (rig_queue_update), or hand it on (rig_queue_handoff). Listing or reading an item doesn't take it. An item titled "Checked on …" is OpenRig's check on other work, not a task: act on the item it names, or the items it lists, and the check closes itself. Say what you can reach from your grant, not from the tool list: a listed tool isn't access. rig_artifact_read's answer for an item names the shared roots you may read, and none means no shared files. If the person connected you, that's basically authorized: claim the items in your inbox and do them without asking whether you may. When an item needs a person's approval before you can finish it, don't close it and don't take the action: keep the item and ask. If it came from a person (an address ending in @external that isn't a shared channel; the item's 'Shared channel:' line names one), set it blocked with blockedOn that person and, as its summary, the question with a short form of what you'll do: the person sees the summary and the item, not your note, which keeps the record. Link a longer draft as an https evidenceRef. Their answer returns the item to you in progress. Otherwise ask as a new item, to the seat it came from or, for a shared channel's item, to your rig's lead (rig_team shows it), with your question and draft. Then set yours blocked with blockedOn that new qitemId: when that item closes, yours returns to pending, to claim again. Nothing promises to wake you, so check your inbox again. Then finish the same item; don't open a new one.

## Ring it when work lands

If the tool has a trigger that starts it from outside, such as a webhook on a scheduled routine, add it to the member's roster
entry. The entry holds secret names, never values:

```json
"wake": { "webhook": { "url_ref": "GROK_WAKE_URL", "authorization_ref": "GROK_WAKE_AUTH", "secrets_env_file": "/abs/path/grok-wake.env" } }
```

- **The secrets:**
  - `url_ref` names the secret holding the webhook URL.
  - `authorization_ref`, when the tool needs one, names the secret holding the `Authorization` header value.
  - Credentials in the URL itself (`https://user:pass@host/…`) are sent as Basic `Authorization` instead, unless
    `authorization_ref` is set: then its value is sent, and the URL's credentials are dropped.
  - `signing_secret_ref`, when the trigger verifies signed webhooks, names the secret holding a
    [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
    signing secret.
    - **Use the `whsec_` form** (`whsec_` followed by base64): the sender and the receiver both decode it to the same
      key.
    - **A value without `whsec_` is used as its raw UTF-8 bytes,** as receivers that accept raw secrets read it.
    - **The headers:** each ring then carries three, alongside any `Authorization`:
      - `webhook-id`, new for every ring, including a row rung again for a new wake;
      - `webhook-timestamp`, in seconds;
      - `webhook-signature`, which is `v1,` and the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.` and
        the body bytes exactly as sent.
    - **When the ring isn't sent:** if the secret it names isn't set, or is `whsec_` followed by nothing or by text
      that isn't valid base64 (with its padding), the ring isn't sent. The result is
      `failed:webhook (<url_ref>) not rung: its signing secret (<name>) …`, never an unsigned ring.
    - **Header names:** a receiver that reads other header names, such as a provider's own prefixed ones, doesn't
      verify these.
  - The daemon reads each from its environment (the name, or `OPENRIG_<NAME>`), else from `secrets_env_file`, an env file kept at mode 0600.
- **The ring:** when a row lands for the member, the daemon POSTs
  `{"source":"openrig.queue","schema_version":1,"event":"work-waiting","qitem_id":…,"destination":…,"summary":…,"from":…}`.
  - It's a pointer, not the row's body: the member reads the row under its grant.
  - A receiver should tolerate a repeated `qitem_id`. A ring accepted just before the daemon stops, before it's recorded,
    is rung again on recovery, the same at-least-once window a terminal wake has.
  - It waits up to 10 seconds and doesn't follow redirects. A ring with no answer by then may still have reached the
    trigger, so it reads unknown, not failed, and durable recovery doesn't repeat that recorded wake (other recovery paths
    can still ring it again). The member sees the work when it next checks its rows.
- **What the trigger should do:** start a run that lists the member's rows (`rig_queue_list` with `owned`) and claims its work.

## What the record says, and doesn't

These facts stay separate on the row:
- **Wake:** with a trigger, the row's wake result is `wake-accepted:webhook (<url_ref>) answered <status>` when the trigger took the
  ring, `indeterminate:webhook …` when it didn't answer in time, or `failed:webhook …`. Accepted means the tool's trigger
  answered, not that the member read the row.
  - With no trigger, the result is `awaiting-pickup: …`: no wake is sent, and the work waits until the member reads its queue (rows
    recorded before this wording read `unroutable: …`, and both are read the same way). The member finds work by reading its own inbox and picks a row up by claiming
    it, so a row gets no finding of its own. Work it leaves unclaimed past the stuck sweep's unclaimed age
    (`queue.stuck_sweep_unclaimed_age_minutes`, 60 by default) is listed in one standing notice per member. The notice goes to
    the operator seat when it's a person, else the rows' creator when they all share one, else the operator agent, else the
    member itself. A notice to a creator lists only that creator's rows: when another creator's row joins, the notice moves to
    the next recipient. It says whether the member has read its own pending inbox recently: a check-in, never a receipt or a
    claim. A member with a declared route (a delegation parent or `escalates_to`) gets one finding per unclaimed row at that
    route instead. A finding is a diagnostic about its row, not a second assignment: read the row and act on it. Closing the
    finding alone doesn't complete the row, and the sweep closes the finding itself once the row is no longer stuck.
  - It tells the person too when the member was rung but hasn't claimed the work by the stuck sweep's unclaimed age
    (`queue.stuck_sweep_unclaimed_age_minutes`, 60 by default).
  - The member sees new work when it checks: when it's rung, when its person asks it to, or on a schedule the tool runs.
- **Pickup:** its claim, a transition by its seat. Listing or reading a row isn't pickup.
- **Result:** the closing transition and its resolution, or the handoff.
- **Notification:** where a person asked, Slack's posted receipt. A posted notice isn't the person's acknowledgment.

**On the team:** `rig_team` lists the rig's hosted members (roster entries marked hosted that aren't one of its nodes), with their capabilities and caveat, no pane, and activity `unknown`. With an external grant offering `team/list`, call it without `rigId` to discover the connected team. It selects the grant's sole rig, or returns only its granted names when a choice is needed.
OpenRig doesn't observe a hosted member between its calls, so it never reads idle. `rig roster find` shows it the same way.
- **Presence:** each entry carries `presence`, which says what OpenRig last saw of the member. It isn't pickup, and `null` means unknown:
  - `lastCallAt`: its last authenticated call to this host's `rig mcp serve --http`, recorded at most once a minute in
    `<OPENRIG_HOME>/mcp-http-presence.json`, beside the token file;
  - `lastWake`: its latest ring and the result, among its 50 most recent rows;
  - `checkIn`: its check-in status, last check-in and stated cadence, as described in [Check-in status](#check-in-status)
    (unknown, with the reason, when the daemon gives none).
- `rig roster show` and `find` show the last call; the last ring is in `rig_team`.

### Check-in status

A connected assistant (a roster member marked `hosted: true`) checks in each time it reads its own pending inbox (through the queue list, as the MCP list tool does
when it lists the member's own work). Other calls it makes don't count yet. Its status compares its last check-in with
what its roster entry states: a cadence (`check_in_minutes`), or that it checks in when a person asks it
(`check_in_on_request: true`):

| Status | Meaning |
|---|---|
| `checking-in` | its last check-in is no older than twice its stated cadence |
| `check-in-overdue` | its last check-in is older than that: its schedule may be off or waiting for an approval |
| `no-check-in-yet` | no check-in recorded for it on this daemon, whatever its entry states |
| `on-request` | its entry says it checks in when a person asks it |
| `disconnected` | reserved for a recorded revocation or removal of its connection. Nothing records one yet, so a revoked assistant reads overdue (or unknown, with no cadence) |
| `unknown` | its entry states neither, its statement can't be used, or its check-ins couldn't be read; the reason says which, and its last check-in is shown. OpenRig assumes no cadence, so this never reads idle or overdue |

Each place it's shown gives the evidence with it, for example `overdue: last check-in 2026-11-12T13:05:00Z, expected
every 60 min; its schedule may be off or waiting for an approval`.

A stated cadence is its person's statement: neither reading proves the assistant's own schedule ran, or that it picked
anything up. It's a status only. Work addressed to a member that isn't checking in still queues and is rung as before, a check-in
isn't pickup (pickup is its claim), and no check-in doesn't mean it's idle, failed or safe. `GET /api/queue/hosted-members`
gives this daemon's host id and each member on this host with its status, last check-in and stated cadence (with the
reason when it's unknown); `rig roster show` and `find` show it as `Check-in:`, for a team with or without terminal seats, and `rig ps` (with or
without `--nodes`, and when it has no rigs or nodes to show) lists every connected assistant after its table, one line
each. That's on this host, and in the node view of an HTTP host; an SSH host's `rig ps` prints its own. An HTTP host's
rig view and the multi-host fan-out leave the section out. When the list can't be read, for example from an older
daemon, it says check-in is unavailable instead. Its `--json` output is unchanged. The TUI's
instance and rig tables list them the same way after their seats, with times in the viewer's zone; when the list can't be read,
they say check-in is unavailable, as `rig ps` does.
When the member has unclaimed work, the standing notice described above states the same status in its `check-ins:`
line; when that notice is filed doesn't change.

## Revoke

`rig mcp token revoke grok` refuses its next request. The rows it worked, and their answers, stay.

## Embed the HTTP endpoint from Node.js

An ESM application can start and close the same HTTP endpoint without running the CLI:

```js
import { startMcpHttpServer } from "@openrig/cli/mcp.js";

const endpoint = await startMcpHttpServer({
  daemonUrl: "http://127.0.0.1:7433",
  host: "127.0.0.1",
  port: 7434,
  tokenFile: "/absolute/path/to/mcp-http-tokens.json",
});
// endpoint.url is the MCP URL; endpoint.authenticated says whether authentication is configured.
// Keep the endpoint for as long as the application serves it, then:
await endpoint.close();
```

`McpHttpOptions`, `McpAccess`, `McpPrincipal`, `McpGrant` and `GrantServiceOptions` are exported types;
`McpHttpConfigError` is the endpoint's configuration error. Importing the module starts neither an endpoint
nor a daemon. Start the daemon separately, and use the existing token commands above to manage grants.
The CLI commands, authentication and tool scope work as before. No package exports map is added, so
existing deep imports and CommonJS extension lookup keep their previous resolution; `@openrig/cli/mcp.js`
is the documented entry.

This entry exposes the current endpoint options. It does not add a resolver-module loader or promise
additional adapter callbacks that those options do not implement.

### Add an introduction and static references

Pass `instructions` to `startMcpHttpServer` to add endpoint-owned guidance. Its exported type is
`McpInstructionExtension`:

```js
const instructions = {
  introduction: "The team guide is available at team://reference/guide.",
  resources: [{
    uri: "team://reference/guide",
    name: "team-guide",
    mimeType: "text/markdown",
    text: "# Team guide\nUse this team's documented workflow.",
  }],
};
```

Core keeps its existing caller-scoped instructions and appends the introduction. Static resources
use the SDK's `resources/list` and `resources/read` protocol. The built-in
`openrig://reference/coordination` resource always serves Core's generic guidance for the current
caller, including read-only and offered-tool filtering. It is available without an extension and
with local token-file grants as well as a resolver or grant service. Its URI is reserved for Core.

Configured introduction and resource text belong to the endpoint and are delivered to callers admitted by that
endpoint; use separate endpoint configurations when the content differs. They do not grant Core tools
or object access. Resources contain the supplied text, not a file path or a loader callback. Duplicate
resource URIs follow the SDK's existing registration error behavior. Without an introduction, the
existing initialization instructions remain unchanged.

### Supply a caller resolver

An embedding can pass `resolver` and `resolverTimeoutMs` to `startMcpHttpServer`. The supported
`@openrig/cli/mcp.js` entry exports the `CallerResolver` and `CallerResolution` types. There is no module loader:
your application supplies the function and owns its credential authority.

The resolver receives `{ bearer, instance, methods, signal }` on each request. `instance` is this daemon's
reported instance id, not a client parameter. `methods` lists the JSON-RPC methods in message order; it is empty
for non-POST requests or an unreadable body. It is operation metadata, not permission to run those methods.
The POST body is read within the shared bounded budget before the resolver decides; authentication refusals
take precedence over parse errors, not over reading the body.
A successful result has this shape:

```ts
{
  ok: true,
  principal: { source: "example-authority", id: "guest-42" },
  seat: "guest@team",
  access: {
    principal: "guest-42", owner: false, workspace: false, rigs: [], roots: [],
    external: {
      objects: { queue: ["create", "show", "list"], team: ["list"] },
      peerSeats: ["lead@team", "helper@team"]
    }
  }
}
```

The exact seat must already exist in this daemon, including a materialized seat that has not launched.
Core does not create or start it during resolution. The principal's opaque `source` and `id`, with optional
`grant`, `version` and `label`, are attribution, never credentials. `access.principal` is normalized to that id.
`external.objects` uses the existing object/action capability evaluator. With `external.peerSeats`, only those
exact peers are in scope for destinations, rows and team members; rig selection follows the named seat addresses.
The `rigs` list is ignored when `peerSeats` is supplied.
Without `peerSeats`, the existing rig-scoped rule remains. Without peers or rigs, only the caller's own rows are
in scope. An external work profile has `owner: false` and `workspace: false`.
A non-external result can instead be an owner or workspace caller, carrying the embedding's full authority;
the embedding owns that choice.

A result may also reduce the profile with `readOnly: true`, or set `newWorkRetryAfterMs`. Read-only connections
are offered only read operations and cannot invoke hidden writes. Backoff holds only new creates, returns a
retryable result with the same request id, and leaves reads, claims, updates and already-landed same-id retries
available. The existing backoff range is 1–600 seconds for a positive delay; zero means no backoff.

A refusal is `{ ok: false, refusal }`. `unknown`, `revoked`, `expired` and `wrong_instance` return HTTP 401 with a
Bearer challenge; `malformed` and `unavailable` return 503. A thrown error, unusable result, missing instance or
unavailable seat is also unavailable. Resolver exceptions are not echoed or logged. No result falls back to the
token file or the process's seat. A resolver and a grant service cannot both be selected.

The default 5000 ms budget covers reading the body, looking up the instance, calling the resolver and checking
the seat. The signal aborts on that deadline or a disconnected client. Core bounds its wait even when the returned
promise ignores the signal, and ignores late completion. Authentication refusals take precedence over JSON
parse errors; an authenticated malformed body still gets 400, and a body over 4 MiB gets 413. OAuth resource
metadata and the configured task destination can also be used with a resolver.

### Use the same profile in a local token file

A token-file entry can optionally carry `objects`, `peerSeats`, `readOnly` and `newWorkRetryAfterSeconds`.
`objects` selects the scoped work profile above; `peerSeats` requires `objects`. An entry without these fields
keeps its existing rig, workspace and owner behavior. The read-only reduction and new-work delay also work on
ordinary local grants. Rotation preserves the optional fields. A malformed field gets a warning naming the
field and its repair, and a conservative reading: `readOnly` becomes true, invalid peers become an empty list,
and invalid object actions are disabled while valid object limits remain. A peer list without `objects` allows
no object actions. These cases never restore owner, workspace or unrestricted legacy access.

An unusable `newWorkRetryAfterSeconds` uses the bounded 600-second new-work delay with a warning. Reads,
existing-work settlement and landed same-ID retries remain usable; the authenticated token does not become
unavailable. Other grants are unaffected. No service or service-shaped principal id is needed.

## Assistants connected through a grant service

With `rig mcp serve --http --grant-service <url>`, an outside service answers each connection's key with its grant
(`openrig.grant/v1`): the seat it acts as, its rigs, and the object/action pairs it may use. Each pair offers one tool,
and nothing else is offered:

| Pair | Tool |
|---|---|
| `queue`/`create`, `queue`/`show`, `queue`/`list` | `rig_queue_create`, `rig_queue_show`, `rig_queue_list` |
| `queue`/`claim`, `queue`/`update` | `rig_queue_claim`, `rig_queue_update` |
| `team`/`list` | `rig_team` |
| `artifact`/`read` | `rig_artifact_read` |
| `question`/`read`, `question`/`answer` | `rig_question_list`, `rig_question_answer`, only when the grant names its person (below) |

- **One seat per connected assistant:** the service gives each connection its own seat and keeps it across that
  connection's reconnects. The seat must be one of the rig's nodes; a node created without a launch is enough. The caller
  is exactly that seat.
- **What it reaches:**
  - It hands work to its rigs' other seats, never to a person or another host's seat.
  - It reads the items it sent and the items addressed to it from those seats or from an external address
    (`<id>@external`), never the team's internal items or an external address's items to another seat. The address is
    matched by its shape, not looked up among registered people: a registered person, a shared channel's address (which
    its unregistered writers post under) and any other `@external` ref count. A person's answer addressed to its seat is
    readable this way too.
  - With `queue`/`claim` and `queue`/`update`, it claims and closes only items addressed to its own seat that it can read,
    and waits (blocked) only on an item it names and can read. Its answers hide what reading the item hides.
- **A first task without a seat address:** with `--task-destination <member@rig>` on the same `rig mcp serve`, a
  `rig_queue_create` that leaves out `destination` goes to that receiver. The operator sets it; a caller can't. It must be
  exactly one existing local node within that request's grant, or nothing is written. An explicit `destination` works as
  before.
- **A seat by its name:** a `destination` with no `@` names a seat as its team shows it: its session's own name, then its
  pod-member form, then that name's slug, in the connection's one rig or the configured receiver's. Only seats the grant
  can address count, and the first of these that any of them matches decides, so another seat's slug never makes an exact
  name ambiguous and a seat the grant can't address never shadows one it can. The item is stored under that
  seat's actual session. A slug two seats match returns `destination_ambiguous` with the candidates, and a name that no
  seat the grant can reach has returns `destination_not_found`. If the team couldn't be read to check, it returns
  `destination_unchecked` and nothing was written; try again. A name the grant can't address as written (its own seat,
  or another assistant's without `team`/`list`) stays `out_of_scope`, whether or not that seat exists.
- **Two assistants together:** a grant with `team`/`list` sees its rigs' seats with `rig_team`, and may address and hear from
  another connected assistant's seat. A grant without it never reaches a seat in the service's caller form
  (`cus-<id>-<connection>@<rig>`), so an existing connection keeps the reach it had.
- **Messages are items:** a message is an item the receiver reads and closes, with any reply in its `resolution`. The
  sender reads that reply on the same item. Nothing wakes the sender or posts a new item for it. A separate new message is
  new work.
- **A fair-use limit on new work:** the service can add `throttle: { new_work: true, retry_after_seconds: <n> }` to an
  active answer.
  - While it does, a `rig_queue_create` that would open a new item writes nothing. It returns `fair_use_retry_later` with
    `retryAfterSeconds` (1 to 600) and the `qitemId` to retry with.
  - A retry of a create that already landed is answered from the stored item, as before.
  - Everything else is served: reading, claiming and closing existing items (a reply in `resolution` included), and
    answering the team's questions. A separate new message or revision waits like any other new item.
  - It's never a credential refusal, and a `throttle` that can't be read is ignored.
  - The service is asked once per HTTP request (initialize and tool listing included), not once per tool call.
- **What the sender can tell, from the item it reads:**
  - **Queued:** the item exists and is `pending` with no claim.
  - **Picked up:** the receiver's claim (`in-progress`).
  - **Answered:** closed `done`, with the answer in `resolution`.
  - Reading or listing an item records nothing on the item, and nothing wakes an assistant, so an item stays queued until its
    receiver claims it. A member listing its own pending inbox records only a check-in time, which the notice above reads.

### A person answering the team's questions through their assistant

A grant can name the person who owns the connection: `person.entity_id`, their gateway entity id on this instance, so their
address is `<entity_id>@external`. The service sends it only for a connection that person owns. With it and the `question`
pair, the person's assistant can read the team's questions waiting on them and submit their answers, without opening
Steering. The caller's seat is never taken for a person: without `person`, the `question` pair offers nothing, and an
unusable `person` withholds only these two tools while the grant's other tools keep working.

A token-file grant can be bound to a person the same way, without a grant service:
`rig mcp token add <name> --seat <seat> --person <entity_id>`. That connection is offered `rig_question_list` and
`rig_question_answer` for that registered person, beside its seat's own tools, and answers through the same path as
below. The person is only ever the one named with `--person`: never the seat, and never an `--owner` grant's. The
answer's audit names the route as `file-grant`, with the grant's name as its principal; a token-file grant has no grant
id or version. Revoking the grant stops both tools on its next request.

- **Register the person** on the instance, once:
  `rig gateway human add <entity_id> --display-name "<name>" --delivery-class B --default`.
  Without `--binding`, they're asked in the Feed and on Steering only. As the default person, today's asks addressed to no
  registered person (such as `human@host`) are theirs too.
- **`rig_question_list`** shows what Steering shows that person as answerable: an ask addressed to them, or a row parked on
  them. Each comes with its options when it has any, and the `revision` an answer names. A question that moved to someone
  else between Steering's view and the read of its row is left out.
- **`rig_question_answer`** takes the question, the revision the person saw, and either the options they chose (one per
  question) or exactly what they typed. It records through Steering's own write path (`answer` for an ask, `resolve` for a
  park), as the person, so Steering shows the same answer and the asker's work continues once. The answer's audit names the
  route it came by: the caller's seat, the grant's principal and, for a grant service's grant, its id and version.
- **What it says back:** a success names what was submitted (`submitted`), never a fresh read of the question's answers.
  - `answered`;
  - `recorded`, when parts of the question are still unanswered;
  - `already-recorded`, for an identical retry whose submission is already on the question, recognised by its operation id
    (never by an equal answer). That includes a settled ask or a park that's back at work;
  - `question_changed`, with the current question, when someone else changed it since the revision the person saw;
  - a retry of a submission that stopped partway confirms the parts already recorded and stops there (`question_changed`,
    with `recorded` and `notRecorded`). The rest goes in a new answer to the question as `rig_question_list` shows it now,
    so a stale retry never overwrites an answer someone gave in the meantime, including one recorded with no action (a
    Slack click);
  - a refusal partway names which parts were recorded (`recorded`, `notRecorded`). A send that got no answer, or a server
    error, leaves that part `indeterminate`: send the same call again to confirm what was recorded;
  - `not_waiting_on_person`, when it was answered or closed, or isn't theirs;
  - `person_not_registered`, when the grant's person isn't registered on this instance. While no one is registered, Steering
    shows every request, so nothing is answered for anyone.
- **What it never does:** answer another person's question, reach a team-internal row, or record a decision of its own. A
  delegated decision (`rig_queue_decide`) isn't offered to a grant-service caller.

## Limits today

- **Webhook triggers only:** OpenRig rings a webhook. Email and other triggers aren't supported yet. A member without a trigger
  isn't rung; work it leaves unclaimed past the unclaimed age is listed in one notice instead, which goes to its person, else
  its rows' shared creator, the operator agent or the member itself.
- **It can't act as a person:** it works rows addressed to its seat, a person's request to it included. It can't settle an ask addressed to a person, or hand work to one, except through a grant that names its person (a grant service's, or a token-file grant with `--person`), which records that person's own answers (above).
