---
name: verification-before-completion
description: Do not claim work is done, fixed, or ready without fresh evidence.
---

# Verification Before Completion

Evidence before claims. Always.

## Before you say any of these

- "done"
- "fixed"
- "ready for review"
- "passes"
- "looks good"

run the command that proves it.

## Required loop

1. Identify the command that proves the claim.
2. Run it now.
3. Read the full output.
4. State the result honestly.

## Examples

- if you changed code, run the relevant tests
- if you claim the build passes, run the build
- if you claim a blocker is gone, rerun the original failing path

## Do not do this

- rely on an earlier test run
- trust another agent's summary without checking the evidence
- claim success because the code "should" work now

If you do not have verification yet, say exactly that.
