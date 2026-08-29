---
name: messaging-the-human
description: "Use when a human decision, access grant, external action, or escalation must survive the operator's absence, or when an orchestrator or PM has a judgment-worthy update for the operator."
metadata:
  cli_surfaces_referenced:
    - gateway human add
    - gateway human list
    - queue block
    - queue handoff
    - queue transitions
    - send
  openrig:
    stage: provisional
    audience: all agents
    sibling_skills:
      - queue-handoff
      - human-in-the-loop
      - openrig-user
---

# Messaging the Human

The human is an addressable participant, but their attention is scarce and they
may not be at a terminal. Anything that must survive their absence needs a
durable queue row; the gateway turns the human blocker on that row into the
external notification.

Any seat may contact the human directly for a real escalation. Orchestrators
and product managers may also send updates they judge the human would want to
know. Do not add a routing intermediary merely because of your role.

## The supported route

First discover the registered human identity. Never invent or remember an
address:

```bash
rig gateway human list --json
```

Use the returned `humans[].address`. If no unambiguous registered human is
returned, stop: registration is lifecycle work (`rig gateway human add
--help`), not an address to guess.

Keep the work row owned by the agent who must resume it, then park that row on
the registered human:

```bash
rig queue block <qitem-id> --on <registered-human-address> \
  --summary "<decision owed>" \
  --evidence-ref "<durable artifact the human should judge>" \
  --continuation "<what resumes after the answer>"
```

The gateway resolves the registered human to the configured connector, sends
the Slack notification, and records its receipt on the same row. Confirm the
effect from the append-only history:

```bash
rig queue transitions <qitem-id>
```

The row is the obligation and the audit trail. Slack is the attention leg. A
reply resolves the durable blocker and wakes the row owner; it does not create
a second private work stream.

## When to use it

Escalate directly when only the human can supply the missing capability:

- a decision or irreversible judgment only they own;
- access, credentials, authority, or capacity only they can grant;
- an external action only they can perform;
- a security-class or provider/model-fallback event they need to know about.

Orchestrators and product managers may additionally send meaningful milestone,
environment, or completion updates. Prefer signal over routine narration.

## Boundaries

- `rig send` sends text to an agent's terminal. It is not the Slack route and
  does not create a durable human obligation.
- An unregistered or ambiguous human identity must fail loudly. Register or
  repair the identity; never downgrade it to an agent seat or a guessed
  `@external` address.
- Agent-to-agent work that needs closure uses `rig queue handoff`, not this
  human-blocker path.
- Deferred work that is not imminent belongs in the mission workspace, not on
  the queue.

## Writing the escalation

Lead with what is blocked and the exact decision or action needed. Point at the
durable evidence instead of pasting a second copy, and name the continuation so
the system can resume the right work when the answer arrives.
