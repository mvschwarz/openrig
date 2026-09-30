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
`npm ci`. It refuses ordinary local invocation. Runtime is inside unprivileged,
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
