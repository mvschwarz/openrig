# S6 — Hermeticity guards

## Intent

Make daemon startup and recap deposit fail or proceed from explicit authority, never from an ambient path accident: an implicit database may not escape its resolved OpenRig home, an older bundled plugin may not overwrite newer or unversioned installed/canonical content, and a valid topology rig may accept a first recap even when its seat directory was never provisioned.

## Mini-requirements

1. `resolveDaemonDbPath` resolves the implicit database and `OPENRIG_HOME` through the filesystem. It throws before database open when the implicit database resolves outside the resolved home. An explicit non-empty `OPENRIG_DB` remains the deliberate split-path override and is returned unchanged.
2. Plugin vendoring reads the bundled and installed plugin manifest versions before replacing an existing plugin tree. Only a strictly newer bundled version may replace versioned installed content; equal, older, malformed, or unversioned-existing authority never gets overwritten silently.
3. Global skill projection carries a plugin-version marker. It may create an absent target or upgrade a target marked with an older plugin version. It must not overwrite equal/newer marked content or a pre-existing unversioned target (including a symlinked shared canon directory).
4. `rig context recap-write` validates rig/seat as safe path segments, requires the addressed rig directory to exist, and recursively provisions the missing seat directory before calling the existing recap store. A nonexistent rig still fails loud and leaves no tree behind.
5. Changes stay inside the S6 reserved source/test territory. No daemon restart, live projection write, push, or PR.

## Proof contract

- [ ] An implicit `openrig.sqlite` symlink escaping `OPENRIG_HOME` fails RED on the base and throws GREEN; ordinary implicit home-local and explicit split paths remain supported.
- [ ] Older/equal bundled plugin content cannot replace newer/equal installed content; a strictly newer bundle upgrades an older marked install.
- [ ] An older/equal global skill projection cannot overwrite newer/equal marked canon, and an unversioned existing target is left byte-identical; an absent/older marked target installs/upgrades.
- [ ] `recap-write` succeeds when the rig exists but its seat directory does not, and still refuses a nonexistent rig plus unsafe path segments without creating them.
- [ ] Focused tests pass from the candidate worktree, TypeScript passes, and the worktree self-check proves `@openrig/daemon` resolves to this worktree before any package-level test is trusted.
