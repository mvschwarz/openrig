# Release Notes

This directory is the lightweight release history for OpenRig.

It is intentionally simpler than a monolithic `CHANGELOG.md`.

Each shipped release gets its own note:

- `v0.1.12.md`
- `v0.2.0.md`
- `v0.3.0.md`
- and so on

## Why This Exists

We want a practical release-management pattern that works with how OpenRig is actually being shipped today:

- npm package release
- optional Git tag
- optional GitHub Release
- short, human-written summary of what is included

This keeps release notes:

- easy to author
- easy to link in GitHub Releases
- easy to paste into announcements
- durable in the repo

## Minimal Process

For each release:

1. Copy `_template.md` to `vX.Y.Z.md`.
2. Fill in the release summary, included changes, operator notes, known limitations, and verification performed.
3. Run the **substance gate** at the exact release cut. The gate derives every
   file under the shipped pack sources, verifies a hash-bound human judgment
   and an individual disposition for each mechanical candidate, scans the
   complete npm artifact set derived by the packager, and writes the durable
   receipt. The receipt records both artifact and scanned file lists; their
   artifact-minus-scanned diff must be empty. The review JSON carries one
   entry per file:

   ```json
   {
     "surfaces": [{
       "path": "packages/daemon/context-packs-src/example/guide.md",
       "sha256": "<sha256 of the reviewed bytes>",
       "verdict": "ship",
       "reason": "Generic product guidance.",
       "candidateDispositions": []
     }]
   }
   ```

   Assemble the package first, then run the named gate from the same clean
   worktree with the judge and cut SHA explicit. The assembly emits the
   substance roots it actually staged; the gate never carries its own root
   list. A non-shipping human verdict is one of `instance-fact`,
   `internal-path`, `position-knowledge`, or `lore-class` and carries its
   reason in the same per-file entry:

   ```bash
   bash scripts/build-package.sh
   npm run gate:substance -- \
     --review /path/to/substance-review.json \
     --receipt /path/to/substance-receipt.json \
     --judge <seat-or-person> \
     --cut-sha "$(git rev-parse HEAD)"
   ```

   A missing/stale judgment, an undispositioned candidate, internal substance,
   a lore-classed pack, a failed full artifact scan, or any artifact absent
   from the scanned set refuses the cut.
4. Create a git tag for the release:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. Create a GitHub Release using the same file:

   ```bash
   gh release create vX.Y.Z \
     --repo mvschwarz/openrig \
     --title "OpenRig vX.Y.Z" \
     --notes-file docs/releases/vX.Y.Z.md
   ```

6. Publish the npm package if that is part of the release flow.

## Guidance

- Prefer user-facing language over commit-log language.
- Group related fixes into a small number of bullets.
- Be explicit about operator-impacting changes: setup, permissions, startup state, restore, recovery, and environment notes.
- Keep internal refactors out unless they materially change user behavior or operator confidence.
- If verification was limited, say so directly.

## Scope

This directory is a release-note archive, not a full historical changelog taxonomy.

If OpenRig later wants a curated `CHANGELOG.md`, it can be generated or summarized from the release notes here.
