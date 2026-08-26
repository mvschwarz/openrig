---
id: OPR.0.5.4.6
slice: 06-delivery-honesty
mission: release-0.5.4
status: intent
stage: wip
verified: 2026-08-26 against PLANNING.md Wave 1 S3 + the S2 lock record (see Evidence)
created: 2026-08-26
approved-spec-by: orch-advisor@v-openrig-build
approved-spec-at: 2026-08-26T06:51:37.788Z
locked-artifacts:
  - name: Implementation PRD
    path: IMPLEMENTATION-PRD.md
    kind: spec
provenance: transport:v1
approved-spec-priors: 2
---

# Slice 06 — S3 — Delivery Honesty End-to-End

Workspace authored 2026-08-26 by dev-planner (desk hygiene row 2ff03ab2) so the slice has a
SPEC home and a proof/ scaffold before dispatch. Per the wave-SDLC ruling this locks by desk
on frozen hashes, no review round. S3 dispatches SERIALIZED BEHIND S2 (same file territory).

BASE REFRESH 2026-08-26 (re-stamp chain, dev-driver row e93d3989 — references only, ZERO
scope change): S2 has FOLDED; the S3 build base is clean main `886c3f1d5` (the S2 fold),
S2-base preservation verified by dev-driver at that base (transport-routes 43/43, cli
send/broadcast 68/68) before any S3 asset. RED proof assets exist as a test-only commit
`e347f84ce` (send.test.ts sha256 9d038e33…, RED run capture
.evidence/RED-s3-staged-vs-consumed-at-886c3f1d5.txt sha256 2b4e732b… — PROOF-1 and
PROOF-3 RED at clean-main bytes, PROOF-2 pin green). Territory reading confirmed consistent
with the locked text: session-transport.ts is outside mini-req 3's territory, so the
staged-vs-consumed discrimination lives CLIENT-SIDE in send.ts, composing the primitives
walk.ts already uses (capture evidence + submitOnly submit) — this was the locked design's
meaning, now stated explicitly. The prior frozen SPEC hash 8b652113… was reproduced
byte-exact by this author from the current file minus the 06:37Z desk-stamp frontmatter —
the earlier divergence dev-driver flagged was the approval stamp alone, no content drift.

## Intent

"Sent" must mean CONSUMED, never merely typed (PLANNING.md Wave 1 S3; absorbs carried slices
02 delivery-verify-honesty + 04 transport-sender-trust). `send --verify` detects
staged-unsent by EFFECT — the walk verb's consumption-verification + turn-closure pacing
pattern, already shipped in 0.5.3, generalized to plain sends. Evidence class: the
send-staging specimens (2 in one mechanics run) + the T1 walk saga; the interim discipline
("text sitting AT the prompt = staged, not consumed; the fix is one Enter, not a re-send")
becomes product behavior instead of seat lore.

## Mini-requirements

1. `send --verify` distinguishes CONSUMED from STAGED by effect (the pane's post-send state,
   the walk pattern generalized), never by transport return codes — whose negative signals
   are measured-unreliable.
2. A staged-unsent detection reports itself honestly (names what was checked and what was
   observed, to the S1 error bar) and the remedy surface is the existing submit path — no
   re-send, no double delivery.
3. Territory (inherits S2's exclusive files, serialized behind S2's fold):
   packages/daemon/src/routes/transport.ts, packages/cli/src/commands/send.ts,
   packages/cli/src/commands/broadcast.ts, and their focused tests only.
4. Seams held: S2's unknown-sender behavior is the base and is not re-opened; the door07
   evidence chain (row 53f6aed1) remains citable here — this slice is where
   sent-means-consumed lives.

## Proof contract

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

## Repro

Send text to a seat whose pane leaves it staged at the prompt (the send-staging class):
`send --verify` today reports sent/verified while the recipient never consumed the text.

## Expected

The verify path reports staged-vs-consumed truthfully by effect, names its evidence, and
points at the single-submit remedy.

## Actual

"Sent" is reported for staged text; the discrimination lives only in seat lore (capture and
look), and blind re-sends double-deliver.

## Impact

Every cross-seat wake and instruction; the T1 walk saga and two same-run staging specimens
measured the cost in 0.5.3.

## Evidence

- PLANNING.md Wave 1 S3 (the defining entry, read whole by the author 2026-08-26).
- The S2 dispatch baton (row 6712d850) fixing the shared territory and the serialization
  rule; the S2 locked spec (OPR.0.5.4.3) as the base whose behavior this slice must not
  re-open.
- 0.5.3 record: the send-staging specimens and the T1 walk saga (mission release-0.5.3
  NOTES.md §6); the walk verb's shipped consumption-verification pattern (delivered
  piece-by-piece with per-piece verification) as the generalization source.

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`); full flow: the `mission-slice-sop` skill. Author intent → mini-requirements + proof contract → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA → `rig proof add … --evidences` → proof-lock (`--scope delivery`). A slice is **not done** until every proof-contract item has evidence.
