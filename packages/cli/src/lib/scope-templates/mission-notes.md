---
mission: {{mission_id}}
name: {{mission_name}}
status: active
authored: {{created_date}}
last-updated: {{created_date}}
---

# Mission Notes — {{mission_name}}

> Read the frontmatter `last-updated` first. If stale relative to runtime,
> treat this file as `provisional` and re-verify before relying on it.
> Pointer-first by design — index durable canonical artifacts; don't duplicate
> them (duplication is the stale-breadcrumb failure mode this convention
> exists to kill).

## §1. Top-of-mind context

(Current most-load-bearing state — gates, open scope-decisions, in-flight
surprises. Updated by anyone when material changes. Keep to 5-15 lines.)

## §2. Active workstreams + drivers + tips

(Per-workstream rows. THIS SECTION IS THE MISSION CODEMAP. Each row:
state / driver / branch+tip-SHA / latest blocker or ACK.)

- (workstream-id) — state — driver — tip-SHA — blocker/ACK

## §3. Open scope-decisions

(Labeled gates the operator owns. Per gate: where the gate is, what's needed,
who routed.)

- OQ-1: (decision needed) — gate at <artifact-path> — surfaced by <seat>

## §4. Slice inventory

(Full table of slices on this mission.)

| # | slice | state | driver | blocker |
|---|---|---|---|---|

## §5. Pending dispatches

(Next-go items waiting on driver availability or convergence. Immediately-ready
set, not full backlog.)

## §6. Ledgers

(Mission-specific shared ledgers: release version + tag, SC counts, cumulative
deltas, etc.)

## §7. Banked memories that apply here

(Bulleted: banked-feedback / banked-project memories load-bearing on restore
for this mission. Ones learned during this mission go into the same list.)

## §8. Convention pointers

(Which banked conventions this mission inherits. Cross-reference each by path.
This section is the principles/conventions inheritance surface for the mission.)

- `conventions/mission-notes/README.md` — this convention (apply on every restore)

## §9. Reconstruction protocol

(Commands to run after compaction or for onboarding. Refresh as the mission's
restore-needs evolve.)

1. `rig whoami --json` — confirm seat identity
2. Read this file's §1 + your §A-§X section + this §9
3. Read `missions/{{mission_id}}/README.md` for mission scope
4. Read `missions/{{mission_id}}/PROGRESS.md` for delivery state
5. `rig queue list --destination <your-session>` — your durable inbox
6. State "restored from {{mission_id}}; resumed at <action>" before acting

## §10. What NOT to reconstruct

(Explicit pruning — completed slices / merged commits / closed ACK packets are
recoverable on demand and don't need to be in working memory. Name them to
free attention.)

## §A. <first-seat>@<rig> notes

(First seat's notes. Pattern: append cont.N entries with date + state of the
world from this seat's perspective. Latest = truth. Other seats READ but
don't modify.)

DONE {{created_date}} (cont.0 — mission scaffolded):
- Mission scaffolded via `rig scope mission create`. Template applied; this
  file is the seed state. First substantive cont.1 entry follows when work
  begins.

## §B / §C / ... — per-seat sections

(Each additional seat adds an h2 ## §X section under their own header as they
join. Section pattern matches §A.)
