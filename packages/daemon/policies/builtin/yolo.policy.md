---
source: builtin
name: yolo
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Permissive launch opt-in. Claude skips permission prompts; Codex selects danger-full-access and never approval policy. Pi enables resource trust.
---

# YOLO (built-in policy — flag surface)

This built-in selects Claude `--dangerously-skip-permissions`, Codex
`-s danger-full-access -a never`, or Pi `--approve` (resource trust). Codex receives
no named-profile argument on this path. These are launch arguments; native
managed restrictions still matter. Use only for work and an environment you
deliberately trust.

**APPLICATION is deterministic, NOT skill-translated.** YOLO is a `surface: flag`
policy: it resolves to a stable launch flag and is applied directly by the runtime
flag-surface opt-in. The `applying-a-permission-policy` skill does **NOT** translate
this policy; it points at that setting. The flag surface is stable enough for
deterministic code, so it does not pay the skill-indirection tax.

**Selection and native enforcement are separate.** A member policy overrides the
rig policy. A resolved config-surface selection chooses OpenRig's normal launch
mode and takes precedence over ambient YOLO. Native configuration and managed
restrictions still matter; recording a policy does not translate config rules.

Skills and starter guidance describe intended behavior; they do not replace
filesystem/network boundaries. For explicit Codex sandbox-plus-approval choices
and returning to a restricted setting, see the getting-started permission guide
at `docs/reference/getting-started.md#opt-in-permissive-operation`.

**Naming:** YOLO names the full-bypass posture plainly; the picker presents all four
named postures (Locked / Standard / Open / YOLO) uniformly.
