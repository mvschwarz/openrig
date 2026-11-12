# HTTP operation correlation

`GET /api/operations/capabilities` advertises `operation-correlation.v1` and the supported kinds: `rig.create`, `rig.import`, `rig.materialize`, and `member.add`. A client should check the required kind before relying on correlation; an older daemon may ignore an unfamiliar request header.

For `POST /api/rigs`, `POST /api/rigs/import`, `POST /api/rigs/import/materialize`, and `POST /api/rigs/:rigId/pods/:podNamespace/members`, send a UUID in `X-OpenRig-Operation-Id`. Keep the same daemon, route targets, original request text, and behavior-changing headers for a retry. Materialization binds the target rig (when expanding), source root and cwd override as well as the spec text; it is distinct from launching import. IDs are case-normalized. An ID that isn't an RFC UUID receives HTTP 400 `Invalid X-OpenRig-Operation-Id` before the route does anything else. Once a request passes the route's own validation, a different request using the same ID receives HTTP 409 `operation_id_conflict`. Matching compares the exact request text, so a change in whitespace or key order is a different request, not an equivalent one; an exact replay receives HTTP 200 with `replayed: true` and current database state. A first request retains its usual status and response fields and adds `operation`.

The operation contains the rig and node IDs committed by that request. Its `current` field reads the database at response time, including whether recorded resources still exist and the latest recorded session for each node. It does not inspect tmux or prove a launch finished. A reservation with no IDs can mean that execution is still underway or that it failed before creating resources. Replaying an exact request that failed before creating resources returns HTTP 200 with `operation.rigId: null` and `operation.nodeIds: []`; inspect those fields to distinguish it from a replay that recorded resources. Replays never execute the mutation again, retry a launch, or recreate deleted resources. Use a new UUID only when deliberately starting a new execution.

This contract stores neither the original response nor a recovery verdict. An HTTP response can be lost after a database commit. External launch effects are outside the database transaction, so the contract is correlation rather than exactly-once execution of external effects.

## CLI no-launch preparation

`rig import ./team.yaml --materialize-only --operation-id <uuid> --json` prepares topology without starting sessions.
Save the UUID before running the command and reuse the exact command after a lost response. The CLI checks that the
daemon advertises `rig.materialize` before writing; a daemon without that capability refuses the explicit retry request.
`--operation-id` and `--json` apply only to `--materialize-only`, without other import modes. Omitting the operation id
keeps ordinary materialization behavior; it does not make repeated imports idempotent.

JSON output is the native receipt. Both initial and replay receipts carry the same committed ids in
`operation.rigId` and `operation.nodeIds`. Replays report current database state, not a cached first result. An empty
receipt leaves the CLI nonzero: it cannot confirm preparation while the original execution is still running or failed
before creating resources. Text-mode replays still print recorded rig and node IDs when resources are archived or
missing, with a warning and a nonzero exit status. JSON mode retains the native receipt and the same nonzero status.
The receipt's ids do not authorize launching anything; use the normal owner-authorized
[first start of a materialized seat](rig-spec.md#starting-one-materialized-seat) afterward.
