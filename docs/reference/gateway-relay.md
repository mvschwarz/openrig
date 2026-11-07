# Gateway Relay: HTTP Loopback Transport Adapter & Custody Reference

OpenRig's Gateway Relay is a local HTTP loopback transport adapter. It enables registered people to receive outbound notifications and questions (asks, updates, and operator digests) through an operator-owned local bridge process, and to post answers back into OpenRig with sender attribution resolved against registered human bindings.

OpenRig does not embed third-party messaging platform SDKs (such as WhatsApp, Matrix, or Signal). An external bridge process translates between OpenRig loopback HTTP requests and external messaging platforms.

```
+--------------------+           HTTP Loopback            +--------------------+
|   OpenRig Daemon   |   POST <OPENRIG_RELAY_URL>  --->   |   Operator Bridge  |
|  (Gateway Subsys)  |   <--- POST .../relay/inbound      |  (Loopback Server) |
+--------------------+                                    +--------------------+
                                                                    |
                                                      Platform-specific transport
                                                                    v
                                                          +--------------------+
                                                          |  External Platform |
                                                          |  (Mobile / Client) |
                                                          +--------------------+
```

---

## 1. System Topology & Custody Boundaries

### Outbound Custody & Recovery
- OpenRig enqueues outbound decisions to a local `DispatchBuffer` before issuing an HTTP `POST` to `OPENRIG_RELAY_URL`.
- Each dispatch attempt uses a stable `deliveryId` (the queue `decisionId`) and frozen payload bytes.
- Transport is at-least-once. The bridge must persist the full envelope and deduplication identity (`deliveryId`) before returning HTTP `2xx`.
- Acceptance by the bridge (`2xx`) records a queue receipt (`relay-owner-notification-accepted`) and drains the item from the dispatch buffer. Acceptance confirms receipt by the bridge process only; it does not indicate downstream platform delivery, posting, or human receipt.
- Failed dispatches remain in OpenRig's dispatch buffer. OpenRig retains unacknowledged decisions and replays them when the gateway subsystem or daemon restarts. There is currently no periodic background timer redriving outbound dispatches on timeout.

### Inbound Custody & Resolution
- The operator bridge posts replies to `POST /api/gateway/relay/inbound`.
- Requests require `Authorization: Bearer <OPENRIG_RELAY_INBOUND_TOKEN>` matching a configured profile.
- OpenRig verifies that the caller is a direct loopback peer (`127.0.0.1/8` or `::1`) over the underlying socket, rejecting forwarding headers (`X-Forwarded-*`, `Via`).
- Sender attribution resolves by matching `sender.handle` against human fragments registered to the authenticated connector. The handle is asserted by the trusted bridge; it does not provide independent proof of the physical human on the external platform.
- When an inbound reply is accepted (`200 OK`), OpenRig durably commits the action through its mission control contract. Exact duplicate replays of the same event ID and payload succeed idempotently.

### Exclusions & Scope
The relay adapter does not handle interactive UI buttons, message attachments, group rooms, unsolicited inbound triggers, multi-bridge failover clustering, or third-party platform SDK backends.

---

## 2. Secrets & Environment Configuration

Each relay connector loads configuration from an absolute file referenced by the binding's `secretsRef` (`file:<absolute-path>`).

### Security & File Requirements
- **Absolute Path Only**: Must begin with `file:/`. Relative paths, bare paths, and `file://` authority URLs are rejected.
- **File Permissions**: The file must have POSIX permission mode `0600` (read/write by owner only). Files with group or other access bits are rejected. Symlinks are not rejected by the permission check.
- **No Environment Fallback**: OpenRig does not fall back to process environment variables (`process.env`). All variables must come directly from the referenced file.
- **Profile Independence**: If a secrets file is invalid or missing, only connectors bound to that file report `not-ready`. Other connectors remain functional.

### Required Secrets Keys

```ini
OPENRIG_RELAY_URL=http://127.0.0.1:8088/webhook
OPENRIG_RELAY_OUTBOUND_TOKEN=sec_outbound_token_value
OPENRIG_RELAY_INBOUND_TOKEN=sec_inbound_token_value
```

- `OPENRIG_RELAY_URL`: Must use `http:`, loopback host (`127.0.0.1/8`, `::1`, or `localhost`), without URL credentials or hash fragments. Redirects (3xx) are rejected.
- `OPENRIG_RELAY_OUTBOUND_TOKEN`: Bearer token sent by OpenRig on outbound requests to the bridge.
- `OPENRIG_RELAY_INBOUND_TOKEN`: Bearer token required on inbound requests from the bridge. Must be distinct from `OPENRIG_RELAY_OUTBOUND_TOKEN` and unique across all configured relay profiles.

---

## 3. Wire Protocol Specifications

### Outbound Envelope (`POST <OPENRIG_RELAY_URL>`)

```json
{
  "v": 1,
  "deliveryId": "dec-019283-abc",
  "recipient": { "handle": "alice-ops" },
  "intent": "decision",
  "outcome": "interrupt",
  "summary": "Database Migration Approval",
  "body": "Production migration script 004_add_indexes.sql is ready to execute. Reply YES to approve, NO to abort.",
  "replyRef": "eyJ2IjoxLCJxaXRlbUlkIjoicS0x...<base64url>"
}
```

- `v`: Protocol version integer (`1`).
- `deliveryId`: Stable delivery identifier corresponding to the queue decision ID.
- `recipient.handle`: Recipient's registered safe alias for this connector.
- `intent`: `"decision"` (actionable question) or `"update"` (informational notice).
- `outcome`: Delivery classification (`"interrupt"`, `"notify"`, or `"digest"`).
- `summary`: Plain text summary (maximum 1,000 characters).
- `body`: Plain text body (maximum 32,000 characters; total envelope capped at 65,536 bytes).
- `replyRef`: Opaque base64url string for actionable decisions; `null` for informational updates.
- `items`: Present when `outcome` is `"digest"`. Array of objects with `qitemId`, `notificationKey`, `summary`, optional `body`, and per-item `replyRef` (or `null`).

### Inbound Envelope (`POST /api/gateway/relay/inbound`)

```json
{
  "eventId": "evt-relay-20261107-001",
  "sender": { "handle": "alice-ops" },
  "replyRef": "eyJ2IjoxLCJxaXRlbUlkIjoicS0x...<base64url>",
  "text": "Approved. Proceed with rollout.",
  "ordering": "after-question"
}
```

- `eventId`: Bridge-assigned identifier (`1..256` chars, matching `/^[A-Za-z0-9._:-]{1,256}$/`).
- `sender.handle`: Sender's alias, matching `/^[A-Za-z0-9._-]+$/`. Must match a human fragment bound to the authenticated connector.
- `replyRef`: Exact opaque string copied from the outbound envelope (maximum 4,096 characters). Bridges must not parse or alter `replyRef`.
- `text`: Plain text response (maximum 32,768 characters, no NUL bytes). Processed as unstructured text without automatic natural-language approval parsing.
- `ordering`: Optional enum (`"after-question"` | `"uncertain"`, default `"uncertain"`). When `"uncertain"`, text is accepted as recorded context rather than verified sequence relative to the question.

#### Inbound Statuses & Responses
- **200 OK**: Request accepted (`{ ok: true, deduplicated: false, reconciled: false, qitemId, verb, actorSession, actionId }`). Duplicate submissions of the same `eventId` return `ok: true` with `deduplicated: true`.
- **400 Bad Request**: Malformed JSON, unexpected fields, invalid envelope syntax, or unparseable `replyRef`.
- **401 Unauthorized**: Missing, malformed, or unrecognized inbound Bearer token.
- **403 Forbidden**: Connector mismatch (e.g. `replyRef` emitted by another connector) or unregistered sender handle.
- **404 Not Found**: Queue item referenced in `replyRef` does not exist.
- **409 Conflict**: Stale `decisionRevision` (question cancelled, answered, or re-asked), attempt to answer an informational update, or conflicting payload submitted under an existing `eventId`.
- **413 Payload Too Large**: Request body exceeds 64 KiB (65,536 bytes).
- **503 Service Unavailable**: Local state store (`relay-inbound-seen.jsonl`) unreadable or temporarily locked.

---

## 4. Identity & Binding Configuration

Bindings are managed through human fragment files (`gateway/humans/<entityId>.yaml`) and CLI verbs (`rig gateway human`).

### Binding Syntax
```
relay:<connectorRef>:file:<absolute-env-file>:<role>[:handle=<alias>]
```
- `kind`: `relay`.
- `connectorRef`: Identifier for the connector instance (e.g. `local-bridge`).
- `secretsRef`: Absolute file path reference (`file:/path/to/relay.env`).
- `role`: `primary` or `secondary` (at least one primary binding required for outbound dispatch).
- `handle`: Optional platform alias (`handle=<alias>`). Required for inbound reply resolution; omitted means outbound-only.

Handles must match `/^[A-Za-z0-9._-]+$/` and are unique per `connectorRef`. Multiple people can share a connector, each registered with their own handle.

---

## 5. Operational Lifecycle

### Step 1: Provision Secrets File
Create a user-owned secrets file with mode `0600`:
```bash
mkdir -p "$HOME/.config/openrig-relay"
touch "$HOME/.config/openrig-relay/relay.env"
chmod 600 "$HOME/.config/openrig-relay/relay.env"

cat << 'EOF' > "$HOME/.config/openrig-relay/relay.env"
OPENRIG_RELAY_URL=http://127.0.0.1:8088/webhook
OPENRIG_RELAY_OUTBOUND_TOKEN=replace_with_outbound_token
OPENRIG_RELAY_INBOUND_TOKEN=replace_with_inbound_token
EOF
```

### Step 2: Register Human Binding
```bash
# Add a person with a primary relay binding
rig gateway human add alice --display-name "Alice Smith" --delivery-class B \
  --binding "relay:local-bridge:file:$HOME/.config/openrig-relay/relay.env:primary:handle=alice-ops"

# Replace an existing binding slot (requires the full binding spec)
rig gateway human set alice binding.0 "relay:local-bridge:file:$HOME/.config/openrig-relay/relay.env:primary:handle=alice-ops"
```

> [!NOTE]
> `rig gateway human set alice binding.<n>` requires a full binding specification string. Supplying `unset` is not supported for binding slots. To reassign a participant, overwrite the slot with a full binding string or remove and re-add the human fragment.

Operator notices use the existing default person. If several people are registered, choose the recipient explicitly when needed:

```bash
rig gateway default alice
```

### Step 3: Activate Daemon
When bindings or secrets files change, restart the daemon process:
```bash
rig daemon stop
rig daemon start
```
*(OpenRig does not provide a `rig daemon restart` command).*

### Step 4: Verify Readiness & Status
```bash
# Check delivery readiness for all participants
rig gateway human list

# Inspect detailed readiness status for an individual
rig gateway human show alice

# Check daemon process status
rig daemon status
```

In `rig gateway human show <entityId> --json`, `deliveryReadiness.state` reports `ready` when the binding configuration and local secrets file are valid. This confirms local readiness, not whether the operator bridge process is currently running.

### Step 5: Removing Bindings or Participants
Before removing a participant, ensure any pending queue items and conversations assigned to them are resolved.
```bash
rig gateway human remove alice
```
*(The remove verb refuses to delete a participant if open conversations or non-terminal items exist, unless `--force` is specified).*

---

## 6. Troubleshooting Common Conditions

| Condition | Observation | Resolution |
| :--- | :--- | :--- |
| **Missing Secrets File** | `deliveryReadiness.state: not-ready`<br>`reason: relay secret file ... is missing or unreadable` | Verify file path in `secretsRef` is absolute and readable. |
| **Insecure Permissions** | `deliveryReadiness.state: not-ready`<br>`reason: ... insecure permissions ... expected 0600` | Adjust permissions with `chmod 600 <secrets-file>`. Group/world bits must be zero. |
| **Identical Tokens** | `deliveryReadiness.state: not-ready`<br>`reason: OPENRIG_RELAY_OUTBOUND_TOKEN and OPENRIG_RELAY_INBOUND_TOKEN must be distinct` | Assign distinct values to inbound and outbound tokens in secrets file. |
| **Invalid Loopback URL** | `deliveryReadiness.state: not-ready`<br>`reason: OPENRIG_RELAY_URL host must be loopback ...` | Ensure URL uses `http://` and host is `127.0.0.1`, `::1`, or `localhost`. |
| **Reused Inbound Token** | `deliveryReadiness.state: not-ready`<br>`reason: duplicate OPENRIG_RELAY_INBOUND_TOKEN across profiles` | Each relay connector profile must declare a unique inbound token. |
| **Stale Question Reply** | HTTP 409 on inbound endpoint | Question was already answered, cancelled, or superseded by a newer revision. |
| **Unregistered Handle** | HTTP 403 on inbound endpoint | The `sender.handle` is not bound to the authenticated `connectorRef`. |
| **Non-Loopback Inbound** | HTTP 403 on inbound endpoint | Connection originated outside loopback or included proxy forwarding headers. |

For automated loopback bridge test reference, see `packages/daemon/test/fixtures/recording-relay.ts`.
