# OpenShell worker reference, driver version 1

This maintained reference binds an ordinary OpenRig seat to one OpenShell sandbox. It supports explicit create/attach, required context projection and verified JSON artifact return. It requires OpenShell 0.1.6, a Linux image with Python 3, Node 22 or later and Claude Code 2.1.310 at `/usr/local/bin/claude`, an API-backed OpenShell provider and an existing authenticated OpenRig MCP HTTP listener. Subscription/OAuth credential migration is outside this reference.

The image recipe is an input recipe, not a published prebuilt image or a reproducible-image claim. Supply your own trusted, digest-pinned base and the native executable. No credentials, histories or task data belong in its context. Build it explicitly with your normal image tooling, then supply its resulting digest to `create`. Provider registration and image construction can incur costs; setup does neither. The helper releases native startup only after Core verifies the selected destination files and installs the two scoped connections. Its initial preparation latch expires after ten minutes; expiry is a refused start, never a cold worker. Create immediately before `rig up`.

## Install the reference and work connection

Start an MCP HTTP listener using `rig mcp serve --http --help` and the normal member-grant file on this daemon host. Select a guest-reachable address and explicit port. Setup adds one non-owner, one-seat, one-rig work grant in that existing file and stores its bearer credential in a private managed file. It prints only the file reference. Existing files/presets with different bytes are preserved.

```sh
rig environment setup --directory ./openshell-example --binding worker-one \
  --seat team-worker@openshell-example --rig openshell-example \
  --mcp-url http://host.openshell.internal:7781/mcp \
  --guest-base-url http://host.openshell.internal:7782 --json
```

Enable the daemon's separate guest activity listener with `OPENRIG_GUEST_ACTIVITY_PORT=7782` and a guest-reachable `OPENRIG_GUEST_ACTIVITY_HOST` in the daemon launch environment. It is disabled by default; this is an explicit additional listener, not a change to the main API's binding. The listener serves only `POST /api/activity/hooks`, using the seat/generation grant. It exposes no queue, config, event-stream or parked-seat reads and refuses the install-wide token. Use the actual guest-reachable MCP and guest-activity ports. Setup generates `policy.yaml` for those two selected host/port pairs, without blanket egress. Never grant the guest access to the daemon's main API port (normally 7433). OpenShell's REST policy applies to a host and port: the dedicated listener confines the surface, while its activity grant and the separate MCP work grant authorize their respective requests. The activity rule names `/usr/bin/node`, matching the selected plugin hook interpreter. Qualify that path in your image. The separate read-only `platform.claude.com` rule is for the pinned native startup check and carries no inference credential.

Import `claude-code-provider.yaml` using OpenShell's provider-profile commands, then create a provider with its `ANTHROPIC_API_KEY` environment lookup. See `openshell provider --help`; keep the master credential in provider custody, never an argument or source file. `create` passes that provider reference with `--no-auto-providers`. The guest helper saves only the provider-injected reference in a private file and uses Claude's `apiKeyHelper`. It does not copy an owner authentication home.

Build `Dockerfile` with the selected digest-pinned `BASE_IMAGE` and your trusted `claude` executable beside it. Use the resulting actual digest, gateway, workspace and provider reference:

```sh
rig environment create worker-one --seat team-worker@openshell-example \
  --gateway YOUR_GATEWAY --workspace YOUR_WORKSPACE --name worker-one \
  --image YOUR_IMAGE@sha256:YOUR_64_HEX_DIGEST --provider YOUR_PROVIDER \
  --policy ./openshell-example/policy.yaml \
  --guest-base-url http://host.openshell.internal:7782 --json
rig up ./openshell-example/rig.yaml
```

Setup installs the `openshell-claude` community preset. The host coordinator uses ordinary Claude Code; the worker selects that preset. The exact seat reservation is claimed by its first stable node. OpenRig maps resolved guidance, skills and plugins into the guest work root, stages all applicable startup files before native launch, verifies bytes again at the latch and records the native UUID observed in that resource. A process receipt establishes identity, not successful authentication, actual ingestion or a model response. Activity hooks are recorded under their grant; this community runtime currently uses pane sampling to decide activity and does not claim the runner inventory. Work and activity grants are separate. The guest never receives the install-wide hook token.

For an existing compatible sandbox, use `attach` with the same placement flags plus `--resource-id` and optionally `--fingerprint`. Its immutable ID, name, workspace and selected fingerprint must match live inspection. Attached ownership remains attached; this cut never deletes its native state, storage or compute. An arbitrary preexisting image without the fixed helper is incompatible, even if its name matches.

An attach refusal permits a corrected attach, and an intent that never requested a provider effect can be replaced with a new operation. Once create was requested it must be reconciled; it is not silently abandoned.

A `202` result means the create is unconfirmed. Repeat the same command and operation identity to reconcile; do not choose a new operation to force another create. A matching operation label and immutable resource identify a lost response. Incomplete listings, duplicate matches and provider unavailability remain distinct from absence. `inspect --live` refreshes the exact resource; plain inspect labels its stored receipt.

## Return actual work

The coordinator assigns ordinary queue work with a concrete JSON-object schema and task/revision context. The worker writes beneath `/sandbox/openrig/work/artifacts`, computes SHA256 and byte count, and calls `rig_environment_export` through its authenticated MCP connection. Alternatively, a host caller can use `rig environment export worker-one --request request.json --json` to use that same managed work grant. Example request:

```json
{
  "operationId": "report-task-one", "taskId": "YOUR_TASK_ID",
  "generation": "YOUR_OCCUPANT_GENERATION", "path": "report.json",
  "sha256": "YOUR_64_HEX_SHA256", "bytes": 123,
  "schema": {"format": "json-object/v1", "fields": {"task": "string", "revision": "number", "report": "string"}, "required": ["task", "revision", "report"]},
  "context": {"task": "YOUR_TASK_ID", "revision": 1}
}
```

The fixed helper opens a single file through non-symlink directory descriptors and reads at most 1 MiB plus one rejection byte. Core bounds the captured response and decoded bytes before any host file write; vendor tar download/extraction is not used. The host checks path/type/size/hash/schema/context, publishes to a fresh no-overwrite path, and atomically appends a receipt to the existing task. Publication before a lost receipt is reconciled from verified host bytes even if the guest is gone. The task remains open until its owner reports completion. The receipt records the authenticated grant-derived caller; a declared body actor and the activity token cannot impersonate a work principal. Preserve the same operation on retry. Changed host bytes, generation, task owner or request refuse publication/receipt rather than overwriting or fabricating completion.

## Boundaries

Driver protocol 1 is documented by `driver-v1.schema.json` and the daemon's `EnvironmentDriver` interface. Core owns placement provenance, operation intent, resolved-file selection and receipts; the driver owns fixed OpenShell CLI transport and guest path mapping. There is no generic plugin loader or alternative task store. Projection is bounded to 4096 files, 1 MiB per file and 32 MiB total. Unsupported runtime resources/subagents refuse the selected launch explicitly; ordinary host runtimes keep their existing behavior.

Native stop, compute stop/delete, checkpoint and exact native restore are not implemented by this driver version. Inspect reports these lifecycle operations as unsupported; closing a viewer proves only detachment. Do not use it as a shutdown receipt. A previous requested or confirmed native execution blocks a fresh launch until lifecycle/restore can reconcile it. No native, provider, lifecycle or restore conformance is claimed by source tests; qualify the maintained reference separately on its exact build.
