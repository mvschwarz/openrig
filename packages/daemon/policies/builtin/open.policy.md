---
source: builtin
name: open
surface: config
policy_schema_version: 1
description: High-trust denylist posture — everything allowed except the explicitly-destructive class, which asks. Just below YOLO.
default_posture: allow
allow: []
ask: []
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs]
---

# Open (built-in policy)

High-trust posture: everything runs without a prompt except the catastrophic-destructive class. Use for trusted autonomous fleets that still want a backstop on disk-destroy-class acts. One step below YOLO.

- **default_posture: allow** — everything, including push, PR, publish, merge/release, force_push, arbitrary shell, network, secrets, topology.
- **destructive_class → ask** — `delete_everything`, `drop_persistent_store`, `reset_or_discard_vcs` ASK, never silent-block (best-effort-safe). This is the only carve-out.
- Difference from Standard: Standard ASKs the release-class (PR/publish/merge/force_push); Open ALLOWs them and asks only the destructive class.

**Autonomous note:** the destructive-class `ask` will freeze a fully-autonomous seat if such an action is attempted — which is the intended backstop. An autonomous fleet that must never pause even on a disk-destroy-class act uses YOLO (flag-surface full-bypass), not Open.

**FLOOR (always on, flag surface):** Claude `acceptEdits` + Codex `workspace-write` (the edit/sandbox floor); Pi `--no-approve` is a resource-TRUST posture, not a permission floor (Pi has no permission surface). **Translation is the skill's job.** Grounded in schema `a8dba0d9`.
