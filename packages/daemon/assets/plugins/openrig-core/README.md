# openrig-core

Canonical OpenRig skills and hooks for cross-runtime agent topology coordination, continuity, and operating discipline.

## What this plugin ships

**Skills (11):** the canonical OpenRig operating knowledge — how to use the `rig` CLI, how to design rig topologies, how to recover from compaction, how to hand work off durably between agents, how to reason about permission posture, and more.

**Hooks:** activity-tracking hooks (Claude Code: 4 events; Codex: 3 events) that POST agent state to the OpenRig daemon for real-time UI seat-status updates.

## Runtimes

This plugin ships dual-manifest packaging — both `.claude-plugin/` and `.codex-plugin/`. Use it with:

- **Claude Code** — install via `/plugin` after the OpenRig daemon vendors `openrig-core/` to `~/.openrig/plugins/openrig-core/` on first run, or install the plugin directly through Claude Code's own plugin commands when remote distribution is available
- **Codex CLI** — install via `/plugins` after the same vendoring step, or directly through Codex's own plugin commands

Two skills target Claude Code's compaction behavior specifically:
- `claude-compaction-restore` — used to rebuild a Claude Code agent's working mental model after `/compact`, from JSONL transcripts and touched files
- `claude-compact-in-place` — verification + recovery SOP for an in-place compacted Claude Code seat

These are NOT Codex-self-targeting (Codex's compaction is handled internally and doesn't need rebuild SOPs). But Codex agents acting as orchestrators frequently invoke these skills when restoring a peer Claude that has compacted — that's exactly when they're needed. Both runtimes ship them.

All other skills are cross-runtime by design.

## Distribution

**At v0 (today):** the vendored copy inside the OpenRig npm package is the source of truth. When you install `@openrig/cli` (or run the daemon), `openrig-core/` is copied to `~/.openrig/plugins/openrig-core/` on first run. This is the offline-safe baseline and is always available.

**Auto-fetch from GitHub at v0:** the OpenRig daemon probes `github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz` on launch with a 5s timeout. **At v0 the success path only logs the response and does NOT extract a tarball, compare versions, or update the local copy** — extraction + version-compare + update are scoped to a later marketplace-consumption phase (mission slice 3.6). 404 (the expected normal-state response while the GitHub repo is empty), network errors, and timeouts are all tolerated silently with the vendored copy remaining authoritative.

**Future (slice 3.6, marketplace-consumption phase):** when the GitHub releases workflow is set up and authorization to publish lands, the daemon will start extracting fetched tarballs + comparing versions + updating the local copy as the "hot update" path that skips OpenRig CLI version bumps.

You can also install directly via Claude Code or Codex's own plugin commands if you prefer to manage plugins outside OpenRig.

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/openrig-plugins
- OpenRig CLI: https://github.com/mvschwarz/openrig
