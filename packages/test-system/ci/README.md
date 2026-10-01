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

The other ten library scenarios are **unadmitted**. Several need step-time `emit`,
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
case runs healthy / lost-baton / healthy. Without `--case` both cases run. CI keeps
its existing six-run default. A single healthy run establishes only that leg; it is
not the paired seeded-regression proof.

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
