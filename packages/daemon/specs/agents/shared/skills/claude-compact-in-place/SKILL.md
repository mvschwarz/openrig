---
name: claude-compact-in-place
description: Use when a Claude Code seat in an OpenRig topology needs compact-in-place recovery or marshal verification after compaction.
---

# Claude Compact In Place

## Purpose

Use this skill when a Claude Code seat keeps the same OpenRig seat/session after `/compact` and must rebuild enough working context to continue safely. This is not succession, not seat handover, and not a generic memory note.

Keep two layers separate:

- **Restore mechanism:** seed from PreCompact output when present, Claude JSONL, touched-files inventory, active queue/session transcript or logs, root docs, and relevant source docs.
- **Acceptance mechanism:** a marshal or peer audits the rebuilt mental model and gives explicit marshal acceptance before the seat resumes real work.

Do not collapse these layers. A compacted Claude can sound coherent while important files were only injected, grepped, partially read, or not read.

## Runtime Boundary

This protocol is for Claude Code compact-in-place. It is not for Codex by default. Codex context management is different; do not intervene on Codex context percentage unless there are behavioral failure signals.

## Policy Boundary

The 400k token threshold is a policy target for considering preemptive Claude compaction on a 1M-context session. It is not an automatic action. Unattended compaction requires installed and dogfooded hooks, an audit path, and explicit policy or human authorization.

Compact one Claude seat at a time unless a human or policy explicitly confirms spare marshal capacity. Do not compact multiple Claude seats at once as a convenience move.

## Preflight

Before restoring or auditing, recover canonical identity:

```bash
rig whoami --json
rig whoami --session <target-seat> --json
```

The marshal verifies the target identity, seat name, runtime, active queue state, and transcript path before accepting any restore proof.

## Required Evidence

The target Claude should rebuild from concrete evidence, not just the compaction summary:

- Claude JSONL transcript for the session.
- Generated restore packet or PreCompact output, if present.
- Touched-files inventory and recent git state.
- Active queue file, queue packet body, session transcript, or session logs.
- Rig bootstrap files such as `AGENTS.md`, `CLAUDE.md`, `CULTURE.md`, role guidance, and startup skills.
- Relevant source docs, as-built docs, codemaps, and workstream trackers.

If a required surface is absent, record it as `NOT-PRESENT`. If it exists but was skipped, record it as `NOT-READ`.

## Required Proof

The target must return an asked-vs-read-depth table before claiming readiness:

| Surface | Source Of Ask | Read Depth | Evidence |
|---|---|---|---|
| `rig whoami --json` | marshal | FULL | canonical seat verified |
| `<path>` | hook/marshal/touched-files | FULL / TARGETED / GREP / INJECTED / NOT-READ / NOT-PRESENT | lines, chunks, command, or reason |

Allowed depth labels:

- `FULL`: the whole surface was read after compaction.
- `TARGETED`: selected ranges, head/tail, or named sections were read.
- `GREP`: search excerpts were read.
- `INJECTED`: content was present from hook, system, summary, or prior context, but not freshly read from disk.
- `NOT-READ`: the surface exists but was not read.
- `NOT-PRESENT`: the requested surface does not exist.

The proof must also include canonical identity, JSONL or restore packet path, active queue items, selected touched files, skipped files with rationale, blockers, and exact next action.

## Acceptance Rule

The target may say `awaiting marshal acceptance` or `blocked`. It must not claim `RESTORED`, resume implementation, review, release, architecture, or orchestration work until marshal acceptance is explicit.

Reject any proof that hides read depth, treats injection as a fresh read, omits queue reconciliation, or says "all docs read" without evidence.

Accept only when:

- The seat identity matches the target.
- JSONL or restore artifacts were used, or their absence is explicitly explained.
- Important recent-work files are either `FULL` or explicitly waived.
- `INJECTED`, `TARGETED`, `GREP`, `NOT-READ`, and `NOT-PRESENT` surfaces are named honestly.
- Active queue/session state is reconciled from durable evidence.
- The target did not resume real work before marshal acceptance.

## Marshal Follow-Up

Ask these before accepting a clean-sounding proof:

1. Which files were explicitly assigned, and which did you read in full after compaction?
2. Which files were only injected by hook, summary, system context, or prior context?
3. Which files were partial reads? Give line ranges or chunks.
4. Which touched-files entries were important, and which were skipped?
5. Did any read fail due to size? If yes, did you retry by chunk until complete?
6. Which queue items changed between checkpoint and now?
7. What would be unsafe for you to do before additional reads?

If a mandatory surface is partial or injected only, ask for a corrected audit before acceptance.
