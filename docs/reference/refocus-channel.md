# The Refocus Channel

**How orientation content reaches a RUNNING seat.** Editing a file is not
delivery: a running seat read its configuration at session start, and nothing
in its context re-reads disk on its own. The refocus channel closes that gap —
it is the mechanism that makes shipped chain files (see
`chain-file-convention.md`) live doctrine rather than boot-time decoration.

## The mechanism

`openrig-core` ships `hooks/scripts/refocus.cjs`, registered on both runtimes:

| event | Claude Code | Codex | why |
|---|---|---|---|
| UserPromptSubmit | ✓ | ✓ | deliver due or on-demand context at a model-visible boundary |
| Stop | ✓ | — | catch a long Claude turn crossing the growth threshold |
| PostCompact | ✓ | ✓ | retain exact compaction due-state; deliver on the next actionable prompt |

Claude's additional firing signal is **transcript growth** — not turns (one turn
can burn 200k tokens across fifty tool calls) and not wall-clock (the failure is
sustained work, not elapsed time). Its default threshold is ~2.6MB of JSONL
growth (≈300k tokens); tune with `OPENRIG_REFOCUS_BYTES`. Codex never uses that
threshold: its exact `PostCompact` lifecycle hook is the trigger, avoiding a
redundant double-fire around Codex's own compaction cadence. Set
`OPENRIG_REFOCUS_NOW=1` for an on-demand refocus and
`OPENRIG_REFOCUS_ENABLED=0` to disable the feature. Fresh `SessionStart` is
always a no-op: the default onboarding pack owns fresh orientation. Both
runtimes retain `PostCompact` due-state for the next prompt. The managed Claude
acknowledgement-only boundary is skipped without consuming that state; the restore
request explicitly asks the seat to read the refocusing skill and run both traces,
and the read-depth audit checks that work. Otherwise the hook
is a no-op (it writes a stderr advisory when the transcript shrinks or the
session has no identity), and it degrades to silence on unrelated hook errors.
Both runtimes stop the hook after 5 seconds, and the content REF lookup gets 2;
a slow REF shows as `REFOCUS CONTENT REF FAILED`. A
configured REF resolution failure instead degrades
loudly in the delivered payload while still completing the hook — a refocus
must never break a seat's turn.

Failed trace or configured-content resolution keeps refocus due. After three
consecutive failed attempts for the same seat and occupant, the hook emits one
idempotent issue-stream item tagged `issue,refocus`, visible through `rig stream
list --tag refocus`. A successful delivery resets that failure episode. An
unconfirmed stream write keeps the same item ID for the next failed attempt; it
does not send a wake, change seat status, or prove the agent read the content.

Because the hook runs at the seat's own turn boundaries, delivery to a
RUNNING seat needs no relaunch, no operator action, and no message traffic:
the next prompt the seat processes carries the content. The latency bound is
"the seat's next turn," which is also the earliest moment new orientation
could have been acted on anyway.

## The content is configurable — and never project-specific in source

Resolution order:

1. `OPENRIG_REFOCUS_CONTENT_REF` — a path-like context-library ref resolved
   through `rig context get`, so refocus receives the same assembled bytes as
   on-demand pull. This wins when REF and FILE are both set.
2. `OPENRIG_REFOCUS_CONTENT_FILE` — an operator-authored file, set in the
   environment the seat's harness runs in (rig and agent specs have no `env`
   key).
3. `$OPENRIG_HOME/refocus/REFOCUS.md` — the instance's standing content.
4. The generic default at
   `skills/refocusing/references/refocus.md`: three project-neutral orientation
   questions, the ladder itself, and a pointer to the separately shipped
   onboarding assets.

The hook names a resolved REF in the delivered payload. If REF resolution
fails, the payload starts with `REFOCUS CONTENT REF FAILED`, the exact ref, and
the resolver's reason, then continues with generic orientation. A broken ref
therefore stays visible without blocking the seat's session boundary. With REF
unset, the existing FILE and generic paths are unchanged.

Mission-, project-, or box-specific refocus text belongs in a context-library
entry or one of those FILES on the instance that needs it. **It must never be committed into product
source** — the shipped default carries no path, seat name, mission, or
practice that is not generally applicable.

Every delivered refocus pairs its content with the public `refocusing` skill's
path-only trace. Configure `OPENRIG_REFOCUS_TREES=topology|work|both` and
`OPENRIG_REFOCUS_DEPTH=light|full`; optional `OPENRIG_REFOCUS_TOPOLOGY_NODE`
and `OPENRIG_REFOCUS_WORK_NODE` select starts that cannot be derived. The
script resolves `topology.root` and `workspace.root` through live config and
reports broken links as gaps rather than following pointers.

This automatic hook path is additive to one-shot manual injection through
`rig send --context`; neither mode substitutes for the other.

## Relation to chain files

The chain files are the durable, altitude-addressed home of orientation
content; the refocus channel is its delivery schedule. A practice added to a
rig's `LEARNED.md` today reaches running seats through their next refocus
trace, which reads `LEARNED.md` at each topology level. The default light trace
shows only about the first 800 characters of each `LEARNED.md` body, so a
practice appended to a longer file reaches seats only with
`OPENRIG_REFOCUS_DEPTH=full` or through the configured refocus content. A `CRAFT.md` practice
reaches them only through the configured refocus content (REF or FILE), and future
installs through the shipped defaults
(discovery → curation → ship, per the convention doc).

## What a refocus is NOT

A refocus corrects drift; it is not a wake (which restores liveness and must
not reframe work) and not a checkpoint (a deliberate phase-boundary pause).
Sending the heavy intervention when the light one was due is the most common
self-inflicted stall — the hook fires the light one automatically, which is
the point.
