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

Invoke the skill as `refocusing`, its frontmatter name. OpenRig seeds it in the
Claude and Codex global skill roots and includes selected plugin skills in managed
loadouts. Existing externally managed copies remain authoritative. If the harness
has not discovered it yet, read this installed skill file and run its script directly;
hook registration alone does not prove native skill discovery.

Refocus preserves a long session's earned expertise while re-grounding it in current intent and
lived context. It is not a restart, wake, or phase checkpoint.

During an actionable managed restore, consume the current topology and work trace
that actually arrived with the request. Do not rerun Python merely to duplicate it.
If no current trace arrived, name that delivery gap. A packet pointer, compact
summary or truncated extract is not a full source read. Use the native file-read
tool for required notes and full sources, and complete the existing restore audit;
partial file reads do not establish completed refocus or restoration.

For a new trace outside that delivered context, follow the command guidance below.
Resolve the bundled script's absolute path from the directory of this loaded skill.
Stay in your current working directory; do not `cd` into the skill directory, which
can change the inferred work node. Run the trace as **one plain command**, replacing
the example path with the actual absolute path written out in the tool call:

```bash
python3 "/absolute/path/to/refocusing/scripts/trace-to-root.py" --trees both --depth light
```

Do not combine this command with shell variables, environment assignments, command
substitution, exit-status printing or file-reading loops. Read the named source
files separately with the native read tool. Combined shell loops or variables can
require native approval even when the intended operations are read-only; a plain
command is not a guarantee that approval will never be needed.

For managed compaction, refocus during the restore request or its read-depth
audit. The earlier acknowledgement-only boundary is not permission to restore.

Use `--trees topology|work|both` to select context domains and `--depth light|full` to control how
much each node contributes. Light work traces compose `intent:` and name notes; full traces include
the complete node and notes bodies. The script resolves `topology.root` and `workspace.root` with
`rig config get`. When a known current node must be supplied, pass `--work-start` or
`--topology-start` with its literal absolute path in the same plain command. Do not
substitute the project root for a mission or slice node and claim that mission was traced.

The trace walks the topology and work trees. For the project's own declared context (intent, context files,
skills), `rig context work-install` lists it; read what the next action needs.

Read [references/refocus.md](references/refocus.md) when changing the automatic hook or its content
ladder. A missing chain file is evidence: report the gap and continue; never follow pointers to invent
a second parent.
