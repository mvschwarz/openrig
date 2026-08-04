---
source: builtin
name: standard
surface: config
policy_schema_version: 1
description: The recommended default — the 80% software-factory interactive-dev posture. Routine dev including push; the outward/release/history-rewriting acts ask the human.
default_posture: allow
allow: [push_to_remote]
ask: [create_pr, publish_package, merge_or_release, force_push]
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs]
---

# Standard ⭐ (built-in policy — recommended default)

The everyday software-factory posture for INTERACTIVE dev. Routine work runs without prompts; the consequential outward and history-rewriting acts defer to the human.

- **default_posture: allow** — routine dev (toolchain, arbitrary shell, install deps, scoped file deletion, network, topology) runs without a prompt.
- **allow: [push_to_remote]** — routine `git push` is allowed (pinned explicitly; the founder rejected gating push as a default).
- **ask: [create_pr, publish_package, merge_or_release, force_push]** — outward/release/history-rewriting acts ASK the human. **ASK ≠ deny**: OpenRig bakes no block; ASK = defer to the human, the founder's explicit beyond-floor default. `force_push` is additionally best-effort on Claude (prefix rules can't reliably split `git push --force`), so ASK is the honest disposition, not a can't-enforce deny.
- **destructive_class → ask** — `delete_everything`, `drop_persistent_store`, `reset_or_discard_vcs` default to ASK, never a silent block (best-effort-safe).

**INTERACTIVE-dev posture:** an `ask` freezes an autonomous seat by design — autonomous fleets use Open or YOLO, not Standard.

**FLOOR (always on, flag surface):** Claude `acceptEdits` + Codex `workspace-write` (the edit/sandbox floor); Pi `--no-approve` is a resource-TRUST posture, not a permission floor (Pi has no permission surface). **Translation is the skill's job** (harness-neutral intent → per-harness format, caveated). Grounded in schema `a8dba0d9`; the ask-set is pinned per cold-transfer `627abbb6`.
