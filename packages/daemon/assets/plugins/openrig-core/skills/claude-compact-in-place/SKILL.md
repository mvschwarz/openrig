---
name: claude-compact-in-place
description: Use when a Claude Code seat in an OpenRig topology needs compact-in-place recovery, auto-compaction policy, or verification that a compacted Claude actually rebuilt its mental model.
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Graduated 2026-05-04 from openrig-work/skills/workspace/from-substrate-wip/claude-compact-in-place/.
      Substrate-WIP triage was deferred per founder direction; this skill is graduated out-of-band as part of Phase 3d N2 expansion (substrate-WIP graduation; out-of-band per dogfood).
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - pre-maintenance-agent-preservation
    transfer_test: pending
---

# Claude Compact In Place

## Purpose

Compact-in-place means keeping the same Claude seat/session role alive while
refreshing its context, then rebuilding its working mental model from durable
evidence. It is not succession, not a fresh spawn, and not a vibe-based
"continue from summary" reset.

The safe pattern has two separate layers:

- **Restore mechanism:** PreCompact seed, JSONL transcript curation,
  touched-file inventory, queue/session-log/root-doc re-prime, and
  SessionStart/compact context injection when installed.
- **Acceptance mechanism:** a separate marshal or peer challenges the restored
  Claude with a read-depth audit before accepting "RESTORED."

Do not collapse these. The live H41 compaction wave showed Claude will often
self-report a good restore while key files were only partially read, injected by
context, or not read at all.

## When To Use

Use this for Claude Code seats that:

- have just run `/compact`
- are about to be compacted in place
- are under an auto-compact policy
- claim they restored after compaction
- need a marshal to verify restore quality

Do not use this for Codex context management. Codex compaction behavior is
different and normally does not need this marshal protocol.

## Operating Policy

Default OpenRig target:

- Preemptively compact Claude around **400k tokens** on a 1M-context session
  rather than waiting for a context wall.
- If Claude Code cannot trigger directly at a token threshold, use an external
  watchdog/monitor that reads `rig whoami --json` or equivalent context usage
  and sends `/compact` at the threshold.
- Only enable unattended auto-compact where the restore hook and audit path are
  installed and dogfooded.
- Do not compact multiple Claude seats at once unless the topology has spare
  non-Claude or already-restored marshal capacity.

The 400k threshold is a reliability posture, not a magic number. Adjust it by
model/context size and the amount of high-value work in-flight.

## Required Artifacts

Before accepting a restored Claude, the marshal needs these surfaces:

- `rig whoami --json` for canonical identity
- Claude JSONL transcript under `~/.claude/projects/.../<session-id>.jsonl`
- restore output from the `claude-compaction-restore` skill:
  `node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json`
- generated `/tmp/claude-compaction-restore/.../restore-instructions.md`
- generated `/tmp/claude-compaction-restore/.../touched-files.md`
- the seat queue file and active queue packets
- recent `rig transcript <seat>` or session logs
- rig bootstrap files such as `AGENTS.md`, `CLAUDE.md`, `CULTURE.md`, role guidance
- relevant OpenRig as-built docs and codemaps
- any workstream tracker that defines the current arc

For OpenRig product/control-plane work, these are mandatory full-read anchors:

- `~/code/projects/openrig/docs/as-built/architecture.md`
- `~/code/projects/openrig/docs/as-built/codemap.md`
- `~/code/projects/openrig/docs/as-built/cli-reference.md`

## Compact-In-Place Flow

1. **Preflight the seat.** Confirm the target is the intended canonical session:
   `rig whoami --session <seat> --json`. Capture the pane and read its latest
   queue/checkpoint state.
2. **Create or locate a restore seed.** Prefer the PreCompact hook plus the
   JSONL restore script. If no pre-save exists, use JSONL transcript, queue
   state, and touched files as the seed.
3. **Send `/compact`.** Use `rig send <seat> "/compact" --verify --force` only
   when the human/policy permits compaction for that seat. Watch the pane until
   the command has landed and compaction completes.
4. **Send the restore prompt.** Tell the compacted Claude to run the restore
   script, read the generated instructions and touched-files list, read the
   mandatory anchors, reconcile active queue items, and return a durable proof.
5. **Reject vague proof.** Do not accept "all docs read", "restored cleanly", or
   "I read the important files" without an exact read-depth ledger.
6. **Ask follow-up questions.** Force the target to distinguish full reads from
   partial reads, injected context, grep/tail evidence, and unread files.
7. **Accept or correct.** A seat is restored only after the marshal accepts the
   corrected ledger and records caveats. If gaps remain, send a targeted
   correction and keep the seat in restore verification.

## Required Restore Proof

The target Claude must return a durable queue packet or otherwise persisted
proof containing this table shape:

| Surface | Source Of Ask | Read Depth | Evidence |
|---|---|---|---|
| `rig whoami --json` | marshal | executed/full output parsed | canonical seat confirmed |
| `<path>` | hook/marshal/touched-files | FULL / TARGETED / GREP / INJECTED / NOT-READ / NOT-PRESENT | lines/chunks/status |

Allowed read-depth terms:

- `FULL`: the whole file was read after compaction using the Read tool or
  equivalent full line-range passes.
- `TARGETED`: only specific ranges, head/tail, or selected sections were read.
- `GREP`: only search excerpts were read.
- `INJECTED`: content was present from Claude/system/hook context but was not
  freshly read from disk.
- `NOT-READ`: file exists but was not read.
- `NOT-PRESENT`: requested surface does not exist.

The proof must also include:

- canonical identity and session name
- restore packet path or JSONL path
- active queue items and exact next action
- recent-work files selected from `touched-files.md`
- files intentionally not read and why they are not restore-critical
- blockers, if any
- status: `awaiting marshal acceptance`, `blocked`, or `restored`

The target should not claim `RESTORED` until the marshal accepts the proof.

## Follow-Up Questions

Ask these after the first proof, especially if it sounds clean:

1. Which files were you explicitly asked to read, and which of those did you read
   in full after compaction?
2. Which files did you only receive through hook/session/system injection?
3. Which files did you read partially? Give exact line ranges or chunks.
4. Which generated `touched-files.md` entries did you classify as important, and
   which did you skip?
5. Did any Read tool call fail due to file size? If yes, did you retry with
   offset/range reads until full coverage was achieved?
6. Which queue items changed between your checkpoint and now? Cite the durable
   evidence that reconciles the difference.
7. Name one non-obvious detail from each mandatory anchor that affects your next
   action.
8. What would be unsafe for you to work on before additional reads?

If the answer reveals partial or injected-only coverage for a mandatory anchor,
reject the proof and ask for a replacement audit.

## Acceptance Standard

Accept the restore only when:

- the seat identity matches the preflight target
- the JSONL/restore packet was used or the absence is explicitly explained
- mandatory anchors are FULL or explicitly waived by a human/marshal
- important recent-work files are either FULL or explicitly classified as
  non-critical with rationale
- every injected/partial/not-read surface is named, not hidden
- queue state is reconciled against durable evidence
- the target has not resumed real work before acceptance

Partial restore can be acceptable for standby if the unread items are honestly
classified and not needed for the next action. Partial restore is not acceptable
for architecture decisions, code review, product direction, or release calls.

## Live H41 Lessons

Observed during the 2026-04-23 rolling Claude compaction wave:

- `platform-architect2@kernel` initially claimed restore, then audit v2 admitted
  the first proof missed OpenRig as-built docs, skill docs, `touched-files.md`,
  and several recent-work files.
- `spec-writer@openrig-pm` needed a final replacement audit before acceptance;
  earlier reports conflated full reads, injected context, and unread files.
- `research-synthesizer@openrig-pm` had its first proof rejected because
  `architecture.md`, `codemap.md`, the compaction manifest, and `progress.md`
  were partial/injected; the corrected proof closed those gaps and waited for
  marshal acceptance before claiming restored.

Conclusion: hook injection and Claude's compaction summary are useful restore
inputs, but the reliable product primitive is **restore plus adversarial
read-depth audit**.

## Common Mistakes

- Accepting a generic "all docs read" statement.
- Treating context injection as equivalent to a fresh full read.
- Reading only the first chunk of a large codemap and calling it full.
- Skipping `touched-files.md` because it is large.
- Letting the compacted Claude resume real work before marshal acceptance.
- Compacting several Claude seats at once and losing marshal capacity.
- Applying this protocol to Codex without evidence of Codex-specific failure.
