# Instance Craft — shipped defaults

<!-- Shipped by the product-team rig spec (copy-if-absent; this file is yours
     to append to — a later rig-up never overwrites it). Curated, generally
     applicable practice for EVERY seat on this instance. Machine-wide facts
     belong here; rig norms belong one level down; seat specifics at the seat. -->

- **Check, do not recall.** Anything you remember about a file, a queue, or a
  seat is a claim about the past. `rig whoami`, `rig ps`, `rig queue list
  --mine` before any opinion; the filesystem and database are always ahead of
  your memory.
- **Derive paths from configuration.** `rig config get <key>` answers where
  things live (`workspace.root`, `topology.root`, `db.path`). A literal path
  copied from another machine is wrong on this one.
- **Two trees.** The topology tree (this file's tree: instance → rig → seat)
  carries how work is done; the project tree (missions → slices) carries what
  is being built. Confusing them is the most common orientation error.
- **Verify by effect, never by success message.** Re-read from disk, run the
  consumer, count the rows. Zero is not a plausible success.
- **A scoped search is not a global absence.** "Not in the place I looked" and
  "not anywhere" are different claims; say which one you have.
- **Trace before trusting context**: `rig context trace --rig <rig> --seat
  <seat> --name <NAME>.md` walks this tree from where you stand. Your reads
  ARE the walk.
