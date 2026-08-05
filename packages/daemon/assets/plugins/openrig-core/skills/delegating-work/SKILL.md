---
name: delegating-work
description: "Use when you have a task and must decide WHO does it — yourself, a spawned subagent, or another agent in the topology that already holds the context. The rule: how much would a blank slate have to read in to do this correctly? A lot → route to a context-holding agent; a little → subagent; unsure → a real agent or yourself. NOT the mechanics of fanning out (that's dispatching-parallel-agents / subagent-driven-development) — this is the who/whether decision, and the failure mode that makes teams abandon subagents."
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

## Once you've decided
- Decided on subagents for 2+ independent tasks → `dispatching-parallel-agents` (the fan-out mechanics).
- Subagents executing a plan's independent tasks → `subagent-driven-development`.
- Routing to a real agent you will direct over multiple rounds → `directing-partner-agents`.
- The right context-holder is the human → `human-in-the-loop`.
