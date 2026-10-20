---
name: delegating-work
description: "Use when you have a task and must decide WHO does it — yourself, a spawned subagent, or another agent in the topology that already holds the context — or how to brief the agent you hand it to, which depends on the model it runs. The rule: how much would a blank slate have to read in to do this correctly? A lot → route to a context-holding agent; a little → subagent; unsure → a real agent or yourself. NOT the mechanics of fanning out (that's dispatching-parallel-agents / subagent-driven-development) — this is the who/whether decision, and the failure mode that makes teams abandon subagents."
metadata:
  openrig:
    stage: field-captured
---

# Delegating work — who should do this task?

## The core question: context performance
Getting work done well is a context problem. The agent best suited to a task is **the one who already holds the context that task requires.** Before you spawn a subagent or grind it out yourself, ask who that is.

## The decision
**Ask: how much would a blank slate have to read in before it could do this correctly?**

- **A lot to read in → route to a real agent in the topology that already holds it.** This is what the role structure is FOR — reviewers, QA, implementers who have been on a project over time. An agent that already understands the work produces a better, safer result than any amount of briefing.
- **A little — a prompt plus light grounding is enough → spawn a subagent.**
- **Genuinely unsure → err toward a real agent, or do it yourself.**

## Subagents are underused — reach for them far more
For self-contained work that is fully specifiable in the prompt, spawn a subagent instead of spending your own context: tracing, research, grounding passes, summarizing, scanning log files, searching, fetching, web search, mechanical extraction with citations. This is the common shape and it is under-used.

## The failure mode — the part that matters most
**Subagents start as blank slates, and you cannot anticipate everything they need to know.** Give one a task where there is a lot to understand and it will have blind spots it does not know it has — it will complete the task and **return a false conclusion**, not from weakness but because it lacked the context to know what "correct" even looked like.

This is the unknown-unknowns problem, and it is the single most common subagent failure: **a poorly-contextualized summary is worse than no summary, because it arrives looking like an answer.** Overreliance on subagents for context-heavy work causes more problems than it solves — and a team burned by it stops using subagents at all, which is the wrong correction. The fix is not "avoid subagents"; it is "match the task to the context it needs."

## The practical test
Before delegating to a blank slate, ask: **would a wrong-but-plausible answer here be detectable?** If the requester cannot check the result against something they already know — a citation they can open, a count they can re-run — the blind-spot risk is unacceptable, and that task belongs with an agent that holds the context.

## Worked examples
- **GOOD (→ subagent):** extract how four apps implement a UI mechanism, with `file:line` citations and an explicit instruction to report facts, not recommendations. Self-contained; the requester can verify the citations.
- **BAD to delegate blind (→ routed to the context-holder):** an independent security re-sweep of a rewritten git branch, where knowing which commit range must stay byte-identical, and that "lightly obfuscated real values" is the thing to hunt, takes a paragraph to explain and one sentence to get wrong. It went to the agent already holding the context.

## It generalizes
This is really **"route work to whoever holds the context,"** with subagents as the option for work that needs none. The audience is **every agent** — implementers and QA seats make this call as much as orchestrators do.

## Check what kind of agent you're handing it to
How to brief another agent depends on the model it runs, so check before you hand over anything open-ended.
`rig ps --nodes --json` shows the model each seat's spec declares (`model`; `null` if none is declared). A declared
model can differ from the one running, so if it's null, or you aren't sure, ask the seat which model it's running.

- **Goal-oriented models** are built to take a goal and find the route themselves. Today that's Claude Opus 5.5 or
  newer and any Fable model, and Codex models at the Sol level or above from GPT-5.6 on (GPT-5.6-Sol, GPT-6-Sol,
  GPT-6.1-Sol, GPT-6-Astra). Give them the goal, why it matters, what good looks like, the requirements and the
  context, then let them work. Spell out the route only where those details really matter.
- **Every other model, and any model you can't identify,** does its best work on smaller, simpler pieces with clear
  steps, clear boundaries and a result you can check. Split open-ended work before you hand it over, or keep the
  open-ended part yourself.

Describe the task, not the agent: don't tell a model which group it's in, or call it weaker. A model can take a
label like that literally and work down to it. A newer model in a family above (a later Opus, Fable, or Codex Sol or
Astra) belongs with the goal-oriented group. A model the lines above can't place, such as a new family or an unfamiliar
tier, starts in the second group until you know where it sits; its maker's own description (frontier or workhorse,
versus balanced, fast or affordable) is a good first signal.

## Hand over intent, not instructions
Whoever does the work, give them the goal, why it matters, the context you hold and where to find more. When you have
the requester's own words, pass them on instead of compressing them into a list of steps. A goal-oriented model builds
better from that than from a narrow spec, which gets exactly what was written and not what was wanted, so let it
decide how; don't pre-do its research or fence what it may conclude. For other models, add the steps and boundaries
the work needs, a piece at a time. Keep exact instructions for the few things that must be exact, and say why.

## Once you've decided
- Decided on subagents for 2+ independent tasks → `dispatching-parallel-agents` (the fan-out mechanics).
- Subagents executing a plan's independent tasks → `subagent-driven-development`.
- Routing to a real agent you will direct over multiple rounds → `directing-partner-agents`.
- The right context-holder is the human → `human-in-the-loop`.
