# RigBundle Reference

Version: 2 (pod-aware)
Last validated against code: 2026-10-07, at the 0.6.6 cut `2620dea8` (whole document at `a350c59b`; changes to its sources since then checked)
Source of truth: `packages/daemon/src/domain/bundle-types.ts`, `packages/daemon/src/domain/bundle-archive.ts`, `packages/daemon/src/domain/pod-bundle-assembler.ts`, `packages/daemon/src/routes/bundles.ts`, `packages/cli/src/commands/bundle.ts`, `packages/daemon/src/domain/bundle-install-context.ts`, `packages/daemon/src/domain/bundle-source-resolver.ts`, `packages/daemon/src/domain/bootstrap-orchestrator.ts`

A `.rigbundle` is a self-contained distributable archive that packages a rig spec, all referenced agent specs, their resources (skills, guidance, startup files), culture file, documentation, and an integrity manifest into a single file. The recipient can install and launch the rig without needing the original source tree.

## GitHub folder links

`rig bundle create`, `inspect`, `install`, and `rig up` accept a public HTTPS GitHub folder link:

```sh
rig bundle create https://github.com/example/teams/tree/main/rigs/team -o team.rigbundle
rig bundle inspect https://github.com/example/teams/tree/v1/rigs/team --json
rig up https://github.com/example/teams/tree/COMMIT/rigs/team --target ./project
```

Replace `COMMIT` with a full commit ID. Branches and tags are also accepted, including names containing `/`: they
resolve once to a full commit before fetching. Each result names the resolved source, configuration ID, package digest
and assembler. Save the printed commit-pinned URL to repeat the same source selection. Only a full 40-character commit
ID counts as a commit; a shorter one is looked up as a branch or tag name. `--preset` and repeatable
`--seat pod.member=runtime` select only configurations the folder declares. A link build takes the rig's `name` from
its `rig.yaml` unless `--name` says otherwise, and is named `github-bundle` when `rig.yaml` has no readable name.

Link import needs a running, verified local daemon and a credential-free, publicly readable GitHub URL. It does not
upload files to remote daemons. For a remote target, run the link command on that host, or create an archive, transfer
it with its sibling digest, and use the existing path command there. Existing local path/name commands keep their
dispatch. Importing does not install dependencies or execute repository scripts. Before packaging a link, it checks
the checkout's symlinks (excluding Git metadata), member agent refs, agent imports and legacy package refs (including
additional `--include-packages` entries): every target must resolve inside the fetched checkout. Shared agents and
legacy packages outside the selected folder are allowed within that repository. Preset staging
preserves that directory layout. Unresolved or escaping references stop the import and remove its temporary source.

The selected source is packaged through the existing bundler once. Link `up`/`install` then use the existing bundle
install path, including compatibility and target-conflict checks. For a link, the default install target is the current
directory; `--cwd` separately overrides seat working directories. Imported archives and source/build receipts remain
under the selected OpenRig home's `bundle-imports/` directory for install history. If a response is lost, inputs stay
available and the outcome is reported as unknown; inspect `rig ps` and `rig bundle history` before retrying.

An author's root `bundle.yaml` can declare `compatibility.min_cli_version` and `compatibility.min_daemon_version`.
Link import passes these into create; explicit create minimum-version flags override them. A local-path create doesn't
read them: it packages a minimum only from `--min-cli-version` or `--min-daemon-version`.

The package digest covers the packaged `integrity.files` entries, excluding `bundle.yaml`, ignored junk basenames,
and file modes. It does not cover resources resolved on the installing host or prove what ran. The archive hash is
separate. See [bundle formats](bundle-formats.md) for the exact coverage and identity definitions. Older archives can
have unknown source, configuration or assembler; inspection does not fill those gaps with the inspecting daemon's
identity.

## Advisory author check

```sh
rig bundle check ./my-team --json
```

This local, read-only check reports `openrig.bundle-standard/v1` with `pass`, `finding` or `not_checked` per rule. It
checks pod-aware rig validity, README inclusion in `docs`, readable declared files, in-folder agent refs/imports,
minimum-version shape, declared preset consistency and known sensitive filenames. It does not contact a daemon,
build an archive, run preflight or launch anything. Findings give exit status 1; they are never an install gate. It
reads the folder on disk, not a link or a commit, so files that aren't committed are checked too. Human output gives
each rule's status, ID and reason, then the file it's about in parentheses when there is one; `--json` carries the
same as a `path` field.

README completeness and arbitrary embedded secrets need human review and are reported as `not_checked`. A bounded
or unreadable scan is also `not_checked`, never a clean scan. The check is advice for authors, not a security audit or
listing approval.

---

## Archive Format

A `.rigbundle` file is a gzip-compressed tar archive (`.tar.gz`) with a fixed structure.

### File extension

The archive MUST have the `.rigbundle` extension. The packer rejects output paths that don't end with `.rigbundle`.

### Sibling digest file

Every `.rigbundle` has a sibling `.rigbundle.sha256` file containing the SHA-256 hex digest of the archive. This detects corruption during transfer. The unpacker verifies this digest before extraction.

Example:
```
my-rig.rigbundle          — the archive
my-rig.rigbundle.sha256   — "a1b2c3d4..." (64-char hex SHA-256)
```

### Determinism

The packer produces deterministic output:
- Files are sorted alphabetically
- A fixed mtime is used (`2026-01-01T00:00:00Z`)
- Portable mode normalizes uid/gid/mode
- Maximum gzip compression (level 9)

Identical staged bytes (including manifest timestamps and provenance) produce the same archive hash. Use the package digest to compare packaged file content independently of manifest metadata.

---

## Archive Layout

```
bundle.yaml                    — manifest (required)
rig.yaml                       — the RigSpec (required, may be rewritten)
CULTURE.md                     — culture file (if declared in rig spec)
SETUP.md                       — documentation (if declared in rig spec docs field)
agents/
  agent-name/
    agent.yaml                 — AgentSpec
    guidance/
      role.md                  — guidance files
    skills/
      skill-name/
        SKILL.md               — skill files
    startup/
      context.md               — startup files
context-packs/<name>/          — a pack carried with --context-pack (its manifest.yaml and declared files)
project/                       — the project carried with --project-dir (project.yaml and files beside it)
skills/<name>/                 — a shared skill the author's bundle.yaml declares; other declared
                                 plugins, workflow specs, context packs and agent images keep their paths
```

### Key rules

- `bundle.yaml` is the manifest — always present, always at the root
- `rig.yaml` is the rig spec — rewritten during assembly with vendored `agent_ref` paths
- Agent directories are vendored copies of the original agent specs with all their resources
- Import refs are rewritten from the original `local:` or `path:` paths to bundle-relative `local:` paths
- All file paths within the archive are safe relative paths (no `..`, no absolute, no symlinks)

---

## Manifest (`bundle.yaml`)

The manifest is a YAML file at the archive root that describes the bundle contents.

### Schema Version 2 (pod-aware, current)

```yaml
schema_version: 2
name: my-bundle
version: "0.1.0"
created_at: "2026-04-11T22:32:48.570Z"
rig_spec: rig.yaml
agents:
  - name: pm-lead
    version: "1.0"
    path: agents/pm-lead
    original_ref: "local:agents/pm-lead"
    hash: "ed4cff20..."
    import_entries: []
  - name: researcher
    version: "1.0"
    path: agents/researcher
    original_ref: "local:agents/researcher"
    hash: "11f8a077..."
    import_entries:
      - name: shared
        version: "1.0"
        path: agents/shared
        original_ref: "local:../../shared"
        hash: "abc123..."
culture_file: CULTURE.md
provenance:
  created_at: "2026-04-11T22:32:48.570Z"
  daemon_version: "0.6.6"
  cli_version: "0.6.6"
  # ... and, for a GitHub link, the source it was built from
assembler:
  openrigVersion: "0.6.6"
configuration:
  id: "dev.lead=claude-code,dev.researcher=codex"
integrity:
  algorithm: sha256
  files:
    rig.yaml: "b80c0674..."
    CULTURE.md: "9354361b..."
    agents/pm-lead/agent.yaml: "ed4cff20..."
    # ... every file in the archive
```

### Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema_version` | number | yes | Must be `2` for pod-aware bundles. |
| `name` | string | yes | Bundle name. |
| `version` | string | yes | Bundle version. |
| `created_at` | string | yes | ISO-8601 timestamp of creation. |
| `rig_spec` | string | yes | Relative path to the rig spec within the archive. Safe relative path. |
| `agents` | AgentEntry[] | yes | Array of vendored agent entries. |
| `culture_file` | string | no | Relative path to the culture file if present. |
| `integrity` | Integrity | no | Per-file SHA-256 checksums for content verification. Validation doesn't require it, but install refuses an archive without it and inspect reports integrity FAIL. |
| `provenance` | object | no | Stated, not verified: `created_at`, `daemon_version`, `cli_version`, `source_host`, `author_session`, `source_rig_id`, `source_rig_name`, `notes`, and `source` for a GitHub link build. |
| `assembler` | object | no | `openrigVersion` of the OpenRig that built the archive. |
| `configuration` | object | no | The configuration ID the archive was built in, and `preset` when it matches a declared preset. Outside the package digest. |
| `compatibility` | object | no | `min_cli_version` and `min_daemon_version`, checked on install. |
| `preconditions` | list | no | The author's setup declarations, shown before install and never run (see [bundle formats](bundle-formats.md#declared-setup-preconditions)). |
| `skills`, `plugins`, `workflow_specs`, `context_packs`, `agent_images` | lists | no | Contents from the author's `bundle.yaml` and `--context-pack`, routed into your libraries on install. |
| `project` | object | no | `id` and `path` of the project carried with `--project-dir`. |

### Agent Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent name (from agent.yaml). |
| `version` | string | no | Agent version. |
| `path` | string | yes | Relative path to the vendored agent directory. Safe relative path. |
| `original_ref` | string | written by create | The original `agent_ref` before rewriting. Validation doesn't require it. |
| `hash` | string | yes | SHA-256 hash of the agent.yaml content. |
| `import_entries` | ImportEntry[] | written by create | Vendored imports for this agent (may be empty). Validation doesn't require it. |

### Import Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Imported agent name. |
| `version` | string | yes | Imported agent version. |
| `path` | string | yes | Relative path to the vendored import within the archive. |
| `original_ref` | string | yes | The original import ref before rewriting. |
| `hash` | string | yes | SHA-256 hash of the imported agent.yaml. |

### Integrity Section

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `algorithm` | string | yes | Must be `sha256`. |
| `files` | map<string, string> | yes | Map of archive-relative file path → SHA-256 hex hash. Every file in the archive except `bundle.yaml`, `.DS_Store`, `Thumbs.db` and `.gitkeep` is listed; an extra file that isn't listed fails verification. |

---

## Security Model

Bundle integrity provides **self-consistency verification, not authenticity**.

- The sibling `.sha256` file detects corruption during transfer
- The per-file integrity hashes detect tampering of individual files within the archive
- Neither mechanism authenticates the bundle author

An attacker who can rewrite the full bundle + digest can bypass verification. Users must trust the source they obtained the bundle from. This is the same trust model as unsigned npm packages and Docker images.

Future enhancement: cryptographic signing (Ed25519) for author authentication.

---

## Safety Guarantees

The unpacker enforces these safety rules before extraction:

1. **No symlinks or hardlinks** — `SymbolicLink` and `Link` entries are rejected
2. **No absolute paths** — entries starting with `/`, or carrying a Windows drive letter such as `C:\`, are rejected
3. **No path traversal** — entries containing `..` segments are rejected, on either slash direction (`..` or `..\`)
4. **Digest verification** — archive SHA-256 must match the sibling `.sha256` file
5. **Content integrity** — after extraction, per-file hashes are verified against the manifest

If any check fails, extraction is aborted and an error is thrown.

`rig bundle inspect` applies the same unsafe-entry scan (rules 1-3) before it extracts into its temporary directory, so an archive the installer refuses for an unsafe entry is never reported as inspectable. Digest and content-integrity failures are a different case: inspect reports those in its result (`digestValid`, `integrityResult`) instead of refusing, which is what lets it describe a broken bundle rather than throw.

---

## CLI Surface

### Paths

`rig bundle create`, `inspect` and `install` resolve every path you give them (`<spec-path>`, `-o`, `--rig-root`,
`<bundle-path>`, `--target`) to an absolute path against **your** current directory before sending the request. The
daemon then reads and writes those paths on **its own host**: nothing is uploaded, so the files must already exist
where the daemon runs.

### Create a bundle

```bash
rig bundle create <spec-path-or-github-link> -o <output.rigbundle> [--rig-root <dir>] [--preset <name>] [--seat <pod.member=runtime>]... [--context-pack <dir>]... [--project-dir <dir>] [--name <name>] [--bundle-version <ver>] [--min-cli-version <ver>] [--min-daemon-version <ver>] [--notes <text>] [--include-packages <refs...>] [--allow-drift] [--json]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<spec-path-or-github-link>` | yes | — | Path to the rig spec YAML file, or a GitHub folder link (see "GitHub folder links" above). |
| `-o, --output` | yes | — | Output path. Must end with `.rigbundle`. |
| `--rig-root` | no | spec directory | Root directory for resolving `agent_ref` and other relative paths. |
| `--preset <name>` | no | — | Build one of the configurations the bundle declares in `configurations.yaml` beside `rig.yaml` (see [bundle-formats.md](bundle-formats.md)). The chosen runtimes and profiles are applied to an owned copy of the rig folder, never to yours. |
| `--seat <pod.member=runtime>` | no | — | Use this runtime for one seat, within what `configurations.yaml` allows. Repeatable; applied after `--preset`. An undeclared choice is refused with the allowed set, and nothing is built. |
| `--context-pack <dir>` | no | — | Carry the context pack in `<dir>`. Repeatable. The directory may be outside the rig folder, for example a world pack whose `manifest.yaml` is at its repository root. Only `manifest.yaml` and the files it declares are carried, the same set `rig context add --git` installs, and the pack lands in the bundle at `context-packs/<manifest name>/`. Needs a pod-aware spec. |
| `--project-dir <dir>` | no | — | Carry the project the rig works in: the folder holding its `project.yaml` (which must declare an `id`) and files beside it, such as `SPEC.md`. On install the project is registered in the workspace catalog and the rig is associated with it, before any seat launches (see [project-workspace.md](project-workspace.md)). Needs a pod-aware spec. |
| `--name` | no | the rig's `name` in `rig.yaml`; `my-bundle` (`github-bundle` for a link) when it has no readable name | Bundle name in the manifest. |
| `--bundle-version` | no | `0.1.0` | Bundle version in the manifest. |
| `--min-cli-version`, `--min-daemon-version` | no | — | The oldest OpenRig CLI or daemon that may install the bundle, checked on install. For a link they override the author's `bundle.yaml` minimums. |
| `--notes <text>` | no | — | Notes stored in the manifest's provenance. |
| `--include-packages <refs...>` | no | all from the spec | Legacy (schema 1) specs only: the package refs to include. |
| `--allow-drift` | no | off | Build a spec that differs from the running rig of the same name. Without it, create refuses; with it, the difference is written into the manifest's provenance notes. |
| `--json` | no | off | Machine-readable output. |

`--context-pack` and `--project-dir` exist only on create. `rig up` and `rig bundle install` have neither, so a bundle
installed straight from a GitHub link carries no project, and carries a context pack only when the folder's own
`bundle.yaml` declares one inside the folder.

The create command:
1. Validates the rig spec, and refuses a spec that differs from the running rig of the same name (see `--allow-drift`)
2. Collects the culture file, docs files, and rig-, pod- and member-level startup files
3. Resolves all `agent_ref` paths and their imports, vendors the agent specs and their resources, and rewrites the refs to bundle-relative `local:` paths
4. Adds the author's `bundle.yaml` contents (preconditions, skills, plugins, workflow specs, context packs, agent images), the carried packs and project, and the configuration and assembler stamps
5. Computes per-file integrity hashes, refusing sensitive paths (such as `.env`, `*.pem`, `*.key`, `*.p12`, `credentials.*` and `tokens.*`), and writes the manifest (`bundle.yaml`)
6. Refuses staged content that can't be shipped publicly
7. Packs into a deterministic `.tar.gz` and writes the sibling `.sha256` digest

### List a bundle's configurations

```bash
rig bundle configurations <spec-path> [--json]
```

Lists the presets that `configurations.yaml` declares, each with its configuration ID, which one is recommended, and which one matches `rig.yaml` as written.

### Inspect a bundle

```bash
rig bundle inspect <bundle-path-or-github-link> [--preset <name>] [--seat <pod.member=runtime>]... [--json]
```

Shows the manifest, the archive's identity (source and commit for a link, configuration, package SHA-256 and its
coverage, assembler, archive SHA-256), digest validity, the integrity result, any carried context packs and project,
and then the behaviour view. Inspect extracts the archive into a temporary directory for safe validation, then cleans
that directory up. It does not install or launch anything. It exits 2 when the digest or integrity check fails.
`--preset` and `--seat` choose a declared configuration of a GitHub link.

The behaviour view describes the selected archive: its team and configured models, declared permission posture,
files agents receive, startup actions and hooks, managed writes, literal outside domains, prerequisites and what
remains unknown until launch. It reads packaged declarations; it does not run scripts, contact providers, probe
runtimes or create a bootstrap run. Source and assembler identity come from the archive, separately from the view
generator. Configured models are not observations of a running model, and literal domains are not predicted traffic.

Under "Needs (not checked)" the view lists the author's setup preconditions, with their commands marked "not run; one
shell, in order". For a declared full-bypass Claude seat it notes that Claude Code asks once to accept its bypass
warning, and when any Claude or Codex seat is full bypass it says that `--non-interruptive` is available (see
[non-interruptive mode](non-interruptive-mode.md)). It doesn't select the mode or check whether you've already
accepted the warning. When the bundle's `rig.yaml` declares `non_interruptive: true`, the view instead says that the
bundle declares non-interruptive launches for those seats, with broad file, command and network access, and that
`--no-non-interruptive` overrides it; the asks-once note is left out.

`rig bundle install` and bundle-form `rig up` print this same view to stderr before the existing action, including
`--plan`. With `--json`, stdout remains one result; its optional `behaviour` field carries the structured view.
GitHub links reuse the single prepared archive. The header is informational: missing views and inspection errors
print a diagnostic, then the original installation checks and result determine success. Legacy schema-1 archives
report `not_generated`, rather than an empty team. A local archive can change between inspection and installation;
the header does not bind a later action atomically to those bytes.

Agents can run shell commands as the launching user, subject to runtime and host policy. Explicit permission bypass
is distinguished from conditional launch floors; Pi resource trust is separate from native permission policy.
Host settings, accounts, plugins, runtime support and effective permissions remain unknown. Text scanning is bounded
and reports unread members; dynamically computed commands and addresses cannot be predicted. Installation targets,
`--cwd` and configured library roots resolve separately from the archive's declarations. See
[bundle formats](bundle-formats.md) for the structured view and digest coverage.

**Integrity means the archive is self-consistent, not who made it. Provenance is stated by the bundle and not verified.**


### Install a bundle

```bash
rig bundle install <bundle-path-or-github-link> [--plan] [--yes] [--target <root>] [--cwd <dir>] [--preset <name>] [--seat <pod.member=runtime>]... [--non-interruptive | --no-non-interruptive] [--skip-version-check] [--force] [--json]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<bundle-path-or-github-link>` | yes | — | Path to the `.rigbundle` file, or a GitHub folder link. |
| `--plan` | no | `false` | Preview without installing or launching. Not side-effect free: it records a bootstrap run and runs the preflight, which for a pod-aware bundle runs `pi --version` or `omp --version` for Pi or OMP seats and `codex -p <profile> mcp list` for a Codex seat that names a `codex_config_profile`. It writes nothing to the target. |
| `--yes` | no | `false` | Auto-approve trusted actions during apply mode. |
| `--target <root>` | yes in apply mode, for an archive path | the current directory for a link | Directory the bundle is installed into and launched from. Required for an archive path unless `--plan` is used. |
| `--cwd <dir>` | no | — | Working directory for every launched member, for this install only (for example, the repository the rig works on). Does not change the install target. |
| `--preset <name>`, `--seat <pod.member=runtime>` | no | — | For a GitHub link, the declared configuration to build and install. |
| `--non-interruptive` | no | the bundle `rig.yaml`'s `non_interruptive`, else the operator setting `launch.non_interruptive`, else off | Accept the harnesses' first-launch warnings for this rig's full-bypass Claude and Codex seats with launch flags, writing nothing to your settings. The choice is saved on the rig. `--no-non-interruptive` turns a saved choice off; stop a running rig with `rig down` first. See [non-interruptive mode](non-interruptive-mode.md). |
| `--skip-version-check` | no | off | Skip the compatibility check below. Not for routine use. |
| `--force` | no | off | Skip the running-team check below. Not for routine use. A pod-aware bundle is still refused before target files are written when a team with the same name is running; a legacy (schema 1) bundle can be left partly installed. |
| `--json` | no | `false` | Emit machine-readable JSON. |

Install **launches the rig**; it does not just unpack it. It extracts the bundle to a temporary directory, validates integrity, and bootstraps the rig. In apply mode, the daemon requires `targetRoot`, so `rig bundle install` must be given `--target <root>` for an archive path unless you are running with `--plan`.

Before it plans or applies, install runs two checks on the archive, both also under `--plan`:
- **compatibility:** the manifest's `min_daemon_version` and `min_cli_version` against this daemon and CLI. A failure
  reports "Bundle compatibility check failed" with the versions involved.
- **running team:** a running team with the bundle's rig name refuses the install with "Bundle install conflict check
  failed". The error names the installed and the offered team and lists three choices: use the existing team, stop it
  with `rig down` and retry to replace it, or cancel. This check does not refuse a stopped team with that name.

Each error lists its fixes; the compatibility error also names `--skip-version-check`.

For a pod-aware (schema version 2) bundle, installing a team whose rig name matches a stopped team replaces it: the
earlier team is archived when the new one is created, and the result gives the `rig unarchive <id>` command that
restores it. If OpenRig cannot confirm the earlier team is stopped, install refuses with `generation_unconfirmed` and
creates no replacement team. For an install into that team's own install folder, OpenRig makes this check before
writing any files; for any other target, bundle files already copied there stay.

A legacy (schema version 1) bundle does not replace a stopped team. Its approved external and package install steps run
first, and then its rig-name check fails preflight with "Rig name '<name>' already exists".

For a pod-aware (schema version 2) bundle, apply copies every extracted file (`bundle.yaml`, `rig.yaml`, `agents/`, culture and docs files, and any carried `project/`, `context-packs/` and author-declared contents) into the target and launches from there, then removes the temporary extraction. So:

- the target becomes the rig root: `agent_ref` paths resolve inside it, and a member with `cwd: "."` starts in the target (every pod-aware member must declare a `cwd`);
- an absolute member `cwd` stays as authored, and `--cwd <dir>` (on `rig bundle install` or `rig up`) still overrides every member's cwd;
- if the target already has a file with **different** content at any bundle path (for example its own `rig.yaml`), install refuses with `target_conflict` and writes nothing. Identical target files don't cause a target-content conflict; the other installation checks above, including the running-team check, still apply. Use an empty or dedicated directory as the target.
- exception: reinstalling over a stopped team into that team's own install folder (the target's `bundle.yaml` is schema version 2 with the same bundle name, or with `my-bundle` or `github-bundle`, the default names before 0.6.7) replaces its files there. Each differing path is first copied under `<OpenRig home>/bundle-backups/reinstall-*/files/`, with a `RESTORE.json` beside it; other files in the folder are kept. The files stay installed even if a later launch fails.

The bundle's declared skills, plugins, workflow specs, context packs and agent images are routed into your libraries **before any member launches**, and the context-pack library is rescanned, so a member's first turn can already read a pack the bundle carried. A routing failure does not stop the install: it is printed as a warning, returned in `routingFailures`, and recorded in the install audit. The human output lists what each declared kind routed and any entry that was not routed.

A carried pack is routed into `context.root` under its folder name in the archive: for a pack carried with `--context-pack`, that is its manifest name (`context-packs/<name>/`); for a pack the author's `bundle.yaml` declares, it is the basename of the declared folder, whatever the manifest says. If a pack of that name is already installed, install never merges into it: an identical pack is reported as `already_installed`, and a different one (for example a `rig context add --git` install at another revision) is kept unchanged and reported as `kept_existing`, with the `rig context rm <name>` command to use the bundle's copy instead.

A carried project is registered as `registered` (a new catalog entry), `associated` (the rig added to an existing entry), `already_registered` or `conflict`. A conflict writes nothing to the catalog and is reported as a routing failure; the install continues. A project folder that already exists with different files is kept unchanged.

### Skills shared by bundle profiles

For skills shared by several agents, place each complete skill directory at
`skills/<name>/` beside the rig spec and declare its entry point in the source
`bundle.yaml`:

```yaml
skills:
  - skills/review-work/SKILL.md
```

`rig bundle create` includes that directory's helper scripts and references as
well as `SKILL.md`. The skill needs valid `name` and `description` frontmatter;
the name is the ID a profile selects with `uses.skills: [review-work]`.
Undeclared sibling directories are not bundled. Other declared skill file paths
retain their single-file behavior.

Claude, Codex and Pi profiles can select this installed bundle pool even when
their working directory is elsewhere. Explicit AgentSpec resources keep priority
over a discovered skill with the same ID. Pi projects selected skills into its
seat's agent directory; it does not scan Claude or Codex home/workspace pools.
Installing the bundle does not add these skills to the operator's managed
`skills.root` catalog. Profiles that already get a skill from a plugin should not
also select its bundle copy.

When a profile selects a skill from inside its agent spec's folder (for example the
installed bundle) and the managed catalog holds a different copy with the same ID,
the bundle's copy is used. Launch warns `skill_bundle_precedence` and leaves the
catalog unchanged. The skill's `SKILL.md` `name` must equal the selected ID. A
differing copy from anywhere else fails launch with `skill_identity_conflict`.

Legacy (schema version 1) bundles keep their old behavior: `--target` is only where packages are installed, and their declared contents are routed after a completed install.

### Launch directly

```bash
rig up <bundle-path-or-github-link> [--target <root>] [--cwd <dir>] [--plan] [--yes] [--preset <name>] [--seat <pod.member=runtime>]... [--non-interruptive | --no-non-interruptive] [--host <id>] [--json]
```

`rig up` auto-detects `.rigbundle` files and GitHub folder links and prints the behaviour view before it acts. The two
take different routes:
- **A GitHub link** builds the archive and installs it through the `rig bundle install` path, with its compatibility
  and rig-name checks and the install audit.
- **A local `.rigbundle` path** goes through the bundle bootstrap path directly. It skips the compatibility check,
  isn't recorded in the install audit (so `rig bundle history` doesn't list it), and doesn't print the routing summary.
  For a pod-aware archive, a running team with the same name is still refused before target files are written, and a
  stopped one is replaced as described under "Install a bundle". A legacy (schema 1) archive runs its approved install
  steps before its rig-name check, which then refuses a running team and fails preflight for a stopped one; it also
  gets no post-install routing this way. To get the checks and the audit for a local archive, use `rig bundle install`
  or `rig bootstrap`.

`rig bootstrap <bundle-path>` also accepts archives and uses the ordinary bundle
install path, including compatibility checks and the install audit. Use `--plan`
to preview, or `--target <root>` to choose the persistent install directory. Its
default target is the caller's current directory; `--cwd` only changes the agents'
working directory. YAML files and library spec names keep the spec bootstrap path.
It prints no behaviour view and has no `--non-interruptive` option; a bundle's declared `non_interruptive` still applies.

- `--target <root>` is the install target described above (for a schema-version-2 bundle, the directory the bundle is copied into and launched from)
- if `--target` is omitted for a `.rigbundle` or a link, the CLI defaults the install target to the current working directory, so the bundle's files are written there
- `rig up` resolves a relative `--target` against your current directory before sending it, like `rig bundle install`; with `--host`, `--target` is sent as given and must be a path that exists on that host, and an omitted `--target` is refused there ("targetRoot is required for bundle apply mode"). GitHub links don't work with `--host`.
- `--cwd <dir>` does **not** change the install target; it only overrides the launched members' working directory for that run
- `--non-interruptive` works as on `rig bundle install`
- a schema-version-2 bundle's declared contents are routed before any member launches, as with `rig bundle install`

### Install history

```bash
rig bundle history [--rig <name>] [--since <iso>] [--json]
```

Lists the install audit records in `bundle-audit.jsonl` in the OpenRig home (default `~/.openrig`): when, the outcome,
the rig and the bundle path.
`--rig` filters by target rig name and `--since` by install time. Installs through `rig bundle install`,
`rig bootstrap <archive>` and `rig up <link>` are recorded; `rig up <local archive>` isn't.

---

## Assembly Process

When `rig bundle create` runs, the `PodBundleAssembler` stages the files (steps 1-4). The create route then adds the
author's `bundle.yaml` contents, the carried packs and project, and the configuration and assembler stamps, and does
steps 5-7:

1. **Parse and validate** the rig spec
2. **Collect rig-level files:**
   - Culture file (if `culture_file` is set)
   - Docs files (if `docs` array is set) — **required: missing docs fail assembly**
   - Rig-level startup files
   - Pod-level and member-level startup files
3. **For each member's `agent_ref`:**
   - Resolve the ref to an agent spec directory
   - Copy the agent spec and all its resources (skills, guidance, hooks, startup, runtime resources)
   - Recursively resolve and copy imports
   - Record the agent entry in the manifest with its hash
   - Rewrite the ref to a bundle-relative `local:` path
4. **Write the rewritten rig spec** to the staging directory
5. **Compute integrity** — SHA-256 of every file in the staging directory
6. **Write the manifest** (`bundle.yaml`) with all entries and integrity
7. **Pack** the staging directory into a deterministic tar.gz

### Terminal nodes

Members with `agent_ref: "builtin:terminal"` are bundle-native sentinels. They are not vendored — the runtime handles them directly.

### Deduplication

If multiple members reference the same agent spec (same resolved path), the spec is vendored once and all members' refs are rewritten to the same bundle-relative path.

### Import resolution

When an agent spec has `imports`, each import is resolved, vendored into the bundle, and the import refs in the vendored agent.yaml are rewritten to bundle-relative `local:` paths. Import entries are recorded in the manifest's agent entry.

---

## Validation Rules Summary

### Manifest validation (schema version 2)

1. `schema_version` must be `2`
2. `name` is required non-empty string
3. `version` is required non-empty string
4. `created_at` is required non-empty string
5. `rig_spec` is required and must be a safe relative path
6. `agents` must be an array
7. Each agent must have `name`, `path` (safe relative), and `hash`
8. Optional blocks, when present, must be well formed: `provenance`, `compatibility`, `skills`, `plugins`,
   `workflow_specs`, `context_packs`, `agent_images`, and `project` (an `id` made of letters, digits, `.`, `_` and `-`,
   and a safe relative `path`)

The manifest validator doesn't check `integrity`; unpack does (below).

### Archive safety (enforced on unpack)

1. No symlinks or hardlinks
2. No absolute paths
3. No `..` path traversal
4. Archive digest must match sibling `.sha256`
5. The manifest must have an integrity section, and per-file content hashes must match it

### Assembly validation

1. Rig spec must validate
2. All `agent_ref` paths must resolve to valid agent specs
3. All declared `docs` files must exist on disk (missing docs fail assembly)
4. Culture file and startup files are collected best-effort (missing = skipped)
5. A declared skill that's missing or unreadable is a warning, written into the manifest's provenance notes; it
   doesn't stop the build
6. Sensitive paths ("Sensitive paths detected in bundle") and content that can't be shipped publicly ("Public artifact
   substance refusal") stop the build

---

## Legacy Bundles (Schema Version 1)

Schema version 1 bundles are the pre-reboot format using flat-node rig specs and package-based bundling. They are still supported for backward compatibility but should not be created for new rigs.

Key differences from v2:
- `schema_version: 1` in the manifest
- `packages` array instead of `agents` array
- Package entries have `original_source` instead of `original_ref`
- No `import_entries` in package entries
- Legacy rig spec format (flat nodes, not pods)

The v1 validator checks a `project` block the same way as v2, so a v1 bundle can't write outside the projects root or
read outside the bundle.

---

## Example: Creating and Using a Bundle

### Create

```bash
# From the rig directory
rig bundle create rig.yaml -o my-team.rigbundle --rig-root . --name my-team --bundle-version 1.0.0
```

Output:
```
Bundle created: my-team.rigbundle
  Name: my-team v1.0.0
  Hash: a1b2c3d4e5f6...
```

### Inspect

```bash
rig bundle inspect my-team.rigbundle
```

The manifest summary and identity lines are followed by the behaviour view:
```
Bundle: my-team v1.0.0
Configuration: dev.lead=claude-code,dev.researcher=codex
Package SHA-256: 3f9a...
Coverage: openrig.package-digest/v1; packaged files only; excludes bundle.yaml, ignored junk and file modes; not host-resolved resources or execution.
Assembler: OpenRig 0.6.6
Archive SHA-256: a1b2c3d4...
Digest valid: true
Integrity: PASS
What this bundle declares before installation:
...
```

### Install and launch

```bash
cd ~/projects/my-project
rig up /path/to/my-team.rigbundle
```

Equivalent explicit form:

```bash
rig up /path/to/my-team.rigbundle --target ~/projects/my-project
```

The bundle is extracted to a temporary directory and its integrity is verified. A schema-version-2 bundle is then copied into the target root and the rig is launched from there, with all agents and resources from the bundle. If you also want agents to launch with a different working directory for that run, pass `--cwd <dir>` separately.

A running team must be stopped before reinstalling. Reinstalling into a stopped team's recorded install folder preserves conflicting files in the instance's `bundle-backups` directory; the result names the backup. The folder must still contain that bundle's installed manifest. A copied same-name manifest in another folder does not authorize replacing its conflicting files. Other targets retain first-install behavior: different files at the same paths are refused before writing. New installations record the canonical target folder for each generation, independently of `--cwd`. Older generations and new generations created directly from `rig.yaml` have no recorded folder and retain the manifest-only check until their next successful bundle installation, so a copied same-name manifest can still qualify for those generations.
