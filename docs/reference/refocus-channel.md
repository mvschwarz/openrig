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
| SessionStart | ✓ | ✓ | fresh orientation |
| UserPromptSubmit | ✓ | ✓ | growth check at each turn boundary |
| Stop | ✓ | ✓ | catches the long single turn |
| PostCompact | ✓ | — (no compact hook) | a compacted seat's picture is lossy |

The firing signal is **transcript growth** — not turns (one turn can burn 200k
tokens across fifty tool calls) and not wall-clock (the failure is sustained
work, not elapsed time). Default threshold ~2.6MB of JSONL growth (≈300k
tokens); tune with `OPENRIG_REFOCUS_BYTES`. SessionStart and PostCompact
always fire. Otherwise the hook is a silent no-op, and it degrades to silence
on unrelated hook errors. A configured REF resolution failure instead degrades
loudly in the delivered payload while still completing the hook — a refocus
must never break a seat's turn.

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
2. `OPENRIG_REFOCUS_CONTENT_FILE` — an operator-authored file (per-seat or
   per-rig via spec env).
3. `$OPENRIG_HOME/refocus/REFOCUS.md` — the instance's standing content.
4. The generic default baked into the hook: three project-neutral orientation
   questions plus the pointer to the seat's topology chain
   (`rig context trace … --name CRAFT.md`) and the LEARNED-ownership warning.

The hook names a resolved REF in the delivered payload. If REF resolution
fails, the payload starts with `REFOCUS CONTENT REF FAILED`, the exact ref, and
the resolver's reason, then continues with generic orientation. A broken ref
therefore stays visible without blocking the seat's session boundary. With REF
unset, the existing FILE and generic paths are unchanged.

Mission-, project-, or box-specific refocus text belongs in a context-library
entry or one of those FILES on the instance that needs it. **It must never be committed into product
source** — the shipped default carries no path, seat name, mission, or
practice that is not generally applicable. (The pre-promotion lab hook had
exactly this defect: a hardcoded per-box distillation-tool path. The
promotion removed it; the grep for project residue is part of the slice's
proof contract.)

This automatic hook path is additive to one-shot manual injection through
`rig send --context`; neither mode substitutes for the other.

## Relation to chain files

The chain files are the durable, altitude-addressed home of orientation
content; the refocus channel is its delivery schedule. A practice added to a
rig's `CRAFT.md` today reaches running seats through their next refocus
pointer, and future installs through the shipped defaults
(discovery → curation → ship, per the convention doc).

## What a refocus is NOT

A refocus corrects drift; it is not a wake (which restores liveness and must
not reframe work) and not a checkpoint (a deliberate phase-boundary pause).
Sending the heavy intervention when the light one was due is the most common
self-inflicted stall — the hook fires the light one automatically, which is
the point.
