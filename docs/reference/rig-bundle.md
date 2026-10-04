# RigBundle Reference

Version: 2 (pod-aware)
Last validated against code: 2026-09-29 (install paths and `--target` only; other sections last checked 2026-04-11)
Source of truth: `packages/daemon/src/domain/bundle-types.ts`, `packages/daemon/src/domain/bundle-archive.ts`, `packages/daemon/src/domain/pod-bundle-assembler.ts`

A `.rigbundle` is a self-contained distributable archive that packages a rig spec, all referenced agent specs, their resources (skills, guidance, startup files), culture file, documentation, and an integrity manifest into a single file. The recipient can install and launch the rig without needing the original source tree.

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

This means the same inputs always produce the same archive hash.

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
2. **No absolute paths** — entries starting with `/` are rejected
3. **No path traversal** — entries containing `..` segments are rejected
4. **Digest verification** — archive SHA-256 must match the sibling `.sha256` file
5. **Content integrity** — after extraction, per-file hashes are verified against the manifest

If any check fails, extraction is aborted and an error is thrown.

---

## CLI Surface

### Paths

`rig bundle create`, `inspect` and `install` resolve every path you give them (`<spec-path>`, `-o`, `--rig-root`,
`<bundle-path>`, `--target`) to an absolute path against **your** current directory before sending the request. The
daemon then reads and writes those paths on **its own host**: nothing is uploaded, so the files must already exist
where the daemon runs.

### Create a bundle

```bash
rig bundle create <spec-path> -o <output.rigbundle> [--rig-root <dir>] [--name <name>] [--bundle-version <ver>]
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `<spec-path>` | yes | — | Path to the rig spec YAML file. |
| `-o, --output` | yes | — | Output path. Must end with `.rigbundle`. |
| `--rig-root` | no | spec directory | Root directory for resolving `agent_ref` and other relative paths. |
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
