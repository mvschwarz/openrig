# Read a reconstruction of selected work

A reconstruction records an author's working understanding, its evidence routes,
constraints and gaps. `rig context reconstruction` reads an exact immutable
`openrig.reconstruction/v0` revision locally. It does not start a daemon, fetch
remote context, write records or transfer the author's authority.

Inspect the purpose, depth, author-declared coverage, observation dates, complete
source manifest and approximate size before reading a view:

```bash
rig context reconstruction inspect <full-sha256> --project example --mission task --slice 01-example
rig context reconstruction view <full-sha256> --project example --mission task --slice 01-example --item decision --json
```

Without `--store`, the store is `reconstructions/` under the selected project,
mission or slice home. Project selection follows `context work-install`: an
explicit catalog project, the only entry, the calling rig's association, the
deepest project containing `--cwd`, or the only unclaimed entry. Ambiguity is an
error. The project's configured `missions.root`, declared mission membership,
slice directory names and slice frontmatter IDs are honored. A workspace
without a catalog can use its own project home. No skill installation or context
projection happens during this lookup.

Use `--store /absolute/local/store` for an imported store without resolving a
project. Supplying work selectors as well still validates that work home.
Revisions are full lowercase SHA-256 IDs; there is no implicit latest revision.

## Faithful views and gaps

Repeat `--item`, `--category` or `--tag` to select their union. A filtered view
always retains authority, constraint and gap items, plus transitive item
dependencies. It names omitted item IDs and uncited evidence routes, and keeps
declared reconstruction coverage separate from actual view coverage. Inspect
always provides the complete manifest; a filtered view provides cited routes.
A full view also includes uncited registered routes.

Base records, deltas and pinned compositions retain inherited observation dates.
A revision's creation date does not refresh those observations. Composition
members do not imply an atomic capture. Authors are claimed attribution, and
coverage is authored description rather than proof of runtime state or acceptance.

Unavailable records, missing selections, dependencies or citations make the
result `complete: false` and set exit status 1. Available composition members
remain visible with the missing member's exact store and revision. Unknown
schemas, invalid content hashes and unsupported numeric representations are
reported explicitly. The initial reader supports safe integer JSON numbers;
floating-point/exponent and unsafe integer representations are rejected rather
than assigned a different ID. Unicode keys follow v0's codepoint sorting.

## Relocate a store without changing its records

Parent and member pointers include absolute source-store paths in the hash.
Do not edit those paths in immutable records. Copy their closure into local
custody, then supply a separate JSON mapping:

```json
[
  {
    "sourceStore": "/original/work/reconstructions",
    "localStore": "/local/import/reconstructions",
    "sourceHost": "original-host"
  }
]
```

```bash
rig context reconstruction inspect <full-sha256> --store /local/import/reconstructions --store-map /local/map.json
```

The mapping is read-time location information, not an identity registry or a
remote fetch permission. It preserves source-host provenance. Since v0 pointers
do not contain a host discriminator, duplicate mappings for the same source
store are ambiguous and rejected. All external store pointers require a mapping,
even if that absolute path happens to exist on the current host.

## Bounds and byte checks

Reads are limited to 8 MiB per regular revision file, 32 MiB per closure, 64
record references and 128 JSON nesting levels. Symlink revision files are not
followed. Output defaults to 256 KiB; `--max-bytes` accepts 1 KiB through 8 MiB.
Oversized output fails explicitly rather than silently truncating a purportedly
complete view. Size estimates use UTF-8 bytes divided by four, not a model tokenizer.

`--check-sources` hashes declared local regular files within 128 files and 64 MiB
total. It reports changed, unchanged, unavailable or unchecked bytes without
executing source commands, fetching opaque routes or updating observations.
Discovery declarations are shown but not scanned. Unchanged known files do not
establish semantic freshness or detect new queue decisions. There is no queue
discovery cursor, native writer or continuity-consumer replacement in this reader.
