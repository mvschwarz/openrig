# Skills Changelog

Append-only log of changes to the canonical skill set, kept per curation
cycle close per `operating-the-skill-library/SKILL.md` v1.9 §8 rule on
`skills/CHANGELOG.md`. New entries land at the top.

Each entry names: cycle date, what changed, which skills affected. Lets
users tracking the skill set pull in updates independently of the daemon
binary version.

---

## 2026-05-09 — Initial publish: skills hub bootstrap

First mirror of canonical skills from
`packages/daemon/specs/agents/shared/skills/` to `<repo-root>/skills/_canonical/`.
27 skills published across 4 categories (`core/`, `pm/`, `pods/`,
`process/`) plus 3 uncategorized at the top level
(`claude-compact-in-place/`, `mental-model-ha/`, `rig-architect/`).

Mechanism: `npm run mirror-skills` (a node script at
`scripts/mirror-skills.mjs` invoking rsync), with `npm run mirror-skills:check`
wired into `npm run test:repo` for drift-detect.

Why: surfaces the skill set at the repo root so the public-facing skill
library is discoverable without spelunking through `packages/daemon/specs/`.
Structure follows `_canonical/` strict-ownership convention so
hand-authored top-level files (this CHANGELOG, README, LICENSE, future
plugin manifests) survive every mirror run.

References:
- `operating-the-skill-library/SKILL.md` v1.9 §8 rule "In-repo skills hub"
  + rule "skills/CHANGELOG.md".
- Mechanism comparison:
  `substrate/shared-docs/openrig-work/lab/skill-authoring-techniques/findings/skills-hub-mirror-mechanism-comparison.md`.
