# openrig-core

Canonical OpenRig skills and hooks for cross-runtime agent topology coordination, continuity, and operating discipline.

## What this plugin ships

**Skills (19):** canonical OpenRig operating knowledge, including the public `refocusing` skill and
its path-only topology/work trace.

**Hooks:** activity tracking, compaction continuity, and the default-on refocus channel. Refocus is
post-compaction on both runtimes, threshold-triggered on Claude, on-demand on both, configurable
off, and never runs at fresh session start.

## Runtimes

This plugin ships dual-manifest packaging — both `.claude-plugin/` and `.codex-plugin/`.

- **Claude Code** — the OpenRig daemon vendors `openrig-core/` to `$OPENRIG_HOME/plugins/openrig-core/` at startup and starts
  each Claude seat whose resolved plugin selection includes it (for example `plugins: [shared:openrig-core]`) with
  `CLAUDE_CODE_PLUGIN_DIRS` pointing at that copy, so the plugin's hooks (refocus, compaction restore) load with no setup
  step. A seat that didn't select the plugin is launched as before. This applies to fresh launches, restores, handover
  successors and launches with a permission mode; a seat that was already running picks it up at its next launch. A
  `CLAUDE_CODE_PLUGIN_DIRS` list a seat declares itself (its spec's `env:` or a one-off `rig up --env`) keeps working: the
  vendored plugin is added after it. Claude Code reads the variable from v2.1.280; an older Claude ignores it, starts
  normally, and doesn't load the hooks (OpenRig doesn't check the version or refuse the launch).
  A seat that has OpenRig's activity relay in its own `settings.local.json` (the `claude-activity-hooks` runtime resource)
  already reports activity from there, so the plugin's `activity-relay.cjs` (which the manifest starts with `--from-plugin`)
  exits for an event the seat's settings register it for. It does so only when the entry is exactly the one OpenRig writes
  (legacy `node` or a quoted absolute Node executable, then one quoted path to
  `state/claude-activity-hooks/activity-relay.cjs`), the interpreter is executable, and the script at that path is this same
  script. A missing interpreter/script, a different script, or a wrapper around it never silences the plugin. A seat without
  that resource, and a plugin installed outside OpenRig, report through the plugin's relay, so each event is reported once.
  A relay entry written by an older install (a different path or quoting) doesn't match, so until the seat is relaunched and
  its entry refreshed, both relays report and its events come twice. The plugin is not a Claude marketplace entry, so
  `/plugin` has nothing to install.
  **A Claude started inside a seat** (from its shell or its Bash tool) inherits the seat's environment, so it loads the
  plugin too. OpenRig gives such a seat `OPENRIG_SEAT_PROJECT_DIR`, its launch project, and the plugin's seat effects (the
  activity and session-identity posts, the compaction hooks, refocus, and the first-launch marker) run only when the Claude's
  own `CLAUDE_PROJECT_DIR` is that folder (compared by real path). So a Claude in another project, or in a subfolder of the
  seat's project, doesn't act as the seat, and a `cd` inside the seat's own session doesn't switch it off, because
  `CLAUDE_PROJECT_DIR` doesn't follow a `cd`. A Claude started in the seat's own project folder is the same project and
  still acts as the seat. A seat launched before this change has no `OPENRIG_SEAT_PROJECT_DIR` until its next launch, restore
  or handover, and behaves as before until then.
- **Codex CLI** — OpenRig installs the plugin automatically when a Codex seat selects it and hooks are enabled.
  On the first installation, it trusts only the six exact shipped hook definitions, after checking installed hook files
  and scripts against the daemon's packaged copy. Existing plugin disables and hook choices remain in place across
  restart and upgrade. An existing untrusted plugin stays under native review: Codex does not persist "continue without
  trusting", so an absent trust record on an existing installation is not treated as permission.
  - **One activity producer:** the four managed inline hooks report Codex activity; the plugin's activity entries are
    no-ops. The plugin supplies refocus and skills. Disabling an inline activity hook is not bypassed by the plugin.
  - **Seat scope:** the commands require both `OPENRIG_SEAT_PROJECT_DIR` and the executable `OPENRIG_NODE`. Personal and
    unselected sessions are no-ops. A nested Codex inheriting those seat variables still acts as that seat.

Generated Claude settings commands for the activity relay and context collector use the daemon's absolute Node
executable when its name is recognized (`node` or `node.exe`); other names keep the legacy bare `node` command and
its PATH requirement. Pinned commands do not require Node on the Claude process's inherited PATH. The executable must
remain installed; removing or moving it requires normal command refresh from a healthy runtime. This does not change the Claude plugin
manifest's commands, which still use `node` (the Codex manifest's run `$OPENRIG_NODE`, above), or prove that an already-running Claude reloaded changed settings.

One skill targets Claude Code's compaction behavior specifically:
- `claude-compaction-restore` — used to rebuild a Claude Code agent's working mental model after `/compact`, from JSONL transcripts and touched files

This is NOT Codex-self-targeting (Codex's compaction is handled internally and doesn't need rebuild SOPs). But Codex agents acting as orchestrators frequently invoke this skill when restoring a peer Claude that has compacted — that's exactly when it's needed. Both runtimes ship it.

All other skills are cross-runtime by design.

## Distribution

The npm package includes an offline baseline under the daemon's
`assets/plugins/openrig-core/`. The daemon resolves local plugin authority before
attempting a network fetch, using the configured OpenRig home (normally
`$OPENRIG_HOME/plugins/openrig-core/` for the installed copy):

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

## License

Apache License 2.0. See `LICENSE`.

## Source

- Plugin repo: https://github.com/mvschwarz/openrig-plugins
- OpenRig CLI: https://github.com/mvschwarz/openrig
