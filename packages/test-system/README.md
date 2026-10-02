# Integration scenarios

The first PR automation increment is described in [ci/README.md](ci/README.md).
It runs the existing daemon-restart baton fixture plus a fault control in the
installed-package testbed, now alongside the library's queue-baton scenario and
its explicit seed binding. Hosted green/red execution is required before claiming
either verified. The eleven authored scenarios below are a broader target;
they are not eleven admitted CI passes.

## Historical 51-03 seed contract — the ten (+ one)

Compose-only L2 scenario set for the OpenRig containerized test system (mission
release-0.5.1). Each scenario pins a NAMED defect class from the 0.4.8/0.5.0 marathon
and becomes standing infrastructure instead of a hand-built probe.

## Authoring authority (verified at authoring time)
- 51-03 spec: README `99f35af5c2d854a7` / PRD `aa0638f161cc3b82` (hash-verified).
- **Format is the LOCKED 51-02 spec** (README `b157f5bc68940963` / PRD `1bf3340188e39212`)
  and the BINDING arch shape `ARCH-SHAPE-scenario-format-and-runner` sha256
  `fc30a736c104863a…`. The daemon-lifecycle step verb for #11 is arch-ruled in
  `ARCH-RULING-51-09-host-identity-and-51-02-step-verb` (`daemon: {op: sigterm|restart}`
  on the shared env-helper's lifecycle surface).
- `emit.behavior` vocabulary = 51-01's LOCKED FOUR {compaction, slow_output,
  mid_turn_death, restore}. `usage_limit` is real-runtime-only and MUST fail validation
  loud in a stub topology — no scenario here names it.
- Assertions ride the shipped-observable surface set ONLY: `ps` · `queue` · `stream` ·
  `scope` · `pane` · `transcript` · `tui_socket` · `policy_provenance`. `proof` is
  reserved: it has no read verb, and the validator rejects it. No internal DB pokes.

## Layout
- `scenarios/` — the eleven scenarios (§6 ten + the A1 eleventh), one YAML file each,
  the scenario name naming its defect class. Beside them: the topology rig specs they
  bring up (`*-stub.yaml`, seats `runtime: stub`) and the `agents/` and `culture.md`
  those specs reference.
- `scripts/` — holds no scripts yet. A scenario names per-seat stub scripts with
  `env.stub_scripts` (paths relative to the scenario file); the built-in default script
  applies when a scenario names none.
- `ROUTING.md` — the runner, stub and format capabilities this set depends on, and which
  of them have landed. Per 51-03 mini-req 2 these are ROUTED, never shimmed here.

## The seed contract (per-scenario, binding — kills the unfalsifiable-RED risk)
Every scenario carries a `seed_regression: {class: …}` step and, in its header, a
**SEED definition**: exactly what a seeded regression of its class plants, and why the
scenario's `expect` legs MUST catch it. Acceptance per scenario = the PAIR: GREEN on the
shipped tip + RED on the seeded run whose runner diff (expected vs last-observed) names
the class. A scenario that cannot be shown RED is not delivered.

For executable seeds, place the step before the affected action and supply the
pipeline's `deps.seedRegression` controller. It must arm a real local fault in the
seeded run and explicitly record that fault as disabled in the healthy run. The
paired harness verifies the injection receipt and the specific failed observation.
The remaining historical markers after their assertions are not executable proofs.

## Run status honesty
The runner (`packages/daemon/scripts/run-scenarios.mjs`, over
`packages/daemon/test/helpers/scenario-*.ts`) and its hermetic env-helper exist. The stub
runs the four emit behaviors only from a per-seat launch script (`env.stub_scripts`); the
step verbs `emit`, `restore`, `mutate` and `policy` parse, but the runner throws
`UnboundActionError` when it reaches one. Only `queue-baton-survives-restart` runs in CI
(see [ci/README.md](ci/README.md)); the other ten are not yet runnable as meaningful
checks. Scenario #11 is RED-FIRST: its GREEN gates on the 51-06 transactional
execution-closure fix and on its own setup and assertion-shape gaps (R-17, R-20); until
then its expected-RED runs are recorded as expected-RED, never massaged. See `ROUTING.md`
for the exact per-item dependencies.
