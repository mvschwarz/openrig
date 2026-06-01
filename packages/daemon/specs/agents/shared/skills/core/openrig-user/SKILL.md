---
name: openrig-user
description: Use when operating OpenRig with the `rig` CLI and you need the shipped command surface for identity, inventory, communication, lifecycle, specs, recovery, or agent-facing JSON output.
---

# OpenRig User

This is an as-built guide to the shipped `rig` CLI.
Use current code and `rig ... --help` as ground truth if anything here ever conflicts with older planning docs.

This is not the config-layer or builder guide. Use the substrate control-plane guidance for `rigx`
and experimental overlays. Use the OpenRig builder guidance when changing OpenRig behavior,
doctrine, or release posture.

## Coordination primitives — when to use which

Three coordination surfaces, used together for forward-momentum work. Internalize this
on first read — it shapes every turn you take in a rig.

### `rig send <seat> "<text>"` — intra-pod direct messaging / nudges

Use when you need to ask a quick question or give a teammate context that does not
carry handoff semantics. **NOT for durable work.** NOT for state that must survive
across turns. The message lands in the target's pane; there is no durable queue
record. The CLI prints `Sent to ...` (and `Verified: yes/no` with `--verify`); read
the receipt and move on.

Example:

```bash
rig send velocity-guard@openrig-velocity "Heads up — filing per-commit handoff on slice-22 Bug 1 BONUS at tip 6b8673b6." --verify
```

### `rig queue create --source <X> --destination <Y> --tags <...> --body "<...>"` — durable work item

Use for any substantive work that must not fall through chat — slice handoffs,
guard verdicts, QA results, full-tip reviews, multi-item batches. Survives agent
restarts. Tracked in the daemon SQLite schema. Surfaces in Project / queue views
+ in the destination seat's inbox. Tag with mission / slice / gate / checkpoint
so future-you (and any peer) can find it.

Body discipline: substantive bodies go through a temp-file pattern, not inline
`--body` with raw backticks — `rig queue create` body parsing breaks on
unescaped backticks and rejects flag-like tokens.

Example:

```bash
rig queue create \
  --source redo-driver-2@openrig-velocity \
  --destination redo-guard-2@openrig-velocity \
  --tags "mission:release-0.3.2,slice:22-rig-up-paper-cut-fix-round,gate:guard,handoff:per-commit,checkpoint:bug-1-bonus" \
  --body "$(cat /tmp/per-commit-body.txt)"
```

### `rig queue handoff <qitem-id> --to <next> ...` — hot-potato handoff

Use when you have completed your turn on a qitem and the work moves to the next
owner. **This is forward momentum.** The ball passes to the destination seat;
chain-of-record (the prior qitem id) is preserved so the verdict trail is intact;
tags carry the phase boundary forward (e.g. `gate:guard` → `gate:qa`).

Example:

```bash
rig queue handoff qitem-20260601012431-d78aa805 \
  --to velocity-qa@openrig-velocity \
  --tags "mission:release-0.3.2,slice:22-rig-up-paper-cut-fix-round,gate:qa,handoff:adversarial-dogfood"
```

### §1b doctrine — turn ends by passing the ball

**A turn ends by passing the ball, never by going idle holding the slice waiting
on a confirmation the process does not include.** If the work was authorized, the
per-commit guard + adversarial QA + orch heavy-verify are the guardrails — not an
operator pre-commit gate. Do the authorized work and pass the ball.

Valid pauses are only:

- A genuine blocker — file a blocked-state qitem against the blocking peer or
  surface explicitly to orch.
- A scope-or-architecture question that requires owner input and changes the
  plan — surface to orch with the specific decision needed.

Implementing already-authorized work is neither of these. Proceed without
phantom-gating on an imagined "next prompt" or "operator confirmation" that the
process does not require.

### Anti-patterns

- Using `rig send` for durable work → use `rig queue create` instead. Sends do
  not survive restarts and do not show up in queue/project views.
- Idle-holding a slice for an imagined "next prompt" or "operator confirmation"
  that the process does not require → pass the ball via `rig queue handoff` and
  proceed to the next slice or stand by for the inbound verdict. See the §1b
  doctrine above.
- Hand-coding `rigx queue` for new work → `rig queue` is the daemon-backed
  canonical surface since the 2026-05-11 host-CLI fix. `rigx queue` is a
  recovery-only fallback; qitems written via `rigx queue` are invisible to
  daemon-backed reads and break fleet-wide routing discipline.
- Inlining a multi-line / backtick-heavy body into `rig queue create --body`
  → write the body to `/tmp/<descriptive-name>.txt` first, then
  `--body "$(cat /tmp/<file>.txt)"`. The body parser does not tolerate raw
  backticks or flag-like tokens inline.

## Runtime-Gated Coordination Primitives

OpenRig v0.3.1 is published publicly as `@openrig/cli@0.3.1` and GitHub Release
`v0.3.1`. It includes the bundled PL-004 Coordination Primitive System: Phase A
`rig stream` / `rig queue`, Phase B `rig project` / `rig view`, Phase C
`rig watchdog`, and Phase D `rig workflow` / `workflow-keepalive`.

These are shipped product surfaces in v0.3.x, but they require a compatible
v0.3.x daemon and matching SQLite schema at runtime — the installed package
version is not automatically the version of the daemon serving you. If a
coordination command behaves unexpectedly, confirm the running daemon with
`rig whoami --json` and daemon status before assuming a product bug.

Default posture:

- Treat daemon `rig queue`, `rig stream`, `rig project`, `rig view`, `rig watchdog`, and
  `rig workflow` as the product coordination surfaces when the active daemon is v0.2.0 or newer.
- **CANONICAL SURFACE NOTE (2026-05-11)**: `rig queue` (daemon-backed SQLite) became
  the canonical queue-routing surface when the 2026-05-11 host-CLI fix landed. The
  coordination model is now load-bearing at the top of this skill — see
  "Coordination primitives — when to use which" above for the send / queue /
  queue-handoff usage model and the §1b doctrine. Auxiliary queue verbs:
  `rig queue update / show / list` complement `rig queue create / handoff`
  for in-flight inspection and state mutation.
- Use temporary substrate overlays such as `rigx queue`, `rigx stream`, `rigx project`, and
  `rigx view-proto` only where the current OpenRig workstream explicitly says that legacy/control
  layer is still in use. For queue specifically, `rigx queue` is recovery-only fallback;
  qitems written via `rigx queue` are invisible to daemon-backed reads and break fleet-wide
  routing discipline.
- If a daemon-backed coordination command fails, debug the command/runtime/schema edge directly;
  do not assume the right workaround is to drop back to a config-layer primitive.
- Do not perform daemon stop/start, production DB copy/mutation, release, publish, or other
  consequence-boundary actions unless the operator/workstream has granted that specific gate.

## First-user workspace setup

When booting into a rig on a host where the workspace is unset, gap-ridden, or
points at a stale layout, address that before substantive project work. The
shipped surface is small + bounded — reach for the canonical commands rather
than improvising.

### Detect workspace state at boot

Agent-actionable when the daemon is reachable.

```bash
rig workspace validate --json
rig workspace validate <path> --kind <user|project|knowledge|lab|delivery> --json
```

`rig workspace validate` walks the workspace root and emits a structured
frontmatter-gap report against the v0 contract. Exit code is non-zero when
gaps exist (operators chain into hygiene fix loops). Default root is the
current directory; pass a positional path to validate elsewhere. `--kind`
scopes the contract to a specific workspace kind; omit for a kind-agnostic
structural check.

If `rig workspace validate` reports a non-zero `gapCount` OR the workspace
root is unset / unwritable, the workspace needs instantiation — see the next
section.

### Instantiate the canonical workspace scaffold

Agent-actionable. Idempotent on existing dirs without `--force`.

```bash
rig config init-workspace
rig config init-workspace --root <path>
rig config init-workspace --dry-run --json
```

`rig config init-workspace` scaffolds the canonical workspace layout at the
configured `workspace.root` (default `~/.openrig/workspace`):

- `missions/` — release missions + slices
- `artifacts/` — work artifacts produced inside the workspace
- `evidence/` — non-dogfood evidence (release evidence, proof packets, etc.)
- `progress/` — progress index + per-mission rails
- `field-notes/` — operator + agent observations
- `specs/` — spec library (rig + agent + workflow YAML lives here)
- `dogfood-evidence/` — dogfood proof packets + run artifacts

The scaffold seeds one example mission (`getting-started`) with multiple
slices, and drops a workspace README.md + STEERING.md so a fresh install has
browsable Project content. `--root <path>` targets a non-default root for
this call; `--dry-run` reports what would be created without writing.
`--force` overwrites existing FILES but never deletes
directories — operator content is safe.

### Redirect the workspace root

Operator-gated when persistent. Agent-actionable when one-shot via env-var.

For a single command:

```bash
OPENRIG_WORKSPACE_ROOT=<path> rig <command> ...
```

For a persistent host-level redirect, the operator changes the config file or
runs the setter:

```bash
rig config set workspace.root <path>
```

ConfigStore precedence: `OPENRIG_WORKSPACE_ROOT` env > config-file
`workspace.root` > built-in default `~/.openrig/workspace`. The same
precedence governs `OPENRIG_WORKSPACE_SPECS_ROOT` → `workspace.specs_root`
(default `<workspace_root>/specs`).

Prefer the env-var form for one-shot redirects (transparent to operators);
reserve `rig config set` for changes the operator owns.

### Build a workspace from scratch

Agent-actionable. Same surface as the canonical scaffold above; the
`workspace.root` cascade handles non-existent host paths.

```bash
rig config init-workspace --root /path/to/new/workspace
```

The command creates the root dir if missing (idempotent: existing root +
populated subdirs is a no-op). Run
`rig workspace validate /path/to/new/workspace --json` after to confirm the
contract holds.

### Create a workflow inside an existing workspace

Authoring is operator-or-agent; validation + instantiation are
agent-actionable.

Workflow spec files live at:

```
<workspace_root>/specs/workflows/<name>.yaml
```

`<workspace_root>` resolves via the ConfigStore precedence named above.
There is no `rig workflow create` verb in v0.3.x — the spec YAML is authored
directly. Template by hand from the documented schema, or copy a built-in
starter from `<openrig install>/dist/builtins/workflow-specs/` and adapt.
Once written:

```bash
rig workflow validate <workspace_root>/specs/workflows/<name>.yaml --json

rig workflow instantiate <workspace_root>/specs/workflows/<name>.yaml \
  --root-objective "<one-line objective for the run>" \
  --created-by <your-session>@<your-rig> \
  --json
```

Both `--root-objective <text>` and `--created-by <session>` are REQUIRED
on `instantiate` — omitting either yields a Commander required-option
error before the daemon is contacted. `--entry-owner <session>` is an
optional override for the entry-step owner; default routing is per the
workflow spec.

`validate` returns a structured ok/error report; `instantiate` creates a
workflow instance + entry-step qitem. Inspect existing surface state with:

```bash
rig workflow specs --json   # list registered specs (built-in + operator-authored)
rig workflow list --json    # list active workflow instances
rig workflow show <instanceId> --json
```

## v0.3.x Starter, Workspace, And Plugin Surfaces

OpenRig v0.3.0 adds `rig agent-image`, `rig context-pack`, `rig workspace`, and
`rig config init-workspace`. It also shifts fresh-user starter guidance toward
`product-team` for human-directed work and `conveyor` for workflow-oriented
work. Treat `demo` as legacy/test content unless a task specifically asks for
the old demo spec.

OpenRig v0.3.1 adds public package/source surfaces for Plugin Primitive v0,
Claude Auto-Compaction Policy, migration `040_workflow_specs_diagnostic`,
Library Explorer finishing, Settings Destination Explorer, Dashboard/For You
vellum refresh, storytelling adapter, and action outcome + inline error UX.

`rig plugin` is read-only at v0:

```bash
rig plugin list
rig plugin show <id>
rig plugin used-by <id>
rig plugin validate <path>
```

There is no `rig plugin install` verb in v0.3.1. Plugin installation remains
explicit operator copy/symlink to `$OPENRIG_HOME/plugins/<plugin-id>/`.

Claude auto-compaction policy is opt-in default-off. The v0.3.1 package and
this host's active daemon ship `policies.claude_compaction.*` ConfigStore keys,
but no behavior changes unless the operator enables the policy.

Known v0.3.0/v0.3.1 caveats:
- `rig down <name> --delete` still returns 404 in the known D1 path; use
  `rig ps` to find the rig ID and then `rig down <rigId> --delete`.
- `rig queue` / `rig view` JSON and limit compatibility drift is an open
  follow-up from host-adoption proof; treat it as a compatibility caveat, not a
  daemon-health failure.
- Queue/view JSON/limit drift is now refined as a wrapper-layer routing issue,
  not a daemon-layer issue; use human-readable output for affected wrapper
  commands until v0.3.2.
- First v0.3.1 daemon start hit a plugin-vendor fallback health-probe timeout;
  controlled retry succeeded. Manual retry is the current workaround.
- Topology mobile drawer restoration and plugin source-label taxonomy are
  v0.3.2 carry-forwards.

## Core Loop

Most work in OpenRig reduces to this loop:
- recover identity: `rig whoami --json`
- inspect inventory: `rig ps --nodes --json`
- read context: `rig transcript ...`, `rig ask ...`, `rig chatroom history ...`
- act: `rig send`, `rig capture`, `rig broadcast`, lifecycle commands

## Agent-Managed Apps

An agent-managed app is a deployable OpenRig unit made of:
- the software or service
- one specialist agent dedicated to that software

Treat the specialist as the domain delegate for that app.
The current canonical example is:
- rig: `secrets-manager`
- pod: `vault`
- member: `specialist`
- logical ID: `vault.specialist`
- session: `vault-specialist@secrets-manager`

Typical operator loop:

```bash
rig up secrets-manager --cwd /path/to/project
rig ps --nodes --json
rig send vault-specialist@secrets-manager "Check Vault health and report back." --verify
rig env status secrets-manager
rig env logs secrets-manager
```

Cross-rig communication is valid when the target session resolves uniquely.
Example:

```bash
rig send vault-specialist@secrets-manager "Read secret/data/dogfood and report the value." --verify
```

Use the specialist instead of teaching every peer the same app-specific toolchain.
For Vault, ask `vault.specialist` to do secrets-domain work rather than improvising curl or Vault CLI usage in unrelated agents.

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
rig env status <rig>
rig env logs <rig>
rig env down <rig>
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
- `Sent to ...` + `Verified: no` = ambiguous delivery, not automatic failure. The message may still land; treat this as verification drift until disproven.
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
rig up <source> --cwd /path/to/project
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
- `rig up --cwd` is shipped. `rig up --cwd <path>` sends a per-run cwd override for all members in that launch.
- `local:` `agent_ref` values resolve relative to the rig spec directory, not your shell cwd.
- if you copy a built-in spec elsewhere, keep its `agents/` tree beside the YAML or rewrite those refs to `path:/absolute/path`
- `rig specs add <directory>` installs a full spec tree when the directory contains `rig.yaml` or `agent.yaml`.

Legacy/spec-specific surfaces still ship too:

```bash
rig bootstrap <spec> [--plan] [--yes] [--json]
rig requirements <spec> [--json]
```

### Tear a rig down

```bash
rig down <rigId>
rig down <rigId> --snapshot
rig down <rigId> --delete
rig down <rigId> --force
rig down <rigId> --json
```

If `--snapshot` succeeds, human output includes the restore hint.

### Environment services

```bash
rig env status <rig>
rig env logs <rig> [service]
rig env down <rig>
```

Use these for service-backed rigs and agent-managed apps.
For `secrets-manager`, these are the fastest CLI surfaces for:
- confirming whether Vault is healthy
- reading Vault container logs
- stopping the Vault env without tearing down the specialist session first

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
  dev1.impl2: dev1.impl2@rigged-buildout
  dev1.qa: dev1.qa@rigged-buildout
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

For deeper host/runtime triage, use the companion `openrig-operator` skill if it is available in your seat.

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
