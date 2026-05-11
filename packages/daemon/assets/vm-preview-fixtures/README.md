# VM Preview Fixtures

Sample data the Tart preview VM uses to populate the "populated" daemon with
a representative "lived-in" environment. See
`<substrate-shared-docs>/openrig-work/conventions/vm-preview/README.md` for the
operator workflow and the rationale behind the two-daemon model.

## Contents

- `workflows/` — workflow_spec YAML files. The operator copies these into the
  populated daemon's `<workspace.specs_root>/workflows/` directory; slice 11's
  folder-discovery scanner auto-discovers them on the next
  `GET /api/specs/library` call.

- `queue-items/` — placeholder for future qitem fixture content (TODO; slice
  follow-up will add).

- `rigs/` — placeholder for future rig-instance fixtures (TODO; slice
  follow-up will add). For v0, the operator manually instantiates a sample
  rig via `rig up product-team` against the populated daemon (see bootstrap
  script).

## Conventions

Fixture YAML files use the canonical placeholder paths per banked
`feedback_test_fixture_example_path_placeholder.md`:

- Username-bearing paths: `/Users/example/...` (never `wrandom` or other
  contributor usernames)
- Substrate-relative refs: `<substrate-shared-docs>/...`

## v0 scope

Slice 22 (release-0.3.1) ships the INFRASTRUCTURE for the two-daemon model:

- **Process-env pattern**: `OPENRIG_HOME=<dir> rig daemon start ...` — each
  `rig` invocation gets its own state directory at process import time.
  No CLI flag (an earlier attempt at `--openrig-home` was dropped because
  it only threaded into the spawned child, not the parent-side lifecycle
  bookkeeping; see substrate convention doc for the architecture note).
- Bootstrap script (`scripts/vm-bootstrap/two-daemon-start.sh`)
- This fixtures directory + a sample workflow YAML
- Convention doc in substrate

Authoring rich populated content (~13-node openrig-velocity rig + 20 qitems
+ getting-started mission narrative) is deferred to follow-up content slices
that have clearer ownership (slice 21 onboarding-conveyor will likely
contribute getting-started mission content).
