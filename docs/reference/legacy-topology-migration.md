# Migrating a pre-convention rig's topology context

For rigs whose hand-authored context predates the chain-file convention and
lives at the legacy location (`~/.openrig/shared-docs/rigs/<rig>/`, or
`$OPENRIG_SHARED_DOCS_ROOT/rigs/<rig>/`). The parent-host reconciliation
campaign is the first consumer of this path. Nothing here is destructive: the
legacy tree is left in place, reads keep working throughout (the walker's
advisory-emitting fallback), and every copy is no-clobber.

## The path, with exact commands

```bash
# 0. Know both roots — never hardcode either.
DEST="$(rig config get topology.root)"
SRC="${OPENRIG_SHARED_DOCS_ROOT:-$HOME/.openrig/shared-docs}/rigs"

# 1. BEFORE: prove the fallback is carrying this rig (expect ADVISORY lines
#    on stderr for every level that resolves at the legacy location).
rig context trace --rig <rig> --seat <seat> --name LEARNED.md

# 2. Preview the migration (dry run — nothing moves).
rsync -av --ignore-existing --exclude 'state/' --dry-run "$SRC/<rig>/" "$DEST/rigs/<rig>/"

# 3. Migrate. --ignore-existing mirrors the installer's copy-if-absent law:
#    anything already earned under topology.root is never overwritten.
mkdir -p "$DEST/rigs/<rig>"
rsync -av --ignore-existing --exclude 'state/' "$SRC/<rig>/" "$DEST/rigs/<rig>/"

# 4. AFTER: the same trace now resolves canonically — the advisories are gone.
rig context trace --rig <rig> --seat <seat> --name LEARNED.md

# 5. Do NOT delete the legacy tree in the same session. Archive it later,
#    once every consumer (queue-state add-dirs, review artifacts, scripts)
#    has been confirmed off it — reads through the fallback stay correct in
#    the meantime, which is the point of fail-open.
```

## What migrates and what does not

- **Migrates:** the rig's chain files and seat directories — `LEARNED.md`,
  `CULTURE.md`, craft files, `seats/<seat>/…`.
- **Stays (for now):** `state/` (queue-state add-dirs and live artifacts are
  actively written by running seats; moving them under a live rig strands
  writers — that cutover is its own change with its own receipt).
- **Never:** anything into a running seat's context. Migration moves files;
  delivery to running seats is the refocus channel
  (`docs/reference/refocus-channel.md`) — editing a file is not delivery.

## After migration

The next `rig up` of a spec shipping topology defaults installs them
copy-if-absent alongside the migrated content — earned context always wins
over a shipped default. Verify any doubt with the trace, not with memory.
