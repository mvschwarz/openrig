---
name: loading-addressable-markdown
description: Use when a mission, slice, dashboard, or task references Markdown as path#h2-slug or path#h2-slug/h3-slug outside the OpenRig context-pack library.
---

# Loading Addressable Markdown

## Overview

Load exactly one addressed Markdown section from any filesystem tree. The resolver mirrors OpenRig's shipped H2/H3 grammar without requiring the file to live in the context library.

## Use

Run the bundled script. Relative file references resolve from `--root`; without it they resolve from the current directory.

```bash
node ~/.agents/skills/loading-addressable-markdown/scripts/resolve-markdown.mjs \
  --root /path/to/mission \
  'slices/09-source-cleanup/SPEC.md#proposal'
```

The accepted forms are:

- `file.md` — whole file
- `file.md#h2-slug` — full H2 span, including child sections
- `file.md#h2-slug/h3-slug` — full H3 span

Slugs are lowercase; Markdown emphasis/code markers are removed; each other non-alphanumeric run becomes `-`. Duplicate or missing paths fail loudly. Headings inside fenced code blocks are ignored.

## Common mistakes

- Do not use `rig context get` for an arbitrary filesystem path; that command resolves context-library refs.
- Do not hand-slice headings with `sed` or line numbers; the bundled resolver owns span and fence behavior.
- Quote addresses in shell commands.
