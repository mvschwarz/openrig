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
- OpenRig enqueues outbound decisions to a local `DispatchBuffer` before issuing any HTTP `POST` to `OPENRIG_RELAY_URL`.
- Each logical decision freezes its complete representation (`relayEnvelope`, plus ordered `relayEnvelopes` parts when split) onto the parent `DispatchBuffer` entry before the first network attempt.
- Transport is at-least-once:
  - Normal small messages (`<= 65,536` serialized UTF-8 bytes) are sent in a single HTTP `POST` with `deliveryId = <decisionId>` and no `part` field.
  - Oversized messages (`> 65,536` serialized UTF-8 bytes, including long ASCII, multibyte CJK, emoji, `humanDetail`, `humanQuestions`/options, and large digests) are split into ordered HTTP `POST` part envelopes (`<= 65,536` UTF-8 bytes each) with `deliveryId = "<parentDeliveryId>:part:<index>"` and `part: { parentDeliveryId, index, total }`.
- An HTTP `2xx` response from the bridge acknowledges durable bridge custody of that specific envelope (`deliveryId`) only. For multi-part messages, the bridge must persist each part by its per-part `deliveryId`, deduplicate replayed part `deliveryId`s, and **durably assemble all ordered parts (`1..total`) before forwarding the complete logical message once** to the recipient on the external platform.
- OpenRig records the logical queue acceptance receipt (`relay-owner-notification-accepted` with the parent `deliveryId`) and drains the parent decision from `DispatchBuffer` **only after all parts (`1..total`) have returned `2xx`**. Bridge acceptance confirms custody by the bridge process only (and is projected as `accepted` / `"Accepted by bridge"`, whereas Slack posts use `posted` / `"Delivered"`). It does not indicate downstream platform delivery, posting, or human receipt.
- Failed dispatches remain in OpenRig's `DispatchBuffer` and record a relay-specific failure transition note (`relay-owner-notification-transport-failed` naming the `connectorRef`, distinct from Slack's `slack-owner-notification-transport-failed`). Already-acknowledged parts of a multi-part message are tracked in `relay-delivered-decisions.jsonl` (`delivered-part`) so replays after a lost ACK or daemon/bridge restart re-send only unacknowledged parts with their exact frozen `deliveryId` and bytes. There is currently no periodic background timer redriving outbound dispatches on timeout.

### Inbound Custody & Resolution
- The operator bridge posts replies to `POST /api/gateway/relay/inbound`.
- Requests require `Authorization: Bearer <OPENRIG_RELAY_INBOUND_TOKEN>` matching a configured, ready relay profile.
- OpenRig verifies that the caller is a direct loopback peer (`127.0.0.1/8` or `::1`) over the underlying TCP socket. Proxy and forwarding headers (`Via`, `X-Forwarded-*`, `Forwarded`, `X-Real-Ip`) are ignored rather than rejected because caller identity is established directly from the loopback socket peer and the bearer token.
- Sender attribution resolves by matching `sender.handle` against human fragments registered to the authenticated connector. Harmless extra fields on the top-level inbound JSON object or inside `sender` are ignored and can never override handle-to-person attribution or alter the event fingerprint. The handle is asserted by the trusted bridge; it does not provide independent proof of the physical human on the external platform.
- When an inbound reply is accepted (`200 OK`), OpenRig reserves the event in `relay-inbound-seen.jsonl` (`received:<fingerprint>`), durably commits the answer/resolve action and its `mission_control_actions` audit record atomically through its Mission Control write contract (using existing `excludeOperationReply` revision checking without a second answer store or synthetic revision refresh), and marks the event `processed:<fingerprint>`. Exact duplicate replays of the same `eventId` and payload succeed idempotently (`deduplicated: true`).

### Exclusions & Scope
The relay adapter does not handle interactive UI buttons, message attachments, group rooms, unsolicited inbound triggers, multi-bridge failover clustering, or third-party platform SDK backends.

---

## 2. Secrets & Environment Configuration

Each relay connector loads configuration from an absolute file referenced by the binding's `secretsRef` (`file:<absolute-path>`).

### Security & File Requirements
- **Absolute Path Only**: Must begin with `file:/`. Relative paths, bare paths, and `file://` authority URLs are rejected.
- **File Permissions**: The file should restrict access to the owner only (no group or other permission bits set, i.e. `(mode & 0o077) === 0`, such as `0600` or `0400`). Owner-only modes (`0600`, `0400`) produce no warning. If group or world permission bits are set (e.g. `0644`), OpenRig logs a redacted warning in the profile's readiness `warnings` and `reason` (matching the Slack secret-file posture) while keeping the profile `ready`. Missing or unreadable secret files remain `not-ready`.
- **No Environment Fallback**: OpenRig does not fall back to process environment variables (`process.env`). All variables must come directly from the referenced file.
- **Profile Independence**: If a secrets file is missing, unreadable, or missing required keys, only connectors bound to that file report `not-ready`. Other connectors remain functional.

### Required Secrets Keys

```ini
OPENRIG_RELAY_URL=http://127.0.0.1:8088/webhook
OPENRIG_RELAY_OUTBOUND_TOKEN=sec_outbound_token_value
OPENRIG_RELAY_INBOUND_TOKEN=sec_inbound_token_value
```

- `OPENRIG_RELAY_URL`: Must use `http:`, loopback host (`127.0.0.1/8`, `::1`, or `localhost`), without URL credentials or hash fragments. Redirects (3xx) are rejected.
- `OPENRIG_RELAY_OUTBOUND_TOKEN`: Non-empty Bearer token sent by OpenRig on outbound requests to the bridge.
- `OPENRIG_RELAY_INBOUND_TOKEN`: Non-empty Bearer token required on inbound requests from the bridge. Must be unique across different configured relay connector profiles (`connectorRef`); sharing the same inbound token across multiple relay profiles is rejected as ambiguous (`not-ready`). Using the same token value for both `OPENRIG_RELAY_OUTBOUND_TOKEN` and `OPENRIG_RELAY_INBOUND_TOKEN` within a single profile is allowed, with a redacted readiness warning explaining why separate directional tokens are recommended so an outbound capture cannot authenticate inbound replies.

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
- `deliveryId`: Stable delivery identifier (`<decisionId>` for single-part envelopes, or `"<parentDeliveryId>:part:<index>"` for multi-part envelopes).
- `recipient.handle`: Recipient's registered safe alias for this connector.
- `intent`: `"decision"` (actionable question) or `"update"` (informational notice).
- `outcome`: Delivery classification (`"interrupt"`, `"notify"`, or `"digest"`).
- `summary`: Plain text summary (up to 1,000 characters on the `summary` field, cut on a code-point boundary; any summary text exceeding 1,000 characters is preserved in full at the beginning of `body`).
- `body`: Complete plain text content (including full `body`, `humanDetail`, and rendered `humanQuestions` headers, prompts, and option labels/descriptions) without silent character clipping. Each HTTP request envelope is capped at 65,536 UTF-8 bytes when JSON-serialized; when the full logical envelope exceeds 65,536 UTF-8 bytes, OpenRig splits it into ordered multi-part envelopes (`part: { parentDeliveryId, index, total }`) cut strictly on Unicode code-point boundaries so concatenating `part.body` for `index = 1..total` reconstructs the exact full `body`.
- `replyRef`: Opaque base64url string for actionable decisions; `null` for informational updates (and `null` at the top level of multi-item digests). Preserved across all parts of a multi-part decision envelope.
- `items`: Present when `outcome` is `"digest"`. Array of objects with `qitemId`, `notificationKey`, `summary`, optional `body`, and per-item `replyRef` (or `null`). For oversized digests, items (and oversized item bodies) are packed in order across part envelopes within each part's 65,536-byte UTF-8 budget.
- `part`: Present only on multi-part split envelopes (`total >= 2`). Object `{ parentDeliveryId: string, index: number, total: number }` where `1 <= index <= total`. Bridges must persist each part by `deliveryId`, deduplicate replayed part `deliveryId`s, and durably reassemble all parts `1..total` in `index` order before forwarding the complete logical message once to the human recipient.

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
- `sender.handle`: Sender's alias, matching `/^[A-Za-z0-9._-]+$/`. Must match a human fragment bound to the authenticated connector. Harmless extra fields inside `sender` or on the top-level JSON object are ignored and never override `sender.handle` resolution or affect the event fingerprint.
- `replyRef`: Exact opaque string copied from the outbound envelope (maximum 4,096 characters). Bridges must not parse or alter `replyRef`.
- `text`: Plain text response (maximum 32,768 characters, non-empty after trim, no NUL bytes). Processed as unstructured text without automatic natural-language approval parsing.
- `ordering`: Optional enum (`"after-question"` | `"uncertain"`, default `"uncertain"`). When `"uncertain"`, text is accepted as recorded context rather than verified sequence relative to the question.

#### Inbound Statuses & Responses
- **200 OK**: Request accepted (`{ ok: true, deduplicated: false, reconciled: false, qitemId, verb, actorSession, actionId }`). Exact duplicate submissions of the same `eventId` return `ok: true` with `deduplicated: true`.
- **400 Bad Request**: Malformed JSON, non-object payload, or invalid required field syntax/bounds (`eventId`, `sender.handle`, `replyRef`, `text`, or `ordering`). Harmless extra fields are ignored.
- **401 Unauthorized**: Missing, malformed, unrecognized, unready, or cross-profile ambiguous inbound Bearer token.
- **403 Forbidden**: Non-loopback TCP socket peer, browser cross-origin request, connector mismatch (`replyRef` emitted by another connector), or unregistered `sender.handle`. (`Via` and `X-Forwarded-*` headers are ignored).
- **404 Not Found**: Queue item referenced in `replyRef` does not exist.
- **409 Conflict**: Stale `decisionRevision` (question cancelled, answered, or re-asked), attempt to answer an informational update, or conflicting payload submitted under an existing `eventId`.
- **413 Payload Too Large**: Request body exceeds 64 KiB (65,536 bytes).
- **503 Service Unavailable**: Local seen-ledger (`relay-inbound-seen.jsonl`) is unreadable, contains unparseable JSONL or unkeyable records (missing `id`), or has a corrupt/unvouched record for the requested `eventId`'s key. Keyed suspect records (`missing/invalid status` or conflicting recorded fingerprints for the same key; diagnostic `ts` or extra metadata fields are ignored) scope refusal to that `eventId` key only so unrelated `eventId`s continue to operate normally, while never treating unparseable or suspect history as unseen.

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
Create an owner-only secrets file (no group/other access bits, e.g. `0600` or `0400`):
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
| **Insecure Permissions** | `deliveryReadiness.state: ready` (with warning)<br>`reason: ... warning: ... insecure permissions (mode 0644; group/other access bits are set ...)` | Restrict permissions so group/other have no access (`chmod 600 <secrets-file>` or `chmod 400 <secrets-file>`). |
| **Identical Directional Tokens** | `deliveryReadiness.state: ready` (with warning)<br>`reason: ... warning: ... uses the same token for OPENRIG_RELAY_OUTBOUND_TOKEN and OPENRIG_RELAY_INBOUND_TOKEN; separate tokens are recommended ...` | Provision distinct outbound and inbound tokens so outbound capture cannot authenticate inbound replies. |
| **Invalid Loopback URL** | `deliveryReadiness.state: not-ready`<br>`reason: ... OPENRIG_RELAY_URL host must be loopback ...` | Ensure URL uses `http://` and host is `127.0.0.1/8`, `::1`, or `localhost`. |
| **Reused Inbound Token Across Profiles** | `deliveryReadiness.state: not-ready`<br>`reason: ... reuses an ambiguous OPENRIG_RELAY_INBOUND_TOKEN shared with relay profile(s): ...` | Each distinct relay connector profile (`connectorRef`) must declare a unique inbound token. |
| **Stale Question Reply** | HTTP 409 on inbound endpoint | Question was already answered, cancelled, or superseded by a newer revision. |
| **Unregistered Handle** | HTTP 403 on inbound endpoint | The `sender.handle` is not bound to the authenticated `connectorRef`. |
| **Non-Loopback Inbound** | HTTP 403 on inbound endpoint | Connection originated from a non-loopback TCP socket peer or included a cross-origin browser header. (`Via` and `X-Forwarded-*` headers are ignored). |
| **Seen-Ledger Corrupt / Suspect** | HTTP 503 on inbound endpoint (`seen_store_unavailable`) | Unreadable/unparseable/unkeyable `relay-inbound-seen.jsonl` refuses all inbound requests; a keyed suspect entry refuses only that specific `eventId`. |

For automated loopback bridge test reference, see `packages/daemon/test/fixtures/recording-relay.ts`.
