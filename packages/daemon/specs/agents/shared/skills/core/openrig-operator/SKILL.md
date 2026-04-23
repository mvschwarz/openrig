---
name: openrig-operator
description: Use when operating or debugging host-side OpenRig runtime issues including daemon reachability, partial identity, unified-exec warnings, stale helper-process cleanup, or when distinguishing harness/process issues from live topology health.
---

# OpenRig Operator

## Overview

This skill covers host/runtime/operator triage around OpenRig itself.
Use it when the problem may be the daemon, the shell/runtime surface, or stale helper processes rather than the product workflow you are trying to run.

## When to Use

Use this skill when you see:
- `rig whoami --json` returning partial identity
- `rig ps --nodes --json` failing while some other `rig` commands still work
- `Sent to ...` plus `Verified: no`
- repeated unified-exec-process warnings
- suspicion that stale helper processes are accumulating

Do not use this skill for normal product workflow routing, queue handling, or ordinary peer communication. Use `openrig-user` for that.

## First Checks

Start with the minimum truthful operator read:

```bash
rig whoami --json
rig daemon status
rig ps --nodes --json
```

Interpret them together, not in isolation:
- partial `whoami` can mean identity is inferable while daemon-backed surfaces are degraded
- `daemon status` tells you whether the host daemon is up, not whether every seat can reach it cleanly
- `ps --nodes --json` is the best machine-readable topology check when it works

## Verification Drift Vs Send Failure

For `rig send`:
- `Sent to ...` + `Verified: yes` = strong positive delivery evidence
- `Sent to ...` + `Verified: no` = ambiguous delivery, not automatic failure
- no `Sent to ...` line or a hard error = send failure

When verification is ambiguous, check:
- direct reply
- `rig capture <session>`
- transcript evidence
- queue/outbox state if the message asked for a durable handoff

Do not blindly retry until you have checked one of those.

## Unified Exec Warning

If you see:

- `Warning: The maximum number of unified exec processes you can keep open is 60 ...`

treat it first as a host/tooling-layer warning, not as automatic proof that the OpenRig topology is unhealthy.

This warning can coexist with a healthy live topology.

## Safe Process Triage

Inspect the process surface first:

```bash
ps -axo pid,ppid,command | rg 'tmux send-keys|rig queue create|tmux attach|codex|claude'
```

Think in layers:
- host/tooling layer: stale one-shot wrappers, session bookkeeping, helper shells
- topology layer: live `tmux attach` seats, live `codex` / `claude` runtimes, daemon health

Do not diagnose topology failure from tooling-layer warnings alone.

## Safe Cleanup Boundary

Usually safe to reap when clearly orphaned / one-shot:
- `tmux send-keys ...`
- short-lived shell wrappers created only to enqueue or send one message

Do not mass-kill:
- `tmux attach ...`
- `codex ...`
- `claude ...`
- other long-lived daemon/runtime processes

The point is to remove garbage, not workers.

## Common Mistakes

- treating `Verified: no` as if it proves the message did not land
- treating the unified-exec warning as if it proves the rig is overloaded
- killing live seats when only stale helper wrappers needed cleanup
- concluding "daemon down" from one seat's failure without checking host-level daemon status

## Practical Rule

Clean the smallest safe surface that matches the evidence.

If the warning or failure remains after stale-wrapper cleanup, re-check:

```bash
rig daemon status
rig ps --nodes --json
```

If those remain healthy, the residual issue may still be in the host/tool/session layer rather than in OpenRig topology state.
