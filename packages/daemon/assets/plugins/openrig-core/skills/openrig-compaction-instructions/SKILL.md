---
name: openrig-compaction-instructions
description: Use when configuring, testing, or customizing OpenRig's Claude Code auto-compaction prompts, restore file path, and post-compaction recovery flow.
---

# OpenRig Compaction Instructions

This skill is the shipped customization surface for OpenRig-managed Claude
Code compaction. It exists so compaction prompt wording can improve over time
without changing daemon runtime code for every wording adjustment.

## Default Instruction Files

OpenRig ships two default templates here:

- `COMPACT.md` is the source template for the compact-summary instruction.
  The current runtime stores that instruction inline in
  `policies.claude_compaction.compact_instruction`.
- `COMPACTION.md` is the default file-backed post-compaction restore prompt.
  OpenRig's Claude compaction policy points at this file by default:

```text
${OPENRIG_HOME}/plugins/openrig-core/skills/openrig-compaction-instructions/COMPACTION.md
```

In a default install this resolves to:

```text
~/.openrig/plugins/openrig-core/skills/openrig-compaction-instructions/COMPACTION.md
```

The UI setting `policies.claude_compaction.message_file_path` can point to a
different file when an operator wants to test an alternate restore prompt.
Inline restore text in `policies.claude_compaction.message_inline` wins over
the file path when it is non-empty.

## Channel Model

Claude Code treats channels differently:

- A normal submitted prompt is the user channel. OpenRig uses this channel for
  the post-compaction restore request because Claude can act on it as an
  operator request.
- Hook output and local-command-adjacent text are context, not a dependable
  action request. OpenRig uses hooks to prepare restore packets and markers,
  then follows with a normal user-channel restore message.
- Terminal text injection is only safe when the agent prompt is idle and empty.
  OpenRig's auto-compaction path waits for that state before submitting
  `/compact`, then sends a short boundary turn before the restore prompt.

## What To Customize

Edit or replace `COMPACTION.md` when the restore process needs different
wording, extra project-specific evidence sources, or a stricter readiness
statement. Use `COMPACT.md` as the matching compact-summary template when
the inline compact instruction needs to be reset or copied into another
policy profile.

Keep the prompt evidence-shaped. Ask the compacted agent to inspect files,
restore packets, transcripts, queue state, and current work before continuing.
Avoid instructions that look like shell output to execute or attempts to
override Claude's safety behavior.
