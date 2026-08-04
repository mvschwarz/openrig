---
source: builtin
name: locked
surface: config
policy_schema_version: 1
description: Whitelist posture for untrusted or sensitive work — implicit deny-all plus a minimal explicit allow. Tight, but far more usable than raw harness-default.
default_posture: deny
allow: [run_toolchain, rig_up, rig_down]
ask: []
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs, delete_files, force_push]
---

# Locked (built-in policy)

The tightest built-in. Everything is denied unless explicitly allowed. Use for untrusted rigs, sensitive repos, or work where the blast radius must be minimal.

- **default_posture: deny** — any semantic action not in `allow` is denied.
- **allow** — only the dev toolchain (`run_toolchain`: npm/node/tsc/test/lint) and rig lifecycle (`rig_up`/`rig_down`). No push, no PR, no publish, no arbitrary shell, no network egress beyond what the toolchain needs, no secret reads.
- **destructive_class** — listed for completeness; moot here (default-deny already blocks them).

**The usability FLOOR is separate and always on** (flag surface, not a config knob): Claude `acceptEdits` + Codex `workspace-write` (the edit/sandbox floor); Pi `--no-approve` is a resource-TRUST posture, not a permission floor (Pi has no permission surface). So a Locked seat can still edit files — it just can't reach beyond the minimal allow-set without an explicit grant.

**Translation is the skill's job.** This spec is harness-neutral semantic intent; the `applying-a-permission-policy` skill translates it to each harness (Claude prefix rules / Codex posture / Pi bit) with the version-stamped caveats. Grounded in schema `a8dba0d9`.
