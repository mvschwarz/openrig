# Native Windows parity: implementation and evidence

Status at source commit `c778b2a52` (2026-10-30). This is an implementation
coverage map for Draft #1309, not a declaration of complete Windows support.
The [experiment record](windows-support-experiment.md) retains individual
reproductions, repairs, results and limitations. Tests linked below are executable
evidence entry points; their presence does not mean every test ran at this head.

## Packaging and local lifecycle

| Workflow | Implemented scope and evidence entry | Still unverified |
| --- | --- | --- |
| Build and install | Native npm lifecycle selects the paired Node build runner; [prepublish fixture](../../scripts/prepublish-native.test.mjs). The installed CLI gate at `c778b2a52` passed build, pack, isolated-prefix install, SQLite ABI and the real npm `rig.cmd` in 83 seconds. Build metadata retains `dirty=true`; packaged plugin hash and ten recent compiled modules were read back. A separate [installed npm TUI demo](../../scripts/installed-tui-native.test.mjs) also passes. | All supported Node versions; clean-release reproducibility; real interactive installed TUI. |
| Daemon and configuration | Native writable-path checks, alias-aware configuration, paired entry points and local stop planning; [doctor](../../packages/cli/test/doctor-native-writable.test.ts), [config](../../packages/cli/test/config-legacy-native-alias.test.ts), [destroy plan](../../packages/cli/test/destroy-native-plan.test.ts). | Actual deployment upgrade/restart and existing-fleet acceptance. |
| Temporary runtime probes | Owned Job containment, child-tree deadlines, cwd/environment/stdin and error status; [shell probes](../../packages/daemon/test/windows-probe-job.test.ts), [runtime probes](../../packages/daemon/test/runtime-probe-native-timeout.test.ts). | Daemon shutdown during each live provider probe. |

## Runtime launch and continuity

| Workflow | Implemented scope and evidence entry | Still unverified |
| --- | --- | --- |
| Pi and OMP | Native executable/npm dispatch and argv-aware protocol fixtures; [native dispatch](../../packages/daemon/test/pi-omp-native-dispatch.test.ts). Earlier reconciliation covered 59 protocol/dispatch cases. | Actual provider conversations, compaction and complete restore. |
| Community harnesses | Metadata reaches the child; standard npm entries resolve against the seat cwd, including relative PATH and command paths; [native environment](../../packages/daemon/test/community-harness-native-environment.test.ts). Combined protocol/activity run passed 70 cases. | Arbitrary batch launchers are deliberately not translated; installed third-party providers and real restore remain unverified. |
| ACP | Native command selection and bounded owned process handling; [selection](../../packages/cli/test/acp-native-command-selection.test.ts), [process handling](../../packages/cli/test/windows-acp-process.test.ts). | Live agent/queue acceptance; previously unresolved companion cleanup behavior. |
| Transcript continuity | Short native staging names, cleanup after partial writes and boundary replay through stock psmux; [long names](../../packages/daemon/test/transcript-long-name-native.test.ts), [write failure](../../packages/daemon/test/transcript-write-failure-native.test.ts), [stock replay](../../packages/daemon/test/transcript-boundary-psmux-native.test.ts). | Live provider output and restart/restore across the complete installed runtime. |

## Terminal and interaction

| Workflow | Implemented scope and evidence entry | Still unverified |
| --- | --- | --- |
| Stock psmux routing | Direct watcher argv, inherited whoami and advertised `-S` routing from a fresh client; [owned stock fixture](../../packages/cli/test/chatroom-psmux-native.test.ts). | Visible terminal attachment and real chatroom SSE. |
| Terminal views | Windows Terminal rendering and daemon-selected recovery shell; [window plans](../../packages/cli/test/terminal-window-windows.test.ts), [recovery](../../packages/daemon/test/terminal-recovery-native.test.ts). | Visible desktop acceptance and real cross-host SSH. Rex remains unavailable on Windows; Herdr is platform-qualified. |
| Scoped task views and TUI | Native alias deduplication for scope indexes and selected project identity; [scope membership](../../packages/daemon/test/scope-task-terminal-view.test.ts), [project selection](../../packages/daemon/test/project-read-native-identity.test.ts), [TUI IPC](../../packages/tui/test/socket-windows.test.ts). Fresh npm installation enters/quits demo, resolves its paired CLI, and transitions from startup to connected work reads against an owned HTTP fixture using GET only. | Full interactive installed-TUI acceptance with actual daemon data; complete page projections. |

## Resources and authored work

| Workflow | Implemented scope and evidence entry | Still unverified |
| --- | --- | --- |
| Context stores | Overlapping roots retain physical-pack custody across native case aliases; [native custody cases](../../packages/daemon/test/context-pack-store-recursion.test.ts). | Complete context-store suite and installed delivery. A successful directory-junction case does not establish file-symlink support. |
| Spec library | Native rename supports long storage names, reserved device names and case-only changes; [service](../../packages/daemon/test/spec-library-service.test.ts), [routes](../../packages/daemon/test/spec-library-routes.test.ts). | Every authored resource/install combination. |
| Lifecycle compilation | A differently cased reference to the actual mission is accepted; a distinct file is refused; [compiler](../../packages/daemon/test/project-lifecycle-compiler.test.ts). | Real workflow execution and fleet restore. |
| Culture export and local copy | Contained native aliases copy correctly while outside destination aliases are refused; [export](../../packages/cli/test/export-import.test.ts), [local copy](../../packages/cli/test/windows-native-local-copy.test.ts). | Real remote transfer and every archive/install path. |

## Completion boundary

The finite source inventory and focused checks do not yet prove all feature
parity. Source-only reviews, skipped cases, file-symlink permission failures,
interactive installed-TUI checks, live provider continuity and visible
terminal behavior remain separate evidence requirements. Existing stop/hold and
ownership decisions are not changed by implementation or by fixture success.
There is no completion claim or request to activate an existing deployment here.
