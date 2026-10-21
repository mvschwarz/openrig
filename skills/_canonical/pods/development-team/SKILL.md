---
name: development-team
description: Use when a development pod begins or hands off implementation, QA, or design work.
---

# Development Team

The pod turns the assigned user outcome into working software. Builders, QA and
designers are capabilities; neighboring roles may be held by one seat unless
independence was explicitly selected.

## Start from the work

Run `rig whoami --json`, then resolve `project.yaml -> mission.yaml -> active
slice.yaml -> selected component or wave map -> addressed context`. The complete
lookup and precedence rule is `docs/reference/product-journey-sdlc.md#resolve-the-selected-path`
(installed: `$OPENRIG_HOME/reference/product-journey-sdlc.md#resolve-the-selected-path`).
Read the selected addresses and source needed for this task; skills available in
your profile are capabilities, not a mandatory reading list. No composition means
light Part A. Role names and idle seats add no gates. Explicit rigor and authored
wave boundaries retain their named checks.

## Build and verify

Clarify consequential uncertainty, inspect the existing seam, then complete one
coherent outcome. Reproduce a defect before repairing it; use tests that distinguish
the failure and verify through the public surface. Keep chunks as large as the
outcome and file territory permit. TDD is a feedback loop, not a two-seat protocol.
When the work consolidates or refactors existing behavior, read
[references/refactoring.md](references/refactoring.md).

The builder reports the exact candidate, changed behavior, commands and observed
results, with remaining uncertainty. No universal pre-edit proposal, QA approval
or post-edit gate is implied. When one is explicitly selected, honor its boundary
and send the relevant evidence directly to its owner.

## QA and design

QA compares the delivered behavior with the actual contract. Read the diff and
exercise the result; avoid tests that merely repeat the implementation. On a tiny
change the builder may hold QA. Independent QA excludes the author when selected.
A wave receives independent review at its authored boundary, not per slice.

Design clarifies user flows and ambiguous behavior when the outcome needs it.
Browser and dogfood skills load for a relevant UI journey, not every task. During
assigned dogfood, fix-and-retest only within the granted scope; a read-only
assignment stays read-only. If a tester becomes an author, preserve that attribution
when independent evaluation is required.

## Blockers and return

Use `systematic-debugging` for an unexpected failure and
`verification-before-completion` before claiming success. A permission prompt is
a concrete blocker; report the command and consequence instead of labeling it
progress. A missing decision goes to the owner who can settle it.

Return the candidate and evidence through the selected handoff. Do not create
obligations just to keep an idle QA, guard or reviewer occupied. Quality is a
working product with honest evidence, not the number of transfers.
