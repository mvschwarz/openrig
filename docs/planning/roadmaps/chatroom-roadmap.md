# Chatroom Roadmap

Date: 2026-04-08
Status: roadmap / long-term requirements + short-term cuts
Scope: OpenRig shared `chatroom` as both a general collaboration surface and a structured roundtable surface

## Purpose And Scope

This document captures what the recent chatroom dogfood round revealed about the current `chatroom` surface.

It serves two purposes:
- long-term requirements for turning chatroom into a durable multi-agent collaboration surface
- short-term highest-value / lowest-effort improvements that can make it much more usable without reinventing Slack

The goal is not to build a full workplace chat product. The goal is to make `chatroom` good enough for:
- agent-to-agent technical collaboration
- shared problem solving and creative synergy
- formal roundtables and review convergence
- human monitoring of rig-level discussion

## What The Dogfood Round Revealed

The dogfood round proved something important:
- a shared durable room is already useful
- multiple agents can post, read each other, amend positions, and converge
- the room can support real review work, not just casual chatter

But it also exposed sharp edges:
- history is too noisy once multiple topics accumulate
- there is no strong notion of topic scope
- polling is awkward for agents
- attendance and convergence are manual
- reply structure is too loose for formal review
- the current drawer chat formatting runs messages together and is hard for a human to scan
- the room is good enough for synergy, but still rough for disciplined roundtables

So the right product stance is:
- keep using `chatroom`
- improve it incrementally
- avoid overbuilding threads/channels/presence/reactions too early

## Long-Term Chatroom Requirements

### 1. Topic Isolation

One room filled up with drill traffic, old discussion, and current roundtable messages. That made formal review harder than it needed to be.

Long-term requirement:
- add first-class topic markers or subrooms

Potential surfaces:
- `rig chatroom topic start <rig> "deep-review"`
- `rig chatroom history <rig> --topic deep-review`
- `rig chatroom watch <rig> --topic deep-review`

Without some notion of topic isolation, formal discussions will keep colliding with ordinary room traffic.

### 2. Better History Retrieval

`history --limit N` was not enough to reliably retrieve the latest relevant messages in a noisy room.

Long-term requirement:
- stable newest/oldest ordering
- `--since <timestamp>`
- `--after <message-id>`
- `--sender <session>`
- `--topic <topic>`

Agents need precise retrieval controls, not repeated blunt rescans of the same mixed room history.

### 3. Unread And Cursor Support

Agents need “what is new since I last checked,” not full-history rescans.

Long-term requirement:
- per-agent cursors
- `chatroom unread`
- `watch --from-unread`
- `mark-read`

This is especially important for longer-running rooms and for hosts trying to monitor participation.

### 4. Reply Structure

The room worked, but reply structure was mostly convention. That is enough for freeform discussion, but weak for formal review.

Long-term requirement:
- message IDs in normal human output
- `reply-to` field in machine-readable output
- `--reply <message-id>` on send

This is not full Slack-style threading. It is lightweight conversational structure that helps agents respond to the right message.

### 5. Roundtable State

We had to simulate `ROUND START` and `ROUND CLOSED` manually.

Long-term requirement:
- topic state such as:
  - `open`
  - `proposed-resolution`
  - `closed`

This would make it easier for agents to know:
- whether they still need to poll
- whether a response is still expected
- whether the room has moved from discussion to convergence

### 6. Attendance And Participation Tracking

The host had to track who had spoken, who had responded to others, and who still owed a final position.

Long-term requirement:
- optional participant list for a topic
- status such as:
  - initial posted
  - responded to another participant
  - final concur/amend posted

This is especially valuable for formal review and architecture roundtables.

### 7. Blocking Wait Primitive

This was the sharpest agent-ops gap. Agents cannot truly “background poll” on their own. Polling had to be manually driven.

Long-term requirement:
- a proper wait primitive such as:
  - `rig chatroom wait <rig> --topic <topic> --since <cursor>`

Expected behavior:
- block until new messages arrive or timeout
- return only new messages
- support easy loop-based monitoring

This would remove a lot of awkward manual polling behavior.

### 8. Room Lifecycle / Fresh-Room Semantics

We wanted a clean slate for the roundtable but did not want to destroy history.

Long-term requirement:
- archive/rollover rather than destructive clear
- possible surfaces:
  - `topic archive`
  - `topic new`

This preserves durable history while still giving formal work a clean space.

### 8A. Practical Short-Term Clear

Before archive/rollover exists, the simplest useful behavior is an explicit clear command.

Short-term requirement:
- `rig chatroom clear <rig>`

Expected usage:
- if the previous room contents matter, save/export them first
- otherwise clear the room and start fresh

This is intentionally pragmatic. It does not replace long-term archiving/topic isolation, but it gives agents and humans a clean slate immediately.

## Roundtable-Specific Requirements

### 9. Built-In Roundtable Mode

Right now the host has to invent a protocol every time.

Long-term requirement:
- a lightweight roundtable workflow that supports:
  - open topic
  - register participants
  - collect initial positions
  - require at least one response to another participant
  - collect final concur/amend
  - close and emit summary state

This does not need to become a full workflow engine. It just needs enough structure to reduce host overhead.

### 10. Consensus Helpers

The host had to infer convergence manually from many messages.

Long-term requirement:
- `topic status`
- current proposal visibility
- “who still owes final”
- participant state summary

This makes it easier to know when a round has actually converged versus merely gone quiet.

### 11. Summary / Pin Support

The proposed final stack should be pinnable inside the room.

Long-term requirement:
- allow pinning or marking one message as the current proposed resolution

This keeps the room anchored during convergence without forcing everyone to scroll for the latest proposal.

### 12. Better External Participant Support

An `external_cli` participant made the flow more awkward than it should be.

Long-term requirement:
- external participants should be first-class room members
- human/external participants should not need relay hacks to be included in formal rooms

### 13. Machine-Readable Export

Formal review workflows need a clean export of the actual discussion.

Long-term requirement:
- topic-only export
- chronological JSON export
- markdown export for review artifacts

This would make roundtable outputs easier to preserve and hand off.

## General Chatroom UX Requirements

### 14. Message Formatting Modes

Long review messages are hard to scan in raw history output.

Long-term requirement:
- compact history mode
- multiline pretty mode
- stable JSON mode with reliable fields

### 15. Better Timestamps

Timestamps should always be easy to read in human output.

Long-term requirement:
- absolute time in human-readable history
- not just internal timestamps in JSON

### 16. Stronger Sender Identity

Long-term requirement:
- show logical role/session clearly in human output
- make it easy to distinguish peer, impl, QA, external, and lead voices

### 17. Built-In Search / Filter

Long-term requirement:
- sender filtering
- topic filtering
- time-window filtering
- maybe text search later if needed

### 18. Mentions / Nudges

Even lightweight mentions would reduce the need for separate `rig send` nudges.

Long-term requirement:
- basic `@session` or `@role` mention support

## UI Requirements

### 19. Better Human Room Browser

The rig drawer `Chat Room` tab is still the right home, but it needs more than a raw scrolling log.

Long-term requirement:
- topic list or topic markers
- unread badge
- current live stream
- sender/topic filtering
- jump-to-latest

### 20. Topic Visibility In UI

Humans should be able to jump directly into a specific topic such as a deep-review roundtable.

Long-term requirement:
- surface named topics in the drawer rather than forcing users to parse a single undifferentiated room

### 21. Bare-Bones Message Readability In UI

Even before richer topic browsing exists, the current rig drawer chat view needs simple formatting so a human can tell where one message ends and the next begins.

Long-term requirement:
- separate sender/header from body
- add visible spacing between messages
- make topic markers visually distinct
- preserve a terminal-like monospace look without rendering the room as one continuous text blob

This should stay intentionally simple. The goal is coherence, not beauty.

### 22. Pinned Final Summary In UI

Long-term requirement:
- show the current pinned resolution or final summary in the chat UI

## Agent Protocol / Instruction Requirements

### 23. Standard Roundtable Protocol

Agents need a consistent procedure for formal chatroom rounds.

Recommended durable protocol:
- post an initial position
- respond to at least one other participant
- post a final `concur` or `amend`
- keep checking until `ROUND CLOSED`

### 24. Hosts Must Not Synthesize Too Early

This happened in the first pass. It weakens the whole point of a roundtable.

Protocol requirement:
- no synthesis until the engagement pass is complete

### 25. Polling Must Be Explicit

Agents should not imply background awareness they do not really have.

Protocol requirement:
- use a real poll/sleep loop, or later a blocking `wait` command

### 26. Topic Markers Should Be Standard

Without topic markers, rooms get polluted quickly.

Protocol requirement:
- every formal discussion should start with a named topic and a clear open/close signal

## Short-Term Highest-Value / Lowest-Effort Improvements

**Status: `clear` (item 0), history filters (item 1), and `wait` (item 3) shipped as CRMUC.** Topic markers (item 2) were already present. See `chatroom-roundtable-protocol.md` for the shipped protocol.

The simplest path is not to build Slack. The simplest path is to add just enough structure so chatroom works well for both collaboration and roundtables.

### 0. Add `chatroom clear`

Simple surface:
- `rig chatroom clear <rig>`

Why first:
- immediately solves the “old room is still full of previous traffic” problem
- dramatically reduces the need for topic/archive machinery in the short term
- easy to explain in protocol:
  - save first if needed
  - otherwise clear and start the new round

### 1. Add History Filters

Highest value for low effort:
- `--since <timestamp>`
- `--after <message-id>`
- `--sender <session>`
- `--topic <topic>`

Why first:
- fixes the biggest current retrieval pain
- helps both agents and humans immediately
- improves formal and informal usage without changing the core room model

### 2. Add Topic Markers

Simple surfaces:
- `topic start`
- `topic end`
- `history --topic`

Why early:
- gives immediate structure without building real threads/channels
- solves the “old traffic mixed with current roundtable” problem

### 3. Add A Blocking `wait` Command (SHIPPED)

Shipped surface:
- `rig chatroom wait <rig> [--after <id>] [--topic <name>] [--sender <name>] [--timeout <seconds>] [--json]`

Why early:
- removes awkward manual polling
- is one of the highest leverage improvements for agents
- improves hosts, participants, and monitoring loops

### 4. Add Message IDs And Lightweight Replies

Simple surfaces:
- show IDs in history
- `send --reply <message-id>`

Why early:
- improves conversational precision immediately
- avoids full thread infrastructure

### 5. Add Archive / New Topic Flow

Simple surfaces:
- `topic archive`
- `topic new`

Why early:
- avoids destructive “clear room” behavior
- gives formal work a cleaner working surface

### 6. Write A Standard Chatroom Roundtable Protocol

This is not a code feature. It is a usage feature.

Should document:
- open signal
- polling expectations
- initial / response / final passes
- close signal
- host responsibilities

Why early:
- immediate improvement
- nearly zero implementation cost
- reduces agent confusion right away

## Recommended First Wave

If we want maximum value for minimum effort, the first wave should be:

1. history filters: `--since`, `--after`, `--sender`, `--topic`
2. `chatroom clear`
3. topic start/end markers
4. blocking `wait` command
5. message IDs + `--reply`
6. basic human-readable message formatting in the rig drawer chat tab
7. documented chatroom roundtable protocol

This wave would dramatically improve both:
- general technical collaboration
- formal roundtables

without requiring:
- full threads
- channels
- unread synchronization across many clients
- Slack-like presence or notification systems

## What Not To Build Yet

Not yet:
- full Slack-style threads
- multiple permanent channels per rig
- reactions
- typing indicators
- presence
- complex moderation/admin systems
- rich message editing workflows

Those may become useful later, but they are not necessary for making chatroom genuinely effective now.

## Bottom Line

`chatroom` is already useful enough to keep using.

The dogfood round proved that it can support:
- real collaboration
- multi-agent convergence
- formal review discussion

But to make it consistently good, the next step is not “reinvent Slack.”

The next step is:
- better retrieval
- practical room reset
- topic structure
- explicit polling support
- lightweight reply structure
- bare-bones human-readable message formatting in the drawer
- a documented roundtable protocol

That is the shortest path to making chatroom work well in practice.
