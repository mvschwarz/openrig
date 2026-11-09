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

> Member workflow (member-workflow/v2). Your inbox is the items addressed to your seat: rig_queue_list with owned set. It's yours, not the team's queue. A wake, a ring or a message only points at it: list your inbox, then act. For each item: claim it (rig_queue_claim), do it, then close it done with closure reason no-follow-on and the answer in resolution (rig_queue_update), or hand it on (rig_queue_handoff). Listing or reading an item doesn't take it. Say what you can reach from your grant, not from the tool list: a listed tool isn't access. rig_artifact_read's answer for an item names the shared roots you may read, and none means no shared files. If the person connected you, that's basically authorized: claim the items in your inbox and do them without asking whether you may. When an item needs a person's approval before you can finish it, don't close it and don't take the action: keep the item and ask. If it came from a person (an address ending in @external that isn't a shared channel; the item's 'Shared channel:' line names one), set it blocked with blockedOn that person and, as its summary, the question with a short form of what you'll do: the person sees the summary and the item, not your note, which keeps the record. Link a longer draft as an https evidenceRef. Their answer returns the item to you in progress. Otherwise ask as a new item, to the seat it came from or, for a shared channel's item, to your rig's lead (rig_team shows it), with your question and draft. Then set yours blocked with blockedOn that new qitemId: when that item closes, yours returns to pending, to claim again. Nothing promises to wake you, so check your inbox again. Then finish the same item; don't open a new one.

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
  - The daemon reads each from its environment (the name, or `OPENRIG_<NAME>`), else from `secrets_env_file`, an env file kept at mode 0600.
- **The ring:** when a row lands for the member, the daemon POSTs
  `{"source":"openrig.queue","schema_version":1,"event":"work-waiting","qitem_id":…,"destination":…,"summary":…,"from":…}`.
  - It's a pointer, not the row's body: the member reads the row under its grant.
  - A receiver should tolerate a repeated `qitem_id`. A ring accepted just before the daemon stops, before it's recorded,
    is rung again on recovery, the same at-least-once window a terminal wake has.
  - It waits up to 10 seconds and doesn't follow redirects.
- **What the trigger should do:** start a run that lists the member's rows (`rig_queue_list` with `owned`) and claims its work.

## What the record says, and doesn't

These facts stay separate on the row:
- **Wake:** with a trigger, the row's wake result is `wake-accepted:webhook (<url_ref>) answered <status>` when the trigger took the
  ring, or `failed:webhook …`. Accepted means the tool's trigger answered, not that the member read the row.
  - With no trigger, the result is `unroutable`, and OpenRig tells the person: the operator seat when it's a person, else whoever
    created the row.
  - It tells the person too when the member was rung but hasn't claimed the work by the stuck sweep's unclaimed age
    (`queue.stuck_sweep_unclaimed_age_minutes`, 60 by default).
  - The member sees new work when it checks: when it's rung, when its person asks it to, or on a schedule the tool runs.
- **Pickup:** its claim, a transition by its seat. Listing or reading a row isn't pickup.
- **Result:** the closing transition and its resolution, or the handoff.
- **Notification:** where a person asked, Slack's posted receipt. A posted notice isn't the person's acknowledgment.

**On the team:** `rig_team` lists the rig's hosted members (roster entries marked hosted that aren't one of its nodes), with their capabilities and caveat, no pane, and activity `unknown`.
OpenRig doesn't observe a hosted member between its calls, so it never reads idle. `rig roster find` shows it the same way.
- **Presence:** each entry carries `presence`, which says what OpenRig last saw of the member. It isn't pickup, and `null` means unknown:
  - `lastCallAt`: its last authenticated call to this host's `rig mcp serve --http`, recorded at most once a minute in
    `<OPENRIG_HOME>/mcp-http-presence.json`, beside the token file;
  - `lastWake`: its latest ring and the result, among its 50 most recent rows.
- `rig roster show` and `find` show the last call; the last ring is in `rig_team`.

## Revoke

`rig mcp token revoke grok` refuses its next request. The rows it worked, and their answers, stay.

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
  - It reads the items it sent and the items addressed to it from those seats, never the team's internal items.
  - With `queue`/`claim` and `queue`/`update`, it claims and closes only items addressed to its own seat that it can read,
    and waits (blocked) only on an item it names and can read. Its answers hide what reading the item hides.
- **A first task without a seat address:** with `--task-destination <member@rig>` on the same `rig mcp serve`, a
  `rig_queue_create` that leaves out `destination` goes to that receiver. The operator sets it; a caller can't. It must be
  exactly one existing local node within that request's grant, or nothing is written. An explicit `destination` works as
  before.
- **Two assistants together:** a grant with `team`/`list` sees its rigs' seats with `rig_team`, and may address and hear from
  another connected assistant's seat. A grant without it never reaches a seat in the service's caller form
  (`cus-<id>-<connection>@<rig>`), so an existing connection keeps the reach it had.
- **Messages are items:** a message is an item the receiver reads and closes, and a reply is an item back to its sender.
- **What the sender can tell, from the item it reads:**
  - **Queued:** the item exists and is `pending` with no claim.
  - **Picked up:** the receiver's claim (`in-progress`).
  - **Answered:** closed `done`, with the answer in `resolution`.
  - Reading or listing an item records nothing, and nothing wakes an assistant, so an item stays queued until its receiver
    claims it.

### A person answering the team's questions through their assistant

A grant can name the person who owns the connection: `person.entity_id`, their gateway entity id on this instance, so their
address is `<entity_id>@external`. The service sends it only for a connection that person owns. With it and the `question`
pair, the person's assistant can read the team's questions waiting on them and submit their answers, without opening
Steering. The caller's seat is never taken for a person: without `person`, the `question` pair offers nothing, and an
unusable `person` withholds only these two tools while the grant's other tools keep working.

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
  route it came by: the caller's seat, the grant's principal and the grant's id and version.
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
  isn't rung, and its person is told instead.
- **It can't act as a person:** it works rows addressed to its seat, a person's request to it included. It can't settle an ask addressed to a person, or hand work to one, except through a grant service's grant that names its person, which records that person's own answers (above).
