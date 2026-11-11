# Network connector: a local seat as a hub participant

Source of truth: `packages/daemon/src/domain/network/` (`network-bindings.ts`, `network-connector.ts`, `hub-client.ts`),
`packages/daemon/src/routes/network.ts`, `packages/cli/src/commands/network.ts`.

A hub is another OpenRig queue that its participants reach over MCP, such as a daemon served by `rig mcp serve --http`
with one grant per participant. The network connector puts one selected local seat on a hub as one of its participants.
The connector opens no port: your daemon makes every connection outward, and the hub never connects to your machine. Work the hub
sends that participant runs on your seat, under your accounts, and the result goes back to the hub item.

## Connect

```bash
rig network connect <seat> --hub <url> --as <participant> --token-file <path>
```

- `<participant>` is the participant's address in the hub (`member@rig`), and the token file holds its bearer.
- The binding follows the seat's node, so a relaunched or renamed seat keeps it.
- The token is stored at `<OpenRig home>/network-secrets/<binding>/credential.json` (a 0700 folder and a 0600 file). It
  is never returned by the API or shown in status. A token in the hub URL is refused.
- A plain-http hub URL needs `--allow-http` (see Limits).
- One active binding per local seat, and one per hub participant.
- On a daemon with an operator bearer configured, `connect` and `disconnect` send `OPENRIG_AUTH_BEARER_TOKEN`, as the
  `rig host` writes do.

## What the connector does

The daemon runs the connector for every active binding. It normally polls every 30 seconds
(`OPENRIG_NETWORK_POLL_SECONDS`, at least 5); a failing hub, backoff or a backlog can delay it. Each binding's pass has
a deadline of 60 seconds, so one slow hub doesn't hold the others. With no active binding it makes no network call.

1. It lists the participant's own items on the hub, claims each pending one, and creates a local queue item for the
   seat's current address. The local item comes from OpenRig itself, and it says where the work came from first: its
   summary starts "From <requester> via network hub", and its body opens with the requester, the hub and the hub item,
   before the requester's own words.
2. It reports each stage on the hub item, kept apart:
   - **Queued:** the hub claim means the connector holds the item. The note says "Not picked up yet."
   - **Picked up:** once the seat claims the local item.
   - **The result:** once the local item closes, following any local handoffs to the item that finished. The hub item
     closes the way its queue closes one: done with the resolution and the closure reason (`no-follow-on`, `canceled`
     or `denied`), or failed when the local item failed. A close with no resolution sends the closer's own note on that
     close, or "Closed without a stated result." No other note on the item is sent.

To answer, close the local item with your result:

```bash
rig queue update <local item> --state done --closure-reason no-follow-on --resolution "<your answer>"
```

## Retries, restarts and unknown outcomes

- Each hub item maps to one local item, under an id derived from the seat's node, the hub, the participant and the hub
  item. A lost answer, a retry, a daemon restart, or disconnecting and connecting the same seat to the same hub and
  participant again lands on that same item, so it isn't queued twice. A new binding reports what the earlier one
  took.
- If the local record of an item is gone, or it was handed on without one successor here, the hub item says its outcome
  is unknown, and it is never run again.
- If someone else closed the hub item first (its requester canceled it, say), the local result stays here, the connector
  doesn't count it as delivered, and `rig network status` (and its `--json`) shows it under the binding as closed
  elsewhere. The connector checks the hub item just before closing it. It does not write over a close it has already
  seen, and reads the item back after a close attempt. A hub item someone there handed on counts as closed elsewhere
  too.
- The derived id makes the queue item unique, not the work's outside effects. Anything your agent did outside OpenRig
  before a crash is neither undone nor deduplicated.

## Status

```bash
rig network status [--json]
```

Each binding shows its seat, participant, hub, state, and its last contact or last error. `--json` adds the
connector's view: each binding's next pass, backoff and last pass.

## When things go wrong

- **The seat has no session:** its hub items stay pending and unclaimed, and the last error says why. They're taken
  once the seat has a session again. A stopped seat still has its session, so it still takes items; they wait for it.
- **The hub can't be reached, or a pass runs past its deadline:** the binding stays active, the error is recorded, and
  retries back off, doubling up to 5 minutes. A failure on this machine is recorded as local, not as the hub's.
- **The hub refuses the credential** (HTTP 401): the binding is marked revoked and its credential removed. No new work
  comes in; local items and results stay.

## Disconnect

```bash
rig network disconnect <binding-or-seat> [--reason "<why>"]
```

The binding ends here, so no new work comes in through it, and its credential is removed. Local items and results
stay. The hub still lists the participant until it's removed there too.

If the credential can't be removed, the binding still ends, and the error names the
`rig network disconnect <binding id>` to run again. The daemon also removes credentials whose binding isn't active
each time it starts.

## Limits

- The connector polls, so new work normally waits up to one interval before it reaches the seat, and longer when the
  hub fails or a backlog builds.
- If someone else closes a hub item between the connector's check and its close, the hub may keep either outcome, or
  combine the later state with the earlier resolution. The connector counts its result as delivered only when the
  readback matches its state, closure reason and resolution; otherwise a closed item is reported as closed elsewhere.
  An atomic close-if-open needs the hub to offer a conditional close.
- After a disconnect or a revocation, work already taken keeps running here, but its pickup and result no longer reach
  the hub item, which stays at its last reported stage.
- **Plain http needs your choice.** `rig network connect` refuses an `http:` hub URL until you add `--allow-http`, because
  the participant's token and its work then cross the network unencrypted, where they can be read. Use the hub's
  `https:` URL where it has one. The choice is recorded on that binding, so the connector doesn't ask again, and
  `rig network status` (and its `--json`) marks the binding unencrypted. OpenRig doesn't judge the address: a private or
  tailnet address doesn't prove the connection is protected.
- **Redirects:** the connector follows a hub's redirect only within its own origin, or to its `https:` form on the same
  host. Any other redirect stops the connection with its target named, and the token isn't sent there. Connect the
  binding to the hub's own URL.
