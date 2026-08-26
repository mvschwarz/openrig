# S6 GREEN + effect receipt

Rebased base: `886c3f1d5def1e1140ef97b3739f81e178a62639`
Runtime: Node `v22.23.1`

## Environment integrity

The package self-check passed before builds and tests:

```text
WORKTREE_SELF_CHECK_OK
packages/daemon == node_modules/@openrig/daemon
```

The authored proof items in `SPEC.md` and `IMPLEMENTATION-PRD.md` compare
byte-for-byte after excluding the PRD's permitted mirror banner:

```text
PROOF_ITEMS_EXACT
```

The pre-edit PRD snapshot is `.evidence/S6-IMPLEMENTATION-PRD-before.md`
(`e48b8929df16fbcffa88c6fe48c00a222c4b968d7b121a129ffdb9b9d7d5bf7d`);
the populated workspace PRD hash is
`38a5a142d95f59d481296c926f9b44bf4134ce4a6bffd25100c58b50af5fc013`.

## Build + focused test receipt

Both package builds exited 0:

```bash
npm run build -w packages/daemon
npm run build -w packages/cli
```

The post-rebase focused run exited 0:

```bash
npx vitest run --maxWorkers=1 \
  packages/daemon/test/daemon-db-path.test.ts \
  packages/daemon/test/plugin-vendor-service.test.ts \
  packages/daemon/test/plugin-vendor-exec-mode.test.ts \
  packages/cli/test/context-recap-write.test.ts
```

```text
Test Files  4 passed (4)
Tests      37 passed (37)
```

## Contract effects

1. **DB outside home:** a real `home/openrig.sqlite` symlink to an outside
   sentinel file is rejected before open; the error contains both `realpath`
   identities and the sentinel bytes remain unchanged. A real explicit
   split-path database is opened, receives a table and row, can be reopened
   read-only, and no home-local database is created.
2. **No canon rollback:** a real unversioned global skill symlinked to shared
   canon remains byte-identical and gains no OpenRig marker; the skip log names
   its external authority. A real older marked projection is updated to the
   newer skill bytes and marker. Unit pins cover older/equal/newer installed
   plugin directions and older/equal/newer global directions.
3. **Recap provisioning:** the CLI product command creates a missing seat
   subtree under an existing rig, writes `RECAP.md`, then a second write moves
   its predecessor into `recap-superseded/`. Missing rigs, unsafe segments, and
   symlinked topology namespaces all fail without creating the target.

The causal base failures are retained in `.evidence/S6-RED-FIRST.md`.
