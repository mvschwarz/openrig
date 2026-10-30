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
| Initial-shell environment policy | Native private bootstrap for PowerShell/pwsh/cmd, selected environment and fresh pane identity; [native scoped launch](../../packages/daemon/test/windows-scoped-launch.test.ts). Stock 3.4.0 empty-server startup, first session and dead-pane respawn pass in an isolated namespace. | Live provider/fleet acceptance, pwsh execution and unsupported shell semantics. Stock psmux's separate `-e` argv visibility limitation remains. |
| Pi and OMP | Native executable/npm dispatch and argv-aware protocol fixtures; [native dispatch](../../packages/daemon/test/pi-omp-native-dispatch.test.ts). Earlier reconciliation covered 59 protocol/dispatch cases. | Actual provider conversations, compaction and complete restore. |
| Community harnesses | Metadata reaches the child; standard npm entries resolve against the seat cwd, including relative PATH and command paths; [native environment](../../packages/daemon/test/community-harness-native-environment.test.ts). Combined protocol/activity run passed 70 cases. | Arbitrary batch launchers are deliberately not translated; installed third-party providers and real restore remain unverified. |
| ACP | Native command selection and bounded owned process handling; [selection](../../packages/cli/test/acp-native-command-selection.test.ts), [process handling](../../packages/cli/test/windows-acp-process.test.ts). | Live agent/queue acceptance; previously unresolved companion cleanup behavior. |
| Transcript continuity | Short native staging names, cleanup after partial writes and boundary replay through stock psmux; [long names](../../packages/daemon/test/transcript-long-name-native.test.ts), [write failure](../../packages/daemon/test/transcript-write-failure-native.test.ts), [stock replay](../../packages/daemon/test/transcript-boundary-psmux-native.test.ts). | Live provider output and restart/restore across the complete installed runtime. |
| Compaction restore hooks | [Real hook round-trip](../../packages/daemon/test/stub-compaction.test.ts) executes shipped packet creation and restore scripts against an owned synthetic transcript, rejects a distinct transcript, delivers once and records the injected clock. Together with the native transcript-alias fixture, five cases pass. The determinism fixture now uses native basename rather than splitting `/`. | Actual provider compaction, full runner restart/restore and installed plugin acceptance. |
| Restore replay preconditions | [Preconditions](../../packages/daemon/test/restore-preconditions.test.ts) pass 23 cases, including actual native files under paths with spaces and case aliases: present replay succeeds, removing its file blocks, and removing its owner root adds the owner-root blocker in order. | Full snapshot restore, live runtime and service restoration. |

## Terminal and interaction

| Workflow | Implemented scope and evidence entry | Still unverified |
| --- | --- | --- |
| Stock psmux routing and input | Direct watcher argv, inherited whoami and advertised `-S` routing from a fresh client; [owned stock fixture](../../packages/cli/test/chatroom-psmux-native.test.ts). Two [isolated native input cases](../../packages/daemon/test/windows-terminal-native.test.ts) also pass on stock 3.4.0: multiline runner submission, literal argv/environment, refusing draft guard and distinct target/decoy sessions. | Visible terminal attachment and real chatroom SSE; actual provider input acceptance. |
| Terminal views | Windows Terminal rendering and daemon-selected recovery shell; [window plans](../../packages/cli/test/terminal-window-windows.test.ts), [recovery](../../packages/daemon/test/terminal-recovery-native.test.ts). | Visible desktop acceptance and real cross-host SSH. Rex remains unavailable on Windows; Herdr is platform-qualified. |
| Scoped task views and TUI | Native alias deduplication for scope indexes and selected project identity; [scope membership](../../packages/daemon/test/scope-task-terminal-view.test.ts), [project selection](../../packages/daemon/test/project-read-native-identity.test.ts), [TUI IPC](../../packages/tui/test/socket-windows.test.ts). Fresh npm installation enters/quits demo, resolves its paired CLI, and transitions from startup to connected work reads against an owned HTTP fixture using GET only. | Full interactive installed-TUI acceptance with actual daemon data; complete page projections. |

## Resources and authored work

| Workflow | Implemented scope and evidence entry | Still unverified |
| --- | --- | --- |
| Context stores | Overlapping roots retain physical-pack custody across native case aliases; [native custody cases](../../packages/daemon/test/context-pack-store-recursion.test.ts). | Complete context-store suite and installed delivery. A successful directory-junction case does not establish file-symlink support. |
| Spec library | Native rename supports long storage names, reserved device names and case-only changes; [service](../../packages/daemon/test/spec-library-service.test.ts), [routes](../../packages/daemon/test/spec-library-routes.test.ts). | Every authored resource/install combination. |
| Lifecycle compilation | A differently cased reference to the actual mission is accepted; a distinct file is refused; [compiler](../../packages/daemon/test/project-lifecycle-compiler.test.ts). | Real workflow execution and fleet restore. |
| Culture export and local copy | Contained native aliases copy correctly while outside destination aliases are refused; [export](../../packages/cli/test/export-import.test.ts), [local copy](../../packages/cli/test/windows-native-local-copy.test.ts). | Real remote transfer and every archive/install path. |
| Local recap handoff | [Recap write](../../packages/cli/test/context-recap-write.test.ts) passes nine cases. Actual Windows write denial on an owned directory triggers delegation to the fixture server; timeout remains unknown and a connection failure retains its cause. The fixture restores its temporary ACL rule in finally. A directory junction checks refusal through a linked namespace. | Actual daemon/seat permissions; file-symlink behavior is not established by the junction case. |

## Completion boundary

The finite source inventory and focused checks do not yet prove all feature
parity. Source-only reviews, skipped cases, file-symlink permission failures,
interactive installed-TUI checks, live provider continuity and visible
terminal behavior remain separate evidence requirements. Existing stop/hold and
ownership decisions are not changed by implementation or by fixture success.
There is no completion claim or request to activate an existing deployment here.

At `696fcc5`, reconciliation with the earlier `9bbed2287` finite ledger found
two changed sources already in that inventory and seven changed production sources
outside its regex candidate set. All nine now have a supplemental source hash and
scoped evidence record. This exposes the candidate set's coverage limit; it does
not make the unchanged rows current acceptance or prove coverage of every feature.

A delayed repository-script receipt from `5dc3ea5` records 335 passes, 16
failures and four skips; its wrapper's zero exit did not represent the child
test result (exit 1). The failures include nine symlink-creation permission
errors, three POSIX-mode assertions, two invalid native-filename fixtures,
one snapshot-refresh case and one npm/Node crash during a second package build.
The current documented snapshot-refresh case passes independently. The old
process crash's cause and remaining platform-specific assertions are not cleared
by the later installed gate or by the notification's successful delivery.

Following a delayed workspace failure notification, the current usage-hosts journey
passes 12 cases with its fetch guard unchanged. A complete TUI run at `80177a8`
exposed one stale POSIX recovery-prefix assertion; `24f301a` makes that journey
expect the daemon-selected native shell. The two journey modules pass 23 cases.
The subsequent complete TUI run at unchanged `24f301a` records 1190 passes, one
different test failure and 21 skips. That remaining failure is unclassified here;
there is no complete-TUI or complete-workspace green claim.

The delayed CLI receipt at `aabbe24` records 4534 passes, 1355 failures and 57
skips. Later historical receipt `b40ecd7` records 5803 passes, 117 failures and
57 skips, so the earlier count is not the current failure inventory. Current
targeted reproduction still found missing owned-loopback registrations in
agent-image and browser-boundary CLI fixtures. Registering their exact bound
origins per test (and explicitly binding agent-image to loopback) makes those
five cases pass without changing the fetch guard. This is not CLI-wide acceptance.
The separate frozen CLI attempt at `e36cef0` is explicitly marked canceled after
missing CLI/TUI compiled inputs were found; its JSON report is absent. Its stable
source metadata supplies no usable test totals and is excluded from acceptance.
Its separate `r2` attempt did complete at unchanged `e36cef0`: 5830 passes,
97 failures and 56 skips. Current reproduction of two bundle-link modules found
four failures from POSIX-only prepared-path fixtures. Supplying native absolute
paths and checking the decoded JSON error preserves archive identity, one-install
dispatch and no retry after unknown outcome; all 17 module cases pass. Neither
the old 97-failure total nor these scoped passes establish current CLI acceptance.
The later stable CLI+TUI run at `dd4bc68` records 7017 passes, 96 failures and
77 skips across both packages; it is a distinct historical scope. Its recap
permission failures reproduced on current Windows because POSIX directory mode
bits did not deny creation. Native ACL-based fixture setup now exercises that
delegation path, with the exact owned HTTP origin registered and the guard retained.
The stable CLI+TUI `a2d903d` run separately records 7031 passes, 94 failures
and 77 skips. Four failures reproduced in current create/grow and config fixtures:
their expected values hardcoded POSIX spellings despite native absolute cwd and
default paths. Native path expectations retain the exact create/grow payload and
header assertions; all 41 cases across those two modules pass. No real rig is
created or grown, and no complete-package result is inferred from this subset.

The delayed daemon receipt at `d555e26` records 21164 passes, 1638 failures and
512 skips, with the private warm diagnostic excluded. A later `06cb5bf` receipt
records 21824 passes, 1210 failures and 528 skips; neither is current acceptance.
That later run changed HEAD from `06cb5bf` to `ebc3bcf` while executing
(`sourceStable=false`), so its totals cannot be attributed to either single
commit. Only its individual failures can serve as leads for fresh reproduction.
Current scoped reproduction found six plugin-projection failures caused by a
slash-only in-memory filesystem. Translating native paths at that fixture boundary
restores its assertions. An additional owned native-filesystem case verifies both
Claude and Codex nested plugin copies and unchanged source bytes. Together with
the current activity-rung module, 20 cases pass. No provider or fleet is launched,
and no POSIX mode result is treated as native DACL evidence.

## Native scoped-shell implementation checkpoint (2026-10-30)

The initial-shell adapter now prepares a private Windows bootstrap for configured
PowerShell, pwsh and cmd shells instead of unconditionally rejecting Windows.
It clears inherited child environment entries, applies selected values with
case-insensitive precedence, and takes terminal identity from the fresh pane.
The bootstrap argv contains its private file path rather than environment values.
Startup supplies the native system/profile/temp roots needed by these children.

Four focused Windows tests pass, including an actual PowerShell child with synthetic
multiline Unicode values, unrelated inherited-variable removal, fresh pane identity,
working-directory preservation and bootstrap-file removal, and a cmd command with
quoted output path. The stock psmux fixture covers held empty-server startup, its
first actual seat, and dead-pane respawn with a new explicit environment override.
It also creates an interactive scoped shell and sends a command through the real
native console-input path; the resulting file confirms its selected environment
and absence of the unrelated server-only value.
The native adapter uses a direct `--` command boundary. Stock 3.4.0 aliases
`default-command` to `default-shell`, so native initial launch preserves shell words
instead of executing that same value as a nested command. Native empty-server
startup uses psmux's queued `exit-empty off` operation, followed by option readback.
The scoped child also retains the pane's `PSMUX_DATA_DIR`: an owned stock fixture
first reproduced its loss as a null value, then passed after the routing metadata
was preserved. A Node child inside the respawned shell reads the same pane through
the stock client and its owned namespace. Two final runs passed; preceding attempts
to capture the native client's output were empty, and an initial Node-observer run
produced no receipt. Those observations do not establish general client reliability.

Together with credential transport fixtures, 15 tests pass and three POSIX-only
integration cases remain skipped; daemon TypeScript passes. This is not live
provider, fleet or deployment acceptance. Unsupported configured shell semantics
retain the diagnostic fallback. No candidate psmux protocol binary was substituted.

