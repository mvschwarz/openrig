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

Use this skill to preserve continuity before Claude Code compacts and to
restore continuity after compaction. Do the work described here; do not merely
explain the protocol.

## If You Are About To Compact

Prepare durable continuity before the context boundary.

1. Identify the active task, queue item, mission/slice, branch or commit, and
   current working directory.
2. Record the current state: decisions made, files changed, commands/tests run,
   evidence produced, blockers, caveats, and the next concrete step.
3. Create or update a durable mental-model restore map. This map is the main
   artifact future-you will use to rebuild context after compaction.
4. In the restore map, write an ASCII file/folder tree of every path that
   mattered to your working mental model during this session. Include:
   - the active queue item or mission packet;
   - mission notes, progress, decisions, and evidence files;
   - Claude memory/project notes you used or wrote, especially when the memory
     folder is shared by many agents;
   - files with active edits or recently inspected source;
   - root instructions such as `AGENTS.md`, `CLAUDE.md`, or `README.md`;
   - as-built docs, codemaps, conventions, skills, and product docs needed
     before code/review work;
   - source files, tests, scripts, UI evidence, screenshots, logs, or reports
     that shaped your current state.
5. For every file or folder in the tree, add a short note explaining why it
   matters and whether it is required reading after compaction.
6. Write any important glue context that is not already on disk into the
   handoff/restore map. This includes assumptions, partial conclusions, failed
   paths, and why the listed files fit together.
7. In the compaction summary, include the restore map path and the top required
   reading paths from that map.

## If You Just Compacted

Treat your memory as unreliable until you restore from durable evidence.

1. Read any restore prompt, marker path, packet path, transcript path, restore
   map, or extra instruction file named by the operator or OpenRig.
2. Run the restore script from this skill:

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore
```

If the prompt names a specific Claude JSONL transcript, pass it explicitly:

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs /path/to/session.jsonl --out /tmp/claude-compaction-restore
```

3. Read the generated `restore-instructions.md`.
4. Read the generated `touched-files.md`.
5. Find and read the mental-model restore map if one exists. Treat it as the
   highest-value guide to which memory files, mission files, source files, and
   docs mattered before compaction.
6. Identify the important files for the active task. The touched-file list is
   a triage aid, not a complete inventory.
7. Read every important file in full. Prioritize the restore map, Claude memory
   files named in the map, Markdown state/planning files, queue/mission packets,
   source files with active edits, root instruction files, and as-built or
   codemap docs.
8. Only resume task work after you can state:

```text
restored from packet at <path>; resumed at step <X>
```

Include the main files you read in full when you make that statement.

## Required Read-Depth Audit

After the first restore pass, audit yourself before continuing.

1. List every file, packet, marker, restore map, instruction file, and source
   document you were asked to read during restore.
2. Mark each item as `FULL`, `PARTIAL`, or `NOT_READ`.
3. You will be given a task where all of these files are required reading in
   order to understand the task.
4. Do not optimize for token conservation.
5. Read every `PARTIAL` or `NOT_READ` item in full now.
6. Report the final read-depth table before doing any substantive task work.

## Guardrails

- Do not silently launch fresh after compaction.
- Do not continue from memory when restore evidence exists.
- Do not skip root instructions, as-built docs, or codemaps before product
  code/review work.
- Do not treat the generated touched-file list as exhaustive.
- Do not mark a file `FULL` unless you actually read the full file content
  after compaction.
- Do not resume task work until the restore sentinel and read-depth audit are
  complete.

## Failure Modes To Avoid

1. **Confidently-wrong restoration**: claiming restoration after reading only
   the touched-file list or summary.
2. **Partial restore**: reading the first few files, then continuing before the
   full reading list is complete.
3. **Skipping project instructions**: missing `AGENTS.md`, `CLAUDE.md`,
   `README.md`, as-built docs, or codemaps that govern the task.
4. **Treating the packet as exhaustive**: ignoring mission or workspace files
   that are important but were not discovered by the script.
