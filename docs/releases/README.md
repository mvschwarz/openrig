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
3. Create a git tag for the release:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Create a GitHub Release using the same file:

   ```bash
   gh release create vX.Y.Z \
     --repo mvschwarz/openrig \
     --title "OpenRig vX.Y.Z" \
     --notes-file docs/releases/vX.Y.Z.md
   ```

5. Publish the npm package if that is part of the release flow.

## Guidance

- Prefer user-facing language over commit-log language.
- Group related fixes into a small number of bullets.
- Be explicit about operator-impacting changes: setup, permissions, startup state, restore, recovery, and environment notes.
- Keep internal refactors out unless they materially change user behavior or operator confidence.
- If verification was limited, say so directly.

## Scope

This directory is a release-note archive, not a full historical changelog taxonomy.

If OpenRig later wants a curated `CHANGELOG.md`, it can be generated or summarized from the release notes here.
