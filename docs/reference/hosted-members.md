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

## Limits today

- **Webhook triggers only:** OpenRig rings a webhook. Email and other triggers aren't supported yet. A member without a trigger
  isn't rung, and its person is told instead.
- **It can't act as a person:** it works rows addressed to its seat, a person's request to it included. It can't settle an ask addressed to a person, or hand work to one.
