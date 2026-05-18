---
kind: as-built
title: As-Built Frontmatter — Pointer + As-Built-Unique Field
status: active
topics: [knowledge-and-context, frontmatter]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Authoring or updating a doc under docs/as-built/. Tells you which
  frontmatter convention governs these docs and the one field that is
  unique to as-built docs.
siblings: [README.md]
prerequisite-reads: [README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# As-Built Frontmatter — Pointer + As-Built-Unique Field

Every doc under `docs/as-built/` carries YAML frontmatter. The shape is
**not** defined here. It is the substrate-wide context-frontmatter
convention; this doc only points to it and documents the one field that
is unique to as-built docs.

## Canonical convention (do not duplicate — read it)

`openrig-work/conventions/frontmatter-for-context/README.md` is the
authoritative schema: required floor (`kind` + `title` + `status` +
`applies-when`), recommended fields (`topics`, `domains`, `siblings`,
`prerequisite-reads`), and the controlled vocabularies for `kind:`,
`topics:`, and `domains:`. Author against that convention. This doc adds
nothing to it except the field below.

## `kind: as-built`

These docs use `kind: as-built`. That value is in the convention's
controlled `kind:` vocabulary (first row of its "Controlled vocabulary —
`kind:`" table, source `openrig/docs/as-built/*`). Using it is conformant,
not an extension.

## `last-verified-against-source: <sha>` (as-built-unique)

As-built docs describe the running system. They drift when the source
drifts. The as-built-unique field records the exact commit the doc was
last verified against:

```yaml
last-verified-against-source: 7eaf524c
```

- **Value:** the short SHA of the source HEAD the doc was verified
  against at its last edit. Pair with `last-updated: <iso-date>`.
- **Why it is here and not in the convention:** the convention is
  substrate-wide; most context docs do not track a source SHA. This
  field is meaningful only for docs that mirror code, i.e. as-built
  docs. It is the per-module drift-detection anchor the
  context-architecture-v1 mission dogfoods on its own production.
- **Discipline:** when re-verifying a module against a newer HEAD,
  bump this field (and `last-updated`) and carry an inline
  `re-confirmed <file:line> @HEAD` annotation on each load-bearing
  claim that was re-checked.

## See also

- `openrig-work/conventions/frontmatter-for-context/README.md` — the canonical schema
- `README.md` — the as-built corpus map of territory
