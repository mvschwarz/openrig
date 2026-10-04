# Bundle formats (v1)

The shared data formats for sharing rig bundles: the configurations a bundle offers, the before-install view of what it
will do, run records and the public status file, and registry entries. The schemas are in [`schemas/`](schemas/), with
fixtures that pass and fail them in [`schemas/fixtures/`](schemas/fixtures/). Tools outside this repository read them
at a pinned commit.

**A v1 format only grows:** new optional properties may appear, and consumers ignore properties they don't know. Any
other change is a v2. The schemas are open to new properties, with three closed on purpose: the package digest (an exact
value), a run record's subject (a harness check can never carry a team's identity), and the public status file, where
nothing outside the schema may appear, so a private field can't leak in. A new property in a closed part is a v2. The
status schema also rejects labels that contradict their evidence: a tested label needs records and a package, tested
with help needs its count, tested can't carry one, and an unreadable listing carries only Status unavailable.

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

Every member's `pod.member=runtime`, sorted by `pod.member` in UTF-16 code-unit order, joined with `,`. There's no
whitespace, and runtimes are spelled as in `rig.yaml`. For example:

```text
build.impl=claude-code,build.lead=claude-code,check.qa=codex,check.review=codex
```

Preset names such as `recommended` or `all-claude` are aliases shown beside the ID, never part of it.

### Package digest

`{ algorithm: "sha256", value, coverage: "openrig.package-digest/v1" }`:
- `value` is SHA-256 over UTF-8 lines `<quoted path>\t<sha256>\n`, one for each entry of the built archive's
  `integrity.files`, sorted by path in UTF-16 code-unit order;
- `<quoted path>` is the path as a JSON string, exactly as JavaScript's `JSON.stringify(path)` writes it, so a tab or
  newline in a file name can't make two different file lists hash the same. In words: wrapped in `"`; `"` and `\`
  escaped with a backslash; U+0008, U+0009, U+000A, U+000C and U+000D written `\b`, `\t`, `\n`, `\f` and `\r`; any
  other character below U+0020, and any lone surrogate, written `\uXXXX` in lowercase hex; everything else as itself;
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
    Optional `posture[].permissionPrompts` is `off` for declared `full_bypass` (including rig- or member-level
    `builtin:yolo`) on any runtime; for Claude/Codex, `on` for a declared flag-surface floor policy or `default` when
    no policy is declared (prompts on unless the installing machine's settings turn them off). Omit it for
    config-surface policies (`builtin:locked`, `builtin:standard`, `builtin:open` or an archived `surface: config`
    policy), host-resolved Codex profiles, and Pi except declared full bypass. `selection` names the declared policy.
    An absent field means not stated, never `on`. For `off`, Claude
    bypasses permissions, Codex runs with full access and never asks, and Pi gets full resource trust (`--approve`,
    not a permission mode). These are archive facts; `nativeEffect` remains `unknown`.
  - An empty list means none are known. Something unknown goes in `unknownBeforeLaunch`.
  - Per-seat facts carry `seat` (`pod.member`) and human output labels them with that identity. On `needs` and
    `unknownBeforeLaunch`, it is optional: bundle-wide facts omit it, and older generators may not have stated it.
- **`not_generated`:** a combination without a generated view. It carries a reason and the local command that shows it,
  and no sections.

### Declared setup preconditions

The author's `bundle.yaml`, beside `rig.yaml`, may declare setup that the user must do before installing:

```yaml
preconditions:
  - name: Run inside an OpenRig source clone with dependencies installed and packages built.
    commands:
      - git clone https://github.com/mvschwarz/openrig.git
      - cd openrig
      - npm ci
      - npm run build
  - name: Sign in to the selected coding runtimes before starting the team.
```

Local-folder creation and GitHub-link imports carry these declarations into the archive manifest. A generated
before-install view lists each as `needs[]` with `kind: precondition`, the author's `name`, optional ordered `commands`,
`status: not_checked`, and a `sourceRefs` entry naming `bundle.yaml` and `preconditions[index]`. Inspect, plan and apply
previews show the same declaration. A legacy schema-1 archive retains it in the manifest, but its view remains
`not_generated`. Missing preconditions mean none were declared, not that no setup is needed.

Each command is one plain command line, without shell operators (`;`, `&&`, pipes, command substitution, backticks or
redirection). Run them in order in **one shell**, then run the install command in that same shell: it inherits the
working directory left by the setup commands. There is no separate `workdir` field. Commands are untrusted author data;
a site building a copyable block must validate every line and bound the number of entries, omitting all setup lines
if any fails its plain-command rule. OpenRig displays these declarations; it does not execute them, verify that setup
was done, or add a prerequisite gate. The archive hash covers the manifest; `packageDigest` excludes `bundle.yaml`
and therefore does not cover these declarations.

At creation, malformed preconditions produce a warning and the whole block is omitted; other author-field validation
is unchanged. Shell operators in otherwise valid command lines produce a warning, but the declarations are retained
as data. An already-built archive with malformed preconditions reports them as unknown before launch.

### Run records and status

**A run record's subject** is either a team (source, configuration ID, package digest, assembler) or a harness check (a
runtime). A harness check never upgrades a team label.

**A run record's `environment.platform` and `arch`** are Node's `process.platform` (`linux`, `darwin` or `win32`) and
`process.arch` (`x64` or `arm64`): the values a status platform key can carry, so every valid record can be labelled.

**Records are private.** Only `outcome.publicNote` (a short public cause) reaches the status file.

**Relations:** `supersedes`, `withdraws` and `resolves`. Reusing earlier evidence for a changed package is a reviewer's
decision, recorded in the registry entry's `evidenceReuse`.

**The status file** is generated from records by rule `openrig.status-rule/v1`:
- **Labels:** `known_problem`, `tested`, `tested_with_help`, `partly_tested`, `not_tested` and `status_unavailable`.
  They're shown as Known problem, Tested by OpenRig, Tested with help (N), Partly tested, Not tested by OpenRig
  and Status unavailable.
- **A label belongs to one configuration ID.** No configuration is ever shown another configuration's label.
- **Empty `platforms`** means Not tested by OpenRig. So does a custom configuration, one the listing doesn't offer.
- **Status unavailable is only for a listed configuration** whose records can't be read, or that's missing from the
  status file; never Not tested by OpenRig. A listing whose records can't be read is `status_unavailable` as a whole.
- **Platform keys** are `<os>-<arch>` (`linux`, `darwin` or `win32`; `x64` or `arm64`).
- **`tested` means no help was needed:** it can't carry an assistance count above zero.
- **The file holds no private paths, host names, row IDs, account names or receipt text,** and regenerating it gives
  identical bytes.
- **`bodyDigest`** is SHA-256, lowercase hex, over the RFC 8785 (JCS) canonical JSON, as UTF-8, of an object holding
  every other top-level field. The site import recomputes it and rejects a hand-edited file. `harnessChecks` has its own
  `state`, so an unreadable harness-check record reads Status unavailable too.

### Registry entries

Each entry records:
- the source at its reviewed commit;
- each offered configuration with its package digest, assembler and behaviour-view file;
- optional `evidenceReuse`;
- the review date, and `listed` or `withdrawn` (with `withdrawnOn`).

v1 has no author field: a listing shows the owner of `source.repository`.

A listing shows "Reviewed for listing on `<date>` at commit `<short>`. Review is not a security audit."
