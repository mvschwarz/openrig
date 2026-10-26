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
| `rigs/` | The `rigs` skill: a route into OpenRig for an ordinary Claude Code or Codex session. It isn't mirrored; see "Using these skills". |
| `CHANGELOG.md` | Append-only log of skill changes per curation cycle close. Hand-authored. |
| `LICENSE` | OpenRig's Apache-2.0 license. Vendored skill folders include their upstream `LICENSE.txt` files. |

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
these skills ship in the package, and each seat gets the ones its profile
selects. You don't have to do anything.

The `rigs` skill is the exception: it's for a Claude Code or Codex session
that isn't part of a team yet, so no seat's profile selects it. Add it with
`npx skills add mvschwarz/openrig --skill rigs`. Once OpenRig is installed, its
daemon also installs `rigs` into `~/.claude/skills` and `~/.agents/skills`, and
refreshes it on each upgrade. A copy you added with skills.sh stays as it is.
The package carries `rigs` at `packages/daemon/assets/skills/rigs`, kept
identical to `skills/rigs` by a test; edit `skills/rigs` and copy it there.

If you're reading this folder for reference (without OpenRig installed),
the SKILL.md files are pure markdown with YAML frontmatter; they're
human-readable and self-describing. Each `description` field in the
frontmatter says when to reach for the skill.

## Authoring

Each shipped skill has **one editable home** in this repository:

- `packages/daemon/specs/agents/shared/skills/<category>/<skill>/` for a
  skill that daemon seats load from specs;
- `packages/daemon/assets/plugins/openrig-core/skills/<skill>/` for a skill
  that ships only in the `openrig-core` plugin.

`scripts/skill-edge-layout.generated.json` says which copies each skill has.
`npm run mirror-skills` regenerates every other copy from the home: this
folder's `_canonical/`, and the plugin copy of a spec skill that the plugin
also carries. It reads nothing outside the repository. Never edit a
generated copy; edit the home and re-run the script before commit.

A home must already be publishable: the script refuses to regenerate when a
home holds text or files that the public copies would drop, such as an
internal fence, a frontmatter key listed in
`scripts/internal-tokens.generated.json`, a `feedback.md`, or an `evals/`
folder. A skill change from anywhere else comes in as a normal pull request
that edits its home.

## Drift detection

`npm run test:repo` runs `mirror-skills --check`. It fails when a generated
copy differs from its home, when a home isn't publishable, when a file
doesn't match `scripts/skill-edge-digests.generated.json`, or when a
`SKILL.md` isn't in the layout. Fix the home, then run
`npm run mirror-skills` and commit the result.

## Future-state

This folder is structured **as if it were already its own repo** so that a
future `git subtree split --prefix=skills HEAD` is mechanical when growth
warrants. Until then, the in-repo mirror is the right scope: skill changes
ship atomically with the daemon binary that loads them; no version-skew
risk; one PR for both halves.
