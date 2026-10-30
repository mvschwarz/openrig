# Native Windows parity: implementation and evidence

Initial map at source commit `c778b2a52` (2026-10-30), with later scoped
updates below through source `8f639d315`. This is an implementation
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
| Daemon status and home selection | [Three-state status](../../packages/cli/test/daemon-status-three-state.test.ts) passes eight cases. Native path fixtures preserve timeout-as-unverified and positive-refusal semantics; actual owned sibling-home files report both paths with injected process liveness. HOME-MOVED remains covered. | Real daemon/process ownership and deployment lifecycle; injected liveness is not an OS process witness. |
| Local endpoint user guard | The optional guard now corroborates the repeated health PID with two Windows process owner-SID/creation-time observations, comparing the caller SID; macOS PID/euid behavior remains. Native own-process and injected refusal/change/timeout tests pass. | Foreign-user OS access and deployed endpoint behavior remain unverified. The guard is routing mitigation, not authentication or socket-ownership proof; forwarded loopback endpoints retain that limitation. |
| Cross-host reads and queue recovery | [HTTP coordination](../../packages/cli/test/cross-host-http.test.ts) passes 70 cases after registering its owned slow-response server. Queue [native command](../../packages/cli/test/queue-recovery-command-native.test.ts), [forwarded outcomes](../../packages/cli/test/queue-forwarded-response-outcome.test.ts) and [missing-item guidance](../../packages/cli/test/queue-not-found-guidance.test.ts) pass 33 cases. Windows recovery now uses PowerShell endpoint selection with finally restoration and literal ID quoting; POSIX command format remains. | No actual cross-host daemon/queue is accessed. Native execution substitutes an owned rig function; endpoint restoration and quoting are tested on success and failure. |

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
| Bundle login-file diagnostics | [CLI](../../packages/cli/test/bundle-login-files.test.ts) and [daemon](../../packages/daemon/test/bundle-login-files.test.ts) pass 45 combined cases using synthetic login fixtures and real owned archives. Native local-path and archive-path diagnostics are both checked, including JSON escaping, explicit opt-in notices and absence of fixture content in diagnostics. | Actual operator credentials are never used; this is not authorization to publish login files or a full bundle-suite result. |
| Local auth-file assessment | [Auth ops](../../packages/cli/test/codex-auth-ops.test.ts) passes six cases with owned synthetic files: private-file creation and assessment, refusal after a real extra read ACE, malformed JSON and result redaction. The fixture import was corrected and its unsafe-file setup now changes only the DACL through native icacls instead of requiring Set-Acl security privileges. | Login state is injected; actual provider sign-in, existing user credentials and profile switching are not exercised. |
| External dependency installation | Windows missing CLI requirements `git`, `pwsh`, `jq`, `rg` and `gh` map to explicit WinGet catalog IDs and literal argv, through the existing reviewed-action workflow. CLI name case and `.exe` spelling are recognized. Current planner/executor/native probe suites pass 34 cases, with nine selected bootstrap cases. Manifest hints remain display-only. | Actual WinGet installation, agreement state, portable alias creation and package/architecture availability are unverified. Unmapped tools and system packages remain manual-only; no elevation, agreement auto-acceptance or reboot is requested. |
| Compose services | [Native Compose checks](../../packages/daemon/test/windows-compose-services.test.ts) pass five cases: literal Docker argv through an owned Node receiver, HTTP status/redirect/deadline handling, numeric TCP probes and Windows services-file name parsing. | No Docker daemon, containers, actual Compose installation or checkpoint import/export is exercised. |

## Completion boundary

The finite source inventory and focused checks do not yet prove all feature
parity. Source-only reviews, skipped cases, file-symlink permission failures,
interactive installed-TUI checks, live provider continuity and visible
terminal behavior remain separate evidence requirements. Existing stop/hold and
ownership decisions are not changed by implementation or by fixture success.
There is no completion claim or request to activate an existing deployment here.

Current [package command](../../packages/cli/test/package.test.ts) and
[running-name refusal](../../packages/cli/test/up-running-name-render.test.ts)
fixtures reproduced two failures: a POSIX cwd expectation and a missing owned
HTTP origin registration. Native cwd expectations and loopback-only registered
listeners restore all 19 cases. The running-name teaching refusal remains verbatim,
including no-created/no-launched wording; there is no real package installation,
publication or rig action in these fixtures.

The remaining parked and activity-filter CLI fixtures also needed exact owned
HTTP origin registration on Windows. Their source reproductions failed before
registration; [parked](../../packages/cli/test/parked-verb.test.ts) and
[activity filtering](../../packages/cli/test/ps-pl019-active.test.ts) pass all 11
cases afterward. Both fixture listeners are loopback-only and awaited on close.
Rig/seat diagnosis, rig-coordinate precedence and activity-filter assertions remain;
the fetch guard, production diagnosis and actual fleet are unchanged.

Current [host selection](../../packages/cli/test/host-select.test.ts) and
[home/move dispatch](../../packages/cli/test/move-commands-host.test.ts) reproduction
found three fixture failures: an unregistered owned HTTP origin and a POSIX-mode
file that was not private under Windows ACL assessment. Exact origin registration,
native private-file creation and explicit injected login status make all 18 cases
pass. The fixture server is awaited on close; no actual host selection, remote
execution, real credential read or provider invocation is performed.

Bundle author checking and configuration staging also now apply their existing
dependency/metadata exclusions case-insensitively on Windows. Two owned-directory
reproductions failed before this change: dependency case variants entered the copy
and were scanned by the author check. Four selected [configuration](../../packages/cli/test/bundle-configuration.test.ts)
and [author-check](../../packages/cli/test/bundle-check.test.ts) cases pass afterward,
with 23 cases filtered. Similarly named `node_modules-not` directories remain
included and the source bytes remain unchanged. POSIX matching is unchanged;
CLI TypeScript passes. This is not complete bundle-suite acceptance.

The offline help resolver also needed a native installation-boundary correction:
Windows `NODE_MODULES` spellings were treated as source checkouts and could select
an outside help file first. An owned-directory reproduction failed before the
case-aware component check. The repaired [blocked-connection module](../../packages/cli/test/daemon-blocked-connection.test.ts)
passes 21 cases, including selecting the bundled file and refusing the outside
fallback after the bundled file is removed. Three POSIX-only fixture spellings
were corrected. CLI TypeScript passes; no live daemon or user help files are read.

At `1104674`, exact package-relative filename and full test-name reconciliation
of the old `a2d903d` CLI/TUI report matches 25 of its 94 failed assertions to
passes in 12 selected later scoped reports. The other 69 assertions have no match
in that selected evidence set; they are unverified, not asserted still failing.
Renamed tests need manual reconciliation, and this assertion-only comparison
does not clear collection failures or establish feature completeness.

The compact queue receipt had a second POSIX-only recovery command even after
ordinary queue error guidance was repaired. It now uses the same native command
renderer. Two real PowerShell receipt-command cases failed before that change;
the receipt and native-command modules pass 91 cases afterward, including literal
ID/host quoting and endpoint restoration after both success and failure. CLI
TypeScript passes. The executor substitutes a fixture function for rig and touches
no actual queue or endpoint.

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

Workspace doctor and typed workflow acceptance fixtures now pass 16/16 on native
Windows. Doctor assertions compare the complete native resolved path; the workflow
fixture registers only its own ephemeral loopback server with the fetch guard.
The real CLI-to-HTTP acceptance checks still reject mismatched fields without
mutation. This scoped result does not establish live workspace or fleet acceptance.

MCP roster discovery now distinguishes a missing directory from a file blocking
an ancestor on Windows, where both can report ENOENT. A blocked path retains the
generic incomplete-rosters warning; a genuinely missing nested directory remains
an empty roster without that warning. The MCP server and owned HTTP telemetry
fixtures pass 57/57, with CLI TypeScript passing. No live roster or daemon is used.

Auth home fallback and seat registry fixtures pass 8/8. Registry creation and
replacement now verify private-file access using the native ACL assertion on
Windows and mode 0600 on POSIX, rather than interpreting Windows mode bits as
an access policy. These fixtures use an owned temporary registry and no account
credentials; OS home fallback resolves a path without reading its contents.

Kernel readiness deadline fixtures pass 6/6 with their exact owned loopback
origins registered. Slow-header and slow-body cases also require a request to
reach their server, preventing a fetch-guard refusal from looking like a working
timeout. The original 150 ms deadline and under-350 ms bounds remain unchanged;
the ready response is read through the real client. Servers are awaited on close.

Native terminal preview coverage now includes nineteen seats across two tabs,
with both writable and read-only attachment payloads. The real owned HTTP routes,
TUI preview plan and CLI composition retain every session exactly once, with two
new-tab and seventeen split-pane operations. Recursive grid command order is not
seat-list order. The native terminal suites pass 19/19; desktop launch remains
inert, so this is not visible-window or live source-process acceptance. The old
macOS/POSIX tmux fixtures remain separate from this native coverage.

An updated exact-name reconciliation of the original 94 CLI/TUI failures finds
46 later scoped passes and 48 without a matching receipt. Renamed tests and
replacement native scenarios are deliberately not counted as exact matches;
these historical reports do not establish a current whole-workspace pass.

Context-add directory-link rejection and watch-reference command checks pass
33/33 together. Windows uses directory junctions for the linked namespace and
dangling directory leaf; POSIX retains directory symlinks. No outside target is
written, and the dangling link remains intact. This does not cover file symlinks
or waive their privilege requirement. The documentation parser now accepts CRLF
as well as LF, so fenced commands are actually checked on Windows checkouts.

The default doctor executor fixture now checks the native empty configuration
name (`NUL` on Windows, `/dev/null` on POSIX) while retaining every probe timeout
assertion; both tests pass with child-process and network operations mocked.
Four selected bin-wrapper tests also pass, including native directory aliases,
sibling Node selection and missing-module diagnostics. The separate file-symlink
wrapper test is not included and retains its unverified privilege limitation.

A further native source audit checked explicit Windows refusal branches and
remaining POSIX shell/null-device references in CLI sources. Platform-qualified
desktop and remote-host paths are not automatically native defects. In particular,
the bundle Git transport's `/dev/null` configuration works with the tested native
Git: selected real-child checks cover empty global configuration, removal of
case-variant injected Git variables and sanitized errors, alongside pinned-source
and owned-archive fixtures. This is local Git execution, not a network fetch or
complete bundle import acceptance. The scan is a bounded source audit rather than
proof that every branch or workflow has been exercised.

An attempted real PowerShell/Node managed-runner witness did not establish
readiness: three owned-fixture attempts failed while removing their temporary
directory with EPERM, masking any preceding assertion outcome. Adjusting exit
ordering and supplying explicit temporary AppData paths did not resolve it.
The attempted test is not shipped, and no real-process acceptance is claimed.
The existing managed-runner synthetic process-table suite passed 22 cases in
the combined attempts. The temporary-directory cleanup assumption remains
unresolved; no shared process or ACL was changed to force the fixture through.

Provider command identity fixtures now cover both global npm shims and project
`node_modules/.bin` shims for Claude and Codex, selected through quoted relative
PATH entries and mixed-case environment keys. All five native alias cases pass,
including the existing executable identity check. The resolved interpreter and
entry are compared to native canonical paths; synthetic executable/script files
are never executed. This establishes selection behavior, not provider readiness.

Five selected seat launch-additions cases now pass on native Windows: owned
prompt/agent/plugin copies, native plugin-list separators and three linked
directory refusal paths. Directory links use junctions on Windows; file-symlink
cases remain unchanged and unverified. The initial broader diagnostic run had
26 passes and nine failures, including POSIX path/list assumptions, directory
and file symlink setup errors and a mode-based deletion-denial fixture. Source
changed before that run finished, so it is diagnostic only. The subsequent
five-case scoped receipt does not clear the remaining permission/file-link cases
or establish a complete launch-additions suite pass. Launch and restore adapters
are fixtures, not actual provider sessions.

The launch-additions deletion-refusal case now uses a real Windows reader lock
on its owned old record, while POSIX retains the non-writable-directory fixture.
The native case passes: refusal names the undeletable record, its bytes stay
unchanged, and releasing the lock allows the same operation to remove it and
return the empty additions result. The reader process is closed before teardown;
no ACL, provider, shared file or real seat is changed. Daemon TypeScript passes.

Native account-home snapshot routes now have their own plan/API-key reference
round-trip cases instead of inheriting the POSIX provider-execution test's skip.
An in-memory rig is stopped with a snapshot and restored through real Hono routes;
its selected native home and private synthetic token-file reference survive, and
status does not expose the synthetic token bytes. These two cases, restore-plan
preview and mocked service snapshot/restore checks pass 52 tests with two POSIX
provider-execution cases skipped. Daemon TypeScript passes. Tmux/resume/service
adapters are fixtures: this does not demonstrate actual provider sign-in, Docker,
running-seat continuity or fleet restoration.

The gate process observer and native executable fixture have also been checked
against their current sources: five Node tests pass, including an actual names-only
host census and an owned compiled receiver preserving literal argv, stdin, stdout,
stderr and exit status. Malformed/unavailable observations remain unavailable
rather than zero foreign load. The gate npm fixture wrapper was source-reviewed;
its full caller integration was not rerun. This closes a scoped evidence gap in
the old source-only ledger, not complete gate-lane or fleet acceptance.

Current cwd expansion, dot-prefix and seat runtime-directory tests pass 32/32.
Owned native directories exercise literal-path precedence, home and environment
expansion through launch/profile/preflight selection, including native backslash
home paths. Runtime-directory forwarding remains Linux-specific. The current two
production-source hashes and report digest are recorded in the local audit ledger;
no new implementation gap was found in these checked paths. Actual seat launches
and OS session-bus behavior were not exercised.

Package-manifest, built-in policy-reference and agent-starter resolver suites
pass 50/50 on native Windows at the current audited sources. Their source hashes
and report digest are recorded separately from the historical source-only ledger.
No new implementation failure was reproduced by these suites. This is selected
resource validation/resolution/materialization coverage, not installed delivery
of every resource or provider startup acceptance.

The native dependency installation gap now has a bounded implementation for
`Git.Git` and `Microsoft.PowerShell`. WinGet runs with exact ID/source selection,
user scope, silent/noninteractive operation and no upgrade. Native argv bypasses
shell parsing, while the existing executor journal and approval classifications
remain. Unaccepted agreements fail rather than being automatically accepted.
The plan-to-executor test verifies unapproved skipping, literal arguments,
failure journaling, continuation and unmapped-tool refusal with injected execution;
all 38 related tests and daemon TypeScript pass. Nothing was installed on the host.
The [WinGet install contract](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)
documents these options and IDs; this implementation is not complete package-manager parity.

The bootstrap call chain now has a focused WinGet integration receipt: the real
orchestrator resolves an owned package requirement, returns its plan/action key,
refuses automatic approval of the reviewed Windows action, and passes the
explicitly approved action to injected native argv execution. The resulting
bootstrap journal records provider `winget` and completion. This single case
passes; other bootstrap cases were filtered. Package files and database are owned
fixtures, runtime instantiation is mocked, and no software is actually installed.

The default argv executor is additionally exercised with real owned Node child
processes: literal quote/semicolon/environment-like/Unicode arguments survive,
and a child exiting 7 records failure and its stderr rather than completion.
The bounded package mapping uses Map lookup so prototype-like or arbitrary tool
names remain manual-only. Related suites now pass 44 tests and daemon TypeScript
passes. No WinGet installer was executed; installer timeout/descendant behavior
and post-install readiness remain unverified. A failed install receipt does not
prove rollback or that an external installer made no changes.

Bootstrap now re-probes requirements after a successful WinGet command before
installing project resources or instantiating the rig. Installed tools permit
continuation; missing tools, unknown results and observation errors retain the
install receipt and return partial without instantiation. The message explains
that the host may already have changed and the daemon PATH may need refreshing.
Four focused orchestrator cases pass and daemon TypeScript passes. This verifies
the control flow with injected probes/installation, not an actual WinGet install.

Failed or skipped WinGet dependency actions now also stop bootstrap before
project resource installation and rig instantiation, returning partial with the
recorded result retained. A new failed-installer orchestrator case confirms that
no post-install success probe or instantiation follows it. Existing selective
approval regressions remain passing; daemon TypeScript passes. This does not
establish installer rollback, descendant termination or safe automatic retry.

Windows native install execution now uses the existing atomic kill-on-close Job
helper rather than a root-only execFile timeout. An owned Node fixture times out
with ETIMEDOUT, its root and detached descendant both exit, and an unrelated owned
child survives. Combined with executor argv/nonzero/journaling regressions, 13
tests pass and daemon TypeScript passes. Output is bounded to 4 MiB and the
production deadline is ten minutes. No real installer ran: external installer
services, host modifications and rollback remain outside this process-tree proof.

A real owned child producing more than 4 MiB now verifies output-limit rejection
rather than success. Bootstrap coverage also includes two required native tools
with only one approved: the other action is journaled skipped, the result is
partial, and no rig is instantiated. Cumulative install/probe/executor suites
pass 46 cases; eight selected bootstrap/approval cases pass, with the other
bootstrap cases filtered. These receipts still do not claim a real installation.

The retired separate-process gateway wrapper has no production caller in the
scanned daemon sources; the in-daemon gateway subsystem is the current path.
It was classified as retired rather than expanded with new native behavior.
The live experimental Jev command/native-input suites pass 25 cases with one
platform-specific case skipped, using owned files, synthetic credentials and
injected provider sends. No external provider request or actual gateway starts.
Current source hashes, report digest and the skipped case name are retained in
the local audit ledger; these checks do not establish hosted provider acceptance.

Activity endpoint persistence and parent-session environment regressions pass
18/18 on native Windows. The health-policy persistence case now performs a second
real update, exercising replacement of an existing file, then reads back the
changed policy/version and both audit records including the correct predecessor.
That selected case passes; other health-diagnosis cases were filtered. All files
and policy changes belong to owned test homes, with no actual diagnosis dispatch,
fleet environment update or running daemon configuration change.

Successor blank-pane verification now uses the native idle-shell witness for
Windows instead of POSIX basename equality. PowerShell labels without `.exe`
and native shell paths are accepted only after stable process/console evidence;
a shell host with another receiver or unavailable evidence remains refused.
All 43 successor tests pass, including native witness acceptance/refusal and
unchanged POSIX successor behavior. The Windows lineage suite also passes its
synthetic observation cases; daemon TypeScript passes. Actual seat cutover and
stock psmux successor acceptance are not established by these injected fixtures.

The successor's idle-shell witness now also has a stock psmux 3.4.0 boundary
receipt. In an owned registry/namespace, the real PowerShell pane passes the
default native process/console witness; after a synthetic Node receiver starts,
the same pane is refused as idle. This selected native test passes and its owned
session is closed before removing the fixture. It does not perform a successor
cutover or access the default server, an existing seat or provider credentials.

Community harness readiness no longer reports a Windows PowerShell/pwsh/cmd
host as a running harness solely because it is absent from the POSIX shell set.
Those labels report native-lineage-unverified; non-shell process-only and POSIX
shell behavior remain. Five selected readiness cases and daemon TypeScript pass.
A positive harness-child witness behind a shell host still needs implementation
and acceptance; this correction prevents a false ready result rather than claiming
complete community-harness Windows readiness. No real harness was launched.

The positive process-only witness behind a native shell host is now implemented:
two stable process/console samples must identify one non-shell leaf receiver,
with every console member accounted for in the pane's descendant lineage and
consistent executable/start-time evidence. Idle, inaccessible, unrelated,
ambiguous or changing observations stay unverified. Fifteen selected helper and
adapter regressions pass; daemon TypeScript passes. An isolated stock psmux
3.4.0 test additionally confirms no receiver at the idle shell and a receiver
after its owned Node process starts. This is community process-only readiness,
not proof of harness identity, conversation recovery or actual provider work.

Community native receiver observation also rechecks the declared pane's membership
in its session before reading its PID on each sample. A missing or unavailable
pane listing cannot reuse another session's process evidence. Seventeen selected
readiness/receiver cases and daemon TypeScript pass, including refusal before
PID observation when the pane is unbound. This adds binding checks to the new
native branch without changing the process-only readiness claim.

At `12204b3`, the original finite 223-row ledger has five changed production
sources, 217 unchanged hashes and one withheld private row that was not read.
Unchanged hashes do not refresh acceptance. A separate seven-source index now
records current hashes and scoped receipt digests for native installation,
bootstrap, successor and receiver changes, including files absent from the old
candidate inventory. These receipts were not all executed at this head and do
not contain production-source hashes themselves; overlapping counts are not a
new cumulative test total. Historical tmux/startup evidence still needs its own
reconciliation rather than inheriting a current whole-runtime claim.

A fresh scoped-shell receipt at `786a74f` records identical before/after HEAD
and hashes for tmux, native scoped launch and startup. Four cases pass, including
stock psmux 3.4.0 cold empty-server setup, first scoped session, selected child
environment and dead-pane respawn/routing. No source changed during execution.
Startup's environment injection is hash-recorded, not createDaemon acceptance;
no daemon deployment, existing seat or provider was activated. An initial local
receipt-wrapper construction failed before any test ran; the corrected standalone
runner produced this terminal receipt rather than treating that failure as a pass.

Current UI command/browser-launch suites pass 16/16. The native fixture starts
system PowerShell with no system tools on PATH and preserves a URL containing
quotes, shell-like text and Unicode through an inert Start-Process function.
Source hashes and the report digest are recorded in the local ledger. No actual
browser/protocol handler is opened; UI lifecycle/client operations are injected,
so this is not visible browser or deployed UI acceptance.

Windows local-owner checking now uses read-only CIM GetOwnerSid and creation
time for the exact reported PID, plus the observing caller's SID. Two health/PID
and OS observations must agree within the deadline; missing, denied, malformed,
changed or late observations stay unknown. No command line or process environment
is requested. A real own-process test and injected same/foreign/change/failure
cases pass alongside existing guard regressions; CLI TypeScript passes. The
[GetOwnerSid contract](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/getownersid-method-in-class-win32-process)
returns nonzero on denied/unavailable observation. No actual foreign process or
deployed daemon was accessed, and this does not prove listener ownership.

Native owner checks are now exercised through real client HTTP boundaries too:
an owned loopback endpoint plus injected foreign SID observations receives only
health requests, with both business reads and writes refused. A second fixture
reports the test process's PID, uses real native SID/birth observations, confirms
same-user and permits exactly its owned business read. Together with direct
consumer and owner regressions, 32 tests pass. Unknown and explicit-routing
behavior retain the existing policy; no deployed daemon or foreign account is used.

Subset restore now admits native Windows shell labels to the existing stable
idle observation path instead of always treating their session as a running
agent. Positive native idle evidence reports attention-required with the pane
and history preserved; unavailable/unverified evidence leaves the existing
session untouched. Three injected native cases plus legacy shell-label restore
regressions pass, with no create/kill action in the native cases; daemon TypeScript
passes. An initial test expected the wrong result collection and was corrected
to the existing attention-required contract. No actual seat restore was run.

Current TUI reading regression/native-path/journey/anchor and window-action
suites pass 57 cases with 11 skipped. Reading resolves explicitly served native
roots; window-action fixtures execute an owned paired CLI entry through Node
and retain unknown-outcome/no-replay behavior. Source hashes, report digest and
skipped names are indexed locally. No new implementation failure was reproduced;
actual desktop opening, skipped viewer integrations and deployed interactive TUI
acceptance remain outside this receipt.

The TUI local reader now hides its helper process window on Windows. A real
owned Node child under a spaced/Unicode paired-CLI directory preserves the full
JSON request, does not execute the CLI main, and reports malformed output and
nonzero exit as errors; a missing CLI retains the unavailable result. Together
with local-selection regressions, six tests and TUI TypeScript pass. The helper
is synthetic, so this does not replace installed reader/content-access acceptance.

The cumulative lint command (daemon build plus daemon/UI/CLI/TUI typechecks),
docs guard and corrected diff whitespace check pass. Native package assembly
also passes at stamped commit `270f95392988d8a1cccf817c5b8cb6ccec43fc75`,
`dirty=true`, built at `2026-10-30T19:35:54Z`; this is not a clean release build.
The packaged native executor runs an owned Node child, the packaged SID guard
corroborates its own process with synthetic health data, and missing-pane/reader
results remain unavailable: four bounded checks pass, with five artifact hashes
recorded. No install, publish or deployment occurred. Without leak-guard rules,
the package build's term checks remain skipped; assembly success does not waive
that limit or establish installed/fleet acceptance.

Current native refocus Python/rig bridge/home suites pass 13/13. The shipped
helper resolves Python through the Windows launcher when plain `python` is not
on PATH, executes the real trace against owned Unicode notes and an owned npm
CLI bridge, and preserves explicit-interpreter failure without retrying through
another interpreter. No new refocus implementation gap was reproduced. This
does not prove availability on a host with no Python runtime or restore any
actual managed session; the fixture roots and CLI replies are synthetic.

At source `16c12c652`, the Windows daemon-control and shutdown suites pass
24/24. An owned child crosses the production startServer drain through the
native named-pipe channel, exits cleanly, persists the matching shutdown receipt
and removes its capability. Separate cases reject stale instance identity and
inherited-access control directories, and preserve a successor capability when
closing a predecessor. The shutdown regressions also cover bounded drain phases,
late/repeated shutdown and receipt-write failures. These checks operate only on
test-owned homes, servers and processes; they do not stop or restart the deployed
daemon or diagnose a historical abnormal exit.

At source `8f639d315`, ACP native command selection, actual owned process-start
identity and identity-bound cancellation pass 5/5. A current combined follow-up
run passes 41/41 across native Compose, idle subset restore, Windows local-owner
guard/client routing and the TUI local-reader subprocess. These scoped checks do
not resolve the previously unverified ACP companion cleanup or live-provider,
installed-TUI and deployment acceptance boundaries.

Reconciliation against the original 223-row finite inventory now finds eight
changed source hashes, 214 unchanged and one private follow-up withheld without
opening its source. The changed rows are local-daemon-owner, tmux, external
install planner, restore orchestrator, successor launcher, startup, local reading
and community runtime adapter. This supersedes the earlier five-row drift count;
unchanged hashes do not refresh historical acceptance, and new files outside that
inventory are not counted as coverage. Current source and report digests are
retained locally; overlapping scoped test counts are not a total suite result.

The next source review found two Pi diagnostics still recommending the POSIX
`command -v pi` in native Windows panes. Version-baseline and rejected-managed-
flag diagnostics now share the preflight lookup selector: `where.exe pi` on
Windows and `command -v pi` elsewhere. Readiness/capability suites pass 41/41,
including both platform variants of the version notice; daemon TypeScript also
passes. This repairs actionable guidance only, without changing launch admission,
probing an actual provider or claiming the selected executable is compatible.

Native seat-storage follow-up passes six cases: valid long filenames, exclusive
first publication in a competing-write fixture, same-seat casing, refusal through
directory junctions, projection restoration and preservation of user edits. An
additional owned `con` runtime path writes and reads successfully with the current
Node filesystem API, so the suspected device-name storage failure was not
reproduced and no directory-name remapping was added. The initial diagnostic
failed only an unjustified expectation that such remapping already existed;
that assertion was removed. This does not establish arbitrary Windows tool
compatibility with those paths, file-symlink support or actual seat restoration.

In-place Codex restart had another native shell-return gap: once the old
provider disappeared, its Windows host label alone could authorize typing the
resume command despite an additional console receiver or unavailable console
evidence. Two injected regression cases reproduced the unwanted continuation.
The Windows branch now uses the shared two-sample idle-shell witness, retaining
the expected pane PID and shell creation identity across those samples. Another
receiver, missing/failed/changing console observations or a changed pane leaves
the result `native_unknown` without typing a resume or signaling that receiver.
The proven idle-shell case still resumes exactly once; POSIX handling remains.

Current in-place restart unit/route regressions pass 154 cases with one platform
skip, and daemon TypeScript passes. These use synthetic native process/console
observations and an in-memory database, not a real Codex conversation or deployed
seat restart. Separately, three native tile/following cases pass: literal argv
and identity-bound replacement following through an owned executable, unchanged
POSIX SSH command rendering, and private selector persistence before injected
provider effects. No actual desktop viewer or remote host is opened.

The ordinary Codex transport's existing shell-label verification now also
recognizes native PowerShell, pwsh and cmd hosts. It reuses the existing Codex
process proof rather than treating those labels as provider readiness. Three
synthetic native-host refusal cases reproduced the previous platform difference;
the 58-case runtime-delivery suite now passes, including delivery after the
foreground resolves to a verified matching Codex. A matching child alone behind
a persistent shell-host label is not foreground proof. Terminal seats and other
runtime policies are unchanged. No actual queue, watchdog or provider is used.
The shared session-transport suite also passes 279/279 at this source change;
daemon TypeScript, docs guard and whitespace checks pass.

A stock psmux 3.4.0 follow-up compiles an owned native `codex.exe` stub with no
provider dependency, starts it beneath an isolated non-profile PowerShell pane,
and verifies the OS executable path plus exact resume argv through the real
native process reader. Its pane is not an idle shell. The one selected case
passes (three unrelated cases filtered), with the test namespace and files
removed afterwards; daemon TypeScript also passes.

This check exposed a test timing assumption rather than a missing launch
implementation: the stub's ready file can precede psmux's foreground-label
refresh. An immediate `codex` label assertion failed once with `powershell`;
the final case waits at most eight seconds for `codex`, then requires strict
process/resume proof. Delivery remains unverified during the shell-label
transition. The stub only waits after writing readiness: this is process and
foreground observation evidence, not Codex provider, conversation or input
acceptance, and it does not exercise an existing seat or deployment.

The old 94-failure CLI/TUI snapshot is now reconciled to 54 exact-name later
passes and 40 cases without an exact-name passing receipt. This supersedes the
earlier 46/48 split. Three current doctor path/distribution checks pass, including
two old failures; 43 unrelated doctor cases were filtered. Renamed home/auth
tests retain separate scoped evidence and are not silently counted as exact
matches. File-link privilege limits, ACP companion behavior and the unlaunched
grant-service integration remain distinct unresolved evidence boundaries.

Two old terminal integration files were also missing platform qualification:
they run real POSIX tmux viewers using `/bin/sh`, `/dev/null` and shell wrapper
files while simulating macOS launchers. They now explicitly skip on Windows,
instead of attempting that incompatible fixture or invoking an installed psmux
as POSIX tmux. Their 13 skipped cases are not passes and remain within the 40
unmatched historical cases. The separate native Windows window suite passes
14/14, including expected-plan refusal; CLI TypeScript passes. Native plan tests
do not substitute for visible desktop acceptance or for running the POSIX
integration cases on a supported host.

The previously unverified materialized-caller grant-service integration now
passes on native Windows. Its fixture supplies native system paths and private
home/temp/registry roots, compiles an owned no-launch terminal stub, and registers
only its owned HTTP origins. A real isolated daemon and the built CLI complete
MCP initialize/list-tools and queue create/show, with the expected grant principal
read back from SQLite. The two materialized nodes retain zero sessions, a missing
seat is refused, and the terminal invocation log contains no pane creation,
respawn or input commands.

The first setup attempt refused the stub because it did not answer the mandatory
version check; the final stub explicitly identifies itself as an owned no-launch
fixture and reports no server, while rejecting other operations. No actual tmux
or psmux is reachable in that test. Cleanup now awaits the owned MCP process and
proves the owned daemon PID exited before removing its scratch tree; cleanup
failures fail the test instead of being swallowed. The final integration case and
CLI TypeScript pass. This establishes the unlaunched HTTP/grant path, not terminal
or provider acceptance. Exact-name failure reconciliation advances to 55 later
passes and 39 unmatched historical cases, still including 13 POSIX fixture skips.

The current workspace build also completes across daemon, UI, CLI and TUI. It is
an ordinary source build with absent CLI build-identity fields, not a stamped
package/release or deployment; the earlier package gate is separate evidence.

Current native ACP process-fact suites pass 5/5, including finding a marked
detached descendant after its parent exits, excluding unrelated markers,
Windows-cased marker keys with exact values, exact argv/cwd and whitelisted home
selectors. This does not clear the old companion integration failure: its
retained report names an `EPERM` during fixture-directory cleanup. The separate
EOF diagnostic could not independently establish EOF. Neither is evidence that
changing the production protocol will fix cleanup, so no further speculative
protocol change or cleanup bypass was added.

The CLI account-home boundary again exercises the three original scenarios
directly: absent HOME in the default process environment, empty HOME there, and
an explicitly supplied empty HOME map. Each resolves beneath the actual OS
account home, with test environment changes restored afterwards; no account
auth file is read. With explicit-home selection and synthetic auth-seat registry
checks, ten cases and CLI TypeScript pass. The three original test names now have
current passing receipts: exact-name reconciliation is 58 later passes and 36
unmatched cases. These counts do not clear renamed permission tests, link
privilege limitations, ACP cleanup or the 13 POSIX fixture skips.

Source-level triage of the remaining 23 non-POSIX-fixture historical cases finds
20 involving file symlinks (including one mixed permission/link case), one POSIX
staging-mode assertion, one renamed auth-seat privacy case and the ACP cleanup
case. This is a classification of the old failure snapshot, not a claim that all
20 link cases have been re-executed or that no other feature gaps exist.

Four selected native proof checks now pass, with 19 unrelated cases filtered.
The new check observes real DACLs immediately before staged replacement bytes
are written: the staging directory has protected access rules, and both directory
and staged-file rules allow only identities already permitted by the original
private artifact. The staged file may safely inherit those rules from its private
parent; requiring the file itself to disable inheritance was an incorrect initial
test assumption, corrected after observation. A separate fixture-only ESM spy
setup failure was corrected by spying on the mutable fs object.

The other selected checks retain the artifact's DACL after replacement, preserve
readonly hard-link aliases and original bytes, and restore readonly state when a
real delete-sharing lock refuses replacement. No new production defect was
reproduced in this scope. Native access-policy evidence does not turn POSIX mode
bits or unavailable file-symlink checks into passes; exact-name reconciliation
remains 58 later passes and 36 unmatched historical cases.

The dependency-install review adds three feasible native CLI mappings: `jq` to
`jqlang.jq`, `rg` to `BurntSushi.ripgrep.MSVC`, and `gh` to `GitHub.cli`.
Microsoft's catalog records portable [jq 1.8.1](https://github.com/microsoft/winget-pkgs/blob/master/manifests/j/jqlang/jq/1.8.1/jqlang.jq.installer.yaml)
and [rg 14.1.1](https://github.com/microsoft/winget-pkgs/blob/master/manifests/b/BurntSushi/ripgrep/MSVC/14.1.1/BurntSushi.ripgrep.MSVC.installer.yaml) entries, and the current checked
[GitHub CLI 2.103.3 manifest](https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/GitHub/cli/2.103.3/GitHub.cli.installer.yaml)
adds portable ZIP entries alongside its machine MSI. The older 2.80.0 manifest
had only machine installers, so the initial manual-only assessment was corrected
after checking the current catalog. The checked [Git 2.56.0.4 manifest](https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/Git/Git/2.56.0.4/Git.Git.installer.yaml)
has user-scope entries and [PowerShell 7.6.9](https://github.com/microsoft/winget-pkgs/blob/master/manifests/m/Microsoft/PowerShell/7.6.9.0/Microsoft.PowerShell.installer.yaml)
includes MSIX entries; the existing git/pwsh mappings remain. These checks do not
pin the versions selected by a future WinGet invocation.

Known CLI names accept Windows case and `.exe` aliases while arbitrary paths,
catalog IDs, duplicate extensions, hints and unknown names remain unmapped.
Approved execution retains literal argv, mandatory user scope and the existing
post-install re-probe; no machine-scope retry is introduced. Planner/executor
and native probe suites pass 34/34, and nine selected bootstrap cases pass
(77 unrelated cases filtered), including uppercase `JQ.EXE`, rg and gh approval
keys and post-install readiness. Daemon TypeScript passes. No real installation,
agreement acceptance or host PATH change was performed; portable link creation
and current-host installation acceptance remain unverified.

The refreshed native package gate passes at exact source
`799e54ff250576683a4727858ea72e32787bd09f`, with identical empty tracked diffs
before and after (2026-10-30 20:24:08–20:25:42 UTC). It builds and packs, installs
into an isolated npm prefix, verifies SQLite ABI and invokes the actual installed
`rig.cmd` to load the daemon subpath and write an owned fixture fragment. Its
temporary install prefix, home and tarball are removed by the gate. The package
stamp remains `dirty=true` (built at 20:24:40 UTC); source stability is not a
clean-release claim. The leak-guard term-rule limitation remains unchanged.

Readback records five assembled artifact hashes. The packaged planner resolves
all five reviewed tool mappings in memory, and the compiled restart witness and
Codex host guard are present. Text presence is not execution of those guards;
their runtime evidence remains the separate scoped tests above. No package is
published and no running daemon or seat is upgraded.

The experimental Windows CI workflow still pinned psmux 3.3.8 while current
stock-native checks used 3.4.0. It now downloads the official 3.4.0 x64 archive
with the [release asset digest](https://github.com/psmux/psmux/releases/tag/v3.4.0)
`a66b6be7c13c6fa0dc3660a267b9e34eaa91a4eb7f07fbd55a0468018bd0f721`,
and includes the reviewed dependency and unlaunched grant-service regression
entries. Workflow YAML, asset URL/digest and referenced new test paths are
validated locally; hosted CI has not run. The existing read-only workflow
permissions and experimental/Draft posture remain.

The validation host does not resolve `winget.exe` on its current PATH, so actual
WinGet alias/Job execution cannot be tested here without changing that host.
No WinGet installation was attempted. A refocus trace also reports unresolved
topology/workspace roots; that trace does not establish a completed contextual
restore or authorize any live-team action.
