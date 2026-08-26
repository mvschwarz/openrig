---
id: OPR.0.5.4.8
slice: 08-hermeticity-guards
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

# Slice 08 — S6 — Hermeticity Guards

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

- [ ] DB-OUTSIDE-HOME LOUD: RED-first (today it proceeds silently); after — the mismatch
      fails loud naming both resolved paths; the deliberate-override path works; a
      legitimate explicit split-path config still runs (both directions evidenced).
- [ ] NO SILENT CANON ROLLBACK: RED-first with an older-versioned scratch install against
      newer shared canon; after — the vendor step refuses/skips per the authority rule and
      says so; a legitimate newer-over-older vendor still lands.
- [ ] RECAP-WRITE PROVISIONS: RED-first on a valid seat with no recap directory (today it
      fails); after — the write succeeds via supported provisioning, and the provisioned
      layout matches the recap store's contract (superseded-chain intact).
- [ ] EFFECT EVIDENCE, NOT MESSAGES: each guard's proof includes the on-disk effect (the DB
      actually refused/used, the canon bytes actually unchanged/updated, the recap file
      actually written) — never a success message alone.

## Notes (elastic)

[Design, seams, risks, sequencing — only as much as the slice needs.]
