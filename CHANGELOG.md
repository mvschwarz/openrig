# OpenRig Changelog

Agent-readable release notes for coding agents and human operators installing,
upgrading, or operating OpenRig.

Versioning: pre-1.0 minor releases may include contract additions,
deprecations, and behavioral changes. Breaking changes are called out explicitly.

---

## [0.4.0] - 2026-06-20

**Status**: wrap-gate CLEAR; lifecycle push / npm publish / tag held for founder-auth.

### Summary For Installing Agents

- **Package version**: bumps from `0.3.4` at the lifecycle wrap step.
- **Migrations**: additive only; no schema-breaking migrations. Existing v0.3.4 databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged.
- **Backward compatibility**: read-command DEFAULTS change (compact-by-default for `rig ps`, `rig whoami`, `rig queue list`, `rig restore-check`, `rig context`); `--full` returns the v0.3.4 default shapes. `rig queue list` adopts docker / kubectl-aligned grammar (`-a` / `-A` / `--full` / `-o json|wide` / `--mine` / `--source` / `--destination`); the prior unscoped firehose default is retired (opt-in via `-A -a --full`). Existing flag forms continue to work and compose with the new grammar.

### Token-Efficient Defaults (headline)

Five read-commands flip from firehose-by-default to compact-by-default — closes a ~225,000-token aggregate context-window cost on aged hosts.

- **`rig ps`** — compact TL;DR per node (slice 25); `--full` for v0.3.4 shape; `--rig <name>` / `--session <sess>` filters. Daemon-side payload source-dedup (slice 26): `recoveryGuidance` no longer duplicated per-node; `contextUsage` compact in list payload.
- **`rig whoami`** — compact identity-recovery essentials by default (~192 tokens vs ~909); `--full` (alias `--verbose`) returns v0.3.4 payload. Allowlist projection — future fields default to `--full`.
- **`rig queue list`** — docker / kubectl grammar (slices 28 + 32): `-a` for history, `-A` for cross-rig breadth, `-o json|wide` for encoding, `--mine` / `--source` / `--destination` for scope. Default is active + compact + current-rig.
- **`rig restore-check`** — summary counts + not-ready seats only by default (slice 29); `--full` for complete per-seat detail. Closes the largest measured bomb (~79,000 → low thousands).
- **`rig context`** — compact summary by default (slice 30); `--full` for complete payload.

### New Top-Level CLI Verbs and Subcommands

- **`rig skill audit`** (slice 10) — read-only audit of the skill cascade. Detects `missing` / `stale` / `self-referential` / `invalid-date` / `mirror-drift` across canonical → product mirror → hub cwd → installed plugin. False-green prevention: emits `unable-to-audit` exit `2` rather than reporting `clean` when evidence unavailable.
- **`rig scope mission|slice progress`** (slice 33) — deterministic `PROGRESS.md` updates through the command surface rather than hand-edited markdown. `rig scope mission|slice create` now scaffold `PROGRESS.md` automatically.
- **`rig seat clear-attention`** extended to derived projection staleness (slice 16) — reaches the second class of projection staleness (`restoreOutcome=failed` on a live ready session) that v0.3.4 couldn't.

### UI + Topology + Identity

- Real (interactive) terminals (slice 01) — per-seat terminals are interactive; read-only 3-second snapshot view retired for local-host seats.
- Agent Images library polish (slice 07) — Fork-now + row metadata + nested-failure rendering.
- Attention / activity detection elite tier (slice 09) — richer `agentActivity` consumption.
- Topology graph-view ghost render fix (slice 21).
- Reliable active/idle node state (slice 18) — DOT→terminalActive fallback; dead `pane_silence_flag` retired.
- Multi-host dogfood hardening (slice 02).
- Native Codex session-identity capture (slice 11) — foundation for 0.4.1 identity refactor.
- Codex resume preserves approval posture (slice 17).
- Scope-backed progress rails (slice 15).

### Bug-Fix Wrap

- Wrap convergence fixes (slice 24) — P1 For-You drill captured/live contract + P2 daemon test-harness WebSocket registration.

### Known Limitations / Carry-Forward

- **Plugin-lineage drift in `openrig-core`** — the openrig-core plugin skill lineage is divergent/stale; full re-sync is OPR.0.4.1.4 (rides 0.4.1). Boot-path layers (canonical + hub cwd) verified current in wrap-gate AC-3 sweep. `rig skill audit` (slice 10) is the runtime mechanism for future drift detection.
- `rig ps --current-rig` default (slice 34) + `rig scope` stage / verified verbs (slice 35) pushed to 0.4.1.

### What To STOP Using

- Stop using `rig ps --nodes --json` as the casual status check assuming v0.3.4 shape; compact default IS the casual check.
- Stop using bare `rig queue list` as the cross-rig firehose; default is now active + current-rig.
- Stop using `rig whoami --json` for the heavy payload on boot; default is compact.
- Stop using `rig restore-check` as a per-seat-detail fleet scan; default is summary + not-ready only.
- Stop hand-editing `PROGRESS.md` markdown; use `rig scope ... progress`.
- Stop applying the `token-efficiency-boot-guardrail` pack's CLI-command prohibitions on hosts running 0.4.0 (host-version workarounds; CLI-prohibitions half retires at host-upgrade). The pack's bounded-local-search + scope/over-flag discipline GRADUATE to a standing convention.

### Verification

- Wrap worktree clean on `8d55ea60`.
- CLI surfaces source-verified against the command modules at the release SHA.
- CLI→skill cascade sweep: canonical `openrig-work/skills/openrig-user/SKILL.md` → product mirror at `packages/daemon/specs/agents/shared/skills/core/openrig-user/SKILL.md` → hub cwd `.claude/skills/openrig-user/SKILL.md` + `.agents/skills/openrig-user/SKILL.md` — all byte-identical (md5 `e2aa9176`).
- cli-reference.md updated for 6 changed commands + new `rig skill` section; `last-verified-against-source` bumped to `8d55ea60`.
- Stale-pattern grep (`dumps everything` / `--notify required` / `rig down 404`) returned 0 hits across active SKILL.md locations.
- AC-6 self-check evidence: `substrate/shared-docs/openrig-work/missions/release-0.4.0/slices/36-release-durability-close/AC-6-wrap-gate-self-check-evidence.md`.

---

## [0.3.4] - 2026-06-15

**Status**: released. npm `@openrig/cli@0.3.4` (latest); GitHub Release
`v0.3.4`; git tag `v0.3.4`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step;
  CLI reports the new version after `npm publish`.
- **Migrations**: no new schema-bumping migrations in 0.3.4. Existing
  databases upgrade by running `rig daemon start` on the new daemon.
- **Node engines**: unchanged from 0.3.3 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings
  remain backward compatible. New routes are additive
  (`POST /api/rigs/:id/up` plan / apply path is the same path 0.3.3
  shipped; `POST /api/sessions/:session/reconcile` is new;
  `POST /api/sessions/:session/clear-attention` is new;
  `POST /api/rigs/:rigId/nodes/:nodeRef/launch` and
  `POST /api/rigs/:rigId/nodes/launch-subset` are new). New CLI
  commands (`rig start`, `rig reconcile-session`,
  `rig seat clear-attention`) are additive. `rig up` flips from
  fresh-by-default to resume-original-by-default — callers that
  implicitly relied on fresh-prime as the default must now name
  `--fresh <seats...>` explicitly.

### `rig start` — Recovery Entry Point (slice 01)

New top-level command. Sequences existing primitives: daemon-start
-> kernel auto-boot wait -> candidate listing -> picker / flags ->
per-rig restore (`/api/rigs/:id/up`) + reconcile:

```
rig start                            Interactive: daemon + kernel + pick-and-restore
rig start --last                     Headless: restore all rigs that were last running
rig start --all                      Headless: restore all rigs with restore-usable snapshots
rig start --rigs <name> [<name>...]  Headless: restore only the named rigs
rig start --json                     JSON output for agents
```

- **Id-grounded end-to-end**: candidate preview and apply both go
  through `POST /api/rigs/:id/up`. Same-name rigs surface as
  separate candidates; selection carries `rigId` so the name-based
  `/api/up` route is never consulted in the recovery path (no
  `ambiguous_name` 409).
- **Re-codes nothing**: same `/api/rigs/:id/up` that
  `rig up <existing>` uses; same five-term vocabulary on the
  seat-level outcome.

### `rig up` — Resume Original By Default (slice 02)

`rig up <existing-rig>` resumes original sessions by default.
`--fresh <seats...>` is now the explicit per-seat opt-in for
operation B (deliberate fresh-prime):

- **Default**: seats resume; outcome reports `resumed`.
- **`--fresh <logicalId> [<logicalId>...]`**: deliberate fresh-
  prime for the named seats; outcome reports `fresh-primed`.
- **`awaiting-decision`**: when the daemon cannot resume and the
  operator has not opted into fresh. TTY callers get a per-seat
  `[y/N]` prompt; headless callers get the explicit hint
  `rig up --existing <source> --fresh <logicalId>`. ZERO session
  started for `awaiting-decision` seats.
- **Backward-incompatible default flip**: callers that implicitly
  depended on fresh-prime as the default must now name `--fresh`
  explicitly. The `--existing` flag (treat `<source>` as a rig
  name) is unchanged.

### `rig reconcile-session` — Adopt a Hand-Resumed Session (slice 03)

New top-level command. Adopts a LIVE, hand-resumed canonical
session back into its persisted node without launching:

```
rig reconcile-session <session>
rig reconcile-session <session> --rig <rigId> --node <logicalId>
rig reconcile-session <session> --no-launch
rig reconcile-session <session> --json
```

- **NEVER launches / relaunches / kills / replays startup / presses
  resume menus / compacts / types into the pane.** The only mode
  this command has; `--no-launch` is accepted for explicitness.
- **Same node id, no re-key**: the live process binds back to its
  OWN persisted node.
- **Honest reporting**: projection drift is a list of unproven
  metadata fields; conversation continuity is reported as a status
  string, never claimed as proven.
- **Daemon route**: `POST /api/sessions/:session/reconcile`.

### `rig up --plan` — Read-Only Restore Preview (slice 04)

```
rig up <existing-rig> --plan [--json]
```

- **No mutation**: returns the restore plan only.
- **Per-node `intendedAction`**: `resume` / `fresh-prime` /
  `awaiting-decision` keyed to the five-term vocabulary.
- **Snapshot the plan would consume**: surfaced in the response so
  the operator can verify the floor before apply.
- **Honest async timeout**: when the preview cannot complete
  within bound, the response says so rather than claiming a clean
  plan.

### Pod-Aware Claude Resume-Selection Menu (slice 05 rev1 BLOCKING)

`ClaudeCodeAdapter.verifyResumeLaunch` now treats a Claude
resume-selection menu the same way it treats the Codex
unresolved-gate case (the 0.3.3 slice 21 FR-2 pattern):

- Returns immediately with `recovery: attention_required` and
  last-12-line pane evidence on BOTH the inner poll loop and the
  final-probe exit path.
- ZERO numeric selection keystrokes are ever sent.
- Routes into the existing `HarnessLaunchResult` ->
  startup-orchestrator `startupStatus: attention_required` ->
  `ps` / `status` projection — same path the Codex case uses.

### Five-Term Restore Status Vocabulary (slice 06)

The seat-level status on `rig up`, `rig restore`, and `rig ps` is
now ONE of:

- **`resumed`** — original session continuity proven by the
  native-resume probe.
- **`fresh-primed`** — operator opted into deliberate fresh-prime
  (operation B); a brand new session started instead of resumed.
- **`awaiting-decision`** — daemon could not resume and operator
  has not opted into fresh. ZERO session started. The honest
  zero-session state.
- **`attention_required`** — seat is live or parked but needs
  operator action (auth gate, model-selection menu, trust prompt,
  stuck recovery). NEVER reported as `failed`.
- **`failed`** — the launch transport itself failed.

Replaces the prior 2-3 term collapsed model that hid edge cases.
`awaiting-decision` is new and replaces the prior pattern where
zero-session outcomes were either misreported as success or as
failure.

### Codex Profile-V2 Preflight (slice 07 rev1 BLOCKING)

Profile-load check on profile-bearing launch and restore
surfaces, with narrowed legacy-profile detection:

- **Legacy detection requires legacy-specific patterns only**:
  `contains legacy`, `[profiles.<name>]`, `cannot be used while.*
  legacy`, `legacy profile selector`. The prior generic match
  against `failed to load configuration` was also catching
  invalid-TOML stderr and giving the wrong migration hint.
- **Invalid TOML surfaces the parse reason**: up to 3 stderr
  lines (e.g. `expected newline`) with a generic TOML-validity
  hint instead of a wrong hint pointing at
  `[profiles.<profile>]`.
- **Stale comment in `codex-runtime-adapter.ts` corrected**:
  absent `.config.toml` passes (Option B), not fails.

### cmux Launch Readiness (slice 08)

Launch path no longer silently produces a partial cmux workspace:

- **Honest partial-workspace state**: when cmux comes up with a
  subset of expected windows / panes, the seat surfaces an honest
  partial state instead of being projected as launched-clean.
- **One-click open-missing affordance**: UI surfaces the one-click
  path to open the missing workspace pieces.

### Periodic Snapshots (slice 09)

`PeriodicSnapshotScheduler` ships as the crash-insurance floor
under event-driven and teardown snapshots:

- **`snapshots.periodic.enabled`** (default `true`): master
  switch.
- **`snapshots.periodic.interval_seconds`** (default `300`):
  per-rig snapshot interval.
- **`snapshots.periodic.retention_keep`** (default `10`):
  per-rig `auto-periodic` retention count.
- **`auto-periodic` snapshot kind**: captured per enabled rig on
  interval; pruned by `retention_keep`.
- **Restore selector**: treats `auto-periodic` and `auto-pre-down`
  symmetrically — the newer wins. A daemon crash between teardown
  snapshots no longer loses arbitrary lifecycle state.
- **`rig ps` / status**: surfaces last-snapshot / floor so the
  operator can see the crash-insurance floor at a glance.

### `rig seat clear-attention` (slice 10)

New subcommand on `rig seat`. Evidence-gated, operator-attested,
audited reconcile of a stuck `attention_required` seat back to
`ready`:

```
rig seat clear-attention <session>
rig seat clear-attention <session> --reason "<operator attestation>"
rig seat clear-attention <session> --json
```

- **Without `--reason`**: clear requires daemon-side evidence the
  seat is back to a clean state.
- **`--reason <text>`**: operator-attestation override of the
  evidence gate; the attestation string lands in the audit row
  verbatim.
- **Daemon route**: `POST /api/sessions/:session/clear-attention`.
- **Output**: `Cleared <session>: <from> -> ready (<clearedBy>)`.
- **Replaces** the hand-edit-SQLite / fake-clear pattern. Node id
  is unchanged.

### Node-Granular Managed Partial Restore (slice 11)

`rig launch` relaunches a seat or subset by logical id through
orchestration:

```
rig launch <rigId> <nodeRef>                  Single seat
rig launch <rigId> --seats <a,b,c>            Subset (comma-separated)
rig launch <rigId> --seats <a,b> --hold-reason "<text>"
rig launch <rigId> --seats <a,b> --json
```

- **Single target**:
  `POST /api/rigs/:rigId/nodes/:nodeRef/launch`.
- **Subset**: `POST /api/rigs/:rigId/nodes/launch-subset`.
- **Partial outcomes never collapsed**: `launched`, `held` (with
  reason), `alreadyRunning`, and `failedTargets` (liveness
  unknown) reported separately.
- **Retires** the v0.3.x-era `pod_aware_launch_unsupported`
  dead-end and the "use `rig up` instead" workaround that lost
  per-seat control.

### Slow Codex Resume Classification (slice 13)

Internal classification tweak in `verifyResumeLaunch` for slow
but genuinely-resuming Codex sessions:

- Previously the slow path mis-categorized through the
  unresolved-gate branch.
- Now correctly classifies through the five-term vocabulary and
  reaches `resumed` when the readiness probe confirms.

### What to STOP Using

- `rig up <existing-rig>` is no longer fresh-by-default. Use
  `--fresh <seats...>` for deliberate fresh-prime.
- A live or parked seat is NEVER `failed`. Use
  `attention_required`. The honest zero-session state is
  `awaiting-decision`.
- `pod_aware_launch_unsupported` / "use `rig up` instead" for
  per-seat relaunch is RETIRED. Use `rig launch <rigId> <nodeRef>`
  or `rig launch <rigId> --seats <a,b>`.
- Hand-editing SQLite or fake-clearing a stuck
  `attention_required` seat is RETIRED. Use
  `rig seat clear-attention <session>` (evidence-gated) or
  `rig seat clear-attention <session> --reason "<attestation>"`
  (operator-attested, audited).
- Relying only on event-driven or teardown snapshots for crash
  safety is RETIRED. The periodic snapshot scheduler is the
  floor; tune `snapshots.periodic.*` to taste.
- Classifying invalid TOML as a legacy-profile problem is
  RETIRED. The Codex profile-v2 preflight surfaces the actual
  parse reason.
- Restoring a hand-resumed session by relaunching the whole rig
  is RETIRED. Use `rig reconcile-session <session> --no-launch`.

### Known Limitations / 0.3.4 Carry-forwards

- **`rig view list/show --json` flag inconsistency** —
  wrapper-layer routing path remains; the daemon's
  `view show <name>` route returns JSON correctly when invoked
  directly. Workaround: human-readable output for now.
- **`docs/DESIGN.md` docs-guard ledger** — design-doc update
  ledger carries forward; no runtime impact.
- **Slice-21 FR-1 (native Codex session-id hook)**: scope-tipped
  to 0.4.0 after build-time forensic. Carried forward from 0.3.3.
- **Slice-13 component 3 (auto-rollout dispatcher)**: skill-layer
  landing remains; product-code dispatcher / invocation is
  intentionally out of the shipped runtime bundle. Carried
  forward from 0.3.3.
- **Slice-05 sub-scopes carried forward**: agent / port /
  managed-app collision detection (Item 4.3); broader
  install-into-existing-rig pathway acceptance (Item 4.4);
  `--target-name` CLI flag for install-time rig-name overrides.
- **Slice-21 FR-4(d) accepted-queue-state schema**: deferred from
  0.3.2; carried forward.
- **Onboarding journey + battle-hardening**: slices 04
  (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) carried forward to a later release.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots remains a
  follow-up; non-blocking for 0.3.4.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental`
  only; not split-deferred (stays held).
- **0.3.4 host-upgrade flow held**: operators installing v0.3.4
  fresh from npm have full access immediately; existing-host
  upgrade follows the standard daemon-restart flow. The named
  host-upgrade flow is held for separate sequencing.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts cleanly (no new migrations to apply in 0.3.4)
rig daemon start

# Confirm rig start surface is wired
rig start --help

# Confirm rig up --plan + --fresh are wired
rig up --help | grep -E "(plan|fresh)"

# Confirm rig reconcile-session is wired
rig reconcile-session --help

# Confirm rig seat clear-attention is wired
rig seat clear-attention --help

# Confirm rig launch supports single-seat + subset relaunch
rig launch --help

# Confirm five-term vocabulary on rig ps
rig ps --help | grep -i attention
```

---

## [0.3.3] - 2026-06-11

**Status**: released. npm `@openrig/cli@0.3.3` (latest); GitHub Release
`v0.3.3`; git tag `v0.3.3`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step;
  CLI reports the new version after `npm publish`.
- **Migrations**: one new migration in 0.3.3 — `042_rig_archive`
  (`ALTER TABLE rigs ADD COLUMN archived_at TEXT` + `idx_rigs_archived`;
  append-only, non-destructive, no rigs-row restructure). Existing
  databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.2 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings
  remain backward compatible. New routes are additive
  (`/api/rigs/:id/archive`, `/api/rigs/:id/unarchive`,
  `/api/rigs/:rigId/pods/:podNamespace/members`). New CLI commands
  (`rig archive`, `rig unarchive`, `rig add` / `rig add-member`) are
  additive. New `rig ps`, summary, and `rig up` flags
  (`--include-archived`, `?includeArchived=true`, `?archived=only`)
  are additive and default to existing exclude-archived behavior.

### Large Startup-File Transport (slice 16)

`TmuxAdapter.sendText` no longer caps at the OS `MAX_ARG_STRLEN`
limit:

- **Payloads over 100KB** are written to a unique temp file (Node
  `fs`, never shell-embedded), loaded into a unique tmux buffer,
  and pasted with `paste-buffer -d -r`. `-r` preserves raw LF so
  multi-line packs do not early-submit on every newline; `-d`
  drops the buffer on successful paste. The single trailing C-m
  stays the caller's separate `sendKeys(["C-m"])`.
- **Payloads under 100KB** keep the exact inline
  `tmux send-keys -t <t> -l <text>` command (behavior-preserving).
- **Cleanup**: temp file unlinked in `finally`; explicit
  `delete-buffer` on paste-error path; unique temp + buffer names
  per call so parallel `rig up` seats do not collide.
- **Backward-compatible constructor**: optional second arg supplies
  the file/buffer ops (default wires Node `fs` + `os.tmpdir`);
  `new TmuxAdapter(exec)` is unchanged.

### `send_text` Inline Dash Sentinel (slice 17)

Inline `tmux send-keys -t <t> -l <text>` now carries a `--`
end-of-options sentinel:

- Any small `send_text` startup payload whose content begins with
  `-` (notably `---` YAML frontmatter — the norm for per-seat
  packs) is no longer parsed by tmux as flags.
- Inert for non-dash content.
- The slice-16 large/buffer path is already immune (content
  travels via a file, never argv) and is untouched.

### cmux 0.64.x Compatibility (slice 18)

`surface.list` normalizer resolves the surface handle across cmux
0.64.x AND 0.63.x:

- cmux 0.64.x renamed the surface identifier: `list-panels --json`
  rows carry `ref` with no `id` (0.63.x carried `id`). Result:
  `surfaceId` came back undefined and cmux-transport never mapped
  `surface.sendText` -> `cmux send`, throwing
  "Unknown cmux method: surface.sendText" (HTTP 500
  `build_workspace_failed`).
- New `normalizeSurfaceRow` resolves the handle from
  `ref ?? surface_ref ?? surface_id ?? id`, normalizing every
  row regardless of array key (`panels` / `pane_surfaces` /
  `surfaces`).
- One resolution order serves both versions — no
  version-negotiation shim. Mirrors the existing
  `normalizeWorkspaceRow` and create/split handle patterns.

### `rig archive` Affordance (slice 19)

New top-level commands and a non-destructive archive lifecycle:

```
rig archive <rigId> [--force] [--json]
rig unarchive <rigId> [--json]
```

- **Non-destructive**: rig row preserved; `archived_at` set;
  `rig.archived` event fires. `unarchive` clears `archived_at`
  and fires `rig.unarchived`.
- **Default reads exclude archived**: `rig ps`,
  `/api/rigs/summary`, `/api/rigs`, `/api/ps`. Opt-in via
  `rig ps --include-archived` / `?includeArchived=true` /
  `?archived=only`. `rig ps` marks archived rows with `*` and
  renders a legend; the flag propagates through cross-host argv.
- **`rig up` archived-name refusal (AC-7)**: a name matching ONLY
  an archived rig is refused with a 3-part error pointing at
  `rig unarchive`; `--json` emits `rig_archived`. Never silently
  restores.
- **`--force` on archive**: required when a rig is running or
  degraded; surfaces a 3-part fact / consequence / action error
  without it (AC-6).
- **UI**: lazy collapsible "Archive" section under the localhost
  host node, fed by `useArchivedRigs` (separate query against
  `/api/rigs/summary?archived=only`), not by client-side
  filtering. `rig.archived` / `rig.unarchived` events drive
  global query invalidation (`["rigs","summary"]` +
  `["rigs","summary","archived"]` + `["ps"]` + `["nodes", rigId]`
  when present) so a CLI archive reactively refreshes other
  mounted UIs.
- **Migration `042_rig_archive`**: `ALTER TABLE rigs ADD COLUMN
  archived_at TEXT` + `idx_rigs_archived`. Append-only; mirrors
  the `023_stream_items` precedent.

### `rig add` / `rig add-member` (slice 24)

New top-level command for the `add_member` converge op:

```
rig add <rigId> <podNamespace> <member-fragment-path> \
    [--json] [--rig-root <root>]
```

- **Member fragment**: YAML or JSON; tolerates a bare member or a
  `{ member }` wrapper; uses the spec snake_case field names
  (`id`, `runtime`, `agent_ref`, `profile`, `cwd`, ...).
- **Daemon route**:
  `POST /api/rigs/:rigId/pods/:podNamespace/members`. Outcome ->
  HTTP: `rig_not_found` / `pod_not_found` -> 404,
  `member_conflict` -> 409, `validation_failed` /
  `preflight_failed` -> 400, success -> 201. Per-node launch
  status (`launched` / `failed` / `attention_required`) rides in
  the 201 body.
- **MCP tool**: `rig_add` ships in lockstep.
- **Honest edge validation**: non-array `edges` is REJECTED
  (CLI prints error + exits 1; route returns 400
  `validation_failed`; domain returns `validation_failed` as
  defense in depth). Edge `kind` is validated against the
  canonical `VALID_EDGE_KINDS` set exported from
  `rigspec-schema.ts` and reused (not duplicated). Edges still
  carry NO runtime behavior (the edge-runtime fence holds).
- **Built on the topology-converge spine**: `Op` union + differ +
  `convergeOp` scaffold (AC-6); `rig add` is imperative CLI
  sugar over the converge interface, not a bypass.

### `rig down` Accepts Name-or-Id (slice 22)

`rig down <name>` now works:

- `/api/rigs/summary?includeArchived=true` is fetched; id-match
  across ALL rigs (archived ids still reach teardown);
  name-match ACTIVE rigs only.
- Same-name active+archived pair resolves the ACTIVE rig (not
  ambiguous).
- Archived-only name does not resolve by name (use the id, or
  `rig unarchive` first).
- The packaged `openrig-user` skill is corrected across specs
  source + assets/plugins copy + `_canonical` mirror; the
  `down.ts` resolver comment is corrected. The historical v0.3.1
  and v0.3.2 CHANGELOG entries and release notes are left intact
  (the bug genuinely existed at those releases).

### Honest Codex Restore Gate (slice 21 FR-2)

`verifyResumeLaunch` no longer returns `ok:true` unless the
native-resume-probe proves the seat actually resumed:

- **Unresolved operator-action gates** (update that cannot
  auto-dismiss, trust, model-selection) and a bounded poll that
  never reaches `resumed` return `ok:false` with
  `recovery: attention_required` plus last-12-line pane evidence.
- **Routes into existing projection**: `HarnessLaunchResult` ->
  startup-orchestrator `startupStatus: attention_required` ->
  `ps` / `status` projection. Same path the Codex auth-refusal
  case already shipped; no new state machinery.
- **Auto-dismiss preserved**: a skippable update gate still
  auto-dismisses and continues to success; only UNRESOLVED gates
  fail loudly. The readiness loop (`checkReady`) stays the
  SECOND check that upgrades the seat to `ready` once it
  genuinely reaches the TUI.
- **Carry-forward**: FR-1 (native Codex session-id hook) scope-
  tipped to 0.4.0 after build-time forensic; FR-2 ships alone in
  0.3.3.

### `rig send --verify` Honest Delivery Outcomes (slice 99.0.6.3)

The three outcomes are now named in the response:

- **`delivered`**: `ok:true` + post-capture re-confirmed the
  snippet (the prior `Verified: yes`).
- **`rendered-unconfirmed`**: text + Enter both succeeded but
  the capture could not re-confirm (redraw race, or the capture
  threw). LANDED, NOT failure. Exit stays clean.
- **`failed`**: the transport itself failed (`send_failed` /
  `submit_failed` carry `outcome: "failed"`; HTTP mapping
  unchanged).

The legacy `Verified: yes/no` line is preserved verbatim
(parsers); a new `Delivery:` line carries the named outcome plus,
for `rendered-unconfirmed`, a `rig capture <session>`
confirmation pointer. `--json` carries `outcome` through.
Mid-work / wait-for-idle REFUSALS deliberately carry no outcome
(nothing was sent).

### `rig whoami` Peers Contract (slice 99.0.6.1)

`peers[]` is this rig's roster EXCLUDING self. It is NOT a
directionally-edged subset, and it is NOT host inventory.

- **`WhoamiResult.peersNote`** (required string, additive)
  carries the contract in-band, naming the three pointers:
  `peers[]` (roster), `edges{}` (directional graph),
  `rig ps --nodes` (inventory including self + live state).
- **CLI Peers header**: keeps the literal `Peers:` prefix
  verbatim (shipped parsers grep on it), then adds the
  in-band clarifier.
- **No new field**: `peers[]` name and shape are unchanged; no
  `roster` / `podRoster` field is added (peers[] already IS the
  roster).

### Workflow Instantiate By Name (slice 04.1)

`rig workflow instantiate <built-in-name>` (e.g. `conveyor`,
`basic-loop`) now resolves end-to-end:

- `WorkflowRuntime.instantiate` resolves the identifier against
  the seeded spec cache BY NAME first via the new
  `WorkflowSpecCache.resolveSourcePathByName`, falling back to
  literal-sourcePath only when no named spec matches.
- The cache returns the STORED path verbatim — no source-tree
  re-derivation — so the `dist/builtins` production layout
  stays safe.
- Diagnostic rows are excluded via `version != ''` (valid specs
  always carry a version) so resolution needs no dependency on
  the slice-11 status column / migration.

### Guided Golden Path State Clarity (slice 04.2)

The new-operator golden path now points at the correct discovery
verb:

- `rig workflow specs` lists built-in / seeded workflow specs
  (`(built-in)` tagged). USE THIS to discover names before
  `rig workflow instantiate <name>`.
- `rig workflow list` lists workflow INSTANCES; empty for a
  fresh operator.

Corrected in `docs/reference/getting-started.md` and in the
CLI's `setup` golden-path text (`goldenPathNextSteps()` step 4).

### For-You Manage-By-Exception (slice 20)

Feed-interaction UX on existing signals only (the 0.4.0
attention-detection layer is untouched):

- **Drill-to-terminal**: new `FeedCardTerminalDrill` in the card
  footer opens the resolved source/author session's terminal
  PREVIEW via `GET /api/sessions/:sessionName/preview`,
  reusing `TerminalPreviewPopover` over the same
  externally-owned-trigger event contract `TopologyTerminalView`
  uses. Session-NAME keyed ONLY. Honest framing — "terminal
  preview" / "captured snapshot, not live"; disabled with an
  honest title when no session resolves.
- **Decision-band sort**: `feed-classifier` exports
  `sortFeedByDecisionBand` — a stable two-band partition
  (action-required + approval above progress / observation /
  shipped) using the existing newest-first comparator within
  each band. Applied at the single `Feed.tsx` merge-consumption
  seam. Not a ranking engine.
- **One-click approve (approve-only)**: `VerbActions` gains an
  additive `oneClickVerbs` prop. APPROVE submits directly on
  click; deny/route stay select+confirm. Defense in depth:
  prop type narrowed to
  `Array<Extract<MissionControlVerb, "approve">>` so misuse is a
  compile error, and a runtime `ONE_CLICK_SAFE_VERBS = {"approve"}`
  allowlist rejects cast-forced `"deny"` / `"route"`. Reuses the
  same `performSubmit` path (identical optimistic receipt and
  held-error behavior).

### CLI Release-Surface Parser (slice 13.1)

Deterministic TypeScript Compiler API extractor that walks
Commander registrations in `packages/cli/src/commands/*.ts` at
two git refs and emits a structured release-surface-diff:

- Resolves both Commander idioms (chained inline subcommands
  and factory indirection through `addCommand(buildChildCommand())`).
- Emits the REGISTRATION name (`rig-policy.ts` surfaces as
  `policy`); option name-tokens taken from `.option()` arg[0]
  only so template-literal descriptions never drop an option.
- Reads batched via one `git cat-file --batch` per ref (fast,
  offline, deterministic).
- 3-part honest failure shape; never a silent empty diff.
- NOT registered as a `rig` verb at 0.3.3 — the module is
  product code with hermetic test fixtures (including a
  v0.3.1..v0.3.2 worked example checked in at
  `src/release-surface/release-surface-diff.v0.3.1-v0.3.2.yaml`).

### Skill <-> CLI-Surface Binding Index (slice 13.2)

Deterministic offline lookup that joins a release surface-diff
to "which skills are affected by this release":

- Composes with the slice 13.1 parser; invocation-agnostic.
- Implements the ratified join grammar: component-wise prefix
  match in either direction (so `up` does not match `update`);
  conservative over-include bias for the no-false-negative floor.
- Drops `--version` from the binding index (the canonical grammar
  is command paths only, not global flags); the skill body still
  documents `rig --version` as prose.
- Ships with the v0.3.2-affected-skills regression fixture
  derived from the corpus.

### Known Limitations / 0.3.4+ Deferrals

- **Slice-21 FR-1 (native Codex session-id hook)**: scope-tipped
  to 0.4.0 after build-time forensic.
- **Slice-13 component 3 (auto-rollout dispatcher)**: skill-layer
  landing for this release; product-code dispatcher / invocation
  is intentionally out of the shipped runtime bundle. 13.1
  parser + 13.2 binding index ARE shipped product code.
- **Slice-05 sub-scopes carried forward**: agent / port /
  managed-app collision detection (Item 4.3); broader install-
  into-existing-rig pathway acceptance (Item 4.4);
  `--target-name` CLI flag for install-time rig-name overrides.
- **Slice-21 FR-4(d) accepted-queue-state schema**: deferred from
  0.3.2; carried forward.
- **Onboarding journey + battle-hardening**: slices 04
  (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) carried forward to a later release.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots remains a
  follow-up; non-blocking for 0.3.3.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental`
  only; not split-deferred (stays held).
- **`rig view list/show --json` flag inconsistency** — wrapper-
  layer routing path remains; the daemon's `view show <name>`
  route returns JSON correctly when invoked directly.
  Workaround: human-readable output for now.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts and migration 042 applies
rig daemon start

# Confirm rig archive surface is wired
rig archive --help
rig unarchive --help

# Confirm rig add surface is wired
rig add --help

# Confirm rig down accepts name-or-id
rig down --help

# Confirm rig workflow specs lists built-ins
rig workflow specs

# Confirm rig send --verify carries the delivery outcome
rig send --help | grep -i verify

# Confirm rig whoami peers contract is stated in-band
rig whoami --json | jq '.peersNote'
```

---

## [0.3.2] - 2026-06-02

**Status**: released. npm `@openrig/cli@0.3.2` (latest); GitHub Release
`v0.3.2`; git tag `v0.3.2`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step; CLI
  reports the new version after `npm publish`.
- **Migrations**: one new migration in 0.3.2 — `041_rig_policy`
  (`CREATE TABLE` for the operator-context-mode bindings store; no impact
  on existing data; binding rows are operator-authored at runtime).
  Existing databases upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.1 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon route
  paths, RigSpec/AgentSpec schemas, and persisted settings remain backward
  compatible. New routes are additive. New CLI commands (`rig policy`,
  `rig scope`, `rig workspace doctor`) are additive. New `rig queue create`
  flags (`--body-file`, `--mission`, `--slice`) are additive.

### Rigbundles First-Class

`rig bundle` ships cross-primitive bundling end-to-end:

- **Five content kinds routed**: skills + plugins (hybrid) +
  workflow_specs + context_packs + agent_images. Each kind lands in
  its canonical library under `$OPENRIG_HOME`; consumer-scan
  visibility preserved.
- **`bundle.yaml` author manifests** auto-detected when present.
  Vendoring uses both-sides path containment + symlink-escape
  protection + integrity hashing in the manifest.
- **`rig bundle create` new flags**: `--notes <text>`,
  `--min-daemon-version <ver>`, `--min-cli-version <ver>` — operator
  notes captured in bundle provenance metadata; min-version gates
  power the install-time compatibility check.
- **`rig bundle install` new flags**: `--skip-version-check` (operator-
  explicit override of the install-time compatibility check),
  `--force` (operator-explicit override of the install-time conflict
  check). NOT recommended for routine use; provided for known-good
  operator scenarios.
- **`rig bundle history`** — new subcommand reading
  `~/.openrig/bundle-audit.jsonl` with optional `--rig` /
  `--since` filters.
- **Install timeout bumped** — the prior 5-second cap was too short
  for tmux-session-bootstrapping installs.

### Workspace + Workflow GA

Operator-facing surface hardened:

- **`rig workspace validate --max-files`** — strict-int regex enforced;
  out-of-range values produce a 3-part error before `client.post`.
- **`rig workflow project --exit`** — enum guard against
  `handoff | waiting | done | failed`.
- **14 new discriminator tests** on validator paths.

### `rig up <starter>` Paper-Cut Fix-Round

Four bounded fixes unblocking the homepage quick-start on fresh
0.3.1→0.3.2 installs:

- **HTTP 4xx surface for pre-launch failures**: `cycle_error`,
  `preflight_failed`, `validation_failed`, `service_boot_failed` —
  replaces bare 500.
- **No orphan rig record on pre-launch failure**: instantiator
  re-ordered + rollback path + compose teardown order tightened.
- **Path-form `rig up <install-internal-spec>` defaults cwd**: closes
  the divergence between path-form and bare-form invocation; library
  specs now match path-form behavior.
- **`walkYamlFiles` skip standard noise dirs**: `.worktrees`,
  `node_modules`, `.git`, `dist`, `.turbo`, `.next`. Plus stale
  `workflow_specs` rows prune at startup with an install-root
  preservation guard (shipped built-in specs survive the prune).

### Coordination + First-User Setup Fix-Round (slice 21)

Five bounded follow-rounds:

- **FR-1 — Coordination-model boot instinct**: `rig send` vs
  `rig queue` vs `rig queue handoff` + §1b doctrine surfaced in
  `core/openrig-user/SKILL.md`.
- **FR-2 — First-user workspace + workflow setup teaching**: skill
  + docs content for the path from fresh install to first
  workflow_spec authoring.
- **FR-3 — MISSION_NOTES durable-pattern hardening**: convention
  codemap + auto-scaffold via `rig scope mission create` (uses
  `conventions/mission-notes/TEMPLATE.md`); `--no-mission-notes`
  opts out.
- **FR-4 — Queue ergonomics**:
  - `rig queue create --body-file <path>` (use `-` for stdin) kills
    the backtick-shell-corruption class for multiline bodies.
    Mutually exclusive with `--body`.
  - First-class `--mission <id>` / `--slice <id>` flags translate
    to `mission:<id>` / `slice:<id>` tags (compose with `--tags`).
  - `lastNudgeResult` wording fix; closure-vs-acceptance docs.
- **FR-5 — `rig workspace doctor`**: 7-check workspace-readiness
  diagnostic (workspace root, missions folder, file allowlist,
  daemon alignment, daemon reload, optional slice docs,
  MISSION_NOTES presence). Default exit-code: non-zero only on
  `fail`; `--strict` makes warn-or-fail non-zero. CLI overlays
  `OPENRIG_FILES_ALLOWLIST` from operator's shell env.

### Daemon Test Substrate-Path Scrub (slice 14)

Internal-team substrate path shape scrubbed from 4 daemon source
sites + 10 test files. Hook-constants de-duplicated. Privacy class
closed for tracked source + test surface.

### ConceptCard Data Source (slice 17)

`ConceptCard` wired to shaped backlog candidates; storytelling-adapter
completion deferred from 0.3.1 is now complete.

### For-You Priority Windowing (slice 20)

Server-side attention query (Option 3): SQL predicate pushdown +
exact-match attention regex + dismissal as string-keyed for
queue-derived cards.

### Operator Context-Mode Bindings (slice 09)

New `rig policy` command surface paired with daemon-side typed-primitive
store (migration `041_rig_policy`):

- **Six modes**: `sleep | desk | mobile | away | focus | debug`.
- **Four scopes**: `global_host | rig | workstream | qitem`.
- **Restate-and-confirm posture (HG-4)**: `set` is restate-only
  until `--confirm` is passed; scripts cannot silently apply a
  binding.
- **`--qualifier` strict reject for `global_host` (HG-7 guard
  finding)**: operators who type `--scope global_host --qualifier
  <id>` get an error and the daemon is never contacted.
- **Operator-edit verbs require bearer token**: `set --confirm`
  and `unset` require `--bearer <token>` (or
  `OPENRIG_AUTH_BEARER_TOKEN` env).
- **6 subcommands**: `set`, `show`, `effective`, `cite`, `unset`,
  `defaults`.

### Scope Tree Primitive (slice 12)

New `rig scope` command for operating the substrate scope tree
(missions, slices, sub-slices) per
`conventions/scope-and-versioning`:

- **Mission tier**: `ls`, `show`, `create` (auto-mints stable
  dot-IDs into mission frontmatter; auto-scaffolds MISSION_NOTES
  by default; `--template` auto-selects `release` when name matches
  `release-X.Y.Z`).
- **Slice tier**: `ls`, `show`, `create`, `ship`, `close`, `move`.
- **Templates ship under `dist/lib/scope-templates/`**: `release-
  feature`, `placeholder`, `mission-notes`, `bug-fix`,
  `research`, `backlog-deprecation`, `backlog-tech-debt`,
  `mission-placeholder`, `mission-release`.
- **Top-level option `--workspace <path>`** overrides workspace
  root (otherwise inferred from cwd or `$OPENRIG_WORK_ROOT`).

### Known Limitations / 0.3.3 Deferrals

- **Slice-05 Item-3 sub-scopes deferred to 0.3.3**: agent/port/managed-app
  collision detection (Item 4.3); broader install-into-existing-rig
  pathway acceptance (Item 4.4); the `--target-name` CLI flag.
  Design-contingent on the CLI surface decision.
- **Slice-21 FR-4(d) accepted-queue-state schema deferred to 0.3.3**:
  the new `accepted` queue state is a schema model change; carried
  forward per the release-triage philosophy.
- **Onboarding journey + battle-hardening deferred to 0.3.3**: slices
  04 (new-user-journey), 08 (hooks-elite), 10 (rig-self), 11
  (personal-rig) physically moved to the `release-0.3.3` mission tree.
- **Workspace symlink alignment**: daemon-side workspace-resolver
  alignment with operator symlinked workspace roots is a follow-up
  from slice-21 FR-5 QA; non-blocking for 0.3.2.
- **Slice-13 permission-block-routing-architecture remains held**:
  big-green-light gated by operator review; `rigx-experimental` only;
  not split-deferred to 0.3.3 (stays held).
- **`rig down <name>` still returns HTTP 404** at v0.3.2; use
  `rig down <rigId> --delete` instead.
- **`rig view list/show --json` flag inconsistency** — wrapper-layer
  routing path remains; daemon's `view show <name>` route returns
  JSON correctly when invoked directly. Workaround: human-readable
  output for now.

---

## [0.3.1] - 2026-05-15

**Status**: released. npm `@openrig/cli@0.3.1` (latest); GitHub Release
`v0.3.1`; git tag `v0.3.1`.

### Summary For Installing Agents

- **Package version**: package metadata bumped at release-manager step; CLI
  reports the new version after `npm publish`.
- **Migrations**: no schema-breaking migrations in 0.3.1. Existing databases
  upgrade by running `rig daemon start`.
- **Node engines**: unchanged from 0.3.0 (CLI accepts Node `>=20`).
- **Backward compatibility**: existing CLI argument shapes, daemon route
  paths, RigSpec/AgentSpec schemas, and persisted settings remain backward
  compatible. New routes are additive. New ConfigStore keys are opt-in
  default-off.

### Claude Auto-Compaction Policy

The headline 0.3.1 feature: operator-configurable Claude session
auto-compaction with safe defaults.

- **Opt-in default-off**: with no policy configured, no behavior change. The
  daemon never sends an auto-`/compact` until the operator explicitly enables
  the policy.
- **7 new ConfigStore keys** in the `policies.claude_compaction.*` namespace
  (lockstep across CLI VALID_KEYS + daemon SETTINGS_VALID_KEYS): `enabled`,
  `threshold_percent` (strict integer 1-100), `compact_instruction` (default
  empty; appended to `/compact` slash-command args when set),
  `message_inline`, `message_file_path`, `pre_compact_instruction`,
  `post_restore_audit_instruction`. Strict validation across all source
  layers (`set/POST/env/file`) — invalid env values fall back to defaults
  with a warning to stderr rather than silently coercing.
- **5 operator-editable prompt surfaces** rendered in the
  Settings → Policies UI form: pre-compaction prep, compact instruction,
  post-compaction restore (inline), restore file path, post-restore audit.
  Daemon-owned wrappers (usage/threshold framing, trust-channel preservation,
  marker paths, read-depth enforcement, turn-boundary handshake, dedup +
  cooldown) are non-editable.
- **6-stage daemon-to-LLM lifecycle**:
  1. Pre-compact prep prompt — full-context Claude writes a mental-model
     restore map (annotated ASCII file/folder tree) before compaction
     ("save game before quit").
  2. `/compact` with operator instructions + trust-channel preservation
     embedded in args.
  3. Post-compact turn-boundary handshake — non-restorative acknowledgment
     creates an assistant-turn boundary so the subsequent restore prompt
     lands in the correct trust context.
  4. Restore prompt — explicit user-request shape; defense-in-depth
     fallback chain (marker → JSONL transcript path → session-id → generic).
  5. Compliance prompt — forces FULL/PARTIAL/NOT_READ read-depth audit
     table; counters Claude's deferred-execution + token-conservation
     instincts.
  6. Cooldown (10-minute default) — prevents re-fire while restore work
     is still consuming context.
- **PreCompact hook + SessionStart/UserPromptSubmit bridge**: the openrig-core
  plugin ships a marker-bridge that picks up pending-restore markers
  post-compaction and injects restore directives once. Templates live in
  the `claude-compaction-restore` skill and ship with the plugin.
- **Safety hardening**: SessionTransport classifies typed prompt drafts as
  attention state — auto-`/compact` retries later instead of overwriting
  human input. Send-failure does not advance dedup state (transient retry).
  Re-arm requires threshold-crossing (session must drop below threshold
  before next auto-compact).

### Library Explorer Finishing

The Library destination (skills + plugins + specs) became a fully
operator-facing surface:

- **No duplicate top-level entries**: `> SKILLS` and `> PLUGINS` rows
  removed from the top of `SpecsTreeView`. Bottom-row clicks now do
  dual-action (navigate to the matching index page + expand the tree).
- **Reorder**: Plugins above Skills.
- **OpenRig-managed skills discovery**: 32 shared skills now visible in
  the tree + on `/specs/skills` index. Previously the workspace-relative
  path lookup returned empty in production VM environments.
- **Daemon-owned library discovery API** (new):
  - `GET /api/skills/library` → consolidated `LibrarySkillPublic[]`
    (workspace + openrig-managed sources; absolute paths not leaked).
  - `GET /api/skills/:id/files/list?path=<rel>` + `/api/skills/:id/files/read?path=<rel>` —
    skill folder browse + content read.
  - `GET /api/plugins/:id/files/list?path=<rel>` + `/api/plugins/:id/files/read?path=<rel>` —
    plugin folder browse + content read.
  - `PluginEntry.skillCount` field added to plugin discovery
    serialization.
- **Real file-browser docs-browser on plugin and skill detail pages**:
  detail pages mount a `DirectoryTree` + `FileContentPanel` against the
  real plugin/skill folder. Markdown auto-renders; non-markdown files
  (e.g. `.ts`, `.json`) render as text. Folder navigation works (entering
  subfolders + listing files).
- **Rolled-up index pages**: `/specs/skills` lists all skills as flat rows
  with source label + file count + entry link. `/specs/plugins` lists all
  plugins as rows with version + runtimes + skill-count + entry link.

### Plugin Primitive v0

- **Plugin discovery**: vendored plugins under `$OPENRIG_HOME/plugins/`
  (default `~/.openrig/plugins/`) are discovered, validated, and
  surfaced through `rig plugin list` + `/api/plugins`.
- **Plugin install (v0)**: explicit operator copy or symlink to
  `$OPENRIG_HOME/plugins/<plugin-id>/`. A `rig plugin install
  <substrate-path>` verb is deferred to 0.3.2; see `OPENRIG-INSTALL.md`
  inside each plugin's source for the documented copy/symlink workflow.
- **CLI**: `rig plugin list` / `show` / `used-by` / `validate` subcommands
  available. No `install` subcommand at v0.
- **Plugins shipped as substrate references** (for plugin authors to
  copy-install): `gstack` (45 skills), `obra-superpowers` (14 skills).
  `openrig-core` ships bundled with the daemon (11 skills).

### Settings Destination Explorer

Settings became a 4-item Explorer destination matching Topology /
Project / Library / For-You pattern:

- `/settings` (general config keys form), `/settings/policies`,
  `/settings/log`, `/settings/status`.
- Old top-row tab nav removed.
- Shared `SettingsPageShell` chrome across all 4 sub-routes.
- Policies page is the home for the Claude auto-compaction policy form
  (see above).

### CMUX Launcher

- **Launch in CMUX button** on the rig-scope topology tab-bar trailing
  slot. Opens a cmux workspace for the rig with appropriate title +
  cwd parameters. Powered by new daemon route + cmux adapter
  extensions.

### Node-Page Overview + Details

- **Seat overview table** consolidated as 7-column horizontal layout with
  vertical grid lines (Claude/Codex agent + status + context + tokens +
  uptime + cwd + current-work).
- **Tab consolidation** + activity alignment on the node-detail surface.
- **Alert-only notification banner** (renders only on real-alert states:
  `failed`, `attention_required`, or `latestError !== null`); generic
  `recoveryGuidance` no longer triggers a banner on every seat.
- **cwd / current-work separation**: factored into a `SeatOverviewSecondary`
  primitive below the column table.

### Mobile Drawer Behavior

The Explorer drawer at 375px viewports now layers above the mobile rail
tray for Settings / Project / Library / For-You destinations
(previously hidden behind rail-tray; visible click path didn't register
on Explorer items). Topology mobile drawer is intentionally hidden in
0.3.1 (clicking the hamburger triggered a pre-existing
TopologyTableView renderer cascade); the topology mobile drawer is
scheduled for full restoration in 0.3.2 via a dedicated
TopologyTableView render-path slice.

### Dashboard And For You Visual Refresh

The Dashboard (`/`) and For You (`/for-you`) destinations got a coordinated
visual refresh to a "vellum" surface language — translucent stone-tinted
cards over a paper-grid background, ambient multi-stop shadow, mono+dot
kind indicators, and L-shaped corner-bracket registration marks. The
chrome vocabulary is consistent across destination cards (Dashboard) and
both feed-card systems (For You).

- **Dashboard** — full rewrite of `/` into a thin composition over new
  `dashboard/vellum/` primitives (`BackVellumSheet`, `MidLayerContent`,
  `TopLayerContent`, `DestinationsLayer`, `VellumDestinationCard`,
  `CornerBracket`, `graphics.tsx`, `marks.tsx`). Hero typography ("WELCOME
  BACK") at display-lg + headline-bold; tactical instrument-panel stats
  line with tabular numerals and a success-token active count. Six
  destination cards (Topology / Project / For You / Library / Search /
  Settings) share the same numeral-layout treatment. Real-data hooks
  thread through (`useRigSummary`, `usePsEntries`, `useSpecLibrary`,
  `window.location.hostname`).
- **For You** — both card systems unified to the same vellum recipe:
  - Storytelling band: `CardShell` rewritten to bg-stone-100/45 +
    backdrop-blur-[10px] + ambient shadow + corner brackets; design-token
    leading dots replace prior bg-emerald-50 / bg-amber-50 / etc.
    off-brand utilities. Title at 16px headline-bold; body at 12px.
  - Queue-item `FeedCard.tsx`: same outer chrome; `KIND_DOT` + `TONE_DOT`
    design-token maps; vellum bordered-no-fill action buttons
    (Approve/Deny/Route/Hold/Drop/Annotate/Handoff) with hover-invert and
    44px touch targets; `TONE_RECEIPT` strip is a subtle bg-stone-50/40
    with a leading colored dot.
- **Single source of truth** — `/dashboard` and `/lab/vellum-lab` both
  import from `packages/ui/src/components/dashboard/vellum/index.js`.
  Future visual changes hit one location.
- **Lab routes** — `/lab/card-previews`, `/lab/vellum-lab`,
  `/lab/vellum-bg/{a-large,b-small,c-allover}` are checked-in experiment
  surfaces for designer iteration. Reachable in production by direct URL;
  not linked from main nav. Useful when iterating on the visual system.

### For You Storytelling Adapter

The storytelling band (top of `/for-you`) now wires four card kinds to
real data:

- **Progress** — from `useMissionDiscovery` (first 2 active missions)
- **Shipped** — from `useSlices` (status = shipped/complete/done; capped at 3)
- **Incident** — from `useSlices` (status = blocked/failed/danger or fallback "info"; capped at 3)
- **Approval** — from `useActivityFeed` + `classifyFeed` (kind === "approval";
  capped at 2; qitemId extracted from event payload with snake_case alt
  and `FeedCard.id` fallback). Surfaces real queue items waiting on
  approval in a high-visibility band.

`ConceptCard` component is preserved in source but not emitted by the
production adapter — a deliberate data-source decision is scheduled for
0.3.2.

### Action Outcome And Inline Error Surface

Queue-item action buttons (`VerbActions` — Approve/Deny/Route/Hold/Drop/
Annotate/Handoff) now render outcomes immediately and surface failures
without silently reverting:

- **Optimistic outcome** — on mutation success, the
  `ActionOutcomePanel` ("Approved by X" / "Routed by X to Y") renders
  immediately. Audit-log roundtrip reconciles in background. Operator
  no longer waits for a query refetch to see what happened.
- **Inline error surface** — on mutation error, a tertiary-bordered
  error block renders below the verb buttons with the daemon's error
  message; verb-selection state is preserved so the operator can
  correct and retry. Replaces the prior silent-revert UX where errors
  were never displayed.
- **React-query callback discipline** — `submit()` split into separate
  `onSuccess` (optimistic outcome + reset selection) and `onError`
  (set error message; do NOT reset). Regression test guards the
  silent-revert class explicitly.

### Vendored Skill Provenance

Vendored skills shipped in `packages/daemon/specs/agents/shared/skills/`
now declare their upstream lineage via `metadata.openrig` frontmatter
and (when modifications exist) a companion `OPENRIG.md` sidecar:

- **vendoring_pattern**: `vendored-as-is` | `modify-the-file` |
  `add-supplementary-files`
- **vendored_from**: upstream source identifier
- **last_upstream_check**: most recent diff date
- **divergence_notes**: human-readable summary of OpenRig-specific changes

Applied to all 10 process-skill surfaces (agent-browser, executing-plans,
brainstorming, systematic-debugging, test-driven-development,
using-superpowers, verification-before-completion, writing-plans,
frontend-design, dogfood). `OPENRIG.md` sidecars added where the file
has been modified or supplemented (agent-browser + executing-plans +
brainstorming + using-superpowers + writing-plans). Convention is
documented in the `writing-skills-for-openrig` skill.

### Plugins And Skills On The VM (Operator Note)

Operators dogfood-testing 0.3.1 should expect:

- **Stock VM install**: only `openrig-core` plugin is bundled. The
  `/specs/plugins` UI list will show one plugin until the operator
  installs additional plugins per the v0 copy workflow.
- **Skills**: 32 OpenRig-managed shared skills ship under
  `packages/daemon/specs/agents/shared/skills/` (discovered via the
  daemon skill-library API; no operator action required).
- **User-installed skills**: skills the operator installs under
  `~/.openrig/skills/` or the workspace `.openrig/skills/` directory
  surface in the same list.

### Config + Settings

Continues from 0.3.0 with the slice 08 validation pass:

- `rig config get/set/reset/list` remains the canonical CLI surface.
- Lockstep CLI `VALID_KEYS` + daemon `SETTINGS_VALID_KEYS` byte-identical
  sets (verified in slice 08).
- Help-drift CI gate from slice 08 honored across all new keys added in
  0.3.1.

### SC-29 Exceptions

The SC-29 exception process tracks explicit scope expansions to release
contracts. Exceptions declared in 0.3.1:

- **#10 (slice 24)**: cmux launcher — `POST /api/rigs/:rigId/cmux/launch`
  + CmuxLayoutService + 4 CmuxAdapter RPC methods.
- **#10 (slice 27, numbering collision)**: Claude auto-compaction policy
  — 7 `policies.claude_compaction.*` ConfigStore keys. (Numbering
  collision with #10 above is a process-only inconsistency; both code
  scopes are correctly merged. Canonical `SC29-LEDGER.md` and ledger
  hygiene scheduled for 0.3.2.)
- **#11 (slice 28)**: Library Explorer daemon API — 5 new daemon GET
  endpoints (`/api/skills/library`, `/api/skills/:id/files/list`,
  `/api/skills/:id/files/read`, `/api/plugins/:id/files/list`,
  `/api/plugins/:id/files/read`) + 2 response shape additions
  (`PluginEntry.skillCount`, `LibrarySkillPublic`).

### Known Carry-Forwards (0.3.2 Candidates)

- **`rig plugin install <substrate-path>` verb**: explicitly deferred.
  Documented copy/symlink workflow is the v0 install path.
- **Topology mobile drawer**: hidden in 0.3.1 to avoid a pre-existing
  TopologyTableView renderer cascade at 375px viewports. Full
  restoration scheduled for 0.3.2 via dedicated render-path slice.
- **Plugin source-label taxonomy**: copy-installed plugins currently
  land in the `vendored` source kind; UI label says "No user-installed
  plugins" while listing them. Taxonomy refinement scheduled for 0.3.2.
- **`SC29-LEDGER.md`**: canonical SC-29 numbering ledger document.
  Authors currently self-assign exception numbers; documented ledger
  prevents collisions like the slice 24/27 #10.
- **VM PreCompact hook installer**: the documented install path for the
  `claude-compaction-restore` skill is operator-manual at v0; an
  automated installer is a 0.3.2 candidate.
- **`docs/DESIGN.md` docs-guard violation**: pre-existing
  `npm run test:repo` failure; tracked doc outside allowed paths;
  cleanup scheduled for 0.3.2 documentation hygiene pass.
- **Environment-dependent tests**: a small number of vitest suites fail
  on developer hosts due to port-conflicts (preflight) or live host
  Claude hook state (restore-check); focused-test gates pass these
  suites; cumulative-workspace runs surface the gaps. Isolation cleanup
  scheduled for 0.3.2.
- **Cross-daemon route awareness**: the VerbActions destination dropdown
  on `/for-you` currently lists session names without checking whether
  the local daemon can reach them. Routing to a non-local destination
  surfaces as an inline error (per the new error surface above) but the
  dropdown should ideally filter to local-daemon seats. 0.3.2 candidate.
- **ConceptCard data source**: `ConceptCard` component is preserved in
  source but not wired in the production adapter. A 0.3.2 slice will
  pick a deliberate data source (likely shaped backlog candidates or
  early-stage discovery items).
- **Warm error messages on demo surfaces**: daemon error strings (e.g.,
  "queue item not found") surface verbatim through the inline error
  surface. Demo-grade polish to humanize these on user-facing surfaces
  is scheduled for 0.3.2.

### Banked Discipline Patterns

0.3.1 surfaced a number of canonical agent-software-design patterns
during the Claude compaction iteration cycle and Library Explorer
finishing work. These are banked in operator-skill documentation for
agent-prompt design + daemon-to-LLM trust establishment:

- **Channel model**: normal user message is the only authorized action
  surface; hook stdout is informational-only; `/compact` args carry
  trust contracts that the post-compact prompt invokes.
- **Turn-boundary handshake**: when a daemon-driven action request
  would land too adjacent to local-command output, insert a
  non-committing acknowledgment message first to create an
  assistant-turn boundary.
- **Save-game-before-quit pattern**: full-context agent writes
  restoration breadcrumb before forced context loss; context-loss
  agent reads it on restore.
- **Structured-output forces completeness**: ask LLMs for explicit
  FULL/PARTIAL/NOT_READ accounting when thoroughness matters; counters
  token-conservation instincts.
- **Daemon-owned shared-resource discovery**: skill/plugin discovery
  belongs at the daemon layer with HTTP endpoint surfaces; UI consumes
  via typed API. Avoids workspace-cwd-relative path-resolution
  brittleness.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts cleanly
rig daemon start

# Confirm new Claude compaction policy keys are visible
rig config list | grep policies.claude_compaction

# Confirm plugins discoverable
rig plugin list

# Confirm skills discoverable
curl -s http://localhost:7433/api/skills/library | jq 'length'
```

---

## [0.3.0] - 2026-05-10

**Status**: release candidate for public publish. This entry documents the
changes since `0.2.0`.

### Summary For Installing Agents

- **Package version**: package metadata is still `0.2.0` until the release
  manager performs the final version bump. The release contents documented here
  are the intended `0.3.0` payload.
- **Migrations**: fresh databases apply migrations through
  `039_queue_target_repo`. Existing databases migrate by running
  `rig daemon start`.
- **Node engines**: the published CLI accepts Node `>=20`. The root package and
  private daemon package remain constrained to active even-numbered Node lines.
- **Specs and primitives**: workflow specs, context packs, agent images,
  workspace scaffolds, file browsing, queue observability, context usage, and
  runtime skill discovery are all first-class product surfaces.
- **UI shell**: the operator UI has been rebuilt around the V1 shell:
  destination rail, explorer, center workspace, detail drawer, vellum surfaces,
  topology graph/table/terminal modes, and focused project observability.
- **Starter content**: `0.3.0` ships generic starter workflows and starter rigs.
  Project-specific automation recipes are intentionally not shipped in product
  source.
- **No schema-breaking release change**: existing CLI argument shapes, daemon
  route paths, RigSpec/AgentSpec schemas, and persisted settings remain
  backward compatible unless noted below.

### Quick Verification Commands

```bash
# Confirm CLI version after the release-manager version bump
rig --version

# Confirm daemon starts and migrations apply
OPENRIG_DB=/tmp/openrig-030-verify.sqlite rig daemon start

# Confirm settings are readable
rig config list --with-source

# Confirm starter specs are visible
rig specs ls --json

# Confirm runtime identity and loaded context
rig whoami --json
```

If any verification fails, see "Failure Modes And Remediation" below.

---

### V1 Shell And Operator UI

The `0.3.0` UI moves from prototype surfaces to a coherent operator shell:

- Two desktop chrome regions: destination rail and explorer.
- Center workspace for full pages.
- Default-closed detail drawer for previews and referenced content.
- Topology graph/table/terminal modes at a single topology URL.
- Settings rendered as a center workspace page, not as a sidebar panel.
- Vellum surface primitives, 1px region borders, and black-glass terminal
  preview styling.
- Shared runtime graphics marks for agent/runtime/tool identity.
- Retired legacy surfaces: old sidebar shell, legacy dashboard page, and
  rig-detail drawer patterns.

### Starter Rigs And Workflows

OpenRig now ships starter content designed to be useful on a fresh install
without exposing project-specific automation recipes.

- `product-team` is the primary human-directed starter rig.
- `conveyor` is the primary workflow-oriented starter rig.
- `conveyor` includes two generic workflow specs:
  - **Conveyor**: each stage can process queued work independently, so multiple
    packets can be in flight at once and natural queue backpressure handles slow
    stages.
  - **Basic loop**: one packet advances hop-by-hop around a small loop, useful
    when the operator wants a slower, easier-to-watch workflow.
- Generic starter workflows use the workflow runtime and queue primitives. They
  are examples and building blocks, not a hidden project workflow.
- Project-specific workflow specs can still be installed from a user workspace
  or private spec directory; they do not need to be committed to product source.

### Mission-Shaped Workspace Defaults

Fresh installs now have a coherent default workspace path and scaffold:

- `rig config init-workspace` creates the default workspace structure.
- Workspace defaults include missions, slices, specs, proof/evidence locations,
  steering files, and user-editable docs.
- Existing installs are rebased at read time so newer defaults become available
  without destructive rewrites.
- Read-only mission/slice indexing supports nested mission-shaped workspaces
  while preserving compatibility with earlier flat-root layouts.

### Project Observability

Project and queue work is now easier to inspect from the UI:

- For You cards classify queue lifecycle events, shipped work, progress,
  observations, and approvals.
- Queue cards hydrate qitem bodies and proof previews.
- Story tabs emphasize qitem body content and paginate long activity streams.
- Queue rows preview bodies and open the detail drawer with full source,
  destination, state, tags, and created-time metadata.
- Tests tabs show diagnostics and proof assets when no proof is available.
- Workspace and mission rollup pages include scoped Progress, Artifacts, Queue,
  and Topology tabs.
- Current/archive grouping separates active project work from old seed or
  completed work.

### Mission Control And Queue Actions

Mission Control remains the operator surface for queue observability and
qitem actions:

- Views include personal queue, human gate, fleet, active work, recent ships,
  recent activity, and recent observations.
- Actions include approve, deny, route, annotate, hold, drop, and handoff.
- Mission Control audit outcomes are reflected back into For You cards so
  terminal or already-actioned items show evidence instead of stale controls.
- Audit browsing and action history are read-only inspection surfaces.
- Existing daemon endpoints are reused; no extra workflow-specific endpoint is
  required for the public starter content.

### Files, Markdown, Progress, And Proofs

The file and proof surfaces were expanded:

- File browser supports allowlisted roots, safe reads, asset reads, and
  conflict-checked writes.
- Markdown rendering supports frontmatter, code blocks, tables, images, and
  raw/rendered toggles.
- Progress views render status pills, hierarchy, and next-work markers.
- Proof screenshots open in an in-page viewer.
- File drawer headers, proof rows, queue related refs, and story rows use
  shared graphics marks for faster scanning.

### Workflow Runtime And Spec Library

Workflow primitives are available as general infrastructure:

- Workflow specs are cached from markdown/YAML sources.
- Workflow instances and step trails are persisted.
- Specs library includes workflow entries and graph preview.
- Slice and project story surfaces can render spec-aware topology when a slice
  is bound to a workflow instance.
- Cycle-aware traversal prevents graph rendering from hanging on looping specs.

### Context Packs And Agent Images

OpenRig now has additional reusable primitives for context and session state:

- `context_packs` package related context files into a coherent sendable bundle.
- `agent_images` capture reusable starter state from productive sessions.
- Library review surfaces can inspect these primitives and show safe summaries.
- AgentSpec startup can reference context packs and agent images.
- Resume-token data is redacted at route boundaries.

### Topology, Activity, And Context Usage

Topology is now a working operational surface rather than a static diagram:

- Graph/table/terminal views are available at the topology route.
- Host graphs can show multiple rigs on one canvas.
- Rig groups can expand/collapse, persist that state, and auto-expand for
  current rig/pod/seat URLs.
- Agent activity, queue handoffs, token telemetry, and context usage are visible
  in topology views.
- Codex context telemetry is read from local session state and reflected in
  topology table and terminal views when available.
- Detached Codex sessions can still expose the last readable context sample;
  Claude context remains running-session based.

### Terminal Preview

Terminal preview matured across several passes:

- Preview panes use existing session capture primitives.
- Compact terminal popovers are portal-mounted, clamp to viewport edges, and
  resize/reposition on scroll or viewport changes.
- The compact view strips unnecessary chrome and uses a black-glass visual
  language.
- The proof viewer and terminal preview share consistent drawer/popover
  behavior.

### Runtime Skill Discovery

Runtime skill discovery is now part of profile resolution:

- Rig-local skill references still win first.
- Skills can be discovered from runtime-specific and shared user skill roots.
- Structurally invalid `SKILL.md` files are rejected with precise reasons.
- Profile resolution surfaces rejected-skill reasons instead of treating every
  broken skill as merely missing.
- The behavior is intentionally strict: a skill must have frontmatter, non-empty
  `name`, non-empty `description`, and non-empty body content.

### CLI And Daemon Release Hardening

Several release-blocking polish items landed in the CLI/daemon:

- Transcript capture now uses bounded `tmux capture-pane` polling instead of an
  unbounded pipe file.
- `rig send` wraps delivered messages with sender/recipient context and a reply
  hint.
- Generated setup markers use OpenRig naming.
- Original runtime environment aliases keep deprecated `RIGGED_*` fallbacks for
  compatibility; newer typed settings use `OPENRIG_*` only.
- ConfigStore and SettingsStore remain lockstep for typed settings.
- No new plugin loader ships in `0.3.0`; plugin support is planned for a later
  release.

### Removed Or Not Included

- Project-specific workflow recipes are not included in product source.
- The old `demo` rig is no longer the recommended starter; public docs point to
  `product-team` and `conveyor`.
- The legacy `mental-model-ha` skill is removed from starter guidance.
- Root runtime projections such as `CLAUDE.md` are intentionally not tracked.
- Package-local `pnpm-lock.yaml` files are intentionally not restored; this repo
  uses npm workspaces and the root `package-lock.json` for release installs.
- Internal release artifacts and local dogfood packets are not part of the
  public release notes.

---

### Failure Modes And Remediation

**`rig daemon start` fails with an ABI mismatch**

- Cause: native dependencies were compiled against a different Node version.
- Remediation: use an active even-numbered Node release, or rebuild native
  dependencies from the installed package directory.

**Files browser or Progress view appears empty on a fresh install**

- Cause: workspace scaffold has not been initialized or the configured root is
  not where the operator expects.
- Remediation: run `rig config init-workspace`, then inspect
  `rig config list --with-source`.

**Mission Control views are empty**

- Expected on a rig with no queue items.
- Remediation: create or hand off a queue item, then refresh. If still empty,
  confirm daemon status and DB path with `rig daemon status` and
  `rig config get db.path`.

**A skill reference resolves as rejected**

- Cause: the target `SKILL.md` exists but failed structural validation.
- Remediation: fix the skill frontmatter and body. It must include delimited
  YAML frontmatter with non-empty `name` and `description`, followed by non-empty
  markdown body content.

**A public starter workflow is too simple for a specialized loop**

- Expected. `0.3.0` ships reusable primitives and generic starter workflows.
  Specialized workflow specs should live in user workspace or private rig
  packages.

---

## [0.2.0] - 2026-04-22

Baseline for this changelog. Key shipped capabilities at `0.2.0`:

- Pod-aware multi-agent runtime with RigSpec, AgentSpec, pods, and seats.
- Rig-scoped environment management.
- Filesystem-backed spec library for built-in and user roots.
- Daemon-backed stream, queue, project, view, watchdog, and workflow primitives.
- Cross-runtime restore packets for Claude Code and Codex sessions.
- Communication primitives: `rig send`, `rig capture`, `rig broadcast`, durable
  rig chat, and transcript inspection.
- Identity and lifecycle commands: `rig whoami`, adoption/bind/materialize
  flows, snapshot/restore, and post-command handoff.
- Operator surfaces: `rig ps`, `rig ps --nodes`, queue inspection, and daemon
  status.
- 32 SQLite migrations.

---

*This changelog is written for agents and humans. It should describe public
release behavior without depending on local workspace paths or private project
packets.*
