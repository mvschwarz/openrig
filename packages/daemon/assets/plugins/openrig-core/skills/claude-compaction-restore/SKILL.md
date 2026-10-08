---
name: claude-compaction-restore
description: Use when a Claude Code session is about to compact, has just compacted, reached its context limit, resumed after /compact, or must rebuild its working picture of a long-running seat from its own restore map, its JSONL transcript and the files it touched.
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

Compaction keeps facts and loses connections. After a compaction you still know file names, row ids and
decisions as items. What you lose is the web between them: why a file matters, what depends on what, which
decision produced which artifact, what you were about to do next, and how this window relates to the ones
before it. Seats whose value is a wide, long-running picture (planners, orchestrators, reviewers holding a
standard) lose the most.

This skill keeps that picture alive across compactions. Before compacting, you write a **restore map**: a
short summary plus the connections between things that already exist on disk. After compacting, you
re-enter the world, read your own map, and rebuild the picture before acting. Over several compactions the
maps chain into one continuous record: a global context window that outlives any single session.

The previous version of this skill is kept at `reference/SKILL-v1.md` for comparison.

## What survives, and what you write

**Already on disk; point to it, don't copy it:**
- your session JSONL at `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` (the post-compaction restore
  request names the exact path). It holds every message and tool call you made, in order. It does not hold
  your reasoning;
- the restore packet the PreCompact hook writes (transcript extract, touched-file triage);
- queue rows and their transitions, mission files (`SPEC.md`, `NOTES.md`, `PROGRESS.md`), your seat's
  `LEARNED.md`, evidence folders, branches and PRs.

**Only in your head; write it down:**
- why each important thing matters, and to whom;
- how things relate: depends on, supersedes, answers, contradicts, was produced by, is owned by;
- decisions and the reasons for them, options you rejected, judgment and taste you applied;
- where you were in time: what earlier windows established, what this window did, what comes next and who
  authorizes it;
- where to look deeper: which JSONL range or file answers which question.

The map is the second list, pinned to the first.

## Two restore classes

Every restored seat must come back competent. It should understand the OpenRig world and its command
surface, the project, its own role, and where it stands in time. Some seats also need the global picture.

Both classes read the same thing: the **ranked reading list** in your own map, in order. They differ only in
how far down the list they go.

| Class | Who | Reads |
|---|---|---|
| **Default** | drivers, builders, reviewers, QA, and any seat not listed below | Tier 1: the top of the list, to about **100k** of real context |
| **High-context** | orchestrators, planners, advisors, leads: any seat that makes product, scope or routing decisions | Tier 1 and Tier 2, to about **200k** of real context |

The tiers are **real context added by the restore**, on top of what the compaction summary leaves (about 60k).
These budgets assume a context window of about 1M tokens; on a smaller window, scale them to about 10% and
20% of it. File size is a poor guide to that cost: in OpenRig's own runs, real context grew 1.7 to 2 times the bytes ÷ 4 estimate,
because of line numbers on reads, tool output and your own reasoning. So rank to about **50k of bytes ÷ 4 for
Tier 1** and about **100k for Tier 2**, and check real usage at each checkpoint with
`rig compact-plan --json` (your seat's `estimatedUsedTokens`).

Tier 2 buys **width, not depth**: more sources, more connections, more of the mission's history and the wider
worlds, not the same files read more fully. Choose your class from your role (`rig whoami --json`). A per-seat
instruction file or your own map can name the class explicitly, and that overrides the role default. In both
classes, transcripts and the session JSONL appear only as targeted line ranges, never as whole files.

If there is no ranked list (no preparation turn happened), use this default order. Default seats stop at about
100k of real context:
1. the post-compaction world profile;
2. the mission or slice `SPEC.md` and `NOTES.md`;
3. rows you hold.

High-context seats then add, to about 200k:
1. the full System World install;
2. the full Project World, public and private;
3. the mission's `PROGRESS.md` and recent returns;
4. previous maps and `RESTORED` notes;
5. `LEARNED.md`.

## If You Are About To Compact

You are about to lose every connection you have built. Spend this turn making them durable.

1. **Think back before writing.** Walk the session and, through your previous map, the windows before it.
   What were the threads? What did you work out about how the pieces fit? What is unfinished? What did you
   decide, and why? What were you about to be wrong about?
2. **Write the restore map at the exact path named in OpenRig's preparation request.** Follow that
   request's completion instructions: use your ordinary file-edit tool to write the named `.tmp` file,
   with the exact completion marker as its last line, then finish and close it. The daemon publishes
   the completed map atomically; do not run a shell rename or write the final file incrementally.
   Do not substitute the seat folder or another map. Managed preparation normally publishes
   `<launch cwd>/.openrig/compaction/preparation/<session>/<attempt>/RESTORE-MAP.md`; its parent
   compaction folder ignores itself in Git because maps hold private working context. Unknown or
   unwritable launch directories retain the instance-home fallback named in the request; it may need
   permission if outside your working directories. When there is **no named path**, use your durable seat
   folder instead: `<topology root>/rigs/<rig>/seats/<seat>/RESTORE-MAP-<UTC yyyymmdd-hhmm>.md`, derived
   from `rig whoami --json` and `rig config get topology.root`. **Run `date -u` for the timestamp and every
   time you write in the map. Do not estimate times**: an estimated time can land before events it describes.
3. **Open the map with a summary** of 10 to 20 lines: who you are, what you hold, what mattered in this
   window, what is next and who authorizes it, and any hold in force. **Publish that summary as your seat
   recap** too: save it, plus a line naming the map's path, to a file and run
   `rig context recap-write --rig <rig> --seat <seat> --file <that file>`. If your world profile has a seat
   recap atom, it loads this recap, and an old recap would be served as if it were current.
4. **Then write the connections.** Choose what this seat needs; these are examples, not a template:
   - **State:** rows you hold (id, state), branches and PR heads, the hold or release in force and who gave
     it, the mission and slice you work in.
   - **Nodes with purpose:** each file, row, PR or evidence folder that matters, one line each on what it is
     and why it matters.
   - **Edges:** "A depends on B", "C supersedes D", "this decision produced that file", "E answers question
     F", "G is owned by seat H", "I and J disagree; unresolved".
   - **Judgment:** decisions with reasons, rejected options, what the human cares about here, the tells you
     caught or nearly missed.
   - **Time:** what the previous map said happened before, what happened this window, what is next.
   - **Lookups:** JSONL line ranges or uuids for threads worth re-reading (`grep -n` the JSONL for a row id
     or timestamp), and which file holds the evidence for which claim.
   - **A small file tree** of the paths above, each with a one-line note, when that helps navigation.
5. **Rank what your restored self should read.** End the map with a reading list ordered by importance.
   - **What each entry gives:**
     - the path;
     - the exact part to read (a heading, a line range, or a JSONL range found with `grep -n`), not the
       whole file unless the whole file is the point;
     - its approximate size (bytes ÷ 4 ≈ tokens; `wc -c`);
     - one line on why it matters.
   - **The first entry** is the post-compaction world profile, with its size from
     `rig context profile … --json` (`totalEstimatedTokens`).
   - **Tier lines:** keep a running bytes ÷ 4 total, draw the Tier 1 line at about 50k (about 100k of real
     context), and continue to about 100k for Tier 2 (about 200k real).
   - **Rank for connections.** Prefer the entry that connects the most other things you need, and choose a
     section that explains how things fit over a long file of detail you can look up later.
6. **Link the chain.** Name the previous restore map (and its `RESTORED` note, if one exists) so a later
   reader can walk back through earlier windows.
7. **Keep it readable in one pass.** Aim for something you could read in a few minutes: point instead of
   copying, and leave out what a command can re-derive.
8. **Update the durable homes you own** as usual: a lesson that changes future decisions goes in
   `LEARNED.md`; mission state goes in the mission's own files; work another seat must act on goes in a queue
   row. The map points to these rather than repeating them.
9. **End the preparation turn** by stating the map path. OpenRig sends `/compact` next; the summary should
   name the map path and the next authorized step.

A map that lists files without saying how they connect is an inventory, and an inventory is what compaction
already leaves you. The edges are the point.

## If You Just Compacted

You have facts without connections. Rebuild the connections before you act on anything.

Use the native read tool for file reads throughout restoration. Load `refocusing`
and consume the current topology and work trace that actually arrived with the
restore request; do not rerun Python merely to duplicate it. If no current trace
arrived, name that delivery gap. A packet pointer, compact summary or truncated
extract is not a full source read. Read required notes and full sources separately
and complete the restore steps and read-depth audit below; partial reading does
not establish completed restoration. The earlier acknowledgement-only boundary
is not a restore request.

1. **Check for a hold first.** Read the restore request, the per-seat instruction file
   (`<OPENRIG_HOME>/compaction/post-compact-extra/<session>.md`, named by your full session such as
   `dev-impl@my-rig.md`) when it exists, the newest row or message from whoever routes your work, and any hold
   from the authority above them. A hold, a release order or an operator's own restore map overrides the default
   order below. Before any write, also run `rig whoami --json` and `rig queue whoami`.
2. **Name your class and state its read budget** before reading (see "Two restore classes"), with a
   checkpoint at each step below. The budget exists so that the restore leaves room for the work it was
   restored to do. Step 5 takes a high-context seat to its Tier 2 line; the extra sources under "Two restore classes" apply only
   when there is no ranked list.
3. **Re-enter the world.** Load the post-compaction world profile your instance provides. Find it with
   `rig context list`; for a private world install, run
   `rig context profile <world-ref> --situation post-compaction --rig <rig> --seat <seat>` (the seat flags are
   needed for its seat-scoped recap atom; take both values from `rig whoami --json`). Without a private world,
   run `rig context profile world-public --situation post-compaction` and `rig context get onboarding-width`. This restores how the system works before you
   restore what you were doing in it. If your work belongs to a project, re-enter its declared context too:
   `rig context work-install` lists what the project declares (intent, context files, skills), so read the pieces
   your task needs. `--deliver` prints them all; when several projects are declared (`--json` lists the ids), name
   one with `--project <id>`.
4. **Read your own restore map in full** at the exact path named by the preparation request, restore
   request or compaction summary. Only when none names a path, look for the newest `RESTORE-MAP-*.md`
   in your seat folder. If the selected map points to an earlier map for context you need, read that too.
5. **Read down the map's ranked list** to your class's tier line, reading exactly the parts each entry names.
   Then check every row you hold (`rig queue show <id> --full --json`) and anything that may have changed since
   the map was written: merged PRs, new rows, a new hold. The map records what was true when it was written;
   current state still has to be derived.
6. **Use the packet and the JSONL as lookups**, not as reading lists: go to a specific line range when a
   specific question needs it. The packet's `restore-instructions.md` and `touched-files.md` help find
   things the map does not cover.
7. **If there is no map** (the preparation turn did not happen), fall back to the packet: read
   `restore-instructions.md`, then the most recent unique narrative, tail first, within the budget; and say in
   your report that you restored without a map.
8. Reply with the sentence the restore request asks for, normally
   `restored from packet at <path>; resumed at step <X>`, naming the map you used. When no packet exists, give
   the map's path as `<path>` and say that you restored from the map.

## Required Read-Depth Audit

The audit message asks for a read-depth table and tells you not to conserve tokens. Do both in this form:

1. **List every item** you were asked to read (request, instruction files, packet, map, and the sources the
   map marks required) with `FULL`, `PARTIAL` or `NOT_READ`, the ranges you actually read, and a reason.
   Mark `FULL` only for content you read after this compaction; content carried in through the summary is
   inherited, not read, and a file the harness re-attached after compaction is
   `PARTIAL (injected)`, not `FULL`, until you read it.
2. **Read in full now** every required item that is not yet `FULL`. "Required" means the ranked entries
   above your class's tier line, in the exact parts they name. Everything else is lookup-only: **every file in the restore packet**
   (`touched-files.md`, `restore-instructions.md`, `transcript.md`, `transcript-latest.md`, `restore-summary.json`),
   the session JSONL and archives. Those stay
   `NOT_READ` with the reason "lookup only", unless a human or the owning seat releases them. The audit
   message's "do not optimize for token conservation" applies to required items: read those fully rather
   than skimming them. It does not turn lookups into reading lists. In an early run of this skill, reading
   the packet transcripts during the audit cost a default seat about 75k, more than the restore itself.
3. **Reconnect, in writing.** In the same reply, and in a short `RESTORED-<UTC yyyymmdd-hhmm>.md` beside the
   map:
   - where you are in time: what earlier windows established, what the last window did, what is true now;
   - the connections you have rebuilt, in a few lines;
   - the connections you could not rebuild, and where you would look;
   - the next authorized step and who authorizes it. If a hold stands, the next step is waiting.

The next restore map links this note, which keeps the chain unbroken.

## Guardrails

- Compaction is survival, not housekeeping. Compact only when a seat is genuinely near its limit, never to
  "lean" a seat or prepare a starter image; a compacted seat can sound confident while missing the context it needs.
- Continue from the map and the files, not from the summary's "next step" alone: a hold placed after the
  summary was written still binds.
- Do not launch a fresh session in place of restoring.
- An honest `PARTIAL` with its reason is a correct outcome. Claiming coverage you did not reach is the
  failure.
- Do not resume task work until the read-depth table and the reconnect note exist.

## Failure modes

1. **Inventory instead of map:** a list of paths with no edges. The restored seat knows where things are and
   not why they matter.
2. **Confident restoration:** acting on the summary after reading only the touched-file list.
3. **Reading to exhaustion:** reading the whole transcript or every linked file and leaving no room for the
   work.
4. **Map in scratch:** writing the map somewhere that is cleaned before you restore.
5. **Broken chain:** a map that does not name the previous one, so earlier windows are lost on the second
   compaction.
