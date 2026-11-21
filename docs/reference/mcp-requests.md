# Requests through OpenRig's MCP tools

An assistant connected to an OpenRig daemon through its MCP tools (`rig mcp serve`) sends work to a team's seats and answers
what's addressed to it with the queue tools. This page says how to keep one request as one item, how to follow it, and what
the errors mean.

## What your connection can do

The tools your connection offers, and what they return, are the authority. A listed tool isn't access by itself: the
connection's grant decides which rigs, seats and items it reaches. `out_of_scope` ("… is outside what this connection may
reach") means the grant doesn't allow it: say so, and don't look for another way.

## Choosing who to send to

- **List the team** with `rig_team` and send to an address exactly as it's listed.
- **If more than one could be the one your person means,** ask which, using the names the list shows. Don't pick from your
  own history or memory.
- **`takesRequests: false`** means its owner says it takes no requests. A request sent there is still written, and the
  answer carries `requestsAdvisory`. Tell your person, and send it to someone else if they want.
- **Judge a member by what the list records** (its label, `participant.app` and `participant.kind`), never by a product
  name. What the list doesn't record is unknown.

## Request IDs: one request, one id

`rig_queue_create` accepts an id you choose (`qitemId`). Choose it before you send, and keep it.

- **A new id for every new request,** unique to it: for example `qitem-` and random letters. Never reuse an earlier
  request's id, even for the same recipient.
- **The same id for a retry of the same request.** If a create's outcome is uncertain (a timeout, or an error after
  sending), read that id with `rig_queue_show` first. Create again only if it doesn't exist, and only with that same id: a
  new id would send the request twice.
- **If a create's answer carries `createWarning` with `qitem_body_not_saved`,** that id already belonged to an earlier
  request to the same recipient, with a different body. Your new request wasn't sent: the earlier item came back
  unchanged. Choose a new id and send it again.
- **If a create fails with `qitem_id_reuse`** ("… is already taken"), the id belongs to another item. Choose a new id and
  send it again.

## Following a request

- **Start with `rig_queue_show`** on the id you kept. Acceptance isn't completion: a request can be accepted and still
  waiting.
- **If it names a successor** your connection can read, follow that item. If the successor or the answer is outside what
  your connection reaches, say so: a handoff isn't an answer.
- **Say how the recipient picks requests up** when the team list says (when its person asks it, or on its check-in
  schedule). When the list doesn't say, it's unknown: don't promise a time.

## Answering what's addressed to you

Items addressed to your seat are yours; `rig_queue_list` with `owned` set lists them. For each, claim it
(`rig_queue_claim`), do it, then close it done with closure reason `no-follow-on` and the answer in `resolution`
(`rig_queue_update`). The sender reads that answer on the same item, so give one answer per request, on that request.
Nothing promises to wake you, so check your items again.

## If something seems wrong

| What you see | What it means | Next |
|---|---|---|
| `destination_not_found` ("No seat here is named …") or `destination_ambiguous` | the address isn't exactly one seat the list shows | use an address exactly as listed, or ask your person which |
| `out_of_scope` | your connection's grant doesn't reach it | say so |
| `createWarning`: `qitem_body_not_saved` | the id was an earlier request's; nothing new was sent | choose a new id and send again |
| `qitem_id_reuse` | the id is taken by another item | choose a new id and send again |
| `fair_use_retry_later` | a limit on new work held this create back, and nothing was written | retry after `retryAfterSeconds` with the same id; work you already have continues |
| a timeout, or an error after sending | the create's outcome is unknown | `rig_queue_show` that id first; retry only with the same id |
| `requestsAdvisory` on a create | the recipient takes no requests, or whether it does is unknown | tell your person, and send it to someone else if they want |
| your connection's tools stop working | the grant may have been changed or revoked | tell your person what the error says |

See also [Hosted members](hosted-members.md), for a member outside a terminal and the grant objects that name its tools,
and [Network connector](network-connector.md), for a team seat bound to another daemon's hub.
