---
name: working-with-an-openrig-team
description: >-
  Use when the person runs an OpenRig team of agents on this machine and wants it to do some work, wants to know how
  that work is going, has a question from the team to answer, or wants to read what the team returned. Works through
  the `rig` command in your shell; no MCP server is needed.
---

# Working with an OpenRig team from Claude Code

The person runs a team of agents with OpenRig: each agent has its own terminal, and they keep working after this chat
ends. You aren't one of those terminals. You're the person's front door to the team: you hand it work, follow that
work, bring the team's questions to the person, and bring back what it produced. You do all of it with the `rig`
command in your shell.

## Your address on the team

Every command that writes to the team runs as one address, such as `claude-app@my-team`. Items you create are recorded
as coming from it, and the team's questions about your work come back to it. It's an address the queue takes items for;
nothing is launched for it.

- If the person hasn't chosen one, run `rig ps` to list their teams (rigs), and suggest `claude-app@<rig>`. Use the
  address they agree to.
- Prefix every `rig queue` command with it: `OPENRIG_SESSION_NAME=<address> rig queue ...`. That's how OpenRig knows
  who is acting. Without it, claiming and recording answers are refused.
- `rig` must be on the PATH (`rig --version`). If it fails, `rig` isn't on this shell's PATH: OpenRig may not be
  installed, or may be installed where this shell doesn't look. Ask the person. If it isn't installed, point them to
  https://openrig.dev, and stop until `rig --version` works.

## Find who takes the work

- `rig ps --nodes --rig <rig>` lists the team's seats. Work goes to the lead (a seat named `lead`, `orch` or
  `orchestrator`, or the rig's only seat) unless the person names one. If you can't tell, ask the person which seat.
- Use the seat's full session name from that list, such as `lead.agent@my-team`, as the destination.

## Hand the team work

Write the body for a capable colleague: the goal, why it matters, what done looks like, and where to look. End it with
the reply route, because your address has no terminal and `rig send` can't reach it:

> To ask me anything, create a queue item to `<address>` (`rig queue create --destination <address> ...`), then block
> this item on that new item's id (`rig queue block <this id> --on <question id>`), so my answer wakes you. I check it
> when the person asks. Don't ask in your own terminal: the person isn't there. If you hand this item on, copy this
> paragraph into the new item. When you finish, put the outcome in this item's resolution and any file in its
> evidence ref.

Write the body to a file first, so quotes and newlines survive the shell.

```sh
OPENRIG_SESSION_NAME=<address> rig queue create --destination <lead session> \
  --summary "<one line>" --body-file <file>
```

- Tell the person the `qitemId` it prints. It's how both of you find this work again.
- If the command times out, check `rig queue show <qitemId>` before trying again. To retry, pass the same id with
  `--id <qitemId>`. Never retry without it: that creates the work twice.

## Follow it

- `rig queue show <qitemId> --full` gives its state, its current owner and how it closed. Its history, including the
  notes the team recorded, is `rig queue transitions <qitemId> --full`.
- When a seat hands the work on, `handedOffTo` names the seat it went to, not the next item, so never pass it to
  `rig queue show`. The next item is the one whose `handedOffFrom` is this item's id. On OpenRig 0.7.12 or later,
  `rig queue show <qitemId> --json` lists it under `successors`. On 0.7.11, find it in
  `rig queue list --destination <that seat> -a -o json`. Follow the chain to the newest item before you report.
- Report what the record says. A claimed item isn't finished work, and a quiet one isn't stuck: say what you saw and
  when it last changed.
- Nothing wakes this chat when the team finishes. Check again when the person asks, or when they come back.

## The team's questions

- Questions about your work come to your address:
  `OPENRIG_SESSION_NAME=<address> rig queue list --owned --state pending,in-progress`.
- Read each one in full (`rig queue show <qitemId> --full`). Show the person the question, in the team's words where
  the item gives them. Then ask for their answer.
- Record only what the person actually tells you. Claim the item, then close it with exactly what they typed, nothing
  else: no label such as "The person's answer:", no quotation marks, and no notes of your own.

  ```sh
  OPENRIG_SESSION_NAME=<address> rig queue claim <qitemId>
  OPENRIG_SESSION_NAME=<address> rig queue update <qitemId> --state done \
    --closure-reason no-follow-on --resolution "<the person's words>"
  ```

- Then check the work item the question was about. If it's still `blocked` on a gate such as `external:...` rather
  than on the question's id, your answer won't wake its seat. Release it with the person's words:
  `OPENRIG_SESSION_NAME=<address> rig queue resolve <work qitemId> --decision "Answered in <question qitemId>: <the person's words>"`.
- If the person isn't there to answer, leave the item open and tell them it's waiting. Never choose an answer for them.
- If a work item is blocked waiting on the person but no question reached your address, its transitions
  (`rig queue transitions <qitemId> --full`) usually say what it needs. Show the person, and send their answer as a new
  item to the same seat that names the blocked `qitemId`.
- Some questions go to the person directly, not to your address. Those wait where they already answer the team, such
  as the OpenRig TUI or Slack. You can mention them; answering them isn't yours.

## Read the result

- When the item is `done`, its `resolution` is the answer, and its transitions
  (`rig queue transitions <qitemId> --full`) hold the notes the team recorded.
- If it names an `evidenceRef`, that's the file the team produced. Read it with your file tools, or give the person
  the path.
- To ask for changes, create a new item that names the earlier `qitemId` in its body, so the revision is easy to trace.

## Come back later

- `OPENRIG_SESSION_NAME=<address> rig queue list --mine` lists open items this address sent or owns. Finished ones,
  including questions the person already answered, need `--state done`:
  `rig queue list --destination <address> --state done`. Items outlive conversations, so a new chat with the same
  address reaches the same work.

## The full plugin

This skill uses the shell. OpenRig also has a full plugin for Claude Code, from OpenRig's own marketplace, that adds
OpenRig's MCP server: typed tools instead of shell commands, and your address set once in the plugin's settings. If the
person wants it:

```sh
claude plugin marketplace add mvschwarz/openrig
claude plugin install openrig@openrig-app
```

Then they set the plugin's OpenRig seat (`/plugin`, then configure) and start a new session.

## What this doesn't do

- It adds no panel, and nothing wakes this chat when the team finishes.
- It reaches a team on this machine.
- Anyone using Claude Code on this machine with the same address acts as that address.
