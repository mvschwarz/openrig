# AgentSpec Reference

Version: 1.0
Last validated against code: 2026-04-11
Source of truth: `packages/daemon/src/domain/agent-manifest.ts`, `packages/daemon/src/domain/types.ts`

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
      hooks: []
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
description: Implementation agent — writes code following TDD discipline

defaults:
  runtime: claude-code

imports:
  - ref: local:../../shared

profiles:
  default:
    uses:
      skills: [using-superpowers, openrig-user, development-team, test-driven-development, mental-model-ha]
      guidance: []
      subagents: []
      hooks: []
      runtime_resources: []

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
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: harness_native
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
      skills: [openrig-user, mental-model-ha, vault-user]
      guidance: []
      subagents: []
      hooks: []
      runtime_resources: []
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
  hooks:
    - id: pre-commit
      path: hooks/pre-commit.sh
      runtimes: [claude-code]
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.json
      runtime: claude-code
      type: settings

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
| `version` | string | yes | — | Spec version. Informational — not used for compatibility gating. |
| `description` | string | no | — | Human-readable description. Shown in spec library and review surfaces. |
| `defaults` | Defaults | no | — | Default runtime, model, and lifecycle settings. Applied when not overridden by the rig spec or profile. |
| `imports` | Import[] | no | `[]` | Other AgentSpecs to import. Resources from imported specs become available for profile `uses` references. |
| `profiles` | map<string, Profile> | no | `{}` | Named profiles. Each profile selects resources and can override startup/lifecycle. The rig spec member's `profile` field selects which profile to use. |
| `resources` | Resources | no | all empty | Declared resources (skills, guidance, subagents, hooks, runtime resources). These are the available pool that profiles select from via `uses`. |
| `startup` | StartupBlock | no | `{ files: [], actions: [] }` | Agent-level startup files and actions. Applied to all profiles via the startup layering model. |

---

## Defaults

```yaml
defaults:
  runtime: claude-code
  model: claude-opus-4-6
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: harness_native
    restore_policy: resume_if_possible
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `runtime` | string | no | — | Default runtime for this agent. Can be overridden by the rig spec member's `runtime` field. |
| `model` | string | no | — | Default model. Can be overridden by the rig spec member's `model` field. |
| `lifecycle` | Lifecycle | no | see below | Lifecycle behavior defaults. |

### Lifecycle Defaults

| Field | Type | Default | Allowed Values |
|-------|------|---------|----------------|
| `execution_mode` | string | `interactive_resident` | `interactive_resident` (only value in v1; `wake_on_demand` is explicitly rejected) |
| `compaction_strategy` | string | `harness_native` | `harness_native`, `pod_continuity` (`custom_prompt` is explicitly rejected in v1) |
| `restore_policy` | string | `resume_if_possible` | `resume_if_possible`, `relaunch_fresh`, `checkpoint_only` |

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
| `version` | string | no | Optional version constraint. Must be an exact version — no ranges (`~`, `^`, `>=`, etc.). |

### Import Resolution

- `local:` paths resolve relative to the importing spec's directory
- `path:` paths are absolute filesystem paths
- Imported resources become available for `uses` references in profiles
- When referencing imported resources in `uses`, use qualified `namespace:id` format (e.g., `shared:openrig-user`)
- Unqualified references (just `id`) resolve against the spec's own local resources first

### The Shared Import Pattern

Most built-in agents import the shared builtin spec:

```yaml
imports:
  - ref: local:../../shared
```

This gives access to the full pool of shared skills (openrig-user, mental-model-ha, development-team, etc.) and agents select the ones they need via profile `uses`.

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
      skills: [openrig-user, mental-model-ha, vault-user]
      guidance: [role]
      subagents: []
      hooks: []
      runtime_resources: []
    startup:
      files: []
      actions: []
    lifecycle:
      restore_policy: resume_if_possible
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `summary` | string | no | — | Profile description. |
| `preferences` | object | no | — | Runtime/model preferences for this profile. |
| `preferences.runtime` | string | no | — | Preferred runtime. |
| `preferences.model` | string | no | — | Preferred model. |
| `uses` | Uses | no | all empty | Selects which declared resources are active for this profile. |
| `startup` | StartupBlock | no | — | Profile-level startup files and actions. Merged with agent-level startup via layering. |
| `lifecycle` | Lifecycle | no | — | Profile-level lifecycle overrides. |

### Uses

The `uses` block selects which resources from the `resources` pool (including imported resources) are active for this profile.

```yaml
uses:
  skills: [openrig-user, mental-model-ha, vault-user]
  guidance: [role]
  subagents: []
  hooks: [pre-commit]
  runtime_resources: [claude-settings]
```

Each array contains resource IDs. These can be:
- **Unqualified** (`vault-user`) — resolves against the spec's own `resources` first, then imported specs
- **Qualified** (`shared:openrig-user`) — resolves against a specific imported spec's resources

The `uses` categories are: `skills`, `guidance`, `subagents`, `hooks`, `runtime_resources`.

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
  hooks:
    - id: pre-commit
      path: hooks/pre-commit.sh
      runtimes: [claude-code]
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.json
      runtime: claude-code
      type: settings
```

Resources are the available pool. They are NOT automatically delivered to agents — profiles select them via `uses`. The only resources delivered are those that the active profile's `uses` block references.

### Resource Categories

| Category | Fields | Description |
|----------|--------|-------------|
| `skills` | `id`, `path` | Skill directories containing a SKILL.md. Delivered via `skill_install`. |
| `guidance` | `id`, `path`, `target`*, `merge`* | Guidance files. Delivered via `guidance_merge` into CLAUDE.md/AGENTS.md. |
| `subagents` | `id`, `path` | Subagent definitions. |
| `hooks` | `id`, `path`, `runtimes`* | Hook scripts. Optional `runtimes` array restricts to specific runtimes. |
| `runtime_resources` | `id`, `path`, `runtime`, `type` | Runtime-specific resources. `runtime` and `type` are required. |

*Fields marked with `*` are optional.

### Resource Path Rules

- All resource paths must be safe relative paths (no `..` traversal, no absolute paths)
- Paths resolve relative to the agent spec's directory
- Resource IDs must be unique within their category
- Resource IDs are the identifiers used in `uses` references

### Guidance Resources

```yaml
guidance:
  - id: role
    path: guidance/role.md
    target: CLAUDE.md      # optional — where to merge
    merge: managed_block   # optional — how to merge (default: managed_block)
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Resource identifier. |
| `path` | string | yes | — | Relative path to the guidance file. |
| `target` | string | no | — | Target file for merging (e.g., `CLAUDE.md`). |
| `merge` | string | no | `managed_block` | Merge strategy. One of: `managed_block`, `append`. |

---

## Startup Block

The startup block follows the same format as in the RigSpec (see `docs/reference/rig-spec.md` for full details on files and actions).

Agent-level startup is applied to all profiles. Profile-level startup is applied only when that profile is active. Both merge additively via the startup layering model.

### Delivery Hint Quick Reference

| Hint | When Delivered | Mechanism |
|------|---------------|-----------|
| `auto` | Before harness boot | System chooses based on file type |
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
6. Profile `uses` references must resolve to declared resources (local or imported).
7. Unqualified `uses` references that don't resolve to local resources require imports to be present.
8. Qualified `uses` references must be in `namespace:id` format.
9. All resource paths must be safe relative paths.
10. Resource IDs must be unique within their category.
11. `runtime_resources` entries require `runtime` field.
12. Lifecycle `execution_mode` must be `interactive_resident`.
13. Lifecycle `compaction_strategy` must be `harness_native` or `pod_continuity`.
14. Lifecycle `restore_policy` must be `resume_if_possible`, `relaunch_fresh`, or `checkpoint_only`.
15. Startup files and actions follow the same validation rules as in RigSpec.

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
  hooks/
    pre-commit.sh         # hook script
  runtime/
    claude-settings.json  # runtime-specific resource
```

The only required file is `agent.yaml`. Everything else is referenced by paths in the spec and must exist at those relative paths.

---

## Shipped Examples

| Agent | Location | Imports | Profile Skills | Purpose |
|-------|----------|---------|---------------|---------|
| `shared` | `specs/agents/shared/` | none | — (resource pool only) | Shared skill pool for all built-in agents |
| `implementer` | `specs/agents/development/implementer/` | `shared` | openrig-user, development-team, test-driven-development, mental-model-ha, etc. | TDD implementation agent |
| `qa` | `specs/agents/development/qa/` | `shared` | openrig-user, development-team, etc. | Quality assurance agent |
| `orchestrator` | `specs/agents/orchestration/orchestrator/` | `shared` | openrig-user, orchestration-team, etc. | Rig orchestration lead |
| `reviewer` | `specs/agents/review/reviewer/` | `shared` | openrig-user, review-team, etc. | Independent code reviewer |
| `vault-specialist` | `specs/agents/apps/vault-specialist/` | `shared` | openrig-user, mental-model-ha, vault-user | Vault domain specialist |
| `design` | `specs/agents/design/` | none | — | Product designer |
