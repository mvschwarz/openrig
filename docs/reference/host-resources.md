# Host load and transcript capture

Use `rig ps --resources` to inspect the serving host, or add `--host <id>`
for one registered HTTP/SSH host. `--json` returns the same measurements for
operators and monitoring tools. This view is host-scoped; rig/node filters and
multi-host fan-out do not apply. Ordinary `rig ps` output is unchanged.

The view reports available CPU count, host load averages (1/5/15 minutes),
load divided by CPU count, running seats, the number of rotating seats and how
many of them are backed off, and transcript capture attempts, failures, UTF8
bytes and elapsed capture time for currently rotating seats.
Load is not CPU utilization; capture elapsed time includes waiting for tmux,
and is not daemon CPU time. Load averages are unavailable on Windows, rather
than reported as zero. Counters reset when a rotation is restarted/stopped or
the daemon restarts, so they are observations rather than a durable billing log.
When no seat is capturing, the active interval, idle ceiling and line count are
unavailable (`null` in JSON), not zero.

## Reduce idle capture cost

Transcript rotation still captures the bounded trailing buffer. When successive
captures are unchanged and tmux exposes an unchanged current-window activity
hint, capture backs off exponentially to a derived ceiling. With the default
2-second active interval and 1-second settings timer, the effective ceiling is
3 seconds: the 10-second freshness window minus the 1-second activity-hint
deadline, 5-second capture-result deadline and 1-second timer spacing. The
ceiling is capped at 6 seconds but never below the configured active interval.
This scheduling budget is not a CPU or child-process lifetime bound; the result
deadline does not cancel an unfinished capture. One shared tmux
activity read wakes idle rotations; a changed hint restores the active cadence.
Missing/failed hints retain the configured full-capture cadence. A hint read
that takes longer than one second becomes unknown without starting additional
metadata probes while its underlying call is still pending. Periodic full
capture reconciles output even when a hint fails to change (tmux timestamps have
one-second resolution). Longer configured active intervals retain that interval
instead of silently increasing capture frequency.

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


## Pace managed startup memory

One shared admission gate coordinates this daemon's managed starts and resumes,
including overlapping rig requests, staged successors and in-place restarts.
It admits one at a time by default. It preserves the selected conversation,
model, effort and dependency order; it does not evict healthy seats or choose a
fresh conversation to reduce memory. It does not coordinate other daemons,
users, manual native launches or memory on remote execution hosts. A local
proxy's admission is not protection for its remote guest's memory.

Readiness proves the runtime became interactive; it does not prove its memory
peak ended. Admission retains the slot for bounded pacing after readiness.
Linux observations use MemAvailable, readable cgroup v2 headroom and memory PSI
(pressure is high at some avg10 >= 10% or full avg10 >= 1%). macOS uses the
read-only memory_pressure -Q percentage and the kernel's memory-pressure level.
These are OS-specific observations, not equivalent guarantees of free capacity.
Samples older than five seconds are unavailable.

Set these environment variables on the daemon's next ordinary start; they do
not change a running daemon's policy:

| Variable | Default | Meaning |
| --- | --- | --- |
| OPENRIG_STARTUP_CONCURRENCY | 1 | Concurrent managed startup operations, integer 1-16. |
| OPENRIG_STARTUP_HEADROOM_PERCENT | 25 | Defer below this observed headroom percentage, integer 0-90. |
| OPENRIG_STARTUP_SETTLE_MS | 3000 | Pacing after the native operation returns, 0-60000 ms, capped by SETTLE_LIMIT_MS. |
| OPENRIG_STARTUP_SETTLE_LIMIT_MS | 15000 | Maximum settling time after native return, 0-120000 ms. |
| OPENRIG_STARTUP_STRICT_TELEMETRY | unset | Set to 1 to wait when memory observations are unavailable. |

The defaults are conservative pacing settings, not a promise that a particular
conversation fits a laptop. Missing, stale or unreadable observations normally
serialize starts, retain readiness and bounded pacing, and report that memory
protection is unavailable. Strict telemetry waiting is opt-in. Known pressure
or a real headroom deficit can defer dispatch even with other telemetry missing.
A one-seat deficit means no startup operation holds another slot: waiting for
another start to finish cannot by itself make that seat fit.

Inspect and control the original request without submitting another launch:

```bash
rig launch my-rig my-seat --startup-admission status --json
rig launch my-rig my-seat --startup-admission cancel --json
rig launch my-rig my-seat --startup-admission continue --json
```

The rig may be an ID or an unambiguous name; --host selects the destination
daemon. Cancel applies only before native dispatch or an incumbent stop. It
never kills a native child. Continue deliberately admits one queued request
despite its observed memory risk, once its concurrency slot is free; it cannot
repeat an unresolved launch. Admission facts also appear on node inventory,
node detail and node.startup_admission events. requestActive distinguishes a
live waiting request from retained historical status after a daemon restart.

A client timeout does not cancel server-side startup. Repeated matching requests
join its existing attempt while it remains owned. After a daemon restart,
reconcile an interrupted native attempt before retrying; a live or unknown
process is not permission to send another resume. A queued request that never
dispatched can be requested again through the original start command. Retained
ready evidence or proven native absence resolves interrupted custody. Failed
or unconfirmed starts remain visible rather than being retried automatically.
