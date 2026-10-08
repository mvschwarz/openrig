# AgentSpec Reference

Version: 1.0
Last validated against code: 2026-10-07, at the 0.6.6 cut `2620dea8` (whole document at `fcaf1f8e`; changes to its sources and the shipped agent specs since then checked)
Source of truth: `packages/daemon/src/domain/agent-manifest.ts`, `packages/daemon/src/domain/types.ts`, `packages/daemon/src/domain/agent-resolver.ts`, `packages/daemon/src/domain/profile-resolver.ts`, `packages/daemon/src/domain/skill-catalog.ts`

This is the canonical reference for the AgentSpec YAML format (`agent.yaml`). Every field, validation rule, and default documented here was traced from the actual parser and validator code.

---

## Minimal Valid Example

```yaml
name: my-agent
version: "1.0"

profiles:
  default:
    uses:
      skills: []
      guidance: []
      subagents: []
      plugins: []
      runtime_resources: []

resources: {}

startup:
  files: []
  actions: []
```

## Practical Example (implementer agent)

```yaml
name: implementer
version: "1.0"
description: Implementation agent — implements and verifies coherent changes

defaults:
  runtime: claude-code

imports:
  - ref: local:../../shared

profiles:
  default:
    uses:
      skills: [development-team, systematic-debugging, verification-before-completion]
      guidance: []
      subagents: []
      plugins: [shared:openrig-core]
      runtime_resources: [shared:claude-default-settings, shared:claude-default-mcp, shared:codex-default-config, shared:claude-activity-hooks]

resources:
  guidance:
    - id: role
      path: guidance/role.md

startup:
  files:
    - path: guidance/role.md
      delivery_hint: send_text
      required: true
  actions: []
```

## Complete Example (all features)

```yaml
name: vault-specialist
version: "1.0"
description: Vault specialist agent — manages HashiCorp Vault for this managed app

defaults:
  runtime: claude-code
  model: claude-opus-4-6
  effort: high
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: default-compaction
    restore_policy: resume_if_possible

imports:
  - ref: local:../../shared
  - ref: local:../common-tools
    version: "2.0"

profiles:
  default:
    summary: Standard Vault operations profile
    preferences:
      runtime: claude-code
    uses:
      skills: [systematic-debugging, vault-user]
      guidance: []
      subagents: []
      plugins: [shared:openrig-core, vault-tools]
      runtime_resources: [claude-settings]
    startup:
      files:
        - path: guidance/profile-specific.md
          delivery_hint: send_text
      actions: []
    lifecycle:
      restore_policy: resume_if_possible

resources:
  skills:
    - id: vault-user
      path: skills/vault-user
  guidance:
    - id: role
      path: guidance/role.md
  plugins:
    - id: vault-tools
      source:
        kind: local
        path: plugins/vault-tools
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.fragment.json
      runtime: claude-code
      type: claude_settings_fragment

startup:
  files:
    - path: guidance/role.md
      delivery_hint: send_text
      required: true
    - path: startup/context.md
      delivery_hint: send_text
      required: true
    - path: guidance/optional-tips.md
      delivery_hint: guidance_merge
      required: false
      applies_on: [fresh_start]
  actions:
    - type: send_text
      value: "Load vault-user skill and verify Vault health."
      phase: after_ready
      idempotent: true
```

---

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Agent name. Used in spec library identification and validation messages. |
| `version` | string | yes | — | Spec version. Quote it (`"1.0"`): an unquoted number fails as a non-string. An importing spec that pins `imports[].version` must match it exactly. |
| `description` | string | no | — | Human-readable description. Shown in spec library and review surfaces. |
| `defaults` | Defaults | no | — | Default runtime, model, and lifecycle settings. Applied when not overridden by the rig spec or profile. |
| `imports` | Import[] | no | `[]` | Other AgentSpecs to import. Resources from imported specs become available for profile `uses` references. |
| `profiles` | map<string, Profile> | no | `{}` | Named profiles. Each profile selects resources and can override startup/lifecycle. The rig spec member's `profile` field selects which profile to use. |
| `resources` | Resources | no | all empty | Declared resources (skills, guidance, subagents, plugins, runtime resources). These are the available pool that profiles select from via `uses`. |
| `startup` | StartupBlock | no | `{ files: [], actions: [] }` | Agent-level startup files and actions. Applied to all profiles via the startup layering model. |

---

## Defaults

```yaml
defaults:
  runtime: claude-code
  model: claude-opus-4-6
  effort: high
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: default-compaction
    restore_policy: resume_if_possible
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `runtime` | string | no | — | Default runtime for this agent. Precedence: the rig spec member's `runtime`, then the profile's `preferences.runtime`, then this, then `claude-code`. |
| `model` | string | no | — | Default model, with the same precedence. |
| `effort` | string | no | — | Default reasoning effort, with the same precedence. Claude gets `--effort`, Codex `-c model_reasoning_effort=…`. A blank or non-string value is ignored with an advisory. |
| `lifecycle` | Lifecycle | no | see below | Lifecycle behavior defaults. |

### Lifecycle Defaults

| Field | Type | Default | Allowed Values |
|-------|------|---------|----------------|
| `execution_mode` | string | `interactive_resident` | `interactive_resident` (only value in v1; `wake_on_demand` is explicitly rejected) |
| `compaction_strategy` | string | `default-compaction` | `default-compaction`, `managed-compaction`, `handover`, `apprentice-handover`; deprecated aliases accepted with a validation advisory: `harness_native` → `default-compaction`, `pod_continuity` → `handover` (`custom_prompt` is explicitly rejected in v1) |
| `restore_policy` | string | `resume_if_possible` | `resume_if_possible`, `relaunch_fresh`, `checkpoint_only` |
| `mechanic` | string | — | A canonical `seat@rig` session address; needed by `apprentice-handover` |

---

## Imports

```yaml
imports:
  - ref: local:../../shared
  - ref: local:../common-tools
    version: "2.0"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ref` | string | yes | Reference to another AgentSpec directory. Must start with `local:` (relative) or `path:` (absolute). The referenced directory must contain an `agent.yaml`. |
| `version` | string | no | Optional version constraint. Must be an exact version — no ranges (`~`, `^`, `>=`, etc.). When set, the imported spec's `version` must equal it, or resolution fails with `version_mismatch`. |

### Import Resolution

- `local:` paths resolve relative to the importing spec's directory
- `path:` paths are absolute filesystem paths
- Imported resources become available for `uses` references in profiles
- A qualified reference `namespace:id` (e.g., `shared:openrig-core`) names the imported spec by its `name` field
- An unqualified reference (just `id`) resolves against the spec's own resources first, then against the one import that
  declares it. If two imports declare it, the reference is ambiguous and fails: qualify it
- An imported spec may not have imports of its own, and its `name` may not contain `:`. Two imports that resolve to the
  same spec name are refused, and import cycles are detected

### The Shared Import Pattern

Most built-in agents import the shared builtin spec:

```yaml
imports:
  - ref: local:../../shared
```

This gives access to the shared pool: skills such as `systematic-debugging`, `verification-before-completion`,
`development-team` and `test-driven-development`; the `openrig-core` plugin, which carries `openrig-user` and OpenRig's
other skills; and runtime resources such as `claude-default-settings`, `claude-default-mcp`, `codex-default-config` and
`claude-activity-hooks`. Agents select the ones they need via profile `uses`, for example
`plugins: [shared:openrig-core]`.

---

## Profiles

```yaml
profiles:
  default:
    summary: Standard operations profile
    preferences:
      runtime: claude-code
      model: claude-opus-4-6
    uses:
      skills: [systematic-debugging, vault-user]
      guidance: [role]
      subagents: []
      plugins: [shared:openrig-core]
      runtime_resources: []
    startup:
      files: []
      actions: []
    lifecycle:
      restore_policy: resume_if_possible
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `summary` | string | no | — | Profile description. Spec review surfaces read a profile `description` instead. |
| `preferences` | object | no | — | Runtime/model/effort preferences for this profile. |
| `preferences.runtime` | string | no | — | Preferred runtime. |
| `preferences.model` | string | no | — | Preferred model. |
| `preferences.effort` | string | no | — | Preferred reasoning effort. |
| `uses` | Uses | no | all empty | Selects which declared resources are active for this profile. |
| `startup` | StartupBlock | no | — | Profile-level startup files and actions. Merged with agent-level startup via layering. |
| `lifecycle` | Lifecycle | no | — | Profile-level lifecycle overrides. `restore_policy` can only narrow (`resume_if_possible` → `relaunch_fresh` → `checkpoint_only`); `compaction_strategy` and `mechanic` take the most specific value (defaults, then profile, then member). |

### Uses

The `uses` block selects which resources from the `resources` pool (including imported resources) are active for this profile.

```yaml
uses:
  skills: [systematic-debugging, vault-user]
  guidance: [role]
  subagents: []
  plugins: [shared:openrig-core]
  runtime_resources: [claude-settings]
```

Each array contains resource IDs. These can be:
- **Unqualified** (`vault-user`) — resolves against the spec's own `resources` first, then imported specs
- **Qualified** (`shared:systematic-debugging`) — resolves against a specific imported spec's resources

The `uses` categories are: `skills`, `guidance`, `subagents`, `plugins`, `runtime_resources`. A `uses.hooks` key, even an
empty list, is refused: hooks ship inside plugins.

**Skills resolve more widely than other resources.** For Claude Code and Codex seats, a skill ID that no declared
resource provides is looked up at launch in the seat's runtime skill folder (`<cwd>/.claude/skills` or
`<cwd>/.agents/skills`), then the `skills/` folder beside the RigSpec, then the home skill folder, then the managed
skills root. Pi looks only in the `skills/` folder beside the RigSpec. OMP does no filesystem discovery, so its
`uses.skills` references need declared resources. A discovered skill's ID is its `SKILL.md` frontmatter `name`, and a declared resource wins over a discovered skill with the
same ID. When a profile selects a skill from inside the spec's own folder and the managed catalog holds a different
copy, the spec's copy is used and launch warns `skill_bundle_precedence`. Any other differing copy fails launch with
`skill_identity_conflict`.

---

## Resources

```yaml
resources:
  skills:
    - id: vault-user
      path: skills/vault-user
  guidance:
    - id: role
      path: guidance/role.md
  subagents:
    - id: helper
      path: subagents/helper
  plugins:
    - id: vault-tools
      source:
        kind: local
        path: plugins/vault-tools
      plugin_type: auto
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.fragment.json
      runtime: claude-code
      type: claude_settings_fragment
```

Resources are the available pool. They are NOT automatically delivered to agents — profiles select them via `uses`.
The only declared resources delivered are those that the active profile's `uses` block references. Two sources add
skills outside `uses`: the managed skill catalog's system selection and a project's `install.skills`.

`resources.hooks` is refused at validation: hooks now ship inside plugins, declared under `resources.plugins`.

### Plugin paths

A local plugin's `source.path` supports these forms:

| Form | Resolution |
|------|------------|
| `/absolute/plugin` | The exact absolute path. |
| `~/plugins/example` or `~` | The operating-system user home. |
| `openrig-home:plugins/openrig-core` | Relative to the daemon's configured OpenRig home, including a non-default `OPENRIG_HOME`. |
| `plugins/example` or `./plugins/example` | Relative to the agent spec directory. |

For a plugin seeded by OpenRig, use the home-relative form so the spec selects
that daemon's copy:

```yaml
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: "openrig-home:plugins/openrig-core"
profiles:
  default:
    uses:
      plugins: [openrig-core]
```

`openrig-home:` is resolved by the daemon from its configured state root. It is
not shell interpolation and does not consult a seat's shell startup files. Its
suffix must be relative. Existing absolute, tilde and spec-relative paths keep
their meaning; `~user` is still a literal relative segment, not a user lookup.
This form needs OpenRig 0.6.5 or later; keep bundles using it pinned to such a
version.

### Resource Categories

| Category | Fields | Description |
|----------|--------|-------------|
| `skills` | `id`, `path` | Skill directories containing a SKILL.md. Projected by the runtime adapter: Claude to `<cwd>/.claude/skills/<id>`, Codex to `<cwd>/.agents/skills/<id>`, Pi and OMP to the seat's own agent directory under OpenRig's state. |
| `guidance` | `id`, `path`, `target`*, `merge`* | Guidance files, merged as a managed block (see "Guidance Resources"). |
| `subagents` | `id`, `path` | Subagent definitions. Claude copies them to `<cwd>/.claude/agents/`, Codex to `<cwd>/.agents/`; Pi and OMP don't project them. |
| `plugins` | `id`, `source`, `plugin_type`* | Local plugin directories; selected with `uses.plugins`. `source.kind` must be `local`. `plugin_type` is `claude`, `codex` or `auto` (default): Claude projects a plugin to `<cwd>/.claude/plugins/<id>` when it is `claude`, or `auto` with a `.claude-plugin/plugin.json`; Codex projects to `<cwd>/.codex/plugins/<id>` when it is `codex`, or `auto` with a `.codex-plugin/plugin.json`. Pi and OMP don't project plugins. Neither Claude Code nor Codex reads skills from that plugin folder, so when a seat is instantiated a selected plugin's skills are also projected into the seat's skill folder (`.claude/skills/<name>` or `.agents/skills/<name>`) under their plain names. A folder already there with the same name, ignoring letter case, that OpenRig doesn't own is left alone; unless it already holds the same bytes, launch warns `plugin_skill_kept`. A skill the seat already selects by that name (from its profile, the System World or the project) keeps that source, an edited OpenRig-owned copy, or one whose plugin changed or moved since OpenRig projected it, is kept with `plugin_skill_kept`, and if the plugin skills can't be projected the seat launches without them and warns `plugin_skills_not_projected`. Hooks ship inside plugins. |
| `runtime_resources` | `id`, `path`, `runtime`, `type` | Runtime-specific resources. `runtime` and `type` are required. An entry whose `runtime` isn't the seat's runtime is skipped. Pi and OMP project none. |

*Fields marked with `*` are optional.

Recognized runtime resource types:
- `claude_settings_fragment` — merge a JSON object into `<cwd>/.claude/settings.local.json`.
- `claude_mcp_fragment` — merge a JSON object into `<cwd>/.mcp.json`.
- `claude_activity_hooks` — reconcile OpenRig's activity hooks into `<cwd>/.claude/settings.local.json`.
- `codex_config_fragment` — upsert a TOML fragment into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) inside an OpenRig-managed block.

Unknown runtime resource types are still copied to the Claude or Codex runtime extension directory for agent-visible context.

#### Writing a `codex_config_fragment`

**Begin the fragment with a table header.** A fragment must be a valid TOML
document on its own, and every key it sets must sit under a table it declares.
A fragment that puts keys ahead of its first table header is refused at
projection time, and nothing is written.

The reason is TOML's grammar rather than a policy choice. The managed block is
appended to the end of the user's `config.toml`, and TOML has no syntax for
returning to document root once a table has been opened. So if the user's file
ends inside any table, an appended root-level key does not land at root — it
silently becomes a member of *their* table. Refusal is deterministic and never
inspects the user's file: a fragment author cannot see user state, and a rule
that passed or failed depending on it would be impossible to reproduce.

```toml
# refused — `model` would bind into whatever table the user's file ends inside
model = "gpt-5"

[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
```

```toml
# accepted — every key sits under a table this fragment declares
[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
```

Where a fragment's table is one the user already declares, the user's table
wins: the managed table is dropped, their values are never merged, rewritten or
overwritten, and the rest of the fragment still applies.

### Resource Path Rules

- All resource paths must be safe relative paths (no `..` traversal, no absolute paths), except a plugin's
  `source.path`, which takes the forms under "Plugin paths"
- Paths resolve relative to the agent spec's directory
- Resource IDs must be unique within their category
- Resource IDs are the identifiers used in `uses` references

### Guidance Resources

```yaml
guidance:
  - id: role
    path: guidance/role.md
    merge: managed_block   # optional — the only strategy applied
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Resource identifier. A `rig-role` guidance resource is never merged; deliver a role with a `send_text` startup file. |
| `path` | string | yes | — | Relative path to the guidance file. |
| `target` | string | no | — | Parsed but not used: the runtime decides the file. Claude merges into the rig's `managed_blocks` file (`CLAUDE.md` by default, or `CLAUDE.local.md`); Codex, Pi and OMP merge into `<cwd>/AGENTS.md`. |
| `merge` | string | no | `managed_block` | Only `managed_block` is applied. Any other value, such as `append`, merges nothing. |

---

## Startup Block

The startup block follows the same format as in the RigSpec (see `docs/reference/rig-spec.md` for full details on files and actions).

Agent-level startup is applied to all profiles. Profile-level startup is applied only when that profile is active. Both merge additively via the startup layering model.

An additional orientation challenge requires an explicit `startup_proof` action
with `value: authenticated` and `idempotent: true`. Omission adds no exercise;
a later applicable `value: none` overrides an earlier selection. See
[startup proof selection](rig-spec.md#startup-proof-selection) for precedence,
restore behavior, and the distinction between readiness and verified proof.

### Delivery Hint Quick Reference

| Hint | When Delivered | Mechanism |
|------|---------------|-----------|
| `auto` | Depends on the file | A path ending in `SKILL.md`, or content beginning with `# SKILL`, is `skill_install`; otherwise a `.md` file is `guidance_merge`, and any other file is `send_text` |
| `guidance_merge` | Before harness boot | Merged into CLAUDE.md/AGENTS.md as managed block |
| `skill_install` | Before harness boot | Installed to runtime skill directory |
| `send_text` | After harness is ready | Sent as text to agent terminal via tmux |

---

## Validation Rules Summary

1. `name` and `version` are required non-empty strings.
2. `imports` must be an array of objects with `ref` field.
3. Import `ref` must start with `local:` (relative) or `path:` (absolute).
4. Import `version` must be an exact version (no ranges).
5. `profiles` must be a map (object), not an array.
6. Profile `uses` references other than skills must resolve to declared resources (local or imported). Skill
   references are checked at launch, not at validation (see "Uses").
7. Unqualified `uses` references that don't resolve to local resources require imports to be present.
8. Qualified `uses` references must be in `namespace:id` format.
9. All resource paths must be safe relative paths (a plugin's `source.path` excepted).
10. Resource IDs must be unique within their category, and each `resources.<category>` must be an array.
11. `runtime_resources` entries require `runtime` and `type` fields.
12a. `resources.hooks` and `profiles.<name>.uses.hooks` are refused: "removed in plugin-primitive (Phase 3a)". Declare
   a plugin instead.
12b. A plugin needs a unique non-empty `id`, a `source` object with `kind: local` and a non-empty `path`, and a
   `plugin_type` of `claude`, `codex` or `auto` when given.
12c. Lifecycle `mechanic` must be a canonical `seat@rig` session address.
12. Lifecycle `execution_mode` must be `interactive_resident`.
13. Lifecycle `compaction_strategy` must be one of `default-compaction`, `managed-compaction`, `handover`, `apprentice-handover` — or a deprecated alias (`harness_native`, `pod_continuity`), which validates with a deprecation advisory and normalizes to its canonical value (OPR.0.5.6.20).
14. Lifecycle `restore_policy` must be `resume_if_possible`, `relaunch_fresh`, or `checkpoint_only`.
15. Startup files and actions follow the same validation rules as in RigSpec.

Unknown keys are ignored, not refused. `rig agent validate <path> [--json]` runs these syntax checks through the running
daemon; it doesn't resolve imports, find skills or check that files exist, so a missing skill shows up only at launch.

---

## File System Layout

An agent spec directory follows this conventional layout:

```
my-agent/
  agent.yaml              # required — the AgentSpec
  guidance/
    role.md               # role definition
  startup/
    context.md            # boot-time grounding
  skills/
    my-skill/
      SKILL.md            # skill content
  plugins/
    my-plugin/            # plugin (skills, hooks) with .claude-plugin/ and/or .codex-plugin/
  runtime/
    claude-settings.fragment.json  # runtime-specific resource
```

The only required file is `agent.yaml`. Everything else is referenced by paths in the spec and must exist at those relative paths.

---

## Shipped Examples

Every agent below except `shared` imports `shared` and selects `plugins: [shared:openrig-core]`, which carries
`openrig-user`. Paths are under `packages/daemon/specs/agents/`; the kernel's own agents are under
`packages/daemon/specs/rigs/launch/kernel/agents/`.

| Agent | Location | Default runtime | Profile skills | Purpose |
|-------|----------|-----------------|----------------|---------|
| `shared` | `shared/` | — | — (resource pool only) | Shared skills, the `openrig-core` plugin and runtime resources |
| `implementer` | `development/implementer/` | claude-code | development-team, systematic-debugging, verification-before-completion | Implementation agent |
| `qa` | `development/qa/` | codex | development-team, systematic-debugging, verification-before-completion, agent-browser, dogfood | Quality assurance agent |
| `orchestrator` | `orchestration/orchestrator/` | claude-code | orchestration-team, systematic-debugging, verification-before-completion | Rig orchestration lead |
| `independent-reviewer` | `review/independent-reviewer/` | claude-code | review-team, systematic-debugging, verification-before-completion | Independent code reviewer |
| `vault-specialist` | `apps/vault-specialist/` | claude-code | systematic-debugging, verification-before-completion, vault-user | Vault domain specialist |
| `product-designer` | `design/product-designer/` | claude-code | development-team, frontend-design, verification-before-completion | Product designer |
| `pm` | `product-management/pm/` | claude-code | office-hours, context-builder, requirements-writer, ui-mockup, plan-review, exec-summary, backlog-capture; `advisor` profile: orchestration-team | Product manager; its `advisor` profile is the factory's advisor |
| `analyst`, `synthesizer` | `research/analyst/`, `research/synthesizer/` | claude-code, codex | — | Research team |
| `conveyor-lead`, `-planner`, `-builder`, `-reviewer` | `conveyor/` | claude-code, codex, claude-code, codex | per role | Kept for the `factory-rsi` world bundle (its planner); no built-in team uses them |
| `factory-rsi-release-manager`, `factory-rsi-dogfood` | `factory-rsi/` | claude-code | per role | Used by the `factory-rsi` world bundle (not a built-in team) |
