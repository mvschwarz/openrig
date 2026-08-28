# The planning dial — how much rigor a plan gets, chosen per piece

Planning is a spectrum, not a binary. The build phase prices its care by wave
composition; planning needs the same flexibility, or every piece gets one protocol —
over-working the trivial and under-working the hard. Graduated 2026-08-28 from the
working SOP that ran a full release; the lived examples behind each rung stay in the
originating team's playbook.

## The rungs — dial up by what the piece is

- **P0 — mini-requirements + pointers.** A few observable outcomes and where to look;
  the builder figures out the how. Right for simple, reversible, well-trodden work.
- **P1 — authored spec.** Intent, mini-requirements, a failing-test-first proof
  contract, declared territory. The default.
- **P2 — plus a research round,** run BEFORE the spec freezes, never during the build.
  The research prompt is authored by an agent who holds the product context (see the
  gate below); execution may fan out to any agents — web legs, documentation legs,
  code-reading legs in parallel. Research returns as CONTEXT with citations, never
  prescriptions; synthesis against your own architecture and intent follows, and it
  differs for greenfield (design the thing) versus brownfield (sharpen your approach).
- **P3 — plus an adversarial pass.** A non-author who holds the product context
  attacks the plan in both directions with the product goals as judge. Amendments land
  with proof-contract teeth — a new or changed checkbox — never as prose advice.
- **P4 — plus a blind design gate.** A from-scratch design is committed before reading
  the priors, then diffed. Similar → proceed; significantly different → stop for a
  design session with the owner.

## The context gate

Only agents with the product's world context installed may author research prompts,
run adversarial passes, or weigh in on architecture questions. Execution researchers
and builders need no such install — the agent CREATING their instructions must have
it. The reason: research shaped by someone who does not know what the product is for
returns answers to the wrong question, fluently.

## What earns P2 or P3 — importance is not the test

A piece earns **P2** when the spec would otherwise freeze on an unresolved external
unknown — a feasibility door or an open design space only research can close. A piece
earns **P3** when its failure mode is invisible to its own author: load-bearing
substrate where a plausible, self-consistent plan would ship the exact disease it
exists to kill. The discriminator is "would a wrong plan be expensive, hard to undo,
and invisible from inside" — never "is this piece central." Importance without an
unclosable unknown or an author-blind failure mode stays at P1. Planning is text-only
work, so the dial's cost stays proportional: a targeted P2 can take minutes; a full
P3 an hour or two — cheap against a wrong plan built.

## Cost calibration (dated observations from the graduating team, 2026-08)

A P2+P3 pass on the most load-bearing piece of a release took about two hours end to
end and produced the most-attacked spec in the release before a line of its code
existed. A P3 alone ran ~70 minutes and returned six findings, two behavior-changing.
A targeted P2 resolved a feasibility door in ~5 minutes against primary sources and
caught two defects in an already-in-flight candidate. The recurring lesson the rungs
carry: run the research BEFORE the build dispatches, not during.
