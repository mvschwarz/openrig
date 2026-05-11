---
name: openrig-installer
description: Use when installing or upgrading OpenRig on a host, especially the V0.3.1 upgrade flow which includes the substrate-kernel → daemon-managed-kernel migration ceremony. Covers npm install, rig setup, rig daemon start (auto-boots kernel), and the canonical verification commands. NOT for ordinary kernel operation post-install — use openrig-operator skill for that.
metadata:
  openrig:
    maturity: L2
    distribution_scope: shipped
    source_evidence: V0.3.1 slice 05-kernel-rig-as-default IMPLEMENTATION-PRD §8 + OQ-A=B migration-ceremony decision
---

# OpenRig Installer

This skill teaches the operator agent how to install + upgrade
OpenRig cleanly. The V0.3.1 upgrade is the one with the migration
ceremony (substrate kernel → daemon-managed kernel); other upgrades
follow the same install / setup / start shape with no migration.

## Fresh install

```bash
npm install -g @openrig/cli
rig setup
```

`rig setup` is idempotent — safe to re-run if a step fails. It probes
host prereqs (tmux present, Node version, writable state path,
optional cmux), then invokes `rig daemon start` per the L2 factoring
(OQ-B). The daemon's start path auto-boots the kernel rig per the
V0.3.1 slice 05 kernel-rig-as-default logic.

## Verification after install

```bash
rig ps --nodes --rig kernel --json
```

Should report 4 members (advisor.lead + operator.agent +
operator.human + queue.worker) all ready. If a runtime is unavailable
the daemon picks the matching variant (`rig-claude-only.yaml` or
`rig-codex-only.yaml`); the topology stays the same shape with the
unavailable runtime omitted from the agent membership.

Entry point for chatting with the rig:

```bash
rig capture advisor-lead@kernel
```

Or click the CMUX button on the topology graph in the UI at
`/topology`.

## V0.3.1 upgrade ceremony (one-time migration)

Operators with an existing substrate-rooted kernel at
`~/code/substrate/shared-docs/rigs/kernel/` (the pre-V0.3.1 layout)
must migrate to the daemon-managed location
`~/.openrig/specs/rigs/kernel/` as a one-time step during the V0.3.1
upgrade. The V0.3.1 upgrade IS the migration moment; it's not a
separate ceremony.

### Migration steps

1. **Snapshot first.** Take a snapshot of the running substrate
   kernel so the migration is reversible:

   ```bash
   rig snapshot kernel
   ```

2. **Stop the substrate kernel** (so the migration doesn't race a
   running rig):

   ```bash
   rig down kernel --snapshot
   ```

3. **Copy the substrate kernel spec** into the daemon-managed
   location:

   ```bash
   mkdir -p ~/.openrig/specs/rigs/kernel
   cp -r ~/code/substrate/shared-docs/rigs/kernel/* ~/.openrig/specs/rigs/kernel/
   ```

4. **Upgrade the CLI + daemon**:

   ```bash
   npm install -g @openrig/cli@0.3.1
   rig daemon stop
   rig daemon start
   ```

   At this point the new daemon detects `~/.openrig/specs/rigs/kernel.yaml`
   exists and skips the V0.3.1 builtin-kernel boot (the
   already-managed-rig branch). The substrate-rooted topology
   continues to run under daemon management.

5. **Verify** the migrated kernel matches expectations:

   ```bash
   rig ps --nodes --rig kernel --json
   ```

6. **Decommission the substrate copy** (only after verifying the
   daemon-managed copy works):

   ```bash
   rm -rf ~/code/substrate/shared-docs/rigs/kernel
   ```

### If migration fails

The pre-step snapshot is the rollback. `rig restore <snapshot-id>
--rig kernel` revives the prior topology. Then `npm install -g
@openrig/cli@0.3.0` rolls the CLI back and you can retry later.

## Operator agent's role in install + upgrade

The operator agent shepherds operators through these steps when the
user asks "how do I upgrade?" or "what's the V0.3.1 ceremony?". The
agent reads this skill on demand via `find-skills` — it does not
need to memorize the steps; it consults the canonical reference
(this file) and walks the operator through.

## 3-part error remediation

| What failed | Why it matters | Fix |
|---|---|---|
| `npm install -g @openrig/cli` permission denied | Global install needs writable npm prefix; macOS Homebrew default is usually writable; some custom Node installs aren't | Either fix the npm prefix permissions or use `sudo npm install -g`; check `npm config get prefix` |
| `rig setup` host prereq fail | tmux, Node version, or writable state path missing | `rig doctor` lists each missing piece + the install command; run those, retry `rig setup` |
| `rig daemon start` auth-block error | Neither Claude Code nor Codex authenticated; kernel rig requires at least one | Run `claude auth login` OR `codex login`; then retry `rig daemon start` |
| `rig daemon start` "kernel already managed" | An existing managed rig named `kernel` exists; the daemon skips builtin-boot per design | This is the expected path after migration — no action needed |
| `rig ps --rig kernel --json` returns empty | Daemon healthy but no kernel rig managed; likely the migration step copied content but did not boot | `rig up kernel` from inside `~/.openrig/specs/rigs/kernel/`; or invoke the daemon's cold-boot path explicitly |

## What this skill is NOT

- Not the canonical OpenRig command surface; that lives in the
  `openrig-user` skill.
- Not the kernel-operating-procedure for post-install daily use;
  that's `openrig-operator`.
- Not for project rigs; project rigs install themselves via `rig
  up <spec>` after the kernel is in place.
