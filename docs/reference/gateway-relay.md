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
- Each logical decision freezes its complete `relayEnvelope` onto the parent `DispatchBuffer` entry before the first network attempt, with no self-imposed outbound 64 KiB cap or multi-part splitting.
- Transport is at-least-once: OpenRig sends the complete JSON envelope in a single HTTP `POST` per attempt with `deliveryId = <decisionId>` (preserving the full `body`, `humanDetail`, `humanQuestions`/options, `summary` overflow, and digest `items` without silent clipping).
- An HTTP `2xx` response from the bridge acknowledges durable bridge custody of that complete envelope (`deliveryId`). The bridge must persist each envelope by `deliveryId` and deduplicate replayed `deliveryId`s idempotently.
- OpenRig records the logical queue acceptance receipt (`relay-owner-notification-accepted` with `deliveryId`) and drains the decision from `DispatchBuffer` once the HTTP `POST` returns `2xx`. Bridge acceptance confirms custody by the bridge process only (and is projected as `accepted` / `"Accepted by bridge"`, whereas Slack posts use `posted` / `"Delivered"`). It does not indicate downstream platform delivery, posting, or human receipt.
- Failed dispatches remain in OpenRig's `DispatchBuffer` and record a relay-specific failure transition note (`relay-owner-notification-transport-failed` naming the `connectorRef`, distinct from Slack's `slack-owner-notification-transport-failed`). Replays after a lost ACK or daemon/bridge restart re-send the exact frozen `relayEnvelope` with the same `deliveryId` and bytes. If the relay subsystem stops while an outbound HTTP `POST` is in flight (or before it starts), the transport aborts cleanly (`stopped`) without recording a false failure transition note or false acceptance receipt, retaining the buffered decision for replay on restart. There is currently no periodic background timer redriving outbound dispatches on timeout.

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
  "replyRef": "eyJ2IjoxLCJwYXlsb2FkSGFzaCI6...<base64url>"
}
```

- `v`: Protocol version integer (`1`).
- `deliveryId`: Stable whole-decision delivery identifier (`<decisionId>`).
- `recipient.handle`: Recipient's registered safe alias for this connector.
- `intent`: `"decision"` (actionable question) or `"update"` (informational notice).
- `outcome`: Delivery classification (`"interrupt"`, `"notify"`, or `"digest"`).
- `summary`: Plain text summary preview (up to 1,000 characters on the `summary` field, cut on a Unicode code-point boundary; any summary text exceeding 1,000 characters is preserved in full at the beginning of `body` or `item.body`).
- `body`: Complete plain text content (including full `summary` overflow, `body`, `humanDetail`, and rendered `humanQuestions` headers, prompts, and option labels/descriptions) sent in a single complete JSON envelope without silent character clipping or self-imposed outbound byte splitting.
- `replyRef`: Fixed-size opaque base64url token (`<= 4,096` characters for any supported ID lengths — `246`–`266` characters in protocol v1, hashing the canonical frozen `RelayReplyRefPayload` and binding `connectorHash`, `mode`, and optional `digest: true`) for actionable decisions; `null` for informational updates (and `null` at the top level of multi-item digests).
- `items`: Present when `outcome` is `"digest"`. Array of objects with `qitemId`, `notificationKey`, `summary`, optional `body`, and per-item `replyRef` (or `null`).

### Inbound Envelope (`POST /api/gateway/relay/inbound`)

```json
{
  "eventId": "evt-relay-20261107-001",
  "sender": { "handle": "alice-ops" },
  "replyRef": "eyJ2IjoxLCJwYXlsb2FkSGFzaCI6...<base64url>",
  "text": "Approved. Proceed with rollout.",
  "ordering": "after-question"
}
```

- `eventId`: Bridge-assigned identifier (`1..256` chars, matching `/^[A-Za-z0-9._:-]{1,256}$/`).
- `sender.handle`: Sender's alias, matching `/^[A-Za-z0-9._-]+$/`. Must match a human fragment bound to the authenticated connector. Harmless extra fields inside `sender` or on the top-level JSON object are ignored and never override `sender.handle` resolution or affect the event fingerprint.
- `replyRef`: Exact fixed-size opaque base64url token copied from the outbound envelope (maximum 4,096 characters). Bridges must not parse or alter `replyRef`.
- `text`: Plain text response (maximum 32,768 characters, non-empty after trim, no NUL bytes). Processed as unstructured text without automatic natural-language approval parsing.
- `ordering`: Optional enum (`"after-question"` | `"uncertain"`, default `"uncertain"`). When `"uncertain"`, text is accepted as recorded context rather than verified sequence relative to the question.

#### Inbound Statuses & Responses
- **200 OK**: Request accepted (`{ ok: true, deduplicated: false, reconciled: false, qitemId, verb, actorSession, actionId }`). Exact duplicate submissions of the same `eventId` return `ok: true` with `deduplicated: true`.
- **400 Bad Request**: Malformed JSON, non-object payload, or invalid required field syntax/bounds (`eventId`, `sender.handle`, `replyRef`, `text`, or `ordering`). Harmless extra fields are ignored.
- **401 Unauthorized**: Missing, malformed, unrecognized, unready, or cross-profile ambiguous inbound Bearer token, or no humans configured (`noHumans`).
- **403 Forbidden**: Non-loopback TCP socket peer, browser cross-origin request, connector mismatch (`replyRef` emitted by another connector), or unregistered `sender.handle`. (`Via` and `X-Forwarded-*` headers are ignored).
- **404 Not Found**: Queue item referenced in `replyRef` does not exist.
- **409 Conflict**: Stale `decisionRevision` (question cancelled, answered, or re-asked), attempt to answer an informational update, unrecognized `replyRef` when both durable receipts and the pending dispatch buffer are readable, or conflicting payload submitted under an existing `eventId`.
- **413 Payload Too Large**: Request body exceeds 64 KiB (65,536 bytes).
- **503 Service Unavailable**:
  - `human_registry_unavailable`: Local human registry (`gateway/humans/*.yaml`) failed to load due to a broken fragment or filesystem read error (normal `noHumans` returns `401`).
  - `queue_store_unavailable`: Local SQLite queue/transition store read failed while resolving or verifying `replyRef`, returning `503` with zero seen-store reservation or Mission Control action side effects.
  - `dispatch_buffer_unavailable`: An un-receipted `replyRef` required fallback verification against `<openrig-home>/gateway/dispatch-buffer.json`, and reading the buffer failed (`pendingStrict()`), returning `503` with zero seen-store reservation or Mission Control action side effects. (`replyRef`s already vouched for by durable accepted receipts in `queue_transitions` or `queue_transitions_archive` are verified before consulting the buffer and still succeed.)
  - `seen_store_unavailable` (response includes `seenPath`): Local seen-ledger (`state/relay-inbound-seen.jsonl`) is unreadable, contains unparseable JSONL or unkeyable records (missing `id`), failed a reservation/processed mark, or has a corrupt/unvouched record for the requested `eventId`'s key. Keyed suspect records (`missing/invalid status` or conflicting recorded fingerprints for the same key; diagnostic `ts` or extra metadata fields are ignored) scope refusal to that `eventId` key only so unrelated `eventId`s continue to operate normally, while never treating unparseable or suspect history as unseen.

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
| **Registry or Buffer Read Failure** | HTTP 503 on inbound endpoint (`human_registry_unavailable` or `dispatch_buffer_unavailable`) | Inspect local `gateway/humans/*.yaml` fragments or `<openrig-home>/gateway/dispatch-buffer.json` for syntax/permission corruption before retrying the bridge event. |
| **Seen-Ledger Corrupt / Suspect** | HTTP 503 on inbound endpoint (`seen_store_unavailable`, includes `seenPath`) | Unreadable/unparseable/unkeyable `relay-inbound-seen.jsonl` refuses all inbound requests; a keyed suspect entry refuses only that specific `eventId`. Follow the conservative recovery procedure below. |

### Conservative Seen-Ledger Recovery (`seen_store_unavailable`)

When `POST /api/gateway/relay/inbound` returns `503` with `error: "seen_store_unavailable"`, the response body and message include the resolved `seenPath` (`<openrig-home>/state/relay-inbound-seen.jsonl`):

1. **Quiesce writers first**: Pause the loopback bridge and stop the daemon (`rig daemon stop`) so no concurrent inbound request or retry appends to the ledger during inspection.
2. **Preserve a full backup**: Copy `<seenPath>` to a timestamped backup outside `state/` before making any edit.
3. **Correlate against durable evidence**: Each ledger entry keys `id` by `eventKey = SHA256(JSON.stringify([connectorRef, eventId]))` (64-character lowercase hex digest) and stores `status` as `received:<fingerprint>` or `processed:<fingerprint>`. Because `eventKey` is a one-way hash, correlate any damaged line or keyed suspect `id` against `mission_control_actions.audit_notes_json` (which records `operationId: "relay:<eventKey>:<fingerprint>"`, `connectorRef`, and `eventId`) and bridge delivery logs by computing `SHA256(JSON.stringify([connectorRef, eventId]))` for candidate events—never by guessing or assuming the hash is reversible.
4. **Apply only evidence-verified, history-preserving repair**: Repair a damaged record only when its exact `id` (`<eventKey>`) and `status` (`received:<fingerprint>` or `processed:<fingerprint>`) are verified from `mission_control_actions.audit_notes_json` or bridge evidence, or restore only from a backup that preserves every subsequently acknowledged event. Do **not** delete, truncate, or skip unknown/unparseable records, and do **not** restore an older backup that omits acknowledged events; if an entry cannot be verified without losing history, leave the ledger in place (continuing to fail closed with `503`) and retain the backup.
5. **Resume and retry**: After a verified, history-preserving repair is saved at `<seenPath>`, start the daemon (`rig daemon start`), resume the loopback bridge, and retry the original inbound delivery with the same `eventId`.

For automated loopback bridge test reference, see `packages/daemon/test/fixtures/recording-relay.ts`.
