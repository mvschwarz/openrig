---
name: openrig-user-settings
description: Use when the user asks an OpenRig agent to read or change OpenRig configuration settings — workspace paths, file allowlists, progress scan roots, daemon port/host, transcripts, or anything stored in ~/.openrig/config.json
---

# OpenRig User Settings

OpenRig settings live in `~/.openrig/config.json` and are managed via the
`rig config` CLI family. The agent-editable surface is **CLI shell-out**;
do NOT write the JSON file directly unless the operator specifically asks
for raw-text editing (which is handled by the UI Files browser, not by you).

## Read

```bash
rig config                                # all keys, value + source
rig config --json                         # JSON: full RiggedConfig
rig config --json --with-source           # JSON: {key: {value, source, default}}
rig config get <key>                      # single value
rig config get <key> --show-source        # value + source on one line
rig config get <key> --json               # {value, source, default}
```

Resolution order: **env var > config file > default**. Always use
`--show-source` (or `--json`) when reporting back to the operator so they
see *where* the value came from.

## Write

```bash
rig config set <key> <value>              # set a key
rig config reset <key>                    # clear one override (revert to default)
rig config reset                          # delete the whole file
```

## Initialize a default workspace

```bash
rig config init-workspace                 # scaffold ~/.openrig/workspace/ with missions + slices
rig config init-workspace --dry-run       # show what would be created
rig config init-workspace --root /path    # use a custom root
rig config init-workspace --force         # overwrite scaffolded files (NOT operator content)
```

This creates a file-backed Project workspace under the workspace root:

```text
README.md
STEERING.md
missions/<mission-id>/README.md
missions/<mission-id>/PROGRESS.md
missions/<mission-id>/slices/<slice-id>/README.md
progress/
field-notes/
specs/
```

It seeds two starter missions with multiple slices so the Project UI has a
real mission/slice map out of the box. It is operator-explicit; do NOT run it
on your own initiative unless the operator asks for workspace initialization
or repair.

## Common keys

| Key | Type | Purpose |
|---|---|---|
| `daemon.port` | number | OpenRig daemon HTTP port (default 7433) |
| `daemon.host` | string | Daemon bind host (default 127.0.0.1) |
| `db.path` | string | SQLite DB path (default ~/.openrig/openrig.sqlite) |
| `transcripts.enabled` | boolean | Whether the daemon writes transcripts |
| `transcripts.path` | string | Transcripts dir (default ~/.openrig/transcripts) |
| `workspace.root` | string | Single-root override (default ~/.openrig/workspace) |
| `workspace.slices_root` | string | Slice discovery root; default `<root>/missions` |
| `workspace.steering_path` | string | STEERING.md path; default `<root>/STEERING.md` |
| `workspace.field_notes_root` | string | Field notes dir; default `<root>/field-notes` |
| `workspace.specs_root` | string | Specs dir; default `<root>/specs` |
| `files.allowlist` | string | `name:/abs/path,name:/abs/path` — UI Files browser roots |
| `progress.scan_roots` | string | `name:/abs/path,name:/abs/path` — Progress browse roots |

Resolution order for workspace per-subdir keys: per-subdir override >
`workspace.root` cascade > built-in default.

## Common operator requests → canonical commands

> **"Make the UI work against an existing workspace layout"**:
> set the per-subdir workspace overrides explicitly:
>
> ```bash
> rig config set workspace.slices_root /path/to/your/workspace/missions
> rig config set workspace.steering_path /path/to/your/workspace/STEERING.md
> rig config set workspace.progress_scan_roots 'work:/path/to/your/workspace,missions:/path/to/your/workspace/missions'
> rig config set workspace.field_notes_root /path/to/your/workspace/field-notes
> ```
>
> No restart needed for the CLI; for the daemon's reads to pick up
> changes affecting startup-time wiring (`files.allowlist`,
> `progress.scan_roots`), restart with `rig daemon restart`.

> **"Initialize a default workspace"**:
>
> ```bash
> rig config init-workspace
> ```

After initialization, the Project UI expects this mapping:

- `workspace.root` maps to the Project workspace.
- `workspace.root/missions/<mission-id>` maps to a Project mission.
- `workspace.root/missions/<mission-id>/slices/<slice-id>` maps to a Project slice.

Queue item bodies or tags should mention the mission id and slice id when the
work belongs to a slice. That lets the Project Story, Queue, Tests, and
Topology tabs attach runtime work to the filesystem slice.

> **"Allow the file browser to see X directory"**:
>
> ```bash
> # Append to existing list (operator decides the name token):
> rig config get files.allowlist --show-source       # check current
> rig config set files.allowlist 'workspace:/path/to/ws,docs:/path/to/docs'
> rig daemon restart                                # picks up new roots
> ```

> **"What's my current setting for X and where does it come from?"**:
>
> ```bash
> rig config get <key> --show-source
> ```

## When NOT to use this skill

- **Per-rig config** — settings are host-global at v0; per-rig is v0+1.
- **Secrets / credentials** — the `vault.specialist` managed-app handles
  secrets. Don't put API keys or tokens in `~/.openrig/config.json`.
- **Settings sync across hosts** — out of scope at v0.

## Errors you might see

- `Unknown config key "<x>". Valid keys: …` — the key name is wrong.
  Check the table above; suggest the correct key.
- `Config file at <path> is malformed. Fix the JSON or reset with: rig config reset` —
  hand-edit broke the JSON. Operator can `rig config reset` (deletes the
  whole file) or fix the syntax in the Files browser.
- `Invalid value for <key>: expected a number/true-false, got "<x>"` —
  wrong type for a typed key. Reach for the key's type in the table.

## Provenance + safety

- Never write to `~/.openrig/config.json` directly. Use `rig config set`.
- Don't run `rig config init-workspace` on your own initiative — wait for
  an operator request.
- Always cite the resolved source (env / file / default) when reporting
  values back, so the operator knows whether their change actually took.
