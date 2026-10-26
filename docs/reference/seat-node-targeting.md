# Seat settings by node ID

Clients that present a specific seat can save its later-launch settings using its durable `nodeId`. The node ID is distinct from the current session and native conversation. These routes never launch, stop, or resume the seat.

| Read or save | Node-addressed route |
| --- | --- |
| Status | `GET /api/seat/status/node/:nodeId` |
| Native permissions | `POST /api/seat/set-permissions/node/:nodeId` |
| Permission policy | `POST /api/seat/set-policy/node/:nodeId` |
| Model | `POST /api/seat/set-model/node/:nodeId` |
| Effort | `POST /api/seat/set-effort/node/:nodeId` |

The POST bodies and responses follow the corresponding name-addressed routes. A successful save's `seat.nodeId` and `seat.rigId` identify the node actually updated. The exact status response adds `node_id`, `contract: "seat-node.v1"`, and `supported_actions` listing the four setters. Existing name status responses retain their shape.

An unknown, deleted, or archived node returns `seat_not_found` (HTTP 404) at node resolution. After awaited validation of a native Claude permission mode or Codex profile returns, the exact node-ID path checks availability again before saving; an unavailable node then returns `seat_not_found` without a setting or audit write. Existing native validation may refuse a changed target before this check: for example, Claude's managed context guard can report `permission_selection_refused` during preparation. The daemon never resolves a node ID through a reusable seat name. Setting writes have no general session precondition; a changed occupant on the same available node can receive a later save.

For example, `POST /api/seat/set-model/node/<nodeId>` accepts the existing `{ "model": "...", "reason": "...", "operator": "..." }` body. The existing audit actor, reason, native validation, permission precedence, and terminal policy rules still apply. The older `/:seatRef` routes remain available, including their name ambiguity behavior.
