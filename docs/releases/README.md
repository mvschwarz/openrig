# Release Notes

This directory holds one note per release for OpenRig v0.1.12 through v0.6.3, plus v0.6.12 (for example `v0.1.12.md`).

Notes for later releases are in [`CHANGELOG.md`](../../CHANGELOG.md) and on the [GitHub Releases page](https://github.com/mvschwarz/openrig/releases).

## Minimal Process

For each release:

1. Add the release's section to [`CHANGELOG.md`](../../CHANGELOG.md).
2. Write the release's GitHub Release notes. No new file is added to this directory.
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

5. Create the GitHub Release with the notes from step 2:

   ```bash
   gh release create vX.Y.Z \
     --repo mvschwarz/openrig \
     --title "OpenRig X.Y.Z" \
     --notes-file <release-notes.md>
   ```

6. Publish the npm package.

## Guidance

- Prefer user-facing language over commit-log language.
- Group related fixes into a small number of bullets.
- Be explicit about operator-impacting changes: setup, permissions, startup state, restore, recovery, and environment notes.
- Keep internal refactors out unless they materially change user behavior or operator confidence.
- If verification was limited, say so directly.

## Scope

This directory is a release-note archive, not a full historical changelog taxonomy.
