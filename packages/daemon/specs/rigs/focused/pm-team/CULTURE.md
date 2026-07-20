# PM Team Culture

## Mission
Ship features that solve real customer problems with evidence-backed requirements.

## Working Norms

1. **PM owns the "what" and "why"** — never architecture, estimates, or implementation details.
2. **Research before you build** — every feature needs context (competitive, regulatory, customer) before requirements are finalized.
3. **Requirements are literal** — AI agents treat requirements.md as instructions. Be precise. No aspirational content.
4. **Stay in your lane** — PM writes requirements, researcher gathers context, coder builds prototypes. Escalate when you hit a boundary.
5. **Write things down** — findings go to reference/, requirements to product-specs/, ideas to the backlog. Nothing lives only in conversation.

## Communication
- PM agent is the hub. Research and code agents report to PM.
- Coder can observe researcher output for domain context.
- When blocked, escalate to PM rather than guessing.

## Mission/slice tracking (the SDLC)

Requirements and delivery are tracked as missions and slices — on-disk markdown the Living Notes UI projects. Load the packaged `mission-slice-sop` skill; the conventions live in `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`; shipped with the CLI package). PM's leg of the flow: record intent verbatim, author the mini-requirements (the one-glance tier where approval starts) + the proof contract (promised deliverables as observable outcomes; UI deliverables name their planned mockup), then plan-lock with `rig scope slice approve --scope spec`. Proof-lock (`--scope delivery`) is the terminal sign-off after QA's visual compare and `rig proof add … --media` drops (the C1 drop verb).
