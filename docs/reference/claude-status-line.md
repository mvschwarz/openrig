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

## Claude usage-limit detection

The status line supplies subscription usage windows and their reset timestamps.
OpenRig also registers Claude's [`StopFailure` hook](https://code.claude.com/docs/en/hooks#stopfailure),
available since Claude Code 2.1.78. Its exact `error: "rate_limit"` value reports a
provider interruption even when no status line window is available. This path
requires the updated OpenRig hook configuration and the current seat's runtime
and occupant generation. Unknown identity or an expired event cannot trigger a
usage-limit pause; a later hook supersedes the event, which expires after five
minutes in any case.

The event carries no usage percentage, account identity or reset timestamp.
It marks the Claude provider pool as limited and preserves a current
`agentActivity.reason` of `usage_limit` over a cached idle reading. It does not
count as a request for human input; a newer permission prompt still takes
precedence in the seat's activity display. Conflicting seat windows retain the
existing `explicit_unknown` host diagnosis.

Pending work handled by the wake ladder uses the existing local Claude pool
(the one-account-per-host assumption). An exhausted status line window with a
known reset supplies the timer. Otherwise a typed failure uses
`queue.wake_retry_interval_seconds` (default 300) from the event time, plus the
existing wake jitter, and records `config-fallback`. That is a retry time, not a
claim that the provider's quota will reset then. The timer releases the shared
blocker once and retains the existing durable wake delivery behavior.

Authentication, billing and overloaded errors are not classified as usage
limits. Claude limit banners are not scraped, and older runtimes or failures
that do not emit this hook still depend on status line data. Without either
source, provider usage remains unknown.
