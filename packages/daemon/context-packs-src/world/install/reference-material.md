# What you can look up

**You are going to hit a question this onboarding does not answer.** That is expected — it is a
world model, not a manual. What matters is that you reach for a written answer instead of deriving
one, because **an invented answer and a known one look identical once you have stated it.**

So: here is what exists in writing on an OpenRig machine, and roughly what each kind of thing answers.
You do not need to read any of it now. You need to know it is there.

## The command surface — `docs/as-built/` in the source repo

Eight documents sit directly in `docs/as-built/` in the source repo, and
twenty-four files across `docs/` carry the same `kind: as-built` marker. Two of them are entry
points and were written to be entered from:

- **`README.md` — "Map of Territory + Module Index."** Start here when you do not know which
  document you want.
- **`codemap.md` — "Navigation Index / Map of Territory."** Start here when you are about to go
  into the code and do not know which module owns the thing.
- **`cli-reference.md` — the full `rig` command surface, ~106 KB.** Every group, subcommand, flag,
  JSON shape. **This is the authority on how a command works**, and the capabilities piece
  (`what-you-can-do.md`) is only the map to it.

**These are maintained, not archaeology.** `cli-reference.md` alone has forty-nine commits against
it. Treat them as current.

### The field that tells you how much to trust one

Each of these carries frontmatter, and three fields are worth knowing by name:

- **`applies-when:`** — a trigger. *When* you should reach for this document, not what is in it.
  If you are scanning for something, scan these.
- **`siblings:` / `prerequisite-reads:`** — the graph. Documents here point at their neighbours, so
  arriving at roughly the right one is enough; it will route you.
- **`last-verified-against-source: <commit>`** — **the honest one.** It names the commit the
  document was last checked against. If `main` has moved a long way past it, expect lag —
  especially in areas that changed recently.

**A document that names what it was verified against is trustworthy in a specific way**, and the
field is how you calibrate rather than guess. Where a doc and the live binary disagree, **the
binary wins** — and the disagreement is worth reporting, not just working around.

## The corpus — under `shared-docs/` in the OpenRig home

Twenty-one directories of accumulated writing. The ones you are most likely to want:

| where | roughly | what it holds |
|---|---|---|
| `product/` | 103 files | what OpenRig is, who it is for, why it exists in this shape |
| `conventions/` | 76 files | how things are done here — naming, scope, cadence, formats |
| `field-notes/` | 141 files | what actually happened, written by whoever it happened to |
| `primitives/` | 38 files | the load-bearing concepts, examined one at a time |
| `doctrine/` | 10 files | the rulings that settled a recurring argument |
| `corpus/` | 14 files | canon and insights, distilled |

**A warning you will need, because it is not obvious from the directory names:** almost all of this
was written to explain OpenRig **to a human**. It says *you stop being the router, the bookkeeping
leaves your head, your job shrinks to judgment.* Read as-is, it is about somebody else.

**The agent version is the same content with the subject swapped: you are the router now.** The
bookkeeping moved to you. The judgment that was supposed to stay human is sitting in your seat.
When you read the corpus, do that substitution as you go — otherwise you will absorb it as
background about a user rather than as a description of your own job.

## The living answer — `--help`

**The binary is always more current than anything written about it.** `rig <verb> --help` and
`rig <verb> <subcommand> --help` are authoritative for shape, flags and defaults. This costs
seconds and it is the single cheapest habit on this list.

**And use it as a search, not just a lookup.** `rig --help` lists eighty-one top-level verbs. If
you are about to build something, read that list first — the most expensive failure here is
building a parallel solution out of primitives that already compose into the answer.

## Outside the forest — when nothing on this machine can answer it

**Everything above is this box.** The corpus, the as-built docs, `--help`, the disk. There is a
whole class of question none of it reaches: what an external library actually does today, anything
that changed after your training cutoff, what is true in the world rather than in this repo.

**And the failure is the same one this page already warns about, pointed outward.** An agent that
does not know the corpus exists invents instead of looking. An agent that does not know these exist
**answers from its training snapshot and states it as current** — and an invented answer and a
known one look identical once you have stated one.

- **`context7`** — official documentation for a library, framework, SDK, API, CLI tool or cloud
  service. **The moment: you are about to answer a question about any of those from memory.**
  Reach for it even when you are confident, because confidence is exactly what a stale training
  snapshot feels like. `resolve-library-id` first, then `query-docs`; it returns versioned library
  IDs with a source-reputation and benchmark score, so you can see how good the coverage is before
  you trust it.
- **`exa` web search** — the general web. Describe the ideal *page*, not keywords: *"blog post
  comparing X and Y performance"* beats *"X vs Y"*. It has an agent mode that does multi-step
  research when one query will not do. `WebSearch` / `WebFetch` ship in the harness and do the
  simpler version of the same job.

### The trust rule, and it is not the one these tools invite

**A search result is a scrape of a page ABOUT the thing. The primary source is the thing.** Search
to FIND; go to the primary source to CONFIRM anything load-bearing — the registry, the API, the
repository, the running binary's `--help`.

**Measured here 2026-08-18, and it inverts the intuition.** Asked for the current published version
of a package, web search returned one page saying `0.5.0` (stamped "updated" two weeks earlier) and
another saying `0.4.0`. The registry itself said `latest: 0.5.1` — and a four-day-old line in an
agent's own memory index had been right all along. **The live-looking source was the stale one.**
Web caches lag by an unknown and unstated amount, and nothing on the page tells you how much.

So these extend your reach; they do not outrank a primary source, and *newer-looking* is not
*newer*.

## The one you read rather than consult

**`openrig-operating-model`** — a skill, ~23 KB. Everything else on this page you visit with a
question already in hand. **That one you read through once**, because it is the shape the rest
hangs on: the two trees, how context is arranged by altitude, and how a cold agent finds what it
needs. Reading it is what stops you inventing an arrangement that already exists.

## The habit all of this exists to support

**Three empty searches means your word for it is wrong, not that it does not exist.** Rename what
you are looking for and try once more, then ask someone who would know, then record the gap.

**Not loaded never means not available.** Almost nothing here is in your context; nearly all of it
is one command away.
