---
kind: as-built
title: Adapters and Runtimes — Claude/Codex/Pi/Stub/Terminal, tmux/cmux, Resume Honesty
status: active
topics: [agent-runtime, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need the runtime-adapter contract — how OpenRig launches and resumes a
  Claude Code, Codex, Pi, Oh My Pi, stub or terminal harness inside tmux, what
  the five required adapter methods do, or how the daemon honestly assesses
  whether a harness actually resumed vs fresh-launched (the resume-honesty
  layer).
siblings: [daemon-core.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d
last-updated: 2026-10-05
---

# Adapters and Runtimes

How OpenRig drives the agent harnesses. Pod-aware launches go through a
`RuntimeAdapter`: five adapter classes implement one contract of five required
methods. Legacy (non-pod-aware) restore resumes through separate resume
adapters (`ClaudeResumeAdapter`, `CodexResumeAdapter`, `PiResumeAdapter` and
`OmpResumeAdapter` in `packages/daemon/src/adapters/*-resume.ts`), which are not
`RuntimeAdapter`s. A separate resume-honesty layer answers the question "did
this harness *actually* resume, or did it silently fresh-launch?" truthfully
rather than optimistically.

> Verified against source at main `82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The five-method RuntimeAdapter contract

`RuntimeAdapter` is `packages/daemon/src/domain/runtime-adapter.ts:141`
(`interface RuntimeAdapter`). Every adapter declares a `readonly runtime`
string (`runtime-adapter.ts:144`) and implements five required methods
(`runtime-adapter.ts:150–174`; **5** =
`sed -n '/^export interface RuntimeAdapter/,/^}/p' packages/daemon/src/domain/runtime-adapter.ts | grep -c -E '^  [a-zA-Z]+\('`):

| Method | Signature (`runtime-adapter.ts`) | Responsibility |
|---|---|---|
| `listInstalled` | `(binding)` `:151` | List currently installed/projected resources for a node. |
| `project` | `(plan, binding)` `:154` | Project resources from a `ProjectionPlan` to the runtime's target locations. |
| `deliverStartup` | `(files, binding, sendInteractiveText?)` `:158` | Deliver resolved startup files to the runtime. The startup orchestrator passes the optional third argument for Claude Code only, so Claude's `send_text` files go through the checked send described in `agent-spec-and-startup.md`. |
| `launchHarness` | `(binding, opts)` `:168` | Launch the harness inside the bound tmux session; return a resume token. |
| `checkReady` | `(binding)` `:172` | Probe whether the harness is responsive and ready. |

The interface also has two optional members: `claudeManagedLaunch` (`:143`)
and `skillTargetPath?()` (`:148`), implemented by `PiRuntimeAdapter`
(`pi-runtime-adapter.ts:118`) and overridden by `OmpRuntimeAdapter`
(`omp-runtime-adapter.ts:12`).

Startup *action* execution (`slash_command` / `send_text`) is explicitly **not**
part of this contract — the contract docstring (`runtime-adapter.ts:135–140`)
states actions belong to the `StartupOrchestrator` *after* `checkReady()`. The
orchestrator delivery split is in `agent-spec-and-startup.md`.

### `launchHarness` opts and the fork seam

`launchHarness` opts is `{ name: string; resumeToken?: string; forkSource?:
ForkSource }` (`runtime-adapter.ts:170`).

Per the contract docstring (`runtime-adapter.ts:160–167`) `resumeToken` and
`forkSource` are mutually exclusive — if both are provided the adapter **must
refuse** with a clear error, not guess; `forkSource` triggers a fork and the
captured token is the NEW post-fork token, never the parent. `ForkSource` is
`runtime-adapter.ts:130` (`kind: "native_id" | "artifact_path" | "name" |
"last"`, `:131`; v1 MVP accepts `native_id` only — other shapes rejected at
schema validation, docstring `:120–129`, and by the Claude, Codex and Pi
adapters themselves).

### `HarnessLaunchResult` is a discriminated union with an honest failure arm

`HarnessLaunchResult` is a **discriminated union** (`runtime-adapter.ts:95–100`):
`| { ok: true; resumeToken?; resumeType?; appliedLaunch? }`
`| { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence? }`.
The failure arm carries a typed `recovery` hint
(`HarnessLaunchRecovery = "retry_fresh" | "attention_required"`, `:93`) and
optional `evidence` (last-N pane lines, flowed through to
`RestoreNodeResult.attentionEvidence` for `attention_required` outcomes,
`:97–100`). This is the honest-failure shape, not a smoothed optional `error`.

Readiness has its own attention codes (`runtime-adapter.ts:72–85`):
`trust_gate`, `hook_trust_gate`, `update_gate`, `login_required`, `mcp_gate`,
`bypass_consent_gate`, `codex_auth_refusal` and `codex_client_incompatible`.
When `checkReady` reports one, the readiness wait returns at once and startup
ends `attention_required`.

## 2. The runtime adapters

**5** classes implement `RuntimeAdapter`
(`git grep -l 'implements RuntimeAdapter' packages/daemon/src | wc -l`):
`ClaudeCodeAdapter`, `CodexRuntimeAdapter`, `PiRuntimeAdapter`,
`StubRuntimeAdapter` and `TerminalAdapter`. All live under
`packages/daemon/src/adapters/` (Architecture Rule 1: **0** files there import
Hono, `git grep -l 'from "hono' -- packages/daemon/src/adapters | wc -l`).
`OmpRuntimeAdapter` (Oh My Pi) extends `PiRuntimeAdapter`, so the daemon wires
**6** runtime keys — `claude-code`, `codex`, `pi`, `omp`, `stub`, `terminal`
(`startup.ts:964`, and the same map at `:1234`;
`grep 'adapters: {' packages/daemon/src/startup.ts | grep -o -E '"[a-z-]+": ' | wc -l`).

### Launch posture

A seat's launch posture is `floor`, `auto` or `full_bypass`. It comes from the
member's or rig's `permission_policy`: `builtinLaunchPosture()`
(`packages/daemon/src/domain/permission-policy/policy-ref.ts:165`) maps
`builtin:yolo` to `full_bypass`, `builtin:auto` to `auto`, and every other
built-in (`locked`, `standard`, `open`) to `floor`.
`resolvePermissionPolicyAttachment()` (`:172`) resolves the attachment, and
`rigspec-instantiator.ts` binds the result: the member attachment
(`resolveMemberPolicyAttachment`, `:1921`), then the persisted node or rig
attachment (`:2006`), then the floor, set on the binding as `launchPosture`
(`:2158`). `NativePermissionStore.apply()`
(`native-permission-store.ts:236`) then overlays a seat's explicit
`rig seat set-permissions` choice, or the kernel operational default described
below. `bundle-behaviour.ts` is the read-only
preview of the same mapping for an unopened bundle (see
`packaging-bootstrap-bundles.md`).

`packages/daemon/src/adapters/yolo-mode.ts` turns the posture into flags:

- **Claude Code** (`claudePostureFlag`): an explicit `permissionMode` becomes
  `--permission-mode <mode>` (`:43`); `auto` becomes
  `--permission-mode auto` (`:47`); `full_bypass` becomes
  `--dangerously-skip-permissions`; otherwise the floor is
  `--permission-mode acceptEdits` (`:50`). For a seat with no resolved
  posture, the instance-wide YOLO setting `OPENRIG_YOLO=1` (`:27`; off by
  default) selects the bypass; a resolved posture always wins (`:26`).
- **Codex** (`codexPostureArg`, `:62`): `full_bypass` becomes
  `-s danger-full-access -a never` (`:67`); for a seat with no resolved
  posture, `OPENRIG_YOLO=1` becomes `-s danger-full-access`; otherwise the
  seat's `-p <profile>` or `-s workspace-write`. Codex with `auto` gets the
  same: its selected profile, or the `-s workspace-write` floor without one.

**Non-interruptive mode** (`nonInterruptiveArgs()` in
`packages/daemon/src/adapters/non-interruptive.ts:12`) adds per-launch
arguments only for a `full_bypass` seat whose rig has it on
(`rigs.non_interruptive`): Claude Code gets
`--settings '{"skipDangerousModePermissionPrompt":true}'` (unless an explicit
non-bypass `permissionMode` is set), and Codex gets
`-c notice.hide_full_access_warning=true -c notice.hide_gpt5_1_migration_prompt=true`.
It never changes permissions or native settings files. `rig up
--non-interruptive` and `--no-non-interruptive` save the choice; the setting
`launch.non_interruptive` supplies the default.

**Kernel operational default.** `NativePermissionStore.launchOverride()`
(`native-permission-store.ts:46`) gives a Claude Code or Codex seat in the
persisted rig named `kernel` operational launch arguments when the seat has no
explicit permission choice, its member and rig declare no permission policy,
and (for Codex) it has no `-p` profile (`hasKernelDefault`, `:28`). Fresh start,
continue, restore and handover all take this decision per launch.
`operationalLaunchArgs()` (`packages/daemon/src/adapters/kernel-authority.ts:19`)
then replaces the non-interruptive arguments for that seat:

- Claude Code keeps the floor, `--permission-mode acceptEdits`, and gets
  `--settings '{"permissions":{"allow":[…]}}'` with `KERNEL_CLAUDE_ALLOW`
  (`:7`): `Skill`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash(<command>:*)`
  for 31 operational commands (`rig`, `tmux`, `node`, `npm`, `git`, `ssh` and
  others), and `Read(~/**)` (`:13`). It is not the bypass flag, and the user's
  own ask and deny rules still apply.
- Codex gets the `full_bypass` posture, `-s danger-full-access -a never`, plus
  the two notice flags above.

It writes no settings file. If the rig lookup fails, the seat keeps its floor.
`rig seat status` reports the source as "kernel operational default"
(`kernel_default`, `native-permission-store.ts:180`).

### ClaudeCodeAdapter (`claude-code-adapter.ts:55`)

- `readonly runtime = "claude-code"` (`:56`).
- **Projects** to `.claude/` targets: guidance managed blocks →
  `<cwd>/CLAUDE.md` by default (`:194`, `:501`; default at
  `domain/managed-blocks.ts:17`, and the rig may select `CLAUDE.local.md`
  instead with `managed_blocks: { claude-code: <file> }`,
  `managed-blocks.ts:15`); `skill_install` → `<cwd>/.claude/skills/<name>/`
  (`:200`, `:582`); subagents → `.claude/agents`, plugins →
  `.claude/plugins/<id>` (only plugins that apply to Claude), runtime
  resources → `.claude/extensions/<id>` (`:584–586`); settings fragments
  merged into `.claude/settings.local.json` (`:594`) and MCP fragments into
  `<cwd>/.mcp.json` (`:597`).
- **Launches**: fresh = `claude <posture> --session-id <generatedId> --name
  <name>` (`:329`); resume = `claude <posture> --resume <token> --name <name>`
  (`:328`); fork = `claude <posture> --resume <parentId> --fork-session --name
  <seat>` (`:298`). `<posture>` is the flag above plus any non-interruptive
  or kernel operational argument. Each command may carry a `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`
  env prefix (`yolo-mode.ts:101–103`; on by default, off with
  `OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0`), a `--model <model>` argument
  (`:275`) and `--effort <effort>` (`:277`). A fresh launch returns the
  generated `--session-id` as its `claude_id` token; a fork polls Claude's
  session files for the new id.
- **Managed launch.** When the binding selects a native permission mode, the
  command comes from `ClaudeManagedLaunch.prepare()`
  (`domain/claude-managed-launch.ts:97`), which resolves `claude` on the
  managed `PATH`, validates the mode against `claude --help` (5-second limit),
  and launches through `/usr/bin/env -i` with only the seat's environment
  (`PATH`, `HOME`, an optional `CLAUDE_CONFIG_DIR`, the OpenRig seat identity
  and forwarded keys).
- **Managed bootstrap.** Before delivery the adapter marks the seat's working
  directory as trusted and onboarding as completed in Claude's state file,
  writing only when a flag is missing (`provisionManagedBootstrap`, `:697`).
  It writes no permission settings. The Codex adapter does the same for
  project trust in its `config.toml` (`codex-runtime-adapter.ts:734`).
- **Readiness** (`checkReady`, `:356`): verifies tmux session alive (`:361`),
  captures the pane command and 40 pane lines, and assesses them with
  `assessNativeResumeProbe` (§3) through `assessManagedProbe` (called `:368`,
  defined `:386`); ready only when probe `status === "resumed"`. The
  resume-launch verification loop `verifyResumeLaunch` (`:420`) retries up to
  **16 attempts** (`:422`), failing loudly with `recovery: "retry_fresh"` on
  `no_conversation_found` (`:429–434`) and with `recovery:
  "attention_required"` plus pane evidence on an `attention_required` probe
  (`:444–450`) — the adapter never relaunches on its own.

### CodexRuntimeAdapter (`codex-runtime-adapter.ts:65`)

- `readonly runtime = "codex"` (`:66`).
- **Projects** to `.agents/` targets: `guidance_merge` → `<cwd>/AGENTS.md`
  (`:306`, `:574`); `skill_install` → `<cwd>/.agents/skills/<name>/` (`:312`);
  skills resolve under `.agents/skills/<id>` (`:662`); plugins go to
  `.codex/plugins/<id>` (`:665`).
- **Launches/resumes**: fresh = `codex[ --no-daemon]<posture>[<network>] -C
  <cwd> …` (`:436`), then capture a fresh thread id (`:454`); resume is built
  by `buildCodexResumeCore` (`:435`) as `codex<daemon><posture> resume
  [<queueStateDirArg>] <token>` (`native-resume-probe.ts:81`); fork =
  `codex<posture> fork<queueStateDirArg> <parentId>` (`:405`). `--no-daemon`
  (`:383`) comes first, and only when `codex --help` lists it
  (`domain/codex-daemon-support.ts`; an unreadable answer refuses the launch).
  `-m <model>` (`:353`) and `-c 'model_reasoning_effort="<effort>"'`
  (`:355`) are added when selected. With a thread id it returns `{ ok: true,
  resumeToken: threadId, resumeType: "codex_id" }` (`:422`, `:451`, `:457`); a
  fresh launch whose thread id is not captured returns `{ ok: true }` with its
  applied launch but no token (`:460`).
- **Network default.** On the plain `-s workspace-write` floor,
  `domain/codex-network-default.ts` asks a one-shot `codex app-server` for the
  effective configuration; when it allows it, the launch adds
  `-c sandbox_workspace_write.network_access=true` (`:19`). Otherwise it adds
  nothing.
- Refuses `resumeToken` + `forkSource` together with a clear error
  (`:347–348`) — honors the mutual-exclusivity contract.

### TerminalAdapter (`terminal-adapter.ts:19`)

- `readonly runtime = "terminal"` (`:20`).
- **All operations are no-ops** — "the shell is immediately interactive"
  (`terminal-adapter.ts:15`): no-op `project`/`deliverStartup`, a
  `launchHarness` (`:34`) that returns `{ ok: true }`, and a `checkReady` that
  returns ready unconditionally (`:47–48`). Used for infrastructure nodes. A
  terminal node cannot fork: `launchHarness` refuses a `forkSource` with a
  clear error (`:38–42`), as the runtime-adapter docstring requires of
  adapters without fork (`runtime-adapter.ts:127–128`).

### Pi, Oh My Pi and stub adapters

- `PiRuntimeAdapter` (`pi-runtime-adapter.ts:64`), `runtime` `"pi"` (`:65`).
- `OmpRuntimeAdapter` (`omp-runtime-adapter.ts:7`) extends it with
  `runtime = "omp"` (`:8`).
- `StubRuntimeAdapter` (`stub-runtime-adapter.ts:69`), `runtime` defaulting to
  `"stub"` (`:81`).

Pi and stub launch an OpenRig runner inside the seat's tmux pane (header
comments `pi-runtime-adapter.ts:1–10`, `stub-runtime-adapter.ts:1–14`). Pi
and Oh My Pi support fork and report `pi_session_file` or `omp_session_file`
resume tokens; the stub refuses fork and reports `stub_session`.

`createDaemon` constructs the adapters (`startup.ts:772`, `:773`, `:776`,
`:777`, `:782`) and creates the terminal adapter inline in the runtime adapter
maps (`startup.ts:964`, `:1234`); see `daemon-core.md` §4 "Startup sequence".

### Terminal providers

Opening a seat in a terminal app goes through `TerminalProvider`s under
`packages/daemon/src/domain/terminal/`, served by `/api/terminal`:
`HerdrAdapter` (`herdr-adapter.ts:343`), the default
(`terminal-service.ts:55–56`), and `CmuxProviderAdapter`
(`cmux-provider-adapter.ts:52`), which is best effort and refuses with
`cmux_unavailable` when cmux is not connected. These place existing tmux
sessions in views; they do not launch harnesses.

## 3. Resume honesty

The daemon does not assume a harness resumed just because the launch command
ran. Three domain files (`packages/daemon/src/domain/`) carry the resume
assessment:

### `native-resume-probe.ts`

`assessNativeResumeProbe(input)` (`native-resume-probe.ts:84`) reads pane
command + pane content and returns one of four honest statuses
(`NativeResumeProbeStatus`, `:7`):

- `resumed` — runtime-specific indicators confirm a resumed session.
- `failed` — terminal failure (e.g. Claude printed "No conversation found" →
  code `no_conversation_found`, `:99–104`).
- `inconclusive` — we don't know yet (e.g. Claude trust gate, code
  `trust_gate`, `:113–118`).
- `attention_required` — alive and recoverable but **needs operator action**
  (e.g. Claude resume-selection prompt, code `claude_resume_selection_prompt`,
  `:106–111`). This is the proxy for "an operator must choose the
  conversation"; it is *distinct* from `inconclusive` and `failed` (comment
  `:4–6`).

Other codes include `bypass_consent_gate`, `mcp_gate`, `login_required` and
`returned_to_shell` for Claude, and `codex_client_incompatible`,
`no_saved_session`, `codex_auth_refusal` and `model_selection_gate` for Codex;
an unknown runtime gets `unsupported_runtime`. For Claude, `assessManagedProbe`
upgrades an auto-mode or composer-only screen to `resumed` only after a stable
native process match on a single pane.

`buildNativeResumeCommand` (`:32`) builds the resume command per runtime:
claude → `claude --resume <token> [--name <name>]` (`:41`); codex →
`buildCodexResumeCore` (`:44`), i.e. `codex<posture> resume <token>`
(`:81`); other runtimes → `null` (`:46`).

At the adapter level (Architecture Rule 15, §4), the adapter's
`verifyResumeLaunch` returns `ok:false` with a `retry_fresh` recovery hint and
never relaunches itself. Acting on that hint is the caller's choice:
`StartupOrchestrator` retries once fresh on `retry_fresh` unless the caller
passes `allowFreshFallback: false` (`startup-orchestrator.ts:319–330`), and the
restore orchestrator passes `false` when a pod-aware node requested resume
(`restore-orchestrator.ts:1217`).

### `resume-metadata-refresher.ts`

`ResumeMetadataRefresher` (`resume-metadata-refresher.ts:59`) records which
sessions can be resumed, without overwriting a token it can't re-derive
exactly. `refresh(sessions, opts?)` (`:124`) works in two modes:

- **At shutdown** (default): a Codex session without a token gets its thread
  id captured. For a Claude session with a token, it first reads Claude's live
  per-process session file, and only if that read fails runs
  `probeClaudeResume` (`:216`) — a real launch of the resume command in a
  throwaway probe tmux session (`rigged-refresh-<name>-<ts>`, `:301`),
  returning `"resumable" | "not_resumable" | "inconclusive"`. The probe result
  is recorded without clearing the token.
- **`fillNullOnly`** (`:127`): a missing Claude token is filled from the
  status-line sidecar, and a present Claude or Codex token is re-stamped
  resumable only when it matches what the runtime reports. No probe runs.

### `codex-thread-id.ts`

Codex thread-id extraction (`codex-thread-id.ts`). Reads the Codex thread id
from the Codex *logs* SQLite databases in the Codex home (`CODEX_HOME` when
set, else `~/.codex`, `:38`): `readCodexThreadIdFromCandidateHomes(...)`
(`:32`) → `readCodexThreadIdFromLogs(...)` (`:242`) →
`resolveCodexDbPaths(homeDir, kind)` (`:300`), which globs
`logs_<N>.sqlite` (`:306`) and falls back to `logs_1.sqlite`. The logged
thread ids are then checked against the `threads` table in `state_<N>.sqlite`
(falling back to `state_5.sqlite`, `:318`; query `:267–278`); an id is
returned only when exactly one CLI conversation matches (`:280`). Uses
`better-sqlite3` (`:6`). Resolves the home dir by the harness PID
(`defaultResolveHomeDirByPid`, `:16`).

## 4. Relevant Architecture Rules

The rule texts live in `architecture-rules-and-event-system.md` §1; this
section cites them by number with the adapter-level evidence checked for this
module.

- **Rule 1** — §2: **0** files in `adapters/` import Hono.
- **Rule 5** — restore picks a node's adapter by that node's own runtime: the
  saved startup context's runtime, else the node's (`restore-orchestrator.ts:1108–1109`),
  used to choose the replay adapter (`:1131`).
- **Rule 13** — the readiness loop is `StartupOrchestrator.waitForReady`
  (`startup-orchestrator.ts:562`; 1 s doubling to a 16 s cap), which calls each
  adapter's `checkReady` (§2). The timeout comes from the
  `runtime.readiness_timeout_seconds` setting (default 30, range 1–600,
  `domain/readiness-timeout.ts:3`).
- **Rule 14** — the probe's `attention_required` (§3) reaches the restore
  result through `HarnessLaunchResult.recovery` and `evidence` (§1), which
  become `RestoreNodeResult.status` (`types.ts:457`, `:475`) and
  `attentionEvidence` (`types.ts:478`). A startup's `continuityOutcome` is a
  separate field that also allows `forked` (`startup-orchestrator.ts:101`).
- **Rule 15** — adapters return `ok:false` and never relaunch (§2, §3);
  restore passes `allowFreshFallback: false` for pod-aware resume
  (`restore-orchestrator.ts:1217`), and a resume that concludes failed rolls
  back to zero sessions as `awaiting-decision` (`restore-orchestrator.ts:1048`,
  `:1236`).

## See also

- `daemon-core.md` — where `createDaemon` constructs the runtime adapters.
- `agent-spec-and-startup.md` — the `StartupOrchestrator` that calls these
  adapters and owns startup-action execution after `checkReady()`.
- `lifecycle-snapshot-restore.md` — how persisted resume tokens flow into
  snapshot/restore (resume vs rebuild vs fresh).
- `architecture-rules-and-event-system.md` — the full architecture rule list.
- Source roots: `packages/daemon/src/domain/runtime-adapter.ts`,
  `packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,pi-runtime-adapter,omp-runtime-adapter,stub-runtime-adapter,terminal-adapter,yolo-mode,non-interruptive,kernel-authority}.ts`,
  `packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id,claude-managed-launch,codex-network-default,native-permission-store}.ts`,
  `packages/daemon/src/domain/permission-policy/policy-ref.ts`.
