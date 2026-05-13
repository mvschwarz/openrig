---
name: rig-lifecycle
description: Use when reasoning about the rig lifecycle operations family (create / start / stop / resume / restore / snapshot / release / unclaim / destroy), reading or trusting `rig ps` / lifecycle projections after recovery, or designing proof for a lifecycle scenario. Covers the 4 failure modes (auto-restore creates partial rig; projections report healthier than reality; provider auth treated as impl work; resume succeeds for one runtime fails another) plus the restore-honesty rule (failed resume is FAILED loudly — no auto fresh fallback).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Lifecycle Reboot/Recovery Scenario Matrix (Tier 1 complete; Tier 2
      human-gated). Codex auth-refusal surfaces as attention_required.
    sibling_skills:
      - openrig-user
      - openrig-operator
      - seat-continuity-and-handover
    transfer_test: pending
---

# Rig Lifecycle

The family of operations that **create, start, stop, resume, restore,
snapshot, release, unclaim, and destroy** OpenRig-managed topologies.
Includes the user story after reboot: **"bring my work back without
turning a clean recovery into a cleanup project."**

If lifecycle is brittle, every higher-level primitive inherits that
brittleness. Queue, workflow, seat continuity, cross-host operation,
and RSI all assume that rigs and seats can be restored into known
states.

## Use this when

- Operating `rig up / down / restore / resume / snapshot / release / unclaim / destroy`
- Reading `rig ps` after a reboot or recovery and deciding what to trust
- Designing proof for a lifecycle scenario (clean start / warm resume / host reboot / provider auth loss / partial boot / operator recovery)
- Reasoning about restore-outcome semantics (`resumed` / `rebuilt` / `fresh` / `failed` / `attention_required`)
- Auditing whether a lifecycle proof is in-process bedrock vs requires real reboot evidence

## Don't use this when

- The operation is single-command and deterministic — use `openrig-user` skill for CLI surface
- The work is operator-level configuration of OpenRig itself — use `openrig-operator`
- The work is rig spec authoring — use `openrig-architect`

## Failure modes (4)

1. **Auto-restore creates a partially restored rig that must be cleaned up before real recovery.** Partial restore looks like recovery but isn't; cleanup-before-recovery becomes the actual workload.
2. **`rig ps` or lifecycle projections report a healthier state than the runtime actually has.** Projections are summaries; the runtime is truth. Don't trust projections silently.
3. **Provider auth is unavailable after reboot and the system treats that as implementation work** instead of a human/environment decision. Auth issues are environmental; route to human.
4. **Resume succeeds for one runtime/provider but fails for another scenario that was never tested.** Per-runtime parity assumptions break silently; matrix proof catches them.

## Restore-honesty rule (load-bearing)

**Failed resume is FAILED loudly.** No automatic fresh fallback. Fresh
launch is **explicit follow-up only.** This is enforced architecturally
at the daemon level (per `architecture.md` §7 rule 15).

The locked restore-outcome vocabulary:

| Outcome | Meaning |
|---|---|
| `resumed` | Native runtime resumed the same conversation |
| `rebuilt` | New process assembled from artifacts (`session_source: mode: rebuild`) |
| `fresh` | New process with no prior continuity |
| `failed` | Restore attempted and failed; no automatic fallback |
| `attention_required` | Recoverable blocker (provider auth refused, etc.); needs operator action |
| `n-a` | Not applicable (terminal nodes, etc.) |

Codex auth-refusal returns `attention_required` (recoverable); Claude
`looksLikeClaudeLoginPrompt` returns `failed/login_required` (terminal).
Cross-runtime alignment is an open follow-up question.

## Proof standard

Lifecycle proof should include **real reboot or VM-reboot evidence**,
not only daemon-unit evidence. The minimum useful matrix covers:

| Scenario | What it proves |
|---|---|
| Clean start | Boot from spec into known state |
| Warm resume | `rig down` → `rig up <name>` resumes seats |
| Host reboot / tmux socket absence | Recovery from lost tmux connection |
| Provider auth loss | Codex/Claude auth refusal handled honestly |
| Partial boot / partial failure | Some seats up, some failed; honest reporting |
| Intentional operator recovery | Operator-initiated restore from snapshot |

Tier 1: in-process bedrock (daemon-unit evidence). Tier 2: real reboot
or disposable Tart VM. Tier 1 alone is not lifecycle proof; it's
bedrock.

## Default policy is part of the primitive

**Treat default policy as part of the primitive, not an afterthought.**
Lifecycle defaults that are too optimistic for the reliability level
actually proven create silent harm:

- `auto-restore` defaults that mask failure modes
- Implicit fresh-fallback that hides resume failure
- Permissive verification that doesn't distinguish honest success from "appeared to work"

## Total-Host Restore Product Rail v2

The rail sequences restore truth into **four rungs**:

- `fully_restored` is a **Rung 3 execution rollup**
- "fully back" is **reserved for Rung 4 only**

Naming discipline matters. "Fully restored" and "fully back" are
different claims; don't conflate.

## See also

- `openrig-user` skill — CLI surface for `rig up / down / restore / etc.`
- `openrig-operator` skill — operator-level discipline for OpenRig itself
- `seat-continuity-and-handover` skill — occupant-creation modes for restore (`resume` / `rebuild` / `fresh` / `failed`)
- `openrig/docs/as-built/architecture.md` (product reference doc) — daemon enforcement of restore-honesty rule
