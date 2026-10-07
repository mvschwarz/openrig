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

When invoking through the plugin skill tool, use the registered name
`openrig-core:refocusing`. If that plugin is not loaded by the current harness,
read this file and run the bundled script directly; hook registration alone does
not make a skill visible to the harness.

Refocus preserves a long session's earned expertise while re-grounding it in current intent and
lived context. It is not a restart, wake, or phase checkpoint.

Run the bundled trace from this skill directory instead of reconstructing the hierarchy from memory:

```bash
python3 scripts/trace-to-root.py --trees both --depth light
```

For managed compaction, do this during the restore request or its read-depth
audit. The earlier acknowledgement-only boundary is not permission to restore.

Use `--trees topology|work|both` to select context domains and `--depth light|full` to control how
much each node contributes. Light work traces compose `intent:` and name notes; full traces include
the complete node and notes bodies. The script resolves `topology.root` and `workspace.root` with
`rig config get`. When a current node cannot be derived, set `OPENRIG_REFOCUS_TOPOLOGY_NODE` or
`OPENRIG_REFOCUS_WORK_NODE`, or pass the matching `--*-start` option.

The trace walks the topology and work trees. For the project's own declared context (intent, context files,
skills), `rig context work-install` lists it; read what the next action needs.

Read [references/refocus.md](references/refocus.md) when changing the automatic hook or its content
ladder. A missing chain file is evidence: report the gap and continue; never follow pointers to invent
a second parent.
