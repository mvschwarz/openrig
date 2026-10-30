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

## Select completion and retain native state

Finite completion is optional and belongs to one binding input. It does not change AgentSpec or persistent defaults. Save a request file selecting exactly one task, generation, required export operation and effect:

```json
{"operationId":"complete-task-one","taskId":"YOUR_TASK_ID","generation":"YOUR_OCCUPANT_GENERATION","exportOperationId":"report-task-one","effect":"stop-native"}
```

```sh
rig environment completion worker-one --request completion.json --json
rig environment checkpoint worker-one --generation YOUR_OCCUPANT_GENERATION --operation native-checkpoint-one --json
```

A selected task must be successfully settled under the existing queue closure contract, with its required host export still matching the verified bytes. Only then does the selected native/compute stop run. Failed work, another row closing, an empty queue, a closed viewer, a stale generation and a pending/changed export do not count. The task, seat and native identity remain. Receipt and pending-effect state are visible in `inspect`. Repeating the same completion request reconciles it without a second provider mutation.

Checkpoint while the guest is accessible. Export the useful result first, then capture the exact newline-terminated native history prefix and prior verified artifact references. A later native append does not rewrite that checkpoint. This first native-store mapping supports one history file of at most 1 MiB at the fixed Claude project path, not arbitrary native-store portability. Retained prior artifacts are bounded to 128 files and 32 MiB combined. Private history bytes stay under the daemon's private state root; snapshots carry only binding/checkpoint/native/compute/state-location references. Missing, changed or mismatched state refuses resume, never starts fresh.

The guest supervisor retains control/file access for up to 30 minutes after native exit. Its native PID and process-start identity are distinct from the supervisor and compute identity. An idle supervisor is not an idle model claim. Native TERM has its own bounded observation; it does not delete compute. Collect the checkpoint before stopping compute.

## Distinct selected effects

```sh
rig environment effect worker-one --effect close-viewer --generation YOUR_OCCUPANT_GENERATION --operation detach-one --json
rig environment effect worker-one --effect stop-native --generation YOUR_OCCUPANT_GENERATION --operation native-stop-one --json
rig environment effect worker-one --effect stop-compute --generation YOUR_OCCUPANT_GENERATION --operation compute-stop-one --json
rig environment effect worker-one --effect delete-owned --generation YOUR_OCCUPANT_GENERATION --operation delete-one --engine-socket /run/user/YOUR_UID/podman/podman.sock --json
```

Use the actual local rootless Podman socket on the provider host. The observer is read-only; it never removes engine resources itself. Before deletion it records exact workload/supervisor container identities and their attributable workspace/control/channel volumes. After the single vendor request, a complete gateway listing must establish the immutable resource's absence, and independent queries on that same engine/socket must establish those components absent. Other engine resources are preserved. Transport/auth errors, changed sockets, incomplete lists or a remaining volume stay unconfirmed. A vendor Accepted/Completed response alone does not establish engine cleanup. Per-sandbox secret cleanup is not an observed component class here.

Attached consumers may close only their own viewer. Their external native process, storage and compute remain preserved. `rig seat stop` and `rig down` retain their existing pane semantics and label community panes accordingly; neither stands in for these explicit resource receipts. A pending/unconfirmed effect retains its original operation. Repeating that operation observes its result without blindly repeating stop/delete. A reused name with another immutable ID refuses deletion.

## Explicit same-host compute recreation and exact restore

After checkpoint and confirmed predecessor deletion, save a recreate request using the checkpoint receipt's exact native type/id and predecessor generation, plus the selected successor placement:

```json
{
  "operationId":"recreate-one", "generation":"YOUR_PREDECESSOR_GENERATION",
  "checkpointId":"native-checkpoint-one", "resumeType":"community:openshell-claude", "resumeToken":"YOUR_RETAINED_NATIVE_UUID",
  "placement":{"gateway":"YOUR_GATEWAY","workspace":"YOUR_WORKSPACE","name":"worker-two","image":"YOUR_IMAGE@sha256:YOUR_64_HEX_DIGEST","provider":"YOUR_CURRENT_PROVIDER","policy":"/ABSOLUTE/PATH/TO/policy.yaml"}
}
```

```sh
rig environment recreate worker-one --request recreate.json --json
rig restore --help
```

Use normal `rig restore` or its existing selected-seat restore surface for the same team snapshot. The snapshot must carry the exact binding/checkpoint/native references. Recreation creates compute only: it does not choose a fresh native UUID or send model input. Current provider references may be selected; old revoked credential bytes are never restored. The successor must be observed on the retained predecessor host/engine before its binding advances. Its first actual launch generation is claimed once, then current projection, unchanged history and prior artifact bytes are verified before the descriptor is released. Native launch uses `--resume` with the exact saved UUID. No missing-history, different-type or restore failure permits a fresh fallback.

The first source tests use fake provider transport, the actual guest helper's file operations and real daemon/MCP/filesystem paths. They do not establish native authentication, ingestion, blind recall, RAM release, same-container restart or a successful provider run. Qualify those claims on the exact maintained build through the selected native acceptance owner.

## Versioned driver boundary

Driver protocol 1 is documented by `driver-v1.schema.json` and the daemon's `EnvironmentDriver` interface. Core owns placement provenance, operation intent, resolved-file selection, selected task completion and receipts; the driver owns fixed OpenShell CLI transport and guest path mapping. There is no generic plugin loader or alternative task store. Projection is bounded to 4096 files, 1 MiB per file and 32 MiB total. Unsupported runtime resources/subagents refuse the selected launch explicitly; ordinary host runtimes keep their existing behavior. Cross-host migration, RAM snapshots and arbitrary native-store portability remain outside this reference.

## Lifecycle and restore limits

The placement name is supplied by the caller. Create refuses an already-listed name, and each binding retains its one selected name; OpenRig does not reserve names globally across bindings. Immediately before stop/delete, OpenRig checks the saved immutable identity, then the pinned vendor call addresses the name and workspace. A deliberate reuse of that name between inspection and the vendor call could affect the replacement. The pinned CLI has no expected-id condition for these calls. Later reconciliation cannot undo that mutation.

Exact restore onto recreated compute stages the current resolved role, skills, plugins and required startup files as destination files, including files originally intended only for a fresh start. Declared context changes, additions and removals are allowed. Current source and destination bytes are verified through the ordinary projection checks; a missing or stale required destination refuses launch. Startup actions and text are not replayed into the conversation. The checkpoint pins the original native history and verified artifact bytes, which remain separate and unchanged; it does not freeze the context.

A pending finite-completion attempt records its last outcome and attempt time in the existing operation receipt. Queue events and boot/manual checks observe it at most once per 60 seconds; there is no new polling timer. Eligibility is checked again after the driver's identity await, immediately before its stop command. A known refusal before dispatch releases only the unstarted effect claim; an uncertain dispatched request is never replayed. With no pending selection, a queue event performs one filtered query and no provider call; the operation table has no additional index or migration in this increment.

Checkpoints contain full private native history and currently have no removal or expiry command. Retain them under the daemon owner's private state root and account for their disk use. Stop-native does not terminate every process the native started or revoke its activity grant; children can outlive it during the bounded supervisor period. Viewer close does not itself finalize the ordinary session row. The earlier per-resource startup fence still requires manual reconciliation of a saved launch, and a successor-generation mismatch after a failed pre-launch projection can still reach projection before later launch refusal. These are named limits, not completion or activity claims.

A lifecycle driver must run its optional final dispatch check after its last asynchronous identity observation and immediately before issuing a stop command. A declined check means no command was sent; transport failure after dispatch remains uncertain. Core also checks at its call boundary.

Lifecycle requester audit uses the existing `X-OpenRig-Session` transport attribution and overrides a body `requestedBy` claim. It is not credential-backed seat authentication; any process able to reach the trusted daemon can supply that header. The separately scoped work and activity grants authenticate their own ingress only.
