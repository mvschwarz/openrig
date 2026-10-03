# Host load and transcript capture

Use `rig ps --resources` to inspect the serving host, or add `--host <id>`
for one registered HTTP/SSH host. `--json` returns the same measurements for
operators and monitoring tools. This view is host-scoped; rig/node filters and
multi-host fan-out do not apply. Ordinary `rig ps` output is unchanged.

The view reports available CPU count, host load averages (1/5/15 minutes),
load divided by CPU count, running seats, and transcript capture attempts,
failures, UTF8 bytes and elapsed capture time for currently rotating seats.
Load is not CPU utilization; capture elapsed time includes waiting for tmux,
and is not daemon CPU time. Load averages are unavailable on Windows, rather
than reported as zero. Counters reset when a rotation is restarted/stopped or
the daemon restarts, so they are observations rather than a durable billing log.

## Reduce idle capture cost

Transcript rotation still captures the bounded trailing buffer. When successive
captures are unchanged and tmux exposes an unchanged current-window activity
hint, capture backs off exponentially to a 6-second ceiling. One shared tmux
activity read wakes idle rotations; a changed hint restores the active cadence.
Missing/failed hints retain the configured full-capture cadence. A hint read
that takes longer than one second becomes unknown without starting additional
metadata probes while its underlying call is still pending. Periodic full
capture reconciles output even when a hint fails to change (tmux timestamps have
one-second resolution). Explicit active intervals above eight seconds retain
that interval instead of silently increasing capture frequency.

This does not change provider readiness, delivery guards, seat activity or queue
state. Capture activity is not proof an agent is healthy or finished. As before,
transcripts are bounded trailing snapshots, not lossless terminal archives: an
output burst larger than retained tmux scrollback or the configured line limit
can exceed the saved trail. Interactive terminal streaming is unchanged.

## Change capture settings without restarting

```bash
rig config set transcripts.poll_interval_seconds 3
rig config set transcripts.lines 2000
rig ps --resources
rig config reset transcripts.poll_interval_seconds
```

Running rotations reread shared settings at most once per second and adopt the
next valid policy without starting overlapping captures. Intervals accept whole
seconds from 1 to 3600; trailing lines accept integers from 1 to 1000000. The
existing environment variables take precedence over file settings. Malformed
intermediate JSON retains the last usable policy, is shown in the resource view,
and is retried; normal config
writes reject invalid values. Changing `transcripts.enabled` or
`transcripts.path` still requires a daemon restart. This feature does not impose
CPU quotas or allocate build slots.
