# The wave SDLC — parallel build, wave-level review, composition as the care dial

Graduated 2026-08-28 from the working playbook of the team that proved it live; the
team-specific custody mechanics stay in that team's playbook. Lock stamps in this
model are ADDITIVE: approval appends metadata and never rewrites authored bytes, so
a candidate's identity survives its own approval.

## The model in one paragraph

Slices build IN PARALLEL across every build-class seat, each in a DISJOINT FILE
TERRITORY, each merged serially by one integrator the moment its candidate freezes
with builder-proven receipts. Independent review happens ONCE PER WAVE over the wave's
whole accumulated range — two reviewers with different vantages (ideally different
runtimes), never the writers — and their findings drive fix rounds that re-earn both
verdicts at the round's final revision. Checks stay per-slice (failing-test-first
proof, verify-by-effect, honest receipts); rounds happen per-wave.

## The mechanics

1. **PLAN:** wave entries in the plan of record; the planner shapes specs; the plan
   authority locks them. Every slice gets a real workspace or proof has no home.
2. **DISPATCH:** batons fan out with EXCLUSIVE file territories. Territory overlap =
   serialize. Territory conflict discovered mid-build = STOP AND RULE, never a silent
   expansion.
3. **BUILD:** failing-test-first against a pristine base with committed final test
   bytes; freeze a single candidate revision; receipts cite the FINAL revision
   (re-earned after any rebase).
4. **MERGE:** integrator-only, serially, verified at source each time (candidate
   parent equals pre-merge tip; changed files equal declared territory). Merge
   announcements are REBASE TRIGGERS for every open candidate.
5. **WAVE REVIEW:** fires when the wave's build completes. Two independent reviewers,
   base-scoped at the tip, writers excluded from reviewing their own work. The two
   gates ask DIFFERENT questions — does the structure hold, versus does each claim
   survive contact with source. That is the design, not redundancy.
6. **FIX ROUNDS:** findings become forward-fix candidates (merges stand; merged is
   not running). One re-review pass per round re-earns both legs at the final
   revision. Narrow rechecks for narrow corrections.
7. **SEAL:** both legs clear at one revision = wave sealed; the next slot opens.

## THE WAVE IS THE CARE DIAL

Wave COMPOSITION is the control surface for how carefully a piece is handled: a
large, complicated, or load-bearing slice gets a wave OF ITS OWN (its review ceremony
fires for it alone); a big piece can even split across waves. This decouples what an
older model conflated: mission and slice workspaces stay flexible organizational
containers; waves are the separate layer that sequences work, assigns it, and prices
its handling care. Care is a per-piece property, never a per-mission one.

## When to use it

Many small-to-medium, root-caused, evidence-backed slices; enough seats to
parallelize; territories that partition cleanly; an integrator who can merge serially
and verify fast.

## When NOT to use it

Design-uncertain or shared-region work (one slice, classic two-leg review, or a
design session first). Anything irreversible within the hour (publish, cutover,
destructive operations) — that is the heavy path. And when no independent non-writing
reviewers exist: nothing ever self-reviews; without them the wave gate is theater.

## Failure modes, with the mitigations that worked (dated observations, 2026-08)

- **Freeze-merge races:** a candidate freezes seconds before a merge moves the tip.
  Mitigation: zero-overlap restack with content-identity proof (stable patch-id) in
  an isolated worktree; builder-side self-catch on merge announcements.
- **Evidence theater:** a failing test that fails for the wrong reason reads
  identical to a real one. Mitigation: reviewers re-derive the failures
  independently; false characterizations retire to a correction history, never a
  silent rewrite.
- **Presence-not-absence tests:** asserting the true line exists while the false
  line still prints. Rule: pin the ABSENCE of the false claim in every encoding.
- **Phantom checkout status:** merge-by-reference leaves a shared checkout's index
  stale. Never build or commit from a shared checkout; sync its index at fences.

## Measured outcome from the proving run (dated, one team, 2026-08)

Eight slices plus five fix candidates plus two addenda built and merged in ~2.5 hours
across five writing seats; two wave passes plus three fix-round passes replaced ~20
per-slice review rounds. Defect yield went UP: the reviewers' findings never
overlapped once across three consecutive verdicts, and the builders' green suites had
missed every one of them — wave-level review sees cross-slice seams per-slice review
structurally cannot. Correction latency: one live defect went found→root-caused→
specced→locked→built→merged in 24 minutes, because no review round stood between a
locked spec and a building seat.
