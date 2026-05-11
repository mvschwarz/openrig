// V0.3.1 slice 21 onboarding-conveyor.
//
// Narrative tab content for the getting-started mission's two slices.
// The scaffold writes these as README.md / timeline.md / PROGRESS.md
// inside each slice folder so a new operator's fresh install ships
// with a click-through-to-learn experience: opening each tab teaches
// both (a) what a conveyor run is and (b) what each Project tab does.
//
// PARITY CONTRACT with CLI:
// `packages/cli/src/commands/config-init-workspace.ts` duplicates the
// same narrative inline because cli + daemon don't cross-import today.
// `packages/daemon/test/getting-started-narrative-parity.test.ts`
// asserts byte-identical content with the CLI counterpart so drift
// fails CI. If you update this content, update the CLI mirror in
// lockstep.
//
// Content authored from the slice 21 onboarding-conveyor IMPLEMENTATION-PRD (Appendix A) in the substrate openrig-work tree.

export const FIRST_CONVEYOR_RUN_README = `# First Conveyor Run

Welcome to OpenRig. This is the first slice in your getting-started mission. It exists to teach you what a **conveyor run** is + how OpenRig moves work through a multi-agent topology.

## What a conveyor run is

A **conveyor** is OpenRig's central work-movement primitive. One conveyor run = one complete flow of work through your topology:

1. **Slice declared** — operator (you) or an agent declares a slice with intent + acceptance criteria
2. **Work routed** — orchestrator picks the slice up + routes it to the right agent
3. **Agents collaborate** — work moves agent-to-agent via durable handoffs (queue items)
4. **Evidence accumulates** — each step leaves a trail: commits, files, proof packets, screenshots
5. **Slice closes** — acceptance criteria met; orchestrator routes the result back

You're looking at a mocked conveyor run RIGHT NOW. The other tabs (Story / Progress / Artifacts / Tests / Queue / Topology) each show a different slice of this same run.

## Walking the tabs

- **Overview** (you're here) — read what a slice intends + how to use the rest of the tabs
- **Story** — narrative timeline of what happened, beat by beat
- **Progress** — acceptance checklist; what's done, what's pending
- **Artifacts** — files produced, commits, proof packets — the durable evidence trail
- **Tests** — pass/fail summaries + screenshots + verification proof
- **Queue** — operational qitems showing how work moved between agents
- **Topology** — the rig graph; which agents touched this slice + which edges fired

## Click through

Try them in order. Each tab teaches itself.
`;

export const FIRST_CONVEYOR_RUN_TIMELINE = `# Story — First Conveyor Run

## 2026-04-15 09:00 — Slice declared

Operator request: "Build a CLI tool that lints todo lists." Slice declared in \`getting-started/slices/first-conveyor-run/\`. Acceptance: \`tdl lint <file>\` exits non-zero on malformed entries.

## 09:02 — Orchestrator routes

\`orch-lead@getting-started\` picks up the slice. Routes to \`driver@getting-started\` via \`rig queue handoff\`. Driver receives nudge; opens IMPL-PRD; reads acceptance.

## 09:05 — Driver picks up

Driver claims qitem. Reads slice scope. Surveys existing tdl repo (this is a worked example — imagine the repo is real). Plans: parse YAML; validate entries; exit code per finding.

## 09:30 — First commit

\`feat(lint): parse + validate todo entries\` — driver commits 4 files. Stream event emitted; visible in Artifacts tab.

## 10:15 — Driver hands to reviewer

Acceptance met locally. Driver hands off to \`reviewer@getting-started\`. Reviewer opens diff; reads tests.

## 10:25 — Reviewer flags concern

"Edge case: what about UTF-8 entries with combining characters?" Hands back to driver as \`concerning\`.

## 10:40 — Driver addresses

Driver fixes UTF-8 handling. Re-runs tests; all pass. Hands back.

## 11:00 — Reviewer accepts

\`accept\` decision; closes qitem with \`closure-reason: handed_off_to orch-lead\`. Conveyor proceeds.

## 11:05 — Slice ships

Orchestrator merges. Proof packet generated. Slice marked SHIPPED.

---

**What you just read**: one conveyor run from declaration to ship. ~2 hours wall-clock; 3 agents involved; 1 handoff with concern + remediation; 5 stream events; 1 proof packet.

The Story tab shows this kind of narrative for any real slice. Driver-authored \`timeline.md\` files live in each slice folder; this is yours to read + your operator's to update as work moves.
`;

export const FIRST_CONVEYOR_RUN_PROGRESS = `---
title: First Conveyor Run Progress
status: active
mission: getting-started
rail-item: getting-started
slice: first-conveyor-run
---

# Progress — First Conveyor Run

## Acceptance criteria

- [x] Parse YAML todo entries
- [x] Validate per-entry shape (id, title, status, due-date)
- [x] Exit non-zero on malformed entries
- [x] Handle UTF-8 entries with combining characters
- [x] Tests pass (12/12)
- [x] Reviewer accepts
- [x] Slice merged

## Status: SHIPPED

This was a mocked conveyor run — no real code was produced. But the Progress tab works the same way for real work: as acceptance criteria are met, boxes get checked; the operator can scan at a glance whether the slice is on track.

## How the Progress tab works

The tab renders the slice's \`PROGRESS.md\` markdown file. Driver updates it as work progresses. Operator scans it during walks. Founder reviews at slice closure.

Try writing one for a real slice you start. It's just markdown; live updates appear here.
`;

export const INSPECT_PROJECT_EVIDENCE_README = `# Inspect Project Evidence

The previous slice (First Conveyor Run) showed you what a conveyor run looks like as it happens. This slice teaches you how to inspect the evidence after a run completes.

## Why inspect evidence?

In OpenRig, agents work autonomously. The operator (you) doesn't watch every keystroke. Instead, the operator:

1. Declares slices with clear acceptance
2. Routes them to agents
3. Inspects evidence when slices close

The Artifacts + Tests + Queue + Topology tabs are your inspection surface. They show you what happened, with enough detail to:

- Verify the acceptance was actually met
- Spot subtle issues a passing test might miss
- Build trust in the agents over time

## Walking the tabs

- **Overview** — you're here; learn what to look for
- **Story** — read the narrative of what happened (high-level)
- **Progress** — acceptance status at a glance
- **Artifacts** — the durable evidence: files, commits, proof packets. **THIS IS THE TAB YOU LEARN MOST FROM.**
- **Tests** — pass/fail + screenshots + verification proof
- **Queue** — who handed what to whom (audit trail of decisions)
- **Topology** — which agents touched this; which edges fired

## Key inspection skills

When walking a finished slice:

1. **Read the Story** for context — what was the operator trying to do?
2. **Check Progress** — did acceptance actually pass? Any TODO boxes?
3. **Open Artifacts → Files** — sample-read 2-3 files; does the code match what the Story claimed?
4. **Open Tests → Proof packets** — do screenshots actually show what was claimed?
5. **Read Queue** — were there concerning decisions? Hand-offs to escalation?
6. **Skim Topology** — were unexpected agents involved?

Trust comes from repeated successful inspections, not from a single proof packet.
`;

export const INSPECT_PROJECT_EVIDENCE_TIMELINE = `# Story — Inspect Project Evidence

This slice mirrors the previous one (First Conveyor Run). The same agents shipped the same work. But this view is from the inspector's angle, not the runner's.

## 11:10 — Operator opens project

Operator (you, in the real world) opens \`/project/slice/first-conveyor-run\` after the slice ships. First read: the Progress tab. All boxes checked.

## 11:12 — Read Story

Operator reads the Story narrative. Notices the reviewer's UTF-8 concern + driver's remediation. Confidence-building: there was friction, friction was caught, friction was addressed.

## 11:15 — Open Artifacts

Operator clicks Artifacts. Sees 4 commits, 5 files, 1 proof packet, 2 screenshots. Opens commit \`feat(lint): parse + validate todo entries\`. Reads the diff.

## 11:18 — Read tests

Operator opens Tests tab. 12/12 passing. Opens the proof packet — screenshot shows CLI output \`Error: malformed entry at line 3\`. Visually verifies the acceptance was met.

## 11:22 — Skim Queue

Operator scrolls Queue. 4 qitems in chronological order. Sees the \`concerning\` decision + subsequent \`accept\`. Confidence reinforced.

## 11:25 — Mark complete

Operator marks slice acceptance complete. Closes the inspection.

---

**What you just read**: a clean inspection in ~15 minutes. Operator builds trust through the evidence trail. This is the OpenRig usage pattern at scale: declare → route → inspect.
`;

export const INSPECT_PROJECT_EVIDENCE_PROGRESS = `---
title: Inspect Project Evidence Progress
status: active
mission: getting-started
rail-item: getting-started
slice: inspect-project-evidence
---

# Progress — Inspect Project Evidence

## Inspection checklist

- [x] Read Story (context: what was being done)
- [x] Check Progress (acceptance status)
- [x] Sample-read Artifacts files
- [x] Verify Tests proof packets visually
- [x] Skim Queue for concerning decisions
- [x] Skim Topology for unexpected agents

## Status: COMPLETE

This was a mocked inspection — a worked example of the inspection workflow.

## How to apply this

For any real slice that ships in YOUR project: open the slice page, walk the tabs in this order, check each box mentally. Over time you'll develop instincts for what passes the smell test vs what needs deeper investigation.
`;

/** Slice id → narrative content map. Scaffold callers use this to
 *  override the boilerplate sliceReadme / sliceProgress for the two
 *  getting-started slices. Other slices keep the boilerplate. */
export const GETTING_STARTED_NARRATIVE: Record<
  string,
  { readme: string; timeline: string; progress: string }
> = {
  "first-conveyor-run": {
    readme: FIRST_CONVEYOR_RUN_README,
    timeline: FIRST_CONVEYOR_RUN_TIMELINE,
    progress: FIRST_CONVEYOR_RUN_PROGRESS,
  },
  "inspect-project-evidence": {
    readme: INSPECT_PROJECT_EVIDENCE_README,
    timeline: INSPECT_PROJECT_EVIDENCE_TIMELINE,
    progress: INSPECT_PROJECT_EVIDENCE_PROGRESS,
  },
};
