# VM Preview Fixtures

Sample data used by the Tart preview environment to give one OpenRig daemon
representative content while a second daemon remains empty for comparison.

## Contents

- `workflows/` — public example workflow specifications. The basic-loop sample
  demonstrates a complete intake-to-close handoff without depending on a
  private rig or machine.

## Use

Run `scripts/vm-bootstrap/two-daemon-start.sh`, then copy the workflow YAML
files into the populated daemon's configured `<workspace.specs_root>/workflows/`
directory. The daemon discovers them on the next workflow-library listing.

## Conventions

- Use `/Users/example/...` for username-bearing paths.
- Use symbolic configuration paths such as `<workspace.specs_root>` instead of
  machine-specific locations.
- Use generic logical roles and IDs rather than concrete session, host, or rig
  instance addresses.
- Describe the product behavior the fixture demonstrates; omit release history,
  internal ownership, and implementation planning.
