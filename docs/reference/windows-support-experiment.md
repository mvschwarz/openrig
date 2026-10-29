# Native Windows support experiment

## Runner readiness from native identity (2026-10-29)

An owned PowerShell/offline-Node reproduction failed for both Pi and stub:
after the runner exited, the PowerShell parent stayed alive and its untouched
sidecar still said ready. The adapters' POSIX shell-word guard returned ready.
Adding PowerShell to that word set would also reject a healthy hosted runner.

Windows readiness now requires exactly one observed managed direct Node child
of the bound PowerShell/pwsh pane. The OS executable path and command-line
executable, selected runner entry, session, state root where applicable, cwd,
launch id, creation-time ordering and runtime selector must match. Duplicate
identity flags, competing/nested runners, changed panes or missing observations
stay unready/unknown. Runner-authored exit records still refuse readiness.
POSIX retains its existing shell/sidecar behavior; hermetic POSIX fixtures now
name their observation platform explicitly rather than impersonating Windows.

Pi, OMP and stub share the existing production process census with model
readers. The strict census now retains Windows platform/executable-path metadata
instead of dropping it while mapping generic fields. Eight concurrent witness
reads are tested to coalesce into one enumeration. Its existing successful
snapshot reuse window is two seconds: readiness is an observation, not an
instantaneous exit guarantee. The native fixture uses that actual census and
verifies that stale readiness does not survive its window.

Final focused verification passed 86/86, including real owned PowerShell/Node
processes for Pi, OMP and stub, healthy-positive and stale-sidecar-negative
controls, wrong identity/ambiguity negatives and census metadata/coalescing.
Expanded verification reports 187 tests: 184 passed, one failed and two pending.
The failure is a Linux `/proc` FIFO fixture invoking unavailable `mkfifo` on this
Windows host; it remains recorded, not waived. Full typecheck passed. The stub
sidecar fixture also uses the host's public protocol path helper instead of a
hardcoded POSIX separator. These are offline process/adapter and observation
tests, not a real provider conversation, installed psmux startup/restore or
fleet activation proof. No existing seat, console or daemon was changed.

## Shared native file boundaries, compaction and shadow (2026-10-29)

The daemon UID baseline selected `compaction-preparation` and
`occupant-shadow-integration` explicitly: 100 tests, 93 passed and seven failed.
It confirmed that an existing owned, equivalent `.gitignore` fell back because
Windows has no POSIX UID, and a private shadow sink could not create its file.
These were not all the same defect: the baseline also contained file-symlink
EPERM and POSIX-only fixture assumptions.

The existing native file bridge now lives in daemon domain modules with a
declared `windows-owned-files` export; CLI modules use thin re-exports. The
compaction ignore reuse path checks the current user's owner SID, final reparse
status and exact bounded bytes on the same reading handle. It does not rewrite
an existing ignore file or loosen the fallback/explicit-root rules.

Shadow remains source-only and disabled by default. Its Windows sink requires
a canonical, current-user-owned parent whose allow rules grant access only to
that user. It asynchronously prepares a private output handle with exclusive
publication, retaining the existing finite budgets, stop/drain behavior and
non-overwrite rule. Preparing the sink does not synchronously run PowerShell on
the send path. POSIX keeps its existing UID/mode parent check.

The revised two-file daemon run reports 102 tests: 100 passed and two failed.
Both remaining failures occur while creating file symlinks (EPERM), before
product code, and remain unwaived. Added directory-junction cases prove refusal
and target preservation for that native reparse shape only. Real DACL-denied
child creation replaces ineffective Windows chmod fixtures; the test restores
only the DACL, not an audit policy requiring SeSecurityPrivilege. A former
`/dev/null` fixture now uses an owned file-as-parent blocker on both platforms.
The CLI seven-file regression still exits successfully with 78 passed and one
POSIX FIFO skip. Full typecheck passed.

An isolated staging probe used the actual compiled CLI/daemon modules and the
official import rewriter, then verified the five required JS paths in the CLI
npm dry-run and performed native file readback through rewritten imports.
The daemon workspace is private and is not its own published npm package; its
standalone dry-run omitting dist is not a CLI packaging failure. The probe is
not a full installed-package or live Claude compaction/terminal capture proof.
These OS-file boundary cases use synthetic observations and mocked transport;
a stub-agent scenario cannot establish native ACL or reparse semantics. No
running daemon was restarted and no live capture was enabled.

## Owned experimental configuration and incremental output (2026-10-29)

The `b6c2c7570` full CLI failures identified a real Windows configuration
blocker: `setExperiment` compared a synthetic file UID with unavailable
`process.getuid()`. Simply dropping that check would lose the ownership
boundary, and Node's unavailable `O_NOFOLLOW` would still follow final links.

Windows now opens the selected file with `FILE_FLAG_OPEN_REPARSE_POINT` and
checks ordinary-disk-file type, reparse attributes and (before configuration
truncation) one link and the current user's owner SID on that same handle.
New configurations get an owner-only DACL; existing files retain their ACL.
Reads remain byte-bounded, and missing configuration retains the disabled
default. Configuration/output content never travels in argv or environment.

Incremental experimental output now obtains a private descriptor through a
protected sibling staging directory, an explicitly private staging file and
an exclusive hard-link publication. This keeps incremental completed records
and refuses every existing destination; it does not buffer the whole run or
replace earlier results. Owned staging names are removed before returning.

The native bridge compiles once per CLI process into a current-SID-only
temporary directory and releases its exact executable/directory on normal
exit. The initial per-operation PowerShell compilation passed all assertions
but caused an unhandled Vitest communication timeout, so that failing run is
not a pass receipt. The revised seven-file batch exited successfully with
79 tests: 78 passed and one POSIX FIFO test skipped. It includes a complementary
owned Windows named-pipe rejection, bounded UTF-8 reads, hard-link/junction
refusal, private incremental output, one-compilation/exit-cleanup proof, Jev
disable/cancel/limits, worker entry and MCP regressions. CLI typecheck passed.
These use synthetic input/credentials and owned OS objects, not a live provider
or fleet. No foreign account's files were modified for this proof; other UID
and private-file consumers remain separate review work. A stub-agent scenario
cannot establish native handle ownership, DACL or reparse behavior.

## Native MCP file privacy (2026-10-29)

The complete CLI run at unchanged `b6c2c7570b6a12abc79783c0213c550c04f0e07a`
reports 5953 tests: 5310 passed, 586 failed and 57 pending. It still fails overall.
Its remaining MCP mode assertions exposed a production gap: `mode: 0600` does
not establish a private Windows DACL for grant and presence files.

MCP grant and presence publication now creates a fresh UUID staging file with
a protected current-user-SID DACL before writing content. The same open handle
verifies its owner and sole explicit FullControl allow rule before writing;
content is sent through child stdin, never command arguments or environment.
An existing staging path, including a hard link, is refused. Atomic rename
retains the DACL. POSIX staging retains exclusive creation and mode `0600`.
Authentication, grant scope and presence throttling keep their existing rules.

Five native test files passed 39/39, covering exact UTF-8 bytes, private DACL
after rename, existing/hard-linked path refusal, MCP protocol negotiation,
grant-service scope, token add/revoke and presence behavior. A separate owned
native probe confirmed the DACL before adoption; its initial Write-only handle
could not read the ACL, so the final handle explicitly includes ReadPermissions.
Tests inspect Windows ACLs instead of accepting synthetic POSIX mode bits.
CLI TypeScript checking passed. This is an OS-file/HTTP boundary proof using
synthetic credentials and owned listeners, not a stub-agent or installed fleet
test. Existing external files are not migrated, and other private-file writers
and POSIX-UID checks still require their own native review.

## Git context checkout aliases (2026-10-29)

The full CLI failure receipt led to an owned local Git reproduction: Node's
portable `realpathSync()` retained the temporary directory's `DAJIAO~1` DOS
alias, while Git for Windows returned its long path. Both names opened the same
checkout, but the strict root comparison rejected it as a subdirectory.
Windows now uses `realpathSync.native()` consistently for checkout-root and pack
containment resolution; POSIX uses the existing resolver.

Both Git context suites passed 20/20 on native Windows after this change,
including shallow SHA-1/SHA-256 retrieval, upstream branch inference, updates,
preserved local changes and merge conflicts, real subdirectory rejection and
directory-junction escape rejection. Fixture assertions compare the selected
checkout's exact bytes, retaining Git's CRLF conversion rather than rewriting
production output. CLI TypeScript checking and diff whitespace checking passed.
These owned local repositories do not establish authenticated remote transport
or installed-provider acceptance.

## Additional owned CLI fixtures (2026-10-29)

The remaining explicit fetch-guard failures in the full `8ad49dd2b` CLI receipt
were traced to OS-assigned low ports. Twenty-seven affected test files now
register their own already-bound HTTP servers or URLs returned by their owned
UsageHost/MCP fixtures; the fetch guard and its canonical-daemon refusal remain
unchanged. The multi-process host-binding fixture also converts its `file:` URL
to a filesystem cwd, and the watch-document assertion normalizes CRLF.

The 29-file verification batch (including host bindings and the fetch guard)
ran with unchanged source: 391 total, 389 passed and 2 failed. The two remaining
failures are MCP presence/token-file POSIX `0600` assertions on Windows, whose
mode bits read `0666`; they are retained as a native permission gap, not skipped
or treated as an ACL proof. The earlier run of this batch had 30 failures before
registering the separate owned MCP listeners and normalizing the document text.
This receipt is not a new complete CLI run or an installed MCP acceptance claim.

## Native listener lookup deadline (2026-10-29)

The complete CLI run at `8ad49dd2bc5e2d1ea35a26a00713c0a9db96ac04`
kept its source stable: 5950 tests, 5001 passed, 892 failed and 57 pending.
This is a failing full-workspace receipt, not native acceptance. An isolated
reproduction confirmed that an owned TCP listener was reported as unknown after
the existing 10-second `Get-NetTCPConnection` deadline; even a filtered CIM query
took 22.7 seconds on this host.

Windows listener lookup now reads `System32/netstat.exe -ano` directly. Parsing
selects exact TCP listening ports, deduplicates IPv4/IPv6 rows for one PID, and
keeps absent, malformed or multiple-owner results unknown. The existing destroy
flow still checks for an OpenRig HTTP listener before consulting this PID lookup.
No running daemon was destroyed or restarted by this verification.

The owned native listener regression and destroy command tests passed 18/18;
the listener lifecycle check completed in 855 ms. This exercises the OS boundary
with an owned socket rather than a stub-agent scenario: stub agents cannot
reproduce CIM query latency or the Windows socket table. Installed destructive
recovery and the remaining CLI failures are not established by these tests.

Tracking: https://github.com/mvschwarz/openrig/issues/88

This branch implements native Windows headless Codex/Pi launch, message delivery,
process observation, snapshot/down/restore, and graceful daemon stop. It remains
an experimental fork; it is not an upstream Windows support announcement.
Use in a particular local deployment does not establish general native support.

## Native resume fixture mutation on CRLF checkouts, 2026-10-29

A structured rerun isolated the workspace log's two native-resume-probe failures.
Both were negative fixture mutations removing a whole LF-terminated line from a
CRLF checkout: removal did nothing, so the test still supplied a complete login
panel. The two removals now accept LF or CRLF; the actual screen parser is
unchanged. Before/after JSON receipts show the entire file moving from 277/279
to 279/279 passed, with no skips. This is fixture portability evidence, not real
provider authentication or conversation acceptance.

## Native telemetry migration inventory, 2026-10-29

The lexical audit found a second shipped upgrade helper still directly spawning
rig.cmd. An actual temporary Windows shim reproduced inventory_unavailable in
read-only plan mode before the fix. The helper now uses the same literal binary
and JSON-argv PowerShell call boundary as upgrade inspection. Both editable spec
and regenerated canonical copies were exercised with successful and exit-7
inventory fixtures; plan mode left the owned home empty. The combined upgrade
inspection/migration file passed 2/2 tests without skips, and the actual mirror
check passed. No apply/rollback phase or real instance inventory was invoked.

The full workspace run has now ended nonzero. Its very large output was truncated
by the terminal response, so exact aggregate counts are not established here.
Observed failures include native-resume-probe cases and TUI fixture fetch-guard
refusals on unregistered fixed ports. The run spanned subsequent source edits
and is not exact-head evidence. This result is retained as failed, never replaced
by the targeted passes; per-package structured receipts are still needed.

## Default-shell failure before native pane cutover, 2026-10-29

The callsite audit found a native lifecycle gap: a failed default-shell read
fell back to /bin/sh after the kept pane's old process had already been stopped.
Controlled orchestrator and successor tests reproduced the old behavior before
the fix. For the native Windows multiplexer, takeover now confirms the configured
shell before changing remain-on-exit or signalling the old process. Unknown shell
returns default_shell_unavailable, with the existing running session/binding
preserved. Staging likewise refuses before creating a session. A known native
shell is used explicitly and read only once, before cutover; no shell is guessed.
The POSIX fallback contract remains unchanged.

Both complete test files passed: 92 tests, no skips, covering kept-pane record
preservation, native refusal, confirmed-shell ordering and ordinary successor
regressions. These mocks/temporary databases stop no actual seat and do not prove
complete Windows restore or PowerShell idle readiness.

## Native window routing with inherited Rex markers, 2026-10-29

Consumer review found the Rex fast path running before the Windows platform
selection. Two new tests failed before the fix: inherited Rex markers diverted
a Windows window request into the POSIX provider, and explicit Rex selection
tried that provider instead of refusing before work. Windows now keeps the native
Windows Terminal route for automatic selection and explicitly reports Rex as
unavailable when requested. The POSIX Rex path spells its paths with the POSIX
library, including in cross-platform dependency tests. Both window test files
passed in full: 36 tests, no skips. These injected launcher tests request no real
desktop window and do not establish visual/layout acceptance.

## Case-variant Git environment isolation, 2026-10-29

Review of the current platform-call inventory found that bundleGit removed only
uppercase GIT_ keys. On Windows Git also reads a mixed-case configuration key.
An actual local Git test first proved that a mixed-case invalid config count
breaks Git, then failed through bundleGit before the fix. The environment filter
now removes GIT_ keys case-insensitively. The three targeted real-Git checks
passed: configuration isolation, error sanitization and missing-executable
reporting. The other 38 cases in that file were outside this selection, not
claimed green. No remote fetch, credentials or provider login was used.

The full lint command passed before this follow-up. A full workspace test run
started at the preceding head is still in flight and may observe later source
changes; its eventual result must not be presented as exact-head acceptance.

## Native plugin snapshot refresh and isolated build follow-up, 2026-10-29

The published plugin baseline refresh command now uses the Node CLI's
`--snapshot --out file` instead of shell redirection, validation and mv. It builds
and validates the snapshot before writing an exclusive temporary sibling and
renaming it over the destination. Missing archives or invalid package metadata
leave the previous baseline intact. The documented native command passed its
actual archive-generation and failure-preservation test. The package-metadata
file-symlink rejection control remains a separate unwaived test, alongside the
other file-link cases that this Windows host cannot create.

The previously failed resident install test passed when run alone at b567195c1:
the real native package build and fresh temporary-prefix install completed and
the complete better-sqlite3 package was present. That is additional evidence,
not a root-cause diagnosis or erasure of the earlier Node/npm crash. No automatic
retry was added and the full repository aggregate remains the earlier run.

## Linked script entries and refreshed failure inventory, 2026-10-29

At `5dc3ea549`, the full repository-script sweep ran 355 tests: 335 passed,
16 failed, four skipped, none cancelled. This is not full workspace acceptance.
One failure is a real second package build exiting 3221225477 in Node/npm,
with a Git Bash segmentation-fault message; no successful install is inferred
from that run. Other failures include prohibited Windows filenames/file symlinks,
POSIX modes and the snapshot-refresh fixture's fixed shell lookup.

Subsequent entry tests use Windows directory junctions for directory links. The
portability report's Windows encoded-filename case copies its standalone script;
its preserved-link case uses a junction parent. POSIX file-symlink cases remain.
This proves those Windows entry paths, not privileged file-symlink creation.
Inspection also found that the import rewriter resolved only argv's real path:
it now resolves both entry paths, so --preserve-symlinks-main through a linked
parent actually executes. All 23 rewriter/report tests passed, including real
rewrites through space/hash/junction paths with and without that flag and the
unmapped-import rejection. No post-change full aggregate is claimed yet.

## POSIX install-wrapper contracts from a Windows host, 2026-10-29

All 17 install.sh contract tests now run on Windows using the explicitly selected
Git for Windows sh, rather than an absent /bin/sh host executable. Fixture paths
are spelled for their shell/native consumers and the HTTP-pipe control uses a
small owned curl forwarding script instead of a privileged file symlink. Every
case passed without skips: prerequisites, original install/prefix/root/ABI/setup
failure statuses, a prefix containing spaces, stale PATH refusal, and the actual
loopback HTTP download piped into sh. Fixture tools prevent a real global npm
install or setup. install.sh still advertises macOS/Linux; these tests do not
establish it as a native Windows installer. Native installed rig.cmd/ABI evidence
remains the separate isolated-package gate described below.

## Native gate process-load advisory, 2026-10-29

Gate logs showed `ps` failing on Windows and the old catch converting that failure
into an empty process list. The gate now reads PID/process-name pairs through
bounded, no-profile, noninteractive Windows PowerShell. It reads no command lines
and changes no processes. POSIX uses direct ps argv rather than a command shell.
Malformed, failed or timed-out observations record an unavailable census and a
null foreign-process count, rather than zero. Windows loadavg is likewise null
and explicitly unavailable; Node's Windows zero tuple is not a real load measure.
The advisory still does not change engineering-leg exit decisions.

All 29 process-reader, gate wiring, candidate-binding and hermeticity tests passed
without skips. Evidence includes the actual host census finding this Node PID
and an actual fixture gate receipt containing the observation and unavailable
Windows loadavg. Invalid-census tests preserve unknowns without recording error
bodies. This is not a full lint/test gate result.

## Gate and reduced-environment scenario fixtures, 2026-10-29

The native failure log exposed directory-link fixtures created without a Windows
type and Unix-only fake npm executables/PATH separators. Candidate-binding and
dependency-root tests now use directory junctions on Windows (directory symlinks
on POSIX), a real owned native fake npm and the host PATH delimiter. These test
the ordinary gate legs, not a substituted smoke branch. Refusal still precedes
cleanup, a late HEAD/input/dependency-target change writes no verdict, and a
refused retry invalidates an older PASS. Native path spelling is normalized only
in diagnostic assertions.

The Linux-container reduced-environment scenario now explicitly uses POSIX paths,
including when its synthetic command/SQLite seams run on Windows. Host path.join
had prevented removal of the container wrapper from PATH in those tests.
All 39 tests across candidate binding, hermeticity and PR scenario contracts
passed without skips. This does not prove real container restart or native npm
engineering legs. The subsequent native census follow-up is recorded above.

## Native runtime mirror drift comparison, 2026-10-29

The failure log revealed that authoring regeneration's native filesystem backend
did not cover the older `checkModeAbsolute` API still imported by the daemon's
runtime skill-drift check. On Windows that API now compares exact file bytes and
file/directory inventories without rsync or writes. It preserves source exclusions,
reports excluded target material as extra, refuses linked roots/descendants and
fails for an absent source. POSIX and explicitly injected rsync callers retain
their existing implementation. Native Windows permission-bit equivalence remains
limited by the filesystem and is not claimed as Unix mode acceptance.

Three targeted script checks passed, covering the actual source mirror, native
content/extra/empty-directory drift, no mutation, missing source, junction refusal
and the injected rsync contract. The daemon's six mirror-drift tests also passed.
The complete repository script suite has not yet been rerun after this change.

## First-run references and byte-bound guards, 2026-10-29

The refreshed native script log exposed a first-run reference bug: joining
Markdown links with the host path library produced backslashes on Windows,
which also bypassed the `skills/` shipped-home fallback. Link resolution now
uses document path syntax and reports repository-relative authority paths with
forward slashes. The added global-skill link case and all 16 reference tests pass.

Built-in policy files now explicitly check out with LF: their five exact authority
hashes bind shipped bytes, so CRLF conversion is a real artifact difference. The
current files were normalized only after comparing their LF bytes to Git HEAD;
the pinned hashes were not changed. The leak scanner recognizes CRLF line endings
for exact-line allowances while still rejecting appended content, a standalone
CR and adjacent sensitive lines. The reference, policy and scanner suites passed
26/26 with no skips. A separate skill-inventory test now uses path.basename and
passed on Windows; this does not resolve the remaining mirror permission/link
or legacy rsync-check failures. The last full script sweep remains the earlier
350-test result, not a post-change aggregate.

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
# Native local tile reattachment follow-up (2026-10-29)

An actual composed local tile still selected `/bin/sh` on Windows; launching that executable failed with `ENOENT`. Windows composition now selects a packaged PowerShell helper, while SSH tiles retain the remote POSIX contract. The helper pins the immutable session ID and managed node identity, follows same-owner replacements, rejects foreign replacements, and bounds missing-session retries. It does not create sessions or restart agents.

The bootstrap passes JSON data as base64 and quotes native arguments literally. The Windows Terminal consumer uses the generated argv directly, avoiding double encoding; the 16-pane command has a regression check against the Windows command-length limit. Native fake-executable scenarios exercise detach, replacement, foreign identity, missing replacement, unmanaged sessions and absent initial metadata. These tests do not establish visual Windows Terminal or interactive console acceptance.

The isolated checkout passed 164 targeted tests and the full TypeScript lint command. Its package proof stopped before package assertions because that checkout lacked the UI-local `tailwindcss` dependency. In the original Draft checkout, all 164 targeted tests passed again, and the package proof passed: the extracted tarball contains the regular helper file with matching bytes, and its compiled module resolves the helper inside that extracted package. This is a dirty-source package-content proof, not a fresh-install or GUI acceptance claim. No deployed daemon or fleet has been changed.

## Native ACP cooperative cancellation (2026-10-29)

The full CLI receipt exposed an ACP cancellation failure. A focused native reproduction confirmed that sending another Node process `SIGINT` terminates it on Windows instead of invoking its cancellation handler. `rig acp cancel` now writes a run-local request bound to the already-verified process start identity; the Windows connector polls that request and uses the existing ACP cancellation promise. POSIX signalling and interactive Ctrl-C retain their existing paths. Polling stops when the run ends and does not keep a detached process alive.

The native subprocess regression rejects ended records, reused process identities and stale request identities, then verifies that the live request produces an ACP `session/cancel`, a cancelled outcome and normal connector exit. That regression and the full TypeScript lint command pass. The first broader ACP pair reported 14 passed and two failed: detached-agent liveness and companion cleanup.

The liveness failure reproduced an agent disappearing when its connector's Windows console closed. Native ACP agents now start in an independent process group with hidden windows, keeping the existing stdio protocol and release path. The subprocess detach regression now proves that the connector exits while its agent remains alive; the cancellation regression still passes. The full pair then reports 15 passed and one failed, in companion-fixture directory cleanup. Attempts to wait for process disappearance and retry deletion did not resolve that cleanup failure and were reverted; it remains open. A focused two-test run passes both detach and cancellation with the other 14 cases excluded, not counted as passed.

The full CLI baseline at `aabbe24444b61eb68e0d65fce10657374e948d83` reports 5,946 tests: 4,534 passed, 1,355 failed and 57 pending. Initial message-based triage groups the failures as 288 fetch-guard, 380 suite-hook stack, 32 EPERM, 14 ENOENT, 13 timeout, two process-signal and 626 other; these are diagnostic groups, not established root causes or completed feature coverage.

## Native database parent-path validation (2026-10-29)

Native execution of the database-path suite exposed a real difference: Windows reports ENOENT for a child path beneath an existing file, where the earlier containment resolver expected ENOTDIR. It consequently accepted an invalid implicit database home as a missing directory tail. The resolver now verifies that an existing resolved parent is a directory before appending an absent component. Real absent parents remain allowed, and explicit database-path selection retains its existing semantics.

The regression covers a file used directly as home and as an ancestor of multiple missing components. Native junction tests also reject an implicit path escaping the resolved home and retain a positive absent-tail case through a home junction. The suite reports seven passed and one failed: the original file-symlink fixture cannot be created on this host (EPERM) and remains unwaived. Three previous path-string expectations now use the host path API instead of POSIX separators. No deployed database or daemon was changed by this source repair.

## Complete TUI receipt and native fixture corrections (2026-10-29)

The complete declared TUI test script at unchanged head `0002cc38421e6ae00a89b8a49dba9067b6399407` reports 1,190 tests: 1,149 passed, 20 failed and 21 pending. JSON, output and matching before/after source fingerprints were captured directly. This is a failing baseline, not native acceptance.

Native investigation found that this host's configured IPv4 TCP dynamic range starts at 1024 with 13,977 ports. `listen(0)` fixtures therefore receive low ports that the unchanged test fetch guard correctly refuses unless explicitly registered. The TUI feed/history and Usage-host fixtures now register their actual bound origins, including their owned redirect relay; the guard remains unchanged. Its test now checks rejection before registering an OS-selected low fixture port. Daemon, non-loopback and unregistered-low-port negative tests pass.

The startup test's source extraction now normalizes CRLF before locating multiline callbacks, preventing accidental extraction of unrelated top-level await into a non-async function. The default-socket test checks the hashed native pipe endpoint on Windows instead of imposing the Unix sun_path byte limit. These three TUI files pass. The broader five-file run reports 44 passed, one failed and one skipped: one Usage-host request-observation case returned an empty request set on a subsequent run. That unresolved failure is retained; no timeout or assertion was relaxed. POSIX shell execution, deleted-cwd fixtures and the remaining complete-suite failures still require separate disposition.

The next complete source-stable TUI run at `0cca246d6e270faa191566e9a228cadd15aea868` reports 1,165 passed, four failed and 21 pending out of 1,190. Its four failures are the POSIX execution-action shell probe, two deleted-cwd fixtures, and the launch-group signal fixture. The earlier intermittent Usage-host observation failure did not recur in that run; it is not declared permanently resolved.

The cwd fixtures now exercise the actual OS contract: POSIX still removes a live working directory and tests recovery, while Windows must reject removal of an in-use directory and preserve helper execution in that directory. All three native cwd tests pass, including the running TUI repeating its startup helper. This does not prove a physically deleted-cwd recovery on Windows, where that fixture operation is unavailable.

Native console signal investigation remains unaccepted. A hidden detached Node process initially had no attachable console. A dedicated hidden-console fixture exposed the vite-node esbuild descendant, then disproved the assumption that the descendant process set equals console membership. Three fixture fixes failed before sending a control event; the attempted changes were withdrawn and retained only as local diagnostic material. No existing seat or user console was signalled. The production TUI workflow command renderer also still emits POSIX quoting and backslash continuations; PowerShell copy-and-run acceptance requires a separate literal-argv implementation and native proof, rather than merely running that test under Git Bash.

## Native workflow command rendering (2026-10-29 follow-up)

The workflow renderer now translates only the daemon's recognized literal-word command form into PowerShell single-quoted strings and backtick continuations on Windows. Long arguments use parenthesized string concatenation, preserving one argument across narrow rows. Values beginning with digits, minus signs or `@` are quoted where required instead of becoming numeric expressions or splats. Other platforms retain the existing POSIX renderer; unrecognized shell programs are not interpreted or translated.

The execution-view file passes 37 tests. At 84, 120 and 160 columns, the complete action extracted from the real rendered screen is executed by Windows PowerShell through an owned `rig.cmd` shim and native executable/Node receiver. The expected workflow, SHA, verdict and long evidence reference arrive unchanged. A separate PowerShell function receiver checks parser-level preservation of empty strings, numeric/splat-like strings, apostrophes, double quotes, metacharacters, Unicode and long values at widths 24–160. That parser test does not prove all those special values survive every external npm shim or legacy native argument marshaller. The POSIX branch also passes an actual shell argv round-trip. Full TypeScript lint passed during this implementation; no deployed daemon, seat or real workflow was invoked by these fixtures. Native console Ctrl-C acceptance remains unresolved.

## Owned native console interruption proof (2026-10-29 follow-up)

The signal fixture now creates a separate hidden Windows console using CREATE_NEW_CONSOLE and SW_HIDE, retaining literal redirected stdio. Its launcher resets the inheritable Ctrl-C ignore attribute before starting Node. Windows documents that [this attribute is inherited by child processes](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler); the detached test launch had propagated it, so generating a control event alone did not demonstrate TUI handling.

The interrupt helper distinguishes required console members from permitted fixture descendants. It checks the target creation FILETIME against the launcher-held process identity, retains a process handle through interruption, verifies descendant creation order and rejects any actual console member outside that owned set. A wrong creation time is tested and rejected before any event. It then sends a real CTRL_C_EVENT to only that verified private console. The first event ends the fixture's rig-up process while the TUI retains its return prompt; Enter restores the page, and a second event closes the TUI normally. The native subprocess regression passes. POSIX retains its actual group-signal path. This proves the owned hidden-console path, not manual Windows Terminal, desktop/reboot acceptance, or control events for any existing seat. No deployed code or user console was modified or signalled.

The complete declared TUI script at unchanged head `77a8c31c50b0b55e77b55ea3d5bbe602e46644b2` passes: 1,171 passed, zero failed and 21 pending out of 1,192. Before/after HEAD and tracked source fingerprints match. Pending cases remain pending, and this result does not cover the outstanding CLI/daemon suites or full native acceptance.

## CLI timeout root-cause sample (2026-10-29)

A focused `add.test.ts` reproduction exposed an unhandled fetch-guard rejection on an owned `listen(0)` server at port 1224, followed by test timeout. Its `new Promise(async ...)` console-capture helper failed to propagate that rejection, hiding the cause behind timeout/stack-only baseline records. The fixture now registers its bound origin for each test, and its async capture propagates errors while restoring console and exit-code state in finally. A Windows expectation now retains the correctly quoted backslash path in suggested commands. The whole add file passes 27 tests; together with the unchanged guard's tests, 34/34 pass. No guard rule or product request behavior was changed. This one-file proof does not classify every historical stack-only failure or replace the complete CLI baseline.

## Bounded CLI fixture repair batch (2026-10-29)

The same diagnosed capture pattern was present in 24 further helpers across the selected baseline-failure files. Those helpers now propagate rejection and restore their existing console/stderr/exit-code state in finally. Twenty-five test files explicitly register their own already-bound HTTP server through a shared test helper; it derives loopback origins from the bound server, not from arbitrary client input. The request guard and its port rule are unchanged. Tests of the helper reject unbound servers and retain rejection of unrelated low ports and non-loopback targets.

The first 27-file batch run reported 561 passed, 18 failed and one pending out of 580. This exposed native path assertion problems and one registration inserted before listening; those were corrected using exact host path resolution and the actual drive root rather than POSIX slash assumptions. A native HOME-MOVED fixture now uses the same resolved path spelling in its filesystem facts and expected result. The second run reports 579 passed, zero failed and one pending. The same 27 files contained 463 failed assertions in the historical full CLI baseline; this is a bounded comparison, not a current full-CLI failure count. The helper/guard pair separately passes nine tests (seven guard cases overlap the batch). No expectation was removed, timeout enlarged, product HTTP behavior changed or real daemon accessed. Other CLI/daemon tests and dynamic Windows feature acceptance remain outstanding.

### Native Codex auth files (2026-10-29)

An owned synthetic-file reproduction of the previous implementation saved a profile but then rejected both validation and switching with `unsafe_permissions`: Windows mode bits do not express its access control. The Windows branch now checks an owner-only protected DACL on the opened file. The existing API safety token `600` denotes that verified DACL on Windows; it does not report Windows POSIX mode bits. POSIX behavior is unchanged.

Auth copying uses the native helper's opened source handle for type, reparse, link-count, owner and exact file-ID checks. Native file IDs travel as bigint values, avoiding floating-point identity comparisons. A fresh destination receives its private DACL before any source bytes, is flushed and closed, then replaces the destination atomically. Failed replacement cleans up only its unique staging file. Saved-profile directory permissions are applied through an owned, non-reparse directory handle. Registry staging also uses the shared private-file creator. The default login-status probe recognizes native executables and verified npm Codex entries; both output streams remain ignored.

Four native tests pass using synthetic files and a synthetic npm entry. The expanded five-file run reports 30 passed and three failed; the failures are file-symlink fixture creation denied by the host, retained without a skip or waiver. Passing cases include hard-link and identity-mismatch refusal, junction containment, prior-destination preservation, staging cleanup, byte preservation, actual DACL inspection and a functioning sentinel-output harness. Shared owned-text/private-file tests pass, and workspace type checking passes. These are native filesystem and command-entry checks, not live account switching, provider acceptance or fleet deployment; no personal credentials were read or changed.

### Root-help startup (2026-10-29)

The piped public binary reproducibly timed out after five seconds without output. Import tracing showed it was still loading the full command tree's MCP dependencies. CLI preparation now derives `root-help.txt` from that complete tree, including its help hooks, at build time. Root help and noninteractive bare calls read this artifact. An equality test binds it to the real command tree; there is no second manually maintained command list. The build and npm file-selection tests require the artifact.

Both the public wrapper and direct `index.js` use this route. The complete synchronous command factory moved unchanged to `program-full.ts`; normal module imports finish loading it before exposing `createProgram()`. The direct entry also shares the existing public wrapper's named-command lazy loader. Interactive bare calls and unknown arguments retain the full front-door/parser flow. With the same five-second bound, observed piped calls exited in 103 ms through the public wrapper and 367 ms through the direct entry. These are local observations, not a latency guarantee.

The root-help/front-door/wrapper/lazy-loader set reports 55 passed, three host-denied file-symlink fixtures and one existing PTY skip. Build asset/license tests report four passed and one existing file-symlink skip. Native npm dry-run file selection includes both entries, the full factory module and both help artifacts. Workspace type checking passes. Full CLI and remaining native carrier acceptance still require their own receipts; this does not prove interactive TUI/Windows Terminal acceptance.

### Windows shell-host identity reconciliation (2026-10-29)

An owned PowerShell process with no Claude child was observed through actual CIM facts and bound to an isolated reconciler fixture. The previous reconciler persisted `verified` because the Windows shell name took its ambiguous-command compatibility path. Windows PowerShell/pwsh/cmd hosts now select the existing Claude native-proof path. This is separate from bare-shell classification: a Windows shell host can still contain a live provider, and its name does not establish idle or exit.

Existing exact-conversation foreground and process-identity checks remain enforced. Runtime-only proof retains its sole-pane and PID checks. Missing provider proof stays non-green as `process_identity_ambiguous`; the reconciler changes no session lifecycle status. The actual owned-process negative reproduction now passes. Three core files pass 322 tests without skips; six restore/rotation/attention/dead-pane/Pi-OMP/batched-read consumer files pass 117 tests with one existing skip. Workspace type checking passes. The actual process test uses a PID-bound facade and kernel facts, not a live managed seat or full psmux/provider acceptance.

### Native test-provider isolation (2026-10-29)

Windows native command lookup does not execute the extensionless POSIX runtime stubs. Test preparation now builds fixture-owned codex.exe and claude.exe probes with Windows PowerShell, ahead of host providers on PATH. They emit fixed version/help output and exit without provider work for other arguments. Compilation failure aborts preparation; the existing explicit real-Codex E2E exception remains limited to its two named tests.

The native resolver/execution/idempotence regression plus stub, daemon-discovery, outbound-fetch and three CLI command fixture suites passed 65/65 tests on Windows. Full workspace type checking passed. Local archive, workflow and Codex config path expectations now use native path operations. This validates test isolation and these fixtures, not live provider or full Windows acceptance.

### Pair credentials and in-place restart (2026-10-29)

Both CLI and daemon pairing now create the approved credential through the shared private-file boundary before writing bytes. Windows receives a protected current-user DACL; exclusive destination creation still rejects a concurrent winner without overwriting or deleting it. Pairing fixtures inspect the actual DACL rather than Windows mode bits. Owned fixture HTTP targets register with the existing outbound-fetch guard.

The in-place Codex observer now supplies the pane's foreground command to native process verification. Windows shell hosts are accepted at the verified launcher-chain boundary and after the old launcher/native process have exited; this does not widen the shared bare-shell or idle classification. Windows Node ancestors require an OS Node executable and exact Codex entry arguments. A Codex-looking label or preload value cannot identify a launcher. Conversation, effective-setting and ambiguous-process refusals remain in force.

Five canonical pairing/restart/route/process-control files pass 195 tests with one existing skip. An additional Codex adapter/native consumer check yields 109 passes, 33 failures already present in the fixed-source baseline, and five existing skips. No new failure names appear in that comparison. Full workspace type checking passes. An actual Windows process test confirms that stopping the owned launcher subtree terminates its child and preserves an independent sibling. The lifecycle cases use synthetic process/IO fixtures; these checks do not establish full psmux/provider, account or saved-conversation acceptance.

### First complete public daemon test observation (2026-10-29)

At fixed head `d555e260b3bd6aeaba888c6526fb665ec03b5cef`, all 1,308 tracked daemon test files were collected, excluding the unrelated untracked private psmux diagnostic. Real-Codex opt-in was disabled, native provider stubs were installed, and two workers were used. The source stayed unchanged from start to finish. Result: 23,319 tests total, 21,164 passed, 1,638 failed, 512 pending and five todo; exit 1. This is a failure inventory, not a Windows acceptance claim or proof that every failure is Windows-specific. Subsequent focused repairs and receipts must be distinguished from this earlier full observation.

### Rebase onto c848ea8af (2026-10-29)

The 109 research commits were rebased from `6cc3626529e8fee5cf33de49570d665bda6b5837` onto selected upstream main `c848ea8af1978168a316e1b91704ec9da6586e4a`. The Claude seat-switch conflict retains upstream's stopped-seat next-launch path and applies Windows undo quoting in its shared report builder. Range comparison retains all 109 patches; the other changed patch contexts reflect upstream imports. Protected stash identity and the five pre-existing policy file byte hashes remain unchanged. The deployed daemon and work seats were not upgraded or restarted.

Workspace type checking passes. Twelve focused files initially yielded 920 passes, four failures and 21 existing skips. All four failures were in the newly added MCP lifecycle fixture: two hardcoded `/bin/sh` calls and two incomplete pre-trusted path aliases. The fixture now uses Git Bash for its POSIX mock command on Windows and pre-trusts both resolved and native real paths, retaining its exact shared-file byte assertions. Its follow-up passes all 36 tests. This mock-shell observation does not establish native PowerShell fallback-probe acceptance; that caller remains a separate follow-up. The earlier full daemon and CLI failures remain recorded, not waived by this rebase.

### Native shutdown fallback probe (2026-10-29)

The shutdown-only Claude fallback now distinguishes the actual native multiplexer from POSIX mocks. It freezes the selected native executable, renders literal Windows arguments, and supplies the seat's config directory (or the daemon-selected directory) through the child environment. The saved per-agent MCP choice is retained. Existing POSIX alias/function behavior remains unchanged.

The fresh probe requires the shared stable idle-shell/kernel-console proof before dispatch. Both positive resume and explicit history-failure outcomes require exact native executable/conversation proof; unproved screen text stays inconclusive and the stored token remains intact. The existing native identity contract does not establish Node npm-launcher identity, so that selection remains inconclusive without starting a provider. Native dispatch reuses the PowerShell-only shell-command boundary.

Probe allocation and failed-allocation cleanup now use the argv executor. Native cleanup carries its own session routing as well as the original atomic name/ID/creation-time check. Before correction, the three new argv-routing regressions failed because these paths bypassed that executor.

Eight relevant files pass 282 tests without skips; full workspace type checking passes. This includes an actual PowerShell execution of an owned inert native stub that records quoted/Unicode config paths, cwd, resume/name arguments and MCP JSON. Process identity and probe lifecycle are simulated in that fixture; existing native lineage/console tests separately exercise the OS boundary. No real provider, credentials, managed work seat or deployed daemon is used. This does not establish complete stock-psmux/provider acceptance or resolve the earlier full-suite failure inventory.

### Codex adapter native fixture follow-up (2026-10-29)

The 33 observed Codex adapter failures are repaired in its test fixtures. Its in-memory filesystem now treats native Windows separators as equivalent while retaining POSIX backslash semantics. Git marker mocks use the same path identity. The POSIX launch-PATH case uses Git Bash/cygpath on Windows, with both inert fixture executables verified before execution. Trust tests use the native absolute project key and continue checking exact instruction preservation, duplicate rejection and single-key/table reuse.

The file passes 144/144 tests without skips, including two added LF/CRLF projection cases: marker-like text inside a person's multiline instructions stays exact, their MCP table survives, and a second projection is byte-identical to the first. Production adapter behavior is unchanged by this fixture repair. This removes the 33 failure names in this file from its focused receipt; it is not a new full-workspace or native-provider acceptance result.

### Owned HTTP fixture registration (2026-10-30)

Nine daemon fixture/helper files now register exact loopback origins only after their own listeners bind. This includes selection/history transport, cross-host usage readers and relays, browser/identity boundaries, notification transport, request observation, WebSocket recovery health checks and the owned child-process stress fixture. The browser fixture also registers the localhost alias it explicitly exercises. Production requests and the outbound-fetch guard are unchanged.

Thirteen fixture, consumer and guard files pass 224/224 tests without skips. The earlier full baseline had 131 direct guard failures across these nine files. Two earlier focused observations each had one ordinary fetch connection failure on different cases; an isolated case passed, and an owned 30-cycle port-reuse experiment did not reproduce the error. The cause remains unknown; no retry, timeout or transport behavior was changed. This is a focused fixture receipt, not a replacement full-workspace or native-provider acceptance result.

### Pod paths and startup asset checkout (2026-10-30)

Pod instantiation and bundle fixtures now key their in-memory files and output assertions by native absolute paths. Directory-link containment and redirected state-root cases use Windows junctions on Windows and directory symlinks elsewhere. File-symlink cases remain unchanged. These fixture corrections retain the outside-root refusal and failed-reconciliation cleanup checks.

The thin startup asset was expanded by checkout CRLF conversion from its canonical 2,464 bytes to 2,518 bytes, exceeding its existing size bound. Its Git attributes now require LF. The checked-out asset matches the existing Git blob exactly; neither content nor the size bound changed.

The two Pod files report 149 passed and three failed out of 152 tests. All remaining failures occur while creating file-symlink fixtures with host-denied EPERM; they remain unwaived and their later assertions are unverified here. The first-run reference checker passes 525 checks across ten files, with six external references unchecked. This does not establish a passing full suite or privileged file-symlink acceptance.

### Claude plugin directory lists (2026-10-30)

The added-seat culture test exposed a production path-list mismatch. OpenRig appended plugin folders with a fixed colon and split that way for duplicate detection. Inspection of the locally installed Claude 2.1.304 parser establishes that it uses Node's native path delimiter: semicolon on Windows. Multiple Windows directories therefore became one provider entry, and duplicate detection split drive letters. OpenRig now uses that same native delimiter for both operations, retaining a declared list unchanged when it already contains the requested absolute directory. This local provider-source observation does not establish compatibility with every Claude version.

Both new regressions fail before the correction. After it, the new path-list tests, added-seat culture/startup integration and install planner pass all 54 tests. The culture fixture now serializes Windows cwd values as valid YAML strings, and install-planner filesystem mocks and path assertions use native path identity. Full workspace type checking passes. The expanded core-plugin file reports 22 passed, 14 failed and nine pending; every remaining failure name occurs in the earlier fixed-source baseline (15 failures there). Those failures are not waived, and no live provider/plugin acceptance or fleet activation is claimed.

### Windows activity relay deduplication (2026-10-30)

The plugin relay failed to recognize its identical settings-installed copy on Windows: its suffix check required forward slashes, and legacy bare-Node availability looked only for an extensionless file. It now compares a native-normalized path and looks for node.exe on Windows PATH. Pinned Windows interpreters must also name node.exe; POSIX executable checks remain unchanged. The finite command grammar, exact script-byte comparison, event/matcher restrictions and fallback reporting remain enforced.

All 14 activity-relay subprocess cases pass, including pinned Node with empty PATH, missing/nonexecutable/directory interpreter refusals, per-event deduplication, matcher restrictions and changed-script fallback. An expanded focused selection passes 19 cases including shared parser grammar and unquoted POSIX-style paths on Windows; 43 other cases are deselected, not validated by that run. A broader three-file observation still has 34 failures among 91 cases, including five parser suffix regressions exposed by an initially over-strict native-only comparison; the final normalized comparison fixes those five in the 19-case receipt. Other broad failures remain recorded. These are owned child-process/loopback fixtures, not live managed-seat or provider acceptance.

### Refocus Windows CLI dispatch (2026-10-30)

The four refocus CLI lookups and failure-episode report used direct `spawnSync("rig", ...)`, which cannot execute Windows npm's rig.cmd. They now share a no-shell dispatcher. It preserves PATH order, accepts native executables, and recognizes an npm shim only when its package is @openrig/cli, its bin entry stays inside that package, and the shim names that entry. The recognized entry runs through the hook's own Node. Unknown batch/shim entries fail rather than falling through to another CLI. POSIX keeps direct rig lookup; timeout, output bounds and failure reporting remain with the callers.

Eight owned Windows tests pass without skips. They reproduce the old direct-spawn failure, verify literal Unicode/apostrophe/metacharacter arguments and cwd, reject five invalid installation shapes, deliver configured content through the actual refocus hook, and report the third failure once with its persisted issue ID. The combined context-ref observation reports 16 passed and 36 failed; those 36 names all occur in the fixed-source baseline, and its POSIX-shell fixtures remain unresolved on this host. Full workspace type checking passes. No real CLI, daemon, provider, credential or managed seat is used by the new tests; Python trace execution and full refocus acceptance remain separate requirements.

### Native Python refocus trace (2026-10-30)

The host has Python 3.13 through the Windows launcher but no python3 command on PATH. Refocus now honors an explicit PYTHON first; otherwise Windows tries py -3, then python3 and python only when the preceding command is absent (ENOENT). An interpreter's nonzero exit is returned as a gap without rerunning the trace elsewhere. Lookup time is deducted from the caller's existing timeout. The trace receives the hook's Node path and UTF-8 stdio encoding. Its own Windows CLI queries use the same no-shell npm/native rig dispatcher rather than directly launching a cmd shim. Standalone traces can use OPENRIG_NODE or Node on PATH; POSIX keeps direct rig execution.

Ten native tests pass, including an actual installed Python running the shipped trace, its npm CLI bridge, and the full hook with Unicode paths and content. Explicit-interpreter arguments and nonzero/missing-interpreter behavior are covered. The isolated test HOME changed the launcher's default to a stale Python 3.14 registration; the test therefore selects an existing installed version through PY_PYTHON3 without restoring personal HOME. No installer runs. The original context-ref file remains at eight passed and 36 failed, with no new failure names against the baseline. Full workspace type checking passes. The new flow uses owned files and a synthetic CLI entry; it does not establish live provider, full refocus-suite or fleet acceptance.

### Delivering the changed plugin tree (2026-10-30)

Vendoring preserves installed bytes at an equal plugin version. Leaving the changed hooks at 0.1.21 would therefore strand existing installations and omit the new rig/Python helper dependencies. Both harness manifests now agree on 0.1.22. A real-filesystem regression fails before that version change and passes after it: a 0.1.21 installation receives exact source bytes for both manifests and the refocus dependency tree, replaced content is preserved by the existing managed-refresh mechanism, unrelated installed content survives, and a second refresh is idempotent. Equal/newer installations remain authoritative.

The three vendoring cases and ten native refocus cases pass together (13/13). A copied asset staging tree passes the packaged-plugin version checker against its existing release baseline; this is not a newly built npm archive. The checker's own four-case suite has one pass and three host-denied file-symlink setup failures, retained without waiver. No deployed plugin, live seat or daemon is updated by these checks.

### Context-ref native fixture coverage (2026-10-30)

The original context-ref file now passes all 44 tests without skips on Windows, replacing its earlier eight-pass/36-failure focused receipt. Windows fixtures use owned npm-shaped CLI entries and an inert compiled trace-argument probe instead of unspawnable shell scripts. Actual dual-tree cases use an existing installed Python interpreter, native canonical paths and line-ending-independent semantic output assertions. POSIX keeps its original shell fixtures. The native argument probe is compiled once per file and its temporary directory is removed after the tests.

The existing content-ref precedence, exact configured-content bytes, missing-content failure, current-work ambiguity/UNKNOWN, no-baton fallback, delivery state and process-count assertions remain. The unchanged two-second timeout is still exercised; its Windows error expectation names the Node process that runs the npm entry. The slow successful-content case retains its five-second bound. Full workspace type checking passes. This is one complete fixture file, not the remaining refocus/workspace suite or live-provider acceptance.

### Work-packet native fixture coverage (2026-10-30)

The work-packet file now passes 36/36 tests without skips on Windows, including one added Unicode evidence/stdin case. Its previous 35-case observation had 14 passes and 21 failures. Windows uses an owned npm-shaped CLI, an installed Python interpreter and an inert compiled argv/stdin capture probe; POSIX retains shell fixtures. Semantic text checks normalize CRLF, native paths use canonical disk spellings, and the old-notes regex escapes its literal path. The capture probe reads and writes UTF-8 and is removed after the test file.

Candidate ownership, ambiguity, ancestry labels, held/next separation, bounded output with pointers, note age/source/threshold, explicit-start precedence and older-CLI fallback assertions remain in place. Production behavior and packet defaults are unchanged by this fixture batch. Workspace type checking passes. This receipt covers the packet fixture file; budget/concurrency characterization and the wider failure inventory remain separate.
