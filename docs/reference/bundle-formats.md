# Bundle formats (v1)

The shared data formats for sharing rig bundles: the configurations a bundle offers, the before-install view of what it
will do, run records and the public status file, and registry entries. The schemas are in [`schemas/`](schemas/), with
fixtures that pass and fail them in [`schemas/fixtures/`](schemas/fixtures/). Tools outside this repository read them
at a pinned commit.

**A v1 format only grows:** new optional properties may appear, and consumers ignore properties they don't know. Any
other change is a v2.

## Three identities, kept apart

| What | Name | Defined by |
|---|---|---|
| What someone chose | configuration ID | the mapping of every seat to a runtime |
| What was packaged | package digest | the built archive's files |
| What actually ran | execution binding | a run record (resolved resources, settings, environment, unknowns) |

None stands in for another. A package digest doesn't describe what ran, and a configuration ID doesn't describe what was
packaged.

### Source identity

A bundle on GitHub is named by `repository` (`https://github.com/<owner>/<repo>`, no credentials), `folder` (the
repo-relative path of the folder holding `rig.yaml`, or `.` for the repository root) and `resolvedCommit` (40 lowercase
hex).
- `requestedRef` (the branch, tag or commit someone gave) and `canonicalUrl` (`…/tree/<resolvedCommit>/<folder>`)
  explain it, and aren't part of it.
- A built bundle records its source in its manifest's provenance, which is outside the package digest.

### Configuration ID

Every member's `pod.member=runtime`, sorted by `pod.member` in plain code-unit order, joined with `,`. There's no
whitespace, and runtimes are spelled as in `rig.yaml`. For example:

```text
build.impl=claude-code,build.lead=claude-code,check.qa=codex,check.review=codex
```

Preset names such as `recommended` or `all-claude` are aliases shown beside the ID, never part of it.

### Package digest

`{ algorithm: "sha256", value, coverage: "openrig.package-digest/v1" }`:
- `value` is SHA-256 over UTF-8 lines `<path>\t<sha256>\n`, one for each entry of the built archive's `integrity.files`,
  sorted by path in code-unit order;
- it's the same when the same folder is rebuilt by the same OpenRig, while the archive's own hash changes with every
  build (`createdAt`).

**Coverage, shown wherever the digest is:** the bytes of every packaged file. It doesn't cover:
- `bundle.yaml`, so no manifest field, provenance or `createdAt`;
- the names the integrity walk skips (`.DS_Store`, `Thumbs.db`, `.gitkeep`);
- file modes;
- anything resolved on the installing machine at launch, for example an `openrig-home:` plugin, catalog skills, or a
  model or effort nothing declares.

**A build result** carries `configurationId`, `packageDigest`, `archiveHash` and `assembler` (`openrigVersion`, plus
`commit` when known). `configurationId()` and `packageDigest()` are exported from `@openrig/daemon/bundle-identity`.
Shared test vectors are in `schemas/fixtures/identity-vectors.json`.

## The formats

| Format | Schema | Lives | Written by |
|---|---|---|---|
| Declared configurations | `bundle-configurations.v1` | `configurations.yaml` beside `rig.yaml` | the bundle's author |
| Before-install view | `bundle-behaviour.v1` (`openrig.bundle-behaviour/v1`) | the registry, one file per configuration and assembler version; never inside the archive | `rig bundle inspect` |
| Run record | `run-record.v1` | beside its receipt, private | Fleet, Dev QA, and maintainers for community reports |
| Public status | `bundle-status.v1` | `openrig-world` status, generated | the status generator only |
| Registry entry | `registry-entry.v1` | `openrig-world/registry/<slug>.yaml` | maintainers, through review |

### Declared configurations

`seats` gives each `pod.member` the runtimes it may use, and the profile each runtime uses. `presets` names full
mappings, and `recommended` names one of them. A combination the file doesn't declare can't be built.

### Before-install view

It's derived from the archive's files alone. Nothing is launched, probed or fetched. It's a view, never a gate, and
carries no tested status.
- **`identity`:** source, configuration ID, package digest, the archive's assembler, the generator that made the view,
  stated compatibility, stated provenance (not verified), and integrity (self-consistency, not authorship). A field the
  archive doesn't state is `null`. It's never filled from the inspecting OpenRig.
- **`team`, `posture`, `toldFiles`, `alsoRuns`, `writes`, `outsideAddresses`, `needs` and `unknownBeforeLaunch`**, in
  that order. Each fact cites the archive file it comes from (`sourceRefs`) and how it resolves: `archive`,
  `host_at_launch` or `unresolved`.
  - Posture separates what the archive declares from the product's default. Its effect on the host is `unknown`,
    because host settings decide it.
  - An empty list means none are known. Something unknown goes in `unknownBeforeLaunch`.
- **`not_generated`:** a combination without a generated view. It carries a reason and the local command that shows it,
  and no sections.

### Run records and status

**A run record's subject** is either a team (source, configuration ID, package digest, assembler) or a harness check (a
runtime). A harness check never upgrades a team label.

**Records are private.** Only `outcome.publicNote` (a short public cause) reaches the status file.

**Relations:** `supersedes`, `withdraws` and `resolves`. Reusing earlier evidence for a changed package is a reviewer's
decision, recorded in the registry entry's `evidenceReuse`.

**The status file** is generated from records by rule `openrig.status-rule/v1`:
- **Labels:** `known_problem`, `tested`, `tested_with_help`, `partly_tested`, `not_tested` and `status_unavailable`.
  They're shown as Known problem, Tested by OpenRig, Tested with help (N), Partly tested, Not tested and Status
  unavailable.
- **Empty `platforms`** means Not tested.
- **A listing whose records can't be read** is `status_unavailable`, never Not tested.
- **The file holds no private paths, host names, row IDs, account names or receipt text,** and regenerating it gives
  identical bytes.
- **`bodyDigest`** is SHA-256 over the canonical JSON of every other top-level field: object keys sorted by code unit at
  every depth, no whitespace, numbers and strings in `JSON.stringify` form, UTF-8. `harnessChecks` has its own
  `state`, so an unreadable harness-check record reads Status unavailable too.

### Registry entries

Each entry records:
- the source at its reviewed commit;
- each offered configuration with its package digest, assembler and behaviour-view file;
- optional `evidenceReuse`;
- the review date, and `listed` or `withdrawn`.

A listing shows "Reviewed for listing on `<date>` at commit `<short>`. Review is not a security audit."
