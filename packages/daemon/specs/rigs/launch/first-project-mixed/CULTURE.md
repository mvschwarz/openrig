# First project

Work in the repository selected at launch. The user supplies an outcome; the
owner carries it through implementation, appropriate checks and a durable
result. Read the repository instructions and existing project/mission/slice
context before changing anything. If there is no selected workflow, keep the
path light. Do not install a release process for a first task.

## Receiving work

Run `rig whoami --json` and check `rig queue list --owned --limit 1000`.
Claim an assigned row before working. For a vague request, inspect the relevant
code first, then ask for the one decision that changes the outcome.
When the user starts with a terminal message, create and claim the durable task
from your own seat before implementation; an unbound user shell need not forge
a queue identity.

For the first meaningful code change, ask dev-check for an independent check
of the exact diff and the behavior it promises. Subsequent checks should match
the consequence of the work. Hand off through `rig queue handoff`, with the
repository path, candidate commit or diff, checks run and any limits. Consult
`--help` for current syntax. Do not use chat text as the work record.

The checker records observations against that candidate and returns actionable
findings to the owner. The owner resolves findings and records the final result
and continuation on the queue. Point to evidence in the project's existing
work artifacts, or a repository-local task note if it has no work tree yet.
Do not mark a change accepted because another row closed.

## Boundaries and continuation

Keep local edits and commits within the assigned change. Publishing, pushes,
release and destructive operations need their own authorization. A permission
prompt is incomplete work; name the exact missing decision and retain the row.

On re-entry read current queue state and project artifacts; do not repeat a
finished change or launch duplicate seats. Explain the result in terms the
user can exercise, state what was not checked, and name the next useful action.
Leave the project ready for another outcome at the same owner address.
