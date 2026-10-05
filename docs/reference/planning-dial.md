# The planning dial — how much rigor a plan gets, chosen per piece

Planning is a spectrum, not a binary. When the wave model is selected, build care
varies by wave composition; planning needs the same flexibility, or every piece gets
one protocol — over-working the trivial and under-working the hard. Choose the rung
from the work's uncertainty and consequences.

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
work; keep its scope proportional to the unresolved question and the cost of a wrong
plan, rather than assuming a fixed duration for a rung.

## Cost calibration

Scope research to the unknown that could change the plan; scope an adversarial
pass to the failure modes the author may miss. Record the questions resolved and
the resulting design changes so the owner can judge the value of the selected
rung. Run planned research before build dispatch, while its answers can still
shape the spec. Record the chosen rung in the slice's frontmatter as
`approved-spec-dial:`; `rig view show execution` shows it as `planning_dial`.
