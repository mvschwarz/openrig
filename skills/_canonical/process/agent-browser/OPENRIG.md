---
skill: agent-browser
openrig-relationship: vendored-supplemented
---

# OpenRig and this skill

## Origin

- **Upstream**: Vercel agent-browser CLI (https://github.com/vercel/agent-browser)
- **Vendoring pattern**: `add-supplementary-files`
- **Last upstream check**: 2026-05-13 (initial relationship declaration)

## How OpenRig uses this skill

OpenRig ships `agent-browser` so any agent dispatched by an OpenRig topology can drive a real browser (snapshots, form fills, screenshots, scraping, web-app testing) without operators having to separately install a browser-automation skill. It's referenced from any agent profile whose role includes web work.

## OpenRig-specific modifications

This is the canonical example of the **add-supplementary-files** pattern (see `writing-skills-for-openrig` SKILL.md §"Vendored skills"). The upstream skill is kept structurally intact; OpenRig adds a companion file that captures local-use insights without polluting the upstream content.

| Surface | What changed | Why |
|---|---|---|
| `SKILL.md` body | A short "## Local Dev Insights" section was added near the end with an `**IMPORTANT:** Read LOCAL-INSIGHTS.md` pointer. | Without the pointer, agents loading the skill wouldn't know the companion file exists. The pointer is the only structural modification needed for the supplementary pattern to be discoverable. |
| `LOCAL-INSIGHTS.md` (new sibling, ~189 lines) | Field-tested gotchas, command-compatibility matrices, corrections discovered through hands-on use that the upstream skill doesn't cover. | E.g., not all `get` subcommands accept `@refs` — `get text @e1` works but `get html @e1` fails silently. The compatibility matrix saves agents from the most common confusion class. |

Nothing else in `SKILL.md` diverges from upstream content as of the last upstream check.

## Companion files

- `LOCAL-INSIGHTS.md` — load-bearing supplementary content. The SKILL.md body explicitly points readers here for hands-on gotchas the upstream skill doesn't cover.

## When to re-sync upstream

Watch for new `agent-browser` CLI releases (Vercel). When the command surface changes meaningfully:

1. Re-sync `SKILL.md` body from upstream, preserving the "Local Dev Insights" pointer section.
2. Update `LOCAL-INSIGHTS.md` compatibility matrix to reflect new behavior (some `get` subcommands may gain `@ref` support, breaking the current matrix).
3. Bump `last_upstream_check` in `SKILL.md` frontmatter.
4. Note any structural shape changes in `divergence_notes`.
