# Lore routing — position knowledge by address

Lore is knowledge earned by one durable position while doing its work. It stays
under that position's seat tree and is composed by address when another artifact
needs it. The value is the combination of the content and where it was learned;
copying the bytes into a shared library destroys that distinction.

This convention defines the item shape, stable address, composition grant, and
the only path by which lore-derived content may leave the position boundary. It
adds no resolver, source kind, curator role, or transcript-mining process.

## Home, ownership, and stable address

Each item is one Markdown file beneath the owning seat's `lore/` directory:

```text
<topology-root>/rigs/<rig>/seats/<seat>/lore/<stable-slug>.md
```

Resolve `topology.root` from configuration; never hardcode the root. The owning
seat is the sole direct author. It writes as the durable position, not as a
particular occupant or predecessor.

The filename describes the situation or trigger and never contains a stage,
date, occupant generation, or version. Its address is therefore stable:

```text
seat:lore/<stable-slug>.md
seat:lore/<stable-slug>.md#situation
```

A stage change edits frontmatter and `date`; it never renames the file. Existing
citations must continue to resolve after the change.

## Required metadata

Every lore item carries these fields from birth:

| field | meaning |
|---|---|
| `taxonomy` | Exactly `lore`. This is the machine-readable privacy class. |
| `stage` | Current epistemic maturity. Legal values come only from [`knowledge-maturity.md`, “Two encodings, one ladder”](knowledge-maturity.md#two-encodings-one-ladder); do not copy or extend that vocabulary here. |
| `method` | How the owning position could know the claim: the observation, comparison, incident, or source method. |
| `date` | UTC date-time of the current stage decision or substantive revision. Update it when `stage` changes. |
| `position` | Canonical owning seat address, `<seat>@<rig>`. It names the position, never an occupant. |

`taxonomy: lore` is required both in each item's frontmatter and on any
manifest-bearing lore pack that serves it. A misspelling is not equivalent and
must fail any machine pin that extracts the class.

## Item template

Start a situation-shaped item with this template. Replace every placeholder;
`wip` is the starting label, while the authoritative vocabulary remains the
citation above.

```markdown
---
taxonomy: lore
stage: wip
method: "<how this position could know>"
date: "YYYY-MM-DDTHH:MM:SSZ"
position: "<seat>@<rig>"
---

# <Short situation or trigger>

## Situation

**Position:** `<seat>@<rig>`

**Moment.** <What is happening when this knowledge becomes useful?>

**Reflex.** <What tempting response is likely to be wrong?>

**Instead.** <What should the reader do?>

**Because.** <What evidence or failure made the difference?>
```

Facts may use `## Fact` instead when a fact genuinely is the transferable unit.
Any H2 intended as a section-level attachment repeats the canonical `Position:`
line so attribution remains visible when the resolver returns only that section.

## Addressing and composition

Lore uses the existing `seat:` grammar and an explicit rig-and-seat read grant.
The address says which file or section to read; the grant says whose seat tree
the address is relative to. No grant means no read.

For an install, compose the whole item address (`seat:lore/<slug>.md`) so its
frontmatter, taxonomy, stage, method, date, and position travel with the content.
A composed piece must visibly retain:

- the `seat` source label supplied by the resolver;
- the owning `position` from the item's bytes; and
- the `taxonomy: lore` class from both item and lore-pack metadata.

Serving one seat's lore into another seat's install is allowed only when the
caller deliberately grants the owning seat tree. The resulting piece remains
attributed to that owner; the receiving seat does not inherit its identity.

An attachment point is only a pointer paired with the owning position:

```yaml
lore:
  address: "seat:lore/<stable-slug>.md#situation"
  position: "<seat>@<rig>"
```

An attachment never embeds or copies the lore bytes. The reader resolves it
with the named position's explicit grant when the deeper context is relevant.

## Stage changes

To change maturity:

1. Edit only `stage` and `date` unless the claim itself also changed.
2. Re-resolve the same `seat:lore/<stable-slug>.md` address.
3. Confirm the address is unchanged and the new stage and date are visible.

If a stage change would break the address, stop: that storage shape violates
this convention. `superseded` and `retired` follow the semantics at the cited
maturity home; no lore-specific alternatives are invented here.

## The outward gate

A lore artifact never crosses from rig-local position knowledge into a shared
or shippable audience by copy, export, serving, or packaging. Grant-gated
read-side composition inside the rig is not graduation and keeps the source
address and position attached. Its content may inform a new outward artifact
only through authored re-homing:

1. The owning seat authors the destination artifact, or records an explicit
   delegation to its author.
2. The destination is written for its new audience in its own words; the lore
   file itself remains byte-unchanged.
3. The destination records the graduation event:

```yaml
graduation:
  source_address: "seat:lore/<stable-slug>.md"
  source_stage: "<stage at graduation>"
  date: "YYYY-MM-DDTHH:MM:SSZ"
  owner: "<seat>@<rig>"
  delegation: "none | <who delegated to whom>"
  warrant: "<why the content earned the new audience>"
```

4. If the destination is shippable, it must pass the public-substance admission
   gate. Renaming, rewrapping, or declaring copied lore as another pack class is
   laundering, not graduation.

The source address, source stage, owner/delegation, date, and warrant make the
move auditable from the destination. The source lore item is never edited merely
to announce that another artifact graduated from it.

## Privacy boundary

Lore is rig-local position knowledge. Shippable projection and bundle paths must
refuse `taxonomy: lore` structurally, independently of token deny-lists or content
scanners. Existing containment protections for seat files remain in force.

This convention deliberately does not create:

- automatic transcript or memory mining;
- a lore librarian, central curation queue, or review ceremony;
- cross-rig lore sharing;
- a new address grammar, resolver kind, or public export form.

Growth is owner-authored and organic. A seat writes an item when lived work makes
the situation worth preserving; consumers attach or compose it by address when
their situation calls for it.
