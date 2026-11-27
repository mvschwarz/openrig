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
earlier cache remains. A cache that exists but cannot be read reports
`claude_statusline_cache_unreadable`; a readable cache that carried no rate
limits reports `claude_statusline_cache_had_no_windows`.

## Feed both commands the same input

On macOS, Linux or WSL2, save a wrapper such as this, replacing the three
placeholder paths and `my-statusline` with your actual commands:

```sh
#!/bin/sh
input=$(cat)
printf '%s' "$input" |
  node '/instance/home/state/claude-context-collector/context-collector.cjs' \
    '/instance/home/state/context-usage' \
    '/instance/home/state/provider-usage' >/dev/null 2>&1
printf '%s' "$input" | my-statusline
```

Derive the collector path and both directory arguments from the selected instance home (`OPENRIG_HOME`), not
from that seat's `.claude/settings.local.json`: once a wrapper is installed, that file holds the wrapper command,
so the generated paths are no longer in it. The collector is
`<home>/state/claude-context-collector/context-collector.cjs`, the context directory
`<home>/state/context-usage`, and the provider directory `<home>/state/provider-usage`. The leading `exec` on the
generated command only lets the generated single command replace its shell, and a wrapper doesn't need it. Keep
paths quoted, including paths with spaces. Each command needs the same status line JSON on stdin: simply running
the collector and renderer in sequence against a single stdin lets the first
consume the input.

If you already have a wrapper, change its collector path to `<OpenRig home>/state/claude-context-collector/context-collector.cjs`.
The old call fails quietly, so the context reading stops updating and goes stale.

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

## A throttled seat

A seat with `statusline_throttle` (see the rig spec reference) keeps its throttled status line in its own launch
settings, not in `.claude/settings.local.json`, so the generated command in that file is the same as for any other seat.
A status line command of your own there, such as the wrapper above, wins over the throttle: the launch skips the
throttle and says so.

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

## Raw context and configured budget

Claude's raw percentage measures input tokens against the full model context
window. `rig ps --nodes` also shows a configured-budget percentage when the
collector sees `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as a plain integer from 100,000
to 1,000,000 tokens. The graph badge, its context ring, and seat context details
show the same sampled budget. For example, 150,000 input tokens in a 1M window
with a 200,000-token budget reads as 15% raw and 75% budget.

The budget is capped at the reported model window. It is a configured limit,
not an observed compaction trigger or countdown; OpenRig subtracts no fixed
reserve. OpenRig deliberately leaves other native settings, defaults, suffix
values such as `200k`, and out-of-range values unknown. Suffix support depends on
the Claude version; settings can change during a session. OpenRig does not
inspect native settings files to guess a limit. In particular, a budget set only
through `autoCompactWindow`, `/autocompact` or `--autocompact` remains unknown.
The CLI omits a budget footer when no budget is known; JSON and seat context
details retain the unknown state. See Claude's
[auto-compaction settings](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction).

The ratio uses current input, cache-read and cache-creation tokens, excluding
output. Missing, invalid or all-zero current usage leaves the ratio unknown,
including immediately after compaction. Budget data shares the raw sample's
freshness and session/occupant checks. Existing watchdog thresholds, filters,
health colors and compaction automation continue to use the raw percentage.
JSON exposes the additional value as `contextUsage.configuredBudget`, with
`tokens`, `usedPercentage` and `source`; older samples have no known budget.

## Claude usage-limit detection

The status line supplies subscription usage windows and their reset timestamps.
OpenRig also registers Claude's [`StopFailure` hook](https://code.claude.com/docs/en/hooks#stopfailure),
available since Claude Code 2.1.78. Its exact `error: "rate_limit"` value reports a
provider interruption even when no status line window is available. This path
requires the updated OpenRig hook configuration and the current seat's runtime
and occupant generation. Unknown identity or an expired event cannot trigger a
usage-limit pause; a hook with a newer source timestamp supersedes the event,
regardless of arrival order. The event expires after five minutes in any case.

The hook's other documented `error` values never pause work. Authentication and
billing failures raise attention with their own reason, and every other value reads
as a generic provider error; see the
[agent state taxonomy](agent-state-taxonomy.md#per-seat-attention-in-the-node-inventory).
The hooks reference says `cloud_credential_error` arrives under that name from Claude
Code 2.1.267, and an older Claude reports the same failure as `server_error` or `unknown`.

A helper Claude started from a seat's shell inherits that seat's environment,
so its rate-limit hook is attributed to that seat too. This is appropriate when
the helper uses the same login, since the quota belongs to the account. A
helper on a different login is attributed the same way, so its rate limit can
hold pending handoffs to every seat in that seat's Claude pool for one retry
interval, even when the seat's own login still has room. A reset time the
helper's message states is not used: OpenRig keeps a stated reset only when the
hook's Claude `session_id` is the seat's own resume token, so a helper never
holds the pool past that one interval.

The event carries no usage percentage or account identity. When the seat's own
Claude states when the limit resets (for example `resets Nov 10, 4pm
(America/Sao_Paulo)`, `resets in 2h 30m`, or the older `usage limit
reached|<epoch>`), the hook relay reads that time on the seat's machine and
forwards only the resulting timestamp (`resetsAt`), never the message text. It
reads the reset only after the typed `rate_limit` failure; the text never
decides that a seat is limited. A reset it can't read completely (an unknown or
truncated time zone, an unsupported unit, a date that doesn't exist such as Feb
30) or that is in the past or more than eight days away gives no reset. The
daemon applies the same eight-day bound to any sender.

The event marks the Claude provider pool as limited and preserves a current
`agentActivity.reason` of `usage_limit` over a cached idle reading. It does not
count as a request for human input; a newer permission prompt still takes
precedence in the seat's activity display. Conflicting seat windows retain the
existing `explicit_unknown` host diagnosis.

Pending work handled by the wake ladder uses the existing local Claude pool
(the one-account-per-host assumption), with separate pools for seats that
declare different Claude config directories. If reset windows conflict within
a proposed shared pool, only the seats reporting exhaustion are held; another
seat's pending handoffs can still retry. An exhausted status line window with
a known reset supplies the timer, and so does a reset the seat's own typed
failure stated (`provider-reset`). Otherwise a typed failure uses
`queue.wake_retry_interval_seconds` (default 300) from the event time, plus the
existing wake jitter, and records `config-fallback`. That is a retry time, not a
claim that the provider's quota will reset then. The timer releases the shared
blocker once and retains the existing durable wake delivery behavior.

A parked row's watchdog wake that a Claude seat refuses at its usage-limit
menu records `usage limit until <reset>` and retries at that stated reset,
when OpenRig holds the seat's own typed usage-limit report with a readable
reset. Otherwise, and for a Codex seat, the ordinary retry applies. The hold
is rechecked: a seat that recovers is retried sooner, and a changed or
unreadable report returns to the ordinary retry, so the wake can come before
the stated reset.

Authentication, billing and overloaded errors are not classified as usage
limits. Claude limit banners are not scraped from the terminal, and older
runtimes or failures that do not emit this hook still depend on status line
data. Without either
source, provider usage remains unknown.
