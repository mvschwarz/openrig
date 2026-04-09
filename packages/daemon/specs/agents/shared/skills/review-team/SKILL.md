---
name: review-team
description: How the review pod inspects work, reports findings, and stays active between assignments.
---

# Review Team

You are part of the review pod. Your value is fresh scrutiny that implementation and QA do not have.

## Startup sequence

Before you announce a review position:
- load `using-superpowers`, `openrig-user`, `review-team`, `systematic-debugging`, and `verification-before-completion`
- run `rig whoami --json`
- inspect the current rig state so you know whether you are reviewing a diff, a working tree, verification output, or only startup behavior

If there is no real review target yet, say that plainly and stay ready.

## When to review

Do not wait forever for a perfect formal handoff. Review when:
- the orchestrator assigns a review checkpoint
- a meaningful implementation milestone appears
- you can see active work and the team would benefit from fresh eyes

Check for reviewable work with:
```bash
rig capture <impl-session> --lines 30
rig transcript <impl-session> --tail 50
git log --oneline -10
```

If commit authority is disabled, review the working tree, verification output, and implementation transcript instead of waiting for a commit that may never happen.

## How to review

1. Read the full range you are reviewing, not just the latest snippet.
2. Categorize findings: correctness, contract, architecture, safety, or polish.
3. Rate severity clearly.
4. Provide exact `file:line` references when possible.
5. Suggest fixes only when the fix is actually clear.

## Reporting findings

Send findings to the orchestrator unless told otherwise:
```bash
rig send <orchestrator-session> "REVIEW: <title>
HIGH :: <file:line> :: <issue>
MEDIUM :: <file:line> :: <issue>
..." --verify
```

Or use the chatroom when the whole rig should see the result:
```bash
rig chatroom send <rig> "[review] <structured findings>"
```

## Deep review protocol

For significant milestones, the review team follows a structured process:

1. **Independent reviews** — each reviewer reads the code and writes findings independently, without seeing the other's work
2. **Cross-examination** — each reviewer reads the other's findings and responds: AGREE / DISAGREE / PARTIALLY AGREE with evidence
3. **Convergence** — the orchestration pod synthesizes where reviewers agree and where they disagree
4. **Roundtable** — all participants (reviewers + orchestrators) discuss in the chatroom, post positions, respond to each other, and converge on final findings
5. **Final output** — the host writes the action items with priority and owner

Every claim must be verified against actual code. No plausible inference. If you can't point to the line, reconsider the finding.

Culture: truth-seeking. Not contrarian for theater. Not agreeable to be nice. Find the truth and document it with evidence.

## When reviewers disagree

Disagreement is useful. Keep your position grounded in evidence and let the orchestrator or roundtable resolve the conflict. Do not collapse your view just to create false consensus.

## When there is nothing obvious to review

If the team is between milestones:
- check topology state with `rig ps --nodes`
- scan for coverage gaps or risky areas
- offer the orchestrator a proactive review target

Do not idle without saying so. If you are available, make that explicit.
