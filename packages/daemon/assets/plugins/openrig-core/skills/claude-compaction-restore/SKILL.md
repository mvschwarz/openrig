---
name: claude-compaction-restore
description: Use when a Claude Code session has just compacted, is about to compact, reached context limit, resumed after /compact, or needs to rebuild its working mental model from Claude JSONL transcripts and touched files.
metadata:
  openrig:
    sibling_skills:
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - session-source-fork
      - seat-continuity-and-handover
---

# Claude Compaction Restore

Use this skill to preserve continuity before Claude Code compacts and to
restore continuity after compaction. Follow the active restore request or
configured continuity policy. A hook notice identifies available evidence; it
does not by itself request a seat restoration.

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

Restore from the evidence for this session before relying on remembered task state.

1. Inspect the restore request and any named marker, packet, transcript, restore
   map, or extra instruction file. Check recorded seat/session/transcript identity
   against the current request, and verify that the referenced packet is readable.
   A marker path alone does not prove a usable packet; do not substitute another
   seat's packet or select one only because it is the newest.
2. **Use the existing packet when usable.** Read its `restore-instructions.md`,
   `touched-files.md`, and any named restore map. A packet already prepared for this
   session does not need rebuilding merely because compaction occurred.
3. **Fall back when the packet is absent or unusable.** Record what is missing or
   mismatched. Resolve this skill's installed directory and run its
   `scripts/restore-from-jsonl.mjs` with the matching Claude JSONL transcript and a
   separate output directory. For a skill installed in the global Claude skill root:

```bash
node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs /path/to/session.jsonl --out /tmp/claude-compaction-restore
```

   If no transcript was named, identify the current session's transcript first.
   The script can discover a transcript from a working directory, but inspect that
   selection before relying on it. If the session cannot be identified, report
   the missing input instead of reconstructing from an unrelated conversation.
   Read the resulting `restore-instructions.md` and `touched-files.md`.
4. Inspect the actual packet and transcript sizes before choosing how much to read.
   The generated instructions report estimated token cost. State a read budget
   and stopping rule that leave room for the task. For a large transcript, begin
   with the most recent task-relevant unique narrative; read earlier material when
   a specific missing decision or dependency requires it. Report ranges actually
   read rather than treating a chosen budget as completed coverage.
5. Use the restore map and touched-file list to identify current task files.
   The list is a triage aid, not an exhaustive inventory. Prioritize the active
   queue/mission packet, decisions and memory named in the map, files with active
   edits, root instructions, and relevant as-built docs or codemaps. Read required
   task files in full within the stated budget; record any remaining gaps.
6. Re-establish the task's purpose and operating context from the current project,
   mission and seat files. A transcript summary alone does not establish current
   scope or obligations. Use the shipped `refocusing` skill for the path-only
   topology/work trace when operating inside OpenRig.
7. Report the read-depth audit below. Once the required context is restored, use
   the packet's requested acknowledgment, normally:

```text
restored from packet at <path>; resumed at step <X>
```

   Include the main files actually read in full. If essential context remains
   missing, report partial restoration and the next recovery action instead of
   claiming completion.

The packaged PreCompact writer can prepare a packet and a per-seat pending marker;
the restore bridge can deliver its pointer once for a matching session. Inspect
those actual artifacts. Their creation or delivery is not proof that a provider
restored its context, that the files were read, or that task understanding returned.

## Required Read-Depth Audit

After the first restore pass, audit yourself before continuing.

1. List every file, packet, marker, restore map, instruction file, and source
   document you were asked to read during restore.
2. Mark each item as `FULL`, `PARTIAL`, or `NOT_READ`.
3. Distinguish essential current-task context from supplementary history, using
   the actual restore request and active task.
4. Read `PARTIAL`/`NOT_READ` items in full — but **to a declared budget with a stopping rule**, not
   unbounded. Prioritize by relevance to the active task; for a large transcript read the most recent
   unique narrative first (see *If You Just Compacted*), not front-to-back.
5. **Stop** when either every task-relevant item is `FULL`, or you reach the budget — *a restore that
   cannot leave room for the work it was restored to do is not a successful restore.* "Read everything,
   never conserve" has no termination condition; that open-endedness is the bug, not the goal.
6. Report the final read-depth table **honestly** (`FULL`/`PARTIAL`/`NOT_READ`, each with a reason)
   before task work. **An honest `PARTIAL` with its reason is a correct outcome, not a failure** — do
   not claim a completion you did not reach.

## Guardrails

- Compaction is survival, not housekeeping — never compact to free space, "lean" a seat, or capture/prepare an agent starter (the `rig agent-image` library). It is lossy (a compacted Claude is confident-but-hollow); compact only when a seat is genuinely near its context limit, with a before/after plan. A starter's value is being *functional*, not small — see the `agent-starters` skill.
- Do not silently launch fresh after compaction.
- Do not continue from memory when restore evidence exists.
- Do not defer required restore reading until a later user task. The restore is
  the current task.
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
2. **Unreported partial restore**: continuing without essential task context or
   claiming full coverage after a budget-limited read.
3. **Skipping project instructions**: missing `AGENTS.md`, `CLAUDE.md`,
   `README.md`, as-built docs, or codemaps that govern the task.
4. **Treating the packet as exhaustive**: ignoring mission or workspace files
   that are important but were not discovered by the script.
5. **Waiting for the next task**: treating restore reading as conditional on a
   future user assignment instead of completing it immediately.
