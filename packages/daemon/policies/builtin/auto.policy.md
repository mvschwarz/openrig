---
source: builtin
name: auto
surface: flag
launch_posture: auto
policy_schema_version: 1
description: Claude runs with --permission-mode auto. Codex and Pi launch at the floor.
---

# Auto (built-in policy — flag surface)

This built-in selects Claude `--permission-mode auto`. Codex and Pi do not have an
auto mode and launch at their floor (Codex `-s workspace-write` or its named
profile; Pi `--no-approve`).

**APPLICATION is deterministic, NOT skill-translated.** Auto is a `surface: flag`
policy: it resolves to a stable launch flag and is applied directly by the runtime
flag-surface opt-in. The `applying-a-permission-policy` skill does **NOT** translate
this policy.

**Selection and native enforcement are separate.** A member policy overrides the
rig policy. A resolved config-surface selection chooses OpenRig's normal launch
mode and takes precedence over ambient YOLO. Native configuration and managed
restrictions still matter; recording a policy does not translate config rules.
