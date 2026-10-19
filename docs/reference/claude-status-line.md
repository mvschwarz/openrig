# Custom Claude status line

OpenRig installs a silent context collector as `statusLine.command` in the seat
working directory's `.claude/settings.local.json`. Claude's project-local setting
overrides your user-level status line, so a renderer configured only in
`~/.claude/settings.json` can disappear in that directory. Other Claude sessions
using the same directory also read that setting.

Since 0.6.5, OpenRig preserves a custom, nonempty project-local status line command,
including a wrapper or a command composed with shell operators. It still refreshes
its own collector script. If your command does not run the collector, context and
provider usage stop updating, and Claude resume-token capture at adoption or
handover loses its current session evidence. An earlier sidecar can remain and
contain an older session ID; without one, context and capture report
`missing_sidecar`, and provider usage reports `no_statusline_cache_yet` unless an
earlier cache remains.

## Feed both commands the same input

On macOS, Linux or WSL2, save a wrapper such as this, replacing the three
placeholder paths and `my-statusline` with your actual commands:

```sh
#!/bin/sh
input=$(cat)
printf '%s' "$input" |
  node '/seat/cwd/.openrig/context-collector.cjs' \
    '/instance/home/state/context-usage' \
    '/instance/home/state/provider-usage' >/dev/null 2>&1
printf '%s' "$input" | my-statusline
```

Take the collector path and both directory arguments from the existing generated
`statusLine.command` in that seat's `.claude/settings.local.json`; the instance
home is the selected `OPENRIG_HOME`. Keep paths quoted, including paths with
spaces. Each command needs the same status line JSON on stdin: simply running
the collector and renderer in sequence against a single stdin lets the first
consume the input.

In that same settings file, merge this field while preserving your other settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh '/absolute/path/to/openrig-status-line.sh'"
  }
}
```

Use the renderer command from your user-level configuration in the wrapper. The
collector stays silent and the renderer supplies the visible status line. This
POSIX-shell example applies to WSL2's Linux installation; it does not establish
native Windows support.

## Check after an upgrade or instance change

The collector command's paths and arguments are implementation details. OpenRig
preserves your wrapper, so it cannot refresh those arguments for you. Recheck
them after an upgrade, a seat-directory move or an `OPENRIG_HOME` change.

After Claude next updates its status line, inspect context usage in `rig ps` or
`rig whoami --full` from the seat. Unknown or stale context is a reason to check
the wrapper; it does not prove the collector is running. For a direct check,
inspect the current session's JSON under the configured `state/context-usage`
directory: its timestamp should advance and its `session_id` should match the
current Claude session. A visible custom status line alone does not verify
collection or end-to-end adoption/handover recovery. The wrapper above suppresses
collector errors; remove its stderr redirection temporarily when diagnosing it.
