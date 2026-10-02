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
last-verified-against-source: 264fade9
last-updated: 2026-10-02
---

# Adapters and Runtimes

How OpenRig drives the agent harnesses. Harness launches go through a
`RuntimeAdapter`: five adapter classes implement one contract of five required
methods. A separate resume-honesty layer answers the question "did this harness
*actually* resume, or did it silently fresh-launch?" truthfully rather than
optimistically.

> Verified against source at main `264fade9`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The five-method RuntimeAdapter contract

`RuntimeAdapter` is `packages/daemon/src/domain/runtime-adapter.ts:131`
(`interface RuntimeAdapter`). Every adapter declares a `readonly runtime`
string (`runtime-adapter.ts:134`) and implements five required methods
(`runtime-adapter.ts:140–163`; **5** =
`sed -n '/^export interface RuntimeAdapter/,/^}/p' packages/daemon/src/domain/runtime-adapter.ts | grep -c -E '^  [a-zA-Z]+\('`):

| Method | Signature (`runtime-adapter.ts`) | Responsibility |
|---|---|---|
| `listInstalled` | `(binding)` `:141` | List currently installed/projected resources for a node. |
| `project` | `(plan, binding)` `:144` | Project resources from a `ProjectionPlan` to the runtime's target locations. |
| `deliverStartup` | `(files, binding)` `:147` | Deliver resolved startup files to the runtime. |
| `launchHarness` | `(binding, opts)` `:157` | Launch the harness inside the bound tmux session; return a resume token. |
| `checkReady` | `(binding)` `:163` | Probe whether the harness is responsive and ready. |

The interface also has two optional members: `claudeManagedLaunch` (`:133`)
and `skillTargetPath?()` (`:138`, implemented by `OmpRuntimeAdapter`,
`omp-runtime-adapter.ts:12`).

Startup *action* execution (`slash_command` / `send_text`) is explicitly **not**
part of this contract — the contract docstring (`runtime-adapter.ts:125–130`)
states actions belong to the `StartupOrchestrator` *after* `checkReady()`. The
orchestrator delivery split is in `agent-spec-and-startup.md`.

### `launchHarness` opts and the fork seam

`launchHarness` opts is `{ name: string; resumeToken?: string; forkSource?:
ForkSource }` (`runtime-adapter.ts:159`).

Per the contract docstring (`runtime-adapter.ts:149–156`) `resumeToken` and
`forkSource` are mutually exclusive — if both are provided the adapter **must
refuse** with a clear error, not guess; `forkSource` triggers a fork and the
captured token is the NEW post-fork token, never the parent. `ForkSource` is
`runtime-adapter.ts:120` (`kind: "native_id" | "artifact_path" | "name" |
"last"`, `:121`; v1 MVP accepts `native_id` only — other shapes rejected at
schema validation, docstring `:110–119`).

### `HarnessLaunchResult` is a discriminated union with an honest failure arm

`HarnessLaunchResult` is a **discriminated union** (`runtime-adapter.ts:85–90`):
`| { ok: true; resumeToken?; resumeType?; appliedLaunch? }`
`| { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence? }`.
The failure arm carries a typed `recovery` hint
(`HarnessLaunchRecovery = "retry_fresh" | "attention_required"`, `:83`) and
optional `evidence` (last-N pane lines, flowed through to
`RestoreNodeResult.attentionEvidence` for `attention_required` outcomes,
`:87–90`). This is the honest-failure shape, not a smoothed optional `error`.

## 2. The runtime adapters

**5** classes implement `RuntimeAdapter`
(`git grep -l 'implements RuntimeAdapter' packages/daemon/src | wc -l`):
`ClaudeCodeAdapter`, `CodexRuntimeAdapter`, `PiRuntimeAdapter`,
`StubRuntimeAdapter` and `TerminalAdapter`. All live under
`packages/daemon/src/adapters/` (Architecture Rule 1: **0** files there import
Hono, `git grep -l 'from "hono' -- packages/daemon/src/adapters | wc -l`).
`OmpRuntimeAdapter` (Oh My Pi) extends `PiRuntimeAdapter`, so the daemon wires
**6** runtime keys — `claude-code`, `codex`, `pi`, `omp`, `stub`, `terminal`
(`startup.ts:941`;
`sed -n '941p' packages/daemon/src/startup.ts | grep -o -E '"[a-z-]+": ' | wc -l`).

### ClaudeCodeAdapter (`claude-code-adapter.ts:53`)

- `readonly runtime = "claude-code"` (`:54`).
- **Projects** to `.claude/` targets: guidance managed blocks →
  `<cwd>/CLAUDE.md` by default (`:187`, `:478`; default at
  `managed-blocks.ts:16`, and the rig may select `CLAUDE.local.md` instead,
  `managed-blocks.ts:14`); `skill_install` →
  `<cwd>/.claude/skills/<name>/` (`:193`, `:559`); subagents → `.claude/agents`,
  plugins → `.claude/plugins/<id>`, runtime resources →
  `.claude/extensions/<id>` (`:561–563`); settings fragments merged into
  `.claude/settings.local.json` (`:571`) and MCP fragments into `<cwd>/.mcp.json`
  (`:574`).
- **Launches** (`:309–310`): fresh = `claude <permissionMode> --session-id
  <generatedId> --name <name>`; resume = `claude <permissionMode> --resume
  <token> --name <name>`; fork = `claude <permissionMode> --resume <parentId>
  --fork-session --name <seat>` (`:281`). Each command may carry a
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` env prefix (`yolo-mode.ts:98`) and a
  `--model <model>` argument (`:263`). When `binding.permissionMode` is set, the
  command is built by `claudeManagedLaunch` instead (`:243–249`, `:307`).
- **Readiness** (`checkReady`, `:336`): verifies tmux session alive (`:341`),
  captures 40 pane lines + pane command (`:346–347`), and assesses them with
  `assessNativeResumeProbe` (§3) through `assessManagedProbe` (`:366`); ready
  only when probe `status === "resumed"` (`:350`). The resume-launch
  verification loop `verifyResumeLaunch` (`:397`) retries up to **16 attempts**
  (`:399`), failing loudly with `recovery: "retry_fresh"` on
  `no_conversation_found` (`:406–411`) and with `recovery:
  "attention_required"` plus pane evidence on an `attention_required` probe
  (`:421–427`) — the adapter never relaunches on its own.

### CodexRuntimeAdapter (`codex-runtime-adapter.ts:61`)

- `readonly runtime = "codex"` (`:62`).
- **Projects** to `.agents/` targets: `guidance_merge` → `<cwd>/AGENTS.md`
  (`:290`, `:549`); `skill_install` → `<cwd>/.agents/skills/<name>/` (`:240`,
  `:296`); skills resolve under `.agents/skills/<id>` (`:628`).
- **Launches/resumes**: fresh = `codex<posture> -C <cwd> …` (`:413`), then
  capture a fresh thread id (`:429`); resume is built by
  `buildCodexResumeCore` (`:412`) as `codex<posture> resume
  [<queueStateDirArg>] <token>` (`native-resume-probe.ts:76`); fork = `codex<posture> fork<queueStateDirArg>
  <parentId>` (`:384`). `<posture>` is `codexPostureArg(...)`
  (`yolo-mode.ts:59`): the `-p <profile>` argument, `-s workspace-write`, or
  `-s danger-full-access`. Each command may also carry `--no-daemon` (`:364`)
  and `-m <model>` (`:337`). With a thread id it returns `{ ok: true,
  resumeToken: threadId, resumeType: "codex_id" }` (`:399`, `:426`, `:432`);
  a fresh launch whose thread id is not captured returns `{ ok: true }` without
  a token (`:435`).
- Refuses `resumeToken` + `forkSource` together with a clear error
  (`:331–332`) — honors the mutual-exclusivity contract.

### TerminalAdapter (`terminal-adapter.ts:19`)

- `readonly runtime = "terminal"` (`:20`).
- **All operations are no-ops** — "the shell is immediately interactive"
  (`terminal-adapter.ts:15`): no-op `project`/`deliverStartup`, a
  `launchHarness` (`:34`) that returns `{ ok: true }`, and a `checkReady` that
  returns ready unconditionally (`:47–48`). Used for infrastructure nodes —
  servers, log tails, build watchers. A terminal node cannot fork:
  `launchHarness` refuses a `forkSource` with a clear error (`:38–42`), as the
  runtime-adapter docstring requires of adapters without fork
  (`runtime-adapter.ts:117–118`).

### Pi, Oh My Pi and stub adapters

- `PiRuntimeAdapter` (`pi-runtime-adapter.ts:60`), `runtime` `"pi"` (`:61`).
- `OmpRuntimeAdapter` (`omp-runtime-adapter.ts:7`) extends it with
  `runtime = "omp"` (`:8`).
- `StubRuntimeAdapter` (`stub-runtime-adapter.ts:69`), `runtime` defaulting to
  `"stub"` (`:81`).

Pi and stub launch an OpenRig runner inside the seat's tmux pane (header
comments `pi-runtime-adapter.ts:1–10`, `stub-runtime-adapter.ts:1–8`); their
projection, launch and readiness behaviour is not detailed here.

`createDaemon` constructs the adapters (`startup.ts:751`, `:752`, `:755`,
`:756`, `:761`) and creates the terminal adapter inline in the runtime adapter
map (`startup.ts:941`); see `daemon-core.md` §4 "Startup sequence".

## 3. Resume honesty

The daemon does not assume a harness resumed just because the launch command
ran. Three domain files (`packages/daemon/src/domain/`) carry the resume
assessment:

### `native-resume-probe.ts`

`assessNativeResumeProbe(input)` (`native-resume-probe.ts:79`) reads pane
command + pane content and returns one of four honest statuses
(`NativeResumeProbeStatus`, `:7`):

- `resumed` — runtime-specific indicators confirm a resumed session.
- `failed` — terminal failure (e.g. Claude printed "No conversation found" →
  code `no_conversation_found`, `:87–90`).
- `inconclusive` — we don't know yet (e.g. Claude trust gate, code
  `trust_gate`, `:101–104`).
- `attention_required` — alive and recoverable but **needs operator action**
  (e.g. Claude resume-selection prompt, code `claude_resume_selection_prompt`,
  `:94–97`). This is the proxy for "an operator must choose the conversation";
  it is *distinct* from `inconclusive` and `failed` (comment `:4–6`).

`buildNativeResumeCommand` (`:30`) builds the resume command per runtime:
claude → `claude --resume <token> [--name <name>]` (`:39`); codex →
`buildCodexResumeCore` (`:42`), i.e. `codex<posture> resume <token>`
(`:76`); other runtimes → `null` (`:44`).

At the adapter level (Architecture Rule 15, §4), the adapter's
`verifyResumeLaunch` returns `ok:false` with a `retry_fresh` recovery hint and
never relaunches itself. Acting on that hint is the caller's choice:
`StartupOrchestrator` retries once fresh on `retry_fresh` unless the caller
passes `allowFreshFallback: false` (`startup-orchestrator.ts:259–267`), and the
restore orchestrator passes `false` when a pod-aware node requested resume
(`restore-orchestrator.ts:1397`).

### `resume-metadata-refresher.ts`

`ResumeMetadataRefresher` (`resume-metadata-refresher.ts:49`). Post-launch
resume-token capture: `refresh(sessions, opts?)` (`:107`) skips `codex`
sessions that already have a `resumeToken` (`:123`, `:139`) and otherwise
captures the thread id (`:142–145`). For `claude-code` sessions with a token
it runs a `probeClaudeResume` returning `"resumable" | "not_resumable" |
"inconclusive"` (`:36`, `:186`) — a real launch of the resume command in a
throwaway probe tmux session (`:243–246`), not a metadata guess. In
`fillNullOnly` mode (`:116`) it skips that probe (`:171`).

### `codex-thread-id.ts`

Codex thread-id extraction (`codex-thread-id.ts`). Reads the Codex thread id
from the Codex *logs* SQLite databases under `~/.codex/`:
`readCodexThreadIdFromCandidateHomes(...)` (`:32`) →
`readCodexThreadIdFromLogs(...)` (`:237`) → `resolveCodexDbPaths(homeDir,
kind)` (`:294`) which globs `<homeDir>/.codex/logs_<N>.sqlite` (regex
`^${kind}_(\d+)\.sqlite$`, `:300`) and falls back to `logs_1.sqlite` (`:312`).
The logged thread ids are then checked against the `threads` table in
`state_<N>.sqlite` (`:262–272`); an id is returned only when exactly one CLI
conversation matches (`:274`). Uses `better-sqlite3` (`:6`). Resolves the home
dir by the harness PID (`defaultResolveHomeDirByPid`, `:16`).

## 4. Relevant Architecture Rules

The rule texts live in `architecture-rules-and-event-system.md` §1; this
section cites them by number with the adapter-level evidence checked for this
module.

- **Rule 1** — §2: **0** files in `adapters/` import Hono.
- **Rule 5** — restore picks a node's adapter by that node's own `runtime`
  (`restore-orchestrator.ts:1252`).
- **Rule 13** — the readiness loop is `StartupOrchestrator.waitForReady`
  (`startup-orchestrator.ts:473`; 1 s doubling to a 16 s cap, `:479–480`,
  `:498`; default timeout 30 s, `:476`), which calls each adapter's
  `checkReady` (§2).
- **Rule 14** — the probe's `attention_required` (§3) reaches the restore
  result through `HarnessLaunchResult.recovery` and `evidence` (§1), which
  become `RestoreNodeResult.status` (`types.ts:457`, `:475`) and
  `attentionEvidence` (`types.ts:478`). A startup's `continuityOutcome` is a
  separate field that also allows `forked` (`startup-orchestrator.ts:68`).
- **Rule 15** — adapters return `ok:false` and never relaunch (§2, §3);
  restore passes `allowFreshFallback: false` for pod-aware resume
  (`restore-orchestrator.ts:1397`), and a resume that concludes failed rolls
  back to zero sessions as `awaiting-decision` (`restore-orchestrator.ts:1229`,
  `:1415`).

## See also

- `daemon-core.md` — where `createDaemon` constructs the runtime adapters.
- `agent-spec-and-startup.md` — the `StartupOrchestrator` that calls these
  adapters and owns startup-action execution after `checkReady()`.
- `lifecycle-snapshot-restore.md` — how persisted resume tokens flow into
  snapshot/restore (resume vs rebuild vs fresh).
- `architecture-rules-and-event-system.md` — the full architecture rule list.
- Source roots: `packages/daemon/src/domain/runtime-adapter.ts`,
  `packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,pi-runtime-adapter,omp-runtime-adapter,stub-runtime-adapter,terminal-adapter}.ts`,
  `packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id}.ts`.
