# Topic E — DEV launcher HOME isolation (Stage 1 contract 3)

**Draft extract** from fork Stage 1. Not a full OS sandbox.

## Ship set
1. `scripts/dev-isolated-daemon.sh` — sets HOME + OPENRIG_HOME + CODEX_HOME + CLAUDE_CONFIG_DIR + XDG_* for daemon and descendants (overrides inherited env).
2. `packages/daemon/test/dev-launcher-isolation.test.ts` — baseline bug class + canary byte immutability + fail preserves log.

## Out of scope
Hermetic private profiles, Jeff, native OMP/Prime smoke, full productization of every launch path.
