# Execution and platform integration contract — draft

This chapter describes the placement and resource responsibilities of an integration author. The harness/runner chapter owns native protocol, model input, activity, attention, permission exchange and turn cancellation. This chapter owns where that harness runs, which files and credentials it can reach, how native state survives an environment change, and how results and resources return to their owners.

**Status:** a design contract for authors, with an existing-compatible composition and one measured private implementation. The measured baseline used OpenRig 0.7.4, OpenShell 0.1.6 and Claude Code 2.1.310. Inclusion of this draft in 0.7.6 documentation does not implement a generic environment driver, a `DeploySpec` loader or a cross-host native-resume guarantee. Proposed operations below are not commands or accepted configuration keys. Capability support must be stated for the actual integration and version.

## Keep the identities and responsibilities separate

RigSpec composes members, their AgentSpecs/profiles, runtimes, working directories and relationships. AgentSpec supplies reusable role, startup and context declarations. A built-in runtime or registered community preset supplies a launch path. An environment integration supplies placement and provider-specific resource handling around that path. Existing declarations do not automatically provision a remote filesystem, credentials or compute.

| Identity or handle | Meaning and responsibility |
|---|---|
| Stable seat and work identity | The member's canonical address/node and owned work records. OpenRig retains this identity across executions; an environment IP or display name does not replace it. |
| Native session identity | The harness's conversation token/UUID, qualified by harness and resume-reference type. The harness owns its format and resume semantics. |
| Environment binding | The integration's durable record linking placement, immutable provider resource IDs, native-state location, projection and ownership. It is separate from the native session token. |
| Execution generation | A particular launch/process instance, with observable process/start identity when available. A new process can resume an old conversation. |
| Viewer/client | A terminal attachment or connection to an execution. Closing it need not stop either the native process or compute. |

An application service bundled with a rig is a separate responsibility. An artifact browser or database in `RigSpec.services` serves the team's application; its presence does not place an agent inside that service. Bundling service definitions also does not bundle image bytes, native binaries, authenticated homes or live runtime state.

## A minimal composition using existing surfaces

The following is a **fragment of one pod** (`pods[].members`), using existing RigSpec fields, not a complete standalone RigSpec:

```yaml
pods:
  - id: dev
    label: Development
    members:
      - id: coordinator
        agent_ref: local:agents/coordinator
        profile: default
        runtime: claude-code
      - id: worker
        agent_ref: local:agents/worker
        profile: default
        runtime: example-contained-claude
```

The worker runtime names an author-installed community preset. This preset shape uses existing fields exercised on the 0.7.4 baseline:

```yaml
format: 1
name: example-contained-claude
maintainer: Integration author
command: ./scripts/launch-contained-worker
launch_result: true
resume: true
startup_assisted: true
limits:
  - Requires an explicitly prepared environment binding and guest projection.
  - Native resume is qualified only for the documented retained-state recipe.
  - Viewer closure does not implement turn cancellation or resource deletion.
```

This is an integration skeleton, not an installed or qualified preset. The author must supply the executable, resolve its path against the actual launch working directory, register the preset in the existing OpenRig home, and prepare the member's host working directory. The launcher implements the preset's declared launch-result and typed-resume behavior; the runner chapter defines those mechanics. `startup_assisted` requires a startup-submission check; it does not hold back submission or establish successful context delivery or ingestion. A member's model setting is not automatically honored by a custom launcher: its resolved native model/effort must be explicit in that launcher's supported configuration. With `passes_model: true`, Core passes the declared model through `OPENRIG_MODEL`; the launcher must map and apply it. The effective model remains unknown to Core.

For a contained worker, the launcher may resolve a private binding, create or attach to the selected resource, project explicit inputs, then connect to the native process inside it. In the measured recipe, OpenRig ran on the host, the plain coordinator used the built-in native runtime, and the worker used a private community launcher. The wrapper performed projection, provider-reference delivery, resume validation and artifact export explicitly. Those effects were not supplied by the preset declarations themselves. The integration must not assume host guidance/skills, hook paths or environment variables automatically reach a community runtime's guest.

A downstream author can implement this composition today around a qualified provider API and native harness. It remains an author-maintained integration until maintained platform support is separately implemented and documented. Validate against the target OpenRig schema and effective launch configuration; a parsed field or successful process start alone does not establish its effect.

## Placement and launch receipts

Before mutation, resolve the selected host/provider, workspace, image/native versions, reachability, credential references, resource request and ownership. Record existing resources and the selected resource scope. Host headroom includes supervisors, gateway and other team members; a workload memory request is not proof of their combined cap. Report requested, admitted and observed resources separately. Do not infer enforced CPU/memory or isolation policy from accepted flags.

Persist a launch intent before a create operation. Use an attempt/retry identity where the provider supports it; otherwise reconcile the original operation before another create. A public binding receipt carries only nonsecret values. If the harness's native resume reference works like a bearer credential (anyone holding it can reopen the conversation), keep it in secret-held receipt data, never in the public receipt. A useful public receipt identifies:

- canonical seat, harness version and native resume-reference type;
- provider/host/workspace, immutable environment ID and execution generation;
- image/policy versions, requested resources and observed readiness;
- inner working directory, private native-state location and projection manifest;
- a public-safe native reference (never a bearer-like resume token), creator or attached-consumer disposition, and exact owned resource handles;
- lifecycle operations supported, completion observations, pending effects and errors.

A resource name or IP can be reused. Reconcile immutable ID, workspace and any available generation/fingerprint before acting. A lost response is **unconfirmed**, not success or absence. Record provider failures without exposing credentials. Readiness should identify what is ready: provider reachable, filesystem projected, native process started, team identity authenticated, or task completed.

## Project files and credential references deliberately

Stage only declared inputs: role/startup material, selected skills, current work context, schemas and required native settings. Preserve unmanaged files and report conflicts. Review every path-bearing setting for its destination: host-only hook scripts, interpreters, status collectors and loopback URLs may not exist or be reachable in the guest. Missing activity or permission transport must remain unsupported rather than being inferred from the base harness name.

Distinguish three observations: host staging, destination delivery and native ingestion. A destination manifest can record relative path, byte count and hash; a useful task using the current context revision/nonce can show consumption. Neither observation substitutes for the other. Current working input may change between tasks while an earlier artifact stays immutable.

Retained native history is a different data class from ordinary project context. Preserve its exact bytes through the harness's supported resume path; do not edit records or synthesize a conversation. Preserve a complete checkpoint prefix with byte length/hash if the harness may append after the checkpoint. Record which native-state files are required and which remain unavailable. Never substitute a fresh conversation seeded with a report while calling it native resume.

Keep secret values out of RigSpec, preset YAML, bindings, argv and public receipts. The provider/credential owner supplies scoped references or native-supported credential helpers and controls revocation. A successful login, provider registration or model-list request is not evidence of usable inference credit or an authorized spend envelope. Do not infer subscription portability from a provider name or copy an authenticated owner home into a guest.

Authenticate guest coordination through the actual granted member route. A shared source IP is not a seat identity. Record the grant-bound principal and scope separately from resource placement; distinct principals do not imply per-seat row ACLs or isolation between co-located secrets.

## Own only the effects assigned to the integration

Record **created** versus **attached** for each launch receipt. The creator may stop/delete the exact resource it created under the selected policy. An attached consumer normally closes only its own client and any separately identified process it owns; it must preserve the external environment, native session, workspace and shared services. Attachment must not silently transfer provider custody. An explicit owner-authorized transfer is a separate recorded action.

Describe these effects independently:

| Operation | Required distinction |
|---|---|
| Cancel a turn | Ask the runner to stop current work and observe its result. Unsupported cancellation must not be replaced silently by killing compute. |
| Close a viewer | Release that client/connection; report whether native execution continues or is unknown. |
| Stop native execution | End the identified native process and observe its exit. This is separate from task success. |
| Stop compute | Release the documented provider allocation; identify retained storage and actual provider/process state. |
| Delete an owned environment | Remove the exact creator-owned resource and reconcile final absence, including provider-managed dependents. |

Use graceful shutdown first where supported, then only explicitly owned, identified handles for stronger termination. Never equate pane disappearance with process or resource release. Persistent/non-persistent lifetime describes when execution should stop; durability describes recovery. An explicit non-persistent completion condition must name its invocation/work scope. An unrelated queue closure or an empty queue is not permission to terminate a member, and no new lifecycle YAML syntax is specified here.

## Resume exactly, or return an honest disposition

A resume request identifies the seat, harness-qualified native reference, prior binding, expected environment boundary and retained state. Validate those before launching the native harness. Reject mismatched reference types, missing/changed history, wrong immutable resources, unavailable required files and duplicate active executions. Never use “latest” as a replacement for an exact requested conversation or silently start fresh on failure.

Separate the outcomes: same native conversation resumed; new conversation rebuilt from artifacts; fresh launch; unsupported; refused; or unconfirmed. Environment continuity has its own outcome: same retained environment, recreated compute with copied state, different host, or unknown. A matching UUID alone does not show that native history was consumed.

If a provider stops exposing file transfer after canonical-process exit, capture artifacts/history and publish any retained resume descriptor **while transfer is still available**. Verify destination bytes before shutdown. After completion, use host/provider observations instead of assuming guest exec still works. For recreated compute, explicitly transfer the retained checkpoint and required artifact into the successor environment and validate them before publishing its resume descriptor. A new environment ID is expected and must be recorded as a successor, not disguised as the old environment.

The measured private recipe demonstrated this latter boundary: the original sandbox was deleted; copied native history and task bytes were restored into new containers on the same physical host; the native harness launched with `--resume` and the retained UUID. Its first new reply recalled a private conversation-only marker before tools, with no marker in the new input and no native-history tool read. It then verified artifact 1, used changed task context, produced artifact 2 and returned it for independent coordinator verification. This establishes one bounded native-return/work result. It does **not** establish new-host migration, RAM restoration, same-container stop/start, cgroup enforcement, general portability or shipped platform support.

## Export results before teardown

A guest path/hash note means bytes exist in a guest; it is not delivery to the consumer. Identify the actor holding the provider transfer handle. In the measured recipe that actor was the host wrapper, not the guest worker.

The worker publishes its report once and records the task/path/hash on its existing child. The wrapper validates the binding, task, allowed path, file type, size and expected hash; transfers to a fresh host staging path; checks the returned bytes/schema/context; and publishes without overwriting an existing result. It records an actual consumer-accessible destination, hash, byte count and actor through the authenticated work route. The worker closes its child after the matching export receipt; the coordinator independently reads/verifies those bytes before closing its parent. An ambiguous transfer is reconciled by existing bytes/hash, not a new report or duplicate task.

Complete exports before resource deletion. If output cannot be returned, preserve the exact resource/owner and failure state. Cleanup then reconciles the exact owned workload, supervisor, volumes and provider records to the intended stopped/absent state. Keep reused engines, caches, authenticated environments and attached resources. Revoke scoped credentials/grants through their owners and record remaining state. “Delete requested” and “absence verified” are different receipts.

## Proposed generic platform seam — not implemented

The existing composition need not acquire another YAML format to describe these responsibilities. If a maintained platform seam is selected, the following **design pseudocode** names the smallest useful operations; it is not a loader or API available in this release:

```text
prepare(placement, ownership, resourceRequest, credentialRefs) -> bindingReceipt
project(binding, explicitFiles, nativeCheckpoint?) -> deliveryReceipt
launch(binding, harnessLaunch, exactResumeRequest?) -> executionReceipt
observe(binding, execution) -> observedState | unsupported | unconfirmed
export(binding, artifactRequest) -> publicationReceipt
shutdown(binding, execution, selectedEffect) -> effectReceipt
```

The provider implementation interprets its image/network/compute configuration. The runner interprets native protocol and control. Core would retain typed provenance and route the selected effects; it must not reinterpret arbitrary provider keys, leak secrets or collapse ownership into a stop boolean. Each mutating operation needs an attempt identity and reconciliation route; partial receipts remain useful after failure. Capability reporting must expose unsupported projection, cancellation, resume or cleanup rather than letting method names imply support.

The most useful author evidence follows the real work path: exact resolved placement and native launch; delivered current context; authenticated work ownership; returned artifact bytes; exact resume boundary and consumed retained state; and final resource disposition. A parser pass, launcher success, viewer reconnect or same display name leaves the corresponding effect unconfirmed. These distinctions let an author implement and diagnose an integration; they do not create a new release gate or require another runtime campaign.
