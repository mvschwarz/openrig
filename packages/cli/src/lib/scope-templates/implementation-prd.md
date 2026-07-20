---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: intent
stage: wip
created: {{created_date}}
---

<!-- ELASTIC MIDDLE (three-capture-points doctrine): the SDLC fixes exactly
     three capture points — intent → proportional structured requirement →
     proof. Everything between is ELASTIC. For a small slice the
     mini-requirements below may BE the whole PRD; add depth only where the
     work demands it. The scaffold must not mint ceremony.
     Conventions SSOT: docs/reference/sdlc-conventions.md (installed: $OPENRIG_HOME/reference/sdlc-conventions.md) -->

# Slice {{slice_number}} — {{title}}

## Intent

[The recorded intent, verbatim — kept in sync with the slice README.]

## Mini-requirements

1. [The concise one-glance requirement tier — this is where approval starts.]

## Proof contract

- [ ] [One promised deliverable, written as an observable outcome — captured. This list is the source the DELIVERED section pairs proof against — pair each item via `rig proof add … --evidences --media` (never hand-place evidence without the drop); UI deliverables name their planned mockup (`plannedRef`).]

## Notes (elastic)

[Design, seams, risks, sequencing — only as much as the slice needs.]
