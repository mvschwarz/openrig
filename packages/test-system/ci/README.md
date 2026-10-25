# PR scenario increment

The `installed-scenario` job in `.github/workflows/tests.yml` builds the existing
`docker/testbed` image from the stock package. It installs that tarball on a clean
Linux target and proves daemon load before running the existing
`packages/daemon/test/fixtures/scenarios/scenario-02-baton.yaml` unchanged.

The runner is `runScenarioFile`, also used by `run-scenarios.mjs`. The small CI
entry binds its existing `rigBin`, daemon lifecycle and results-ledger seams.
No second scenario engine or synthetic CLI replaces the product.

## What must pass

1. **Healthy:** real stub topology launch, queue creation/claim, daemon restart,
   the same in-progress baton visible through the shipped CLI, then rig teardown.
2. **Lost-baton control:** the same scenario and assertions. After the pre-restart
   assertion and a confirmed daemon stop, the test changes exactly one scratch DB
   row from `in-progress` to `pending`. The unchanged post-restart assertion must
   fail (step 3). The raw container exits 1; the CI wrapper accepts only that
   specific failure, with the injection receipt and runner ledger. The actual
   post-restart queue observation must contain `baton-1`, addressed to
   `dev-worker@scn-baton`, in `pending` state; words in the diff do not qualify.
   Startup errors, timeouts, other failures, or a surviving fault fail the job.
3. **Healthy again:** another fresh container with fault injection disabled must
   pass the same scenario. All three logs are retained separately.

This protects installed-package startup and **daemon-owned queue durability**.
It does not prove native provider sessions, seat resume, restored context,
transactional handoff closure or compatibility on every platform. The injected
fault is a storage-state reset, not a replay of a specific production bug.

## Isolation and evidence

Use `bash scripts/run-pr-scenarios.sh` on a disposable GitHub Linux runner after
`npm ci`, or select a prepared remote executor as below. Runtime is inside unprivileged,
network-disabled containers, with no host mounts, a read-only root, private
writable `/tmp`, dropped capabilities and bounded memory/processes/time. Image
construction uses network to retrieve the pinned base, Node and dependencies;
runtime has no external route. No credentials or provider CLIs are supplied.

The CI layer bundles the existing TypeScript helpers with the lockfile's esbuild;
it needs no development install inside the runtime container. Fixture files travel
unchanged. Logs, the bundle input map, build manifest and image identity are saved
as `installed-scenario-evidence`, including on failure. The raw result records the
scenario SHA256, verdict, failing step/diff, structured last observation and
injection receipt. The pure `scripts/pr-scenarios.test.mjs` controls validate result
admission only; they are
**not** a substitute for the three actual container runs.

## Library scenario increment

The same job also runs `../scenarios/queue-baton-survives-restart.yaml` in three
fresh containers: healthy, `baton-drop`, healthy again. It brings up the library's
two-seat stub rig and asserts the exact `dev-qa@dev-pair-stub` claim after restart.
The original fixture and its three controls remain unchanged.

`seed_regression` now calls an explicit fault controller supplied through the
pipeline. With no controller it still fails loudly. The library baton declares
its seed **before** restart, not after the assertions; the controller records the
healthy control or arms the stopped-DB mutation. Unknown classes, a missing seed,
an injection failure, a surviving fault, or an unrelated failing observation fail
the job. Assertions continue to use the shipped queue read, never a fake observer.

## Stub-script scenarios, passing form

The same job then runs `../scenarios/transcript-reads-addressed-seat.yaml` and
`../scenarios/capture-returns-addressed-seat.yaml` once each, healthy only, in their own
fresh containers. Each brings up a two-seat stub rig whose seats print their own token from
an `env.stub_scripts` script, and reads it back through the shipped `rig transcript` or
`rig capture`. `verifyPassingRun` in `result.mjs` accepts only a clean PASS of the named
scenario: one ledger record matching the result, the scenario SHA256, exit 0, and no error,
seed or fault.

Their planted failures are product-code mutations (the transcript response dropping its
content, and capture resolving a seat by member-name prefix). The read-only installed image
can't carry them, so they stay per-PR evidence outside CI. A green run here shows the
passing leg only.

The existing `daemon-restart` case also connects the installed `rig mcp serve` over
stdio, using its shipped SDK. It checks whoami with a configured stub seat and with
none, queue create/show attribution, the missing-item daemon code in structured
content, and the four server instruction lines. The captured MCP results and direct
daemon error readback are in the case report. Both MCP children close before teardown;
this adds no container, YAML verb, provider client or model call.

The other library scenarios are **unadmitted**. Several need step-time `emit`,
`policy`, `mutate`, or `restore`. Others have incomplete assertions or setup:
clean-lifecycle has no post-down residue assertion, ps-scope neither brings up its
second topology nor excludes extra rows, and the home/preseed and send/render
scenarios need input behavior from the stub. `kill-daemon-mid-handoff` still has
its documented setup/observable gaps. A callback binding does not fix these gaps.
Do not count this increment as eleven passing scenarios or native seat-resume
coverage. Container evidence for each selected case is required for admission.

The existing CLI `run-scenarios.mjs` still accepts paths only; `--container` is
refused. This job runs the helper *inside* the isolated image, so it does not depend
on the host-to-container staging adapter's unsupported per-seat-script path.

## Run one case before pushing

Any developer or agent can use the same script with a prepared SSH Docker executor;
there is no seat-owner or per-run approval requirement. Use a private checkout with
the normal Node 22/24 development dependencies. Source build/pack runs on the client;
Docker image construction and the scenario run at the selected daemon.

```sh
DOCKER_HOST=ssh://your-test-executor bash scripts/run-pr-scenarios.sh \
  --remote --case library --mode healthy --out dist/scenario-check
```

Leave `DOCKER_CONTEXT` unset when selecting `DOCKER_HOST`, so a saved context cannot
override the explicitly selected executor. This does not change Docker configuration.
Use a fresh output directory for each retained run. Without `--mode` the selected
seeded case runs healthy / lost-baton / healthy. Without `--case` all nine cases run,
fifteen container runs by default: the `fixture` and `library` seeded pairs (healthy /
lost-baton / healthy each), the `refocus-parked` seeded pair (healthy / seeded /
healthy), and the six passing-only cases (healthy once each). A single healthy run
establishes only that leg; it is not the paired seeded-regression proof.

The client can be macOS/arm64 while Docker is Linux/amd64: the build reads the
**server** OS/architecture and passes the same platform to the image builds and
containers. The Node deadline helper replaces GNU `timeout`, preserves the real
exit status, returns 124 on deadline and escalates TERM to KILL after 15 seconds.
All daemon work remains in the container. No local OpenRig daemon is touched.

Build contexts are uploaded by Docker, not mounted from the client. Logs, actual
exit-code files, container names/inspection, server platform, image identity and
manifests are written in the client's `--out` directory. The image-load check still
runs once before the selected scenario to detect a broken package/native install.
It has a 120-second deadline, a recorded unique container name, actual exit/log
and inspection receipts, and bounded named cleanup even on failure or timeout.
Scenario runtime is 2 CPUs, 2GiB memory with no swap, 256 PIDs, network-none, non-root
and a read-only root plus scratch tmpfs. A rootless executor must enforce its
configured cgroup limits; its aggregate budget is an executor setting, not a
claim made by successful source checks.

The script removes only its named containers. If SSH becomes unavailable, it
reports incomplete cleanup with the exact name for later reconciliation; no remote
cleanup can be guaranteed through a broken connection. It never prunes shared
images or other agents' containers.

## Refocus context regression controls

`refocus-parked` runs the real typed blocked-row setup, daemon `queue whoami`, shipped refocus hook and trace. The `hook_context` observation carries the hook's exact raw JSON stdout and its parsed `additionalContext`; pane text is not evidence. The emit step switches the work packet on (`packet: true`), so the healthy context must show the row under `HELD WORK (blocked; this is not next)` with its blocker, and never the slice as current work. The same fresh scenario runs healthy, seeded, healthy. Its fault substitutes a scratch Python launcher for this hook's trace child, verifies the packet carried exactly that one real held row, then moves it into the candidates as the seat's current work and runs the real trace. The hook's own emitted context must then fail step4, rendering the held row's slice as `WORK FROM QUEUE EVIDENCE`. An unrelated timeout/action failure or mere exit1 is rejected. `refocus-parked-off` is the packet-off control (`packet: false`): the same parked row keeps today's labelled root fallback. `refocus-active` claims the equivalent typed row and requires that work node's intent with no fallback. The emitter gives the hook its selectable 20 s budget, since these scenarios assert content, not latency.

These are controlled hook invocations against the actual scenario daemon, not native Claude/Codex hook scheduling or agent consumption. Fixtures and fault launchers stay under the scenario scaffold; installed hooks are unchanged. The pre-existing queue-durability and passing-only cases are retained.

Managed-compaction coverage uses `managed-compaction-effect.test.ts` in ordinary daemon CI instead: the shipped compact route deliberately refuses `runtime:stub`, and the precompact seam exposes a keyed marker rather than a daemon stream event. The bounded helper fallback drives the real enforcer's command through a stub input model (recorded Claude2.1.282 success792/paste850-851) into the real precompact hook. Healthy and851-character seeded controls assert marker presence/absence, rather than a submit receipt or pane token. This is not native compaction or an installed `rig compact` journey. No runtime filter or ordinary-send behavior changes.

The `daemon-restart` case exercises team-only recovery without the inherited
`TMUX`/`TMUX_TMPDIR` or the scaffold's forced-socket wrapper. It requires recorded
process evidence before the first blind restart; then it waits for the actual
normal poll to persist fresh `tmux_unavailable` verdicts with null current PID
fields, and performs a second blind restart. Original sessions, running status,
bindings and private panes/PIDs must survive both restarts without default-socket
duplicates or supersession. It then restarts with the correct environment and
sends a unique marker, captured in the addressed seat's pane (rendered delivery,
not agent consumption).

Immediately before the existing `down` action, a gone-process control rechecks
one private pane's identity, closes only that fixture pane, independently proves
its shell, children and recorded seat PIDs gone, and blindly restarts again.
The dead seat must detach or restore
with a different live process, while the untouched peer remains unchanged. A
correct-environment restart then permits the ordinary cleanup. Each partial DB,
pane and poll observation, and any failed stage, remains in the report; an
unreadable socket is never an empty census. **Kernel duplication and native
runtime behavior are not exercised.** The same helper is applied to the release
cut and the published comparator archive, preserving each one's actual outcome.


## Pane attention and quoted prompt text

`prompt-state` runs one private scenario daemon with two adopted, scripted panes
whose declared runtimes are Codex and Claude. The pane is 45 rows tall; the first
quoted working frame must leave at least 20 blank rows below its composer, with
the full pre-send screen retained. This covers inline redraws in tall panes.
No native provider runs and neither
fixture emits an activity hook. Adoption/runtime/readiness must succeed before
assertions; the scratch event store is read-only when counting hook events.

The selector-only pane must report needs-input consistently in the node API,
rig attention count, human table and compact JSON. A subsequent working frame
must clear attention. The Claude fixture then draws quoted selector/permission
history above its current empty composer and running timer: unique sends and
actual parked-row timer wakes must reach its pane. A real waiting dialog must
refuse a send and an attempted wake without either marker being typed.

The report retains each served value, delivered nonce, wake transition, matching
watchdog refusal attempt and current pane, including the stage if incomplete. Product state is never set through a DB
write or a mocked observation. These are controlled pane layouts and OpenRig's
coordination path, not native prompt-layout or model behavior evidence. Historical
fail-before arms are author evidence: #1946 against32633a3d-era installed bytes,
and #1955 againstdb863940's parent, with named product assertion failures. Setup,
missing wake attempts, unrelated errors and setup timeouts do not count as RED.
A labelled product-assertion timeout retaining the served values (the #1946
attention disagreement) counts as RED after successful adoption/readiness.
