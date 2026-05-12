---
name: claude-compaction-restore
description: Use when a Claude Code session has just compacted, is about to compact, reached context limit, resumed after /compact, or needs to rebuild its working mental model from Claude JSONL transcripts and touched files.
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Graduated 2026-05-04 from openrig-work/skills/workspace/from-home-skills/claude-compaction-restore/
      (which was a verbatim copy of ~/.agents/skills/claude-compaction-restore/).
      Originally authored as a personal skill; promoted as load-bearing for any
      OpenRig seat that may compact. PreCompact hook is actively wired at
      ~/.claude/settings.json on the primary host.
    transfer_test: practical-passed-2026-05-04
    transfer_test_notes: |
      Skill was actively used during the 2026-05-04 conversation by the
      compacted skills-architect@skill-library seat. The PreCompact hook
      generated the restore packet; the post-compaction agent ran
      restore-from-jsonl.mjs, read restore-instructions.md and touched-files.md,
      identified important files, and reported "restored from packet at <path>;
      resumed at step <X>." That's a real-work transfer-test pass; formal
      pressure-scenario sub-agent test still pending per writing-skills TDD
      discipline.
    sibling_skills:
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# Claude Compaction Restore

## Situation

You have just been compacted, or you are preparing a Claude Code session
for compaction. Treat memory after compaction as unreliable. Do not
continue real work from vibes.

Restore from durable evidence:
- the Claude JSONL transcript
- files touched during the session, especially Markdown state/planning files
- project root docs and as-built documentation
- repo code maps before code/review work

## Fast Path

Run the restore script from this skill:

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore
```

If you know the JSONL path, pass it explicitly:

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs /path/to/session.jsonl --out /tmp/claude-compaction-restore
```

The script writes:
- `transcript.txt` — readable transcript reconstructed from JSONL
- `touched-files.md` — ranked file list, with Markdown and written files highlighted
- `restore-instructions.md` — checklist for the compacted agent
- `restore-summary.json` — machine-readable summary

## Operator Instruction Templates

OpenRig ships default operator-facing templates for the two editable
Claude auto-compaction policy fields:

- `templates/compact-instruction.md` — instruction passed as `/compact <instruction>`.
- `templates/post-compact-restore-instruction.md` — restore directive delivered by compaction hooks after the summary boundary.

These templates are deliberately continuity/procedure-shaped. Avoid
testing compaction with "say this exact phrase" or persona-style
commands; Claude may correctly treat those as prompt-injection-shaped
hook output rather than useful lifecycle instructions.

## Restore Protocol

1. Read `restore-instructions.md`.
2. Read `touched-files.md`.
3. Pause and answer: which files do you recognize as important to the work and project state?
4. Read each important file in full. Prioritize Markdown files that were written or tracked by file-history snapshots.
5. Read project root docs in full when present: `CLAUDE.md`, `AGENTS.md`, `README.md`.
6. Read as-built docs and code maps in full before product work, code review, or architecture decisions. Common paths: `docs/as-built/`, `docs/codemap*`, `docs/architecture*`.
7. Only resume work after stating: "restored from packet at <path>; resumed at step <X>."

## Hook Usage

Claude Code exposes compaction lifecycle hooks. OpenRig uses
`PreCompact` to prepare the packet before compaction, plus
`SessionStart` with matcher `compact` and `UserPromptSubmit` as the
post-compact bridge that injects the pending restore directive if the
summary alone did not carry enough context.

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/precompact-hook.mjs
```

The hook reads Claude hook JSON from stdin, creates a restore packet
under `/tmp/claude-compaction-restore/`, writes a pending marker under
`$OPENRIG_HOME/compaction/restore-pending/`, and returns a
`systemMessage` telling the compacted agent what to read.

The hook and bridge provide context, but they do not create an
assistant turn by themselves. OpenRig's daemon-side compaction enforcer
therefore sends one normal post-compaction restore prompt after context
usage drops below the configured threshold. That prompt points at the
pending marker and restore packet so the seat actively runs the restore
protocol instead of sitting idle after `/compact`.

To wire the hook, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/skills/claude-compaction-restore/scripts/precompact-hook.mjs"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs\""
          }
        ]
      }
    ]
  }
}
```

## Guardrails

- Do not silently launch fresh after compaction.
- Do not trust fuzzy recollection over files.
- Do not skip as-built docs or codemaps before code/review work.
- Do not treat a generated touched-file list as perfect. It is a triage aid; the agent must still recognize and select important files.
- Do not skip the explicit "restored from packet at <path>; resumed at step <X>" announcement. It's the sentinel that signals genuine restoration vs performed restoration.

## Common Failure Modes (load-bearing — read these)

1. **Confidently-wrong restoration**: agent claims to have restored but actually only read the touched-files list, not the files themselves. The "restored from packet" announcement should be backed by specific file content cited in subsequent work. If the agent's first post-restore turn is generic / doesn't reference specific file content, restoration didn't actually happen.
2. **Skipping the project root docs**: agent reads only the touched-files list; misses `CLAUDE.md` / `AGENTS.md` / `README.md` which carry persistent context. The restore-instructions.md checklist explicitly names these — follow it.
3. **Reading partial then continuing**: agent reads 2-3 files and starts working before reading all important ones. Better to over-read than to drift on partial recovery.
4. **Treating the restore packet as exhaustive**: the packet is a triage aid. Important state may live in files NOT in the touched-files list (e.g., recently-relevant skills, doctrine docs, mission state). Use the packet as a starting point, not a complete inventory.
