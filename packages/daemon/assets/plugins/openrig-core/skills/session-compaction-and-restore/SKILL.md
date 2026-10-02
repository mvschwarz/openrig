---
name: session-compaction-and-restore
description: Use when reasoning about what survives compaction/context-loss/restart/seat-refresh, designing a high-fidelity restore packet, or distinguishing native runtime resume vs fork vs artifact-backed mental-model rebuild. Covers the 4 failure modes that prevent honest restore (compacted seat drops hot potato; restore packet preserves details but loses product intent; runtime resume mistaken for handover or fork; rebuilt seat starts with stale instructions).
metadata:
  cli_surfaces_referenced:
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - session-source-fork
      - seat-continuity-and-handover
      - retiring-and-inheriting-a-seat
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

## The three mechanisms — who owns each (verified vs main d37a08ad, 2026-07-21)

The outcomes above ride on three DISTINCT mechanisms; keep them separate:

1. **Claude built-in `/compact`** — a Claude Code HARNESS feature, **not OpenRig
   code**. OpenRig only *emits* the literal `/compact` toward the pane after a prep
   turn; there is no compaction algorithm in the OpenRig repo. Provider-owned.
2. **OpenRig-managed restore** — the enforcer + hook bridge: a precompact hook
   WRITES a restore packet; a bridge READER injects exactly ONE restore directive
   back via the harness hook channel (`hookSpecificOutput.additionalContext`),
   seat-isolated. The OpenRig-owned half.
3. **Codex session continuity** — resume/rollout tokens (`codex resume <token>`),
   a separate path from the Claude mechanisms. Never conflate with Claude restore.

**Safety boundary (ties to `native-session-file-lab-boundary`):** no supported
OpenRig path EDITS provider-owned native **session / auth / transcript** files to
inject context. Context enters ONLY through sanctioned channels: the hook
`additionalContext`, a normal user message via `rig send`, or Codex resume tokens.
Precise nuance: OpenRig *does* write `~/.codex/config.toml` — but only to install
OpenRig activity **hooks** and `[features]`, never session or auth state. So the
rule is "never edits native session/auth/transcript files," NOT "never touches any
provider-owned file."

## Current CLI surface (operator / kernel seats; verified vs main d37a08ad)

Managed compaction/restore is driven by five shipped verbs — pick per intent, and
stay durable-substrate-first (the packet/artifacts are the truth; the CLI is the trigger):

- **`rig compact <session>`** — guided managed compaction for ONE Claude seat
  (prep → `/compact` → restore → audit). Non-Claude seats rejected. ~180s.
- **`rig compact-plan`** — READ-ONLY triage; *does not compact*. Flags `--rig`,
  `--refresh`, `--threshold-tokens`, `--threshold-percent`. (Codex seats flagged
  `codex_not_managed_by_claude_compact_in_place`.)
- **`rig restore-check`** — restore-readiness probe across running rigs; read-only;
  exit 0/1/2. Flags `--full`, `--ready`, `--rig`, `--no-queue`, `--no-hooks`.
- **`rig restore-packet {write,read,validate}`** — the cross-runtime restore
  packet (v0): write / read / validate the durable packet this skill's contract defines.
- **`rig restore <snapshotId> --rig <rigId>`** — ⚠ RIG SNAPSHOT restore (infra), a
  DIFFERENT mechanism — NOT session-context restore. Do not conflate.

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

A restore may consume transcripts, durable messages, startup context,
checkpoints and a restore packet. Inventory the surfaces actually present for
this seat, with their source, freshness and purpose. Do not infer that a named
surface exists or grants write authority.

The active project/rig policy and task authorization determine what may be
written. Treat provider-owned conversation records as evidence to read through
supported tooling. For placement and durable context, load
`skills/openrig-operating-model/SKILL.md` with `rig context get`; for the
selected startup path, use `skills/core/agent-startup-and-context-ingestion/SKILL.md`.
A packet or marker proves retained/delivered evidence, not successful provider
restoration; measure the resumed seat against the proof standard above.

## See also

- `claude-compaction-restore` skill — the Claude Code restore SOP (PreCompact hook + JSONL restore script for post-compaction recovery)
- `session-source-fork` skill — `fork` mode for native-runtime-continuity-based restoration
- `seat-continuity-and-handover` skill — occupant-creation primitives (resume/fork/rebuild/fresh) that this primitive instantiates
- `openrig-operating-model` skill — placement and authority of durable context
