---
name: refocusing
description: >-
  Use when a long-running agent may have lost the product outcome, when context was compacted,
  when work has crossed a major boundary, or when a fresh path-based trace is needed before the
  next consequential action. Not for fresh-session orientation, waking an idle seat, or checkpoints.
metadata:
  openrig:
    stage: product
---

# Refocusing

Refocus preserves a long session's earned expertise while re-grounding it in current intent and
lived context. It is not a restart, wake, or phase checkpoint.

Run the bundled trace from this skill directory instead of reconstructing the hierarchy from memory:

```bash
python3 scripts/trace-to-root.py --trees both --depth light
```

Use `--trees topology|work|both` to select context domains and `--depth light|full` to control how
much each node contributes. Light work traces compose `intent:` and name notes; full traces include
the complete node and notes bodies. The script resolves `topology.root` and `workspace.root` with
`rig config get`. When a current node cannot be derived, set `OPENRIG_REFOCUS_TOPOLOGY_NODE` or
`OPENRIG_REFOCUS_WORK_NODE`, or pass the matching `--*-start` option.

Read [references/refocus.md](references/refocus.md) when changing the automatic hook or its content
ladder. A missing chain file is evidence: report the gap and continue; never follow pointers to invent
a second parent.
