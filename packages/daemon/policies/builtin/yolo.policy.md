---
source: builtin
name: yolo
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Full-bypass posture — the flag-surface YOLO opt-in. Everything runs, nothing prompts. Guardrailed by skills and starter markdown, not by permission-blocking.
---

# YOLO (built-in policy — flag surface)

The maximum-permissive built-in. The seat runs the harness with its full-bypass launch flag: Claude `--dangerously-skip-permissions`, Codex full-bypass, Pi `--approve`. Nothing prompts; nothing is denied. Use only for fully-trusted autonomous work where any pause is unacceptable.

**APPLICATION is deterministic, NOT skill-translated.** YOLO is a `surface: flag` policy: it resolves to a stable launch flag, so it is applied by the deterministic flag-surface opt-in — the rip-out slice's YOLO setting (OPR.0.4.8.2). The `applying-a-permission-policy` skill does **NOT** translate this policy; it simply points at that setting. This is the two-surface distinction: the flag surface is stable enough for deterministic code, so it does not pay the skill-indirection tax.

**Config policies are MOOT when YOLO is on.** The full-bypass launch flag overrides any Claude prefix rules / Codex posture, so an attached config-surface policy (Locked/Standard/Open) has no effect while YOLO is active. Pick YOLO OR a config policy, not both.

**Guardrails come from skills + starter markdown, not permission-blocking** — a YOLO seat is bounded by what its skills and operating context tell it to do, since the permission layer imposes nothing.

**Naming lineage:** the original final design named the fourth built-in **Operator**. The two-surface refinement (2026-08-03) subsumed Operator into this flag-surface full-bypass built-in and renamed it **YOLO** to name the posture plainly; the picker presents all four named postures (Locked / Standard / Open / YOLO) uniformly. Grounded in schema `a8dba0d9`.
