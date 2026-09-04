# OpenRig Instance Layout

An OpenRig instance keeps its managed state under one configured
`$OPENRIG_HOME`. `rig daemon start` and direct daemon first start reconcile the
same additive layout before the database is opened or the listener binds.

```text
$OPENRIG_HOME/
  config.json             # typed instance settings; created as an empty object
  state/                  # runtime-owned durable state
  context/                # addressable context library (`context.root`)
    system/
      system-world.yaml   # selected baseline context + skill identities
  skills/                 # managed skill catalog (`skills.root`)
  workspace/              # project work tree (`workspace.root`)
    SPEC.md                # project intent
    project.yaml           # project context and skill selection
    workspace.yaml         # project-location catalog
    .gitignore
    missions/
    exhaust/
  specs/                  # canonical instance spec library
  topology/               # instance, rig, pod, and seat continuity tree
  plugins/                # installed OpenRig plugins
  run/                    # process coordination files
  logs/                   # daemon and operation logs
  transcripts/            # durable per-seat terminal transcripts
  backups/                # operator-created recovery artifacts
  secrets/                # local connector and host secrets
```

The initializer creates only missing managed entries. It never overwrites an
existing file, and it checks every managed path before the first write. A path
with the wrong type is reported by its exact location; unrelated user-owned
content is preserved. A second run against an already-converged instance writes
nothing.

The workspace subtree is owned by the [Project Workspace
Contract](project-workspace.md). The instance initializer calls that owner
rather than carrying another copy of its file bytes. `skills/` and `topology/`
are created as empty roots; their respective catalog and topology workflows own
their contents.

## Context library setting

The addressable context library has one typed setting and one environment
override:

| Surface | Value |
| --- | --- |
| Config key | `context.root` |
| Environment | `OPENRIG_CONTEXT_ROOT` |
| Default | `$OPENRIG_HOME/context` |
| Resolved property | `contextRoot` |

The removed `context.packs_root`, `context.packsRoot`, and
`OPENRIG_CONTEXT_PACKS_ROOT` spellings are refused with guidance to use
`context.root`; they are not compatibility aliases. Bundle installation and
`rig context add` both resolve the same configured landing root.

## System World

The System World is the instance-wide baseline selected before topology/role
and Project World material. Its versioned manifest contains ordered context-pack
references plus managed skill identities; it never contains authoritative skill
bytes. The default manifest is installed additively at
`$OPENRIG_HOME/context/system/system-world.yaml`.

| Surface | Value |
| --- | --- |
| Config key | `context.system_world` |
| Environment | `OPENRIG_CONTEXT_SYSTEM_WORLD` |
| Default | `default` |
| Resolved property | `systemWorld` |

`default` selects the installed manifest, a safe relative or absolute path
selects an explicit replacement, and `disabled` is an explicit off state.
Missing or malformed selections fail; absence is never inferred as disablement.
`rig context work-install --json` reports the effective state, source, manifest,
context selectors, and skills. With `--runtime`, its managed skill loadout then
combines System World, topology, and Project World selectors with provenance.

For a pre-0.5.9 home, use the `openrig-upgrade` skill's
`migrate-telemetry-state-0.5.9.mjs` helper. Its order is plan → `--apply-state`
→ fresh Claude sample → `--verify` → `--apply-library`; `--rollback` restores
the preserved prior library, config, telemetry sources, and collector settings.
The helper must stop rather than claim success if writer/reader convergence or
any migration-owned path cannot be proved.

## Existing spec libraries

Creating `$OPENRIG_HOME/specs` does not migrate existing launch-era specs.
Upgraded installations may still have a separate legacy specs library that the
runtime reads for compatibility. Treat the two-home state as an explicit
limitation: use the live spec-library commands to determine where a spec is
served from, and do not infer convergence merely because the canonical
directory exists.
