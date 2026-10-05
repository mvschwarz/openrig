# The release boundary — housekeeping run once per fence

A CHECKLIST OF JUDGMENT GUIDES, not gates: every item says WHY, most items are one
act, and anything situational expires at the next boundary. Runs once per release
fence, after the prior release's ceremony completes. The project and seat owners
select the applicable actions and preserve their reasons in the boundary record.

## 1. Seats — reset or re-prime, per each seat's continuity needs

- **Choose continuity per seat, with its owner.** Fresh launch, managed compaction
  with re-prime, or retaining the current session serve different needs. Role names
  alone do not select one. Record the choice, the reason and custody of open work;
  selecting a procedure does not itself authorize a lifecycle action.
- **Fresh launch** can clear accumulated context and load current startup guidance.
  Before an authorized exit, preserve the seat's earned knowledge and continuation
  (recap where provisioned); verify the new occupant's actual identity and install.
- **Managed compaction with re-prime** can retain planning continuity while
  restoring the context needed for the next phase. **Retaining the current session**
  can preserve ongoing custody. In either case, inspect which guidance is stale and
  deliver the selected current context; an edit on disk is not delivery to a session.
- **Re-prime = the world walk + the current capability delta + the mission install**
  per the mission-install convention (`docs/reference/mission-install.md`): the world
  half restores where-you-are; the project half (five layers, two depth profiles,
  paced pointer-walk) restores what-you-are-doing. Composing from named artifacts
  keeps source precedence visible.
- **THE CEREMONY IS THE EXPERIMENT.** Every act above runs on the product's own
  primitives, so the ceremony doubles as their live test. Observe passively: what did
  each re-primed seat's first natural turns reach for, and what broke? Findings land
  in one dated observations file beside the boundary record.

## 2. Memory — distill, never accumulate

- Per-seat learned files: a distillation pass. The cut test: "has this changed a
  decision recently?" Keep those; move the rest to a dated archive section in the
  same file. A learned file at volume stops constraining and starts justifying.
- Any shared agent memory: same pass, same test; retire entries the release
  falsified.
- The finished release's mission notes: SEALED AS RECORD, carried as nothing. The
  new mission starts thin. Rules do not migrate; requirements do, via the plan.

## 3. Queue — sweep by destination, disposition everything

- Every seat sweeps its DESTINATION for open rows (wakes are unreliable; the sweep
  is the read). Each open row from the finished release gets exactly one of:
  done-with-receipt · carried-to-the-new-mission (re-filed against the new plan,
  never dragged) · closed-superseded. The sweep exposes obligations that a missed
  wake or a stale remembered work list can hide.
- Verify every closing-paper inheritance has a live intake row with an owner. Zero
  orphans.

## 4. Substrate — teardown as its own atom

- Retain the current release and the immediately previous release. At a boundary
  for release N, worktrees and other release-scoped substrate from N-2 and older
  are eligible for cleanup. Eligibility is not permission to discard unique dirty
  bytes: archive or otherwise disposition those first. Identify live `main` and
  runtime state by their actual refs and identity, never by a stale directory name.
- Prune worktrees; remove session-scoped scratch trees; verify merged branches
  deleted (merge receipts authorize).
- Scratch homes and scenario roots in temp directories: swept.
- Runtime installs: keep LIVE + LAST-KNOWN-GOOD; archive the hotfix chain;
  disposition launcher backups.
- Mid-release vendored-file backups removed once the release containing the real
  fix is live.
- Snapshots of torn-down topology: indexed in one line each, or deleted.

## 5. Instruments and boards

- The finished release's tracking and planning boards: FROZEN as records, labeled
  so. The new mission gets fresh boards — source-of-truth markdown first, board
  derived.
- Frozen review criteria: archived beside their evidence, marked "available,
  unweakened, not gates."
- Capture ONE clean-box baseline receipt at mission start (load, process counts,
  health tail latency) — the next performance question deserves a before.

## 6. The capability-delta lifecycle (standing law)

Each release's capability delta is authored at the fence and bound to the exact
candidate, then reconciled to the published cut. Its baseline is the canon's actual
last-absorbed marker, not an assumption that the immediately prior semver was
absorbed. When canon is behind, the new delta is a cumulative synthesis of every
intervening delta, preserving supersessions and pivots rather than concatenating
old prose.

Canon absorbs the kept public-product truths. Expiry requires BOTH the canon header
naming that exact delta AND a distinct successor delta file existing. A header alone
does not expire it; missing or unreadable inputs remain unknown/live. At the actual
boundary, verify the event before recording expiry, then stop citing the expired
delta. Do not create a successor merely to make the condition true. Candidate
absorption is not proof of publication or served production adoption. The delta is
`CAPABILITY-DELTA-v<version>.md` in the release mission folder (scaffolded by
`rig scope mission create release-X.Y.Z`); its `expiry.canon_path` and
`expiry.successor_path` name the two inputs, and `rig scope audit --mission <name>`
reports `expired_capability_delta` once both hold.

Private project topology, host practice, and release ownership go to the versioned
project world instead of leaking into the public package. The new release's delta
obligations start at ITS cut.

## 7. World absorption and discoverability

- Every changed capability gets one small map: **user situation · current capability
  · authoritative source · natural first product encounter · durable context home ·
  clean-agent probe**. Record an already-good route and leave it alone.
- Prefer point-of-need truth from the existing `--help`, error, command output, live
  state, context catalog, work install, or skill router. The world install supplies
  width and ontology; it should not copy exact facts a live surface can derive.
- The release mission owns this review before its cut when possible, so public
  world/help changes ship with the capability. This boundary verifies the exact
  packaged result, repairs any missed absorption as explicit debt, absorbs private
  project truth, re-primes, and observes whether a clean world-installed agent
  reaches the capability from its situation without being told its name.
- A missing route is a release finding. Repair the smallest existing seam or record
  the evidenced gap as scoped follow-up work in the project; do not create a second
  capability registry, search service, or world store at the boundary.

## 8. What deliberately does NOT happen at the boundary

- No process migration: situational rules expired at the fence. The standing corpus
  is the four checking principles — verify by effect · evidence at source · honest
  verdicts including against yourself · never fabricate.
- No re-litigating the finished release's verdicts; the sealed paper is the record.
- No additions to this checklist without a lived specimen attached.
