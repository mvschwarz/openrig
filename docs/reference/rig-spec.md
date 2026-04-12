# RigSpec Reference

Version: 0.2 (pod-aware)
Last validated against code: 2026-04-11
Source of truth: `packages/daemon/src/domain/rigspec-schema.ts`, `packages/daemon/src/domain/types.ts`

This is the canonical reference for the pod-aware RigSpec YAML format. Every field, validation rule, and default documented here was traced from the actual parser and validator code, not from prior documentation.

---

## Minimal Valid Example

```yaml
version: "0.2"
name: my-rig

pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: "."
    edges: []

edges: []
```

## Complete Example (all features)

```yaml
version: "0.2"
name: my-product-team
summary: A full product squad with orchestration, development, and review pods.

culture_file: culture/CULTURE.md

docs:
  - path: SETUP.md
  - path: README.md

startup:
  files:
    - path: guidance/team-norms.md
      delivery_hint: guidance_merge
      required: true
  actions: []

services:
  kind: compose
  compose_file: docker-compose.yaml
  project_name: my-product
  profiles: [core]
  down_policy: down
  wait_for:
    - url: http://127.0.0.1:5432/health
    - service: redis
      condition: healthy
  surfaces:
    urls:
      - name: App
        url: http://127.0.0.1:3000
    commands:
      - name: psql
        command: "psql postgresql://app:dev@127.0.0.1:5432/app"
  checkpoints:
    - id: postgres
      export: "docker compose exec -T postgres pg_dump -U app > {{artifacts_dir}}/postgres.sql"
      import: "cat {{artifacts_dir}}/postgres.sql | docker compose exec -T postgres psql -U app"

pods:
  - id: orch
    label: Orchestration
    members:
      - id: lead
        agent_ref: "local:agents/orchestrator"
        profile: default
        runtime: claude-code
        cwd: "."
      - id: peer
        agent_ref: "local:agents/orchestrator"
        profile: default
        runtime: codex
        cwd: "."
    edges: []

  - id: dev
    label: Development
    summary: Implementation and quality assurance pair.
    continuity_policy:
      enabled: true
      sync_triggers: [pre_compaction, pre_shutdown]
      artifacts:
        session_log: true
        restore_brief: true
      restore_protocol:
        peer_driven: true
        verify_via_quiz: false
    startup:
      files:
        - path: guidance/dev-sop.md
          delivery_hint: guidance_merge
          required: true
      actions: []
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: "."
        label: "Implementation Lead"
        model: claude-opus-4-6
        restore_policy: resume_if_possible
        startup:
          files:
            - path: guidance/impl-specific.md
              delivery_hint: send_text
              required: false
              applies_on: [fresh_start]
          actions:
            - type: send_text
              value: "Load the implementation-pair skill and begin."
              phase: after_ready
              idempotent: true
      - id: qa
        agent_ref: "local:agents/qa"
        profile: default
        runtime: codex
        cwd: "."
    edges:
      - kind: delegates_to
        from: impl
        to: qa

  - id: rev
    label: Review
    members:
      - id: r1
        agent_ref: "local:agents/reviewer"
        profile: default
        runtime: claude-code
        cwd: "."
      - id: r2
        agent_ref: "local:agents/reviewer"
        profile: default
        runtime: codex
        cwd: "."
    edges: []

edges:
  - kind: delegates_to
    from: orch.lead
    to: dev.impl
  - kind: delegates_to
    from: orch.peer
    to: dev.qa
  - kind: can_observe
    from: rev.r1
    to: dev.impl
  - kind: can_observe
    from: rev.r2
    to: dev.qa
```

---

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | string | yes | — | Must be `"0.2"` for pod-aware specs. |
| `name` | string | yes | — | Rig name. Used in session naming (`{pod}-{member}@{name}`), snapshot identification, and spec library lookup. |
| `summary` | string | no | — | Human-readable description. Shown in spec library, review surfaces, and `rig specs show`. |
| `culture_file` | string | no | — | Relative path to a rig-wide culture/constitution file. Must be a safe relative path (no `..`, no absolute). |
| `docs` | Doc[] | no | — | Documentation files that should travel with the rig. Included in rig bundles. Each entry has a `path` field (safe relative path). The engine does not consume these — they are for humans and agents setting up the environment before launch. |
| `startup` | StartupBlock | no | — | Rig-level startup files and actions. Applied to all members via the startup layering model. |
| `services` | ServicesBlock | no | — | Optional managed services (Docker Compose). When present, services boot before any agent launches. |
| `pods` | Pod[] | yes | — | At least one pod required. Each pod is a bounded context containing members and pod-local edges. |
| `edges` | CrossPodEdge[] | no | `[]` | Cross-pod edges connecting members in different pods. Must use fully-qualified `pod.member` IDs. |

---

## Pod

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Pod identifier. Must not contain dots. Must be unique within the rig. Used as the first segment of session names and logical IDs. |
| `label` | string | yes | — | Human-readable pod name. Shown in UI explorer, graph groupings, and detail surfaces. |
| `summary` | string | no | — | Pod description. |
| `continuity_policy` | ContinuityPolicy | no | — | Pod-level continuity/restore policy. Controls compaction recovery, artifact management, and peer-driven restoration. |
| `startup` | StartupBlock | no | — | Pod-level startup files and actions. Applied to all members in this pod via the startup layering model. |
| `members` | Member[] | yes | — | At least one member required (enforced by pods needing content). |
| `edges` | PodLocalEdge[] | no | `[]` | Edges between members within this pod. Must use unqualified member IDs (not `pod.member`). |

### Pod ID Rules

- Must not contain dots (`.`)
- Must be unique across all pods in the rig
- Becomes the first segment of the qualified logical ID: `{podId}.{memberId}`
- Becomes the first segment of the canonical session name: `{podId}-{memberId}@{rigName}`

---

## Member

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Member identifier. Must not contain dots. Must be unique within the pod. |
| `agent_ref` | string | yes | — | Reference to an AgentSpec. Must start with `local:` (relative) or `path:` (absolute). Exception: `builtin:terminal` for infrastructure nodes. |
| `profile` | string | yes | — | Profile name from the referenced AgentSpec. Use `default` for the default profile. Exception: `none` for terminal nodes. |
| `runtime` | string | yes | — | Agent runtime. Current supported values: `claude-code`, `codex`, `terminal`. |
| `cwd` | string | yes | — | Working directory for the agent. Resolved relative to the rig root (the directory containing the rig spec). Use `"."` for the rig root itself. Can be overridden at launch time with `rig up --cwd`. |
| `label` | string | no | — | Human-readable member name. Shown in UI when present. |
| `model` | string | no | — | Model override. Runtime-specific (e.g., `claude-opus-4-6` for Claude Code). |
| `restore_policy` | string | no | `resume_if_possible` | Restore behavior. One of: `resume_if_possible`, `relaunch_fresh`, `checkpoint_only`. |
| `startup` | StartupBlock | no | — | Member-level startup files and actions. Applied only to this member. |

### Terminal Nodes

Terminal nodes are infrastructure processes (servers, log tails, build watchers) that are not agent runtimes. They require an exact triple:

```yaml
runtime: terminal
agent_ref: "builtin:terminal"
profile: none
```

All three must be present together. Any partial combination is a validation error.

### agent_ref Rules

- Must start with `local:` or `path:`
- `local:` paths are relative to the rig spec file's directory (the rig root)
- `path:` paths are absolute filesystem paths
- The referenced path must contain an `agent.yaml` file
- Exception: `builtin:terminal` for terminal nodes

### Session Naming

The canonical session name is derived from the pod ID, member ID, and rig name:

```
{podId}-{memberId}@{rigName}
```

Example: pod `dev`, member `impl`, rig `my-team` → session `dev-impl@my-team`

This is human-authored (you choose the pod/member IDs) and system-validated (the system enforces the format).

---

## Edges

### Edge Kinds

| Kind | Meaning | Use When |
|------|---------|----------|
| `delegates_to` | Source delegates work to target. Constrains launch order. | Orchestrator → implementer, lead → worker |
| `spawned_by` | Target was spawned by source. Constrains launch order. | Parent → child in hierarchical topologies |
| `can_observe` | Source can observe target's output. Does NOT constrain launch order. | Reviewer → implementer, monitor → worker |
| `collaborates_with` | Peer collaboration relationship. Does NOT constrain launch order. | Co-equal peers working together |
| `escalates_to` | Source escalates to target for decisions. Does NOT constrain launch order. | Worker → lead for escalation |

### Pod-Local Edges

Edges within a pod use **unqualified member IDs** (just the member `id`, not `pod.member`):

```yaml
pods:
  - id: dev
    members:
      - id: impl
        # ...
      - id: qa
        # ...
    edges:
      - kind: delegates_to
        from: impl      # NOT dev.impl
        to: qa          # NOT dev.qa
```

Both `from` and `to` must reference members that exist in the same pod.

### Cross-Pod Edges

Edges between pods use **fully-qualified `pod.member` IDs**:

```yaml
edges:
  - kind: delegates_to
    from: orch.lead     # pod.member format
    to: dev.impl        # pod.member format
```

Cross-pod edges must reference different pods. An edge where both `from` and `to` are in the same pod is a validation error — use pod-local edges instead.

---

## Startup Block

Startup blocks can appear at three levels: rig, pod, and member. They are merged additively via the startup layering model (see `docs/reference/startup-layering.md`).

### Files

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | yes | — | Relative path to the file. Must be a safe relative path. |
| `delivery_hint` | string | no | `auto` | How the file is delivered. One of: `auto`, `guidance_merge`, `skill_install`, `send_text`. |
| `required` | boolean | no | `true` | Whether startup fails if this file cannot be delivered. |
| `applies_on` | string[] | no | `[fresh_start, restore]` | When this file is delivered. Subset of: `fresh_start`, `restore`. |

#### Delivery Hints

| Hint | Behavior |
|------|----------|
| `auto` | System chooses based on file type and context. |
| `guidance_merge` | Merged into the runtime's guidance file (`CLAUDE.md` or `AGENTS.md`) as a managed block. Delivered before harness boot. |
| `skill_install` | Installed as a skill in the runtime's skill directory. Delivered before harness boot. |
| `send_text` | Sent as text to the agent's terminal after the harness is ready. Requires the agent TUI to be active. |

### Actions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | yes | — | Action type. One of: `slash_command`, `send_text`. Note: `shell` is explicitly NOT supported in v1. |
| `value` | string | yes | — | The command or text to send. |
| `phase` | string | no | `after_files` | When to execute. One of: `after_files` (after startup files are delivered), `after_ready` (after harness readiness check passes). |
| `idempotent` | boolean | yes | — | Whether this action is safe to replay on restore. **Required field.** Non-idempotent actions must NOT include `restore` in `applies_on`. |
| `applies_on` | string[] | no | `[fresh_start, restore]` | When this action runs. Subset of: `fresh_start`, `restore`. |

---

## Services Block

The services block is optional. When present, services boot before any agent node launches. If service health checks fail, agent launch is blocked.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | string | yes | — | Service backend. Only `compose` is supported in v1. |
| `compose_file` | string | yes | — | Relative path to the Docker Compose file. Must be a safe relative path. Resolved relative to rig root. |
| `project_name` | string | no | derived from rig name | Docker Compose project name. Must match `[a-z0-9][a-z0-9_-]*`. If omitted, derived by sanitizing the rig name. |
| `profiles` | string[] | no | — | Compose profiles to activate. |
| `down_policy` | string | no | `down` | What happens on `rig down`. One of: `leave_running`, `down`, `down_and_volumes`. |
| `wait_for` | WaitTarget[] | no | — | Health targets that must pass before agent launch. |
| `surfaces` | Surfaces | no | — | Metadata about accessible URLs and commands. Not executed — informational only. |
| `checkpoints` | CheckpointHook[] | no | — | Shell commands for checkpoint export/import during snapshot/restore. |

### Wait Targets

Each target must define exactly one of `service`, `url`, or `tcp`:

```yaml
wait_for:
  # HTTP probe — hits the URL, expects 2xx
  - url: http://127.0.0.1:8200/v1/sys/health

  # TCP probe — connects to host:port
  - tcp: "127.0.0.1:5432"

  # Compose health check — requires Docker health to report "healthy"
  - service: postgres
    condition: healthy
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | one of three | HTTP URL to probe. |
| `tcp` | string | one of three | `host:port` for TCP probe. |
| `service` | string | one of three | Compose service name. Requires `condition: healthy`. |
| `condition` | string | only with `service` | Must be `healthy`. Only valid with `service` targets. |

### Surfaces

```yaml
surfaces:
  urls:
    - name: Vault UI
      url: http://127.0.0.1:8200/ui
  commands:
    - name: Vault status
      command: "vault status -address=http://127.0.0.1:8200"
```

Surfaces are metadata only. They are displayed in the UI and in `rig env status` output but are NOT executed by OpenRig.

### Checkpoint Hooks

```yaml
checkpoints:
  - id: postgres
    export: "docker compose exec -T postgres pg_dump -U app > {{artifacts_dir}}/postgres.sql"
    import: "cat {{artifacts_dir}}/postgres.sql | docker compose exec -T postgres psql -U app"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier for this checkpoint. |
| `export` | string | yes | Shell command to export state. `{{artifacts_dir}}` is replaced with a daemon-managed path. |
| `import` | string | no | Shell command to import state on restore. |

Checkpoint hooks are shell commands run by the daemon. They are best-effort — a failed export does not block snapshot, but continuity is classified as `receipt_only` instead of `checkpointed`.

---

## Continuity Policy

Optional pod-level configuration for compaction recovery behavior.

```yaml
continuity_policy:
  enabled: true
  sync_triggers: [pre_compaction, pre_shutdown, manual, milestone]
  artifacts:
    session_log: true
    restore_brief: true
    quiz: false
  restore_protocol:
    peer_driven: true
    verify_via_quiz: false
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | yes | — | Whether continuity is active for this pod. |
| `sync_triggers` | string[] | no | — | When to sync. Values: `pre_compaction`, `pre_shutdown`, `manual`, `milestone`. |
| `artifacts.session_log` | boolean | no | — | Whether to maintain a session log. |
| `artifacts.restore_brief` | boolean | no | — | Whether to maintain a restore brief. |
| `artifacts.quiz` | boolean | no | — | Whether to use quiz-based verification. |
| `restore_protocol.peer_driven` | boolean | no | — | Whether peers drive the restore process. |
| `restore_protocol.verify_via_quiz` | boolean | no | — | Whether to verify restoration via quiz. |

---

## Validation Rules Summary

These rules are enforced by the validator. A spec that violates any of these will be rejected by `rig spec validate` and `rig up`.

1. `version` and `name` are required non-empty strings.
2. `pods` must be a non-empty array.
3. Pod IDs must not contain dots and must be unique.
4. Pod labels are required.
5. Member IDs must not contain dots and must be unique within their pod.
6. `agent_ref`, `profile`, `runtime`, and `cwd` are required for every member.
7. Terminal nodes require the exact triple: `runtime: terminal`, `agent_ref: builtin:terminal`, `profile: none`.
8. `agent_ref` must start with `local:` (relative) or `path:` (absolute), except `builtin:terminal`.
9. `local:` refs must be relative paths. `path:` refs must be absolute paths.
10. `restore_policy` must be one of: `resume_if_possible`, `relaunch_fresh`, `checkpoint_only`.
11. Pod-local edges use unqualified member IDs. Cross-pod edges use `pod.member` format.
12. Cross-pod edges must reference different pods.
13. Edge kinds must be one of: `delegates_to`, `spawned_by`, `can_observe`, `collaborates_with`, `escalates_to`.
14. All file paths (`culture_file`, startup file paths, `compose_file`) must be safe relative paths.
15. `services.kind` must be `compose`.
16. `services.compose_file` is required when services is present.
17. `services.project_name` must match `[a-z0-9][a-z0-9_-]*`.
18. `services.down_policy` must be one of: `leave_running`, `down`, `down_and_volumes`.
19. Each wait target must define exactly one of: `service`, `url`, `tcp`.
20. `condition` is only valid on `service` targets and must be `healthy`.
21. Startup file `delivery_hint` must be one of: `auto`, `guidance_merge`, `skill_install`, `send_text`.
22. Startup action `type` must be one of: `slash_command`, `send_text`. (`shell` is explicitly rejected.)
23. Startup action `phase` must be one of: `after_files`, `after_ready`.
24. Startup action `idempotent` is a required boolean.
25. Non-idempotent actions must not include `restore` in `applies_on`.
26. `applies_on` values must be from: `fresh_start`, `restore`.

---

## Shipped Examples

These are the built-in specs shipped with OpenRig. Read them as worked examples.

| Spec | Location | Pods | Members | Services |
|------|----------|------|---------|----------|
| `product-team` | `packages/daemon/specs/rigs/product-team.yaml` | orch, dev, rev | 7 (lead, peer, impl, qa, design, r1, r2) | no |
| `implementation-pair` | `packages/daemon/specs/rigs/implementation-pair.yaml` | dev | 2 (impl, qa) | no |
| `adversarial-review` | `packages/daemon/specs/rigs/adversarial-review.yaml` | orch, rev | 3 (lead, r1, r2) | no |
| `research-team` | `packages/daemon/specs/rigs/research-team.yaml` | orch, research | 3 (lead, analyst, synthesizer) | no |
| `secrets-manager` | `packages/daemon/specs/rigs/launch/secrets-manager/rig.yaml` | vault | 1 (specialist) | yes (Vault) |
