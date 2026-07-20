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

[The recorded intent — the debt to pay down and why now. The Living Notes UI projects this text as the INTENT section.]

## Mini-requirements

1. [The paydown as observable outcomes. For small debt this may BE the whole plan.]

## Proof contract

- [ ] [The debt is paid and pinned (tests/measures) — captured. Pair with proof via `rig proof add … --evidences` (media attached with `--media`).]

## Current state

[How the code/system looks today]

## Cost

[What this debt costs us — surface friction, bug class, perf, etc]

## Proposal

[How to pay it down]

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`); full flow: the `mission-slice-sop` skill. Author intent → mini-requirements + proof contract (→ mockups for UI slices) → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA visual compare → `rig proof add … --evidences --media` drops into `proof/` (never hand-place evidence without the drop) → proof-lock (`--scope delivery`). Track on PROGRESS.md; a slice is **not done** until every proof-contract item has evidence. Verify with `rig scope audit`.
