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

The daemon runs the connector for every active binding, about every 30 seconds (`OPENRIG_NETWORK_POLL_SECONDS`, at
least 5). With no active binding it makes no network call.

1. It lists the participant's own items on the hub, claims each pending one, and creates a local queue item for the
   seat's current address. The local item comes from OpenRig itself, and its body names the requester and the hub item.
2. It reports each stage on the hub item, kept apart:
   - **Queued:** the hub claim means the connector holds the item. The note says "Not picked up yet."
   - **Picked up:** once the seat claims the local item.
   - **The result:** once the local item closes, following any local handoffs to the item that finished. The hub item
     closes with its resolution, and with the closure reason `canceled` or `denied` when the local item ended that way.

To answer, close the local item with your result:

```bash
rig queue update <local item> --state done --closure-reason no-follow-on --resolution "<your answer>"
```

## Retries, restarts and unknown outcomes

- Each hub item maps to one local item, under an id derived from the binding and the hub item. A lost answer, a retry
  or a daemon restart lands on that same item, so the work isn't started twice.
- If the local record of an item is gone, the hub item says its outcome is unknown, and it is never run again.
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
  once the seat has a session again.
- **The hub can't be reached:** the binding stays active, the error is recorded, and retries back off, doubling up to
  5 minutes.
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

- The connector polls, so new work can wait up to one interval before it reaches the seat.
- **Plain http needs your choice.** `rig network connect` refuses an `http:` hub URL until you add `--allow-http`, because
  the participant's token and its work then cross the network unencrypted, where they can be read. Use the hub's
  `https:` URL where it has one. The choice is recorded on that binding, so the connector doesn't ask again, and
  `rig network status` (and its `--json`) marks the binding unencrypted. OpenRig doesn't judge the address: a private or
  tailnet address doesn't prove the connection is protected.
- **Redirects:** the connector follows a hub's redirect only within its own origin, or to its `https:` form on the same
  host. Any other redirect stops the connection with its target named, and the token isn't sent there. Connect the
  binding to the hub's own URL.
