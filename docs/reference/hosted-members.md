# Hosted members: a tool outside the terminal on your team

A hosted member is a tool that lives outside a terminal, such as an assistant, a chat bot or a cloud routine, and works as a member of a rig. You
address work to it like any seat. It reaches the team through OpenRig's MCP server under a grant you issue and can revoke. It never gets a pane.

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
   for how authentication works.
5. **Add the server in the tool:** its `https://…/mcp` URL and the token as a bearer credential.

## How it works its rows

- **Hand it work** as you would any seat: `rig queue create --destination grok@research …`.
- **The member works it** through the MCP tools:
  - `rig_queue_list` with `owned` lists its rows;
  - `rig_queue_claim` takes one;
  - `rig_queue_update` closes it done with the answer in `resolution`, or `rig_queue_handoff` hands it on to a seat in its rig.
- **It can send work too:** `rig_queue_create` to its rig's seats.
- **Its rows outlive the conversation.** A new conversation with the same grant reaches the same work.

## What the record says, and doesn't

These facts stay separate on the row:
- **Wake:** a hosted member has no terminal, so nothing wakes it. The row's wake result says so (`unroutable`), and the row shows in
  `rig queue undelivered` until it's claimed. The member sees new work when it checks: when its person asks it to, or on a schedule the tool runs.
- **Pickup:** its claim, a transition by its seat. Listing or reading a row isn't pickup.
- **Result:** the closing transition and its resolution, or the handoff.
- **Notification:** where a person asked, Slack's posted receipt. A posted notice isn't the person's acknowledgment.

**On the team:** `rig_team` lists the rig's hosted members (roster entries marked hosted that aren't one of its nodes), with their capabilities and caveat, no pane, and activity `unknown`.
OpenRig doesn't observe a hosted member between its calls, so it never reads idle. `rig roster find` shows it the same way.

## Revoke

`rig mcp token revoke grok` refuses its next request. The rows it worked, and their answers, stay.

## Limits today

- **No wake route:** OpenRig can't ring the member when work lands.
- **It can't act as a person:** it works rows addressed to its seat, a person's request to it included. It can't settle an ask addressed to a person, or hand work to one.
- **No last-call presence yet:** OpenRig doesn't track when the member last called.
