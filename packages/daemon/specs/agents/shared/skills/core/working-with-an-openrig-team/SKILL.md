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

- Call `rig_whoami`. It names the seat this connection acts as. Every item you create is recorded as coming from that seat,
  and the team's questions about your work come back to it.
- If it has no seat, you can still hand the team work. It goes as the unknown sender `rig_whoami` names, with no return
  address, so tell the person the `qitemId` and follow it with `rig_queue_show`. Receiving the team's questions and
  replies, recording the person's answers and listing your own work need a seat: offer to set one (the last section).
- Call `rig_team` with the rig's name: it shows the team's seats, what each is for, and its lead. Work goes to the lead
  unless the person names a seat.
- If `lead` is null (its `leadNote` says why), and the team has exactly one seat, send work there. Otherwise, ask the person
  which seat should take it.

## Hand the team work

- Use `rig_queue_create` with `destination` (the lead, or the seat the person chose) and `body`. Write the body for a
  capable colleague: the goal, why it matters, what done looks like, and where to look. Add a one-line `summary`.
- With a seat, end the body with the reply route, because your seat has no terminal and `rig send` can't reach it:

  > To ask me anything, create a queue item to `<your seat>` (`rig queue create --destination <your seat> ...`), then
  > block this item on that new item's id (`rig queue block <this id> --on <question id>`), so my answer wakes you. I
  > check it when the person asks. Don't ask in your own terminal: the person isn't there. If you hand this item on,
  > copy this paragraph into the new item. When you finish, put the outcome in this item's resolution and any file in
  > its evidence ref.
- Tell the person the `qitemId` it returns. It's how both of you find this work again.
- If the call times out, check `rig_queue_show` with that same `qitemId` before trying again. If you retry, pass the same id
  as `qitemId`. Never retry with a new one: that creates the work twice.

## Follow it

- `rig_queue_show` with the `qitemId` gives its state, its current owner and its transitions.
- When a seat hands the work on, the item names the next one. Follow the chain to the newest item before you report.
- Report what the record says. An accepted or claimed item isn't finished work, and a quiet one isn't stuck: say what you
  saw and when it last changed.
- Nothing wakes this chat when the team finishes. Check again when the person asks, or when they come back.

## The team's questions

- Questions about your work come to your seat: `rig_queue_list` with `owned` lists them.
- Show the person the question and the team's draft, in their own words where the item gives them. Then ask for an answer.
- Record only what the person actually tells you. Claim the item (`rig_queue_claim`), then close it with
  `rig_queue_update`: `state` `done`, `closureReason` `no-follow-on`, and exactly what the person typed in `resolution`,
  nothing else: no label such as "The person's answer:", no quotation marks, and no notes, paths or summaries of your own.
  If the person isn't there to answer, leave the item open and tell them it's waiting. Never choose an answer for them.
- Some questions go to the person directly, outside your seat. Those wait for them where they already answer the team,
  such as the OpenRig TUI or Slack. You can mention that they're waiting; answering them isn't yours.

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

- It doesn't add a panel to the app, and nothing wakes this chat when the team finishes.
- Anyone using this app on this machine acts as the seat the plugin names.
- It reaches a team on this machine. A team hosted elsewhere needs that host's own connection.
