# PROOF — OPR.0.4.7.3 Shared by label

> **WHO/WHEN:** the impl/QA pair that worked the slice, at slice-close — a slice is NOT done until this file exists and every proof-contract item has evidence (mapped 1:1, artifacts under `proof/`). See the `mission-slice-sop` skill + the conventions SSOT (`docs/reference/sdlc-conventions.md`).
>
> **HOW (the drop verb, not hand-placement):** put media files under `proof/`, then ATTACH them with `rig proof add OPR.0.4.7.3 --artifact-type qa --verdict PASS --candidate-sha <tip> --money-evidence "<one line>" --evidences "1" --media "screenshot-01.png"` — the drop writes the C1 header the Living Notes DELIVERED pairing joins on. Hand-placing files without a drop leaves the deliverable unpaired and `unverified`.

Closed by: dev1-qa@product-team   Date: 2026-07-11   Verdict: pass-with-residue

## What this proves

Final candidate `5afea9da6bbd248191f78ef2613d1fd8706a38ae` adds a server-resolved,
privacy-safe Shared-by label only to non-owner album cards. Focused read-model
tests pass 10/10, the exact-markup Tailwind render matches the locked mockup,
and independent design coherence review passed all four visual states.

## Artifacts (media in proof/)

Dropped via `rig proof add … --evidences … --media …` (one drop per verdict; media attached, never only hand-listed):

- `proof/qa-PASS-shared-by-label.md` — canonical C1 QA PASS mapped to proof-contract items 1-6.
- `proof/qa-delivered-shared-by-label.png` — exact AlbumTile markup rendered with the app's Tailwind v4 compiler and theme tokens; shows shared, fallback, owner, and long-name states.

## Residue / caveats (if any)

- The configured Clerk publishable/secret keys are mismatched and local Supabase cannot run without Docker, so a live authenticated two-account screenshot was unavailable. Functional data plumbing is covered by `getAlbumsForUser` tests and source trace; visual fidelity is covered by the real-Tailwind browser render and design PASS.
- The full unit baseline remains 145 passed / 2 failed in unchanged `actions/__tests__/members.test.ts`; the focused candidate suite is 10/10.
- Repository lint/type/format gates have pre-existing infrastructure/baseline failures documented in the post-edit review bundle; no target-file diagnostic was introduced.
