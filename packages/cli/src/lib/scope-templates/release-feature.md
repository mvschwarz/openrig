---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
---

# Slice {{slice_number}} — {{title}}

## Intent

[The recorded intent, verbatim — what this feature ships and why now. The Living Notes UI projects this text as the INTENT section.]

## Mini-requirements

1. [The concise one-glance requirement tier — numbered observable outcomes.]

## Proof contract

- [ ] [One promised deliverable, written as an observable outcome — captured. Each item pairs with its proof via `rig proof add … --evidences` (media attached with `--media`); UI deliverables name their planned mockup.]

## Scope

[In / out for v0]

## Risks

[Known unknowns]

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`); full flow: the `mission-slice-sop` skill. Author intent → mini-requirements + proof contract (→ mockups for UI slices) → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA visual compare → `rig proof add … --evidences --media` drops into `proof/` (never hand-place evidence without the drop) → proof-lock (`--scope delivery`). Track on PROGRESS.md; a slice is **not done** until every proof-contract item has evidence. Verify with `rig scope audit`.
