# Orchestration Craft — shipped defaults (product-team)

<!-- Shipped by the product-team rig spec (copy-if-absent; append freely).
     Cross-pod tactical reminders stay at the RIG altitude; a pod directory is
     for context that one bounded sub-team owns. These are the reminders you
     need AT THE MOMENT OF ACTING on another seat. -->

## Reading another seat's pane

- **Ghost text vs staged text.** Both Claude Code and Codex render
  autocomplete GHOST TEXT in the input box, and a capture cannot show font
  color. Discriminators: cursor at the END of the text → possibly
  typed-and-left (staged); cursor at the BEGINNING → ghost text.
  Behaviorally: an Enter that does not consume it → ghost. Misreading ghost
  as staged (or vice versa) has caused real misdiagnoses — check the cursor
  before you conclude anything about an un-submitted line.
- **Text sitting AT the prompt = staged, not consumed.** The fix is one
  `C-m`, never a re-send (a re-send delivers twice).
- **The spinner renders ABOVE the input box.** A capture of fewer than ~20
  lines shows a bare prompt for a seat deep in work; never lower the line
  count to "simplify" a liveness read.

## Watching without burning the fleet

- **One capture, then arrange to be told.** You cannot watch — only glance,
  and every glance costs a turn. If you must poll: two minutes minimum, and
  identical output twice means STOP polling, not poll harder. A tight loop on
  a shared provider can exhaust the usage limit and stop every seat on it.
- **Liveness is not health.** A pane can render while nothing progresses.
  Cross the screen (`rig capture`) with `claimedAt` and
  `rig queue transitions` before you call a seat stuck.

## Acting on another seat

- **A wake, a refocus, and a checkpoint are three different interventions.**
  A wake restores liveness and must not reframe the work; a refocus corrects
  drift and opens with "finish your current action first"; a checkpoint is a
  deliberate phase-boundary pause. Sending the heavy one is the most common
  self-inflicted stall.
- **Never compact a peer to unblock something.** What comes back believes it
  knows everything and no longer does — and you are the only one who knows it
  happened. Deposit first, announce, and state what the seat no longer holds.

## Adding a practice to these files

Discovery (it appears where it was earned — a LEARNED, a field note, a review
observation) → curation (is it generally applicable, or project-specific?) →
ship (add it to the spec's `topology/` defaults in source, one motivating
incident per line). Editing this installed copy helps THIS rig now; shipping
it helps every future install. See docs/reference/chain-file-convention.md.
