---
name: session-compaction-and-restore
description: Use when reasoning about what survives compaction/context-loss/restart/seat-refresh, designing a high-fidelity restore packet, or distinguishing native runtime resume vs fork vs artifact-backed mental-model rebuild. Covers the 4 failure modes that prevent honest restore (compacted seat drops hot potato; restore packet preserves details but loses product intent; runtime resume mistaken for handover or fork; rebuilt seat starts with stale instructions).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Translated from openrig-work/primitives/continuity/session-compaction-and-restore.md (75 lines, design-consolidation). Cross-references the canonical packet contract in missions/recursive-self-improvement-v2/work-discovery-and-slice-shaping/slices/cross-runtime-restore-reentry-packet-standard-v0/ and the externalized-memory-surfaces convention.
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
    transfer_test: pending
---

# Session Compaction and Restore

Preserving useful working state across **compaction, context loss,
restart, or seat refresh.** Includes Claude compaction restore, Codex
resume/fork mechanics, transcript-based mental-model rebuilds, and
durable handoff packets.

**Long-lived seats are valuable only if they can survive context
pressure.** If compaction turns a senior seat into a cold-started
agent, users will avoid persistent topologies and fall back to
throwaway agents.

## Use this when

- A seat is approaching compaction or just compacted
- Designing a high-fidelity restore packet for an active workflow
- Distinguishing native runtime resume vs fork vs artifact-backed mental-model rebuild
- Reasoning about what should be preserved vs reconstructable
- Auditing a restore for product-intent preservation (not just detail preservation)

## Don't use this when

- The session is fresh and has no working state to preserve
- The intent is to *create* a new seat from a primed source — that's `session-source-fork` or `agent-starters`
- The packet is a one-off snapshot for human review — restore packets are for re-entering active work

## The 5 distinctions (do not collapse)

Per the cross-runtime restore/reentry packet standard:

| Mode | What it means | Outcome literal |
|---|---|---|
| **Native resume** | Continue the same managed seat with native runtime token | `resumed` |
| **Fork** | New managed seat from prior native runtime conversation; new post-fork token | `forked` |
| **Rebuild** | Fresh-launch seeded with operator-declared artifacts in trust-precedence order | `rebuilt` |
| **Artifact-backed mental-model rebuild** | Restored seat derives understanding from a packet rather than native runtime continuity | (case of `rebuilt`) |
| **Fresh launch** | New agent without prior continuity | `fresh` |

These are load-bearing distinctions. **Do NOT collapse `fork` into
artifact-backed reentry; do NOT collapse `rebuild` into fork.**

## Failure modes (4)

1. **A compacted seat forgets active workflow state and drops the hot potato.** Compaction without continuity preservation is silent failure.
2. **A restore packet preserves details but loses the user's product intent.** Restore must preserve *why this work matters*, not just *what was happening*.
3. **A runtime resume is mistaken for a seat handover or fork.** These have different continuity outcomes and provenance — don't conflate.
4. **A rebuilt seat starts with stale instructions that conflict with current workflow mode.** Restore must include current state, not just historical state.

## Proof standard

Proof should include a deliberate compaction/restart of a seat with
active work, followed by **measured recovery**: identity, current
workflow, next owner, relevant files, and constraints all restored
without human re-briefing.

## Canonical packet contract (16-field, v0)

The cross-runtime restore/reentry packet standard v0 defines:

- Source/target identity
- Runtimes
- Workspace root, default repo, role pointer
- Bounded latest transcript
- Touched-path inventory
- Durable work pointers
- Current work + next owner
- Caveats + authority boundaries
- Omitted classes + redaction policy
- Source-trust ranking
- Generated-at + generator version

Plus a 6-item restored-seat acceptance checklist.

Source-trust ranking applies when restored seat ingests packet evidence:
**`rig whoami` > target rigspec > bounded latest transcript > full
transcript > touched-files > `restore-summary.json`.**

## Memory surfaces consumed at restore time

This primitive consumes multiple externalized memory surfaces. Per the
externalized-memory-surfaces convention's 13-row first inventory pass,
the primary rows for restore are:

| Row | Surface |
|---|---|
| 1 | Transcripts |
| 2 | Durable chat |
| 3 | Startup replay context |
| 5 | Checkpoints |
| 12 | Restore/reentry packets and Agent Starters |

The umbrella's authority-rank + permission-posture columns govern which
surfaces a restore path can write vs only read.

## See also

- `claude-compaction-restore` skill — the Claude Code restore SOP (PreCompact hook + JSONL restore script for post-compaction recovery)
- `mental-model-ha` skill — HA-pair compaction recovery (different scenario; sister primitive)
- `session-source-fork` skill — `fork` mode for native-runtime-continuity-based restoration
- `seat-continuity-and-handover` skill — occupant-creation primitives (resume/fork/rebuild/fresh) that this primitive instantiates
- `externalized-memory-surfaces` skill — umbrella convention listing all surfaces this primitive consumes
- `substrate/shared-docs/openrig-work/missions/recursive-self-improvement-v2/work-discovery-and-slice-shaping/slices/cross-runtime-restore-reentry-packet-standard-v0/README.md` — canonical packet contract
- `session-compaction-and-restore` skill — primitive dossier with adjacent doctrine pointers
