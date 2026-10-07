---
kind: as-built
title: As-Built Frontmatter
status: active
topics: [knowledge-and-context, frontmatter]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Writing or refreshing a source-grounded document under docs/as-built/.
last-verified-against-source: 82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d
last-updated: 2026-10-05
---

# As-Built Frontmatter

Source snapshot: `82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d`. This describes the source at that commit;
it does not establish the version or behavior of a running daemon.

Frontmatter makes an as-built page discoverable and records the source it
was checked against. This page describes the convention visible in this
repository. It does not require an unpublished schema or an internal
workspace to interpret the fields.

## Fields

The corpus uses these fields; see the [module index](README.md) and
[CLI reference](cli-reference.md) for examples.

| Field | Meaning |
|---|---|
| `kind: as-built` | Identifies a description of implemented behavior. |
| `title` | Human-readable subject of the page. |
| `status` | Document status, such as `active`; not a daemon or feature status. |
| `applies-when` | Short retrieval cue explaining when to open the page. |
| `topics`, `domains` | Lists of indexing labels used in this corpus. They do not select permissions or runtime behavior. |
| `siblings`, `prerequisite-reads` | Related pages and reading order, when useful. Paths are relative to the containing page. |
| `last-verified-against-source` | A resolvable Git commit whose source was used to check the page. |
| `last-updated` | Date of the document update, in `YYYY-MM-DD` form. |

## Verification stamp

Use a commit ID, preferably full length, rather than a branch name or a
moving `HEAD` label. A source stamp identifies what was read; it is not proof
that an installed package or a running system uses that source. Keep runtime
observations separately qualified.

```yaml
last-verified-against-source: 82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d
last-updated: 2026-10-05
```

Check that the commit resolves with `git cat-file -t <commit>` in a checkout
containing that history. Verify the paths, symbols, and numeric claims cited
by the page at that commit before changing its stamp. A newer date alone
does not refresh the content. Missing history in a shallow checkout and an
invalid commit ID are different conditions.

Use repository links and named symbols for source references. For numeric
inventories, state what is counted and how it was obtained; for example, the
CLI reference distinguishes registered command objects from aliases and
Commander-generated help.

## What the repository guard checks

[`scripts/check-docs-guard.mjs`](../../scripts/check-docs-guard.mjs)
checks allowed tracked documentation paths. Its `findBlockedDocsPaths`
function does **not** validate this frontmatter or prove the prose matches
source. Passing that guard should not be reported as a schema or factual
accuracy check.

[As-built pages](README.md) and [operator reference pages](../reference/help.md)
serve different purposes. `docs/reference/` is staged by
[`scripts/build-package.sh`](../../scripts/build-package.sh); placing content
there changes what is distributed in the package.
