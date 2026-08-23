# Worked project-tree example (demo)

This folder is a WORKED EXAMPLE of the project tree's chain files — the other
tree from the topology defaults this rig also ships. Copy the shapes, not the
content.

**Why project context cannot ship as a default, plainly:** it describes what
*you* are building. A mission's intent, a slice's specification, a proof
contract — no vendor can author those in advance, and installing someone
else's would put a stranger's project in your agents' heads. That is why the
topology tree ships curated defaults (how a team runs well is largely
general) while the project tree ships only this example (what you build is
yours alone). See `docs/reference/chain-file-convention.md`.

The shape, one chain name per altitude:

```
missions/<mission>/SPEC.md              intent in frontmatter; context slices need
missions/<mission>/slices/<slice>/SPEC.md    the ONLY altitude that specifies
                                 .../PROGRESS.md  derived progress rail
                                 .../PROOF.md     retained evidence: did it actually work
```

`rig scope mission create` / `rig scope slice create` scaffold these for real
projects — prefer the tooling to hand-copying this folder.
