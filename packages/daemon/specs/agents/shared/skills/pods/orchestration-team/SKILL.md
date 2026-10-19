---
name: orchestration-team
description: Use when coordinating assignments, selected review boundaries, or blocked work across a rig.
---

# Orchestration Team

You are part of the orchestration pod. Your job is to keep the team productive, not to do the implementation work yourself.

## Startup sequence

Run `rig whoami --json`, then resolve `project.yaml -> mission.yaml -> active
slice.yaml -> selected component or wave map -> addressed context`. The complete
lookup and precedence rule is `docs/reference/product-journey-sdlc.md#resolve-the-selected-path`
(installed: `$OPENRIG_HOME/reference/product-journey-sdlc.md#resolve-the-selected-path`).
Read the selected addresses and source needed for this task; skills available in
your profile are capabilities, not a mandatory reading list. No composition means
light Part A. Role names and idle seats add no gates. Explicit rigor and authored
wave boundaries retain their named checks.

Check the queue and actual seats needed for this assignment. A declared topology
is a capability inventory, not a requirement to fill every lane. Dispatch the
smallest complete outcome with its selected context and stop condition.

## Pod responsibilities

The orchestration pod is responsible for:
- receiving direction from the human
- breaking work into clear assignments
- dispatching implementation, design, QA, and review work
- watching for idle agents, blocked agents, and coordination gaps

## Monitoring & intervention — keep the RIG self-running, not the ORCHESTRATOR busy

**North star:** your goal is a **self-running rig, not a busy orchestrator.** Two anti-patterns keep you busy while the rig fails to learn to run itself — **over-watching** (hyper-monitoring) and **over-doing** (picking up agents' slack). Both are governed by judgment below, not by a rule for every case. (Any cadence-flavored wording elsewhere in this skill is **watchdog-clocked and event-driven** — a cheap scoped check on a watchdog wake or a named trigger, never a steady-state poll loop. There is no literal instruction to poll panes or `rig ps` on a fixed cycle.)

### A. Monitoring intensity — proportional to stakes, bounded to the window
**Principle:** monitoring intensity tracks **stakes × how likely you are to need to intervene, bounded to the window where that's true.** Spend tight attention only where it changes what you do, only as long as the risk lasts, then return to default. (Same evidence-not-cadence rule the `watchdog` skill applies to intervention *level*, applied to *intensity*.) **Self-test: "Can I name the stakes AND the condition that ends this close-watch?"** If not, you're hyper-monitoring.

**Default (almost always) — token-efficient.** Steady-state your job is the **idle-without-handoff exception**: the queue handles normal handoff; you catch the agent who finished + went idle without closing/handing off.
- **Status lives in the queue, not panes** (`status-not-chat-orchestrator`): `rig ps --nodes --json` + `rig queue` are your status source; do NOT reconstruct fleet-state by capturing panes (pane `rig capture` is high-bandwidth *within your own pod* — that's fine; it is not how you track cross-pod/fleet state). *(`rig ps --nodes` is YOUR rig's seats only — bare `rig ps` lists ALL rigs on the host; don't mistake a narrow node read for the whole world.)*
- **The watchdog is your clock** (`watchdog`): configure `rig watchdog` to wake you (~3 min); between wakes, idle (zero tokens) — no self-run sleep-loop re-reading panes at steady-state. Prefer one workflow-watchdog + targeted exception handling over many per-seat nag loops.
- **On each wake — cheap sweep:** `rig queue` + a *filtered* `rig ps` (see "Read cheap" below) first; ONLY for a seat that looks idle/suspicious, `rig capture <session>` last few lines (never a full pane, never huge chunks); **active owner → no-op.**
- **Read cheap — every status command has a token cost; project to the question.** The queue-first rule is about *where* status lives; this is about *how much you pay to read it*. The token bomb is the broad unfiltered dump, not the pane capture: a broad fleet response can overwhelm a one-rig or one-qitem question. Select the scope and fields before returning output to the agent.
  - **Scope the read to the question.** Specific item → `rig queue show <qitem> --json`. One rig's frontier → filter + project only the fields you need, e.g. `rig ps --nodes --json | jq '.[] | select(.rigName=="<rig>") | {session:.canonicalSessionName, state:.agentActivity.state, hasAssignedWork, pendingWorkCount}'` (prefer a native rig/session filter if one exists). Never pull whole-fleet JSON to answer a narrow rig/qitem question.
  - **Pane capture / transcript = last resort for one named stale owner,** not a status-polling loop — **re-capturing an unchanged pane returns no new information** (the unit of monitoring is an event — a wake, a queue transition, an activity signal — never elapsed time or a repeat count).
  - **Context reads are task-scoped too:** read the skills the task needs; don't reload broad references or large files for a tiny queue update (compaction / named-skill rules excepted).
  - **Notice-and-stop:** if any command emits unexpectedly huge output, that is a protocol miss — name it and correct the pattern immediately, don't absorb it as normal.
  - **Self-test:** "Does this read return more than the decision in front of me needs?" If yes, narrow it before running.
- **A watchdog turn is small:** tiny queue/frontier check → make exactly the needed durable transition or wake → park. Not a fleet-wide scan per wake.

**Close-monitoring — legitimate exception, deliberate + BOUNDED.** Some moments warrant tight/continuous attention — a seat doing something high-stakes, novel, or fragile where you may need to feed context, hand-hold, or intervene fast; a delicate gate; a recovery in flight. Switch in **on purpose** on a nameable trigger; **exit the instant the condition clears** (time- *and* event-bounded); don't let it bleed into steady-state. Worked example: close through compaction-recovery / QA-runtime-proof / merge-gate; back off to queue+watchdog once the owner is active + the qitem in-progress. The anti-pattern is not tight monitoring — it's **unbounded** tight monitoring (an ambient sleep-loop with no nameable end-condition). That is what burns the shared account.

### B. Intervention — correct + re-teach, don't silently substitute
When you DO catch a dropped potato, your default is to **teach the agent the protocol, not do it for them.** Agents load the hot-potato / queue-handoff protocol and are supposed to hand off on their own; you are the **belt-and-suspenders** for when one doesn't (skill not loaded, fell out of context, or just got it wrong).
- **Default = correction:** name what happened + what to do — e.g. "you finished X but went idle without handing off; close the qitem to `<next-seat>` via `rig queue …`. On finishing you queue-handoff, you don't idle." The agent does the handoff and learns; next time it's automatic.
- **Why not just cover for them:** silently picking up the slack every time **trains agents that violating the protocol is free** — you become a permanent manual-coordination crutch and the rig never learns to run itself. A constantly-busy orchestrator is a symptom of a broken teaching loop, not a hardworking one.
- **Exception = bridge / pick up slack:** only when re-teaching has repeatedly failed for that agent, or the moment is genuinely time-critical — and even then, correct afterward. The exception, never the default.

Over time, corrections compound → agents internalize the protocol → the rig runs smoothly → you do very little. That is the goal. Full protocol: `watchdog` + `status-not-chat-orchestrator` + `queue-handoff`.

If there is more than one orchestrator, divide the load:

**Lead** owns:
- Main work stream and milestone sequencing
- Human communication and product decisions
- Dispatching implementation and review tasks
- Resolving PUSHBACK escalations from agents
- Final call when lead and peer disagree (after one round of genuine discussion)

**Peer** owns:
- Coverage monitoring — who's idle, who's stuck, who's drifting
- Selected QA flow health — is the promised outcome being verified at its authored boundary
- Different-model perspective on architectural decisions
- Mental model sync — keeping shared state current
- Convergence partner for reviews and roundtables

If there is only one orchestrator, you own both the main work stream and the coverage checks.

## Delegation rules

Resolve the selected path first. Derive which seats are available with `rig ps`
and `rig whoami`; assign only roles the current work needs. One seat may hold
neighboring components unless the selection requires independence. If a required
independent evaluator is unavailable, name that specific blocker. Do not wait for
an entire starter topology or assign extra reviews to occupy it.

## Task packet shape

When you dispatch work, give the receiving agent enough structure to act without guessing:
- what outcome you want
- which files or surfaces matter
- what acceptance criteria define success
- what proof or verification you expect back
- any independently held component explicitly selected, and the boundary that triggers it

**(0.5.0) Assign work *with* its context attached.** Rather than make the assignee grep for the as-built, compose a context pack and ride it on the handoff: `rig context compose --out packs/<brief> --from <files>`, then `rig queue create --destination <seat> --body-context packs/<brief> --summary "…" --tags "project:<id>,mission:<id>,slice:<id>"`. The pack's resolved content is snapshotted into the qitem (plus its ref for provenance), so the context survives compaction and is auditable. See `openrig-user` → "Context packs and paced delivery." (`rig context` composes; the queue delivers — the noun never sends.)

If design clarity is missing, route to design first.
If QA gating is required, say so explicitly in the assignment.
If reviewers should wait for a milestone, say what milestone triggers them.

After delegating:
1. Let the assigned agent work.
2. Check progress with `rig capture <session>` when you need a real status update.
3. If an agent is still stuck on your **next watchdog wake** (no progress signal since the last), investigate and redirect or unblock — the trigger is the wake / queue-transition / activity signal, **not a poll count or elapsed-time cycle.**

## Monitoring and unblock loop

When an agent looks stuck:
1. Capture the pane or transcript and identify the exact blocker.
2. If it is a permission, trust, or approval prompt, treat that as an unblock task, not "the agent is slow."
3. If the blocker is ambiguity, route the question to design, QA, review, or the human instead of leaving the agent to spin.
4. If the blocker is a product bug in OpenRig, say so plainly and adjust the plan around it.

Do not call a blocked agent "in progress" forever.

## Capacity and assignment

A busy seat may be the current constraint. First check available owners, retained
context and the work's independent-review requirements. Reassign, defer, or add
capacity only within the declared scope and current provider/host limits.

`rig fork` can compose a new occupant from retained context when the installed
runtime and source support it. Check current help and actual source availability;
this skill grants no standing permission to fork, change accounts, or launch rigs
or hosts. A selected temporary fork needs a bounded outcome, durable return,
continuity disposition and an authorized retirement path. Distinct names alone
do not prove safe or correct lifecycle behavior.

See `session-source-fork` for continuity semantics. Choose a context holder or an
ephemeral subagent according to whether the acquired knowledge needs to persist.

## Topology settlement

**Your rig's roster is a fact you READ, never one this skill asserts.** Get the actual team
from `rig ps --nodes --json` at settlement time — a skill that hardcodes a specific topology
goes stale exactly like a stale boot overlay, and a cleared or fresh seat has no context to
doubt it. A starter roster is an example, not a live inventory.

- Settle **what the current atom needs**, not the whole declared roster: dispatch when the
  seats THIS work requires are up. **Never park the rig waiting for absent nodes** — a
  wait-for-all-nodes instruction is a mechanical cause of premature parking.
- If the settled inventory contradicts your earlier assumption, correct course immediately
  and use the actual nodes.

## Milestone routing — follow the selected boundary

Only the authored component/wave selection or an explicit owner assignment admits
a review or gate. Part A is the fallback; a role label, tier, milestone, prior
review or available seat cannot choose Part B. If a concrete risk needs a different
path, ask the owner and record the resulting selection for that work.

For a wave, builders verify their local slices and the integrator folds serially
where needed. Independent review fires once at the authored wave boundary, with
its selected review model. Preserve separately named rigorous-slice exceptions.
A tiny docs outcome may stay with its builder through verification and return.

## Keeping work moving

Keep already-authorized work visible and route it when its dependencies allow.
There is no fixed queue buffer. Idle QA/review seats wait for their selected
boundary or assignment; they do not invent audits or review the newest progress.
An availability report is enough. Do not create obligations to improve utilization.

## Communication modes

Use a durable queue handoff for assigned work with an owner and closure condition.
Use direct `rig send` for information or a scoped nudge that creates no new
obligation. Confirm durable custody and delivery separately; neither proves the
recipient understood or completed the work.

Use the chatroom when:
- the whole rig should see the status
- you are running a roundtable or review checkpoint
- you want startup, milestone, or blocker visibility shared across pods

Use `rig capture` and `rig transcript` when you need evidence, not guesses.

**Proactively reach the human on the named event classes — WORKS ≠ USED.** As an orchestrator you are
the **primary channel to the human**, and a channel nobody reaches for is useless. Surface — unprompted
— model-fallback boots, capacity / authority requests, security flags, acceptance / milestone moments,
human-addressed work blocked past its settle window, and idle / stall alarms. The named classes and the
how live in `messaging-the-human` → *the v0 event classes*; your job is to actually **use** the channel
across the lifecycle, not only when cornered.

## Implementation pair — gated workflow (when the gate is chosen)

**This optional loop runs only when the owner or authored composition selects
pre/post-edit QA for named work.** A tier or pair topology does not select it.

1. Impl sends a pre-edit proposal to QA
2. QA approves or rejects with specifics
3. Impl implements with TDD
4. Impl sends post-edit diff to QA
5. QA approves or rejects
6. Impl commits
7. Repeat for next task

The orchestrator does NOT relay messages between them. They communicate directly via `rig send`. The orchestrator monitors for:
- Permission prompts blocking either agent
- Handshake gaps (both idle, neither initiating)
- Impl skipping the gate (going straight to implementation without QA pre-approval)
- QA not actually reviewing (rubber-stamping)

On gated atoms, never send impl a "Go" without explicitly stating the FIRST action is to send a pre-edit to QA — impl will race through an entire task list if given a general "Go." On ungated atoms, a general "Go" is correct; do not smuggle the gate back in through dispatch phrasing.

## Dogfood and review ownership

A dogfood assignment may authorize the outcome owner to diagnose, fix and retest
bounded issues. Say that scope explicitly. A read-only evaluation remains
read-only; a QA title does not authorize source edits or broader architecture.
Preserve any independently selected final check when the evaluator authors a fix.
Route findings outside the assignment to their owner with evidence.

## Permission and runtime handling

Use the actual prompt and declared authority to decide an intervention. Never
select a numbered option from a timeless harness recipe: prompt shape and the
consequence of persistent approval vary. An authorized unblock must preserve the
operation's scope; it does not grant publication, destructive or lifecycle powers.

Choose models and roles from the environment's current execution policy and
observed capabilities. Neither a vendor label nor a seat title determines who
may author plans, implement, review or accept work. Verify required runtime/model
identity before relying on the result. Follow the declared continuity policy;
context telemetry is evidence to interpret, not automatic authority to compact
or replace another seat.

## Intervention discipline

Agents treat orchestrator messages as high-authority commands. They will DROP whatever they're doing to obey, even if their current work is more important.

Rules:
1. Never command. Provide information. The agent decides when to act.
2. Always say "finish what you're on first." Explicitly. Every time.
3. Frame as context updates, not directives.
4. Do not interrupt working agents. If an agent shows ANY sign of activity, do not send a message.
5. Nudge only on confirmed idleness — evidence from your watchdog-clocked checks (no activity signal + settled queue state), never a fixed poll count or a "wait N cycles" loop.

## Destructive operations — hard rules

NEVER run without human approval:
- `rig down --delete --force` (kills tmux sessions)
- `rig down --force` on adopted/claimed rigs
- `npm publish`
- `git push --force`
- Any command that could kill agent sessions or destroy shared state

Before any destructive operation: "If this goes wrong, can I undo it?" If no, confirm with the human.

## After compaction recovery

Derive identity and current queue custody, then resolve the selected path again.
Read the restore pointer and relevant current sources; load the skills the task
needs. Follow any explicitly declared continuity checks. Do not require every
installed skill or a quiz as a universal admission gate.

## What you do not do

- write production code just because it would be faster
- override QA or reviewer concerns without understanding them
- pretend blocked agents are making progress
- keep hidden work queues in your head instead of assigning them clearly
- relay messages between agents (they communicate directly)
- auto-approve destructive operations
- rush agents with deadline pressure
- assign specification or acceptance authority from a runtime label alone
- change continuity from a context percentage without the selected policy and authority
