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

At `bd39336`, the complete pod RigSpec instantiator file passes 73/73 on native
Windows, including materialization, persisted spec identity, startup failure
cleanup and retained ambiguous terminal ownership. Its terminal and runtime
adapters are mocks; this is not live-team launch or restore acceptance. The
complete pod bundle assembler file passes 76/79. The other three cases fail
while creating file symlinks with host `EPERM`, before the containment assertions;
they remain unverified and are not waived or replaced by junction coverage.
The existing native path normalization already resolves the historical mock
filesystem failures in these paths; no additional production change was needed.

A finite reconciliation of the earlier source-stable daemon run's 1,638 failed
cases found 465 exact filename/title matches in subsequent fully passing scoped
reports before these two checks. The remaining 1,173 were unmatched evidence,
not reproduced current failures. Reports cover different revisions and the
filename selection is bounded, so these counts establish neither current full
suite status nor comprehensive Windows feature parity. The two checks above
add current scoped evidence without changing those historical snapshot counts.

The upgrade-helper follow-up found a production migration defect after replacing
POSIX-only test CLI fixtures with owned native executables. Preparation recorded
the managed System World as mode `0644`; Windows reads the same writable artifact
as `0666`, so verification rejected its own unchanged output as
`system_world_conflict`. Both canonical and shipped migration helpers now record
the native writable-file mode on Windows, retaining the POSIX expectation on
other hosts. Hash, file-kind and native read-only drift checks remain active;
this mode value makes no claim about Windows DACL privacy.

Nine selected upgrade tests pass on native Windows (41 other cases filtered):
CLI inspection and phase routing, helper mirror equality, prepare/finalize and
bounded-tail rollback, legacy-byte and resumed-writer refusals, and two new
System World byte/read-only drift refusals. The latter assert the operator's
changed artifact remains untouched. These use owned temporary homes and native
fake CLI executables, not the running daemon or installed telemetry. Daemon
TypeScript passes. The earlier wider exploratory selection still contains
file-symlink privilege failures and an unresolved planning expectation; neither
is counted as passed by the narrower regression result.

The unresolved planning expectation was a test-only slash assumption: native
paths are now compared to the exact owned fixture paths, including the stored
preimage reference. The complete planning/real collector sampling/verification/
rollback case passes. Plugin refresh checks now exercise Windows read-only
attribute changes rather than unobservable POSIX owner/execute-bit changes:
an operator's read-only local modification is preserved, while an unchanged
ancestor can receive the target's new bytes and read-only attribute. These
three cases pass together; daemon TypeScript also passes.

The exploratory full upgrade-file result was 34 passed and 16 failed before
these test corrections. Two of those passes were early returns because the
host has no `sqlite3` executable (`ENOENT`); they did not verify backup behavior.
Both now report explicit skips. The final selected run has three passes and
47 skips, including those two missing-tool skips and 45 filtered cases. File
symlink creation and the full corrected file remain unverified; native mode
coverage is not POSIX permission coverage or a DACL-preservation claim.

The complete restore-check service file passes 118/118 on native Windows after
normalizing its mock relay destination to an absolute native path. Before this
test correction, 18 hook-readiness cases incorrectly reported an absent relay
because their mock filesystem only recognized the POSIX spelling; production
already resolved the instance-owned relay correctly. The passing cases include
selected-event matchers, disabled/malformed and similarly named command caveats,
plus the existing owned real-file check for Windows slash variants. Database,
inventory and health dependencies remain isolated fixtures: this does not prove
live-team recovery or provider continuity. Daemon TypeScript passes.

The subsequent non-link upgrade selection passes all 34 executed cases;
two SQLite-tool cases explicitly skip and 14 link-related cases are filtered.
That selection validates the corrected planning and native attribute checks
together with the migration regressions, without converting missing-link or
missing-tool coverage into passes.

Pinned classic Claude launches exposed another production gap: the adapter emits
POSIX `exec <selected executable>`, but the Windows seat environment left `exec`
as `ProcessStartInfo.FileName`. An owned native fresh-launch regression failed
at Windows process creation before the selected executable ran. The Windows
Claude conversion now removes that one leading POSIX builtin after decoding
the allowed command-scoped assignments, then launches the selected executable
directly. Literal parsing still refuses shell operators; POSIX launch behavior
is unchanged.

Six native regressions execute the generated command through real PowerShell
and owned fake Claude entries: fresh/fork/resume, legacy resume, and Node-script
fresh/resume. Child argv readback verifies one intact settings value, exact
marker/map/configured-extra grants (including escaped bracket paths), preserved
member deny rules, and the intended resume/fork identity. Together with the nine
existing Windows launch tests, 15/15 pass; daemon TypeScript passes. The native
fixture children exit before their temporary roots are removed. Provider
readiness is mocked, so this proves OS command/argv transport, not a real Claude
conversation, authentication or restore continuity. The six-case file is added
to Windows CI; hosted execution is still pending. The older POSIX-shell-based
restore-read file remains separate evidence and is not claimed native-green.

The follow-up prefix audit passes five current Codex/Pi checks and all 11 native
community-environment cases, including recognized npm entries, environment
assignment/removal, named/resumed conversations and launch-result metadata.
No additional prefix defect was reproduced in those scoped paths. These are
owned fake entries and child-environment checks, not real provider acceptance.

Materialized first-start and explicit failed-first-start retry now pass 34/34
on native Windows. Before correcting their mock filesystem lookup, 33 cases
stopped at POSIX-spelled fixture keys while the resolver requested native
absolute paths. The mocks now compare resolved paths, retain mutable fixture
contents, and assert native startup-file destinations. Production code did not
change for this correction. Coverage includes selected-seat effects, preserved
sibling records, snapshot reopen, ownership/refusal controls and projection
failure/retry. Terminal/runtime operations are mocked and the database is
in-memory; this does not launch seats or establish live-fleet acceptance.
Daemon TypeScript passes after the test changes.

The complete startup-orchestrator file at `8f53276` reports 166 passes, four
file-symlink creation failures (`EPERM`) and two skips. No production change
was needed for those four host-limited cases. One skipped POSIX-only named
community-resume failure case now also runs natively: an isolated PowerShell
command starts an owned Node fixture, reads the saved resume name, and exits
with status 4. The orchestrator records failure, keeps the exact saved DB
name/type and dispatches only once, without starting a fresh conversation.
That selected native case passes; the other prior skip and file-link limits
remain separate, and the full edited file has not been rerun.

The test uses the real Windows seat-environment conversion with a narrow owned
child environment, in-memory DB and mocked terminal dispatch/readiness surfaces.
Its YAML command is encoded as data so spaces and native backslashes survive
preset loading. It does not use a real community provider or live terminal.

Claude managed-block destinations and conflict detection pass all 37 cases on
native Windows after test corrections. The real-file journey now JSON-encodes
the native cwd in YAML instead of treating backslashes as YAML escapes; conflict
fixtures compare native paths and normalize mock filesystem keys. Coverage
includes the selected `CLAUDE.local.md` destination, preservation/idempotence,
restore/expansion/teardown and export/import selection. No production change
was required by these fixture failures, and terminal/provider activity remains
mocked.

The team/kernel permission file passes 197/197. On Windows its subprocess tests
parse the emitted literal Node command and execute that owned hook entry
directly with stdin, rather than requiring `/bin/sh`. This verifies allow/ask
decisions, unchanged input/settings, malformed-input fallback and paths with
spaces/apostrophes. It neither executes the command described in the hook input
nor proves Claude's own Windows hook-shell dispatch. POSIX tests retain their
shell execution. Daemon TypeScript passes after all three test-file changes.

Shipped-role orientation and scope-view projection pass 30/30 on native Windows
after correcting fixture-only path and line-ending assumptions. Shipped agent
references use portable slash-separated paths, removal of the one orientation
line accepts CRLF without rewriting the rest of the source, and scope fixtures
resolve native filesystem paths. Authored requirements/evidence remain the
scope data source; `PROGRESS.md` is still display-only. No production code was
changed for these two files.

The accompanying generated-file hygiene exploration is not green: its current
file has 12 failures, including Windows-invalid fixture filenames, directory
symlink privilege, POSIX command wrappers and Git's quoted native path output.
Qualified plugin IDs such as `shared:openrig-core` are still used as literal
directory components in those fixtures and in projection target construction;
native namespaced projection needs a dedicated reproduction and reconciliation
of target paths and generated-file exclusion before any parity claim. The
successful role/scope checks do not close that separate projection requirement.

Dedicated owned-file reproductions confirmed that qualified plugin IDs failed
in both Claude and Codex because `:` was passed directly to NTFS mkdir. Native
resource directory construction now escapes Windows-invalid components while
retaining logical IDs in specifications and projection records. Percent spelling
is escaped too; newly encoded names preserve case/Unicode distinctions even on
case-insensitive volumes, and reserved device names/trailing dots are encoded.
Ordinary valid names and all POSIX directory names retain their existing layout.
No existing directories are migrated or removed by this change.

The shared mapping is used by Claude/Codex/Pi/OMP (and stub skill) projection,
conflict-target resolution, cwd preparation, seat-skill replay and runtime-switch
material preparation. Codex's generated-file exclusion recognizes the mapped
core-plugin directories. Installed-skill reads decode logical IDs and group
recursive filesystem entries by resource directory instead of reporting helper
filenames as separate resources.

Thirteen scoped native regressions pass: directory encoding/collision checks,
real Claude/Codex plugin projection and Codex Git exclusion, four runtime skill
projections with ID readback/cwd conflict detection/operator-edit preservation/
missing-source replay refusal, plus six existing native filename/path cases.
A separate existing Codex installed-resource case also passes. Daemon TypeScript
passes. All files/Git repositories are owned temporary fixtures; no provider,
live seat or runtime switch is executed. The new regression file is in Windows
CI, which has not run. The broader generated-file hygiene file still has its
separate invalid-fixture/symlink/wrapper limitations and is not claimed green.

The subsequent complete generated-file hygiene file reports 28 passes and one
failure: ordinary directory-symlink creation remains host-denied with `EPERM`.
The distinct native junction case passes, including idempotent exclusion and
Git's NUL-delimited alias readback; it does not waive the symlink case.

Fixtures now use Windows-valid literal metacharacters (spaces/brackets/`!`/`#`)
on Windows, retaining `*`/`?` filename cases on POSIX. Qualified plugin fixtures
use the production directory mapping. NUL-delimited Git output avoids confusing
Git's quoted display of native backslashes with a changed filename. Current and
sibling worktree case conflicts, existing user-file visibility, exact exclusions
and the large ignored-tree bounds pass.

The Git batching and overall-deadline tests also execute on Windows through
owned native wrappers. Read counts compare canonical physical directories, so
DOS short-name spellings do not hide a call. The slow fixture delays in its
native entry before starting Node/Git; the five-second overall deadline expires
during that delay, records a timeout/deadline warning and leaves exclude bytes
unchanged. The test now requires elapsed time between 4.5 and 6.5 seconds, so an
unrelated immediate error cannot count as deadline evidence. A default-delay
native Claude fixture still passes after extending the test helper. No product
code changed in this follow-up; daemon TypeScript passes.

The refocus follow-up reproduced a production regression in the paired CLI hook
resolver. Windows seat launch now generates the v2 `rig.cmd` with
`setlocal DisableDelayedExpansion`, escaped percent paths and a v2-specific
directory digest; the hook still recognized only the earlier shim/digest and
therefore could not invoke that seat's paired CLI. The resolver now accepts both
exact generated forms, decodes only doubled literal percents for v2, and checks
the matching digest, Node identity and declared OpenRig package entry. It never
executes the batch text; malformed escapes, extra commands, wrong digests and
unrelated/mismatched package entries remain refused.

Twenty-eight related native tests pass, including the actual v2 generator and
hook dispatch under an owned path containing Unicode, apostrophe, `%PATH%` and
`!`, exact argv/empty-argument readback and refocus content retrieval. The older
role fixture now uses a recognized owned npm CLI and a native Python stand-in
with platform PATH separators, making its role/unknown/failure cases executable
on Windows. These stand-ins do not prove real Python traces, provider delivery
or current seat state. Daemon TypeScript passes. Windows CI includes this group
but has not run; no installed plugin is refreshed and no live seat is touched.

Agent resolution, package resolution and install planning pass 51/51 together
on native Windows. Seventeen earlier resolver failures were fixture-only native
path lookup/absolute-path expectations; their mock keys now resolve paths before
lookup without changing production ref handling. The install planner was already
passing in the initial run and required no change.

An additional owned real-filesystem case resolves a local ref, a drive-qualified
ref and its forward-slash spelling under a temporary root containing spaces,
brackets and an apostrophe. All three load the same base and exact absolute
imported spec through JSON-encoded YAML. Import versions/collisions and refusal
cases remain covered by the other resolver cases. This does not access a network
share, install a package or start a runtime. Daemon TypeScript passes.

The historical exact-name reconciliation refreshed at `2fede10` finds 690 of
the original 1,638 failed daemon cases in later fully passing scoped reports;
948 lack such a match. The bounded report selection now also includes completed
`-full` reports. Renamed cases and passes in reports with unrelated failures are
still not credited. These are historical evidence counts across revisions, not
948 reproduced current failures or a current full-suite result.

The complete seat set-cwd and plugin-vendor files pass 60/60 on native Windows.
Set-cwd's destination-refusal tests now look for JSON-escaped native paths in
serialized results, preserving their existing file/custody/no-event assertions.
The vendor mock resolves virtual paths consistently for reads, writes, directory
walks, removals and direct test inspection, including mutable installed content.
Tests retain newer/same-version installed authority and vendored/fetch-fallback
behavior. No product code changed; daemon TypeScript passes. Set-cwd uses owned
temporary files, in-memory state and no real terminal input; vendoring/fetch
dependencies remain fixtures, not a deployed plugin refresh or remote fetch.

The asset-header fixture no longer creates a file symlink before every test;
only its actual file-link case requests that privilege. Its existing 12 ordinary
preview/type/range/allowlist cases pass on native Windows, while the file-link
case still fails at creation with host `EPERM`. A separate new native junction
case passes: an in-root target is served and an outside target is refused. It
does not replace or waive file-symlink coverage.

The complete files-routes, truncation and asset-range selection passes 35 cases
with one existing POSIX executable-bit case skipped on Windows. Owned actual
files exercise read/write conflict metadata, full-file hashes with truncated
reads, exact bytes/ranges and render opt-in responses through in-process Hono
requests. No live daemon, browser or network listener is used. No production
code changed in this follow-up; daemon TypeScript passes.

The public-world verifier audit identifies an outstanding native implementation
gap. `world-public` currently ships only `verify-world.sh`, with POSIX shell,
grep/awk/sed and shell-based CLI fixtures. The native full-file reproduction
reports five passes and 17 failures; one is a CRLF census assertion, while most
remaining cases cannot launch their POSIX entry. Correcting that census split
makes its selected case pass, without treating verifier execution as covered.

The port inventory retains all 29 named checks and the existing mutation/refusal
tests. Native completion must preserve missing-rig skip versus broken-command
failure, identity/topology, exact retrieval/profile bytes, typed context-root
precedence, install/list/remove effects and partial-sync cleanup. The native
entry and its packaging/claim-census updates remain unfinished. No verifier was
run against a live rig or real user context store.

That verifier gap is now implemented as `node verify-world-native.mjs`. The
standalone Node entry executes all 29 existing named checks without a POSIX
shell or text utilities. It reads the shipped shell companion's static check
definitions as data, never as commands, and rejects a missing/duplicate or
removed named-check inventory. Operational checks use literal CLI argv and
parsed JSON, preserving missing-rig skip versus a broken command failure,
identity/topology, retrieval/profile/token checks, typed context-root precedence
and the isolated install/list/remove probe. Normal and partial-sync cleanup are
verified; forced termination cleanup is not claimed tested.

On Windows, native executables, recognized npm CLI entries and exact paired
seat-bin shims are resolved without executing batch text. The v2 digest uses
the producer's exact realpath spelling, while file identity checks also support
native canonical paths; this matters for DOS short-name aliases. Malformed
paired percent escapes remain refused. The manifest, claim census and taught
command now include the native entry; the POSIX companion remains shipped.

The complete public-world file passes 24/24 natively, including all existing
mutation/refusal cases, real owned copy/list/remove effects, partial-sync cleanup,
an actual v2 generated seat shim under percent/apostrophe paths, and rejection
after a named check is removed. The production-library generator check passes,
and generation writes 57 packs with the native entry declared and byte-identical
to its source. Daemon TypeScript, Node syntax, docs and workflow YAML checks pass.
Windows CI includes the file but has not run. All CLI/state are owned fixtures;
this does not validate an installed tarball, real daemon or POSIX-host execution.

### Permission-policy discovery fixture follow-up

The Windows scoped run initially passed 42 tests and failed 14 across permission-policy discovery and seat-skill ownership. Eleven failures came from POSIX-only mock path predicates; those predicates and the negative cross-root read assertion now normalize native separators. The complete permission-policy discovery file passes 12/12 (permission-discovery-69ff15c-final.json); daemon TypeScript checking exits 0. No production policy behavior changed. Three ownership tests still fail while creating file symlinks with EPERM; those cases remain unverified, and directory junction coverage does not replace them.

### Codex hooks.json state fixture follow-up

The complete Codex activity hooks JSON test file now passes 14/14 (codex-hooks-a09a9ca-final.json). Its in-memory filesystem accepts native separators, expected config/hooks paths use the native join operation, and basic TOML keys escape Windows backslashes. The existing literal-quoted TOML key case remains separate. The tests cover preservation of user hooks/trust/disable state, inline-to-JSON migration, idempotence, removal and refusal of invalid writes. This changes fixtures only; it does not claim an installed Codex conversation. The separate Git add-dir file still has unresolved native failures and is not included in this pass claim.

### Codex Git add-directory fixture follow-up

The complete Git add-directory file passes 22 tests, with one directory-symlink creation EPERM and three explicit Windows skips (codex-dirs-4a2966e-final.json). Fixture roots and Git-reported admin directories use native real paths; command assertions normalize separators without changing command generation or process argv proofs. The skipped cases require trailing whitespace/control-character Git directory names or POSIX chmod denial, and provide no Windows coverage. A separate Windows junction refusal test passes (codex-dirs-junction-4a2966e-current.json): no seat folder is created through the junction and its target remains empty. It does not waive the original symlink case. Daemon TypeScript checking exits 0. These tests use owned temporary Git repositories and mocked terminal transport, without starting Codex or the daemon.

### Native bounded runtime verification integration

A new Windows-only RuntimeVerifier integration suite exercises an owned temporary codex.cmd through the actual bounded shell/Job probe and an in-memory migrated SQLite database. It verifies a healthy version, failed-version/help fallback, version timeout without fallback, help timeout, persisted status/version, and termination of every recorded fixture Node PID. Its isolated probe PATH and cwd prevent resolving the installed Codex; no provider or daemon is started. A separate native I/O case proves stdin EOF and exact 300,004-byte output drainage. Together with the existing Windows probe orphan/tree containment cases, 7/7 pass (runtime-verifier-b929b1c-native.json), with daemon TypeScript checking exiting 0. The Windows workflow includes these files; hosted execution is unverified. The POSIX process-group fixture suite is not counted as native coverage.

### Claude core-plugin load fixture follow-up

The complete plugin-load test file initially passed 26, failed 10 and skipped 9 on Windows. Native delimiter/path-aware mocks, JSON-escaped restore-warning assertions and CRLF-normalized shared boundary source comparisons bring that scoped run to 31 passes, five failures and nine skips (claude-plugin-7bd55b2-native.json). The remaining qualified-selection path assertion was then normalized and its complete rig-up case passes separately (claude-plugin-qualified-7bd55b2-current.json). Four original cases remain blocked at directory symlink creation with EPERM; they are not waived. No combined all-green file result or live Claude/plugin activation is claimed. The startup test creates an in-memory daemon under temporary homes without serving or changing the deployed daemon, and runtime launches use mocked terminal transport. Daemon TypeScript checking exits 0.

### Bundle API recovery and archive boundary follow-up

The two complete bundle API/context-pack router files pass 89 tests, fail seven at original filesystem-symlink creation with EPERM, and explicitly skip four POSIX chmod-denial cases (bundle-api-46c345a-final.json). The ordinary missing-skill recovery scenarios now run independently of the unrelated README file-link refusal: both local and imported skill warnings survive archive creation, inspection and unpack, complete skills clear the warnings, and invalid agents preserve previous finalized archive/digest bytes. The original README link refusal remains in separate matrix rows. A Windows junction escape row also passes, refusing a plugin outside the source root without producing an archive.

An additional install test constructs a real tar SymbolicLink header without creating a filesystem link. Independent tar listing confirms its exact type/target, the sibling digest matches the archive, and the install API rejects it with the unsafe-entry diagnostic (bundle-tar-link-46c345a-final.json, one pass). The original filesystem-link archive case remains unwaived. The combined 89-pass report predates this additional header row and is not represented as an aggregate final rerun. Daemon TypeScript checking exits 0; no deployed daemon, real provider or external bundle is accessed.

### Generated Claude activity hooks without Git Bash

The current [Claude hook reference](https://code.claude.com/docs/en/hooks#command-hook-fields) documents PowerShell fallback on Windows without Git Bash and an explicit powershell shell selection. A native regression using the actual adapter settings writer reproduced failure of the generated POSIX-quoted activity command (claude-hook-powershell-e627f63-repro.json). Windows settings activity hooks now explicitly select PowerShell and use its call operator with single-quoted literal executable/script arguments, doubling embedded apostrophes. POSIX generation remains unchanged. Legacy settings commands remain recognized for replacement/removal; both the daemon reader and shipped relay reader recognize the finite new literal form and reject appended commands/operators.

The actual generated command now executes an owned replacement relay in Windows PowerShell with empty PATH (claude-hook-powershell-e627f63-native.json). The full invocation file passes 15 and fails four: two file-link EPERM cases and two plugin-manifest shell cases still requiring POSIX sh (claude-hook-node-e627f63-native.json). Three scoped delivery/restore-check/native-path files pass 30/30 after updating the expected generated command (claude-hook-readers-e627f63-native.json). Daemon TypeScript checking exits 0. This is not real Claude hook dispatch or installed plugin acceptance. The shipped plugin manifest and status-line command shell behavior remain separate follow-up items; this scoped activity-hook fix does not close them. No deployed settings, plugin or seat was changed.

### Native Claude status collector shell envelope

The [official status-line documentation](https://code.claude.com/docs/en/statusline#windows-configuration) says Windows routes commands through Git Bash, or PowerShell when Git Bash is absent. The Windows collector writer now uses powershell.exe with a UTF-16LE encoded, literal call of the pinned Node executable and collector arguments, avoiding POSIX quoting at the outer shell. PowerShell must remain resolvable on PATH; Node need not be. The ownership reader only accepts the exact envelope with canonical base64, a finite literal Node call and the existing collector path/argument shape, retaining older generated commands for migration and preserving custom/composed commands.

The actual generated collector command runs through both installed Git Bash and Windows PowerShell with only the PowerShell directory on PATH. Both execute the real copied collector and persist the expected usage sample, including a Chinese/apostrophe session ID (claude-statusline-21b29b5-shells.json: two passes, 19 filtered). The complete collector suite passes 54/54 (claude-collector-21b29b5-native.json). The complete command invocation suite passes 17 and retains four failures: two file-link EPERM cases and two plugin-manifest POSIX-shell cases (claude-hook-node-21b29b5-final.json). The activity-hook native test was strengthened to verify exact Unicode stdin forwarding as well. Daemon TypeScript checking exits 0. These are shell/process and owned-file proofs, not actual Claude dispatch; the plugin manifest remains a separate unfinished item. No deployed settings or runtime changed.

### Native Claude plugin manifest conversion, not yet installed

A strict Windows manifest renderer now accepts only the shipped finite Node/script/argument grammar and renders explicit PowerShell hooks. It retains event/group metadata, matcher, timeout and argument ordering, reads the plugin root and selected Node from environment as values, and refuses unknown commands, traversal or appended shell operators. The canonical source manifest remains unchanged.

The new scoped suite passes 7/7 (claude-plugin-manifest-db6662a-native.json). It checks all 13 shipped entries and runs every rendered entry in actual Windows PowerShell with both explicit Node/empty PATH and legacy PATH Node selection: 26 process calls, each preserving its arguments and exact Unicode stdin. Scripts are owned stand-ins under a temporary path containing Chinese, apostrophe, percent and dollar characters; this does not execute all real hook effects or start Claude. Daemon TypeScript checking exits 0.

This renderer is not yet connected to plugin staging. Equal/newer installed plugin versions retain authority, and Codex checks the complete shipped tree, so platform specialization must be integrated with those paths before claiming native plugin installation. No deployed plugin, seat, version authority or hash predicate was changed by this step.

### Native plugin staging and exact Codex content authority

The Windows hook renderer is now connected to PluginVendorService: only the shipped openrig-core hooks/claude.json gets the native projection, while other files keep their bytes. Both harness plugin manifests advance together from 0.1.31 to 0.1.32, so existing installs use the established newer-version refresh with recovery copies; equal/newer installed versions and operator edits keep their authority. POSIX staging retains canonical source bytes.

Codex compares the expected platform-projected shipped tree against the actual installed tree. The installed-content fingerprint algorithm remains untransformed; no installed file is rewritten or normalized for comparison. The per-hook-file gate, complete strict tree gate and owned content-approval gate use the same expected platform projection. Changed hook manifests/scripts, extra files and operator-owned equal-version bytes do not match.

Actual owned-filesystem staging plus all 13 hook entries in both Node-selection modes passes 8/8 (plugin-native-staging-4b489e0-native.json). The test verifies backup of replaced canonical hooks, exact staged bytes, idempotence and raw installed fingerprint mismatch after each tampering case. Vendor/route tests pass 34/34 (plugin-staging-4b489e0-native.json); complete owned Codex trust tests pass 33/33 (codex-owned-native-staging-4b489e0-current.json), including refusal/disable retention and unchanged native baseline behavior. Daemon TypeScript checking exits 0. These tests stage temporary plugin trees and use a fake Codex CLI; no deployed plugin was refreshed and no provider/Claude session was launched. Windows hosted CI is configured but has not run.

### Native package gate at 126a5ca

The actual package gate passes at clean tracked source 126a5ca2ca5e3372a166cfc3ca3bb2461e1450c9, with unchanged head and tracked-diff hash before/after (pack-gate-126a5ca-current.json; 2026-10-30 22:02:46–22:04:18 UTC). It builds the package, creates/installs an owned tarball into an isolated prefix, checks SQLite ABI and runs rig.cmd through a daemon-subpath-loading command. This is not deployment, publication or fleet acceptance. The protected untracked diagnostic is retained, so artifact dirtiness is distinct from tracked-source stability. No leak-guard term rules were supplied; that term check remains skipped.

### Control-plane generator entry and Windows loader follow-up

A real Node import without argv[1] reproduced an undefined-path crash in the generator entry check. It now guards the argument and compares native real paths, retaining direct CLI execution and inert imports. Separately, the Windows test loader exposed Vite moving a CRLF shebang into the middle of generated code. The generator is pinned to LF checkout bytes, and its test no longer discards the original import error. Two attempted loader bypasses were discarded; normal imports are used.

The complete generator file passes 10 cases and retains two file/directory-symlink creation EPERM failures (control-plane-126a5ca-final.json). Passing cases include product-authority byte preservation, digest/layout/override generation, malformed-input refusal, real Node import without argv[1], direct CLI parameter validation, and separate Windows junction refusal before outside-root traversal. Junction success does not waive either original symlink case. Daemon TypeScript checking exits 0. The preceding package gate predates this generator change and is not a final-head gate.

### Managed refocus result and real native trace follow-up

The complete managed-result test file initially passed seven and failed ten on Windows (refocus-result-2602aa2-current.json). Its fixture now uses a recognized owned npm CLI on Windows, the native PATH delimiter, an isolated USERPROFILE as well as HOME, and the existing installed-Python discovery helper. The check-mode case invokes that actual Python executable rather than assuming python3 exists. POSIX fixture behavior remains.

All 17 cases pass (refocus-result-2602aa2-native.json), including managed restore hold/expiry, occupant isolation, successful authored diagnostic text, retained real trace failures and recovery, check-mode status, slow stream receipt, and in-memory daemon startup seeding. The trace script runs with real Python; CLI results and stream receipts use an owned stand-in. This is not actual seat continuation or a restored deployed fleet. Daemon TypeScript checking exits 0, and the Windows workflow includes this file. No production code or deployed runtime was changed by this fixture follow-up.

### Native profile-resolution fixture follow-up

The complete profile-worker file initially passed seven and failed nine (profile-worker-af10b16-current.json): five POSIX FIFO dependencies, two bare Windows --import paths, and two POSIX shell Git wrappers. The selected import/catalog cases now use a file URL for the Node loader, a real native executable Git wrapper forwarding literal argv to Git, and the native PATH delimiter. Once the loader ran, Windows correctly refused deletion of the child process current directory with EBUSY. The original deleted-cwd cases remain POSIX-only, with separate Windows move-then-remove cases verifying fresh reads on repeated resolution.

The four selected native cases pass (profile-worker-af10b16-final.json). Fourteen cases are marked skipped in that filtered report: two explicit POSIX-only deleted-cwd cases and twelve name-filtered cases, not fourteen platform passes. Catalog tests prove one raw scan per preflight scope while retaining member selection, and fresh scans across operations/edits. Daemon TypeScript checking exits 0. Five FIFO-backed blocked-scan/health cases remain without native coverage; no full-file all-green result or native equivalent is claimed. No production resolver, deployed daemon or actual seat was changed.

### Native blocked profile-worker responsiveness

Five new Windows cases supplement the POSIX FIFO checks. A real native Git wrapper runs inside the actual profile-resolution worker and blocks on an owned release marker with a five-second fail-safe. Tests confirm its exact scan arguments and live PID, then receive an owned loopback health response while the operation is incomplete and the release marker absent. Releasing the gate completes preflight, instantiate, materialized launch and first-start retry respectively; the recorded fixture PID is then gone. These paths use actual worker resolution, temporary Git catalogs and an in-memory daemon test app; terminal/runtime adapters are stand-ins. A fifth case proves a resolver exception returns before any Git gate helper starts.

The complete profile-worker file now passes 16 cases with seven explicit POSIX-only skips (profile-worker-2db5a91-full.json): five FIFO cases and two deleted-current-directory cases. Windows does not gain FIFO filesystem semantics from these checks; its separate blocking Git catalog path proves parent-thread responsiveness during synchronous worker I/O. The first four native cases initially reached the gate but the test fetch guard refused the host low-port fixture; only each exact owned origin was registered before the passing run. The Windows workflow now runs the complete file. Daemon TypeScript checking exits 0. No production resolver, fleet or deployed daemon was changed.

### Host pairing and selected Codex home follow-up

The complete host pairing API test file passes 31/31 at ef310df (hosts-pair-ef310df-current.json), without a new code change. It uses owned fixtures, not an actual remote host or credential exchange.

The Codex selected-home file initially passed five and failed eleven on Windows (codex-home-ef310df-current.json), largely because its executable and shell fixtures were POSIX-only. The Windows branch now uses an owned native executable, the native SeatLaunchEnvironment and actual Windows PowerShell execution, native PATH delimiter and canonical fixture roots. Probe/legacy paths carry the same launch environment. The unavailable-metadata case preserves the native refusal without typing a POSIX fallback; TOML path assertions account for escaped native separators.

The complete selected-home file passes 16/16 (codex-home-ef310df-async.json). It covers fresh/resume/fork/legacy HOME precedence, default/empty selection, capability probes, selected state reads, seatless startup and refusal of nonabsolute homes, while retaining sentinel bytes in the other home/project. Runtime verification/capture and terminal transport are mocked; actual PowerShell commands run the owned fake Codex. Cleanup uses asynchronous bounded removal so owned exit callbacks can run; earlier failed-cleanup roots are not claimed cleaned. Daemon TypeScript checking exits 0. No provider credentials, real Codex conversation, deployed daemon or user home was accessed by these fixtures. The Windows workflow includes the full file.

### Native trunk diff and local notes fixture follow-up

The operating-model trunk diff file initially failed all nine tests because its bare bash call resolved to the host WSL launcher, whose shell was unavailable (trunk-diff-5c84187-current.json). The shipped shell entry already delegates to the native Node implementation. Windows tests now invoke that actual mjs entry directly; POSIX retains the wrapper check. All nine pass (trunk-diff-5c84187-native.json), covering the six default filenames, explicit names and replacement of defaults, change detection and stable subsequent renders. No WSL startup or configuration is required by the passing path.

Local notes tests now use real installed Python, native PATH spelling and canonical fixture roots, with an owned npm CLI fixture retained to detect unexpected delegation. Six pass, three original file/directory-symlink cases remain EPERM, and one POSIX chmod-denial case is explicitly skipped (refocus-notes-5c84187-native.json). Passing cases compare daemon, CLI and trace resolution, cover a Windows junction pointing to a directory, and retain the full-read race diagnostic. Junction coverage does not waive file-symlink or unreadability coverage. Daemon TypeScript checking exits 0; this step changes fixtures/workflow only, not deployed source or user workspace contents.

### Native test fixture temporary-directory containment

The shared test setup now binds TEMP and TMP as well as TMPDIR on Windows. Previously, only TMPDIR was changed, which does not select the Windows os.tmpdir location. This keeps ordinary test scratch directories inside the worker-owned temporary directory. POSIX and the existing keep-temp opt-out retain their own semantics. The child fixtures use file URLs for the Node --import loader and explicit native temp variables, preventing Windows drive letters from becoming unsupported URL schemes.

The complete fixture-home cleanup file passes eight cases with three explicit POSIX signal skips (home-cleanup-c39a92d-native.json). Normal exit and a controlled IPC exit clean the worker-created state home, user home and scratch directory. Reused parent fixture homes and unmarked environment-selected state remain untouched. Windows forced termination is not represented as graceful signal cleanup. The separate shared environment/test-app/scaffold regression passes 20 and fails two POSIX tmux-shim spawn cases (hermetic-temp-c39a92d-regression.json); those direct shebang/signal fixture cases remain unverified on Windows, not cleared by the temp fix. Daemon TypeScript checking exits 0. No deployed runtime or user state was cleaned or changed.

### Native inert terminal scaffold forwarding

The scaffold helper now provides a native executable bridge only to an explicitly supplied inert terminal fixture. It pins Node, restores the saved executable PATH for that child, passes the explicit socket and literal argv, and forwards stdin/stdout/stderr and numeric exit status. Without that explicit fixture the native executable refuses; a negative test confirms it never calls a terminal from the saved PATH. Real Windows terminal-server lifecycle is still unsupported by this helper, and an unexpected socket marker makes cleanup retain the evidence. POSIX wrappers and their signal checks remain separate. Windows USERPROFILE and temporary-directory variables point into the scaffold.

Exact stdin comparison exposed a BOM introduced by the C# fixture bridge. Selecting no-BOM UTF-8 console input before Process.Start fixes the fixture without stripping input. The shared scaffold/environment/test-app regression passes 22 with one POSIX signal skip (scaffold-5672941-regression.json); the separate native env assertion passes (scaffold-env-5672941-native.json). The Windows executable-fixture argv/stdio/status test passes 1/1. Daemon TypeScript checking exits 0. No real tmux/psmux server, deployed seat or production input handling was changed. This closes the inert fixture invocation gap, not native real-server scaffold acceptance.

### Real isolated native psmux scaffold lifecycle

A separate real-server scaffold now invokes an explicitly selected psmux executable directly, with immutable owned HOME/USERPROFILE/app-data/temp paths, a private PSMUX_DATA_DIR, NUL config and random -L namespace. It rejects caller endpoint overrides. Before the first session, it holds the empty server and configures a NoProfile PowerShell default shell. The inert tmux fixture bridge remains separate and does not become a PATH-first real-server launcher.

The stock 3.4.0 native test passes 1/1 (native-psmux-scaffold-cbe5792-complete.json). Two simultaneous scaffolds expose different server PIDs and disjoint session lists. A real pane writes its own HOME/USERPROFILE/registry receipt; ending the first scaffold leaves the second reachable. Cleanup reads the selected namespace PID, corroborates executable and home identity through OS process facts, sends kill-server only to that namespace, waits for the recorded server/pane PIDs to disappear, then removes the owned root. Both roots disappear and repeated cleanup is inert. Unknown identity or unfinished exit retains evidence under an ignored task-specific cache directory outside the generic worker TMPDIR cleanup. No PID-wide kill or default namespace access is used.

Daemon TypeScript checking exits 0, and the Windows workflow uses its pinned psmux download for this test. This proves the exercised new-session/interactive command/cleanup lifecycle; arbitrary caller-created subprocess trees and externally ended/empty-server failure recovery are not established. No provider, deployed daemon or allocated seat was launched or restarted.

### Native rigspec preflight fixture follow-up

The complete preflight file initially passed 27 and failed nine on Windows (preflight-a2bc468-current.json). Its in-memory file keys and lookups now resolve native paths consistently, and the file-as-cwd refusal uses an owned ordinary file instead of assuming /etc/hosts exists. Product validation was not relaxed. All 36 cases pass (preflight-a2bc468-native.json), covering resolvable agent refs, profile/restore-policy/runtime refusals, import collisions, builtin-install cwd refusal/explicit override, and existing preflight behavior. Daemon TypeScript checking exits 0. These use owned fixtures and mocked runtime probes; no seat was started.

### Hosted wake fixture and bound-launch audit follow-up

The hosted-member wake file initially passed one and failed nine because its owned low-port receiver was not registered with the test fetch guard. Registering only that exact fixture URL restores 10/10 passes (hosted-wake-4b2e7db-native.json). Tests retain wake-accepted versus delivered/claimed distinctions, timeout/error/redirect handling, credential redaction, and per-wake recovery/deduplication using SQLite, the real queue and an owned HTTP receiver. No actual hosted member or paused group was rung. Daemon TypeScript checking exits 0.

The separate S03 bound-launch file currently passes 36 and fails 30 (bound-launch-4b2e7db-current.json). It explicitly constructs Linux managed-launch fixtures on this Windows host. Twenty-seven fail capability queries, two fail intended-PATH executable validation, and one fails the expected successful transition. These are recorded unresolved platform-fixture evidence, not counted as fixed native product failures or waived via name matching. Native managed-launch evidence remains separately scoped; this audit does not establish every S03 case natively.

### Native managed terminal metadata parity

A new actual Windows managed-child matrix reproduced a product difference: empty TERM_PROGRAM/TERM_PROGRAM_VERSION remained in the child, while the existing POSIX managed renderer omits empty terminal metadata. The native renderer now accepts an explicit nonempty-inheritance list supplied only for terminal metadata. Ordinary inherited/declared variables keep their set-but-empty behavior. The tests set conflicting daemon terminal values, then exercise pane metadata present, absent and empty through generated PowerShell commands and an owned Node executable.

The complete Windows managed-launch file passes 23/23 (native-renderer-8960ee6-native.json). The three matrix cases were then strengthened to prove an explicitly declared empty variable survives, and all three pass (native-renderer-8960ee6-empty.json; 20 filtered). General Windows launch regressions pass 9/9 (windows-renderer-8960ee6-regression.json). Daemon TypeScript checking exits 0. These prove native command/environment behavior, not a real Claude provider or every Linux S03 fixture. No deployed seat or daemon changed.

### Native permission-selection service effects

Five Windows service-level cases now exercise the production SeatLifecycleService and Windows ClaudeManagedLaunch with a real migrated SQLite fixture and a mocked capability child. The supported vocabulary saves one selection and one permissions-changed event. Capability timeout, malformed vocabulary, missing intended-PATH executable, and a generation change during help all refuse without selection or audit writes. No terminal input/launch is sent, the missing executable causes no capability call, and the synthetic auth value is absent from recorded state/events.

The complete Windows managed-launch file passes 28/28 (native-selection-49610d7-native.json), including earlier actual PowerShell child cases. Daemon TypeScript checking exits 0. Timeout/error delivery in the new service cases is injected; actual bounded native probe-process behavior remains supported by its separate scoped tests. This adds native service evidence without claiming the Linux S03 shell suite ran natively or changing the deployed permission selections.

### Native generation-bound managed launch evidence

The native permission-service matrix now also covers a later generation after a successful selection. A second capability response no longer supports the saved mode; the real adapter queries again, refuses launch without input, and preserves the original selection/audit instead of treating earlier support as a cache. Capability responses are injected, with two actual preparation calls recorded.

A separate generated PowerShell command starts an owned Node executable with a reserved successor generation despite a conflicting pane value. The child reads the reserved generation, while SQLite retains the current tenure before and after execution. The complete Windows managed-launch file passes 30/30 (native-generation-af9a7ff-native.json). Daemon TypeScript checking exits 0. These add native proofs for the S03 generation branches without a real Claude/provider launch, a fleet handover or a deployed permission change.

### Native fork call-entry snapshot

A Windows adapter case now mutates the caller's binding and fork options during capability discovery, then executes the generated PowerShell command through an owned npm-style Claude entry backed by Node. The child receives the original model, permission mode, Unicode name and literal parent ID, plus the new fork session ID and fork flag. No session file is read. This verifies the native call-entry snapshot through actual argv delivery rather than relying on the Linux shell assertions.

The complete Windows managed-launch file passes 31/31 (native-fork-7a774c7-fixed.json). The initial new fixture omitted the terminal send result; that fixture error was corrected without a product change. Daemon TypeScript checking and the documentation guard exit 0. Capability discovery and post-launch verification are mocked; no real Claude conversation or deployed seat was started. Other unresolved S03 branches remain outside this proof.

### Windows staged-launch revalidation boundaries

Four additional cases connect the real Claude adapter and Windows managed helper to TmuxAdapter's psmux staging path. Changes to generation, executable bytes or managed HOME after script staging refuse before paste. A managed HOME change after a permitted paste refuses before Enter. Each refusal unlinks the unconsumed staged script. The complete Windows managed-launch file passes 35/35 (native-stage-c4a4960-native.json); daemon TypeScript checking and the documentation guard exit 0.

These inject file staging and terminal transport responses to control the await boundaries. They exercise the production Windows staging and context checks, but do not prove console delivery, physical script deletion, real psmux behavior or a provider launch. Those claims require their separate evidence; the Linux buffer tests are not relabeled as native coverage.

### Portable pollution-finder skill helper

The shipped systematic-debugging helper previously offered only a Bash/find/npm shell script. A standalone Node entry now runs on native Windows without Bash or cmd parsing, selecting ordinary files deterministically and forwarding each filename literally to the npm CLI through Node. Native backslash patterns are accepted. It preserves the three outcomes: all selected runs succeeded without pollution (0), a polluter was found (1), or no conclusion is available (2). Failed test execution cannot become a successful clean result. Existing pollution is preserved, and neither helper deletes or retries anything.

The spec skill is the editable source; canonical bytes and recorded edge digests were regenerated through mirror-skills. Root-cause guidance now names the Node entry, with the Bash companion retained. All eight native helper tests pass, including actual command-line dispatch with an owned npm entry, Unicode/metacharacter filenames and failed npm execution. Two real-canon generator tests pass and prove both manifest membership and served helper content. Mirror consistency and documentation checks exit 0. These fixtures use synthetic test commands; no project test campaign is launched by the helper tests.

The independently running CLI/TUI audit started at 112f969 before this addition. Work resumed during that run to avoid blocking a known implementation gap on a long test campaign. Its eventual before/after receipt must therefore be interpreted as a cross-revision diagnostic run, not acceptance of a single current HEAD.

### CLI/TUI diagnostic audit and native context/attach fixtures

That diagnostic run ended with 7,220 passes, 35 failures and 92 pending cases out of 7,347 (cli-tui-112f969-audit.json). Its receipt records sourceStable=false: tracked skill changes were present by completion. It supplies reproduction leads, not current-head acceptance. Remaining failures include symlink-creation EPERM, fixture/path expectations, a cleanup failure and cases still needing classification.

The complete context-work-install and attach-reply-address files reproduced 20 passes and nine failures on current sources. Seven context expectations used a short Windows temporary-home alias while product paths were canonical long names. Canonicalizing the owned fixture root with native realpath retains exact path comparisons. The two attach cases mocked the obsolete shell-string query rather than the current execFileSync argv call; their inert metadata fixture now intercepts and validates the actual argv entry. Production behavior was unchanged. Both files now pass all 29 cases (context-attach-8d8fdae-native.json), covering real Commander/HTTP/SQLite attach-address round trips and context selection/projection with owned files. CLI TypeScript checking and the documentation guard exit 0; no real seat was attached.

### Proof mission lookup across native path aliases

The catalogued absolute-slice proof case exposed a product gap: the catalog's canonical long missions root did not string-match the caller's short Windows temporary path, so the existing slice was reported as having no parent mission. Windows mission lookup now first compares both paths after native realpath resolution, then retains the existing lexical fallback. POSIX behavior is unchanged. The regression test also exercises a case alias and verifies that only the catalogued beta project receives the artifact; explicit workspace and uncatalogued-project refusals remain.

The initial complete proof run after the alias repair passed 42 and failed three (proof-path-8382b1e-native.json): file-symlink creation EPERM and two POSIX-mode assertions remain unwaived. Shared scope regression exposed a lost lexical fallback for a path containing '..'; restoring that existing fallback yields 67 passes and seven skips across both complete scope files (scope-proof-8382b1e-full.json). The combined selected scope/proof run passes 43 with 77 filtered/pending cases (scope-proof-8382b1e-fixed.json). CLI TypeScript and documentation checks pass. These use owned files and do not alter a live workspace or prove the remaining permission/link cases.

### Native Slack replacement refusal cleanup

Fresh reproduction of the MCP HTTP, ACL and preflight files passed 60 and failed two (mcp-acl-preflight-8f4dab7-current.json). All 17 MCP HTTP cases passed; its earlier full-run fetch failure is not reproduced here and its cause remains unknown. Preflight's remaining assertion expected Unix tmux guidance despite the native psmux instruction; the test now checks the platform's existing message.

The Slack ACL fixture still expected the obsolete fixed '.tmp' name. Checking the actual directory instead reproduced a product issue: a refused readonly replacement left a unique native staging file behind. Native state replacement now cleans the successfully written, invocation-specific staging path after rename succeeds or fails, while preserving the durable original and the original error. Injected filesystem behavior and POSIX fixed-path behavior are unchanged. The refusal test verifies owed events, generation and original DACL are unchanged, no staging file remains, and a later allowed replacement succeeds.

The complete ACL/preflight files pass 45/45 (acl-preflight-8f4dab7-native.json); both Slack store/native-filename regression files pass 11/11 (slack-state-8f4dab7-regression.json). CLI and daemon TypeScript checking and documentation checks exit 0. The native ACL tests use owned files and synthetic Slack records; no actual connector, account or paused group is contacted.

### Exact reconciliation of the latest CLI/TUI failure leads

At be077fd, all 35 assertions from the cross-revision CLI/TUI diagnostic have an explicit disposition (cli-tui-failure-reconciliation-be077fd.json). Thirteen have exact filename/full-test-name passes in later scoped reports, including the independent MCP reproduction. Nineteen remain unverified because file or directory symlink creation was refused by this host. Two proof assertions require POSIX mode semantics; native DACL tests are separate evidence and do not make those assertions pass. One ACP cleanup failure remains unresolved, with the earlier cleanup attempts exhausted. There are no unclassified assertions in this finite list.

This is assertion reconciliation across revisions, not a current whole-package green result, a waiver of the 22 remaining assertions, or a complete Windows feature assessment. In particular, the independent passing MCP run does not explain the earlier fetch failure, and permission-limited symlink coverage remains missing.

### Installed gate refresh and helper entry identity

The native installed tarball gate passes at exact source 5c9604f8d40d0f5d5002e5e182b0f03a9e0df669 (pack-gate-5c9604f-current.json), with unchanged tracked bytes before/after: real build, pack, isolated-prefix install, SQLite ABI and rig.cmd daemon-subpath load. Protected untracked diagnostics still make the package metadata dirty; no deployment or publication occurred.

A separate owned directory-junction reproduction then exposed a helper entry bug: direct invalid invocation returned 2, while the alias silently returned 0 without executing. The helper now compares native realpaths for direct-entry identity and stays inert when imported. All nine helper cases pass, including actual junction execution and inert import. Canonical skill bytes and digests were regenerated; mirror and documentation checks pass. The installed gate now additionally compares the delivered helper bytes to the authored source and verifies its usage exit status. That strengthened gate requires a fresh run after this change; the earlier passing gate does not prove it.

The strengthened gate subsequently passes at exact d34e489c871afca883518ca49d4d67b9fbc3f575 with unchanged tracked source (pack-gate-helper-entry-current.json). It includes the installed helper byte comparison and actual usage exit check, alongside tarball installation, ABI and rig.cmd load. This acceptance is scoped to that revision and gate, not later source changes or full feature readiness.

### Native successor blank-shell startup grace

Review of changes since the earlier finite source inventory exposed a behavior mismatch: POSIX successor verification retries one transient blank-shell observation, but the Windows branch immediately refused its first unready label or idle witness. Three new cases fail before repair (native-successor-d34e489-before.json): delayed label, delayed witness and transient witness error. The Windows branch now makes at most two observations separated by the existing poll interval. Every successful observation still requires both a recognized Windows shell label and a positive native idle witness; persistent uncertainty refuses without launching the harness.

The complete successor file passes 46/46 (native-successor-d34e489-native.json). Five focused cases additionally assert the exact one-or-two witness call bound and launch ordering (native-successor-d34e489-bounded.json; 41 filtered). Daemon TypeScript and documentation checks pass. Tests use SQLite plus injected terminal and witness observations; no deployed seat, real provider, cutover or fleet restore was performed. The installed gate above predates this successor change.

### Long native resource directory components

An owned native reproduction found a second resource-name gap: a 97-character qualified ID expanded to a 279-character percent-encoded component, and mkdir failed with EINVAL (resource-name-length-2d82e75-finding.json). A nested-directory prototype was withdrawn before commit because provider discovery through that layout was not established.

The final mapping preserves a single immediate-child directory. Existing percent encodings up to 255 characters stay unchanged. Longer encodings pack UTF-8 hex triplets into caseless CJK characters with an unambiguous percent-underscore marker and explicit padding count. Every POSIX-sized UTF-8 component of at most 255 bytes fits within 173 UTF-16 units, with its exact logical ID recovered on listing. Decoding accepts only canonical round trips; literal marker spellings still use ordinary percent escaping. No sidecar, source-byte change, ID truncation or nested skill layout is introduced. Identities beyond the native component capacity refuse explicitly.

The complete native resource file passes 14/14 (resource-compact-2d82e75-final.json): short/long skill projection, installed-ID recovery, conflict/edit preservation and replay for Claude, Codex, Pi and OMP; short/long Claude/Codex plugins; native file creation for all padding lengths, Unicode/case distinctions and a 255-byte ID. Daemon TypeScript checking passes. The expanded shared run passed 41 and failed two before correcting an overbroad new fixture expectation: arbitrary long plugins are not the shipped core plugin and must not inherit its automatic Git exclusion. The other failure remains host symlink-creation EPERM (resource-compact-2d82e75-regression.json). This proves owned filesystem and adapter behavior, not actual provider discovery or conversations. No deployment changed.

### Actual installed skill discovery for compact resource names

Two additional owned checks now establish discovery beyond OpenRig's adapter listing. The installed Pi 1.4.0 loadSkillsFromDir module discovers valid short, compact-long and compact-Unicode skills with zero diagnostics (pi-compact-resource-aeedb35-native.json). The module hash and resource-source hash are recorded; the child receives an isolated HOME and agent directory. No runner or extension is started.

Installed Codex 0.165.0 independently returns all three named skills from its native app-server skills/list response, including the expected actual SKILL.md paths (codex-compact-resource-aeedb35-native.json). Its initialization/schema come from that installed binary. The process runs in an owned Job with isolated HOME/CODEX_HOME and an owned Git project, receives only initialize/initialized/skills-list messages, then exits 0 on EOF. Its executable hash and resource-source hash are recorded, and the owned tree is removed afterward. No thread, provider request, login, deployment or existing seat is used.

These proofs apply to the observed installed versions and owned skill fixtures at aeedb355cf567a36ffdcdf4268c11dd2fcdd14ea. Actual Claude/OMP discovery and real model use remain separate unverified claims; the earlier adapter tests do not establish them.

Claude discovery was subsequently checked with installed Claude Code 2.1.304 at 0abb93871420444eb7d60ac9c10af7525db2cece (claude-compact-resource-0abb938-native.json). The owned Job receives only an initialize control request using the [official SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py). Its response lists the short, compact-long and compact-Unicode fixture skills; the process exits 0. HOME/config/project are isolated, hooks and external MCP configuration are disabled, and the only configured API endpoint is an owned rejecting loopback receiver with a synthetic key. That receiver observes zero requests; no user message is sent. The executable and resource-source hashes are recorded and the owned tree is removed.

Thus installed Claude, Codex and Pi discovery have separate positive evidence for these directory spellings; this does not prove model execution or every installed version. No OMP executable was found on the current PATH, so actual OMP discovery remains unverified rather than inferred from Pi's result. No existing runner, account, deployment or paused group was changed.
