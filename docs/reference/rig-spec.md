# RigSpec Reference

Version: 0.2 (pod-aware)
Last validated against code: 2026-10-07, at the 0.6.6 cut `2620dea8` (whole document at `fcaf1f8e`; changes to its sources since then checked)
Source of truth: `packages/daemon/src/domain/rigspec-schema.ts`, `packages/daemon/src/domain/types.ts`, `packages/daemon/src/domain/startup-validation.ts`, `packages/daemon/src/domain/permission-policy/policy-ref.ts`, `packages/daemon/src/domain/profile-resolver.ts`, `packages/daemon/src/domain/rigspec-preflight.ts`, `packages/daemon/src/adapters/kernel-authority.ts`, `packages/daemon/src/domain/native-permission-store.ts`, `packages/daemon/src/domain/codex-team-workspace.ts`

This is the canonical reference for the pod-aware RigSpec YAML format. Every field, validation rule, and default documented here was traced from the actual parser and validator code, not from prior documentation.

---

For choosing IDs, see [naming rigs, pods and seats](topology-naming.md). Keep the same
logical names in edges, startup instructions, workflow targets and runtime presets.

## Minimal Valid Example

```yaml
version: "0.2"
name: my-rig

pods:
  - id: dev
    label: Development
    members:
      - id: build
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
      - id: build
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
              value: "Read your guidance and begin."
              phase: after_ready
              idempotent: true
      - id: qa
        agent_ref: "local:agents/qa"
        profile: default
        runtime: codex
        cwd: "."
    edges:
      - kind: delegates_to
        from: build
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
    to: dev.build
  - kind: delegates_to
    from: orch.peer
    to: dev.qa
  - kind: can_observe
    from: rev.r1
    to: dev.build
  - kind: can_observe
    from: rev.r2
    to: dev.qa
```

---

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | string | yes | — | Use `"0.2"`. Any non-empty string validates; a spec is treated as pod-aware because `pods` is an array. |
| `name` | string | yes | — | Rig name. Used in session naming (`{pod}-{member}@{name}`), snapshot identification, and spec library lookup. `rig up <spec> --name <rig>` launches the spec under another name instead (see below). |
| `summary` | string | no | — | Human-readable description. Shown in the spec library, review surfaces and `rig specs preview` (in `rig specs show` only with `--json`). |
| `culture_file` | string | no | — | Relative path to a rig-wide culture/constitution file. Must be a safe relative path (no `..`, no absolute). |
| `non_interruptive` | boolean | no | — | Pod-aware rig launch-warning default. With full-bypass Claude/Codex seats, true accepts or hides supported harness warnings using launch flags. Explicit CLI choices override this field; this field overrides the machine default. It does not grant permissions, change native settings files, or bypass login. |
| `permission_policy` | string | no | — | Permission policy attached to the rig. Either a built-in (`builtin:locked`, `builtin:standard`, `builtin:open`, `builtin:yolo`, `builtin:auto`) or a safe relative path to a custom policy file (resolved from this spec's directory; no `..`, no absolute, no empty segments, each segment `[A-Za-z0-9][A-Za-z0-9._-]*`), or `none`, a recorded choice of the floor. Absent uses the default floor with the scoped team launch allowances described below. A bare built-in name such as `yolo` is refused ("use 'builtin:yolo'"), and so is an explicit `null`. A custom file that is missing, unreadable or invalid isn't a validation error: it resolves to the floor, and preflight warns. A member may set its own `permission_policy` (not on a terminal member), which takes precedence over the rig-level one; there is no pod level. See "Attaching a permission policy" below. |
| `env` | map | no | — | Launch environment for every seat in the rig: `NAME: value` pairs. A member's own `env` overrides it name by name. Names match `^[A-Z_][A-Z0-9_]*$`, names starting `OPENRIG_` are reserved, and values must be non-empty strings (quote numbers and booleans). Values are not secret. See "Launch environment" below. |
| `managed_blocks` | map | no | `CLAUDE.md` | File that receives OpenRig's managed instruction blocks for Claude Code members. Only the `claude-code` key is accepted, with `CLAUDE.md` or `CLAUDE.local.md`. Codex, Pi and OMP members use `AGENTS.md`. See "Choosing the Claude instruction file" below. |
| `workspace` | object | no | — | The rig's workspace: `workspace_root` (required), `repos[]` of `{name, path, kind}` with `kind` one of `user`, `project`, `knowledge`, `lab` or `delivery` and unique names, an optional `default_repo` naming one of them, and an optional `knowledge_root`. Relative repo paths resolve against `workspace_root`. |
| `docs` | Doc[] | no | — | Documentation files that should travel with the rig. Included in rig bundles. Each entry has a `path` field (safe relative path). The engine does not consume these — they are for humans and agents setting up the environment before launch. |
| `startup` | StartupBlock | no | — | Rig-level startup files and actions. Applied to all members via the startup layering model. |
| `services` | ServicesBlock | no | — | Optional managed services (Docker Compose). When present, `rig up` boots them before any agent launches; `rig import` doesn't boot them. |
| `pods` | Pod[] | yes | — | At least one pod required. Each pod is a bounded context containing members and pod-local edges. |
| `edges` | CrossPodEdge[] | no | `[]` | Cross-pod edges connecting members in different pods. Must use fully-qualified `pod.member` IDs. |

**Launching one spec under another name.** `rig up <spec> --name <rig>` creates the rig as `<rig>` instead of the spec's `name:`, so one spec can run as several rigs at once, for example `--name alpha` and `--name beta`, with seats `{pod}-{member}@alpha` and `{pod}-{member}@beta`. The spec file is not changed. The rig keeps the chosen name from then on: `rig ps`, `rig down alpha`, `rig up alpha --existing`, snapshots and restore all use it. The same checks as a launch without `--name` apply to the chosen name: a running rig of that name refuses the launch, and a stopped one is archived and replaced, as an explicit spec import does today. `--name` does not rename an existing rig, so the CLI refuses it with the name of an existing rig to restore, with a topology and with a GitHub bundle link. A library spec name works: `rig up starter --name beta` launches the library spec as `beta` even while a rig named `starter` exists. Over `--host`, pass the spec path or bundle file with `--name`. A spec that sets `services.project_name` refuses `--name`: every rig launched from it would share that Compose project, and `rig down` or a failed service boot of one would stop the others' services. Without `project_name`, each rig gets its own project. Two launches of the same spec started at the same moment can answer 409 (already in progress for this source) even under different names; start them one after the other.

### Starting one materialized seat

`rig import ./team.yaml --materialize-only` records the team without starting its harnesses.
For a seat that has never started, use its positional logical ID:

```bash
rig launch <rig-id> dev.lead --json
```

This starts only that seat, preserving the rig's node IDs and the other seats. The daemon retains
the materialized declaration and resolves its agent and startup files from the original source
root at launch time; keep those files available. Current saved model, effort and permission
choices take precedence over the retained declaration; launch reports the differences. A prior snapshot isn't required. Seats with
session history continue through restore. Explicit `--snapshot-id` and `--seats` use restore too.
`--plan` previews restore selection; it requires a snapshot and does not preflight this first start.
Rigs materialized by older daemons lack the retained declaration; this path doesn't retrofit them.

### Attaching a permission policy

Attach a policy to a rig with `permission_policy`, either at the rig level or on a member:

```yaml
# a built-in, by name:
permission_policy: builtin:standard

# or a custom policy file, by relative path (resolved from this spec's directory):
permission_policy: policies/my-cautious-dev.policy.md
```

Built-in policies (`locked` / `standard` / `open` / `yolo` / `auto`) are read-only and are
referenced as `builtin:<name>`. A custom policy lives in your own project and is
referenced by a safe relative path (no `..`, no absolute). A shipped example of the
custom shape is `packages/daemon/policies/examples/my-cautious-dev.policy.md` — copy it
into your project and edit it to taste.

This records a selection, not a live permission change. Flag-surface policies
select launch flags; config-surface policies still need native configuration
application and inspection. In particular, `builtin:yolo` selects Codex's
`danger-full-access` sandbox and `never` approval policy, and replaces
any `codex_config_profile` argument. See [practical permission choices](getting-started.md#opt-in-permissive-operation).

An explicit `rig seat set-permissions` choice overrides member/rig policy for
future managed launches of that stable seat; it does not rewrite this spec or
its inherited policy provenance. `inherit` removes that override. See
[per-seat permission mode](getting-started.md#per-seat-permission-mode).

### Per-member Claude tool rules

Claude members can record tool rules independently, even when they share a project folder:

```yaml
claude_permissions:
  allow: ["Bash(node lane-reader.mjs *)"]
  deny: ["Read(./private/**)"]
```

This field accepts only `allow` and `deny` lists of native Claude rule strings. It is
also supported on legacy flat Claude nodes. Other runtimes, `ask`, mode settings,
arbitrary settings and parenthesized MCP rules are rejected. Shape validation does
not establish support by every Claude version.

The initial spec records the rules on the stable seat. For an existing seat, put the
complete replacement in a JSON file and use the existing audited permission command:

```sh
rig seat set-permissions dev-reader@team --rules member-rules.json --reason "Select the reader lane"
rig seat status dev-reader@team --json
```

Choose either `--rules` or `--mode`, never both. Empty allow and deny lists clear the
seat's rules. Updating rules leaves the permission mode, running process and history
unchanged; they apply at the next separately authorized managed launch or resume.
Restore and same-seat handover read that same record. A fork copies the source's
currently recorded rules independently, including retained-seat updates. Export
contains the current record. An invalid or unreadable record refuses that seat's
launch, fork or export with a repair message rather than silently omitting its denies.

OpenRig composes these rules into its one operational `--settings` value, preserving
team/kernel defaults, hooks and managed-compaction settings. It never writes them
into the shared project's Claude settings. Without the field or a recorded update,
launch arguments are unchanged. Status reports the next-launch plan and lists the
added rules; it does not verify native enforcement.

Rules add to inherited native permissions; an allow list cannot withdraw broader
user or project grants. In bypass mode, allows do not constrain access. Managed
policy and installed mods can change rule behavior; see [Claude's permission
precedence](https://code.claude.com/docs/en/permissions#precedence-among-rules-hooks-and-mods).
These are native tool rules, not OS-user or credential isolation. Native acceptance
and effects must be checked on the Claude version and configuration being used.

**Downgrade:** a file-backed SQLite and launch-composition check against the
pre-feature reader at `75c1f045` found that it can open the upgraded database but
omits the recorded rules from launch arguments. This pair is not
restriction-preserving. The stored bytes survive and the supporting reader recovers
them; a process already launched by older code is unchanged. Keep a copy of the
intended rules and establish equivalent native restrictions before using an older
managed-launch path. Other version pairs and native enforcement need their own checks.
The launch still uses inline JSON, subject to the operating system's argument-size
limits.

### Per-member Codex permissions

Codex members can record their own sandbox and approval choice, even when they share a project folder:

```yaml
codex_permissions:
  sandbox: workspace-write        # workspace-write or read-only
  approval: never                 # never, on-request or untrusted
  network_access: false           # workspace-write only
  writable_roots: ["/abs/lease"]  # workspace-write only; absolute paths
  exclude_tmpdir_env_var: false   # workspace-write only
  exclude_slash_tmp: false        # workspace-write only
```

OpenRig emits this envelope as explicit `-s`, `-a` and `sandbox_workspace_write.*` flags on
every managed launch and resume of the seat (fresh, both resume paths, restore and same-seat
handover), so a named `codex_config_profile` or a policy posture doesn't override those fields.
Omitted workspace-write fields are recorded as `false` or `[]` and emitted as such. Full access
is not an envelope: it stays the `full_bypass` mode. The envelope is the seat's explicit choice,
so team and kernel launch defaults don't apply to it, and status names the policy posture or
ambient `OPENRIG_YOLO` it replaces. With workspace-write, OpenRig still adds its queue-state root
and, on a fresh launch, git metadata folders; with read-only it adds no writable roots. It adds
no network setting of its own. Codex's implicit roots (the working directory and temporary
folders) still apply: this is a native sandbox and approval selection, not a complete
filesystem or credential-isolation guarantee. OpenRig's tests prove these launch flags, not
that Codex enforces them, so check the seat's actual behaviour before relying on a narrower
envelope. An OpenRig older than 0.7.3 doesn't read a recorded envelope, so after a downgrade
the seat launches without it. The field is also supported on legacy flat Codex nodes; other
runtimes reject it.

For an existing seat, put the envelope in a JSON file, or change its profile, with the existing
audited permission command:

```sh
rig seat set-permissions dev-impl@team --codex-permissions envelope.json --reason "Narrow the implementer"
rig seat set-permissions dev-impl@team --codex-profile lease-impl --reason "Use the lease profile"
rig seat status dev-impl@team --json
```

Choose one of `--mode`, `--rules`, `--codex-permissions` or `--codex-profile` per call. A seat
keeps one explicit permission choice: setting an envelope replaces a recorded mode, and setting
a mode (including `inherit`) clears the envelope, in the same audited write that names both.
A runtime switch keeps the envelope while the seat runs Claude Code and applies it again when
`rig seat set-runtime` brings the seat back to Codex. A switch back to Codex with an explicit
`--permission-mode` replaces the envelope when the switch commits, and the switch's plan and
event name it. A switch that doesn't commit leaves it in place.
A profile name is separate from the envelope and from approval: a resumed conversation keeps
its saved approval unless an envelope sets one. `--codex-profile inherit` clears the profile.

The profile command checks the profile in the config home this seat's launches use: the seat's
own `CODEX_HOME` when its `env:` declares one, else the daemon's explicit `CODEX_HOME`. There it
reports an absent file (Codex loads it as an empty layer, so base config applies), records the
file's hash so a later check can report a change, and refuses a profile that fails to load,
keeping the previous one. When neither sets a `CODEX_HOME`, a seat's pane keeps its own, and the
command reports the profile as unverified rather than checking a different home. Every launch
still runs the native profile check.

Updates leave the running process and history unchanged; they apply at the next separately
authorized managed launch or resume. Restore reads the seat's current record, so an older
snapshot doesn't bring back a replaced profile. A fork copies the source's current profile and
envelope independently. Export contains the current record. A new generation from `rig up
<spec>` starts from the spec. An invalid or unreadable envelope refuses that seat's launch, fork
or export with a repair message rather than launching broader. Without the field or a recorded
update, launch arguments are unchanged.

**Downgrade:** an older OpenRig keeps the stored envelope but doesn't read it, so its launches
of the seat use the earlier posture decision, which can be broader. This is not
restriction-preserving. Keep a copy of the intended envelope and establish equivalent native
restrictions before using an older managed-launch path. Native enforcement must be checked on
the Codex version and configuration being used.

### Team launch defaults

A non-kernel Claude or Codex seat with no authored permission policy, explicit
seat permission selection, or named Codex profile receives the team launch
default. An explicit policy, including `none` or `builtin:locked`, keeps its
existing meaning. The default is derived again for fresh launch, resume, fork
and handover; it is not saved as a user choice. Kernel, Pi and terminal behavior
is unchanged.

Claude keeps `acceptEdits` and receives inline session settings allowing ordinary
`rig` commands, project reads and common project test commands (for example,
`npm test`, `pnpm test`, `pytest`, `go test` and `cargo test`). Lifecycle commands
such as `rig up`, `rig down`, `rig restore`, `rig bundle install` and seat stop or
handover ask through a session `PreToolUse` hook. Their literal help forms, such
as `rig down --help`, `rig bundle install -h` and `rig help down`, run without
that lifecycle prompt. Native personal, project and managed deny/ask rules still
apply; OpenRig does not remove or override them.

For allowances, the hook recognizes literal command words (including quoted or absolute paths),
leading environment assignments that do not change executable lookup or startup,
and `env`, `command` and `exec` wrappers without options other than `--`.
Relative executable paths and assignments such as `PATH` or `NODE_OPTIONS` stay
with native checks. The same existing team allowances apply after spelling
normalization; project `node_modules/.bin/vitest` and `jest` paths match their
existing `npx` allowances. It does not automatically allow pipelines, command
substitutions, redirects, heredocs, shell functions or other unrecognized syntax.
Lifecycle prefixes are checked at every word position, including after wrappers,
control-flow words and CLI argument separators. A `--` separator before or after
the subcommand ends option parsing, so a later `--help` is an operand and still
asks. Ask detection also scans with comment text retained, so a `#` inside a
substitution does not hide a later lifecycle command. Unquoted prose or comments
containing a lifecycle command may also ask; ordinary trailing comments do not
change allowance matching. Quoted messages and quoted heredoc bodies remain data.
Arithmetic shifts are not treated as heredoc operators. These are command
allowances, not containment: a project's test command can execute code. The
hook and allowances are passed with `--settings` at launch, including resume
and fork; nothing is written to personal or project permission files.

If the helper asset is missing at launch, OpenRig falls back to the native lifecycle
ask rules; help can prompt in that fallback. A helper that disappears or times out
after launch cannot supply a decision, leaving Claude's remaining native rules
in effect. The hook is a convenience policy, not a containment boundary.

Codex keeps `workspace-write` with its existing approval policy and receives the
configured OpenRig workspace root plus its pod's shared state directory as
additional writable directories. The team workspace preparer creates missing
directory ancestors and excludes the home directory and its ancestors from its
prepared scopes. Unavailable optional directories are warned about and omitted
from that list without blocking launch. When no prepared scopes remain, the
runtime adapter retains its existing pod-state `--add-dir` fallback, which this
step does not prepare. This does not modify Codex permission files or enable
non-interruptive mode.

**Codex lifecycle commands do not gain a new approval rule.** With Codex's
existing `on-request` policy, non-escalated sandboxed commands, including
`rig up` and `rig down`, can run without asking. This default addresses writable
workspace access; it does not promise a lifecycle confirmation prompt.

### Built-in permission policies

The five built-ins live in `packages/daemon/policies/builtin/`. Action names are the
policies' own semantic classes.

| Policy | Surface | Runs without asking | Asks a person | Denied |
|--------|---------|---------------------|---------------|--------|
| `builtin:locked` | config | `run_toolchain` (npm, node, tsc, tests, lint), `rig_up`, `rig_down` | nothing | everything else (`default_posture: deny`) |
| `builtin:standard` | config | everything not listed, including `push_to_remote` (`default_posture: allow`) | `create_pr`, `publish_package`, `merge_or_release`, `force_push`, and the destructive class | nothing |
| `builtin:open` | config | everything, including PRs, publishing, merges and force pushes (`default_posture: allow`) | the destructive class only | nothing |
| `builtin:yolo` | flag (`launch_posture: full_bypass`) | everything; the runtime's permission prompts are bypassed at launch | nothing | nothing |
| `builtin:auto` | flag (`launch_posture: auto`) | Claude runs with `--permission-mode auto`; Codex, Pi and OMP launch at the floor | Claude: decided by auto mode; others: as at the floor | Claude: decided by auto mode; others: as at the floor |

The destructive class is `delete_everything`, `drop_persistent_store` and
`reset_or_discard_vcs`; `builtin:locked`'s list also names `delete_files` and `force_push`.

**At launch.** `builtin:yolo` selects Claude `--dangerously-skip-permissions`, Codex
`-s danger-full-access -a never`, and Pi `--approve`. `builtin:auto` selects Claude
`--permission-mode auto`, while Codex and Pi do not have an auto mode and launch at the floor.
Every other seat launches at the floor (a non-kernel seat with no policy also gets the
[team launch default](#team-launch-defaults) above):
- Claude `--permission-mode acceptEdits`;
- Codex `-s workspace-write`, or `-p <profile>` when the member sets
  `codex_config_profile`, in which case the profile governs its own sandbox;
- Pi `--no-approve` by default.

Seats of the rig named `kernel` are the exception. With no member or rig policy, no
per-seat choice and (for Codex) no named profile, Claude launches in `acceptEdits` with a
per-launch `--settings` allow list for its file tools and operational commands, and Codex
launches with `-s danger-full-access -a never`, plus per-launch `-c` overrides that hide its
full-access and GPT-5.1 migration notices, whatever the rig's non-interruptive choice.

**Config-surface policies are recorded, not applied at launch.** The seat still starts at
the floor. The `allow`, `ask` and `deny` rules take effect once they are translated into the
runtime's native settings. The `applying-a-permission-policy` skill in `openrig-core` does
that translation, with per-runtime limits. For example, Claude's prefix rules can't
reliably tell `git push --force` from `git push`. An `ask` waits for a person, so it pauses
an autonomous seat. Standard suits interactive work, and the policy files point
autonomous teams to Open or YOLO.

**Pi has no permission policy.** `--approve` and `--no-approve` set Pi's resource trust. The
OMP variant maps that trust to its approval mode: `yolo` under `--approve`, otherwise
`always-ask`.

**A custom policy file** is Markdown with frontmatter: `policy_schema_version: 1`, `name`,
`source: custom`, `description`, and `surface`.
- `surface: flag` adds `launch_posture` (`floor`, `full_bypass` or `auto`).
- `surface: config` adds `default_posture` (`allow`, `ask` or `deny`) and the `allow`, `ask`,
  `deny` and `destructive_class` lists (`[]` for none).

**Claude Code's own checks.** The first time Claude Code starts an interactive session
with permissions bypassed, it shows a warning dialog asking you to accept responsibility;
declining exits. OpenRig reports such a seat as `attention_required` and holds its startup
context for `rig seat continue`; `rig up --non-interruptive` or `rig bundle install
--non-interruptive` accepts the warning with a launch flag instead (see
[non-interruptive mode](non-interruptive-mode.md)). That choice is saved on the rig, not in
`rig.yaml`. On Linux and macOS Claude Code refuses that mode when run as root or under `sudo`,
except inside a recognized sandbox. See Claude Code's
[Choose a permission mode](https://code.claude.com/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).

### Launch environment

`env:` sets environment variables for the seats of a rig, so a team can share a setting such as a feature flag, a region or a log level without every member hand-editing a shell profile. Declare it on the rig, on a member, or both:

```yaml
env:
  LOG_LEVEL: info
  REGION: eu
pods:
  - id: dev
    members:
      - id: impl
        runtime: claude-code
        env:
          LOG_LEVEL: debug   # overrides the rig's value for this seat only
```

- A seat gets the rig's `env` with its own `env` laid over it, name by name.
- The same environment is applied on first launch, on `rig up <rig-name>` restore, and to the successor of a seat handover.
- `rig up <spec> --env KEY=VALUE` (repeatable) adds or overrides a value for one launch, except `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, which the CLI leaves out with a note (see "A seat's own account" below). A one-off value belongs to the terminal that launch creates: it stays in that terminal's environment for as long as the terminal lives, and OpenRig removes it from the tmux session's environment as soon as the terminal has started, so a terminal started later in that session does not get it. If OpenRig can't take it out, the seat keeps running and the launch warns, naming the variable and the tmux command to put it back or remove it. Until then, a terminal started later in that session would get it. A restore, a handover successor or any later launch starts from the spec's `env:` alone, so the value is not saved and does not carry forward. To keep a value, put it in `env:`. One exception to "does not carry forward", for a managed Claude seat (see below): a one-off name that the seat's spec does not declare stays on the session's list of names, `OPENRIG_SEAT_ENV_KEYS` (names only, no values), because the first launch and an in-place restart of the same terminal read that list. So if a later pane in that session gets a value for that name from the tmux server's own environment, its managed Claude launch can forward that value, where a launch without `--env` would leave it out. The first launch's one-off value itself is not passed on to that pane. This comes from reading the code and has not been measured. `--env` does not apply to `rig up <rig-name>` (a restore) or to a topology (several rigs from their own specs); the CLI refuses both. For a topology, put `env:` in each rig's spec.
- **The runtime directory, on Linux.** When the daemon runs with an absolute `XDG_RUNTIME_DIR` (usually `/run/user/<uid>`), a seat gets the same `XDG_RUNTIME_DIR`, so a tool that keeps its socket there, such as an MCP server's daemon or `gpg-agent`, works inside the seat without per-tool setup. It comes with `DBUS_SESSION_BUS_ADDRESS=disabled:`, an address that D-Bus clients refuse. sd-bus, GDBus and libdbus look for your session bus at `$XDG_RUNTIME_DIR/bus`, or start one, only when that variable is unset, so a seat doesn't find your session bus (the keyring, notifications) on its own. This is a default, not isolation: `systemctl --user` reaches your service manager through its own socket in the runtime directory, as any tool there can.
  - A seat's own value wins. Set `DBUS_SESSION_BUS_ADDRESS` in `env:` to give a seat a bus. Set `XDG_RUNTIME_DIR` there to choose the directory yourself; the seat then gets no bus address, as before, so its D-Bus clients find the bus in that directory. A name listed in tmux's `update-environment` counts as the seat's own too.
  - A shell startup file that runs in the seat's terminal can still change either name. One that sets only `XDG_RUNTIME_DIR` now leaves the seat with `disabled:`, where before its clients found your bus; set the bus address in `env:` or in that file to keep it.
  - With `terminal.inherit_tmux_environment` on, a seat gets tmux's environment as before, and OpenRig adds neither name. On macOS, and for a daemon started without `XDG_RUNTIME_DIR`, nothing changes.
  - Codex passes only a fixed list of variables to the MCP servers it starts, so a Codex seat's MCP server gets the runtime directory only when its entry in `config.toml` names it: `env_vars = ["XDG_RUNTIME_DIR"]`. Codex's hooks and shell commands get it without that, and so do Claude Code's MCP servers and hooks. Pi and OMP agent processes don't get it (see below).
  - It applies at a seat's next launch, restore or handover; a seat that is up keeps the environment it started with.
- Names starting `OPENRIG_` are reserved for OpenRig and refused. Empty values are refused, because the launch omits empty variables.
- `rig export` writes the rig and member `env:` back out.

**Where the declared names reach, by runtime.** Declared values are handed to the seat's terminal as tmux environment, so most seats take them as given:

- Plain Claude Code (no permission mode selected), Codex and terminal seats take a spec `HOME`, `PATH` or `CLAUDE_CONFIG_DIR` as given.
- The cleared environment (`env -i`) belongs only to a managed Claude launch, which is the one used when a permission mode is selected for the seat (for example `permission_policy: builtin:auto`). It forwards the declared names through the cleared environment, except `PATH`, `HOME` and `CLAUDE_CONFIG_DIR`, which OpenRig sets for that launch itself, and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, for which it sets its own renderer setting. A spec value for any of those four is not forwarded as such; an absolute `CLAUDE_CONFIG_DIR` becomes the config dir OpenRig sets (see "A seat's own account" below). A seat that selected the shipped `openrig-core` plugin also has `CLAUDE_CODE_PLUGIN_DIRS` (the vendored plugin, added after a list the seat declares itself) among its declared names, so it is forwarded like the others and the plugin's hooks load in a seat with a permission mode as in one without; a seat that didn't select the plugin has no such name added. Beyond the declared names, the launch also forwards, by name and only when the seat's terminal has them set, the terminal and locale variables (`TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LANG` and the `LC_*` names) and the person's editor and display session: `EDITOR`, `VISUAL`, `DISPLAY`, `XAUTHORITY` and `WAYLAND_DISPLAY`. They let Claude's external-editor action open the person's editor and let image paste reach the clipboard, without a value in a spec. `WAYLAND_DISPLAY` is passed as an absolute path: an absolute value is kept, and a relative one is joined to the terminal's `XDG_RUNTIME_DIR`; if the terminal has no `XDG_RUNTIME_DIR` for it, the name is left out. The runtime directory and its `disabled:` bus address (see "The runtime directory, on Linux" above) are forwarded together, and the runtime directory is also forwarded beside a declared `DBUS_SESSION_BUS_ADDRESS`. A terminal's own `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`, from a shell startup file or tmux's `update-environment`, is not, because D-Bus clients look for the session bus at `$XDG_RUNTIME_DIR/bus` when no address is set; declare it in `env:` to forward it. `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP` and `SSH_AUTH_SOCK` are not forwarded. A running seat picks the names up at its next managed Claude launch, not before: `rig seat launch <seat> --fresh --stop --reason "<why>"` for that seat alone (a new conversation), or a restore of the whole rig (`rig down <rig>`, then `rig up <rig> --existing`, which resumes each conversation but restarts every seat in the rig), or a handover. A seat that is up keeps the environment it started with.
- Codex seats run OpenRig's own Codex executable whatever a spec `PATH` says. They use the seat's own `CODEX_HOME` when its `env:` declares an absolute one, else the daemon's when the daemon has one.
- On Pi and OMP seats the values reach the terminal. The agent process gets only what the runner passes on, so a spec or one-off value reaches it only for the names the runner always passes: `PATH`, `HOME`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SHELL` and `TMPDIR`. Pi's agent process receives the runner's `HOME`, so a spec or one-off `HOME` value that reaches the runner is passed to Pi; OMP's agent process gets its seat state directory (`$OPENRIG_HOME/state/omp/<seat>`, see Oh My Pi below) as `HOME`, so a `HOME` value does not reach it. The selected provider's variables are passed separately, as described under each runtime.

**A seat's own account.** Claude Code keeps its login in its config dir and Codex in its home, so a seat whose `env:`
declares an absolute `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex) runs on whatever login that directory
holds. The member's value wins over the rig's. OpenRig follows it everywhere it launches or reads that runtime: the
launch, Claude's first-run trust settings, Codex's managed `config.toml`, hooks and plugin, conversation capture for
resume, context usage, `rig seat status` and `rig provider status`. A value that isn't an absolute path isn't used:
the seat resolves as if it declared none, and `rig seat status` shows the ignored value. Name the home in `env:`: a
one-off `rig up --env` value for either variable isn't applied, because a restore, a handover and `rig seat status` read
only the stored `env:`. Seats may share a home. Live usage refresh (`rig provider status --refresh`) still reads only the
daemon's own logins; reading each seat's home would need a native reader per home. OpenRig doesn't copy logins or conversation history between homes, so a conversation saved under a seat's earlier home
doesn't resume after the seat moves to another one. The `openrig-user` skill has the setup steps.

**Do not put secrets in `env:` or `--env`.** The values are not secret, and nothing here encrypts or hides them (see #306):

- Spec values are stored in OpenRig's database and in rig snapshots, and `rig export` and bundles copy them, so a secret put there by mistake travels with the rig.
- While a seat launches, the values are passed to tmux as command arguments, so other users and processes on the same machine can see them for that time. They then sit in the seat's process environment. Only the managed Claude launch command is value-free: it forwards names, and the terminal supplies the values.
- A one-off `--env` value is not stored in the database or in snapshots, but it reaches tmux the same way, so it is visible in the same ways while that launch runs.

Use `env:` for settings only. Credentials belong in the provider's own login or a secret store the seat reads at run time.

### Choosing the Claude instruction file

OpenRig writes its instructions for Claude Code members into managed blocks in
the member's working directory. By default the file is `CLAUDE.md`. If your
repository tracks `CLAUDE.md`, write the blocks to `CLAUDE.local.md` instead:

```yaml
managed_blocks:
  claude-code: CLAUDE.local.md
```

Claude Code loads `CLAUDE.local.md` from the working directory as well. By
convention the file is kept out of git, for example with a `.gitignore` entry.

- Accepted values are `CLAUDE.md` and `CLAUDE.local.md`. Any other value or
  runtime key is rejected before a member launches.
- The setting applies to launch, restore, relaunch, handover, adding members,
  and export. `rig down` removes OpenRig's blocks from the selected file only.
- OpenRig never edits, moves or deletes blocks in the other file.

A rig that already wrote blocks into `CLAUDE.md` keeps them there after you
switch. Until you remove them, `CLAUDE.md` stays modified and Claude Code loads
both copies. Delete each `<!-- BEGIN OpenRig MANAGED BLOCK: … -->` …
`<!-- END OpenRig MANAGED BLOCK: … -->` section by hand and keep the rest of the
file. If `CLAUDE.md` has no other uncommitted edits you need to keep, you can
instead run `git restore CLAUDE.md`; that command discards every unstaged change
to the file, not only OpenRig's blocks. Running `rig down` on a rig that still uses
the default is not a substitute: it strips every OpenRig block from that
directory's `CLAUDE.md`, including blocks written by other rigs.

---

## Pod

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Pod identifier. Must not contain dots or `@`. Must be unique within the rig. Used as the first segment of session names and logical IDs. |
| `label` | string | yes | — | Human-readable pod name. Shown in UI explorer, graph groupings, and detail surfaces. |
| `summary` | string | no | — | Pod description. |
| `continuity_policy` | ContinuityPolicy | no | — | Pod-level continuity/restore policy, validated and stored with the pod (see "Continuity Policy"). |
| `startup` | StartupBlock | no | — | Pod-level startup files and actions. Applied to all members in this pod via the startup layering model. |
| `members` | Member[] | yes | — | The pod's members. It must be an array; validation doesn't refuse an empty one. |
| `edges` | PodLocalEdge[] | no | `[]` | Edges between members within this pod. Must use unqualified member IDs (not `pod.member`). |

### Pod ID Rules

- Must not contain dots (`.`)
- Must not contain `@`, which separates the pod/member portion from the rig name in session addresses
- Must be unique across all pods in the rig
- Becomes the first segment of the qualified logical ID: `{podId}.{memberId}`
- Becomes the first segment of the canonical session name: `{podId}-{memberId}@{rigName}`

---

## Member

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | — | Member identifier. Must not contain dots or `@`. Must be unique within the pod. |
| `agent_ref` | string | yes | — | Reference to an AgentSpec. Must start with `local:` (relative) or `path:` (absolute). Exception: `builtin:terminal` for infrastructure nodes. |
| `profile` | string | yes | — | Profile name from the referenced AgentSpec. Use `default` for the default profile. Exception: `none` for terminal nodes. |
| `codex_config_profile` | string | no | — | Codex-only native profile passed as `-p <name>`; letters, numbers, `_`, `.`, `-`. Separate from the AgentSpec `profile`. With the normal launch mode, this replaces OpenRig's explicit workspace-write sandbox flag. A full-bypass policy instead emits danger-full-access and omits this profile argument. |
| `codex_permissions` | mapping | no | — | Codex-only sandbox and approval envelope, emitted as explicit flags on every managed launch and resume; see [per-member Codex permissions](#per-member-codex-permissions). |
| `runtime` | string | yes | — | Agent runtime. Current supported values: `claude-code`, `codex`, `pi`, `omp`, `terminal`, `stub`. `stub` is a deterministic test harness, not an agent: a Node runner in the seat's tmux pane goes through the normal launch, skill projection, startup-file and readiness path, follows `<cwd>/.openrig/stub/script.json` when present, and calls no model. See "What a stub can and cannot prove" in `docs/as-built/test-layers.md`. |
| `cwd` | string | yes | — | Working directory for the agent. A relative path resolves against the rig root (the directory containing the rig spec). If that path exists as written, it is used. Otherwise a leading `~` or `~/` expands to the home directory (`~user` does not) and `$VAR` / `${VAR}` expand from the daemon host's environment; a relative result still resolves against the rig root. A reference to an unset variable stays as written, so the cwd is that literal path and works only if it exists. Use `"."` for the rig root itself. Can be overridden at launch time with `rig up --cwd`. A cwd inside the OpenRig installation fails preflight unless `--cwd` is given. Editing this declaration does not update an existing seat; use [`rig seat set-cwd`](agent-startup-guide.md#change-an-existing-seats-working-directory) to save its future launch directory. |
| `label` | string | no | — | Human-readable member name. Shown in UI when present. |
| `model` | string | no | — | Model override. Runtime-specific (e.g., `claude-opus-4-6` for Claude Code). |
| `effort` | string | no | — | Reasoning effort override, trimmed. Claude gets `--effort`, Codex `-c model_reasoning_effort=…`, Pi `--thinking` (see "Pi" below). A non-string value is ignored with an advisory. |
| `advisor` | string | no | — | Claude-only Advisor model for this seat. Overrides the AgentSpec profile/default; blank or non-string values are ignored with an advisory. |
| `permission_policy` | string | no | — | Member-level permission policy; overrides the rig's. Not valid on terminal members. |
| `env` | map | no | — | Launch environment for this seat, laid over the rig's `env`. Same rules as the rig-level field. Valid on terminal members too. See "Launch environment" below. |
| `agent_file` | string | no | — | Claude members only. A Claude agent definition (a `.md` file with `name` in its frontmatter) for this seat. It's copied into the seat's own storage and launched as `--agent openrig:<name>`. A path beside the spec: no `..`, not absolute. |
| `append_system_prompt_file` | string | no | — | Claude members only. A prompt file appended to Claude's system prompt for this seat. It's copied into the seat's own storage and passed as `--append-system-prompt-file`. A path beside the spec. |
| `plugin_dirs` | list | no | — | Claude members only. Claude plugin folders for this seat, each copied into the seat's own storage and loaded through `CLAUDE_CODE_PLUGIN_DIRS`. Paths beside the spec. Each is copied under its folder name, so two folders with the same name are refused; an empty list is none. A missing file or folder fails that seat's launch by name. `rig bundle create` carries all three; `rig export` names a seat whose additions it doesn't carry. |
| `role` | string | no | — | The seat's role, letters, digits, `_`, `.` and `-`. Not valid on terminal members. |
| `restore_policy` | string | no | the AgentSpec's | Restore behavior. One of: `resume_if_possible`, `relaunch_fresh`, `checkpoint_only`. The default comes from the AgentSpec's `defaults.lifecycle` (else `resume_if_possible`) as narrowed by its profile; a member value may only narrow it further, in that order. |
| `compaction_strategy` | string | no | — | `default-compaction`, `managed-compaction`, `handover` or `apprentice-handover`; `harness_native` and `pod_continuity` are accepted as deprecated aliases, and `custom_prompt` is refused. `managed-compaction` and `apprentice-handover` create their jobs only for `claude-code` seats; see [Codex compaction and sizing](agent-startup-guide.md#codex-compaction-and-sizing). |
| `mechanic` | string | no | — | A canonical `seat@rig` session address, for `apprentice-handover`. |
| `session_source` | object | no | — | Start the seat from an existing session: `fork` with `native_id`, `rebuild` with `artifact_set`, or `agent_image` with `image_name`. A Claude Code `fork` needs Claude Code 2.0.73 or later. Not valid on terminal members. |
| `starter_ref` | object | no | — | `{ name }` of an agent starter (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`) whose files lead the seat's startup. Not valid on terminal members or with a fork. |
| `startup` | StartupBlock | no | — | Member-level startup files and actions. Applied only to this member. |

### Claude Advisor (`runtime: claude-code`)

Set `advisor` independently of the primary `model`:

```yaml
members:
  - id: owner
    agent_ref: local:agents/implementer
    profile: default
    runtime: claude-code
    cwd: .
    model: claude-sonnet-5-5
    effort: medium
    advisor: opus
```

OpenRig passes `--model claude-sonnet-5-5 --effort medium --advisor opus` to this
Claude session. The primary model stays Sonnet. Advisor resolution uses the member's
`advisor`, then the profile's `preferences.advisor`, then the agent's `defaults.advisor`.
Blank candidates are skipped before applying this precedence. Materialization stores
the resolved value, so node/graph output, exported specs and snapshots include it even
before the first launch. Launching the original spec re-resolves its current preferences.
The selection is supplied again on resume, restore, fresh restart and handover. A fork
uses the resulting member's configuration and keeps its own conversation identity.

This requires a Claude Code version that supports `--advisor`. OpenRig never writes
`advisorModel` to user or project settings. Members sharing a checkout can therefore
choose different Advisors. When Advisor is unset, no flag is emitted and Claude's
own defaults/settings apply. Other runtimes ignore this field.

### Pi (`runtime: pi`)

`runtime: pi` launches the Pi coding agent (`pi --mode rpc`) through OpenRig's RPC runner.

- **State:** Each seat uses `$OPENRIG_HOME/state/pi/<session>/agent` as its Pi agent directory, with `sessions/` beside it, instead of your default `~/.pi/agent`. The runner sets `PI_CODING_AGENT_DIR` to that directory. `<session>` is the seat's session name, unchanged; for a pod member it is `{podId}-{memberId}@{rigName}`. `$OPENRIG_HOME` defaults to `~/.openrig`. OpenRig creates these directories at launch and does not copy anything from `~/.pi/agent`.
- **Thinking level:** A Pi seat's effort (the choice saved with `rig seat set-effort`, else the spec's `effort`) is sent to Pi as `--thinking <level>` on every managed launch and resume: fresh launch, successor and restore. Pi accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; OpenRig passes the value as written and does not translate it, so Codex's `none` is not mapped to `off`. Only a value of the shape `set-effort` accepts (a letter, then up to 31 letters, digits, `-` or `_`) is sent; any other spec value, such as one with a space or one that starts with `--`, is left out, and `rig seat effort` says so. An unfamiliar level gets an advisory (a warning from `set-effort`), never a refusal, and Pi itself ignores an unknown level with a warning and keeps the level it would use without the flag: a model suffix, the resumed session's level, or its default. With no effort resolved, no flag is sent. The effort wins over a model suffix, and the model string is never changed. `rig seat effort` reports the level sent at launch and, on Pi 0.99.0 or later, the `thinkingLevel` Pi records on this launch's latest successful assistant turn (error and aborted turns are skipped); that is the session's level after Pi's own cap, not proof the provider applied it, and it is shown apart from the level sent when they differ. On older Pi it is NOT VERIFIED. Without an effort, you can still set the level as a model suffix, for example `model: openrouter/x-ai/grok-4:high`. Pi first looks for a model whose id is the whole pin, and uses it when there is one, suffix included. Only when there is none does Pi read the suffix as the level and record the model without it. Any other suffix, such as OpenRouter's `:free`, stays part of the model id. The model-divergence check reads the pin literally when the seat's `models.json` defines a model with that exact id; otherwise it accepts the model with or without the suffix. If the seat's `models.json` can't be read, a pin with a suffix stays unchecked, with the usual warning, when the recorded model matches the whole pin or the pin without its suffix. A record that matches neither is reported.
- **Custom models:** Pi reads `models.json` from its agent directory, so a seat reads `$OPENRIG_HOME/state/pi/<session>/agent/models.json`, not `~/.pi/agent/models.json`. Custom provider and model definitions for a seat go in that file. A seat that uses only providers Pi already includes does not need one. OpenRig does not create or write `models.json`.
- **Credentials:** The Pi process receives only `PATH`, `HOME`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SHELL`, `TMPDIR`, a fixed set of OpenRig seat and instance variables, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and at most one provider key. That key is `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY` or `MINIMAX_API_KEY`, passed only when it is set in the seat's environment and the seat's `model` is written as `openrouter/<id>`, `zai/<id>`, `kimi-coding/<id>` or `minimax/<id>`. Naming that variable in `recovery.provider_auth_env_allowlist` (empty by default) makes the daemon add it, when set in the daemon's environment, to the seat's launch environment. No other variable reaches Pi, including other providers' keys and a custom provider's own key variable.

- **Extension dialogs:** The RPC runner shows extension `select`, `confirm`, `input` and `editor` requests in the pane and cancels them because the managed pane cannot answer them. The seat needs attention through the end of the turn, until a new agent run starts. Review the cancelled request and send an instruction the extension can complete without a dialog. Extension `notify` text is shown without raising attention or sending a response.

### Oh My Pi (`runtime: omp`)

`runtime: omp` launches Oh My Pi through OpenRig's RPC runner. It is separate from `runtime: pi`; OMP does not use Pi's `--name` or `--approve` flags.

- **State:** Each seat uses `$OPENRIG_HOME/state/omp/<seat>/agent` and `sessions/` instead of your default `~/.omp` profile, and runs with that seat directory as `HOME`. OpenRig does not copy OMP credentials. The runner finds the real `omp` binary before switching `HOME`, so a version-manager shim such as mise on the daemon's `PATH` still works.
- **Credentials:** Provision each seat separately, or put the provider's key variable in `recovery.provider_auth_env_allowlist` (for example `ANTHROPIC_API_KEY` or `MISTRAL_API_KEY`). The allowlist accepts the key variable of every provider in OpenRig's OMP provider map, from `anthropic` through `litellm`. A seat receives a key only when its `model` is written as `provider/id`, such as `anthropic/claude-sonnet-4-5`. Short names such as `opus` pass no key. A provider whose key is scoped to one endpoint also accepts that endpoint's variable: `anthropic`, `openai` and `litellm` each take their `<PROVIDER>_BASE_URL` — `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `LITELLM_BASE_URL`. The allowlist admits each variable on its own, so an endpoint named without its key is admitted too, which suits a keyless local proxy. The launch gate admits these endpoint names for OMP seats; the match against the seat's declared `provider/id` happens at the OMP child, which forwards a matching endpoint already in the runner's environment just as it forwards a key. OMP also reads the launch directory's `.env`, so use a trusted working directory.
- **Approval posture:** The default floor is `--approval-mode always-ask`. Because the runner is headless, OMP approval requests are cancelled and the seat stays in needing-attention after the turn ends, until the next agent run starts. A `full_bypass` permission policy selects `--approval-mode yolo`.
- **Model errors:** Errors are printed in the pane. A completed assistant failure with a numeric `errorStatus` of 408, 429, 500, 502, 503, 504, or 529 returns to idle at terminal `agent_end`, allowing an ordinary retry. Until that terminal boundary it stays in needing-attention. Intermediate `agent_end(isTerminal:false)` events do not release attention. A statusless failed retry summary retains that classification only when its attempt matches an announced retry and its final error exactly matches the latest typed transient assistant failure in that attempt. New assistant/turn boundaries invalidate the previous failure; unmatched summaries remain runtime errors. Rejected prompts, auth/configuration failures, exhausted retries without a typed transient status, and untyped errors (including text such as `529 overloaded`) retain attention until the next agent run starts. The runner does not classify diagnostic text. A transient failure does not clear a denied approval or another unresolved runtime failure in the same turn.
- **Restore:** OMP creates its session file after the first persisted turn. A new seat with no persisted turn has no resume token, so a restore leaves it awaiting a decision. Start it fresh with `rig seat launch <seat> --fresh --reason "<why>"`, the command `rig start` and `rig up --existing` print for that seat. After that file exists, OpenRig restores that exact session file. If a full rig restore leaves an OMP seat in `attention_required` or `failed`, `rig seat clear-attention` cannot yet reconcile it to `operator_recovered`, even with `--reason`, because restore reconciliation only verifies Claude Code and Codex processes ([#41](https://github.com/mvschwarz/openrig/issues/41)). Relaunch that seat with `rig seat launch <seat> --fresh --reason "<why>"`, or restore it manually. `rig seat launch --fresh` refuses a managed seat whose pane is still running unless you add `--stop`, which ends what is running there; add it only when you mean to replace that session.

### Terminal Nodes

Terminal nodes are infrastructure processes (servers, log tails, build watchers) that are not agent runtimes. They require an exact triple:

```yaml
runtime: terminal
agent_ref: "builtin:terminal"
profile: none
```

All three must be present together. Any partial combination is a validation error.

A terminal seat no longer waits for a `--fresh` decision just because it has no resume token: on restore it relaunches fresh and re-runs its startup actions. The runtime, identity and replay prerequisites still apply. A runtime mismatch still waits for a decision, an ambiguous occupant still fails, and a missing required replay file still blocks.

`rig send` to a terminal node types the exact text, without the From/To envelope that agent seats get, because the shell would run the envelope lines. The sender's output says so.

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

Example: pod `dev`, member `build`, rig `my-team` → session `dev-build@my-team`

Pod and member IDs cannot contain `@` because the first `@` separates their portion
of the session address from the rig name. Rig names may still contain `@`.

This is human-authored (you choose the pod/member IDs) and system-validated (the system enforces the format).

---

## Edges

### Edge Kinds

| Kind | Meaning | Use When |
|------|---------|----------|
| `delegates_to` | Source delegates work to target. Constrains launch order. | Orchestrator → implementer, lead → worker |
| `spawned_by` | Source was spawned by target; the target launches first. Constrains launch order. | Child → parent in hierarchical topologies |
| `can_observe` | Source can observe target's output. Does NOT constrain launch order. | Reviewer → implementer, monitor → worker |
| `collaborates_with` | Peer collaboration relationship. Does NOT constrain launch order. | Co-equal peers working together |
| `escalates_to` | Source escalates to target for decisions. Does NOT constrain launch order. | Worker → lead for escalation |

### Pod-Local Edges

Edges within a pod use **unqualified member IDs** (just the member `id`, not `pod.member`):

```yaml
pods:
  - id: dev
    members:
      - id: build
        # ...
      - id: qa
        # ...
    edges:
      - kind: delegates_to
        from: build     # NOT dev.build
        to: qa          # NOT dev.qa
```

Both `from` and `to` must reference members that exist in the same pod.

### Cross-Pod Edges

Edges between pods use **fully-qualified `pod.member` IDs**:

```yaml
edges:
  - kind: delegates_to
    from: orch.lead     # pod.member format
    to: dev.build       # pod.member format
```

Cross-pod edges must reference different pods. An edge where both `from` and `to` are in the same pod is a validation error — use pod-local edges instead.

### Changing edges on an existing rig

Use `rig edge add` to ensure relationships between seats that already exist. It
accepts a rig name or ID and **fully qualified logical IDs for both same-pod and
cross-pod edges**. This command only changes edges; it does not create pods,
restart sessions or change seat identity.

```sh
rig edge add my-rig orch.lead review.reviewer --kind delegates_to --plan --json
rig edge add my-rig orch.lead review.reviewer --kind delegates_to --json
```

Run it once per edge. It returns `added` with the new edge's ID, or `present` with
the existing edge's ID when that `{from, to, kind}` is already there, and then
writes nothing. Existing duplicate rows from other creation paths are retained;
this operation does not create more copies.

Unknown endpoints, an invalid kind or a launch-order cycle leave the graph
unchanged. Both endpoints must belong to the target rig. `--plan` performs the
same validation and returns `would_add` for a new edge without writing anything.

Each `added` receipt includes a rollback command,
`rig edge remove <rig-id> <edge-id>`, which removes exactly that edge in that rig.
Removal also supports `--plan` and `--json`. Removing an edge that is already gone changes nothing
and returns `edge_not_found` (HTTP 404, exit 1), so a repeated removal reports not found, not success.
Rig names resolve only among unarchived rigs, and an ambiguous name requires an
explicit ID. These commands target the local daemon, as `rig add` does.

A `delegates_to` edge also decides routing. A seat's stuck-row findings and recovery go to its most
recently started parent. A person's top-level Slack message in the rig's mapped channel goes to the rig's
representative, its one delegation root, unless that channel names an `inbound` seat; with no single root it
goes to Slack's inbound destination. When an added or removed edge changes either, the receipt says what
moved in `routing`:
`orchestrator: {seat, from, to}` and `representative: {from, to}`, where `null` is none. The plain output
prints a `routing:` line for each. A change that moves nothing has no `routing`, and `--plan` doesn't
preview it.

Changes are persisted immediately and included in `rig export`. Existing snapshots
remain unchanged, and restore reads the **selected snapshot's edges**. To restore
the modified topology, run `rig snapshot <rig-id>` and use its returned ID with
`rig restore <snapshot-id> --rig <rig-id>`.

---

## Startup Block

Startup blocks can appear at three levels: rig, pod, and member. They are merged additively via the startup layering model (see [the layering model](agent-startup-guide.md#the-layering-model)). The rig's `culture_file` joins as a required file with the `auto` hint in the culture layer, on both fresh start and restore.

`rig export` includes the rig's saved culture file and startup block, and now also
writes each pod's saved startup files under that pod. The file order, delivery
hints, required flags, orientation and `applies_on` selections are retained.
Previously the saved pod file lists were omitted. Pods without a recorded file
list, including older rigs, keep their existing export behavior; the exporter
does not reconstruct declarations from a member's combined startup context.

File paths remain relative to the exported spec's folder. When exporting to a
different folder, supply the referenced startup files there or import with the
original `--rig-root`. The CLI warns once per missing required rig or pod file;
missing optional files do not trigger that warning. Pod startup actions and
member startup blocks remain outside this export; keep the source spec when you
need those declarations.

### Files

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | yes | — | Relative path to the file. Must be a safe relative path. |
| `orientation` | string | no | — | Set to `role` to identify a per-seat role file for `rig queue whoami --json` and refocus. Does not change delivery or replay startup. |
| `delivery_hint` | string | no | `auto` | How the file is delivered. One of: `auto`, `guidance_merge`, `skill_install`, `send_text`. |
| `required` | boolean | no | `true` | Whether startup fails if this file cannot be delivered. |
| `applies_on` | string[] | no | `[fresh_start, restore]` | When this file is delivered. Subset of: `fresh_start`, `restore`. An exact resume of the saved conversation delivers none, apart from putting back a missing managed guidance block. |

#### Delivery Hints

| Hint | Behavior |
|------|----------|
| `auto` | System chooses based on file type and context. |
| `guidance_merge` | Merged as a managed block into the runtime's guidance file: for Claude, the `managed_blocks` file (`CLAUDE.md` or `CLAUDE.local.md`); for Codex, Pi and OMP, `AGENTS.md`. Delivered before harness boot. |
| `skill_install` | Installed as a skill in the runtime's skill directory. Delivered before harness boot. |
| `send_text` | Sent as text to the agent's terminal after the harness is ready. Requires the agent TUI to be active. |

### Actions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | yes | — | Action type. One of: `slash_command`, `send_text`, `startup_proof`. Note: `shell` is explicitly NOT supported in v1. |
| `value` | string | yes | — | Command/text to send, or `authenticated` / `none` for `startup_proof`. |
| `phase` | string | no | `after_files` | When to execute text/commands. One of: `after_files` (after startup files are delivered), `after_ready` (after harness readiness check passes). Proof selection is resolved before projection regardless of phase. |
| `idempotent` | boolean | yes | — | Whether this action is safe to run again on a restore without the earlier conversation or a retried start. **Required field.** Non-idempotent actions must NOT include `restore` in `applies_on`. |
| `applies_on` | string[] | no | `[fresh_start, restore]` | When this action runs. Subset of: `fresh_start`, `restore`. An exact resume of the saved conversation runs none (see the startup guide). |

### Startup proof selection

Startup adds no orientation exercise by default. To select the authenticated
startup challenge, declare an action in an agent, profile, rig, pod, member, or
operator startup block:

```yaml
startup:
  actions:
    - type: startup_proof
      value: authenticated
      idempotent: true
```

Use `value: none` in a later layer to select lean startup explicitly. The last
applicable declaration wins in agent → profile → rig → pod → member → operator
order. Culture contributes files, not a proof selection. With no applicable
declaration, the result is `none`; the number of startup files never selects
proof. Invalid values and non-idempotent proof declarations fail validation,
including declarations overridden later. These actions declare policy and are
never typed into a terminal.

An authenticated selection challenges only a fresh or fresh-fallback managed
agent launch. Resumed, forked, rebuilt, and adopted sessions receive no new
challenge; terminal nodes never receive one. `applies_on` follows the requested
startup context, so a fresh fallback during restore uses `restore` selections.
Keep the default `[fresh_start, restore]` to cover both fresh launch paths.

Identity delivery, projection, readiness, and ordinary startup actions still
run. `startup_status: ready` means startup completed, while `oriented: missing`
means a selected proof awaits authenticated submission. Omission/`none` yields
`oriented: n-a` on a new fresh launch and retires an older challenge without
deleting its audit history. Retirement follows successful harness launch,
before readiness checks, so attention, timeout, or a readiness exception cannot
retain the preceding proof. A replacement that fails to launch does not retire
the current proof; resume/adoption also preserves existing proof history.
The effective selection is recorded on `node.startup_pending`; actions are
persisted in startup context for restore and fresh relaunch.

The harness readiness window defaults to 30 seconds. On a loaded machine, set
`rig config set runtime.readiness_timeout_seconds 60` to give new seats and
handover successors longer to become interactive. The setting accepts 1–600
seconds, applies to the next launch without a daemon restart, and can also be
set with `OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS`. It also bounds how long a
restore keeps watching a Claude seat whose resume is still starting, so raising
it for slow fresh launches lengthens that wait too. The wait is about the
setting in total per seat, counting the usual 3.2-second check: the adapter polls
for the rest of it (nominally: it counts polls, and each poll's tmux and process
reads add a little). A restore
starts seats one after another, so each seat that never starts Claude adds up to
about this much, minus the 3.2 seconds, to the restore; the time adds up seat by
seat, and a longer setting means a longer wait before a stuck seat is reported.
A seat that is still not interactive then ends `attention_required` with its
launch and resume token kept, and the later readiness wait is skipped for it.
That holds at every setting: at 1–3 seconds there are no extra polls, but an
unresolved boot is still kept rather than failed. A pane that shows a Codex or
another conversation's Claude is not waited for. `rig up` and
`rig launch` wait 120 seconds for the daemon, so a restore of several stuck
seats can pass that (in one measurement, about 31 seconds a seat at the
default, 95 for three). A client timeout and exit code 1 do not mean the
restore was rolled back or that it should be run again; check the real state
first with `rig ps`. Apart from this, the setting does not change the time
spent by the runtime adapter before readiness polling starts.

---

## Services Block

The services block is optional. When present, services boot before any agent node launches. If service health checks fail, agent launch is blocked.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | string | yes | — | Service backend. Only `compose` is supported in v1. |
| `compose_file` | string | yes | — | Relative path to the Docker Compose file. Must be a safe relative path. Resolved relative to rig root. |
| `project_name` | string | no | stored predecessor project or unique rig-ID default | Docker Compose project name. Must match `[a-z0-9][a-z0-9_-]*`. An explicit value takes precedence. A new rig uses a stable, unique rig-ID-derived name. A same-name replacement inherits the stored project of the exact generations it replaces; conflicting predecessor projects require an explicit value. Existing stored names remain unchanged. |
| `profiles` | string[] | no | — | Compose profiles to activate. |
| `down_policy` | string | no | `down` | What happens on `rig down`. One of: `leave_running`, `down`, `down_and_volumes`. |
| `wait_for` | WaitTarget[] | no | — | Health targets that must pass before agent launch. |
| `surfaces` | Surfaces | no | — | Metadata about accessible URLs and commands. Not executed — informational only. |
| `checkpoints` | CheckpointHook[] | no | — | Shell commands for checkpoint export/import during snapshot/restore. |

### Wait Targets

Each target must define exactly one of `service`, `url`, or `tcp`:

```yaml
wait_for:
  # HTTP probe — any 2xx or 3xx response passes the HTTP wait target; redirects are not followed.
  # This proves the server answered, not application readiness.
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

Surfaces are metadata only. They are displayed in the UI and in `rig env status --json` output (the text output lists only services) but are NOT executed by OpenRig.

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
| `export` | string | yes | Shell command to export state. |
| `import` | string | no | Shell command to import state on restore. |

Checkpoint hooks are validated and stored with the spec. In this version the daemon doesn't run them during snapshot or restore, and doesn't substitute `{{artifacts_dir}}`.

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

These fields are validated, stored on the pod and written back on export. In this version nothing acts on
`sync_triggers`, `artifacts` or `restore_protocol`.

---

## Validation Rules Summary

Unknown keys at the rig, pod, member and edge levels are refused ("unknown key … refusing the spec because
normalization would otherwise discard it"). Keys inside `startup`, `services`, `continuity_policy` and `workspace` are
not checked this way. Some rules are enforced at preflight rather than validation: the runtime must be one of the
supported values, rig, pod and member names may use only letters, digits, `-`, `_`, `.` and `@` where allowed above,
each `agent_ref` must have an `agent.yaml`, Codex profiles must load, and a cwd may not be inside the OpenRig
installation.

Schema validation checks the structural rules below. Pod and member IDs containing
`@` are additionally rejected during preflight and member creation or launch; a
spec can pass `rig spec validate` and then fail at preflight or import. Run
`rig spec preflight` before creation or import.

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
22. Startup action `type` must be one of: `slash_command`, `send_text`, `startup_proof`. (`shell` is explicitly rejected.) Proof selection requires `value: authenticated` or `none` and `idempotent: true`.
23. Startup action `phase` must be one of: `after_files`, `after_ready`.
24. Startup action `idempotent` is a required boolean.
25. Non-idempotent actions must not include `restore` in `applies_on`.
26. `applies_on` values must be from: `fresh_start`, `restore`.

---

## Shipped Examples

These are the built-in specs shipped with OpenRig. Read them as worked examples.

| Spec | Location | Pods | Members | Services |
|------|----------|------|---------|----------|
| `starter` | `packages/daemon/specs/rigs/launch/starter/rig.yaml` | dev | 2 (build, review) | no |
| `factory` | `packages/daemon/specs/rigs/launch/factory/rig.yaml` | orch, dev, review | 7 (lead, advisor, build, qa, design, r1, r2) | no |
| `code-review` | `packages/daemon/specs/rigs/focused/code-review/rig.yaml` | orch, review | 3 (lead, r1, r2) | no |
| `research` | `packages/daemon/specs/rigs/focused/research/rig.yaml` | orch, research | 3 (lead, analyst, synthesizer) | no |
| `pm` | `packages/daemon/specs/rigs/focused/pm/rig.yaml` | pm, dev | 3 (lead, researcher, build) | no |
| `secrets-manager` | `packages/daemon/specs/rigs/launch/secrets-manager/rig.yaml` | vault | 1 (specialist) | yes (Vault) |

Also shipped, in the same tree: `launch/kernel`, OpenRig's own team, which starts automatically. `first-project` is
starter's old name and still resolves to it. `workshop`, the four-agent middle team, is a rig bundle rather than a
built-in. List the built-ins with `rig specs ls --kind rig`.
