---
id: OPR.0.5.4.6
slice: 06-delivery-honesty
mission: release-0.5.4
status: intent
stage: wip
created: 2026-08-26
---

<!-- ELASTIC MIDDLE (three-capture-points doctrine): the SDLC fixes exactly
     three capture points — intent → proportional structured requirement →
     proof. Everything between is ELASTIC. For a small slice the
     mini-requirements below may BE the whole PRD; add depth only where the
     work demands it. The scaffold must not mint ceremony.
     Conventions SSOT: docs/reference/sdlc-conventions.md (installed: $OPENRIG_HOME/reference/sdlc-conventions.md) -->

# Slice 06 — S3 — Delivery Honesty End-to-End

## Intent

[The recorded intent, verbatim — kept in sync with the slice README.]

## Mini-requirements

1. [The concise one-glance requirement tier — this is where approval starts.]

## Proof contract

[MIRRORED 2026-08-26 by the workspace author (dev-planner, desk hygiene row 2ff03ab2), per
the standing mirror rule (slice-06/0.5.3 precedent): SPEC.md is CANONICAL; the proof-pairing
tool reads THIS file's exact `## Proof contract` section, so the SPEC promises are mirrored
ITEM-EXACT below — this banner is the only permitted delta. Divergence in the items is a
defect — fix it, never pick a winner silently.]

- [ ] STAGED-UNSENT DETECTED BY EFFECT: a send whose text lands AT the prompt (staged, not
      consumed) is reported as such by `send --verify` — RED-first against the current bytes
      (today "sent" is reported), GREEN after, with the discriminating evidence being pane
      effect, not a transport return.
- [ ] CONSUMED MEANS CONSUMED: a genuinely consumed send verifies positively; the two
      outcomes are never interchangeable and the staged report names what was checked.
- [ ] NO DOUBLE DELIVERY: the staged remedy is the submit path (the single Enter), proven to
      deliver exactly once; a blind re-send is never the product's suggestion.
- [ ] INTERIM LORE RETIRED: the seat-discipline note ("staged-at-prompt, fix is one Enter")
      is demonstrated unnecessary by the product's own report; retirement recorded in the
      guidance that taught it, cited by path.

## Notes (elastic)

[Design, seams, risks, sequencing — only as much as the slice needs.]
