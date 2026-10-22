---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, or before committing or creating PRs
metadata:
  openrig:
    vendored_from: "Obra Superpowers (https://github.com/obra/superpowers)"
    vendoring_pattern: modify-the-file
    last_upstream_check: "2026-05-13 (diff against plugin source pulled 2026-05-11 = identical)"
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims.

**This rule serves shipping — it is not a ritual that outranks it.** It governs one thing: *claims that a verifiable result holds* ("tests pass", "build succeeds", "bug fixed") — have evidence for the result before you assert it, and scale the check to the stakes (a one-line copy tweak is not a test-suite ceremony). Don't dodge it with synonyms; equally, don't inflate it into a tax on the word "done" or a reason to keep re-proving instead of shipping the working thing.

## The Rule

Before claiming a verifiable result, inspect evidence that supports that result for the candidate and environment you name. Use an existing result while its relevant inputs and assumptions still hold; rerun the affected check when they change or are uncertain. State whether you ran the check or inspected another owner's evidence. A source read, syntax check or partial test supports only its stated scope. Ordinary progress reports, delegation and moving to another task do not require a new test run. Required project checks still apply.

A completed run is not automatically current, and unchanged source does not establish unchanged live state.

For a claim about performance, also read [references/performance-claims.md](references/performance-claims.md).

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test output with 0 failures, for the candidate you name | A run on an older candidate, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Delivered outcome | Relevant artifact and observed result | An agent's success message or a diff alone |
| Requirements met | Promised outcomes checked against applicable evidence, gaps named | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Claiming a specific result is *proven* ("tests pass", "it's fixed", "build's green") without evidence that applies to it — enthusiasm itself is fine; an unverified **result claim** is the flag
- About to commit/push/PR without verification
- Trusting agent success reports
- Claiming more than a partial check covers
- Thinking "just this once"
- Tired and wanting work over

## Key Patterns

**Tests:**
```
✅ [Run test command, or read the named candidate's CI output] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Check each promised outcome against applicable evidence → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Inspect the artifact and the evidence it names → Report what was checked and what wasn't
❌ Pass on the report alone
```

## When the check itself lies — content over shape

A passing check is necessary but not sufficient: a check can exit clean and still prove nothing. These are the named ways a green check lies — the failure siblings behind "evidence before claims." (Deeper treatment of *what* you verify against: `reference-first-verification`.)

- **Assert on CONTENT, never shape or count.** Output that *looks* like success — a non-zero count, a clean exit, no error text — can carry failure as its content. Before trusting a check, ask what its output looks like *when it fails*: if failure and success are indistinguishable at a glance, the check proves nothing. (`[1 lines]` and `No matches found` both read as "a match" to a line-count.)
- **Compare the returned value to the value you PASSED — never to a description of it.** A confident label (`evidenceRef NOW SET:` printed above the untouched original) is indistinguishable from a verification in a transcript. Diff the actual result against your actual input, not against a claim about it.
- **Find the untested axis.** Thorough coverage of ONE axis reads as thorough coverage overall. Ask what every one of your tests shares — a healthy manifest, a default option value, the happy path — and treat that shared assumption as the dimension you never tested.
- **A syntax check proves parseability and nothing else.** A clean `node --check` / lint / parse pass is the *covered* axis; boot and runtime are the untested one. Parseable ≠ sound.
- **A failure whose shape is a HANG reports nothing.** A bare `await` against a stated deadline that never re-checks cannot fail loudly. Race it against a timer so failure has a shape you can see.
- **A completeness inventory read through a truncating display is worthless.** When deciding *which occurrences to change*, count with `grep -c` / `grep -o` / full-line output — never `cut`, `head`, or a pager, which can hide a match *past* the cut. Distinguish *"I found N"* (a count) from *"I saw N"* (a display). Audit multiline prose **by paragraph, not by line** — a line filter both misses long-line matches and false-flags paragraphs whose companion text is on the next line. Then re-audit with a **different method** than the one that built the inventory — same-method re-checking reproduces the blind spot. (Empty/short output is a claim about your COMMAND until re-proven a second way.)
