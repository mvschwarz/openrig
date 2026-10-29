# Native Windows support experiment

Tracking: https://github.com/mvschwarz/openrig/issues/88

This branch implements native Windows headless Codex/Pi launch, message delivery,
process observation, snapshot/down/restore, and graceful daemon stop. It remains
an experimental fork; it is not an upstream Windows support announcement.
Use in a particular local deployment does not establish general native support.

## Native scenario subprocess fixtures, 2026-10-29

The repository script failure log exposed two scenario tests that could not
exercise their intended behavior on Windows: a Unix shebang-only fake Docker
client and a fixed `/bin/bash` path. The tests now use the explicitly selected
build shell and a real, temporary Windows executable forwarding literal argv,
stdin, stdout, stderr and exit status to an owned Node fixture. The executable
is compiled using the existing Windows .NET Framework compiler; no installation
or Docker daemon is involved. Background scenario subprocesses hide their
Windows console windows.

The native scenario and executable-fixture tests passed 8/8 with no skips.
They verify remote-server platform receipts and refusal before build as well
as the existing deadline and exact-ID settlement contracts. This does not prove
a real remote Docker run.

The image-build wrapper's integration fixture now also uses native executables
and the selected Git Bash, with explicit POSIX shell paths and a Windows PATH
for shell-free Node children. Its 13 tests passed on Windows, including repeated
success, nonzero load, deadline expiry, confirmed exact-ID removal and retained
cidfile refusal after uncertain removal. The fake client also checks that the
container health-check command survives the shell/native boundary. This is a
client-contract test with marker files, not an image build or container proof.

## Isolated native install and installed shim, 2026-10-29

The package-install checks now ask the same npm CLI for its global root under
the owned temporary prefix. The original POSIX-only `prefix/lib/node_modules`
assumption failed after npm had successfully installed on Windows. The corrected
fresh-prefix check passed with a complete better-sqlite3 directory, binding.gyp
and package.json; it uses --ignore-scripts and does not by itself prove the ABI.

The opt-in target-native gate was then explicitly enabled and passed separately.
It installs the tarball into another temporary prefix, runs the installed ABI
checker (including its child-process in-memory SQLite open/query), and invokes
the actual npm-generated rig.cmd from Windows PowerShell. CLI operands travel
through a fixture JSON file to avoid constructing command text from them. The
command loads the packaged daemon surface and writes the expected temporary
human fragment. Inherited OPENRIG/RIGGED variables are removed; HOME,
USERPROFILE, OPENRIG_HOME and cwd point only to the fixture. The binding is
synthetic local configuration, with no connector delivery or operator daemon.

Each of the two targeted checks passed one test, with no skips/cancellations.
Build identity is source 7f1a5d676 plus these verification edits, dirty=true;
this is fresh-prefix, single-host evidence, not clean-head/general installation
acceptance. One strengthened run first failed because its test omitted a Node
filesystem import; that failed receipt is retained and was fixed before the
passing shim/ABI run. Prefix/home/tarball fixtures were removed by teardown.
No operator prefix, actual runtime, fleet/seat, Stop or timer was changed.

## Windows Git reference projection, 2026-10-29

The six tracked static-pack symlinks now project correctly when Git checks them
out as regular placeholder files on Windows. The resolver requires index mode
120000 and verifies the placeholder's Git blob hash (SHA-1 or SHA-256). Modified
placeholders and unmerged index entries refuse rather than falling back to
ordinary content. Other path-looking files remain ordinary files. Native links
and attested placeholders must resolve to an actual file physically under
docs/reference; missing targets, directories and junction escapes refuse.
The same resolved file is used by scanning, manifest reading and projection.

The combined generator/resolver selection ran 26 tests: 25 passed, one failed,
none skipped/cancelled. The existing file-symlink fixture fails at creation with
EPERM on this host; it was not waived. New tests use Git's actual placeholder
checkout in both object formats, verify all six production outputs byte-for-byte,
check stale/unmerged metadata and escaping targets, and prove resolved content
is leak-scanned before replacing existing output. The previous production-library
and help-address tests also pass with actual document content.

An actual Git-for-Windows assembly, npm pack and extraction proof passed at base
2148202a6 plus these edits, stamped dirty=true. It now explicitly checks all six
extracted references are regular files with bytes identical to docs/reference,
alongside daemon surfaces, bins, versioned release guidance and absence of
unmapped daemon imports. The release-guidance assertion now accepts CRLF while
still rejecting wrong headings/versions. This supersedes the earlier placeholder
tarball failure. The temporary tarball/extraction was removed; derived assembly
remains local. Clean-head install, provider and deployment acceptance remain
unverified; no package was published or activated.

## Native npm subprocesses and package-root checks, 2026-10-29

Repository release/package scripts now share a native npm command builder:
Windows runs the current npm CLI with Node, without passing operands through
cmd.exe. POSIX invocation remains npm. It is used by artifact enumeration,
package content/license tests, testbed/TUI package paths and inherited-instance
isolation. Native receiver tests preserve quotes, shell metacharacters, empty
strings, Unicode, stderr and a nonzero child status. Artifact-enumeration errors
now expose an actual spawn error instead of only `exit null`.

The substance gate uses native relative-path containment for package roots.
Fifteen gate cases passed, including a real nested npm package and rejection of
a sibling root without replacing the existing receipt. With npm argument,
license/archive and actual inherited-instance cases, the related selection
passed 19 tests. The separate npm dry-run content check passed too. The license
fixture now supplies a native compiler stub on Windows; it still runs the actual
build staging, npm file selection and tarball byte checks for LICENSE/README.

Testbed package assembly now uses the existing explicit Git for Windows shell
selector instead of the ambient WSL bash. The native assembly and npm pack ran
at source `265d12380` plus these edits, stamped dirty=true; the tarball test
**failed** because its release-note content was a Git symlink placeholder
(`../../../../docs/reference/whats-new.md`) rather than the document. Six tracked
symlinks under context-packs-src need Windows-aware projection. This remains a
demonstrated packaging gap; compilation/assembly is not package acceptance.
The install and packed-TUI gates are not claimed passed. No publication,
installation into an operator prefix or runtime activation occurred.

## Guard execution and mirrored bytes correction, 2026-10-29

Earlier Windows docs/mirror “passed” reports relied on exit status from entry
checks that manually constructed `file://` URLs. Those checks did not match a
native Windows script path, so they could return zero without executing. Those
exit-only reports do not establish guard execution. The docs, leak and mirror
entry checks now compare native real paths; imports without argv remain inert.
Real child tests prove execution from spaced, hash/Unicode and junction paths,
including `--preserve-symlinks-main`. Seeded blocked docs/leak data and a missing
mirror manifest produce the expected nonzero result. The artifact scanner also
uses native relative-path containment instead of a POSIX separator prefix.

The actual mirror check then exposed CRLF digest differences and a stale
canonical upgrade helper. Git attributes now keep text in the three skill roots
at LF with automatic binary detection; a checkout fixture with autocrlf enabled
verifies text and binary bytes. Existing bytes were normalized only when their
LF hash matched the recorded digest; the remaining upgrade source was compared
with committed source before normalization. Windows authoring now uses native
filesystem synchronization, retaining whole-tree link refusal, source/output
separation, declared-output deletion and undeclared-home preservation. It needs
no rsync. The actual regeneration updated the one stale helper copy and hashes;
the real `mirror-skills --check` passes. Windows POSIX permission-bit semantics
and unrestricted file-symlink fixtures are still not accepted.

Seventeen leak/lineage script tests, six targeted mirror tests, two native
entry/checkout tests and three cross-surface lineage tests passed. The generator
normalizes CRLF only, while content edits still fail drift checks. Actual docs
and mirror checks plus 57 context-pack checks passed after these corrections.
These replace the earlier exit-only guard evidence, not the outstanding full
suite/provider/deployment work.

The subsequent repository-script sweep ran 341 tests: 259 passed, 79 failed,
three skipped, zero cancelled. The four additional cases cover native entry
execution, Git checkout bytes, native mirror transitions and EOL regeneration.
This remains a non-green script-suite result from the source working tree, not
full workspace/npm-test acceptance. The remaining 79 failures are retained for
diagnosis; the reduction from 96 was not achieved by skipping their assertions.

## Python CLI lookup, 2026-10-29

The historical composer and refocusing scripts now execute the full path from
`shutil.which("rig")`, and decode CLI stdout as UTF-8. A native Windows fixture
reproduced error 2 when only `rig.cmd` was on PATH but Python launched the bare
`rig` name. The same fixture succeeded with the resolved path. Both shipped
Python subprocess call sites use the correction; their fixed config/whoami
arguments are unchanged and no shell=True path was added.

An opt-in native Python test passed using the existing Python 3.13 installation:
a fixture shim in a path containing spaces, ampersand and Chinese characters
received exact config/whoami arguments, returned a Unicode root correctly, and
missing CLI/nonzero exit returned unavailable. This exercises synthetic CLI
responses, not a live topology configuration or managed refocus acceptance.
The Python interpreter remains a prerequisite for these historical entries.

The repository's inherited-instance isolation test now runs npm's CLI through
Node on Windows, rather than attempting native spawn of the `npm` shim name.
Both OPENRIG and RIGGED cases passed their actual daemon child selection and
confirmed unchanged outer audit, no outer database creation and no requests to
the fixture's outer server. This repairs test execution; it does not exercise an
operator's real daemon or alter deployment state.

The repository Node-script sweep at the uncommitted Python/isolation follow-up
ran 337 tests: 238 passed, 96 failed, three skipped, zero cancelled. This is not
full `npm test`: `test:repo` stopped on script failures before workspace suites
and the later chained check commands. Failures include native-incompatible
fixtures/prerequisites, link permissions, packaging assumptions and generated
lineage drift; they are not all diagnosed or waived. Targeted docs/mirror checks
and the explicit opt-in Python test passed separately. No whole-suite green
claim follows from the new targeted successes.

## Native subtree render and trunk diff, 2026-10-29

`compose-down.mjs` and `trunk-diff.mjs` provide native Node entries for subtree
rendering and baseline comparison. The historical shell entry delegates to Node.
Diffing uses native Git with external diff/text conversion disabled, rather than
Bash/Python/Unix diff. Baseline replacement happens only after a successful
render/diff; a per-state exclusive lock prevents concurrent writers, and linked
state files are refused. The renderer preserves template-only collapse, stale
UNSEEDED warnings, names/exclusions and generated-header removal, without
following file links or directory junctions. Failed diff or locked-state tests
verify that existing state survives and another writer's lock is retained.

Six scaffold/trace/trunk tests passed on Windows. A separate fixture matched the
old Python subtree renderer after stdout EOL normalization, including authored,
template-only, conflicted and excluded content. Python 3.13 was available through
the Windows launcher, while `python3` was absent from PATH. This is a fixture
comparison, not general Python/Node equivalence or Linux/macOS acceptance.
Historical `compose.py up/progress` and the public refocusing trace remain Python
entry points. A local trace ran via the existing launcher and reported unresolved
topology/work roots; it did not change operator configuration.

Default psmux bootstrap idle proof remains open. Its `-NoExit -Command` body
sources user profile code, which can still be executing builtins with only the
shell in the console. Command-line recognition plus a sole-member console census
does not prove that execution ended. Eighteen native lineage/console tests passed,
including explicit retained-command/profile refusal cases. The idle predicate
was not broadened to treat this bootstrap as a bare shell.

## Inactive-pane input routing, 2026-10-29

The psmux adapter now carries the immutable pane/window ID in its first target,
alongside the server's session name. Stock 3.4.0's send-keys client consumes a
later `-t` without forwarding it, so the old session-only first target sent Enter
to the active pane even though paste-buffer reached the intended inactive pane.
This also explains the apparent first-command failure after respawn. Waiting
for the prompt or command echo did not fix the old route. The correction does
not select a window, repeat Enter or relax occupant/input guards.

The relevant adapter/target selection passed 200 tests with two POSIX skips;
workspace build/typecheck passed. Native isolated stock 3.4.0 and candidate
probes delivered before and after respawn while the target window was inactive.
The stock probe verifies the active selection and decoy pane screen remain
unchanged. Namespace/pane processes and fixture files were removed, and the
default session list was unchanged. No operator runtime was replaced.

## Optional private environment protocol, 2026-10-29

OpenRig can select a versioned file protocol when a psmux backend advertises the
exact capability. The pinned v3.4.0 source candidate and isolated build guidance
are in [scripts/windows](../../scripts/windows/README.md). A protected current-SID
manifest replaces initial/respawn values in client and server argv. Successful
responses dispose it; uncertain execution retains it without a literal retry.
Capability observation failures stop the attempt. Stock 3.4.0 still uses its
existing experimental literal transport, with its argv visibility limitation.
No binary is installed or selected by this change.

The related five-suite selection passed 68 tests with five platform/opt-in skips;
workspace build/typecheck passed. A native isolated candidate exercised the
actual adapter with a manifest path containing spaces and verified exact values,
user config precedence, later panes, warm-server isolation, rejected malformed
input, direct respawn and file disposal. Its namespace and pane processes were
stopped, temporary files removed and default session list unchanged. This is
synthetic local evidence; stock-backend privacy remains open. The earlier
interactive respawn failure is addressed by the target-routing correction above.

## Current-occupant parsing after rebase, 2026-10-29

Windows Claude/Codex candidates now parse native argv and compare the executable
with the OS path witness. Pi uses the same native argv boundary for its known
PowerShell parent and Node runner, while retaining the registered pane, direct
parent, launch-id, start-time and sidecar/session-folder checks. A real owned
PowerShell/Node pair observed through CIM verifies that join; synthetic cases
also reject stale executable paths, repeated selections and unrelated programs.
These are process-boundary checks, not real provider-turn or fleet acceptance.

The rebase retains upstream API-key credential checks. Windows API-key files now
use a current-SID owner/ACL check on the opened read handle, shared by preflight
and launch. Launch rechecks privacy and size, reads at most 8193 bytes, accepts
only the existing printable ASCII key format, and updates only the child's
environment after clearing login/routing overrides. The selected file stays
locked against writes/replacement during that read. No credential file ACL is
rewritten. Broad ACLs and unavailable/malformed/oversized files refuse launch
without fallback. A static .NET helper keeps key bytes and strings out of
PowerShell variable tracing; the compiler receives only fixed source. An owned
PowerShell 7 child also exercised its .NET ACL path and tracing behavior.
These tests use synthetic credentials; real account/billing acceptance remains
unverified. Initial private session environment, warm-shell isolation and full
parity validation remain open.

## Native service-adapter follow-up, 2026-10-29

Windows production service operations now invoke Docker with argv arrays,
including compose file/project/profile names, log tail zero and volume policy.
POSIX command strings are retained for the existing transport and injected test
executors; authored checkpoint commands keep their own platform syntax.
Windows HTTP readiness uses Node fetch with manual redirects and an abort
deadline rather than curl shell quoting. Numeric TCP probes use Node sockets;
named TCP ports use the Windows services database (TCP names and aliases only),
with an explicit unknown-name diagnostic rather than an nc installation request.
This uses Node's HTTP/TLS behavior; proxy/custom-CA parity needs acceptance.

The native service and related replica/project suites passed 19 tests with four
existing platform skips. A real Node receiver proves the Windows argv boundary
with spaces, quotes and shell metacharacters, but is not a real Docker daemon.
An owned HTTP server proves status, no redirect follow, abort and TCP behavior.
No system services file was edited and no container was started for these tests.
Actual Docker Compose integration remains unverified.

## Earlier native console-membership follow-up, 2026-10-29

Windows idle-shell proof can query actual console members with AttachConsole /
GetConsoleProcessList from a separate current-user helper. The helper sends no
control event and restores its own standard handles after detaching. A known
bare interactive shell is idle only after two stable process/console samples
show no other receiving process; a child omitted from a process listing still
blocks the proof. A PowerShell script/encoded command is not assumed idle just
because it runs under a shell executable. Claude's returned-to-shell check now
considers Windows shell candidates but still requires this native proof.

Native console/lineage suites passed 18 tests; existing process-lineage/Claude
delivery suites passed 297 tests. Workspace lint/typecheck passed. An expanded
process-table selection had one Windows failure from its POSIX mkfifo fixture
and two skips; it is not reported green. Isolated psmux 3.4.0 acceptance observed
one console member and idle=true for an explicitly bare PowerShell, then two
members and idle=false after an owned Node receiver started. Its unique socket
namespace was stopped. Default psmux's -NoExit -Command bootstrap remains
unknown rather than being promoted to idle; its completion needs more evidence.
The same isolated probe also confirmed both /dev/null and Windows's null device
work for this psmux version's capture preflight, so that literal was not changed.

## Earlier native process-facts follow-up, 2026-10-29

Codex in-place restart no longer relies on `/proc` on Windows. A shared read-only
query observes a target's cwd, exact command-line words, kernel executable path
and only HOME/USERPROFILE/CODEX_HOME. It is restricted to the current Windows SID,
uses the existing bounded NT/PEB environment approach and returns unavailable
for exited/inaccessible/unsupported targets. Restart maps a missing HOME to the
target's USERPROFILE, never the daemon's. The thread resolver uses the same home
observation. ACP marker lookup consumes the shared module through a packaged
daemon surface rather than retaining a separate query implementation.

Windows ISO creation timestamps now enter the existing whole-second PID reuse
gate; they previously failed the POSIX `lstart` parser. A retired-PID log fixture
confirms old conversations are excluded. Staged launch-script recognition also
accepts native absolute paths using the same generated filename contract.

The latest five-suite process-facts/thread/restart selection passed 137 tests
with one existing skip. Workspace lint/typecheck passed. Native package assembly passed using
Git for Windows, including the new daemon-import rewrite; the candidate build
was stamped dirty because these source edits were not committed at build time.
The assembled CLI's ACP help and shared native marker-query module both ran.
This is not installed-package, live Codex restart or reboot acceptance.

## Earlier native Claude token follow-up, 2026-10-29

Windows classic and managed Claude launches now read a seat token file inside
the staged PowerShell command, directly into the child ProcessStartInfo
environment. The value is absent from command text and never assigned to the
pane's environment. A required unreadable/empty token stops before child start;
optional failure retains the existing warning and removal policy. Isolated
account selection clears inherited provider credentials, and managed launch
overrides cannot restore them through Windows case variants. Declared empty
environment values are retained. Missing optional tmux identity fields are
normalized from null before rendering.

The four Windows launch/token suites passed 25 tests, including real child
processes with synthetic credentials, stored-reference plumbing and unchanged
pane values. Workspace lint/typecheck passed. A broader seat-launch regression
selection passed 18 tests and failed seven POSIX Bash/symlink fixtures on this
host; those failures remain recorded. This is native plumbing validation, not
a real provider authentication, billing or conversation acceptance claim.

## Earlier native capability follow-up, 2026-10-29

Based on main `0fcb7040e1abb45061b134de2738f3e7f40af92c`, code revision
`a7f4823d33fdcfb2ce0bde613befe5c86a1e0e78` adds native listener PID queries,
Restart Manager database-file holder observations, shared CIM process identity,
ACP creation times and detached-run marker discovery, local file copying, and
live probe/scenario-client process-tree termination. Windows file operands retain
drive, UNC, casing-deny and trailing-separator semantics. Extra destination files
are retained; local dry-run moves nothing. Windows remote transfers now use the
native OpenSSH SFTP subsystem rather than requiring rsync on either endpoint.
The registered SSH target/user and existing path policy are retained. The client
uses binary SFTP v3 with request deadlines, bounded packet framing and literal
SSH argv. Recursive copies retain extra destination entries, preserve timestamps
and remote permission bits, support trailing-directory-separator semantics and
preview without writes. Changed files are written to exclusive sibling staging
files, then renamed; an existing remote target requires the OpenSSH atomic-rename
extension. Failed staging may remain and is reported rather than deleting the
old target. Remote names that cannot be represented on Windows are refused.
Owner/group/ACL mapping is not claimed. Link creation still requires native OS
permissions; the OpenSSH-compatible symlink wire order is used.

Windows Codex help, network-default and usage readers also resolve native
executables or the recognized `@openai/codex` npm entry instead of trying to
execute a `.cmd` file through native spawn. The selected Node executable receives
literal argument arrays; arbitrary batch wrappers are not interpreted. Relative
PATH entries resolve against the seat cwd. The native fixture exercises literal
arguments, help and usage RPC without a real provider. Together with existing
opt-out/auth tests, 38 tests passed; seven network-reader tests passed separately.
The existing parent-exited process-group cleanup case was excluded from that
selection at that revision because native orphan cleanup was unresolved. Initial regression
attempts exposed a POSIX-only fake PATH and unintentionally reached the installed
Codex in temporary homes; those results are not acceptance evidence. The fixture
now uses the native PATH delimiter and an isolated recognized npm layout.

The SFTP follow-up selection passed 64 tests with three existing rsync skips.
Actual Windows `sftp-server.exe` subprocesses exercised upload/download, Unicode
names, directories, overwrite, extra-file retention, skip and dry-run behavior.
Malformed framing and a silent subsystem are rejected with owned-child cleanup.
This does not validate a real SSH host, authentication, interactive prompts,
non-OpenSSH SFTP servers or privileged Windows symlink creation. Workspace
lint/typecheck passed; these changes have not been deployed.

The Claude background-reader follow-up recognizes Windows native executables and
the declared npm entry using the same provider-command resolver as Codex. Reader
environments remove case-variant seat variables, replace duplicate home/path keys,
and set USERPROFILE alongside HOME. Explicit token probes additionally isolate
APPDATA, LOCALAPPDATA and temporary paths. A live timed-out child tree uses native
taskkill; that revision still lacked containment after the root exited.
Native reader/Codex/cache regressions passed 43 tests. Three selected synthetic
token tests separately passed, including native homedir isolation and timeout.
The full token selection still has three failing POSIX uid/symlink/path fixtures
and one FIFO skip; the selected pass is not a full-suite pass. Native token ACL
validation and real Claude authentication remain unverified.

Windows history search now has a Node streaming fallback when both optional
rg/grep tools fail. It searches the same explicit transcript log files or located
session JSONL, keeps ANSI cleanup and whole-character excerpt truncation, and
reports file-read failures as unknown/unreadable. Four native/history regression
suites passed 18 tests, including actual Unicode/CRLF files and a read error.
This follow-up has not been packaged or deployed.

Background-probe containment now uses a native kill-on-close Windows Job Object.
The PowerShell/.NET helper supplies `PROC_THREAD_ATTRIBUTE_JOB_LIST` at process
creation, preventing the launch-to-assignment race. Only standard handles are
inherited; target argv and its explicit Unicode environment are reconstructed
without shell interpolation or payload files. Node/libuv's required Windows
environment additions are retained, and helper metadata is absent from the target.
An owning helper closes the job when the root exits, ending descendants even if
they closed stdio. Owner Node exit or helper termination also ends the job.
This applies to bounded runtime probes, Codex help/network/usage readers and Claude
background commands, never to persistent seat processes.

Six native/probe/reader regression suites passed 52 tests, including owner exit,
root exit with closed-stdio descendants, pipe holders, timeout, literal argv,
environment parity, shell builtins and survival of an unrelated process. All eight
network-reader tests now pass, including the previously excluded orphan case.
The installed Codex `--help` also returned supported through the Job path. Workspace
lint/typecheck passed. Windows PowerShell/.NET startup adds measured helper cost
(roughly 0.4 seconds on this host); an enforced policy that denies compilation or
Job creation fails the probe. Windows 10+ and nested Job support are required;
x86/ARM64 and real provider turns remain unverified. This is not a recovery
mechanism for arbitrary trees launched outside the helper, and does not establish
the cause of previous daemon exits. See [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Native session-environment updates now source a private config instead of passing
the value in `set-environment` argv. A current-SID protected directory is created
and its owner/DACL checked before any private value is written. psmux's explicit
time-format modifier reconstructs LF after physical config-line parsing; escaped
hashes prevent the supplied value from executing format expressions. Quotes,
backslashes, CR/LF, tabs, Unicode, percent sequences and empty values were checked
against real psmux 3.4.0 in a unique namespace with two sessions. Only the selected
session changed. A failed/uncertain source call retains its protected file; a
protected-file failure never falls back to value-bearing argv. Successful calls
remove their file and directory; cleanup failures report the retained path.
Three focused suites passed five tests, including inherited file-DACL inspection.
An expanded POSIX credential selection still has four scoped-shell fixture failures
and three native-tmux skips on this Windows host. This update does not yet replace
initial `new-session -e` or `respawn-pane -e` transport, preserve every startup/warm
configuration path, or establish a general Windows credential-ACL audit. It has
not been deployed.

The generic executable-path and argv readers now delegate Windows requests to
the same current-SID native process-facts helper, instead of always returning no
witness. A batch of at most 128 distinct valid PIDs uses one helper invocation;
exited/inaccessible targets remain unknown, and only the three established home
selectors can leave that helper. This supplies the Windows path fallback used by
Claude restore as well as the generic argv API. Native child fixtures verify
exact parameters, kernel executable identity, duplicate/invalid PID filtering,
exited targets and absence of an unrelated environment sentinel.

Discovery recognizes `codex.exe` and native backslash paths. An unavailable cmux
is queried once per scan, with fresh queries on subsequent scan refresh; this
does not produce a positive cmux identity. Six process/discovery suites passed
68 tests with three existing platform skips, and workspace lint/typecheck passed.
These checks do not prove complete Windows restore or every native process
architecture. Two initial private-config startup experiments with a custom
default-command failed to start their owned receiver. A subsequent bare-session
fixture, launching its receiver through the existing native launch adapter,
verified exact metadata and inheritance into the first shell's child. This case
is now a repository test: the three focused native environment suites pass six
tests. All owned namespaces and receiver processes were stopped and temporary
files removed. This proves a startup primitive, not a production initial-launch
replacement: TmuxAdapter still passes new-session/respawn assignments in argv.

A separate native comparison established that existing `new-session -e` values
are overwritten by a user-config assignment. A private wrapper must therefore
apply its assignments before sourcing the selected user config to match that
baseline, rather than silently changing precedence. Warm-server adoption,
reserved routing variables, config metadata and private-file lifetimes still
need verification before integrating the initial path.

Workspace lint/typecheck passed. The latest related selection passed 64 tests
with three existing rsync integration skips; the scenario deadline selection
passed three tests. Earlier native holder/listener/process-table selections are
recorded separately and are not full-suite proof. The native detached ACP test
finds a marked child after its launcher exits and excludes an unrelated run.
The query returns PIDs only and uses read-only process memory access for the
current Windows account without debug privilege. Its NT/PEB layouts are internal
OS details, following the approach in Microsoft's Azure Pipelines
`WindowsEnvVarHelper`; inaccessible or unsupported target layouts yield no witness.
Only the x64 host path has been exercised here.

Full `npm test` failed in the repository-script stage, before workspace tests.
It exposed a real scenario timeout hang from POSIX group signalling on Windows;
that owned fixture was manually ended, and the deadline path was then fixed and
retested. The failed run also includes Bash/npm-shim fixtures, symlink permission
assumptions, Windows-invalid filenames and generated-lineage drift. It is not
reported green. General cleanup of processes launched without native containment,
real remote SSH authentication acceptance, live provider token acceptance, every-provider hooks,
desktop/reboot and Linux/macOS acceptance remain incomplete. The database holder
test uses mocked HTTP confirmation, not a real competing-daemon acceptance test.
Known-home holder records are checked; an unknown holder home stays unknown.
The actual local deployment has not adopted these follow-up commits.

## Historical main rebase, 2026-10-27

Rebased all 28 experiment commits onto upstream main
`a6f61d9a0a8c8425ea13f7861d4dce56eb77ff87`; the previous public head was
`21d7e283a2b2a5593b7fc2ac3df57852a4e8cdeb`, with actual merge base
`4222e608049085faba14a473d73d1973d24a7860`. The code revision tested after
rebase is `1578412932533b30446b41c49fbad690c6d75621`; this entry is a
documentation-only follow-up.

On native Windows, workspace build and lint passed. The focused Windows, Pi,
queue-recovery, launch and CLI selection passed 702 tests with 15 skips. With
psmux 3.4.0, the actual multiline submission and exact argv/environment checks
also passed (three tests including the transport regression). These results do
not establish Linux/macOS, installed-package or every-provider acceptance.

Full `npm test` is not green: a bounded run did not finish within ten minutes;
an unbuffered diagnostic run exposed repository-fixture failures involving
Windows shell, symlink and executable-path assumptions. No assertions were
weakened or checks reported as passing because the focused selection passed.
Deployment-specific Pi and queue recovery overlays remain outside the public PR.

The final refresh also includes upstream main
`9110ab9dc911773d514b050c4bd63b0ae8209b31` (the attach pane separator fix).
Build and lint passed again. The two attach suites passed 13 tests with one
platform skip after registering their own ephemeral loopback fixture origins
with the existing fetch guard. Windows can allocate ports below the guard's
assumed ephemeral range; no production target or blanket network exemption was
added. The earlier full-suite failures and acceptance limits still apply.

## Historical main rebase, 2026-10-26

Rebased onto main c241fbb45fe248191dc34b40d31ea0a26de29f58.
Windows launch paths retain upstream runtime-home selection, launch identity and
wake-recovery shutdown ordering. The shutdown consumer fixture now supplies the
new wake-recovery assembly dependency; it does not exercise wake scheduling.

Native Windows workspace build and lint passed. The focused daemon selection
passed 312 tests, with 13 platform-skipped tests. UI: 1753 passed, five failed,
one skipped (Windows executable-path, CRLF and locale assumptions). Full npm test
is not green; repository fixtures hit Windows shell/path/permission limitations.
These checks do not establish Linux/macOS, installed-package or full native
provider acceptance. The new upstream per-seat Claude token launch step remains
POSIX-specific and is not exercised by this Windows experiment. Local fleet policy
and recovery overlays are separate from this public branch.

The upstream empty-server `start-server; source-file` environment transport does
not create a session on psmux 3.4.0. The native branch retains direct literal argv
transport; environment values retain the experiment's command-line visibility,
so the POSIX private-file environment protection is not claimed for psmux.
A transport regression plus both real psmux multiline/argv tests passed (3 tests).

## Historical main audit, 2026-10-21

The experiment is rebased onto main `3657af0b59e82d6b3fb1c136eb7da28ac8ed6ad0`.
The previously reproduced Windows `ProcessCensus` failure (`spawn ps ENOENT`)
is repaired: resume metadata uses the strict CIM reader, while best-effort native
identity observation retains its existing failure behavior. A failed enumeration
rejects rather than caching an empty successful table, and a later call retries.

Pi children retain `APPDATA` so tools can locate their existing Windows config;
this does not export GitHub token variables. Process termination uses `taskkill`
for native psmux, preserving failure results and the existing TERM/KILL sequence.
The test environment also isolates Windows profile/config directories.

Windows workspace build and typecheck passed. The focused daemon selection passed
526 tests; a separate 156-test selection covered the tmux adapter, Pi environment,
census and failure recovery. Actual psmux multiline/argv tests and an owned-process
termination test passed. The latter verifies that a sibling remains alive. These
fixtures exercise OS plumbing without provider calls; the stub scenario runner
cannot exercise Pi's child environment or Windows CIM enumeration.

Full native tests are not green: the UI run has five failures involving a POSIX
tsx path, CRLF matching and locale assumptions. The repository/workspace runs were
stopped after the repository suite remained in a POSIX signal fixture; their
partial failures are not a completed-suite result. Linux and hosted validation
results belong to the exact source head recorded in the PR.

The 2026-10-20 census gap below is historical and superseded by this repair.
Physical reboot/suspend, live all-runtime acceptance and general Windows support
remain separate requirements.

## Current-main rebase and readiness, 2026-10-20

Rebased the 20 experiment commits onto main
`b57fa8c5d3f52e886e69fb3d1a5ebaa3606970fc`. Conflict resolution keeps main's shared
Linux `/proc` reader, Claude script-launch observation, Codex resumed-process
evidence and explicit tmux environment-inheritance fixtures. The native CIM
branch, launch-only composer repair and session-scoped psmux kill coverage remain.
The candidate helper introduced by main also receives the selected Windows
executable, retaining the native exact-executable comparison.

Current local validation:

- Windows full workspace build and lint/typecheck passed.
- Expanded Windows daemon selection: **663 passed, 9 failed, 23 skipped** across
  27 files. Actual psmux multiline/argv transport, CIM observation and graceful
  drain fixtures passed. The nine failures are in `process-table.test.ts`
  (missing `mkfifo`/`ps`) and `seat-launch-environment-regression.test.ts`
  (POSIX `/bin/bash`, shebang and colon-separated PATH assumptions). They remain
  reported failures; no assertions or platform skips were added to hide them.
- Windows CLI lifecycle selection: **109 passed**. TUI pipes/reading/live-event
  selection: **65 passed, 12 skipped**.
- A separate Linux-local WSL2 source tree built all workspaces and passed
  **592 tests, 1 skipped** in 18 affected files, including the two files above,
  real tmux draft-aware delivery, process-table reads and Codex resume proof.

There is also a concrete production readiness gap, distinct from fixture
portability: invoking the built `defaultListProcessesStrict()` from
`resume-metadata-refresher` on native Windows fails with `ENOENT` / `spawn ps`.
The native identity reader uses CIM, but the shared resume-metadata census still
uses the POSIX reader. Until that path and fresh end-to-end native recovery are
verified, this branch is an isolated experiment rather than a replacement for a
production coordination service.

These results do not refresh the old live-provider acceptance below. Current
Claude/Codex/Pi conversations and hooks, kernel/operator, desktop interaction and
physical reboot/suspend remain unverified. Hosted CI results apply only to the
exact head displayed by the PR; WSL2 remains the supported Windows route.

## Design

1. Use psmux as a distinct backend. Its per-session servers reuse local pane
   IDs, so OpenRig preserves session scope in an opaque pane reference. Buffer
   operations share that scope. Termination checks the session ID on the selected
   connection and kills that server itself, without resolving a session name again.
2. Render generated literal argv into a staged PowerShell command. Refuse unknown
   shells and shell expansions. Expose the paired CLI through PowerShell, cmd and
   Git Bash entries. Resolve a standard npm Pi shim through Node, without cmd eval.
3. ConPTY drops VT paste framing. Node's Pi runner receives bracketed paste via
   native console input; native Codex receives character events and Shift+Return
   for newlines. A launch-only repair removes a recognised otherwise-empty OSC
   colour-response draft. It never clears additional user text or old history.
4. Read Windows process identity and birth times through CIM. Require unique
   executable ancestry, creation ordering, a runtime foreground label and stable
   samples; do not invent Unix foreground process groups. Accept validated drive
   and UNC Pi session paths only on Windows; reject traversal and device/ADS paths.
5. Windows SIGTERM force-terminates Node. An instance-specific named pipe and
   private capability instead request the existing bounded shutdown drain. Check
   current daemon PID/start identity and the resulting receipt. Refuse unavailable
   channels without force termination. Remove only the closing instance's capability.

## Local evidence, 2026-10-08

Windows, Node 24.14.1, psmux 3.3.8, Codex 0.153.4 and Pi 0.87.1:

- Both managed native seats reached ready and replied to unique markers.
- Actual native conversation files preserved a two-line message containing
  Chinese characters, an apostrophe and a semicolon. Both replied with the marker.
- Snapshot/down stopped exactly the two intended sessions. A sibling session
  remained present. Restore reported both nodes resumed; both recalled the prior
  marker without receiving its value again.
- Graceful daemon stop produced a clean/complete receipt. Restart retained the
  running seats and bindings. A production startServer fixture also persisted
  its recorder data and clean receipt through the Windows control channel.
- Native terminal tests verify exact argv, Unicode, empty arguments, a trailing
  backslash, multiline runner submission and sibling-safe termination. CIM tests
  exercise the actual Windows reader as well as ambiguity and recycled-parent refusal.
- Workspace build, typechecking and native Git Bash package assembly passed.

The first isolated-profile harness failed because ConPTY did not start with a
redirected USERPROFILE. Keep the real OS profile and isolate product/provider
homes instead. A copied Pi OAuth refresh token was stale after another instance
rotated it; use independently established sign-ins for persistent installations.

Acceptance boundaries: no physical reboot/suspend or GUI terminal acceptance;
no kernel/operator or other runtime acceptance; no upstream merge/review claim.
psmux 3.3.8 does not expose tmux server clipboard options, so that capability is
reported unavailable. Git for Windows is required for Pi bash tools and packaging.
WSL is not used by the native runtime or native build path.

## Parity work on the v0.6.7 base, 2026-10-09

The earlier live Codex/Pi acceptance above belongs to the prior experimental
build. Merging v0.6.7 does not carry that acceptance forward automatically.

| Surface | Implemented and checked | Remaining acceptance |
| --- | --- | --- |
| Browser opening | Literal Windows PowerShell URL launch; browser-launch and CLI UI tests | Actual interactive browser opening |
| Daemon logs | Bounded last-ten-line reads; follow, truncation and split UTF-8 writes | Operator interruption in a real console |
| Desktop views | Windows Terminal tabs and split-grid commands from the guarded view plan | Visible layout, focus and return navigation |
| TUI control | Native named pipes; commands, live collision refusal, independent fallback and killed-owner recovery | Windows pipe access-control assessment |
| TUI reading | Served drive/UNC paths, mixed separators and remote POSIX roots; actual files routes and UI state | File-symlink cases when the account has that OS permission |
| Claude launch | Native executable selection, bound managed environment/argv and classic fresh/resume/fork command transport | Full native conversation, hooks, kernel/operator and same-conversation recovery |
| OMP launch | Resolve native `.exe` before applying the isolated seat HOME; retain mise selection | Actual isolated-seat RPC, provider reply and recovery |
| Workflow context | Native manifest selection and context-pack file resolution | Complete workflow and hook coverage |
| Proof judgments | Exclusive immutable publication, corrections, concurrent writers and killed-process recovery | Power-loss durability; Windows flushes the writable receipt rather than a POSIX directory handle |

The local whole-daemon run at the start of this repair pass reported 12,630
passing, 1,109 failing and 181 skipped tests. The corresponding TUI run reported
861 passing, 43 failing and one skipped test. Subsequent focused runs verified
the repaired paths; they do not establish a green whole suite. Failures include
POSIX-specific fixtures, mode/symlink assumptions and actual native path failures.
Retain and investigate those groups rather than disabling the whole suite.

The parity goal remains open: complete native lifecycle and startup integration,
CLI/TUI actions and hooks, workflow/context/resource coverage, fresh live acceptance
for all supported runtimes, interactive desktop checks, and physical reboot/suspend.
The targeted Windows workflow and Linux/macOS regression jobs are separate from
those operator/provider acceptance requirements.

## Reproduce

### Rebase to current main, 2026-10-15

The experiment has been rebased onto main `2cfc5fa017cf73bf4261d7b4c4e64c34b080757c`
(0.6.10). Build changes already integrated through #1033 were removed from the
experiment's delta. Conflict resolution retains main's OMP protocol-v2 and charge
tracking, Codex launcher-chain handling, tmux-server selection and Claude resume
rotation. It also carries the new command-scoped resume marker into the Windows
child environment without exporting it to the pane shell. Delivery and exact
identity checks now use Windows argv parsing for Windows process rows.

On this rebased tree, the targeted daemon pass has 388 passing tests; CLI has 109
passing tests; TUI has 62 passing and 12 explicitly skipped tests. Windows workspace
build and typecheck pass. Extra Windows checks of main's POSIX-only fixtures still
fail: the OMP runner-entry fixture creates a `/bin/sh` executable and a colon-separated
PATH, and a tmux socket test assumes Unix `/tmp` identity. These are separate from
the passing native suite; no green full native suite or live all-runtime acceptance
is claimed. POSIX regression and native package assembly are recorded in the PR
when their runs finish.

### Native argv follow-up, 2026-10-15

A fresh psmux 3.3.8 run exposed an empty-argument regression in the v0.6.7
parity branch: PowerShell's `& executable @args` dropped `""` at the native
program boundary. Literal launch rendering now uses `ProcessStartInfo` with
the existing Windows argv encoder, preserving console handles and waiting for
the child exit code. This also affects classic Claude fresh/resume/fork launch
transport; those commands are checked with a real native Node receiver rather
than a PowerShell function standing in for a native executable.

The real psmux regression now preserves empty words, embedded double quotes,
spaces, apostrophes, Chinese text, metacharacters and trailing backslashes.
It also verifies that stopping the target retains its sibling session. All
331 tests in the targeted 15-file daemon pass, including actual CIM observation,
multiline runner input and the production graceful-stop receipt. The first
production-drain check timed out waiting for its fixture; diagnostics were added,
and subsequent built-tree runs passed. No production timeout was widened.

These are targeted local checks on the experimental v0.6.7 branch. They do not
refresh the earlier live Codex/Pi conversation acceptance, establish current-main
compatibility, or complete the full-suite, GUI, kernel/operator or reboot/suspend
requirements above. WSL's retained 0.6.6 installation reported an absent daemon
PID on this date; its earlier ready status is historical.

Install Node 22/24, Git for Windows, PowerShell and psmux 3.3.8. Put the portable
psmux directory on PATH ahead of unrelated tmux installations. Keep USERPROFILE
unchanged. Use a separate OPENRIG_HOME and explicitly selected CODEX_HOME; establish
provider sign-ins there. Configure Codex's supported Windows sandbox for that home
before using OpenRig's normal workspace-write floor. The local test used
`[windows] sandbox = 'unelevated'`; it did not disable the workspace sandbox.

```powershell
npm ci
npm run build
npm run lint
npm run build:package
$env:OPENRIG_TEST_PSMUX = 'C:\path\to\psmux\tmux.exe'
npm exec --workspace @openrig/daemon -- vitest run test/windows-terminal-native.test.ts test/windows-launch.test.ts test/windows-pi-command.test.ts test/windows-process-lineage.test.ts test/windows-daemon-control.test.ts test/resume-token-validation.test.ts
```

The native terminal tests create and remove only their uniquely named fixtures.
The Windows workflow verifies the pinned psmux archive digest and runs provider-free
terminal, identity, drain, lifecycle and package checks. Live provider responses
remain separate local evidence; a green CI job does not establish account access.

```powershell
rig daemon start --no-kernel
rig up path\to\rig.yaml --plan
rig up path\to\rig.yaml --json
rig ps --nodes --rig my-rig --json
rig send seat@my-rig 'unique test marker' --raw --json
rig down my-rig --snapshot --json
rig restore SNAPSHOT_ID --rig RIG_ID
rig restore status ATTEMPT_ID --rig RIG_ID --json
rig daemon stop
```

Keep authentication, session environments, staged launch scripts and raw launch
argv out of public diagnostics. Runtime state stays outside the source checkout.

Prior WSL evidence (a separate deployment, not native acceptance):
https://github.com/mvschwarz/openrig/issues/88#issuecomment-6043925546

### Native inspection follow-up, 2026-10-29

The setup/doctor capture probe now selects `NUL` on Windows instead of
`/dev/null`. A real pinned psmux 3.4.0 fixture created a unique namespace,
captured its pane, stopped that namespace and confirmed it no longer listed
sessions. The focused suite passed four tests with one POSIX-only skip.
Upgrade inspection also executes Windows npm command shims; its native fixture
preserves probe arguments, Unicode output and a failing command's exit status.
History search now reports a directory-listing failure rather than treating it
as an empty transcript set; the four history suites passed 19 tests.
Workspace lint/typecheck passed after these changes. These checks do not establish
full-suite acceptance or activation of this revision in the existing deployment.

The initial private-config environment experiment remains incomplete. In a
verified warm-standby claim with psmux 3.4.0, session/global metadata no longer
contained the synthetic value, but a child of the already-running adopted shell
still inherited it. Explicitly respawning that fixture's shell removed the value.
This is a counterexample to using cleared metadata as isolation proof, not a
production recovery mechanism: automatically respawning an arbitrary live pane
would be unsafe. Initial `new-session -e` and `respawn-pane -e` values still use
argv in production. The separate dynamic-update fixture passed only the tested
ordering where standby creation preceded the update; later standby replacement
and every timing are not proven isolated.
