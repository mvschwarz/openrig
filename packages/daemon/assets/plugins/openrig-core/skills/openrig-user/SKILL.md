---
name: openrig-user
description: Use when operating OpenRig with the `rig` CLI and you need the shipped command surface for identity, inventory, communication, lifecycle, specs, recovery, or agent-facing JSON output. NOT for debugging host-side runtime issues (use openrig-operator) or for changing OpenRig itself (work in the openrig product repo).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Bootstrap skill — NPM install lands this in personal homes (~/.claude/skills/, ~/.agents/skills/) so agents have it at every boot.
    sibling_skills:
      - openrig-operator
      - openrig-architect
      - forming-an-openrig-mental-model
    transfer_test: pending
    notes: |
      Description was already correct (starts with "Use when..."; lists triggering domains without summarizing workflow). No frontmatter rewrite needed.
      2026-05-04 sync: body content updated for OpenRig v0.2.0 release — adds Runtime-Gated Coordination Primitives section (PL-004 Phase A-D commands: rig stream / rig queue / rig project / rig view / rig watchdog / rig workflow), default posture for daemon vs substrate coordination commands, capture discipline section. Frontmatter metadata.openrig.* preserved across the sync.
---


# OpenRig User

This is an as-built guide to the shipped `rig` CLI.
Use current code and `rig ... --help` as ground truth if anything here ever conflicts with older planning docs.

This is the daily-driving CLI guide for an OpenRig operator. It is not
a guide to OpenRig internals or to changing OpenRig behavior — for that,
work in the openrig product repo.

## Runtime-Gated Coordination Primitives

OpenRig v0.2.0 is published publicly as `@openrig/cli@0.2.0` and GitHub Release
`v0.2.0`. It includes the bundled PL-004 Coordination Primitive System: Phase A
`rig stream` / `rig queue`, Phase B `rig project` / `rig view`, Phase C
`rig watchdog`, and Phase D `rig workflow` / `workflow-keepalive`.

Do not confuse public package truth with this host's active daemon truth. As of 2026-05-04, the
human reports the production daemon has been upgraded to v0.2.0; a local check showed `rig
--version` and the product package version at `0.2.0`, with the daemon running on port 7433.

Default posture on this host now:

- Treat daemon `rig queue`, `rig stream`, `rig project`, `rig view`, `rig watchdog`, and
  `rig workflow` as active-host coordination surfaces for PL-004-backed work.
- **CANONICAL SURFACE NOTE (2026-05-11)**: `rig queue` (daemon-backed SQLite) is the
  canonical surface for queue routing since the 2026-05-11 host-CLI fix landed. Use
  `rig queue create / handoff / update / show / list` for all substantive work.
- Use substrate `rigx queue`, `rigx stream`, `rigx project`, and `rigx view-proto` only where the
  current workflow is still explicitly operating on the temporary substrate coordination layer or
  a legacy artifact has not migrated. For queue specifically, `rigx queue` is recovery-only
  fallback; qitems written via `rigx queue` are invisible to daemon-backed reads and break
  fleet-wide routing discipline.
- If a daemon-backed coordination command fails, debug the command/runtime/schema edge directly;
  do not fall back to stale pre-upgrade assumptions about this host.
- Do not run daemon stop/start, wrapper mutation, production DB copy/mutation, git push, tags, npm
  publish, or GitHub release unless a human grants the specific bounded gate. The public release
  already exists; further release operations need explicit scope.

## Core Loop

Most work in OpenRig reduces to this loop:
- recover identity: `rig whoami --json`
- inspect inventory: `rig ps --nodes --json`
- read context: `rig transcript ...`, `rig ask ...`, `rig chatroom history ...`
- act: `rig send`, `rig capture`, `rig broadcast`, lifecycle commands

## Identity and Recovery

Start here after launch, compaction, or confusion:

```bash
rig whoami --json
```

What it gives you today:
- identity: rig, logical ID, pod/member, session name, runtime
- peers and directional edges
- transcript info
- `contextUsage` when available

Flags:
```bash
rig whoami --session <name>
rig whoami --node-id <id>
```

If the daemon is unreachable but identity can still be inferred, `--json` may return a partial result instead of crashing.

## Inventory and Monitoring

```bash
rig ps
rig ps --json
rig ps --nodes
rig ps --nodes --json
```

Use `rig ps --nodes --json` for the current node inventory across rigs. It is the best machine-readable operator surface for:
- session name
- runtime
- session/startup status
- restore outcome
- attach/resume commands
- latest error

Other health surfaces:

```bash
rig status
rig daemon status
rig config
rig preflight
rig doctor
```

## Transcript and Communication

### Transcript access

```bash
rig transcript <session> --tail 100
rig transcript <session> --grep "pattern"
rig transcript <session> --json
```

### Send to one session

```bash
rig send <session> "message"
rig send <session> "message" --verify
rig send <session> "message" --force
rig send <session> "message" --json
```

Use `--verify` when you want delivery evidence. Use `--force` only when you intentionally want to bypass activity-risk checks.

Observed operator nuance for `--verify`:
- `Sent to ...` + `Verified: yes` = strong positive delivery evidence.
- `Sent to ...` + `Verified: no` = ambiguous delivery, not automatic failure. We have repeatedly seen the message still land; treat this as verification drift until disproven.
- no `Sent to ...` line or a hard error = send failure.

When you get `Verified: no`, do not immediately retry blindly. First check one of:
- a direct reply from the target
- `rig capture <session>`
- transcript evidence
- queue/outbox state if the message asked for a durable handoff

### Capture terminal output

```bash
rig capture <session>
rig capture <session> --lines 50
rig capture --rig <name>
rig capture --pod <name> --rig <name>
rig capture --rig <name> --json
```

Capture discipline:
- Default to bounded captures: `rig capture <session> --lines 80`.
- Use `--lines 120` when the latest activity is ambiguous.
- Use `--lines 200` or more only for explicit recovery/debug reconstruction, such as post-compaction restore, context-wall diagnosis, or a failed handoff.
- Prefer targeted `rig transcript <session> --tail ...`, `rig transcript <session> --grep ...`, queue files, or status commands over large pane captures.
- Do not use large captures as routine monitoring; they waste operator context and can hide the actual latest state in old scrollback.

### Broadcast

```bash
rig broadcast --rig <name> "message"
rig broadcast --pod <name> "message"
rig broadcast "message"
rig broadcast --rig <name> "message" --json
```

Without `--rig` or `--pod`, broadcast targets all running sessions.

### Chatroom

```bash
rig chatroom send <rig> <message> [--sender <name>]
rig chatroom history <rig> [--topic <name>] [--after <id>] [--since <ts>] [--sender <name>] [--limit <n>] [--json]
rig chatroom wait <rig> [--after <id>] [--topic <name>] [--sender <name>] [--timeout <seconds>] [--json]
rig chatroom clear <rig>
rig chatroom topic <rig> <topic-name> [--body <text>] [--sender <name>]
rig chatroom watch <rig> [--tmux]
```

**Key commands:**
- `send` — post a message
- `history` — retrieve with composable filters (sender, since, after, topic)
- `wait` — block until new matching messages arrive (polls history, times out honestly)
- `clear` — delete all messages for the rig (destructive, rig-scoped)
- `topic` — set a topic marker
- `watch` — SSE or tmux-based live stream

**Roundtable protocol:**
1. Inspect old room: `rig chatroom history my-rig --limit 5`
2. Save if needed: `rig chatroom history my-rig --json > /tmp/old-room.json`
3. Clear if needed: `rig chatroom clear my-rig`
4. Set topic: `rig chatroom topic my-rig "ROUND START"`
5. Post: `rig chatroom send my-rig "position..." --sender <session>`
6. Monitor: `rig chatroom wait my-rig --timeout 120`
7. Close: `rig chatroom topic my-rig "ROUND CLOSED"`

See `docs/planning/roadmaps/chatroom-roundtable-protocol.md` for the full protocol.

### `rig ask`

```bash
rig ask <rig> "question"
rig ask <rig> "question" --json
```

Current shipped behavior:
- queries the daemon for evidence
- returns rig summary
- returns transcript excerpts
- may return chat excerpts
- returns insufficiency state and optional guidance

This is an evidence/context command. It is not a hidden second-LLM call.

## Lifecycle

### Bring a rig up

```bash
rig up <source>
rig up <source> --plan
rig up <source> --yes
rig up <source> --json
```

`<source>` can be:
- a rig spec path
- a `.rigbundle` path
- a bare name

Bare names are special:
- if they match a library spec, `rig up` launches from the spec library
- if they do not match a library spec, `rig up` treats the name as an existing-rig restore/power-on target
- if both exist, `rig up` fails loudly on ambiguity

Current behavior notes:
- `--target <root>` is only for `.rigbundle` / package installation. It does not change agent cwd.
- `local:` `agent_ref` values resolve relative to the rig spec directory, not your shell cwd.
- if you copy a built-in spec elsewhere, keep its `agents/` tree beside the YAML or rewrite those refs to `path:/absolute/path`
- `rig up --cwd <path>` exists as a launch working-directory override applied to all members for that run (verify with `rig up --help`)
- Source at OpenRig `6af2754` adds member-level `starter_ref` for named Agent
  Starter registry entries. Active host availability still depends on the
  running daemon; `rig-real-17812d5` does not resolve `starter_ref`.

Legacy/spec-specific surfaces still ship too:

```bash
rig bootstrap <spec> [--plan] [--yes] [--json]
rig requirements <spec> [--json]
```

### Agent Starter `starter_ref`

Source `>= 6af2754` lets a RigSpec member set:

```yaml
starter_ref:
  name: my-team-starter--claude-code
```

The daemon resolves the named entry from the Agent Starter registry, applies the
credential scan, and prepends the starter content as `guidance_merge` on fresh
launch. It supports Claude and Codex members, rejects terminal members, rejects
`starter_ref + session_source.mode: fork`, and allows
`starter_ref + session_source.mode: rebuild`.

Runtime-truth rule: verify active daemon/runtime provenance before depending on
this. If the live daemon is still `rig-real-17812d5`, `starter_ref` is source
truth only and should not be used against the active control plane. After a
runtime at or after `6af2754` is active, `rig up --plan --json` should expose a
`resolve_starter` stage with `detail.starterContent`.

### Tear a rig down

```bash
rig down <rigId>
rig down <rigId> --snapshot
rig down <rigId> --delete
rig down <rigId> --force
rig down <rigId> --json
```

Known v0.2.0 public-release caveat: `rig down <name> --delete` can return HTTP 404 even when
`rig ps --json` exposes the rig name. Use `rig ps` to find the rig ID, then run
`rig down <rigId> --delete` until `rig-down-name-lookup-404` is fixed.

If `--snapshot` succeeds, human output includes the restore hint.

### Release management without killing live claimed sessions

```bash
rig release <rigId>
rig release <rigId> --delete
rig release <rigId> --json
```

Use `rig release` for adopted/claimed-session rigs when you want OpenRig to stop managing the rig but leave the tmux sessions alive.
This is the safe recovery/reset surface for the "sessions still exist, management is broken or stale" case.
If the rig contains OpenRig-launched nodes, `rig release` refuses loudly instead of pretending the mixed rig is safe to detach.

### Snapshots and restore

```bash
rig snapshot <rigId>
rig snapshot list <rigId>
rig restore <snapshotId> --rig <rigId>
```

`rig restore` requires `--rig <rigId>`.

Claude Code autonomy note:
- unattended `rig whoami` on boot may require the local permission allow list to include `Bash(rig:*)`

### Import/export and bundles

```bash
rig export <rigId> -o rig.yaml
rig import <path> [--instantiate] [--materialize-only] [--preflight] [--target-rig <rigId>] [--rig-root <root>]
rig bundle create <spec> -o out.rigbundle
rig bundle inspect <bundle>
rig bundle install <bundle> [--plan] [--yes] [--target <root>] [--json]
```

### Legacy package surface

This still ships, but is explicitly marked legacy:

```bash
rig package validate <path>
rig package plan <path> [--target <dir>] [--runtime <runtime>] [--role <name>]
rig package install <path> [--target <dir>] [--runtime <runtime>] [--role <name>] [--allow-merge]
rig package list
rig package rollback <installId>
```

## Discovery and Topology Mutation

### Discover unmanaged tmux sessions

```bash
rig discover
rig discover --json
rig discover --draft
```

### Bind a discovered session

```bash
rig bind <discoveredId> --rig <rigId> --node <logicalId>
rig bind <discoveredId> --rig <rigId> --pod <namespace> --member <name>
```

There is no shipped top-level `rig claim` command.
The current adoption surface is `discover`, `bind`, `adopt`, and `unclaim`.

### Self-attach the current shell or agent

```bash
rig attach --self --rig <rigId> --node <logicalId>
rig attach --self --rig <rigId> --node <logicalId> --print-env
rig attach --self --rig <rigId> --pod <namespace> --member <name> --runtime <runtime>
```

Use `rig attach --self` when the current agent should attach itself directly instead of going through `discover` + `bind`.

Current proven behavior:
- inside `tmux`: attaches as a normal tmux-backed node, preserving inbound `rig send` / `rig capture`
- outside `tmux`: attaches as `external_cli`
- `--print-env` prints the `OPENRIG_NODE_ID` and `OPENRIG_SESSION_NAME` exports for the current shell

Recommended flow:

```bash
rig attach --self --rig <rigId> --node <logicalId> --print-env > /tmp/openrig-self-attach.env
. /tmp/openrig-self-attach.env
rig whoami --json
```

Notes:
- for tmux-backed self-attach, `rig whoami --json` is the right verification
- for raw/external self-attach, `rig ps --nodes --json` is currently the more reliable verification surface
- if the current shell is outside tmux, pass `--display-name <name>` when you want a stable human session label recorded

### Adopt a topology and bind live sessions

```bash
rig adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId>
rig adopt <path> --bind <logicalId=...> --bind <logicalId=...> --json
rig adopt <path> --bindings-file <bindings.yaml>
rig adopt <path> --bind <logicalId=...> --target-rig <rigId> --rig-root <root>
```

Use `rig adopt` when the sessions already exist and you want OpenRig to start managing them.

A bindings file is the durable map from authored logical IDs to live sessions. Shape:

```yaml
bindings:
  dev1.impl2: dev1-impl2@rigged-buildout
  dev1.qa: dev1-qa@rigged-buildout
```

Spec + bindings is the proven recovery pair for adopted rigs.
Spec gives OpenRig the intended topology. Bindings tells OpenRig which discovered live session belongs in each logical node.

### Proven adopted-rig recovery workflow

This workflow is proven for the case where the external tmux sessions are still alive:

```bash
rig release <rigId> --delete
rig discover --json
rig adopt <spec.yaml> --bindings-file <bindings.yaml>
```

What this does:
- removes OpenRig management without killing the sessions
- re-discovers those same sessions as unmanaged
- re-attaches them to the topology defined by the spec + bindings

Important limits:
- this is for `sessions still alive`
- spec alone is not enough for adopted rigs; you also need bindings
- this does not yet mean OpenRig can recreate dead external sessions from nothing

### Add unmanaged pods into an existing rig

This is the proven workflow when a rig is already managed, but a new pod was created outside OpenRig and you want to add it later:

```bash
rig adopt <pod-fragment.yaml> --bindings-file <pod.bindings.yaml> --target-rig <rigId>
```

Use this when:
- the target rig already exists
- the new sessions are live and visible in `rig discover --json`
- you want additive topology growth, not a full rebuild

What to prepare:
- a pod fragment spec with only the new pod
- a bindings file mapping the new logical IDs to the live session names

Verification loop:

```bash
rig discover --json
rig adopt <fragment.yaml> --bindings-file <bindings.yaml> --target-rig <rigId>
rig ps --nodes --json
rig export <rigId> -o rig.yaml
```

Success looks like:
- the new sessions stop appearing in `rig discover`
- the new logical IDs appear in `rig ps --nodes --json`
- `rig export` includes the new pod

### Mixed-origin rigs are allowed

One rig can contain both:
- adopted nodes bound from already-running sessions
- OpenRig-launched nodes created later with `rig expand` / `rig launch`

Current safety rule:
- `rig release` is for claimed/adopted-only rigs
- if a rig contains launched nodes, `rig release` fails with `contains_launched_nodes`

### Manager-assisted recovery

The proven operator pattern is:
- keep one OpenRig manager session outside the rig it manages
- address the target by rig name, not cached rig ID
- resolve the current owner from fresh `rig ps --nodes --json`
- send the manager the spec path, bindings path, and verification steps with `rig send`

This lets ordinary agents ask the manager for OpenRig help instead of every agent needing to be an OpenRig expert.

### Add/remove running topology parts

```bash
rig expand <rig-id> <pod-fragment-path> [--rig-root <path>] [--json]
rig launch <rigId> <nodeRef> [--json]
rig remove <rigId> <nodeRef> [--json]
rig shrink <rigId> <podRef> [--json]
rig unclaim <sessionRef> [--json]
```

## Specs and Validation

### Validate specs

```bash
rig spec validate <path> [--json]
rig spec preflight <path> [--rig-root <root>] [--json]
rig agent validate <path> [--json]
```

### Spec library

```bash
rig specs ls [--kind <kind>] [--json]
rig specs show <name-or-id> [--json]
rig specs preview <name-or-id> [--json]
rig specs add <yaml-or-directory> [--json]
rig specs sync [--json]
rig specs remove <name-or-id> [--json]
rig specs rename <name-or-id> <new-name> [--json]
```

`rig specs add <directory>` installs a full spec tree when the directory contains `rig.yaml` or `agent.yaml`.

## MCP

```bash
rig mcp serve [--port <port>]
```

Current shipped MCP tools:
- `rig_up`
- `rig_down`
- `rig_ps`
- `rig_status`
- `rig_snapshot_create`
- `rig_snapshot_list`
- `rig_restore`
- `rig_discover`
- `rig_bind`
- `rig_bundle_inspect`
- `rig_agent_validate`
- `rig_rig_validate`
- `rig_rig_nodes`
- `rig_send`
- `rig_capture`
- `rig_chatroom_send`
- `rig_chatroom_watch`

## Troubleshooting and Weird States

When the CLI behaves strangely, use the smallest truthful check first:

```bash
rig whoami --json
rig daemon status
rig ps --nodes --json
```

Specific operator rules:
- `Sent to ...` + `Verified: no` is ambiguous delivery, not automatic failure. Check reply, `rig capture`, transcript evidence, or queue/outbox state before retrying.
- partial `rig whoami --json` can happen when identity is still inferable but the daemon-backed path is degraded.
- the unified-exec-process warning is a host/tooling-layer signal, not automatic proof that the OpenRig topology is unhealthy.

If you hit the unified-exec warning, inspect for stale one-shot helpers before touching live seats:

```bash
ps -axo pid,ppid,command | rg 'tmux send-keys|rig queue create|tmux attach|codex|claude'
```

Safe cleanup target:
- orphaned one-shot wrappers like `tmux send-keys ...`

Do not mass-kill:
- `tmux attach ...`
- `codex ...`
- `claude ...`

For deeper host/runtime triage, use the companion `openrig-operator` skill.

## JSON and Error Posture

Design assumptions that hold in the shipped CLI:
- many operator commands support `--json`
- error messages are intended to say what happened, why it matters, and what to do next
- daemon-backed commands fail loudly when the daemon is stopped or unhealthy
- restore failure is not something you should silently reinterpret as success

## After-Compaction Recovery Checklist

1. `rig whoami --json`
2. `rig transcript <your-session> --tail 100`
3. `rig ps --nodes --json`
4. `rig chatroom history <rig> --limit 50`

## Commands That Do Not Exist

Do not assume these exist unless the shipped help starts listing them:
- `rig claim`
- `rig blame`
- `rig replay`

`rig env` IS shipped (was previously listed as not-present). It exposes `status`, `logs`, and `down` for service-backed rigs and managed apps; verify with `rig env --help`.
