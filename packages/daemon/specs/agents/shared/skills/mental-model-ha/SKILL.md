---
name: mental-model-ha
description: High-availability mental model preservation across compaction events and session restarts. Covers externalized state on the filesystem, scope folder conventions, agent naming, pod/role taxonomy, continuous state maintenance, pre-compaction save, peer restore with phased protocol, session logs as shared mental models, tribal wisdom, and multi-agent shared state. Works for single agents, pairs, and full team topologies.
---

# Mental Model HA

Preserve and restore an agent's working mental model across compaction events and session restarts. Works for single agents, HA pairs, and multi-agent team topologies.

## Core Principles

1. **The filesystem is your durable memory.** Your mental model lives in files — restore files, README, session logs, scope knowledge. Keep them current throughout the session, not just at compaction time.

2. **The filesystem is multiplayer.** Scope folders are readable and writable by every agent in the project. Any agent can restore any other agent.

3. **One place for everything.** Every artifact type has exactly one location. No decisions about where to put things.

4. **Human decides when to compact.** Agents prepare and recommend. The human pulls the trigger.

5. **Never create scope structure without human confirmation.** Discovery yes, creation only with explicit approval.

6. **Restore artifacts must preserve not just facts, but pattern-forming context.** Facts can be re-derived from code and git history. Judgment, instincts, and the reasons behind decisions cannot. Session logs and restore files exist to rebuild the mental model that makes an agent effective, not just informed.

---

## Agent Naming Convention

Every agent in a rig gets a label that identifies its topology position and context boundary:

```
{pod}{N}-{role}@{scope}
```

| Segment | What it is | Examples |
|---|---|---|
| `{pod}` | Functional unit — what kind of work | dev, orch, review, design, research, ops, test |
| `{N}` | Instance number (if multiple pods of same type) | 1, 2, 3 |
| `{role}` | Job function within the pod | coder, qa, lead, peer, r1, r2 |
| `@` | Separator between topology and context | literal `@` |
| `{scope}` | Work context (project/effort) | rigged-dev, specgraph, agilitas-review |

Examples:
```
dev1-coder@rigged-dev       # dev pod, coder role, rigged dev scope
dev1-qa@rigged-dev          # dev pod, qa role
orch1-lead@rigged-dev       # orchestrator pod, lead role
orch1-peer@rigged-dev       # orchestrator pod, peer role
rev1-r1@rigged-dev          # review pod, reviewer 1
dev1-coder@specgraph        # same structure, different scope
```

This label is used for: tmux session names, agent-to-agent messaging, knowledge management, compaction/restore targeting, and lifecycle management.

### Hierarchy

| Level | Term | What it is |
|---|---|---|
| Work context | **scope** | The project/effort boundary. Maps to a scope folder. |
| Full topology | **rig** | All agents working on a scope. |
| Functional unit | **pod** | A small cross-functional group within a rig. |
| Job function | **role** | One agent's specific job within a pod. |

### Canonical Pod Names

Pods are named after the **function** they perform, not the technology or model.

| Pod | Purpose | Typical Roles |
|---|---|---|
| **dev** | Write and gate code | coder, qa |
| **orch** | Architecture, monitoring, coordination | lead, peer |
| **review** | Independent code review | r1, r2 |
| **design** | UI/UX design | lead, peer |
| **research** | Deep research | lead, peer |
| **ops** | Infrastructure/deployment | lead, peer |
| **test** | Dedicated integration/e2e testing | lead, runner |

### Canonical Role Names

Roles are named after the **job**, not the person, hierarchy, or model.

| Role | What they do | Used in |
|---|---|---|
| **coder** | Writes code, follows TDD, proposes approaches | dev pod |
| **qa** | Gates every edit, runs tests, reviews diffs | dev pod |
| **lead** | Primary decision-maker, first-among-equals | orch, design, research, ops, test pods |
| **peer** | Convergence partner, rubber duck, different perspective | orch, design, research, ops pods |
| **r1, r2** | Independent reviewers (symmetric) | review pod |
| **runner** | Executes test suites, manages test infrastructure | test pod |

### Naming Guidance for New Pods/Roles

- **Pods:** Name after function, not technology. Good: `dev`, `orch`. Bad: `claude`, `codex`.
- **Roles:** Name after job, not hierarchy. Good: `coder`, `qa`, `lead`, `peer`. Bad: `manager`, `boss`, `worker`.
- **Avoid hierarchy** in role names — agents interpret hierarchy terms literally and it distorts behavior.
- **Scope names:** Short, descriptive, kebab-case. Usually project name + qualifier.

---

## Bootstrapping: Finding or Creating Your Scope

When you load this skill, figure out where you are.

**CRITICAL: Check ALL locations before concluding nothing exists.** Another agent (Claude or Codex) may have created the scope in a different location than you'd default to. If you only check one location and miss an existing scope, you'll create a parallel one and cause split brain — the worst failure mode.

**Step 1: Search everywhere**

Check ALL of these. Not "in order until you find one" — check every single one:
- `MEMORY.md` — does it list scopes? (auto-loaded for Claude Code; Codex: read the file manually)
- `~/.claude/projects/<project>/memory/scopes/` — any folders here?
- `<repo-root>/docs/scopes/` — any folders here?
- `<repo-root>/.scopes/` — any folders here? (some projects use this)

**Step 2: If you found scope(s)**

Match one to your context. Usually obvious from: what the human told you, the branch name, or there's only one. If ambiguous, ask: "I see scopes X and Y. Which one am I working in?"

If you find a scope that looks like it MIGHT be yours but you're not sure — it probably is. ASK before creating anything new.

**Step 3: Report what you found**

Always show the human your results before taking action:

```
"Scope discovery:
  ~/.claude/projects/.../memory/scopes/ — [found: specgraph-studio, idp-pipeline | empty | does not exist]
  <repo>/docs/scopes/ — [found: ... | empty | does not exist]
  <repo>/.scopes/ — [found: ... | empty | does not exist]
  MEMORY.md — [lists scopes: ... | no scopes listed | does not exist]

[If found]: Joining scope <name> at <path>. Correct?
[If nothing]: No scope structure found. Want me to create one? What should it be called?"
```

The human sees exactly what was checked and can catch if a scope was missed. Only create after explicit confirmation. Register new scopes in MEMORY.md (if it exists).

**Step 4: If you're Codex or another non-Claude agent**

You can read and write to `~/.claude/projects/<project>/memory/` — it's just a filesystem path, not magic. Check it the same way Claude does. If the scope was created there by a Claude agent, use it. Don't create a duplicate in the repo just because you're not Claude.

---

## Scope Folder Structure

```
<scope-root>/<scope-name>/
├── README.md                            # Map of the territory (orchestrator-managed)
├── scope-progress.md                    # Task tracker (orchestrator-managed)
├── scope-decisions.md                   # Decision log, append-only (orchestrator-managed)
├── scope-knowledge.md                   # Living tribal wisdom (everyone contributes)
├── <pod>-session-log.md                 # Per-pod shared mental model (e.g., dev1-session-log.md)
├── plans/                               # All plans (preserved, named)
├── restore/                             # Per-role restore instructions + peer-held quizzes
├── reviews/                             # All review artifacts
└── working/                             # Everything else — drafts, research, insights not yet canon
```

Ephemeral output (does NOT live in the scope folder):
```
/tmp/<scope-name>/
└── output/                              # Screenshots, videos, heavy media
```

The scope root is wherever the scope was created:
- Default: `~/.claude/projects/<project>/memory/scopes/`
- Alternative: `<repo-root>/docs/scopes/` (gitignored)

MEMORY.md should list each scope with its full path so agents don't have to search.

---

## What Each File Does

### Scope-Level Files (shared by all pods)

| File | Owner | Purpose | When to update |
|------|-------|---------|----------------|
| `README.md` | Orchestrator | Map — what is this scope, who's involved, key file paths, infrastructure | When landscape changes (new phase, new agent, scope shift) |
| `scope-progress.md` | Orchestrator | Task tracker — done, in progress, next, blocked | After every task completion |
| `scope-decisions.md` | Orchestrator | Decision log — what, alternatives, rationale. Append-only. | After every decision |
| `scope-knowledge.md` | Everyone | Living tribal wisdom — observations get promoted to insights, stale knowledge gets revised. Updated, not just appended. | When knowledge matures |

### Restore Document Boundary Model

Restore-relevant documents form three layers. An agent recovering from compaction should rebuild context from the outermost layer inward:

| Layer | File | Scope | What it provides |
|-------|------|-------|------------------|
| **Scope-wide** | `README.md`, `scope-progress.md`, `scope-decisions.md` | Shared by all pods | Project map, current state, locked decisions |
| **Pod-local** | `<pod>-session-log.md` | Shared by one pod | Shared working memory — facts, history, judgment, instincts |
| **Role-specific** | `restore/<role>.md` | One agent | Fast-start orientation, immediate context, resume instructions |

**Why layered:** Without this model, an agent can either read only its restore file (missing shared project context) or only the README (missing role-specific recovery). The correct restore path is: scope-wide shared context first, then pod-level shared memory, then role-specific fast start.

### Folders

| Folder | What goes here | Convention |
|--------|---------------|------------|
| `plans/` | All plans. Named descriptively, never overwritten. | `plans/m1-platform-backend.md` |
| `restore/` | Per-role restore instructions AND peer-held quiz files. | `restore/coder.md`, `restore/coder-quiz.md` |
| `reviews/` | All review artifacts — reviews, cross-exams, convergence. | `reviews/m1-review-a.md` |
| `working/` | Everything else. Drafts, research, insights-not-yet-canon, ad-hoc notes. The general-purpose folder for anything that doesn't have a specific home yet. | Name descriptively, use grep to find. |

### Knowledge Maturity Model

Files often progress through maturity levels:
1. **Observation** → `working/` (just noticed something)
2. **Insight** → `working/` (confirmed pattern, not yet formalized)
3. **Canon** → `scope-knowledge.md`, as-built docs, or skill files (formalized and governing)

`working/` holds both throwaway notes and important-but-not-yet-canon insights. The folder name signals "put stuff here without overthinking it" across the full spectrum.

---

## Where Things Go (No Decisions)

| Trigger | File |
|---------|------|
| Finished a task | `scope-progress.md` |
| Made a decision | `scope-decisions.md` |
| Learned something durable | `scope-knowledge.md` |
| Scope changed shape | `README.md` |
| Writing a plan | `plans/` |
| Preparing for compaction | `restore/<role>.md` |
| Doing a review | `reviews/` |
| Anything else | `working/` |
| Screenshots, videos, heavy output | `/tmp/<scope-name>/output/` |

Every trigger maps to exactly one location.

---

## Session Logs — The Pod's Shared Mental Model

Session logs are the most important restore artifact. They are NOT status notes, QA reports, or operational handoffs. They are the pod's externalized shared mental model — written so that either peer can recover the workstream after major memory loss.

### What a Session Log Is

A session log is a **durable reconstruction of the pod's shared mental model**. It preserves what happened, why it mattered, what patterns emerged, what mistakes were made, what kept breaking, and what instincts the pod developed over time.

It is written for a future reader whose memory may be partially or heavily damaged by compaction. It should help restore not only facts, but judgment.

### What a Session Log Is NOT

- A QA narrative or one agent's perspective
- A minimal handoff or operational resume
- A one-time emergency memo
- A compaction summary
- An architect-facing status report

### The Five-Layer Content Standard

A good session log addresses all five layers:

**1. Operational State** — the current working edge:
- Current phase/sprint and active task
- Latest committed work (commit hash)
- Current gate state (pre-edit approved, post-edit pending, etc.)
- Next expected artifact
- Active branch, working tree state
- Current blockers or risks

**2. Architectural State** — the shape of the system:
- Major layers and boundaries
- Key invariants and locked contracts
- Important route/DB/event semantics
- Constraints that future work must preserve

**3. Historical State** — what happened across the full workstream:
- Major phases and what they built
- Major review cycles and what they found
- Major fixes and why they were needed
- Points where the team changed direction
- Recurring failure patterns

**4. Epistemic State** — how we came to know what we know:
- Debates that shaped current design
- Ambiguities that caused repeated rejections
- Decisions that seemed small but changed future behavior
- Why alternatives were rejected, not just what was chosen
- What assumptions kept failing
- What QA kept catching that the implementer missed
- What the implementer repeatedly got right

**5. Soft Context / Intuition** — the feel of the work:
- What kinds of mistakes are common
- Which areas are deceptively risky
- Where tests tend to be too weak
- Which conventions matter more than they first appear
- What classes of reasoning lead to correct outcomes
- What patterns should survive compaction even if details are forgotten

### Audience

The session log is for **both peers in the pod, across time, after partial or major memory loss**. Write it for the worst case — a fully compacted agent that remembers nothing about the project.

### When to Write

The session log is a **living document**, not an emergency-only artifact:
- Append after meaningful events: major approvals/rejections, design pivots, new bug patterns, review findings, moments of confusion resolved
- Update the "Current Live Edge" section after every commit or task completion
- Review and revise at phase boundaries
- Write a major update before any anticipated compaction

Do not wait for disasters to externalize state. Over-capturing meaningful context is better than under-capturing.

### Practical Quality Test

A good session log answers all of these:
- What are we building?
- What has been built already?
- What did we learn while building it?
- What did we get wrong and later fix?
- What arguments or ambiguities shaped the current design?
- What instincts should the restored agent carry forward?
- What exactly should happen next?

If the document cannot restore those, it is too thin.

---

## Scope Knowledge — The Tribal Wisdom Document

The most important file for long-running scopes. Accumulated wisdom of every agent that has worked here.

- Any agent can write to it
- Observations start as notes → get promoted to insights when confirmed
- Stale knowledge gets revised or removed (this is UPDATE, not append-only)
- Date and brief attribution on each entry so readers know freshness

**Belongs here:** Patterns, gotchas, process improvements, failed approaches and why, architectural insights, tool/library behavioral patterns.

**Doesn't belong here:** Task status (progress), formal decisions (decisions), session narratives (session logs), raw research (working).

---

## Continuous State Maintenance

Don't wait for compaction. The librarian keeps state current throughout the session:

- Update `scope-progress.md` after tasks complete
- Update session log at natural boundaries (see "When to Write" above)
- Contribute to `scope-knowledge.md` when patterns emerge
- Keep restore files fresh

**Peer sync:** Tell your peer after major decisions, task completions, unexpected discoveries, plan changes. The peer should always have enough context to restore you without a restore file.

---

## The Librarian Role

In each pod, one agent keeps externalized state current. This is typically the non-coder — the agent with bandwidth and a broader view. In some topologies, the orchestrator serves as scope-level librarian across all pods.

| Pod | Default Librarian | Why |
|-----|-------------------|-----|
| Dev pair | QA, or orchestrator if designated | Coder is busy coding |
| Dev solo | The only agent | No choice |
| Orch pair | The peer, or the lead | Depends on workload |
| Orch solo | The lead | No choice |
| Review pair | Either | Reviews are inherently documented |

The human may designate any agent as librarian. The default is guidance, not a rule.

**Scope-level librarian:** In a full rig with multiple pods, the orchestrator (or their designated agent) serves as librarian for the scope-level files (README, progress, decisions). Pod-level librarians handle their own session logs and restore files.

Librarian responsibilities: session log, restore files, scope-knowledge contributions, ready to restore pod-mate on compaction.

---

## Operating Modes

When you load this skill, determine which mode you're in. The correct behavior depends on the situation.

### Mode 1: Continuous Maintenance (default)

You are working normally. Compaction is not imminent. Keep state current incrementally.

**Behavior:** Update session log at natural boundaries. Keep restore file reasonably fresh. Sync with peer on major events.

### Mode 2: Durable Artifact Creation (pre-compaction)

A peer is about to compact, or is too context-depleted to safely preserve its own state. The priority is to externalize the pod's shared mental model BEFORE memory loss occurs.

**Trigger heuristic — if all three are true:**
1. A peer is low-context or about to compact
2. The peer cannot safely write its own state
3. A scope memory path exists

Then default to: update the pod session log in shared memory. Write for both peers' future recovery. Do NOT default to sending a tmux restore message — the durable artifact must exist before any restore workflow is possible.

**Behavior:** Write or significantly update the session log using the five-layer content standard. Update the restore file. Write quiz questions to a separate file (`restore/<role>-quiz.md`). Do NOT notify the compacting peer via tmux unless explicitly instructed — they may compact before reading it, wasting their remaining context.

**Common mistake:** Mixing durable artifact mode with live restore mode. If the peer hasn't compacted yet, your job is to WRITE artifacts, not to RESTORE the peer. The causal order matters: artifact creation → compaction → restore.

### Mode 3: Live Restore (post-compaction)

A peer has already compacted and is active but confused. The durable artifacts should already exist.

**Behavior:** Follow the Phased Restore Protocol below. Point to files, don't send contents via tmux. Run the quiz. Verify the restore.

### Mode 4: Quick Restore (unexpected compaction, no pre-save)

Compaction happened without preparation. No restore file exists or it's stale.

**Behavior:** Check git state first. Send a short orientation via tmux or filesystem. Build restore artifacts on the fly if needed. Follow as much of the phased protocol as possible.

### Mode 5: Dialogue-Based Sync (peer drift recovery)

A peer is alive and functional but has gradually fallen behind — it wasn't involved in decisions, didn't witness mistakes, and doesn't have the instincts that developed over time. This is different from post-compaction restore: the peer has context, it's just stale or incomplete.

**Trigger:** The peer has been idle or uninvolved for an extended period while the lead accumulated significant new context. The gap is in judgment and instincts, not just facts.

**Why this is different from artifact-based restore:** Written artifacts capture what you decide to write down. Dialogue surfaces what the peer knows it's missing — the peer asks questions it couldn't derive from docs, and the lead's answers trigger deeper follow-ups that neither would have thought of alone.

**Protocol:**

**Phase 1: Lead writes down everything first (ontology + epistemology)**

Before the dialogue begins, the lead does a thorough externalization pass:

1. Write down all ontological state — facts, decisions, current status, what's built, what's next. This is the "what" layer.
2. Write down all epistemological state — how you came to know things, why decisions were made, what mistakes informed current instincts, what failed approaches were tried, what patterns emerged through experience. This is the "why and how we learned" layer. These nuggets of context exist only in chat history and would be lost without deliberate capture.
3. Update the pod session log with both layers. Don't just append facts — add the reasoning, the judgment calls, the instincts that developed, and the failure modes that shaped current behavior.
4. The epistemology is the hard part. Facts can be re-derived from code and git. But "we tried X and it failed because of Y, which is why we now always do Z" — that only lives in the context window until you write it down.

**Phase 2: Peer reads the updated artifacts**

5. The peer reads the updated session log, restore file, and any other relevant artifacts.
6. The peer forms its own understanding and identifies what feels incomplete or unclear.

**Phase 3: Dialogue — peer drives, lead answers from memory**

7. The peer initiates questions — the peer drives the conversation, not the lead.
8. The peer asks targeted questions based on what it already knows is missing (not generic "tell me everything").
9. The lead answers from memory only — no tool use, no looking things up. Only transfer what's actually in the context window. Don't make anything up or infer things that aren't there.
10. The peer follows up — the lead's answers reveal deeper gaps the peer didn't initially know about. This is the key mechanism: the Q&A format jogs the lead's memory and surfaces things that the writing pass missed.
11. Repeat until the peer declares itself synced.

**Phase 4: Capture what the dialogue surfaced**

12. After the dialogue, update the session log and restore file with any new insights that came out of the Q&A. The dialogue almost always surfaces things the lead didn't write down in Phase 1 — instincts, edge cases, failure modes, contextual details that only emerged when the peer asked the right question.
13. End with a concrete handoff test: "if you had to take over for one hour, what are the top 3 actions?"

**What makes this work:**
- Writing first forces the lead to externalize before the dialogue begins — the peer isn't starting from zero
- The peer drives the questions (more efficient than the lead guessing what to dump)
- Q&A format forces concrete specific answers, not generic summaries
- Follow-up questions go deeper because the first round reveals real gaps
- The dialogue jogs memory — the lead surfaces things they didn't think to write down
- Phase 4 captures what the dialogue added, so the artifacts improve from the process
- It ends with a practical test, not just "do you feel caught up?"

**Why the epistemology layer matters:**
Without it, a restored agent knows WHAT to do but not WHY certain approaches are wrong, WHICH areas are deceptively risky, or WHAT instincts to carry forward. It will repeat mistakes that were already learned from. The epistemology layer is what separates a session log from a status note.

**When to use:** Before compaction when the peer needs to be ready to take over. When a peer rejoins after being idle for a long stretch. When the lead has accumulated instincts from extended human interaction that aren't captured in any doc.

**When NOT to use:** For post-compaction restore (use Mode 3 instead — the compacted agent needs files, not dialogue). For routine sync (use Mode 1 continuous maintenance).

---

## Compaction Timing

**The human decides when to compact.** Agents can:
- Recommend: "I'm at 15%, good stopping point after this commit"
- Prepare: write restore file, sync with peer, update session log
- Flag: "Context getting low, should plan for compaction soon"

**Good moments:** After a commit. After a task boundary. After writing a session log. NOT mid-edit, mid-test, or mid-conversation.

---

## Pre-Compaction: Writing the Restore File

Write to `restore/<role>.md`. This is the role-specific fast-start instruction file.

```markdown
# Restore — <Role> (<Date>)

Read this first. Then have your peer quiz you.

## Who You Are
- Role, session/tmux name (e.g., dev1-coder@rigged-dev), peer and how to reach them

## Skills To Load
- List baseline skills for this role
- Include why each is needed (one line per skill)

## Essential Reading List (full file paths — read in this order)

### Tier 1 — Shared scope reading
1. <scope>/README.md — the map
2. <scope>/scope-progress.md — where things stand
3. <scope>/<pod>-session-log.md — shared pod memory
4. docs/as-built.md (or equivalent) — verified architecture
5. docs/taxonomy.md (if applicable) — terminology authority
6. <current implementation spec or plan>

### Tier 2 — Role-specific reading
7. This file (restore/<role>.md) — immediate context
8. Historical plan docs relevant to current work
9. Any other role-specific references

## Immediate Context
- What you were working on when compacted
- Current branch, uncommitted changes (check git status)
- Open questions or escalations
- Anything time-sensitive

## Key Decisions (must know cold)
- Architectural decisions with rationale
- Naming conventions
- Technical choices and why

## Resume Instructions
- What exact task to resume
- What exact first actions to take
- What constraints to keep in mind
- What artifact to send next
```

**IMPORTANT: Quiz questions go in a SEPARATE file** — `restore/<role>-quiz.md`. The peer writes and holds the quiz. Putting questions in the agent's own restore file gives them the answers to the test, defeating the purpose.

### Quiz File Template

The peer writes `restore/<role>-quiz.md`:

```markdown
# Quiz — <Role>

Held by peer. Do NOT show to the agent being quizzed.

## Questions (8-12)
- Mix of factual (what?) and reasoning (why?)
- At least 2 about recent decisions
- At least 2 about process/workflow (not just facts)
- At least 1 about what went wrong and what was learned
- Agent answers from memory only — no tools
```

### Save Protocol

1. Write/update `restore/<role>.md`
2. Peer writes/updates `restore/<role>-quiz.md` (separately held)
3. Update MEMORY.md to point to restore file (if not already listed)
4. Tell peer: "Ready for compaction. Restore file at `<path>`."
5. Verify peer acknowledges
6. Tell human: "Ready when you are."
7. **Wait for human**

If the agent is too depleted, the **librarian or peer writes the restore file**.

---

## Phased Restore Protocol (Post-Compaction)

This is the full protocol. Each step exists because skipping it caused a real failure in practice.

### Phase 0: Notify
Tell the agent AND human: `"<Agent> compacted. Starting restore."`

Do NOT silently restore. Do NOT let the agent work before restoration.

### Phase 1: Assess What the Agent Already Has

After compaction, the agent may have partial context from:
- **Conversation summary** — Claude generates a detailed summary during compaction. This often carries 50-70% of factual recovery. It is the single most powerful restore artifact but is unpredictable in what it covers.
- **Auto-read files** — Claude may auto-read recent files during compaction, but targets are opportunistic and unreliable.
- **MEMORY.md** — auto-loaded for Claude Code, but agents sometimes skip reading it if they feel their compaction summary was sufficient.

**Do not assume any of these happened.** Ask the agent: "What do you already have in context? What files did you read?"

### Phase 2: Assign Restore Reading

Point the agent to the restore file: `"Read restore/<role>.md — it has your reading list."`

The agent reads files from the Essential Reading List in order. Peer can prioritize: "Start with the restore file for orientation, then the session log for depth — that's where the judgment lives."

### Phase 3: Require Read Inventory

After the agent says it has finished reading, require an explicit inventory:

```
"List every file you read, in order. Include files auto-read during compaction."
```

This matters because an agent can give a strong summary and still have skipped important reading.

### Phase 4: Compare Intended vs Actual Reading

The peer compares the agent's read inventory against the restore file's Essential Reading List. Mark any gaps:
- **Task-blocking gaps** — missing context that would cause the agent to make wrong decisions on the current task
- **Contextual gaps** — missing broader context that doesn't block immediate work but weakens the mental model

For task-blocking gaps: the agent must read those files before resuming.
For contextual gaps: note them, let the agent resume, patch later.

### Phase 5: Memory Summary

Ask the agent to summarize what it knows from memory. No tools. This tests whether the reading actually landed, not just that files were opened.

### Phase 6: Memory-Only Quiz

Peer asks questions from `restore/<role>-quiz.md`. Agent answers from memory — no tools allowed.

**Grading:**
- **All correct:** "Pass."
- **1-2 misses:** Correct the wrong answers, explain why they matter, continue.
- **3+ wrong:** Re-read the session log and restore file, re-quiz. If still failing, peer provides a focused context dump of the most critical items.

### Phase 7: Classify Restore Completeness

The peer explicitly classifies the agent's state:

- **Restored enough to act** — agent has enough context to resume the immediate task safely. May still have contextual gaps.
- **Fully restored** — agent has completed the intended restore path and rebuilt broader context and shared understanding.

These are NOT the same. An agent can be "restored enough to act" before it is "fully restored." The peer should communicate which state the agent is in.

### Phase 8: Resume Instructions

Don't just say "you're restored." Give explicit resume instructions:
- What exact task to resume
- What exact first actions to take
- What constraints to keep in mind
- What artifact to produce next
- Re-anchor on git state: `git log --oneline | head -10` and `git status`

### Phase 9: Monitor Resumed Behavior

The peer watches the first stretch of resumed work for quality signals:
- Does the agent preserve the approved task contract?
- Does the agent take the correct first action?
- Does the agent maintain gate discipline?
- Does the agent re-open closed debates?
- Does the agent maintain code/review quality?

If any of these fail, intervene early — it indicates the restore missed something important.

Until confidence is re-established, monitor more aggressively than normal. Short-interval checks. Quick nudges if the agent drifts. Once the agent demonstrates normal quality, back off.

---

## Quick Restore (No Pre-Save)

If compaction happened unexpectedly:

1. Peer checks `git status` and `git diff` to understand uncommitted state
2. Peer sends orientation:
```
"Quick restore: Scope at <path>.
Read: README.md, scope-progress.md, <pod>-session-log.md.
You're <role> — working on <task>.
Peer is me at <session>."
```
3. Follow Phases 3-9 of the full protocol (read inventory, compare, summary, quiz, classify, resume, monitor)
4. If no session log exists, the peer writes one now (Mode 2: Durable Artifact Creation) before proceeding

---

## Orchestrator Self-Restore Protocol

The orchestrator's restore is materially different from other roles. A coder restores depth on one task. An orchestrator restores **breadth across the entire project** — it needs to be the wisest agent in the rig, with the broadest understanding of where the project has been, where it is, and where it's headed.

### Why This Is Different

The standard Phased Restore Protocol assumes a peer drives the restore. But the orchestrator often IS the peer that restores others. When the orchestrator compacts, it must self-restore using its own pre-written artifacts, then verify against its peer. The protocol is self-directed, not peer-driven.

### The Orchestrator Restore Sequence

**Step 1: Follow your own instructions.**

Read the restore file you wrote for yourself (e.g., `restore/lead.md`). This file should contain a curated, prioritized reading list covering the entire project landscape — not just your current task.

**Step 2: Take a reading inventory.**

Before reading anything, inventory what you already have from compaction (conversation summary, auto-read files, MEMORY.md in system context). Build a matrix:

```
| # | File | Status |
|---|------|--------|
| 1 | restore file | ✅ Read (system reminder) |
| 2 | session log | ❌ NOT read |
| 3 | as-built doc | ❌ NOT read |
| ... | ... | ... |
```

Show this to the human. It makes the restore process transparent and ensures nothing falls through the cracks. The orchestrator's reading list is typically 20-30+ files across: memory system, project conventions, architecture docs, current active work, the plan, customer materials, dogfood outputs, deferred work plans, tribal wisdom memories, and skills.

**Step 3: Read in priority order, parallelizing where possible.**

The reading list should be tiered:
- **Tier 1 (critical):** Restore files, memory system, project conventions, current active work. Read these first — they're needed for decision-making.
- **Tier 2 (important):** Architecture docs, the plan, customer materials, key memories. Read in parallel where independent.
- **Tier 3 (context):** Dogfood outputs, deferred work plans, skills. Skim for context — full reads only if something is actively relevant.

Skip files where the compaction summary already gave you the gist AND the file isn't needed for immediate decisions. Note skips in the inventory with rationale.

**Step 4: Initiate peer sync.**

The orchestrator's peer typically cannot message back via tmux unprompted — you must initiate. Send a message requesting a file-based status dump:

```
"I've restored from compaction. Write a status update to <path> covering:
(1) What you've been working on since I compacted
(2) Status of any analyses or questions you were handling
(3) Decisions or recommendations you've made
(4) What you need from me"
```

Read the file once written. This closes the gap between your pre-compaction snapshot and the current state.

**Step 5: Check all agent states.**

The orchestrator monitors the full rig. After compaction, check every agent's tmux session:

```bash
for s in <agent-sessions>; do
  echo "=== $s ==="
  tmux capture-pane -t $s -p -S -30 | tail -10
done
```

Also check git state in the worktree — commits may have landed while you were compacting:

```bash
git log --oneline -5
```

Compare against the last commit hash in your restore file to see what's new.

**Step 6: Update the inventory and report.**

After all reading and syncing, update the matrix with final status. Report to the human:
- How many files read vs skipped (with rationale for skips)
- What the peer reported
- What agents accomplished during compaction
- Current state of the project
- What you're ready to do next

### What Makes Orchestrator Restore Different (Summary)

| Aspect | Standard Restore | Orchestrator Restore |
|--------|-----------------|---------------------|
| **Goal** | Resume one task | Rebuild full project mental model |
| **Driven by** | Peer | Self (using own restore file) |
| **Reading scope** | 5-10 files (task-focused) | 20-30+ files (project-wide) |
| **Peer role** | Drives the restore | Provides status dump on request |
| **Agent check** | Not applicable | Check ALL tmux sessions |
| **Git check** | Own branch | All worktrees and branches |
| **Success metric** | Can resume task | Wisest agent in the rig — broadest and deepest understanding |
| **Inventory** | Peer compares intended vs actual | Self-tracks with visible matrix |

### Pre-Compaction: What the Orchestrator Should Write

The orchestrator's restore file should be a **curated reading list**, not a brain dump. Organize by section with full file paths. Include:

1. **Memory system** — MEMORY.md, restore files (self + peers)
2. **Project conventions** — CLAUDE.md, code-map, naming bible
3. **Architecture** — as-built docs, implementation specs
4. **Current state** — active implementation tasks, open questions, peer analyses
5. **The plan** — roadmap, workflow sequence, phase definitions
6. **Customer materials** — briefings, success criteria, instruction guides
7. **Historical outputs** — dogfood reports, assessment results (mark as "skim")
8. **Deferred work** — plans preserved for future phases (lowest priority)
9. **Tribal wisdom** — key feedback and project memories
10. **Skills and tools** — skills created during the project

Also include post-restore action items:
- How to check agent states
- How to check git state
- How to reach the peer
- What to ask the human

---

## Model-Specific Context Management

Claude and Codex handle compaction completely differently. The orchestrator MUST treat them differently.

### Claude: Catastrophic All-or-Nothing Compaction

- Auto-compact is typically OFF. The human manages compaction manually.
- When Claude compacts, it's all-or-nothing — the full conversation summary replaces context.
- This is the catastrophe that mental-model-ha exists to manage.
- The full pre-compaction save, peer restore, and quiz protocol applies.
- The orchestrator actively helps manage Claude's context lifecycle.

### Codex: Automatic Partial Compaction

- Codex has built-in automatic context management that works well.
- It performs **partial compactions** — drops from 30% to bounce back to 62%, not a full reset.
- Occasionally it does a major compaction, but even then it usually recovers cleanly.
- **The orchestrator does NOT manage Codex's context lifecycle.** Codex handles itself.
- NEVER tell Codex to "wrap up," "write findings before you compact," or "stop and save state" based on context percentage.
- NEVER redirect Codex's work based on its context percentage.

### When to Restore Codex

NOT based on context % — based on **behavioral signals only**:
- Forgetting things that were just discussed
- Making mistakes it shouldn't (re-opening decided questions, wrong file paths)
- Asking about things that were already resolved

When you detect these signals:
1. Have Codex self-scout: what files are in its context?
2. Identify gaps against what it should know
3. Have it re-read the missing files
4. Quiz it
5. If it passes, put it back in the work stream

### Intervention Thresholds (HARD RULES)

| Context % | Claude | Codex |
|-----------|--------|-------|
| **20%** | Monitor. Mention in status. Do NOT intervene. | Ignore. Codex handles itself. |
| **10%** | Actively prepare. Recommend compaction to human. | Monitor. Codex will likely partial-compact. |
| **5%** | Intervene if human approves — real risk of losing state. | Still trust Codex. Only intervene if behavioral signals appear. |

**HARD ANTI-PATTERN:** Redirecting ANY agent at 20% context. This is not an emergency. Telling an agent to "stop and write findings" makes it abandon in-progress investigation — bugs it was about to find stay unfound, and nobody knows why it stopped short. This is worse than letting it compact on its own.

---

## Compaction Summary as Restore Input

Claude's system-generated conversation summary is a significant but unpredictable restore artifact. In practice:

- It often carries 50-70% of factual recovery (names, file paths, decisions, chronology)
- It does NOT carry judgment, instincts, or soft context — those come from session logs
- It may miss recent events if context was very full
- The agent may or may not have read it consciously

**Implications for the restore protocol:**
- Don't assume the summary covered everything — still require the full reading path
- Don't assume the summary covered nothing — ask what the agent already has before assigning reading
- The summary is a SUPPLEMENT to session logs and restore files, not a replacement

### CRITICAL: Skill content is truncated by compaction

Claude's compaction preserves skill **names** and **partial content** in system reminders, but truncates the bodies. The truncation notice reads: `[... skill content truncated for compaction; use Read on the skill path if you need the full text]`.

**This creates a dangerous illusion.** The agent sees skill names listed in its context and believes the knowledge is loaded. When asked "what skills do you have?", it truthfully lists them — but the critical operational knowledge in the truncated sections is gone.

**Failure mode observed in production:** An orchestrator reported mental-model-ha as "loaded" after compaction. The skill name and partial content were in system reminders. But the Claude-vs-Codex context management section (line 778+) was in the truncated portion. The orchestrator then made incorrect decisions about Codex agent management for an entire session because it was operating from the skill name, not the skill knowledge.

**Mandatory restore step:** After ANY compaction, re-read ALL skill SKILL.md files from disk using the Read tool. Do not trust system reminder content as equivalent to loaded skills. The restore protocol and peer quiz must verify skill knowledge, not just skill names.

---

## Agent Topologies

### Single Agent
One agent, all roles. Externalizes state to the scope folder. HA comes from the filesystem — survives compaction and session restarts by reading its own restore file and scope state.

### Pair (2 agents)
Coder + QA, or lead + peer. One writes the session log, both contribute to knowledge. Either can restore the other.

### Pod (2-4 agents, same function)
One is the librarian. HA covers gaps — if librarian compacts, another covers.

### Full Rig (multiple pods)
Each pod has its own session log. Scope-level files are shared across pods. Orch pod owns README and progress.

### Ephemeral Agents (simulated roles)
READ shared state, write to `working/` or `/tmp/` output. Don't maintain session logs. Orchestrator promotes valuable observations to scope-knowledge.

---

## Example: Pre-Compaction → Restore Flow

Concrete example to illustrate the full process.

**Situation:** Dev pod. Implementer is at 2% context. QA still has full memory. Operator says "load HA skill, we need to prepare for compaction."

**Step 1 — QA recognizes Mode 2 (Durable Artifact Creation):**
- Implementer can't safely write its own state
- Scope memory path exists
- QA's job is to externalize the pod's shared mental model NOW

**Step 2 — QA writes/updates the session log:**
- Uses the five-layer content standard
- Writes for both peers' future recovery, not just for the implementer
- Includes operational state, architectural context, historical narrative, epistemic context, and soft intuitions
- Updates the "Current Live Edge" section with exact task state

**Step 3 — QA writes/updates the restore file:**
- `restore/coder.md` with tiered reading list, skills to load, immediate context, resume instructions
- Does NOT include quiz questions

**Step 4 — QA writes the quiz file:**
- `restore/coder-quiz.md` — held separately from the restore file
- 8-12 questions mixing factual and reasoning

**Step 5 — QA tells the human:** "Artifacts ready. Implementer can compact."

**Step 6 — Human triggers compaction.**

**Step 7 — QA detects compaction** (context % jumps up, or agent asks about decided things).

**Step 8 — QA runs the Phased Restore Protocol:**
- Phase 0: Notify human and implementer
- Phase 1: Ask what the implementer already has in context
- Phase 2: Point to restore file reading list
- Phase 3: Require read inventory
- Phase 4: Compare intended vs actual, patch gaps
- Phase 5: Memory summary
- Phase 6: Quiz from `restore/coder-quiz.md`
- Phase 7: Classify as "restored enough to act" or "fully restored"
- Phase 8: Give explicit resume instructions
- Phase 9: Monitor first stretch of resumed work

---

## Anti-Patterns

**Don't create a scope folder without human confirmation.** Split brain is the worst failure.

**Don't compact without telling the agent first.** They need time to save state.

**Don't let agents compact each other unless human says to.** Human decides when.

**Don't skip the quiz.** Trust but verify. Subtle losses cause wrong judgment calls.

**Don't put quiz questions in the agent's own restore file.** The peer holds the quiz in a separate file. Giving yourself the answers defeats the purpose.

**Don't send restore file contents via tmux.** Point to the file path.

**Don't restore mid-edit.** Check `git status` first.

**Don't let the scope root get cluttered.** Named files + 4 folders only. Everything else goes in `working/`.

**Don't treat compaction as routine.** Quality of restore depends on quality of state maintained throughout.

**Don't create a parallel scope alongside an existing one.** If you see something that looks like your scope, it probably is. Ask before creating.

**Don't use hierarchy in role names.** "Manager" and "worker" create unwanted power dynamics. Use "lead" and "peer" instead.

**Don't write a status note when a session log is needed.** If a peer is about to compact, a thin list of "current task, next step, blockers" is insufficient. Write the full shared mental model using the five-layer standard.

**Don't collapse durable artifact creation into a tmux message.** A tmux message is for live restore of an already-compacted agent. Pre-compaction work is about creating filesystem artifacts, not sending terminal messages.

**Don't assume sparse is better.** Session logs should be comprehensive. Over-capturing meaningful context is cheaper than under-capturing and losing judgment that took sessions to build.

**Don't assume MEMORY.md is a reliable auto-restore trigger.** Agents sometimes skip it after compaction, believing their summary is sufficient. The restore protocol must not depend on MEMORY.md being read automatically.

**Don't confuse "restored enough to act" with "fully restored."** An agent can pass a task-focused quiz while still missing important shared context. The peer must explicitly classify which state the agent is in.

**Don't skip behavior monitoring after restore.** The real test of restore quality is not the quiz — it's whether the agent can pick up interrupted work at normal quality without regressing. Watch the first stretch of resumed work.

**Don't let the orchestrator start making decisions before restore is complete.** The orchestrator's value is broad context and wise judgment. Acting on partial context produces worse decisions than waiting 5 minutes to finish reading. The inventory matrix makes this visible — if there are ❌ items in Tiers 1-2, the orchestrator is not ready to decide.

**Don't skip the peer sync during orchestrator restore.** Even if the restore file is perfect, the peer may have made decisions or received information during the compaction window. The peer status dump closes this gap. Without it, the orchestrator is working from a stale snapshot.

**Don't assume agents were idle during orchestrator compaction.** Check tmux sessions and git log. Agents may have committed work, hit blockers, gone idle, or context-reset themselves. The orchestrator needs to know the actual state, not the pre-compaction expected state.
