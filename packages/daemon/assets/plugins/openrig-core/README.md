# openrig-core

Canonical OpenRig skills and hooks for cross-runtime agent topology coordination, continuity, and operating discipline.

## What this plugin ships

**Skills (11):** the canonical OpenRig operating knowledge — how to use the `rig` CLI, how to design rig topologies, how to recover from compaction, how to hand work off durably between agents, how to reason about permission posture, and more.

**Hooks:** activity-tracking hooks (Claude Code: 4 events; Codex: 3 events) that POST agent state to the OpenRig daemon for real-time UI seat-status updates.

## Runtimes

This plugin ships dual-manifest packaging — both `.claude-plugin/` and `.codex-plugin/`. Use it with:

- **Claude Code** — install via `/plugin install openrig-core@mvschwarz/openrig-plugins` (or via the OpenRig daemon's auto-vendor on first run)
- **Codex CLI** — install via `/plugins` (or via OpenRig daemon)

Two skills target Claude Code's compaction behavior specifically:
- `claude-compaction-restore` — used to rebuild a Claude Code agent's working mental model after `/compact`, from JSONL transcripts and touched files
- `claude-compact-in-place` — verification + recovery SOP for an in-place compacted Claude Code seat

These are NOT Codex-self-targeting (Codex's compaction is handled internally and doesn't need rebuild SOPs). But Codex agents acting as orchestrators frequently invoke these skills when restoring a peer Claude that has compacted — that's exactly when they're needed. Both runtimes ship them.

All other skills are cross-runtime by design.

## Distribution

This plugin is published two ways:

1. **Vendored inside the OpenRig npm package.** When you install `@openrig/cli` (or run the daemon), `openrig-core/` is copied to `~/.openrig/plugins/openrig-core/` on first run. This is the offline-safe baseline.

2. **GitHub auto-fetch.** When network is available, the OpenRig daemon checks `github.com/mvschwarz/openrig-plugins` for a newer version of `openrig-core` and updates the local copy. This is the "hot update" path — skill improvements ship without bumping the OpenRig CLI version.

You can also install directly via Claude Code or Codex's own plugin commands if you prefer to manage plugins outside OpenRig.

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/openrig-plugins
- OpenRig CLI: https://github.com/mvschwarz/openrig
