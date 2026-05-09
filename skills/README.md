# OpenRig Skills

This folder is the **publicly-visible mirror** of the canonical skills that
ship with OpenRig — the set of progressive-disclosure context manifests
that OpenRig agents load on demand to do their work well.

The skills are **mirrored** from the daemon's bundled-skills folder at
`packages/daemon/specs/agents/shared/skills/` into `_canonical/` here, so
that anyone reading the openrig repo can find the skills at the repo root
without spelunking through `packages/daemon/specs/`.

## What you'll find

| Path | Contents |
|---|---|
| `_canonical/` | The mirrored skills, organized by category (`core/`, `pm/`, `pods/`, `process/`) plus a few uncategorized at the root. Do not edit files here directly — see "Authoring" below. |
| `CHANGELOG.md` | Append-only log of skill changes per curation cycle close. Hand-authored. |
| `LICENSE` | Apache-2.0, matching the parent project. |

## What a skill is

A skill in OpenRig is a **primitive for progressive-disclosure context
injection**, not a unit of capability in the dictionary sense. Frontmatter
sits in the agent's hot tier (cheap pattern-matching against the trigger
description); body loads on activation; references in the folder load on
demand. Read a few `_canonical/*/SKILL.md` files to see the shape — the
frontmatter `description` is the trigger, and the body is what the agent
loads when the trigger matches.

OpenRig agents discover skills automatically; you generally don't invoke a
skill explicitly. Authoring a skill is about naming a recurring need with
a precise enough trigger that the agent reaches for it at the right moment.

## Using these skills

If you're running OpenRig (`npm install -g @openrig/cli` or via tarball),
these skills are already installed for any rig you launch — they ship
inside the daemon. You don't have to do anything.

If you're reading this folder for reference (without OpenRig installed),
the SKILL.md files are pure markdown with YAML frontmatter; they're
human-readable and self-describing. Each `description` field in the
frontmatter says when to reach for the skill.

## Authoring

Skills live in two places during their lifecycle:

1. **Substrate factory** at `substrate/shared-docs/openrig-work/skills/`
   — where new skills are authored, audited, and refined through curation
   cycles. Includes `feedback.md` per skill (curation bookkeeping) and
   `evals/` per skill (eval-pilot infrastructure). This is the source of
   truth for the skill team's ongoing work.

2. **Product source** at `packages/daemon/specs/agents/shared/skills/`
   — the subset of skills that ship with the daemon. Once a skill graduates
   to product source, that's what gets bundled into the npm package.

`<repo-root>/skills/_canonical/` (this folder's `_canonical/`) is mirrored
**from** product source via `npm run mirror-skills`. The mirror is
strictly a copy — never edit `_canonical/` directly; edits in product
source must be propagated by re-running the mirror script before commit.

## Drift detection

`npm run test:repo` runs `mirror-skills --check` to detect drift between
product source and `_canonical/`. If you edit a skill in product source
without re-running the mirror, the test fails with a clear message naming
the script to run. CI may also enforce this gate when GitHub Actions
arrives.

## Future-state

This folder is structured **as if it were already its own repo** so that a
future `git subtree split --prefix=skills HEAD` is mechanical when growth
warrants. Until then, the in-repo mirror is the right scope: skill changes
ship atomically with the daemon binary that loads them; no version-skew
risk; one PR for both halves.
