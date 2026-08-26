# Revision guide — for agents improving this skill

Authored in one sitting by the seat that held the full design context
(pm-lead gen-4, 2026-08-09, founder-ordered sole authorship to avoid dilution).
Revise freely WITHIN these boundaries; the authoring seat (or its successor)
checks every change.

## LOAD-BEARING — do not change the meaning (wording tweaks fine)
- Two trees + uniform-filename law (one name per chain; folder=context; path=instance).
- The axis (template/learned) + per-chain amendment clocks.
- The trace laws: read-receipts-not-recitation · report-broken-links-never-obey ·
  chains inform, never enforce.
- The trace principle + its taught failure mode (§5): identical scheduled prompts decay and idle seats accumulate ritual — teach the principle, allow scheduling where context fits; the due-check script is the preferred gate, not a law.
- LEARNED size is SOFT guidance (attention budget + Deuteronomy warning as a taught antipattern) — never reintroduce a hard cap.
- Composed views generated-never-edited; approvals that freeze content record the hash of a render (§7). Plain language — no 'seal'/'fold' jargon; those were seat-local terms and are banned from this skill.
- Placement rule (§8) + the dual-home interim rule (ROLLOUT.md): do NOT drain skills before the registry.
- Seeding-as-audit + never-bulk-seed + wave pacing (all in ROLLOUT.md).
- The write principles (§6, exactly two — resist re-complicating them into protocol tables; an over-specified write protocol was cut from v1 for breaking the model's own cheap-to-update law).
- "fleet" not "host".

## IMPROVABLE — expected revision surface
- Script robustness (portability: `date -r` vs `stat -f` is macOS-flavored;
  Linux needs `stat -c %Y`; add tests).
- Template wording, more worked examples, a rendered example LEARNED.md.
- scaffold.sh ergonomics (node discovery from a rig spec instead of --node args).
- compose.py: ordering options, front-matter-aware rendering, seal-hash helper.
- Frontmatter/metadata conformance to the skill-factory's current schema.

## PROCESS
1. Propose changes as a diff (queue item to the authoring seat).
2. Load-bearing changes need the authoring seat's explicit OK before landing.
3. When this skill ships to source (target: 0.5.1 skill+scripts, doc 0.5.4),
   the shipped copy is generic: keep host-specific anything OUT (placement law —
   host specifics live in the tree this skill bootstraps, never in the skill).
