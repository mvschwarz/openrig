# RigBundle Reference

Version: 2 (pod-aware)
Last validated against code: 2026-10-04 (GitHub source input, author check and identity fields; install paths and `--target` checked 2026-09-29; other sections last checked 2026-04-11)
Source of truth: `packages/daemon/src/domain/bundle-types.ts`, `packages/daemon/src/domain/bundle-archive.ts`, `packages/daemon/src/domain/pod-bundle-assembler.ts`

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
and assembler. Save the printed commit-pinned URL to repeat the same source selection. `--preset` and repeatable
`--seat pod.member=runtime` select only configurations the folder declares.

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
Link import passes these into create; explicit create minimum-version flags override them. No implicit minimum is
added to existing local-path builds.

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
build an archive, run preflight or launch anything. Findings give exit status 1; they are never an install gate.

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
| `integrity` | Integrity | no | Per-file SHA-256 checksums for content verification. |

### Agent Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent name (from agent.yaml). |
| `version` | string | no | Agent version. |
| `path` | string | yes | Relative path to the vendored agent directory. Safe relative path. |
| `original_ref` | string | yes | The original `agent_ref` before rewriting. |
| `hash` | string | yes | SHA-256 hash of the agent.yaml content. |
| `import_entries` | ImportEntry[] | yes | Vendored imports for this agent (may be empty). |

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
| `files` | map<string, string> | yes | Map of archive-relative file path → SHA-256 hex hash. Every file in the archive (except `bundle.yaml` itself) should be listed. |

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
rig bundle create <spec-path> -o <output.rigbundle> [--rig-root <dir>] [--context-pack <dir>]... [--project-dir <dir>] [--name <name>] [--bundle-version <ver>]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<spec-path>` | yes | — | Path to the rig spec YAML file. |
| `-o, --output` | yes | — | Output path. Must end with `.rigbundle`. |
| `--rig-root` | no | spec directory | Root directory for resolving `agent_ref` and other relative paths. |
| `--preset <name>` | no | — | Build one of the configurations the bundle declares in `configurations.yaml` beside `rig.yaml` (see [bundle-formats.md](bundle-formats.md)). The chosen runtimes and profiles are applied to an owned copy of the rig folder, never to yours. |
| `--seat <pod.member=runtime>` | no | — | Use this runtime for one seat, within what `configurations.yaml` allows. Repeatable; applied after `--preset`. An undeclared choice is refused with the allowed set, and nothing is built. |
| `--context-pack <dir>` | no | — | Carry the context pack in `<dir>`. Repeatable. The directory may be outside the rig folder, for example a world pack whose `manifest.yaml` is at its repository root. Only `manifest.yaml` and the files it declares are carried, the same set `rig context add --git` installs, and the pack lands in the bundle at `context-packs/<manifest name>/`. Needs a pod-aware spec. |
| `--project-dir <dir>` | no | — | Carry the project the rig works in: the folder holding its `project.yaml` (which must declare an `id`) and files beside it, such as `SPEC.md`. On install the project is registered in the workspace catalog and the rig is associated with it, before any seat launches (see [project-workspace.md](project-workspace.md)). Needs a pod-aware spec. |
| `--preset <name>` | no | — | Build one of the configurations the bundle declares in `configurations.yaml` beside `rig.yaml` (see [bundle-formats.md](bundle-formats.md)). The chosen runtimes and profiles are applied to an owned copy of the rig folder, never to yours. |
| `--seat <pod.member=runtime>` | no | — | Use this runtime for one seat, within what `configurations.yaml` allows. Repeatable; applied after `--preset`. An undeclared choice is refused with the allowed set, and nothing is built. |
| `--name` | no | `my-bundle` | Bundle name in the manifest. |
| `--bundle-version` | no | `0.1.0` | Bundle version in the manifest. |

The create command:
1. Validates the rig spec
2. Resolves all `agent_ref` paths and their imports
3. Vendors all agent specs, resources, and startup files into a staging directory
4. Rewrites `agent_ref` paths to bundle-relative `local:` refs
5. Collects culture file, docs files, and rig-level startup files
6. Computes per-file integrity hashes
7. Writes the manifest (`bundle.yaml`)
8. Packs into a deterministic `.tar.gz`
9. Writes the sibling `.sha256` digest

### List a bundle's configurations

```bash
rig bundle configurations <spec-path> [--json]
```

Lists the presets that `configurations.yaml` declares, each with its configuration ID, which one is recommended, and which one matches `rig.yaml` as written.
On install, a carried pack is routed into `context.root` under its manifest name. If a pack of that name is already installed, install never merges into it: an identical pack is reported as `already_installed`, and a different one (for example a `rig context add --git` install at another revision) is kept unchanged and reported as `kept_existing`, with the `rig context rm <name>` command to use the bundle's copy instead.

### List a bundle's configurations

```bash
rig bundle configurations <spec-path> [--json]
```

Lists the presets that `configurations.yaml` declares, each with its configuration ID, which one is recommended, and which one matches `rig.yaml` as written.

### Inspect a bundle

```bash
rig bundle inspect <bundle-path> [--json]
```

Shows the manifest, digest validity, and integrity verification result. Inspect extracts the archive into a temporary directory for safe validation, then cleans that directory up. It does not install or launch anything.

### Install a bundle

```bash
rig bundle install <bundle-path> [--plan] [--yes] [--target <root>] [--cwd <dir>] [--json]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<bundle-path>` | yes | — | Path to the `.rigbundle` file. |
| `--plan` | no | `false` | Preview without installing or launching. Not side-effect free: it runs the preflight, which executes the members' runtime `--version` probes, and it records a bootstrap run. It writes nothing to the target. |
| `--yes` | no | `false` | Auto-approve trusted actions during apply mode. |
| `--target <root>` | yes in apply mode | — | Directory the bundle is installed into and launched from. Required unless `--plan` is used. |
| `--cwd <dir>` | no | — | Working directory for every launched member, for this install only (for example, the repository the rig works on). Does not change the install target. |
| `--json` | no | `false` | Emit machine-readable JSON. |

Install **launches the rig**; it does not just unpack it. It extracts the bundle to a temporary directory, validates integrity, and bootstraps the rig. In apply mode, the daemon requires `targetRoot`, so `rig bundle install` must be given `--target <root>` unless you are running with `--plan`.

For a pod-aware (schema version 2) bundle, apply copies the extracted contents (`bundle.yaml`, `rig.yaml`, `agents/`, culture and docs files) into the target and launches from there, then removes the temporary extraction. So:

- the target becomes the rig root: `agent_ref` paths resolve inside it, and a member with `cwd: "."` (or no `cwd`) starts in the target;
- an absolute member `cwd` stays as authored, and `--cwd <dir>` (on `rig bundle install` or `rig up`) still overrides every member's cwd;
- if the target already has a file with **different** content at any bundle path (for example its own `rig.yaml`), install refuses with `target_conflict` and writes nothing. Identical files are accepted, so reinstalling the same bundle into the same target works. Use an empty or dedicated directory as the target.

The bundle's declared skills, plugins, workflow specs, context packs and agent images are routed into your libraries **before any member launches**, and the context-pack library is rescanned, so a member's first turn can already read a pack the bundle carried. A routing failure does not stop the install: it is printed as a warning, returned in `routingFailures`, and recorded in the install audit. The human output lists what each declared kind routed and any entry that was not routed.

Legacy (schema version 1) bundles keep their old behavior: `--target` is only where packages are installed, and their declared contents are routed after a completed install.

### Launch directly

```bash
rig up <bundle-path> [--target <root>] [--cwd <dir>]
```

`rig up` auto-detects `.rigbundle` files and routes them through the bundle bootstrap path.

- `--target <root>` is the install target described above (for a schema-version-2 bundle, the directory the bundle is copied into and launched from)
- if `--target` is omitted for a `.rigbundle`, the CLI defaults the install target to the current working directory, so the bundle's files are written there
- `rig up` resolves a relative `--target` against your current directory before sending it, like `rig bundle install`; with `--host`, `--target` is sent as given and must be a path that exists on that host
- `--cwd <dir>` does **not** change the install target; it only overrides the launched members' working directory for that run
- a schema-version-2 bundle's declared contents are routed before any member launches, as with `rig bundle install`

---

## Assembly Process

When `rig bundle create` runs, the `PodBundleAssembler` performs these steps:

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
8. Integrity `algorithm` must be `sha256`
9. Integrity `files` must be a non-empty map of safe-relative-path → 64-char hex hash

### Archive safety (enforced on unpack)

1. No symlinks or hardlinks
2. No absolute paths
3. No `..` path traversal
4. Archive digest must match sibling `.sha256`
5. Per-file content hashes must match integrity section

### Assembly validation

1. Rig spec must validate
2. All `agent_ref` paths must resolve to valid agent specs
3. All declared `docs` files must exist on disk (missing docs fail assembly)
4. Culture file and startup files are collected best-effort (missing = skipped)

---

## Legacy Bundles (Schema Version 1)

Schema version 1 bundles are the pre-reboot format using flat-node rig specs and package-based bundling. They are still supported for backward compatibility but should not be created for new rigs.

Key differences from v2:
- `schema_version: 1` in the manifest
- `packages` array instead of `agents` array
- Package entries have `original_source` instead of `original_ref`
- No `import_entries` in package entries
- Legacy rig spec format (flat nodes, not pods)

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

Output:
```
Bundle: my-team v1.0.0
Digest valid: true
Integrity: PASS
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

The bundle is extracted to a temporary directory and its integrity is verified. A schema-version-2 bundle is then copied into the target root (refused if the target holds different files at the same paths) and the rig is launched from there, with all agents and resources from the bundle. If you also want agents to launch with a different working directory for that run, pass `--cwd <dir>` separately.
