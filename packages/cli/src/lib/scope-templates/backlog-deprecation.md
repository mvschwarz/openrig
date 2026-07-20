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

[The recorded intent — what is being deprecated and why. The Living Notes UI projects this text as the INTENT section.]

## Mini-requirements

1. [The deprecation path as observable outcomes. For a small deprecation this may BE the whole plan.]

## Proof contract

- [ ] [The migration landed / the removal is clean — captured. Pair with proof via `rig proof add … --evidences` (media attached with `--media`).]

## Target

[What is being deprecated]

## Current state

[How it works today; what depends on it]

## Migration

[Path off the deprecated thing]

## Removal

[When/how the deprecated thing gets deleted]

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`); full flow: the `mission-slice-sop` skill. Author intent → mini-requirements + proof contract (→ mockups for UI slices) → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA visual compare → `rig proof add … --evidences --media` drops into `proof/` (never hand-place evidence without the drop) → proof-lock (`--scope delivery`). Track on PROGRESS.md; a slice is **not done** until every proof-contract item has evidence. Verify with `rig scope audit`.
