# ROADMAP — what gets formalized in product code, and when

SKILL.md teaches the model as it works TODAY (markdown + scripts only). This
file tracks what later ships in OpenRig product code. Verbose on purpose;
none of this belongs in the SOP.

| Piece | Interim (now) | Formalization target |
|---|---|---|
| The skill + scripts themselves | this folder, host-level projection | ship with 0.5.1 (zero product code — skill and scripts only; every new install gets the fallback-design version) |
| Work-triggered trace | manual + trace-due.sh under watchdog | 0.5.4 — the drift-correction spec (FROZEN) formalizes the trigger on the per-seat usage series and the delivery as durable queue items |
| STEERING→INTENT naming | files renamed at rollout; pointer files at old names | 0.5.4 — conform-amendment to the frozen spec's steering-substrate unit (its owner sweeps every narrative surface) |
| Seat scaffolds + boot order | scaffold.sh + convention (read SOP/LEARNED before any handover packet) | 0.5.4–0.5.5 — seat-create scaffolds the pair; launcher/boot integration |
| SPEC render + lock semantics | new work may fragment; compose.py renders; locks hash the render by convention | 0.5.5 — `rig scope spec render <node>`; plan-lock records the render hash natively (a lock-semantics change; needs its own spec) |
| Render verb family + trunk diff | compose.py / trunk-diff.sh | 0.5.5 — `rig render <tree> <node>` |
| Hot/cold skill pool | de-facto hot tier (profile-selected ambient projection); cold = context packs + library, separate indexes | 0.6 — one registry, multi-source cold pool, per-seat tier assignment in specs; THE DRAIN of mis-shelved skill content into the trees happens here, not before |
| Compaction-restore + handover restore-map | today: full-context salvage (crude blunt instrument) + rich packet; dual-rail per founder ruling 2026-08-10 | 0.5.4 REVISIT (founder-directed): once the ontology walk works live, the restore map SHRINKS — ontology rebuilds via the seat's own trace (SOP/LEARNED/INTENT chains), so restore artifacts reduce to slim SESSION NOTES carrying the earned nuance/epistemology the files can't (judgment traces, in-flight reasoning). Old machinery retires only after migration + demonstrated confidence, per the dual-rail ruling. |
| The Operating Model document | the workspace artifact + this skill | 0.5.4 — ships in source as the operating-model doc; absorbs/supersedes sdlc-conventions.md and the overlapping parts of mission-slice-sop |
| PROGRESS roll-up | already shipped machinery + re-surfacing spec | 0.5.2 (in build) — proof-item checkbox as the single mark level |

Release-ladder context at the time of writing: 0.5.1 = test system
(stabilization, at its cut) · 0.5.2 = human layer · 0.5.3 = maintenance/
dogfood of 0.5.2 · 0.5.4 = drift-correction system · later = renders,
registry. The ladder is the founder's; entries here move when it moves.
