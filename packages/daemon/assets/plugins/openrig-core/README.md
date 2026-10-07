# openrig-core

Canonical OpenRig skills and hooks for cross-runtime agent topology coordination, continuity, and operating discipline.

## What this plugin ships

**Skills (19):** canonical OpenRig operating knowledge, including the public `refocusing` skill and
its path-only topology/work trace.

**Hooks:** activity tracking, compaction continuity, and the default-on refocus channel. Refocus is
post-compaction on both runtimes, threshold-triggered on Claude, on-demand on both, configurable
off, and never runs at fresh session start.

## Runtimes

This plugin ships dual-manifest packaging — both `.claude-plugin/` and `.codex-plugin/`. Use it with:

- **Claude Code** — install via `/plugin` after the OpenRig daemon vendors `openrig-core/` to `~/.openrig/plugins/openrig-core/` on first run, or install the plugin directly through Claude Code's own plugin commands when remote distribution is available
- **Codex CLI** — install via `/plugins` after the same vendoring step, or directly through Codex's own plugin commands

One skill targets Claude Code's compaction behavior specifically:
- `claude-compaction-restore` — used to rebuild a Claude Code agent's working mental model after `/compact`, from JSONL transcripts and touched files

This is NOT Codex-self-targeting (Codex's compaction is handled internally and doesn't need rebuild SOPs). But Codex agents acting as orchestrators frequently invoke this skill when restoring a peer Claude that has compacted — that's exactly when it's needed. Both runtimes ship it.

All other skills are cross-runtime by design.

## Distribution

The npm package includes an offline baseline under the daemon's
`assets/plugins/openrig-core/`. The daemon resolves local plugin authority before
attempting a network fetch, using the configured OpenRig home (normally
`~/.openrig/plugins/openrig-core/` for the installed copy):

| Installed state | Local vendoring behavior |
| --- | --- |
| Absent | Seed the bundled plugin. |
| Older manifest version | Advance files from the newer bundled version. |
| Equal manifest version | Preserve installed content; executable modes may be reconciled on byte-identical files. |
| Newer manifest version | Preserve the installed copy. |

Version authority comes from the plugin manifests. An existing directory without
a manifest is left unchanged; invalid or disagreeing manifest versions are
reported rather than guessed. Updating the CLI therefore does not unconditionally
overwrite an equal/newer or independently managed plugin copy.

After local resolution, the daemon attempts the GitHub release endpoint for
`openrig-core.tar.gz` with a five-second timeout. This path currently fetches and
logs the response only: it does not extract the archive, compare its version, or
install its content. Fetch failures, including 404 and network errors, leave the
resolved local copy in place. A successful fetch also leaves it unchanged.
This describes the fetch implementation, not a claim that a release artifact is
currently available at the external repository.

You can also install directly via Claude Code or Codex's own plugin commands if you prefer to manage plugins outside OpenRig.

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/openrig-plugins
- OpenRig CLI: https://github.com/mvschwarz/openrig
