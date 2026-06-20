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
- `rig down` now accepts a rig name or id (symmetric with `rig up`): the earlier
  name-to-404 caveat (the D1 path) is resolved in v0.3.3. An ambiguous name
  matching more than one active rig is refused with the matching ids; re-run
  with `rig down <id>`.
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

## Recovery and Resilience (v0.3.4+)

v0.3.4's theme is Recovery + Resilience. The surfaces below compose into a
single boot-to-running-rig path that survives crashes, hand-resumed sessions,
profile-load drift, and partial workspace state without silently fudging
status.

### `rig start` — recovery entrypoint

`rig start` is the top-level recovery sequencer. It does not invent recovery;
it composes existing primitives (daemon start + kernel verify + per-rig
restore) into one call.

```bash
rig start                    # interactive: daemon + kernel + pick-and-restore
rig start --last             # headless: restore all rigs that were last running
rig start --all              # headless: restore all rigs with restore-usable snapshots
rig start --rigs <name> [<name>...]   # headless: restore only the named rigs
rig start --json             # JSON output for agents
```

Framing: `rig start` is the RECOVERY entry point, not the getting-started
hero. The fresh-user boot hero remains `rig up <starter>` (typically
`rig up product-team`). Reach for `rig start` after a host reboot, daemon
restart, or any "bring my rigs back" moment.

### `rig reconcile-session` — no-launch adopt of a hand-resumed session

When an operator has externally resumed an agent session (e.g. attached a
shell, restarted a runtime by hand) and you want OpenRig to reconcile its
lifecycle state without re-launching or sending input, use:

```bash
rig reconcile-session <session>
rig reconcile-session <session> --rig <rigId> --node <logicalId>
rig reconcile-session <session> --no-launch
rig reconcile-session <session> --json
```

This is a no-launch, no-input adopt. `--rig`/`--node` disambiguate when the
canonical session name does not uniquely resolve. `--no-launch` is accepted
for explicitness (it is the only mode this command has).

### Five-term restore status vocabulary

The shipped restore vocabulary is intentionally honest. It surfaces in
`rig up` / `rig restore` / `rig ps`. Use the term that fits — do not collapse
to a generic "ok/failed":

- `resumed` — seat resumed from its original session/snapshot and is live.
- `fresh-primed` — seat opted into `--fresh` and was freshly started.
- `awaiting-decision` — zero-session honest state. There is no resumable
  session AND no `--fresh` opt-in was given; the seat is waiting for an
  operator decision. Previously fudged as `failed`; that was wrong — nothing
  is broken, the system is asking for input.
- `attention_required` — seat is in a state needing operator attention; not
  a transport failure. Clear via `rig seat clear-attention` once the
  attention has been resolved.
- `failed` — the send transport or launch genuinely failed.

This replaces the prior collapsed model (the v0.3.3 four-term vocabulary, in
which `rebuilt` was a term, is retired).

### `rig seat clear-attention` — audited reconcile of stuck attention

When a seat is stuck in `attention_required`, do NOT hand-edit SQLite to
fake-clear the state. Use the evidence-gated, operator-attested, audited
reconcile:

```bash
rig seat clear-attention <session>
rig seat clear-attention <session> --reason "operator attested: founder re-authed, confirmed live"
rig seat clear-attention <session> --json
```

`--reason <text>` is the operator-attestation override path; without it the
command runs the evidence gate. Either way the action is audited.

### Periodic snapshots — crash-insurance floor

The daemon ships a periodic-snapshot scheduler. It runs independently of
teardown events and provides the crash-insurance floor that prior
event-only/teardown-only snapshots could not provide on hard crashes.

Config keys (SettingsStore):
- `snapshots.periodic.enabled` — default `true`
- `snapshots.periodic.interval_seconds` — default `300`
- `snapshots.periodic.retention_keep` — default `10`

Newest-wins semantics: when both `auto-periodic` and `auto-pre-down`
snapshots exist for a rig, the freshest of the two is selected for restore.
A newer `auto-periodic` beats a stale `auto-pre-down` (the crash fix); a
genuinely-fresher `auto-pre-down` still wins on graceful cycles. Manual
snapshots are handled separately. See
`packages/daemon/src/domain/snapshot-repository.ts` for the ordering rule.

The last-snapshot floor surfaces in `rig ps` / status output so an operator
can see at a glance how recent the crash-insurance floor is.

### Codex profile-v2 preflight

Profile-bearing launch/restore surfaces run a profile-load preflight. When
profile-load issues are detected, the failure is honest and actionable
(named error + remediation pointer) instead of a silent partial launch that
would later look like an attention_required seat with no explanation.

### cmux launch readiness

cmux-backed launches no longer produce silent partial workspace state. When
parts of the workspace are missing, the launch surfaces partial state
honestly and the UI exposes a one-click open-missing affordance.

(See also `## Token-Efficient Defaults (v0.4.0+)` below for the compact-by-default read-command surface that lands in 0.4.0.)

## Token-Efficient Defaults (v0.4.0+)

v0.4.0 flips the five most frequently invoked read-commands from firehose-by-default to compact-by-default, and `rig queue list` adopts the docker / kubectl read-command grammar. **All defaults preserve breadth and capability — the firehose is one explicit flag away.**

### `rig ps` — compact-by-default + `--full`

```bash
rig ps                      # compact rig summaries (default)
rig ps --json               # compact array (TL;DR per node: session, rig, activity, assigned/pending)
rig ps --nodes              # compact node inventory
rig ps --nodes --full       # complete record (the v0.3.4 default shape)
rig ps --nodes --rig <name> # narrow to one rig
rig ps --nodes --session <sess>  # narrow to one canonical session
```

Same breadth as v0.3.4 — all visible nodes still listed. The change is **projection-trim, not scope-narrowing**. Default emits the 80/20 a status glance needs; `--full` returns the complete per-node record (raw byte-equivalent passthrough). Daemon-side payload source-dedup (slice 26) means `recoveryGuidance` is no longer duplicated per-node (relocated to a top-level guidance-by-reference map) — even `--full` benefits.

**STOP using `rig ps --nodes --json` as the casual status check assuming the v0.3.4 shape.** The v0.4.0 default IS the casual check; explicit `--full` is the firehose. The ~77,000-token status-glance incident is closed.

### `rig whoami` — compact-by-default + `--full` (`--verbose` alias)

```bash
rig whoami                  # compact: identity + peers names + edges + transcript path
rig whoami --json           # compact JSON (~192 tokens)
rig whoami --full           # complete payload (~909 tokens; v0.3.4 default shape)
rig whoami --verbose        # alias of --full
```

The first command every agent runs on boot AND every compaction-restore. The compact default keeps identity-recovery essentials (`identity`, `peers` names + sessionNames, `edges` directional `kind` + `to.sessionName`, `transcriptPath`). `--full` adds `contextUsage`, `commands`, `peersNote`, `runtimeContext`. The compact-default is an ALLOWLIST projection — future payload fields default to `--full` and cannot silently re-bloat the every-boot path.

### `rig queue list` — active-frontier + docker/kubectl grammar

```bash
rig queue list                       # active, compact, CURRENT-rig (docker-ps default)
rig queue list -a                    # + closed/done history within current breadth (docker -a)
rig queue list -A                    # cross-rig breadth (kubectl -A)
rig queue list --full                # add body + chain-of-record + transition history
rig queue list -o json               # compact JSON (token-safe, machine-parseable)
rig queue list --full -o json        # full JSON
rig queue list --mine                # just the caller's items
rig queue list --destination <s>     # destined to <s>
rig queue list --source <s>          # sourced by <s>
rig queue show <qitemId>             # full single item (kubectl describe)
```

Four orthogonal axes (scope × history × field-breadth × encoding), all composable. **STOP using bare `rig queue list` as the cross-rig firehose.** Default is now active + compact + current-rig. The cross-rig + history + full-body firehose (the ~64,000-token bomb on this host) is opt-in via `-A -a --full`.

### `rig restore-check` — summary + not-ready-only default + `--full`

```bash
rig restore-check               # summary counts + not-ready seats (with reasons) only
rig restore-check --full        # complete per-seat readiness across the fleet (v0.3.4 default)
rig restore-check --rig <name>  # narrow
rig restore-check --as <session>  # narrow to one seat
```

Closes the largest measured bomb (~79,000 → low thousands). Summary correctly identifies EVERY not-ready seat (no false-ready omission); detail is dropped only for ready seats.

### `rig context` — compact summary + `--full`

```bash
rig context                # compact summary
rig context --full         # complete current payload
rig context --rig <name>   # narrow to one rig
rig context --threshold 80 # filter to seats at/above 80%
```

Lower leverage than the others but keeps the read-command surface compact-by-default after the upgrade.

### Why this matters

This release closes the host-version-aged token-burn class: on this host the read-commands accumulated to ~225,000 tokens of context-window cost over a typical orchestrator session, almost all of it firehose-when-a-glance-was-wanted. Compact defaults restore the lean-monitoring doctrine: a narrow status check must be cheap. The full payloads remain one flag away when actually needed.

### Token-efficiency-boot-guardrail pack (interim) — CLI-prohibitions RETIRE at host-upgrade

The interim `token-efficiency-boot-guardrail` pack (the CLI-command prohibitions on `rig queue list` unfiltered, `rig ps --nodes --json` unfiltered, `rig restore-check`, `rig context`, `rig whoami --json`) is a host-version workaround for the bloated defaults this release closes. **The CLI-command-prohibitions half retires when 0.4.0 lands on the host.** The pack's bounded-local-search rule + scope / over-flag discipline GRADUATE to a standing convention (`conventions/bounded-local-search-and-flag-scope`) and continue to apply host-independently.

### `rig scope mission|slice progress` — deterministic progress updates (slice 33)

```bash
rig scope mission progress <mission> --status <state> --milestone <text>
rig scope slice progress <slice-path> --status <state> --note <text>
```

Replaces hand-editing `PROGRESS.md` with markdown. Writes the canonical structure the OpenRig PROGRESS UI page reads. `rig scope mission create` + `rig scope slice create` now scaffold `PROGRESS.md` automatically per `conventions/scope-and-versioning/README.md`.

### `rig skill audit` — skill cascade provenance (slice 10)

```bash
rig skill audit                  # human report of findings
rig skill audit --json           # structured findings
rig skill audit --severity warn  # stale + mirror-drift only
rig skill audit --rig <name>     # narrow to embedded skill copies for one rig
```

Read-only audit of the skill cascade. Detects `missing` / `stale` / `self-referential` / `invalid-date` / `mirror-drift` across the canonical `openrig-work/skills/` → product mirror → hub cwd → installed plugin chain. Findings route back to the lifecycle for shaped propagation runs. **False-green prevention**: when audit evidence is unavailable, the CLI emits `unable-to-audit` with exit code `2` rather than reporting `clean`.

### `rig seat clear-attention` — extended to derived projection staleness (slice 16)

v0.3.4 shipped `clear-attention` gating on `session.startupStatus` only. v0.4.0 extends the verb to also reach **restoreOutcome-derived** attention (seat is `startupStatus=ready` + `sessionStatus=running` but carries `restoreOutcome=failed` / `continuityOutcome=failed`). Same evidence-gated audit row applies; the `--reason <text>` operator-attestation override carries the runtime / cwd-uncertainty disclosure honestly.

## Core Loop

Most work in OpenRig reduces to this loop:
- recover identity: `rig whoami` (compact default; add `--full` only when you need the heavy payload)
- inspect inventory: `rig ps --nodes` (compact default; add `--full` only when you need the firehose)
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

`WhoamiResult` (v0.3.3+) carries a required `peersNote` field with three pointers
the agent can use to navigate the rest of the rig from a cold start. The
human-formatted CLI output preserves the literal `Peers:` line prefix verbatim
(parser/test compatibility) and surfaces the clarifier in-band beneath it; the
JSON form exposes `peersNote` directly for programmatic consumers.

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

As of v0.3.3 (slice 17), content beginning with `--` or `-` is safe:
`rig send <session> "content starting with -- or - is now safe"` delivers
literally. The daemon's `send_text` path carries an explicit `--`
end-of-options sentinel so tmux no longer parses dash-prefixed content
as its own flags. The CLI surface itself is unchanged. For multi-line
or large bodies handed off as durable work, use
`rig queue create --body-file <path>` (`-` for stdin) — that's the
queue-side surface, not `rig send`.

`--verify` delivery outcomes (v0.3.3+):
- `delivered` — text + Enter both succeeded and capture re-confirmed the body landed.
- `rendered-unconfirmed` — text + Enter both succeeded but capture could not re-confirm the body (TUI redraw race or scroll). The message landed; the post-send re-check could not prove it. Treat as landed-but-unconfirmable, NOT failure.
- `failed` — the send transport itself failed.

The legacy `Verified: yes/no` line is preserved verbatim (parser/test
compatibility). A new `Delivery: <outcome>` line carries the named outcome
above.

Observed operator nuance for `--verify`:
- `Sent to ...` + `Verified: yes` (`Delivery: delivered`) = strong positive delivery evidence.
- `Sent to ...` + `Verified: no` + `Delivery: rendered-unconfirmed` = the message landed; capture could not re-prove it. Don't blind-retry — check reply / `rig capture` / transcript before sending again.
- `Sent to ...` + `Verified: no` + `Delivery: failed` = send-transport failure.
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
rig up <source> --existing
rig up <source> --fresh <seat...>
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

Resume-original-by-default (v0.3.4+):
- For an existing rig, `rig up <name>` resumes each seat from its original session/snapshot by default (operation A). Seats that successfully resume report `resumed`.
- `--fresh <seat...>` is the per-seat opt-in for deliberate fresh-prime (operation B). Named seats are reported as `fresh-primed`.
- `--existing` forces existing-rig restore semantics on a bare name, bypassing library-spec resolution. Useful when a rig name collides with a library spec name.
- Example: `rig up --existing my-rig --fresh dev-impl` — resume everything in `my-rig` except `dev-impl`, which is freshly primed.
- Seats with no resumable session land in `awaiting-decision` (zero-session honest state, NOT `failed`); see the five-term restore vocabulary in "Recovery and Resilience" below.

`--plan` (v0.3.4+):
- `rig up <source> --plan` produces a read-only restore plan preview. It surfaces per-seat resume/fresh-prime intent and any awaiting-decision seats without mutating state. Honest async timeout: a stuck plan reports the timeout rather than hanging silently.

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
rig down <rig>            # <rig> = rig name or id (active rig)
rig down <rig> --snapshot
rig down <rig> --delete
rig down <rig> --force
rig down <rig> --json
```

If `--snapshot` succeeds, human output includes the restore hint.

### Archive a stopped rig (recoverable) — v0.3.3+

```bash
rig archive <rig> [--json]
rig unarchive <rig> [--json]
```

`rig archive` marks a stopped rig as archived (sets `archivedAt`) without
discarding it. The rig is preserved for later restoration via `rig unarchive`,
which clears `archivedAt` and returns the rig to the active set.

Archive vs delete:
- `rig down --delete` — permanent removal; not recoverable.
- `rig archive` — recoverable; the rig is hidden from the default active view but its record + snapshots are preserved.

Visibility in `rig ps`:
- `rig ps` — active rigs only (default).
- `rig ps --include-archived` — includes archived rigs, marked with `*`.

SSE events `rig.archived` / `rig.unarchived` drive Project / dashboard updates;
consumers that depend on the rig list should subscribe rather than poll.

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
rig launch <rigId> --seats <a,b,c> [--hold-reason <text>] [--json]
rig remove <rigId> <nodeRef> [--json]
rig shrink <rigId> <podRef> [--json]
rig unclaim <sessionRef> [--json]
```

Node-granular managed partial restore (v0.3.4+):
- `rig launch <rigId> <nodeRef>` relaunches a single seat by logical id or node id through orchestration.
- `rig launch <rigId> --seats <a,b,c>` relaunches a comma-separated subset of seats.
- `--hold-reason <text>` records a reason for holding non-target seats during the partial launch.
- This is a SUPPORTED managed path. The prior `pod_aware_launch_unsupported` dead-end is retired; pod-aware narrow launch now goes through this surface rather than ad-hoc rebuilds.

### Add a member to an existing pod — v0.3.3+

```bash
rig add <rig> <member-fragment-path> [--json]
rig add-member <rig> <member-fragment-path> [--json]
```

`rig add` (alias `rig add-member`) is the top-level verb for the `add_member`
converge op. It adds a single member to an existing pod from a YAML/JSON member
fragment file. The fragment must declare the target pod; the daemon resolves
the pod by that declared identity, validates the member, runs preflight, and
launches the member in place.

HTTP outcomes:
- `201` — member added; per-node launch state included in the response.
- `400` — `validation_failed` or `preflight_failed` (the fragment or its launch posture is rejected before any state change).
- `409` — `member_conflict` (a member with that identity already exists in the pod).

Use `rig add` when you want additive growth inside a pod without re-running
the full `rig expand` pod-fragment path or rebuilding the rig.

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
