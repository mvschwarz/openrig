---
name: messaging-the-human
description: |
  When and who should send a message to the human operator, at
  operator-human@your-rig — which routes straight to his Slack. Role-gated:
  orchestrators and PMs use discretion to send anything worth his attention
  (blockers, ships/completions, changes, good news); every other agent may
  message him ONLY for a real blocker he can personally unblock, and routes
  everything else through an orchestrator. Use to protect a scarce human's
  manage-by-exception attention. NOT for agent-to-agent coordination (send/queue
  a peer) or durable agent work-handoffs (use the queue to the owning seat).
metadata:
  openrig:
    stage: provisional   # operator-directed, freshly authored 2026-07-30; hardens as agents use it
    audience: ALL agents (universal); orchestrators + PMs are the primary discretionary senders
    sibling_skills:
      - queue-handoff
      - status-not-chat-orchestrator
      - human-in-the-loop
      - openrig-user
---

# Messaging the Human

## The one-line mechanism

```bash
rig send operator-human@your-rig "your message"
```

That goes straight to the human's Slack. That is the entire *how*. Everything
below is the *when* and the *who* — which is the part that actually matters.

## The mental model: the human is a scarce attention resource managing by exception

There is one human. He is single-threaded across many agents, so his attention
is the bottleneck of the whole system. He operates **by exception**: he wants to
be pulled in when it genuinely matters and left alone when it doesn't. Every
message you send spends a slice of that scarce attention.

So the rule is not "can I reach him" (you can, trivially — one `rig send`). The
rule is **should this reach him, coming from me**. Two things decide that: **who
you are** (your role sets how much of his attention you're trusted to spend) and
**what it is** (does it clear the bar for that role). Get the altitude wrong in
either direction and you fail him: spam his Slack with noise, or sit silently on
something he needed to know or could have unblocked.

## WHO sends WHAT

### If you are an ORCHESTRATOR or a PRODUCT MANAGER — use discretion

You are the primary channel to the human. You may send **more than blockers** —
anything you judge he would want to know:

- something **shipped**, **completed**, or a **milestone** was hit
- something **important happened**, or something **changed**
- **environmental** changes (infra, hosts, tools, external state)
- **good news**
- anything that needs his attention, or is simply **good for him to know**

There is no hard trigger here — it is judgment, and you are trusted with it. The
test is: **"would he want to know this?"** If yes, send it. Lean toward sending
genuine signal and real good news; do not manufacture noise or narrate routine
churn. Discernment is the skill: you are curating his attention, not flooding it.

### If you are ANY OTHER agent — blockers only

You may message the human **only** when you are **blocked** and **he** is the one
who can unblock you. That authority is universal — you do **not** have to be an
orchestrator to raise a real blocker. But a blocker is the **only** thing you may
send him directly.

For anything that is **not** a blocker — an update, an idea, a question, an
interesting finding — do **not** message the human. Send it to your
**orchestrator**, who decides whether it is the human's role to handle or whether
it is handled another way. The orchestrator/PM layer is the filter that protects
the human's attention; routing through it is how the system keeps his queue at
manage-by-exception altitude.

## What counts as a real blocker (for non-orchestrator / non-PM agents)

You are **blocked** AND **only the human** can clear it:

- a **decision** only he can make,
- **access / a credential / an authority** only he holds,
- an **external action** only he can take (something in the real world, an
  account or service he owns).

Not a blocker: "I'd like a second opinion," "which approach do you prefer,"
"here's a cool thing I found." Those go to your **orchestrator**. And if an
orchestrator or PM *could* unblock you, route to them first — reserve the human
for what genuinely only he can do.

## How to write it (so it earns the interruption)

- **Lead with the point.** Blocker: what is blocked + exactly what you need from
  him. Update: the headline first, detail after.
- **Full absolute paths.** No internal jargon he can't parse. **No backticks** in
  `rig send` bodies (they trigger shell substitution).
- `rig send` is an **ephemeral conversation** to his Slack. For a durable *agent*
  work-handoff, use the queue to the owning seat — not the human.

## Quick reference

| You are… | You may send the human… |
|---|---|
| Orchestrator / PM | anything worth his attention — blockers, ships, completions, changes, good news (your discretion) |
| Any other agent | a real blocker only he can unblock — **and nothing else** (everything else → your orchestrator) |
