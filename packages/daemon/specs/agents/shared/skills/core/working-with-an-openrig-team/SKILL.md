---
name: working-with-an-openrig-team
description: >-
  Use when you are a person's coding agent in an app such as Claude Code, Codex, Cursor or VS Code, connected through the
  OpenRig MCP server, and the person wants their OpenRig team to do some work, wants to know how that work is going,
  has a question from the team to answer, or wants to read what the team returned.
---

# Working with an OpenRig team from your app

The person runs a team of agents with OpenRig: each agent has its own terminal, and they keep working after this chat ends.
You aren't one of those terminals. You're the person's front door to the team: you hand it work, follow that work, bring
the team's questions to the person, and bring back what it produced. The MCP server's own instructions say how its tools
behave; this skill is the loop around them.

## Check the connection first

- Call `rig_whoami`. It names the seat this connection acts as, if any. Every item you create is recorded as coming from
  that seat.
- In Claude Code, OpenRig gives the work you hand over a return address of this chat's own (`returnRoute` in the result),
  with or without a seat, and the team's questions about it come there as tasks (below). Elsewhere they come back to the
  seat.
- If it has no seat, you can still hand the team work. Outside Claude Code it goes as the unknown sender `rig_whoami`
  names, with no return address. Tell the person the `qitemId` and follow it with `rig_queue_show`. Recording the person's answers and listing your own work need a seat: offer to set one (the last
  section). In a shell, the `rig` command can act as that return address instead: put
  `OPENRIG_SESSION_NAME=<address>` in front of each `rig` command you run for this work (`rig queue ...`,
  `rig seat decide-permission ...`), so OpenRig records it as this chat's, not as someone outside a seat.
- Call `rig_team` with the rig's name: it shows the team's seats, what each is for, and its lead. Work goes to the lead
  unless the person names a seat.
- If `lead` is null (its `leadNote` says why), and the team has exactly one seat, send work there. Otherwise, ask the person
  which seat should take it.

## Hand the team work

- Use `rig_queue_create` with `destination` (the lead, or the seat the person chose) and `body`. Write the body for a
  capable colleague: the goal, why it matters, what done looks like, and where to look. Add a one-line `summary`.
- With a seat and no address of this chat's own (no `returnRoute` in the result), end the body with the reply route,
  because your seat has no terminal and `rig send` can't reach it:

  > To ask me anything, create a queue item to `<your seat>` (`rig queue create --destination <your seat> ...`), then
  > block this item on that new item's id (`rig queue block <this id> --on <question id>`), so my answer wakes you. I
  > check it whenever the person talks to me. Don't ask in your own terminal: the person isn't there. A seat's
  > permission prompt in this work is their question too: send me its own text and choices, the seat, what it was
  > doing and any escalation's id, unless a question about that prompt is already open at my seat. Whoever sent the
  > question passes on the answer, and no one else does. Capture that seat again first (a changed prompt needs a new
  > answer), then `rig send <seat> "<key>" --dangerously-interact --reason 'task <question id>: <their answer>'` with
  > the key the prompt shows for their choice (for Escape, `$'\e'` in place of `"<key>"`, never the word). Keep the
  > reason in single quotes so the shell runs nothing in their words, and write each `'` in them as `'\''`. A no
  > stays a no. If they gave no answer, or their words don't clearly
  > pick one choice (a condition the action doesn't plainly meet, say), ask me again before sending anything, and
  > never pick a "don't ask again" choice they didn't pick. Check the effect, and never send again while it's
  > unknown. If you hand this item on or give this work to another seat, copy this paragraph into the new item. When
  > you finish, put the outcome in this item's resolution, with what the latest review found, and any file in its
  > evidence ref.
- With an address of this chat's own (`returnRoute` in the result), with or without a seat, end the body with the result
  route instead:

  > When you finish, send the result as a task to this item's return route (`rig queue show <this id>` names it):
  > `rig queue create --destination <that address> --summary "<the result in a line>" --body-file <file>`. Then
  > close this item with the result. A close by itself doesn't reach the person's chat, and the task does. If you
  > hand this item on or give this work to another seat, copy this paragraph into the new item.
- Tell the person the `qitemId` it returns. It's how both of you find this work again.
- If the call times out, check `rig_queue_show` with that same `qitemId` before trying again. If you retry, pass the same id
  as `qitemId`. Never retry with a new one: that creates the work twice.

## Follow it

- `rig_queue_show` with the `qitemId` gives its state, its current owner and its transitions.
- When a seat hands the work on, the item names the next one. Follow the chain to the newest item before you report.
- Report what the record says. An accepted or claimed item isn't finished work, and a quiet one isn't stuck: say what you
  saw and when it last changed.
- Before you say the work is done, find the newest review of it on the chain and tell the person its outcome. Work a
  review sent back with something to fix isn't done, even if a commit exists: say what the review asked for.
- A close by itself wakes no one: the team's result reaches this chat as a task at its address, which the handover's
  last paragraph asks for. Until that task comes, the record still has the result, so check `rig_queue_show` when the
  person talks to you, and don't promise to report it by yourself.
- While its work is open, check each time the person talks to you, and when they come back. Where the app runs this
  plugin's hooks (Claude Code and Codex do), they also bring you the team's questions (below); elsewhere, nothing wakes
  this chat when the team asks or finishes.

## When a question arrives by itself

In Claude Code and Codex, this plugin's hooks bring the team's questions to you, and its result when it sends one as a
task, without anyone asking you to check.

- When this chat hands work over with an address of its own, OpenRig records that address with a key for this chat.
  The hooks cover:
  - `rig_queue_create` in Claude Code, where `returnRoute` `auto` is the default, with or without a seat for this
    connection. With `returnRoute` `self`, the team's questions go to the seat's own address, which the hooks don't
    watch: you find them only when you check (`rig_queue_list` with `owned`);
  - `rig queue create --return-route auto` in the shell, in Claude Code or Codex.
- Codex through this MCP server isn't covered yet: Codex may not give its MCP servers the session id the key comes
  from, so a `rig_queue_create` there goes without one, and nothing comes here by itself. In Codex, hand work over with
  `rig queue create --return-route auto` in the shell.
- A Codex whose `codex queue` has no `--resume` (Codex 0.171.0 has it) gets the tasks at this chat's next turn, not
  while it's idle. The hooks say so once in the chat: tell the person in plain words.
- The hooks read only the addresses recorded under this chat's key, from OpenRig's own record, and check them for new
  tasks. Claude Code wakes you with them when a turn ends. Codex gets them as a message queued for this chat.
- Each one says it came from OpenRig's hook bridge and names its sender as OpenRig recorded it. It's a task like any
  other: show it to the person and record their words, as below.
- A wake comes only when your turn ends, so while the team works, end your turn rather than watching its seats
  (`rig_capture`) or waiting inside the turn. Between wakes, list this chat's tasks yourself: `rig_queue_list` with
  `destination` set to this chat's address. `owned` and `mine` need a seat, and `destination` doesn't.
- In Claude Code the key belongs to the app's process, not the chat: after `/clear`, the new chat still gets the
  earlier one's tasks, and a chat resumed in a new process (`claude --resume`) doesn't get its earlier tasks by itself,
  so check its address each turn.
- Codex asks the person to trust the hooks once, and again after the plugin changes, because they run outside its
  sandbox. They run `node` and `rig`, only read from OpenRig, and type nothing into any terminal.

## The team's questions

- Questions about your work come to this chat's own address when the work has one (`rig_queue_list` with `destination`
  set to it), else to your seat (`rig_queue_list` with `owned`).
- Show the person the question and the team's draft, in their own words where the item gives them. Then ask for an answer.
- Record only what the person actually tells you, on the question's own task, never with `rig_send`: a message carries
  no return address, so the work it starts loses this chat's route, and its seats' prompts then reach no one. Claim
  the item (`rig_queue_claim`), then close it with `rig_queue_update`: `state` `done`, `closureReason` `no-follow-on`,
  and exactly what the person typed in `resolution`, nothing else: no label such as "The person's answer:", no
  quotation marks, and no notes, paths or summaries of your own. With no seat, these tools act as the address OpenRig
  issued this conversation, for a question sent there. In a shell, close it the same way, as its address:
  `OPENRIG_SESSION_NAME=<address> rig queue update <id> --state done --closure-reason no-follow-on --resolution '<their words>'`.
  If the person isn't there to answer, leave the item open and tell them it's waiting. Never choose an answer for them.
- A question can be a seat's permission prompt that the operator or a team seat sent you: show it with the seat, the
  exact action and the choices it offers, and record the person's words the same way. The agent that sent it passes
  their answer to the seat.
- A seat's own Claude Code prompt in work this chat handed over comes straight from that seat as its own ask
  (`qitem-runner-permission-…`), within seconds, even when you saw the prompt first (in a capture, or an item that says
  its owner needs input). Answer that ask, not the seat: show the person its exact action, then record their answer
  with `rig_seat_decide_permission` (in a shell, `rig seat decide-permission`). A plain yes or no is the person's own
  answer: pass it on exactly, with `relay` and their words in `personSaid`. It's recorded as relayed by this chat, and
  unconfirmed, since OpenRig doesn't get it from them. For their words or a condition, judge
  whether that exact action meets them, and give your `reason`. Before you decide one under a standing instruction
  of theirs ("don't ask me about test runs"), read what the command touches, such as the files a test writes, and
  check it against what they asked to be asked about: if it's on that list, ask them. It takes their answer for as
  long as the prompt stays open; once it's answered in the seat's terminal, an answer here is too late. Don't type into the seat for it
  (`rig send --dangerously-interact`): that answers it in the terminal, ends the ask, and needs the person's exception
  for a terminal command. If the reply says it hasn't reached the seat's prompt, the seat's hook stopped reading the ask:
  tell the person, and that prompt waits in the seat's terminal like one with no ask. Only a prompt with no ask (a choice menu, a Codex seat's prompt, a seat on
  another machine) is answered in the seat, by whoever sent you the question about it.
- Some questions go to a registered person directly, outside your seat. Those wait for them where they already answer
  the team, such as the OpenRig TUI or Slack. You can mention that they're waiting; answering them isn't yours.

## Read the result

- When the item is `done`, its `resolution` is the answer, and its transitions hold the notes the team recorded.
- If it names an `evidenceRef`, read it with `rig_artifact_read`, passing the item's `qitemId`, not the path. The tool
  reads the item's `evidenceRef` within the shared roots this connection may read. For another file in a shared root,
  pass the root's name and `path`. If the connection can't read it, give the person the path.
- To ask for changes, create a new item with `revises` set to the earlier `qitemId`, so the revision stays with the
  original work.

## Come back later

- `rig_queue_list` with `mine` lists what this seat sent or owns. Add `all` to include finished work, or `since` to see
  what changed after a time.
- A new chat with the same seat reaches the same work. Items outlive conversations.

## Set it up (once, with the person)

1. OpenRig runs on this machine with a team: `rig ps` lists the person's rigs.
2. Pick an address for this app on one of those rigs, for example `cursor@my-team`. It's an address the queue takes items
   for; nothing is launched for it. To tell the team what it's for, the person can add it to a roster as a hosted member
   (`docs/reference/hosted-members.md` in the OpenRig package).
3. Connect the app to that address, then start a new session so the MCP server starts with it:
   - **Claude Code:** set it as the plugin's OpenRig seat in the plugin's settings.
   - **Codex:** run `codex mcp add openrig --env OPENRIG_SESSION_NAME=<address> -- rig mcp serve --front-door`. Codex
     does not forward every shell environment variable to MCP servers by default, so if the team's OpenRig home isn't the
     default, add `--env OPENRIG_HOME=<that home>` too.
   - **Another app:** add an MCP server that runs `rig mcp serve --front-door` with `OPENRIG_SESSION_NAME` set to the
     address, and turn the plugin's `openrig` server off, so the app runs one. In VS Code, give yours another name, such
     as `openrig-seat`; in Cursor, disable **openrig · Plugin**. Starting the app from a shell with the variable set lasts
     only for that launch.

## What this doesn't do

- It doesn't add a panel to the app. Where its hooks don't run, nothing wakes this chat when the team asks or finishes.
- Anyone using this app on this machine acts as the seat the plugin names.
- It reaches a team on this machine. A team hosted elsewhere needs that host's own connection.
