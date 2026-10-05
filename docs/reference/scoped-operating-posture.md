# Scoped operating posture

Human-led work is quiet by default for process-only diagnosis. Delegated work can
receive oversight during planning as well as implementation. This preference does
not grant execution authority or change permissions, work phase, workflow reminders,
context/continuity health, or health policy.

## Inspect and choose

Use the existing `rig mode` surface. Give an exact rig or authored work scope:

```sh
rig mode effective --rig my-rig --json
rig mode effective --project my-project --mission release-1 --json
rig mode effective --qitem my-packet --json
rig mode set delegated --scope mission --qualifier my-project/release-1 --evidence "Operator delegated this outcome"
# The proposal above exits 2 without writing. Apply the deliberate choice:
rig mode set delegated --scope mission --qualifier my-project/release-1 --evidence "Operator delegated this outcome" --confirm
rig mode set human-led --scope mission --qualifier my-project/release-1 --evidence "Return to interactive planning" --confirm
rig mode unset mission my-project/release-1
```

Unsetting reveals the next applicable explicit choice, or the visible human-led
product default. A new, resolved rig with no binding reports `human-led`,
`source: product-default`, and `binding: null`. Missing scope identity, conflicting
linkage or malformed authored context reports `unknown` with a reason. If the mode
store itself is unavailable, the route answers HTTP 503 `rig_policy_store_unavailable`
instead. Calling `effective` without a scope does not select a rig implicitly.
The existing operator bearer requirement still applies. `set` requires `--confirm`;
`unset` is an explicit deletion command and applies immediately.

## One scope and phase contract

`GET /api/rig-mode/effective` accepts `rig`, `project`, `mission`, `workstream`, and
`qitem`. Its additive `operatingPosture` object is also attached to health records
and diagnosis findings. CLI explanation and TUI health detail display the same data.
Consumers of posture, phase, and health should use this object rather than invent
another preference store or infer delegation from workflow existence or activity.

| Field | Meaning |
| --- | --- |
| `posture` | `human-led`, `delegated`, or `unknown` |
| `source` | `product-default`, `binding`, or `unknown` |
| `context` | Resolved rig/project/mission/workstream/qitem IDs, source addresses, canonical authored paths, phase and `warnings` (for example a malformed `rigs` list that project inference skipped); null if scope resolution failed |
| `context.phase` | `{value, source}` from an explicit workflow packet step, otherwise slice stage/status, otherwise mission release phase/status. A slice with neither gives `value: null` with its `SPEC.md` as the source; a mission with neither makes the whole read unknown; both fields are null only for rig- or project-only scopes |
| `binding` | Winning binding ID, scope, timestamp and evidence citation; null for default/unknown |
| `reason` | Explanation of the result or the missing/conflicting fact |
| `grantsAuthority` | Always `false` |
| `members` | For queue-backed findings, each member's qitem, posture, source and binding ID; differing or unknown member postures, or members in different project/mission/workstream contexts, yield unknown aggregate posture |

The existing SQLite mode-binding table remains the only preference store. Matching
posture bindings resolve in this order: qitem, workstream, mission, project, rig,
global host. The qualifiers are respectively a qitem ID, `project/mission/slice-id`,
`project/mission`, project ID, canonical rig ID, and null. Rig names resolve to IDs.
The workstream is an existing authored slice, found by its directory or SPEC ID;
the returned identity uses its SPEC ID and project/mission qualification.

Project selection reads the declared `projects: [{id, root}]` catalog at
`workspace.catalog_path` (default `workspace.yaml` in the workspace root), the
same catalog `rig context work-install` uses, or the workspace's own
`project.yaml` when no catalog exists. A sole project may be derived. With several
projects and no explicit selection, posture picks one the way `rig context work-install`
does: a project whose `projects[].rigs` lists the rig, then (for qitem reads) the deepest
project root containing the destination seat's working folder, then the only project no rig
claims. The method is recorded in the source as `#selected-by=rig:<name>`, `cwd:<path>` or
`unclaimed`. If none gives a single answer, the read is unknown.
The project manifest validates identity and supplies `missions.root` (default
`missions`). Mission and slice identities come from those authored work nodes;
missing, duplicate or conflicting identities remain unknown. The selected work
must stay inside its canonical project root.

Qitem reads join explicit `project:`, `mission:`, `slice:`/`workstream:` tags,
destination rig, and the existing workflow packet binding. A qitem with a mission but no
project gets its project from the selection above. Workflow lifecycle
project/mission identity must agree with the tags and requested scope. The bound
packet's exact step is the phase source; phase names are not classified by guess.
An unlinked qitem does not silently inherit the default. Scope reads are observational.

Legacy ergonomic modes (`sleep`, `desk`, `mobile`, `away`, `focus`, `debug`) retain
their bindings and ten-field records. They do not imply either operating posture.
Only human-led/delegated bindings participate in posture precedence. The legacy
`effective` and `posture: known|unknown_posture` fields remain for compatibility;
`unknown_posture` there means no legacy mode binding and does not override the
new `operatingPosture.source: product-default` result. Setting another mode at the
same scope replaces that row; inspect effective posture after any mode change.

## Diagnosis effects

Process-category findings remain visible under human-led or unknown posture, but
new diagnosis presentations, re-presentations and human notifications require
explicit delegated posture. Retained occurrences are not canceled or rewritten
when posture changes. Their current finding is refreshed for inspection and
notification; unavailable current findings cannot reuse old delegated posture.
Notification admission is rechecked after readiness I/O.

Delegation is necessary for process interruptions and is insufficient by itself:
enabled diagnosis policy, detector selection, source freshness, custody, cooldown,
recurrence limits and human delivery readiness still apply. Other health categories
and ordinary queue/workflow reminders retain their existing behavior. The automatic
ceremony source reads declared catalog projects through the same resolver; unresolved
lineages remain visible with unknown scope instead of acquiring invented authority.

See [health diagnosis](health-diagnosis.md) for policy, evidence and disposition.
