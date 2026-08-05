---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
metadata:
  openrig:
    vendored_from: "Obra Superpowers (https://github.com/obra/superpowers)"
    vendoring_pattern: vendored-as-is
    last_upstream_check: "2026-05-13 (diff against plugin source pulled 2026-05-11 = identical)"
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**This rule serves shipping — it is not a ritual that outranks it.** It governs one thing: *claims that a verifiable result holds* ("tests pass", "build succeeds", "bug fixed") — run the check before you assert it, and scale the check to the stakes (a one-line copy tweak is not a test-suite ceremony). Don't dodge it with synonyms; equally, don't inflate it into a tax on the word "done" or a reason to keep re-proving instead of shipping the working thing.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Claiming a specific result is *proven* ("tests pass", "it's fixed", "build's green") before running the check in this message — enthusiasm itself is fine; an unverified **result claim** is the flag
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
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
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When the check itself lies — content over shape

Running a verification is necessary but not sufficient: a check can exit clean and still prove nothing. These are the named ways a green check lies — the failure siblings behind "evidence before claims." (Deeper treatment of *what* you verify against: `reference-first-verification`.)

- **Assert on CONTENT, never shape or count.** Output that *looks* like success — a non-zero count, a clean exit, no error text — can carry failure as its content. Before trusting a check, ask what its output looks like *when it fails*: if failure and success are indistinguishable at a glance, the check proves nothing. (`[1 lines]` and `No matches found` both read as "a match" to a line-count.)
- **Compare the returned value to the value you PASSED — never to a description of it.** A confident label (`evidenceRef NOW SET:` printed above the untouched original) is indistinguishable from a verification in a transcript. Diff the actual result against your actual input, not against a claim about it.
- **Find the untested axis.** Thorough coverage of ONE axis reads as thorough coverage overall. Ask what every one of your tests shares — a healthy manifest, a default option value, the happy path — and treat that shared assumption as the dimension you never tested. (A 15-case "exhaustive" harness whose only defect lived on the one axis every case held constant.)
- **A syntax check proves parseability and nothing else.** A clean `node --check` / lint / parse pass is the *covered* axis; boot and runtime are the untested one. Parseable ≠ sound.
- **A failure whose shape is a HANG reports nothing.** A bare `await` against a stated deadline that never re-checks cannot fail loudly. Race it against a timer so failure has a shape you can see.
- **A completeness inventory read through a truncating display is worthless.** When deciding *which occurrences to change*, count with `grep -c` / `grep -o` / full-line output — never `cut`, `head`, or a pager, which can hide a match *past* the cut (a doc pointer on a ~540-char line sat just past `cut -c1-180` and nearly shipped the defect inside its own fix). Distinguish *"I found N"* (a count) from *"I saw N"* (a display). Audit multiline prose **by paragraph, not by line** — a line filter both misses long-line matches and false-flags paragraphs whose companion text is on the next line. Then re-audit with a **different method** than the one that built the inventory — same-method re-checking reproduces the blind spot. (Empty/short output is a claim about your COMMAND until re-proven a second way.)

## Why This Matters

From 24 failure memories:
- your human partner said "I don't believe you" - trust broken
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion → redirect → rework
- Violates: "Honesty is a core value. If you lie, you'll be replaced."

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.
