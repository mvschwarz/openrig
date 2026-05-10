---
name: openrig-operator
description: |
  Use when debugging host-side OpenRig runtime issues: daemon reachability, Codex permission or writable-root failures, command approval friction, rate limits/account switches, helper cleanup, or topology health confusion. NOT for ordinary CLI operation (use openrig-user) or for changing OpenRig itself (use openrig-builder).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Graduated 2026-05-04 from openrig-work/skills/workspace/from-product/openrig-operator/.
      Originally imported from openrig/packages/daemon/specs/agents/shared/skills/core/openrig-operator/
      (product built-in). Bootstrap skill — NPM install lands this in personal homes.
      Companion to openrig-user (daily CLI surface) — this skill is host-side troubleshooting.
    transfer_test: pending
    sibling_skills:
      - openrig-user
      - openrig-builder
      - openrig-architect
      - openrig-upgrade
      - forming-an-openrig-mental-model
      - ai-dev-workflows
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
- Codex seats hit `Operation not permitted`, command approval friction, or stale writable roots
- Codex seats report usage-limit/rate-limit or need a ChatGPT account switch

Do not use this skill for normal product workflow routing, queue handling, or ordinary peer communication. Use `openrig-user` for that.

Do not use this skill to decide how to change OpenRig behavior. Use `openrig-builder` for build
lane selection, feature lifecycle, doctrine rollout, and topology/build-system decisions.

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

## Terminal Node Escalation

Use a terminal node when evidence shows a seat-level sandbox/profile cannot perform required host work, but another approved operator surface can. This is an explicit operator lane, not a silent permission bypass.

Good fits:
- Codex/Claude seat cannot access Tart, SSH, tmux, queue directories, or host files needed for a proof
- a VM/test-proof or current-host-operator task needs real host capability
- another seat or terminal/sysadmin node has approved access and can return command evidence

Do not use this lane to bypass repo safety, dirty-worktree boundaries, review gates, or destructive-action approval. If the command would stop live rigs, delete data, reset git state, or mutate VM state beyond the accepted plan, require explicit authorization and record it.

Protocol:
1. Classify the original failure as seat/profile-specific if possible, not product failure.
2. Write or cite a packet with objective, lane, exact commands, cwd, expected outputs, stop conditions, and artifact path.
3. Route to an existing sysadmin/infrastructure/terminal node when available; otherwise provision a named terminal node through the topology/config layer instead of using a hidden ad hoc shell.
4. Terminal node runs only the packeted commands and returns command log, exit codes, cwd/env notes, and artifacts.
5. Original agent keeps task ownership and proof classification; terminal node supplies host capability.

Field lesson: if tester sees `Operation not permitted` for Tart/SSH while driver or another approved seat can reach the VM, treat it as permission/profile variance and route a terminal-node/operator remediation before changing product code.

## Codex Permission Policy

Use the `security-and-consequence-boundary-policy` skill for the security model.
OpenRig gates consequence boundaries, not ordinary work inside the intended boundary.

Treat Codex permissions as two independent layers:
- command approval rules decide which shell commands can run outside the sandbox
- filesystem writable roots decide which paths a `workspace-write` seat can mutate

Codex `auto_review`, `--full-auto`, and approval-bypass modes are not normal fleet defaults. They
can burn quota catastrophically and do not widen filesystem roots for an already-running seat. Full
access scope with `approvals_reviewer = "user"` is the intended Codex default here.

Claude Code auto permissions are different and are the preferred Claude default on this host when
the consequence-boundary rules still apply.

Current host policy:
- default profile is `fleet`
- `fleet` uses `sandbox_mode = "danger-full-access"`, `approval_policy = "on-request"`, `approvals_reviewer = "user"`
- top-level `[sandbox_workspace_write].writable_roots` intentionally includes `~/code` and tool dotdirs: `.codex`, `.claude`, `.openrig`, `.agents`, `.config`, `.cache`, `.local`, `.docker`, `.npm`, `.nvm`, `.pnpm-store`
- `permissions.fleet.filesystem` mirrors those writes and denies `.ssh`, `.gnupg`, and project env files
- `default.rules` broadly allows `rig` and `rigx`; `rigx` is fully permitted for now because it is the fast-moving config-layer overlay
- `default.rules` still prompts for destructive/publishing surfaces such as `rm`, `mv`, `chmod`, `git push`, PR mutation, `sudo`, process kills, daemon lifecycle, and destructive Docker/Brew/rig commands

## Codex Account / Usage-Limit Refresh

When Codex seats hit usage limits or need a ChatGPT/OpenAI account rotation, use the focused
`codex-seat-auth-refresh` skill instead of improvising.

Key reminder: host auth can switch while already-running Codex TUIs keep the old account. Refresh
only the scoped seats, preserve stable seat names, and record auth-seat registry rows sequentially.

Known failure modes this policy prevents:
- Codex seats assuming a task is impossible when the real issue is stale launch roots
- agents creating workaround slices/features for what is actually a sandbox/config problem
- writing load-bearing canon into `state/`, `/tmp`, or a nearby writable folder because the intended durable path was blocked
- trusting labels like `full access`; verify actual roots and command policy instead
- changing `config.toml` and expecting already-running seats to pick it up without restart

When `Operation not permitted` appears:
1. Identify whether it is command approval, filesystem root, macOS privacy, or stale session.
2. Check effective roots with `codex -p fleet debug prompt-input <probe-name>`.
3. Verify with a tiny direct write probe in an allowed target and a negative probe in a protected target such as `.ssh`.
4. If `config.toml` changed, restart one seat and re-run the probes before fleet rollout.
5. If the target should be durable and is not writable, stop and escalate; do not invent fallback storage.

Field note: as of Codex CLI `0.125.0`, top-level `[sandbox_workspace_write]` was the shape reflected by `debug prompt-input`; profile-scoped writable roots did not show in the effective prompt. Re-test this if Codex changes.


## Durable Write Escalation

If the task requires writing load-bearing knowledge or behavior and the intended target is not writable, stop and escalate. Do not silently write to `state/`, `/tmp`, or a nearby writable folder.

Use the intended durable home:
- `skills/` for operating rules and refocus behavior
- `openrig-work/field-notes/` for durable observations and investigations
- `openrig-work/lab/` for experiments and external project research
- `openrig-work/missions/` for PM specs, roadmap packets, and workstream canon
- product repo for shipped OpenRig daemon/CLI/config/spec/test behavior

A runtime mirror under a rig `state/` path may be used only as a temporary live patch, must be labeled as non-canonical, and must have a canonical sync follow-up.

## Common Mistakes

- treating `Verified: no` as if it proves the message did not land
- treating the unified-exec warning as if it proves the rig is overloaded
- killing live seats when only stale helper wrappers needed cleanup
- concluding "daemon down" from one seat's failure without checking host-level daemon status
- assuming Codex config changes apply to already-running seats without a restart/probe
- confusing command approval with filesystem write permission
- calling a VM or product path broken before comparing another approved seat or terminal-node probe
- assuming a label like `full access` proves effective write/network capability; verify command approval and filesystem writable-root coverage separately

## Practical Rule

Clean the smallest safe surface that matches the evidence.

If the warning or failure remains after stale-wrapper cleanup, re-check:

```bash
rig daemon status
rig ps --nodes --json
```

If those remain healthy, the residual issue may still be in the host/tool/session layer rather than in OpenRig topology state.
