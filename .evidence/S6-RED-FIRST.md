# S6 RED-first receipt

Base: `7e6bedda754a07c34be9f51a54032196d062a1d1`
Runtime: Node `v22.23.1`
Worktree package self-check:

```text
DAEMON_SOURCE=/private/tmp/s6-hermeticity-guards/packages/daemon
DAEMON_LINK=/private/tmp/s6-hermeticity-guards/packages/daemon
```

## DB + plugin authority RED

Command:

```bash
npx vitest run packages/daemon/test/daemon-db-path.test.ts packages/daemon/test/plugin-vendor-service.test.ts
```

Base result extracted from the first three-file run: 6 causal failures.

- implicit database symlink escaping resolved `OPENRIG_HOME` did not throw;
- older bundled plugin overwrote newer installed bytes;
- equal-version bundled plugin overwrote different installed bytes;
- bundled global projection overwrote an unversioned existing canon target;
- newer bundled projection did not advance the target version marker;
- older bundled projection overwrote a newer marked target.

The strict-newer upgrade pin already passed on base because the old implementation overwrote unconditionally; its opposite-direction tests establish the missing authority rule.

## Recap provisioning RED

The first CLI run was indeterminate because the daemon package export had not been built. After `npm run build -w packages/daemon` completed, this command exercised the product path:

```bash
npx vitest run packages/cli/test/context-recap-write.test.ts
```

Result: 2 causal failures / 3 preservation passes.

- a valid existing rig with a missing seat directory failed instead of provisioning it;
- an unsafe seat segment reached path resolution instead of being rejected as unsafe.

The existing write/supersession behavior, missing-rig refusal, and addressability gate all passed.
