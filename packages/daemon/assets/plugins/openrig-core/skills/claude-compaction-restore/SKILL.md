---
name: claude-compaction-restore
description: Use when a Claude Code session has just compacted, is about to compact, reached context limit, resumed after /compact, or needs to rebuild its working mental model from Claude JSONL transcripts and touched files.
metadata:
  openrig:
    stage: factory-approved
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
Restoration is your current task. Do not wait for a future user request or a
new task assignment before reading the required files.

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
8. After the required reads are complete, state:

```text
restored from packet at <path>; resumed at step <X>
```

Include the main files you read in full when you make that statement.

9. **REFOCUS BEFORE YOU RESUME — the restore returns your TASK, not your BEARINGS.** Everything
   above rebuilds *what you were doing*. None of it rebuilds *what the work is for* or *how this
   rig operates* — those live in the chains, and nothing in steps 1–8 walks them. Invoke the
   `refocus` skill and do its reads before your next substantive move.

   **Measured 2026-08-13, and this step exists because of it:** a seat completed this protocol
   faithfully — packet built, narrative read tail-first, read-depth audit reported honestly — and
   resumed with a perfect picture of its atom and *zero* work-tree context. It had never opened
   the mission or project nodes, and could only paraphrase the release's intent second-hand from
   a peer's message. It then produced a technically-correct trace concluding *"I hold nothing"*
   while holding 18 pending rows. **A restore that returns you to your task without your bearings
   is how a confidently-wrong agent gets back to work.**

**On the marker and the packet's size (measured across restores, 2026-08):** two realities the restore
must handle honestly —

- **The per-seat marker (`restore-pending/<session>.json`) is frequently absent** — in five observed
  restores it was never present. Treat the JSONL rebuild via `restore-from-jsonl.mjs` as the **primary**
  path, not a fallback: run it regardless of whether a marker exists. (When product-infra reliably writes
  the marker for tmux-launched seats, it becomes a fast-path upgrade — not a prerequisite that keeps failing.)
- **The generated transcript can be very large** (measured at ~346k tokens in one restore). Do **not**
  read it front-to-back or claim to. `restore-instructions.md` declares its token cost up front; default
  to the **most recent ~50k tokens of unique narrative first** (recency is what a restore needs — the
  thread that produced the current frontier, not the boot handshake), and go earlier only if a specific
  question requires it. A restore must leave room for the work it was restored to do.

## Required Read-Depth Audit

After the first restore pass, audit yourself before continuing.

1. List every file, packet, marker, restore map, instruction file, and source
   document you were asked to read during restore.
2. Mark each item as `FULL`, `PARTIAL`, or `NOT_READ`.
3. You will be given a task where all of these files are required reading in
   order to understand the task.
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
2. **Partial restore**: reading the first few files, then continuing before the
   full reading list is complete.
3. **Skipping project instructions**: missing `AGENTS.md`, `CLAUDE.md`,
   `README.md`, as-built docs, or codemaps that govern the task.
4. **Treating the packet as exhaustive**: ignoring mission or workspace files
   that are important but were not discovered by the script.
5. **Waiting for the next task**: treating restore reading as conditional on a
   future user assignment instead of completing it immediately.
