---
name: systematic-debugging
description: Investigate root cause before proposing or applying fixes.
---

# Systematic Debugging

No random fixes. Find the root cause first.

## Use this when

- a test fails
- the runtime behaves unexpectedly
- the UI or control plane disagrees with what you expected
- an agent is blocked and the reason is not already obvious

## Required loop

1. Read the actual error or prompt carefully.
2. Reproduce the problem consistently.
3. Gather evidence:
   - exact command
   - exact output
   - relevant file or code path
4. Form one concrete hypothesis.
5. Test that hypothesis with the smallest possible change.
6. Verify the result before claiming the issue is fixed.

## Do not do this

- stack multiple speculative fixes together
- call a blocker "probably permissions" without checking the pane or transcript
- patch symptoms when you do not yet know where the failure starts

## Output shape

When you report a blocker, say:
- what happened
- where you saw it
- what you think is causing it
- what next check would confirm or disprove that
