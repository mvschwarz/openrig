# The product-management pass — what runs above planning, before planners touch a mission

Graduated 2026-08-28 from a working SOP born during live release preparation; the
originating team's channel specifics stay in its playbook.

## Why this layer exists (read this or the steps are ceremony)

The build is a lossy compression pipeline: product intent → planner spec → builder
code, and each stage is a narrower reader than the one above. Nothing leaks downward
by proximity — a dimension the product owner's seat holds and does not WRITE AND
ROUTE is deleted from the product, and the deletion is silent: the downstream agent
invents a plausible replacement rather than raising a hand. This pass is the only
point where product taste physically enters the pipeline. Its output is judged by one
measuring stick:

> A slice folder is ready when SPEC.md alone, plus only what SPEC.md explicitly
> routes to, reproduces the design intent in a reader who has none of your context.

## The steps

1. **GROUND IN THE RAW MATERIAL.** Survey where the ideas actually live: owner intent
   layers, prior-era designs, the conversations. Enumerate cheaply first (intent
   frontmatter, indexes); read the centerpiece documents yourself; fan out readers for
   breadth, requiring citation-bearing reports (claims with openable paths; status:
   shipped / partial / designed-never-built). Never grep-and-hope.
2. **SYNTHESIZE ONE SCOPE OF RECORD.** Theme; waves; binding design principles; an
   explicitly-NOT-in list (decisions, not omissions); the owner-decision set, each
   with a recommendation. Archive superseded planning where a cold reader cannot
   mistake it for authoritative. Every other surface DERIVES from this document;
   where they disagree, it wins.
3. **PRESENT DECISIONS DECISION-READY.** One at a time, lettered, recommendation
   first, records cited. The owner's ruling gates everything downstream —
   mechanically where possible (a blocked-on anchor), never by memory.
4. **MINT SLICES AT PLAN TIME** with real one-paragraph intents.
5. **DEPOSIT THE DESIGN — the fidelity law.** Every design-bearing slice's SPEC.md
   carries the full design contract INLINE: the owner's words verbatim, the settled
   do-not-reopen decisions, the live evidence, the shape of done, the anti-goals. A
   one-line intent is a ~20:1 lossy compression; building from it alone matches the
   design only by coincidence. Design that happened in conversation is deposited at
   mint time or it dies with the author's context window. Mechanical slices with
   durable named seeds may stay thin — thinness is a per-slice judgment, never a
   default.
6. **ROUTE EVERYTHING — the spec is the router.** The downstream reader's world is
   SPEC.md; their curiosity does not extend past it, and a file's existence is not a
   route. The spec itself carries the complete per-slice reading list (the exact
   sources YOU used, with one line of why each) and per-slice research routing
   (which tool answers which question — including explicit NOs where outside
   frameworks would contaminate an owner-designed model). Nothing load-bearing may
   depend on a reader's initiative.
7. **FRAME THE PLANNING PER SLICE.** In each spec: the planning-dial rung WITH its
   reason (`docs/reference/planning-dial.md`); what matters most; the required output
   shape. Author the research prompts for research-round slices yourself — the
   context gate: prompts come from the agent who holds the product context;
   execution can fan out. Constraints binding every spec are stated in the spec,
   never assumed known.
8. **THE THEORY-OF-MIND REREAD.** Before releasing the batch, reread each spec AS the
   narrow downstream reader — an agent who got a queue ticket, will read this one
   file, and will invent anything missing without asking. Every "but how would they
   know X?" is a hole to fix now.
9. **SEQUENCE AND GATE.** Waves file-disjoint; anything that must precede dispatch
   gates it as a row dependency, never a remembered intention; elaboration batons
   carry the dial assignments and route back per slice.
10. **KEEP THE RECORD LIVE.** The owner-facing board re-derives from the scope of
    record; corrections land in the governing document first and project outward.

## The failure modes this pass exists to prevent (each observed live)

- Thin intents shipped as if elaboration could recover fidelity the elaborator never
  had.
- Beautiful context written to disk but never routed — write-only artifacts.
- Reading lists that were curated excerpts of the real source set.
- Research needs known to the shaper but never assigned a tool or a question.
- Dispatch before the gate; sequencing held in memory instead of a row.
- Knowing the world at ten dimensions and writing for readers as if the missing
  seven would leak through on their own. They do not. Route it or it is gone.

## Addressing the wide-angle seat: context, never instructions

When any seat sends findings, problems, or proposals to a wide-angle seat (an
advisor, a product shaper), it frames them as CONTEXT ON THE TABLE — the problem
articulated, the grounding, candidate solutions if it has them — and explicitly
leaves the steering to the receiver. Never as instructions, even with a confident
recommendation in hand. Why: narrow-aperture seats produce narrow solutions and
default to imperative speech; a wide-angle seat that trusts the sender will comply,
and that is exactly how narrow decisions leak into a product unsynthesized. The
pattern converts the sender's intensity (deep, focused, current) into the receiver's
synthesis (wide, cross-cutting, temporal). This is the inbound half of the fidelity
law: outbound, the shaper deposits design so compression cannot eat it; inbound,
senders frame as context so aperture cannot bypass synthesis.

## Aperture narrows by default — and that is the point

Do not read the above as "assign every seat an aperture." Agents inevitably narrow:
heads-down on one kind of work, a seat specializes, and the narrowing IS the
specialization effect — the system's core mechanism, never a flaw to correct.
Widening a specialist diffuses what made them elite. Never set a narrow aperture
intentionally; seats arrive at theirs on their own. The ONLY aperture you ever steer
is the wide one: wide-angle is itself a specialization, and its defining discipline
is MAINTAINING width against the same pull that narrows everyone else. State
aperture in a role only when the role must hold altitude.

## The topology pairing (blueprint note)

A strong topology pairs an ORCHESTRATION seat (flow: dispatch, sequencing, capacity —
wide across the board, narrow in the act) with a PRODUCT-SHAPING seat (taste:
coherence, contracts, temporal judgment — wide across the product), each with its
aperture stated in its role. The context-not-instructions rule is the wire protocol
between them.

## Price one layer lower — the right-layer check

Before accepting the fix your hands reached for, price ONE LAYER LOWER. The tendency
is to fix high — high fixes are easy to write and test — and narrow is sometimes
exactly right: sometimes all you need is a band-aid. But sometimes you are setting a
bone, and the tells are learnable:

- **The bone tell:** the lower fix collapses several open problems at once, and is
  often SMALLER than the patch — it deletes or reuses instead of adding.
- **The band-aid tell:** the lower layer is stable, correct, and merely
  inconvenient; the defect is genuinely local; nothing else downstream shares it.
- **The floor:** there is a sweet spot. A fix below the primitives you own is
  someone else's lane, and a new engine where composition suffices fails the
  simplicity bar.
- **The move, mechanically:** name the layer you instinctively chose; name the
  layer below it; state what each fixes and what each leaves broken; choose with
  the price visible.

This is the vertical twin of the wide-angle lens above: where
context-not-instructions protects synthesis across seats, ARE-YOU-AT-THE-RIGHT-LAYER
protects it across layers — a question to ask of every fix, and one layer lower
deserves a look every time.
