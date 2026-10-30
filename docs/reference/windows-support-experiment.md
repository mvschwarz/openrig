# Native Windows support experiment

## Current review status (2026-10-30)

### Context pack discovery preserves custody across native case aliases

Overlapping context-store roots spelled with different case indexed the same
physical Windows pack twice. Its second ref could also shadow a distinct
top-level pack. Discovery now uses native canonical paths for its existing
physical-pack ownership set on Windows. Both owned reproductions failed before
the repair and pass afterward: the system pack keeps its first ref, and removing
a distinct top-level pack leaves the system pack intact. Daemon TypeScript
checking passes. These are two selected native cases, not a full context-store
suite; no real context library was read or changed.

### Native spec rename handles storage limits and case-only changes

Renaming a user spec to a long valid name failed at file creation on Windows;
changing only the source filename's case incorrectly conflicted with itself.
Native rename now uses a bounded hashed storage stem for overlong or reserved
device names, reserving its generated prefix against literal-name collisions.
The YAML name remains the requested name. A case-only change updates that same
physical file without unlinking it. Distinct existing files remain conflicts.
Two failures were reproduced before repair; the reserved-name storage spelling
is also checked. Service and route tests pass 20/20 after correcting two existing
POSIX path spelling assertions; daemon TypeScript checking passes. Only owned
fixture specs were changed.

### Native transcript boundary replay has a stock psmux check

The earlier rotation report contained 26 passes and one Windows-skipped POSIX
terminal replay case. A separate opt-in native fixture now passes on stock psmux
3.4.0: real capture-pane output feeds repeated rotation, preserving one structural
old boundary and one retained latest boundary alongside its original scrollback
line, without accumulating duplicates. It uses a synthetic Node receiver and
separate home, registry, config and namespace. The POSIX fixture remains separate;
this adds native coverage rather than claiming it ran on Windows. No real seat,
provider, transcript or daemon was used.

### Native advertised server flags reach the owned stock server

The stock psmux fixture now checks the daemon's advertised `-S` flags from a
fresh client without inherited TMUX/pane routing. Those flags independently
reach the same isolated `-L` session. This passes together with the watcher argv
and inherited whoami checks on stock 3.4.0. It establishes read routing, not a
visible terminal attachment or live-daemon acceptance; no implementation change
was needed for this checked path.

### Lifecycle compilation accepts native case aliases of its mission

A slice's valid `../../MISSION.YAML` reference was rejected on Windows even
though it addressed the authored mission. The compiler's mission identity check
now uses native canonical paths on Windows, with POSIX behavior retained. An
owned compilation fixture failed before the change and passes afterward; a
reference to a distinct mission file still fails. The compiler test file passes
12/12 after correcting an existing POSIX-only path spelling assertion. Daemon
TypeScript checking passes. These checks use fixture manifests and an in-memory
database, without launching workflows or touching real task records.

### Scoped terminal indexes deduplicate native directory aliases

The same scope index supplied under mixed-case and junction spellings was read
as distinct sources on Windows, causing a valid slice selector to return
`scope_ambiguous`. Scoped terminal reads and resolver root comparisons now use
native canonical paths on Windows, retaining POSIX resolution. An owned
filesystem/in-memory database reproduction failed before the repair; afterward
the complete scoped-terminal test file passes, including slice and mission
selectors over the aliased index. No real queue, task owner or terminal changed.

### Selected project root identity uses native canonical paths

The selected-project guard previously compared `realpathSync` strings and could
report that an unchanged Windows project had moved when its path was supplied
with different case. It now uses `realpathSync.native` on Windows, retaining the
POSIX behavior. An owned filesystem fixture failed before the repair and passes
afterward for mixed-case paths, a directory junction, distinct/missing roots and
the actual `selectedProject` lookup with an aliased root query. Daemon TypeScript
checking passes. No real workspace catalog, project source or live route was read.

### Native transcript partial-write cleanup

Native rotation now records ownership immediately after exclusive creation of its
staging file, before writing payload bytes. A mid-write error therefore closes
and removes that owned file while preserving the old transcript and its freshness
state. A synthetic ENOSPC fixture writes real partial bytes and then throws; it
checks cleanup, unchanged old bytes, unadvanced freshness and a later successful
capture. Together with long-name, rotation and boundary fixtures, 26 cases pass.
This simulates a write error; it does not fill a disk or alter real transcripts.

### Long native transcript names survive rotation

A valid 250-character transcript filename could be created but not rotated on
Windows: appending `.tmp.<pid>` exceeded the filesystem component limit and the
best-effort tick left the old bytes in place. Native rotation now stages through
a short unique filename in the same directory, exclusively creates that file,
and removes its owned staging file when replacement fails. POSIX staging names
remain unchanged. The owned native reproduction failed before this repair;
afterward 25 rotation/boundary checks pass, including long-name replacement,
retained session boundaries and freshness after a refused replacement. Daemon
TypeScript checking passes. No real session, transcript or capture timer was used.

### Community npm entries relative to the seat directory

Native community launch now passes the binding's cwd through both ordinary and
named-conversation launch paths. The standard npm entry resolver uses that cwd
for relative PATH entries and explicit relative commands, while preserving
PATHEXT order and package/bin agreement checks. Without an absolute seat cwd it
retains the unresolved command rather than guessing the daemon directory.

Eleven owned native environment cases pass, including relative PATH and relative
command launches from a seat directory distinct from the daemon directory.
Daemon TypeScript checking passes. The first combined run had 69 passes and one
unavailable real-multiplexer case (`spawn psmux ENOENT`). That fixture now requires
an explicitly selected psmux on Windows and isolates its home, configuration and
registry as well as its namespace. With stock psmux 3.4.0, the same three files
pass 70/70, including activity selection after replacing an occupant under the
same session name. This does not prove the whole community suite or installed
provider acceptance.

### Native probe lifecycle review

Five current owned native probe cases pass: cmd builtin execution, cleanup of a
pipe-holding descendant after its parent exits, deadline cleanup of a child tree,
runtime cwd/environment/stdin EOF, and preservation of exit status and stderr.
The bounded probe implementation was read through its timeout, drain and stop
tracking paths. These checks do not exercise daemon shutdown or installed provider
probes. A full source review of `rig start` found no additional Windows-specific
gap; interactive selection and real restore remain unverified.

### Stock psmux chatroom watcher direct argv

Windows chatroom creation now supplies the psmux `--` command separator. Stock
psmux 3.4.0 otherwise joins positional words into a shell command, losing paths
with spaces. An opt-in native test reproduced the missing watcher receipt before
this change and passed afterward: the watcher receives its original argv and
whoami resolves the owned pane's node through inherited server routing. The test
uses a separate registry, home, namespace and synthetic receiver; it does not
start a real daemon, provider or existing seat. This is scoped evidence, not
complete Windows runtime acceptance.

### Pi/OMP protocol fixture failures reconciled

The current two protocol files reproduced the previously recorded 15 failures
(41 passed, 15 failed). Some POSIX runtime fixtures omitted their platform seam;
resume fakes also extracted launch ids and asserted arguments using POSIX quote
spelling even when the adapter emitted a native PowerShell envelope. Runtime
fixtures now explicitly model POSIX where intended, while resume assertions read
the command's actual argv from either literal words or the native argument field.
Session-file, trust, effort, usage and launch-attempt checks remain in place.

Both complete protocol files and the existing owned native dispatch file now pass
together (59/59). Three cases execute actual PowerShell/Node fresh/resume commands
with synthetic runners, including routing refusal fallback; other cases use fake
terminal/filesystem state. No production code changed in this reconciliation.
These results clear the fixture failures, not live Pi/OMP conversation or process
identity acceptance. No installed provider, daemon or seat was used.

### Native prepublish entry and fresh-prefix installation

The CLI's `prepublishOnly` lifecycle previously invoked bare `bash`, bypassing
the native Git Bash selector. An owned npm lifecycle fixture with no bash on PATH
reproduced the command-not-found failure. It now calls the paired Node build
runner. Three focused cases pass, including actual npm lifecycle forwarding to
an owned stand-in build tool and the existing native build-runner cases; no
publish command was executed.

The single target-native install gate also passes for
`ee373ab14affc2219cc5169b381b663d115e20f2` (80 seconds). It rebuilt and packed the
CLI, installed 32 dependencies into a fresh owned prefix, explicitly checked the
installed SQLite ABI using an in-memory database, then executed the npm-generated
`rig.cmd` through PowerShell against an isolated home. Its synthetic local human
fragment was written as expected; no connector delivery occurred. Owned install,
home and tarball fixtures were removed after completion. The build stamp remains
dirty=true. This is one native host/install flow, not clean-release, installed-TUI,
provider, fleet or full test-suite acceptance. No global installation or runtime
deployment was changed.

### Current package build and assembled-entry readback

The complete native Windows package build passed for implementation head
`aafc656edadbef26e7a7eed073ddc4aa6fca54bb` (05:04:07–05:05:03 UTC, 56 seconds).
Daemon, UI, TUI, CLI and assembly completed with unchanged tracked source. The
artifact honestly retains `dirty: true` for the working copy; this is not a clean
release-certification claim.

Readback confirmed the new community entry resolver, seat environment, terminal
composer and TUI modules in the assembled package. Its standalone native TUI
resolver selects the paired packaged CLI entry. Source and assembled openrig-core
both pass version checking at 0.1.31 with content SHA-256
`93fa63894ca2799955e397b26a43e5595c61d0221ab17895792066bc4e105b6a`.
No CLI command, provider, installed plugin or daemon was invoked by readback.
This refreshes build evidence only: a current-head installation gate, full test
coverage, visible-terminal acceptance and live deployment remain separate.

### Community npm launchers use their declared Node entries

Owned native fixtures reproduced standard global and project-local npm community
launchers failing to run through their `.cmd` entry. Native community launch now
recognizes a standard Node invocation whose script agrees with the package's bin
declaration, then launches that script directly with the selected Node. PATH and
PATHEXT precedence are retained; relative entries now use the explicitly supplied
seat cwd as described above. Unknown batch launchers are not
evaluated through a shell fallback.

Eleven selected native cases pass: global and local npm entry launches, an earlier
native executable winning over a shim, unknown-shim refusal before typing, the
five community metadata cases, and the existing two npm Codex cases. They use
owned packages/scripts, synthetic inputs and actual PowerShell/Node subprocesses.
Daemon TypeScript checking passes. This does not prove arbitrary batch-script,
installed community-provider or live pane acceptance; no such provider was run.

### Community launch metadata reaches native children

Five owned community-adapter fixtures reproduced native launches that returned
without running the intended child: generated first-input/model/conversation and
launch-result metadata still prefixed the command with POSIX `/usr/bin/env`.
The Windows seat environment now decodes only the community adapter's six named
metadata fields and explicit removals into the child environment before native
launch. Nested generated prefixes retain assignment/removal order; the pane's
environment is not changed. Built-in runtime and POSIX command construction are
unchanged; this does not translate arbitrary POSIX launch scripts.

Seven native cases pass: model and first-input transmission, clearing inherited
values, named fresh/resumed conversations, a matching launch-result record, and
the existing two npm Codex seat-launch cases. They use owned Node scripts and
actual PowerShell subprocesses with synthetic inputs and identity. No actual
community provider, conversation, credential, pane or daemon was used. Daemon
TypeScript checking passes. Full provider/native launch acceptance remains open.

### Manual terminal recovery carries the daemon's shell

Owned daemon/TUI fixtures reproduced native manual recovery instructions combining
POSIX `env -u TMUX` with a PowerShell call operator. Executing the generated line
in PowerShell failed with a parser error. Composed native recovery commands now
carry their PowerShell shell identity; daemon notes and TUI rendering use the
matching environment reset, independently of the TUI host's OS. Older responses
without this optional field retain POSIX rendering. Native SSH recovery also
quotes local SSH arguments for PowerShell while retaining POSIX quoting inside
the remote command and requesting a terminal.

Owned PowerShell recorder functions verify local attach argument boundaries and
TMUX removal, plus SSH read-only/interactive recovery with quotes and metacharacters
in the synthetic session name. No actual tmux/SSH process or connection is used.
TUI checks cover native and legacy response rendering. The complete terminal
service file and these focused files pass (88/88); daemon and TUI TypeScript checks
pass. This does not establish visible terminal or live cross-host acceptance.

### Finite Codex plugin commands contain native descendants

Owned npm-entry fixtures reproduced detached descendants remaining alive after
the finite Codex plugin CLI returned, both on exit 0 and exit 7. The Windows
plugin-command runner now uses the existing Job Object wrapper and disposes its
invocation after completion. The existing 120-second bound and output bound remain;
native timeout termination targets the wrapper with SIGKILL. POSIX execution and
persistent seat launches are unchanged.

Three native cases pass: successful and failing owned CLI exits with detached
descendant cleanup and output/status preservation, plus the existing offline npm
entry's exact-argv/home and missing-executable case. The daemon TypeScript check
passes. The full 120-second timeout was not exercised. No actual Codex provider,
plugin installation, credentials or live seat was used; installed-plugin and
provider lifecycle acceptance remain open.

### Pi missing-command guidance matches the native shell

Pi preflight's missing-executable warning now suggests `where.exe pi` on Windows,
which is usable from PowerShell and cmd, instead of the POSIX `command -v pi`.
The POSIX hint and advisory launch behavior are unchanged. This is a diagnostic
text correction verified by source review, not a new provider-availability or
installed-Pi acceptance result.

### Author bundle vendoring accepts contained native aliases

An owned API fixture reproduced bundle creation rejecting an internal plugin
junction as outside the source root when its native target spelling differed.
Author-bundle vendoring now uses native canonical paths consistently for the
source root, declared source, nested link checks and source collection on Windows.
Containment checks remain in place; POSIX path resolution is unchanged.

Four owned API/archive cases pass: contained and outside targets, both directly
declared and nested within a plugin directory. Successful archives were extracted
only into fixture directories and checked for expected bytes and regular copied
directories; outside targets remain refused and unchanged. The daemon TypeScript
check passes. No bundle was published or installed, and no real project, plugin,
runtime or credentials were used. Other bundle routes and file-symlink acceptance
remain separate; this batch reviewed the author-vendoring path, not the full module.

### Standalone native TUI uses its paired CLI

Without launcher-injected `OPENRIG_TUI_CLI_ENTRY`, the standalone Windows TUI
previously tried to execute bare `rig` directly. Owned fixtures with only an npm
`rig.cmd` shim reproduced ENOENT for prerequisite reads. The TUI now finds the
paired existing CLI JS entry in either the workspace-build or assembled layout,
then uses its current Node interpreter. Explicit launcher entries still win;
POSIX selection is unchanged. A missing paired entry retains the existing
unavailable-command behavior rather than selecting another installation.

Both owned layout cases pass with actual Node subprocess argv readback, including
spaces, percent, exclamation, ampersand and quote characters; missing paired
entries and explicit-entry precedence are checked. The TUI TypeScript check
passes. No real CLI command, daemon, terminal, credential or installed provider
was invoked; visible standalone-TUI and packaged-install acceptance remain open.

### Execution arrangement retains native path aliases

An owned execution-view fixture reproduced valid uppercase Windows composition
references yielding an indeterminate arrangement instead of the mission YAML.
The read surface now resolves existing member paths and the slices root through
native canonical spelling and recognizes the slice filename case-insensitively
on Windows. POSIX handling and the shared composition validator remain unchanged.
Both alias-only references and an actually uppercase filename retain the YAML
arrangement and its canonical source path.

Five selected cases pass: those two native cases, ordinary YAML promotion, malformed
YAML fallback, and absent optional YAML fallback. The first combined run also
exposed an existing POSIX-only slash assertion; it now uses the platform path
join. The daemon TypeScript check passes. Sixty-five other cases were filtered,
not run; this is targeted source review and owned fixture evidence, not complete
execution-view or live-runtime acceptance. No real workspace/database was used.

### Explicit missions-directory casing on Windows

An owned native fixture reproduced `rig scope` root resolution rejecting an
existing explicitly named `MISSIONS`/`Missions` directory in strict mode. The
same mismatch could send non-strict resolution to the configured workspace
instead. Directory-name recognition now follows Windows case-insensitive
spelling; POSIX recognition remains case-sensitive. Explicit flag and environment
selection retain the caller's path. No project or configured workspace was used.

The new native case and complete existing scope-filesystem test file pass with
60 passed and 7 pending; the CLI TypeScript check passes. Pending cases and full
scope-command/live-runtime acceptance remain open. Only root-resolution sections
of the current helper were reviewed in this batch, not the complete module.

### File transfer, log worker and control-mode boundary review

The current file-transfer entry and slow-operation recorder were read in full.
The transfer entry selects native local/SFTP implementations on Windows and
retains its existing explicit path/host planning. This review did not execute
a remote transfer or establish additional transport acceptance.

The complete Windows private-log test file passes (3/3): actual owned Worker
append/rotation beyond MAX_PATH with ACL inspection after writes stop, upgrading
an existing owned log without losing bytes, and refusing a multiply-linked log
with an unsuccessful durable drain. No live daemon log or user material was used.
This does not establish every recorder barrier, shutdown or failure condition.

The tmux control-client boundary was also checked against current startup:
control mode is opt-in on POSIX, while native Windows keeps the psmux argv
executor. No control client, terminal server, session, service or fleet process
was started. The full POSIX control parser/lifecycle was not re-reviewed or
accepted as a native feature by this boundary check.

### Native settings-relay path casing and plugin duplicate suppression

The activity relay's settings-command check used a case-sensitive path suffix on
Windows. An owned identical relay referenced through upper-case native path
spelling was not recognized, so the plugin could report the event in addition to
the managed settings copy. The suffix check now follows native Windows casing;
the finite command grammar, available interpreter check and exact script-byte
comparison remain required. POSIX matching is unchanged.

The pre-repair native case failed; 28/28 tests pass afterward across native relay
paths and the complete managed hook-delivery test file. Missing event registration
and different script bytes still do not suppress the plugin. The hook syntax and
source packaged-plugin version check pass. Both source plugin manifests are now
0.1.31 (source hash
`93fa63894ca2799955e397b26a43e5595c61d0221ab17895792066bc4e105b6a`).
This does not refresh the previously assembled 0.1.29 CLI plugin or installed
plugins. No live hook event, HTTP delivery, provider, seat or daemon was used.

The complete activity-relay script and pure Pi runner protocol module were also
reviewed. The latter retains explicit native environment handling and shared
state/argv builders; its native pane dispatch remains the adapter's responsibility.
Source review does not establish full live runner or hook integration acceptance.

### Bounded native Codex login-state probe

The default synchronous `login status` probe had no timeout. An owned npm-layout
fixture kept it waiting for its nine-second self-exit; the pre-repair timeout case
failed while the ordinary exit-zero/exit-one cases passed. Native login-state
queries now use the existing background Job Object helper with a five-second
bound, output still ignored, and exact helper cleanup. A timeout or ambiguous
helper exit 125 reports unavailable. Exit zero/one retain logged-in/signed-out
classification. POSIX probe execution is retained.

Nine tests pass across the owned native probe and complete home-fallback test
files: timeout, detached-child termination, ordinary login states, ambiguous exit,
and home selection. Daemon TypeScript checking passes. The failed fixture was
waited out using its finite self-exit, with no numeric-PID kill. Tests used owned
homes without auth files and an owned fake Codex; no installed provider, real
login, credential file, seat or daemon was accessed. Full native authentication
and provider integration remain open.

The complete rig-teardown source was also reviewed: existing ownership, unknown
probe and retained guidance/skill semantics remain. No teardown, service stop,
session mutation or cleanup of real material was executed; source review is
separate from actual native stop/restore acceptance.

### Native managed Claude capability-query descendants

The complete managed-launch module was reviewed. Its native `--help` query used
direct execFile timeout handling. An owned npm-layout fixture showed that an
ordinary child was already ended, but a detached, closed-stdio child remained
alive after the query timed out. That fixture had a finite self-exit and was
waited out after the failing pre-repair observation; no numeric PID was signaled.

Native capability queries now use the existing background-probe Job Object
helper, retaining the five-second timeout, isolated capability environment and
existing refusal message. Persistent seat launches are unchanged. The helper is
disposed after the query settles; POSIX query execution is unchanged.

The final owned help-query and complete Windows managed-launch test files pass
(23/23), including detached-descendant termination and successful actual help.
The first integrated run was 11/23: fixtures expected the direct executable
instead of the Job helper, or expected short-root spelling. The fixtures now
inspect the helper's selected command and use native canonical roots. Synthetic
API-key, permission, binding-change and argv cases pass; no real credential,
provider, conversation, seat, terminal server or daemon was accessed. Daemon
TypeScript checking passes. Live provider and full runtime acceptance remain open.

### Native skill-loadout ownership manifest publication

The loadout reconciler's explicit storage location accepts an ownership-manifest
path, but publication appended a UUID to its full filename. An owned catalog and
local Git fixture reproduced a failed projection with a valid 248-character
manifest filename. Windows publication now uses a short sibling staging file and
removes that owned staging file after publication or failure. POSIX staging names
remain unchanged.

The fixture passes first projection and refresh with exact file/manifest readback
and no staging residue. A read-only manifest refuses the update, preserves its
prior bytes, rolls the projected skill back, and leaves no staging file; restoring
the owned attribute permits the refresh. Three selected existing loadout cases
also pass for an explicit location, modified-target preservation and invalid
owner/manifest refusal. Daemon TypeScript checking passes. No installed skills,
real user project, runtime, seat, provider or daemon was accessed. This checks the
native manifest writer and selected existing contracts; full catalog/module and
live recovery acceptance remain open.

### Native seat-skill first creation filename limit

The existing-file replacement path already used short staging, but first creation
still appended a PID/timestamp to the complete destination filename. An owned
248-character filename reproduced a Windows first-write failure. First creation
now uses a short UUID sibling on Windows; POSIX staging and the exclusive hardlink
publication are unchanged.

Five native cases pass: first creation/replacement with readback and no staging
residue, preservation of a competing file created before publication, and the
complete existing native path cases covering casing, sibling/junction refusal,
record rehydration and preservation of edits. Daemon TypeScript checking passes.
Only owned temporary seat-storage fixtures were used; no installed skills,
provider, live seat, restore, delivery or daemon was accessed. Full skill-storage
module and live recovery acceptance remain open.

### Status, registry, readiness and native process-facts review

The current CLI status and host-registry modules, Pi readiness metadata reader,
Herdr viewer and native process-facts helper were read in full, including the
helper's PowerShell/C# implementation. This pass did not establish another native
implementation defect. Herdr ensure-viewer remains deliberately qualified only
for Linux 0.9.5/protocol 22; its existing refusal is not native support.

Three selected process-facts tests pass, with one marker-search test filtered.
Actual owned Node children verify cwd/argv, whitelisted homes, empty-HOME profile
fallback, batch observation, invalid PIDs and absence after exit. The batch also
observes the test-runner process. No all-machine marker search or console-member
census was run; no real registry, bearer, provider profile, remote endpoint,
running seat or daemon was accessed. Live fleet, console and timeout-lifecycle
acceptance remain separate from these checks and the source-only reviews.

### Bundle source preparation with native checkout aliases

The complete bundle-source module was reviewed. An owned injected-Git fixture
reproduced a valid in-checkout junction being refused as an outside repository
folder when a short-root checkout and its native long path were compared.
Windows now consistently uses native realpath for checkout roots, selected
folders, linked directories, referenced agents/packages and preset staging.
POSIX canonicalization is unchanged.

Three final owned native cases pass: selected-folder junction, contained agent
reference through the alias, and outside-checkout junction refusal with its target
unchanged and the failed import removed. CLI TypeScript checking passes.
The earlier combined run passed 36/42 (the initial native case plus 35 existing
cases); all six failures were fixture symlink EPERM errors. Those six remain
unverified, and junction coverage does not substitute for file-symlink permission.
No GitHub fetch, real Git remote, daemon request, bundle build/install, credential
or host workspace was used by the new fixtures. Full native import and preset
integration remain open.

### CLI and daemon legacy workspace defaults through native aliases

Both settings readers recognized old workspace defaults only by exact text or
normalized Windows separators. An owned fixture reproduced both readers keeping
the old `slices` path as a file override when it named the existing legacy default
through a junction and different casing, instead of deriving the current
`missions` layout. The same issue applied to the old steering-file layout.

Both readers now additionally compare existing paths using native realpath.
Exact/separator matching and POSIX behavior are retained; failed resolution does
not infer equivalence. The native fixture covers both old defaults, different
custom directories and an absent custom file. It fails in both readers before
the repair and passes afterward. With the complete extended CLI config tests,
112 tests pass; CLI and daemon TypeScript checking pass. This used owned files
and directories only, with no live home settings, workspace initialization,
daemon launch or restore.

The complete NodeLauncher source was also reviewed: native kept-pane takeover
requires a readable default shell before ending a process, and launch registration
retains its existing ownership checks. No real pane, seat, database, transcript
rotation or lifecycle operation was executed; this is source review only.

### Terminal, reconciliation and protocol review continuation

The current tmux executor, session reconciler, proof routes, SFTP protocol,
Claude seat switch, TUI workflow model and gate-lane entry were read in full.
This pass did not establish another native implementation defect in those files.
It does not establish acceptance of their dependencies or live integrations.
The existing real-server tmux transport and unseen-seat tests deliberately skip
Windows and cannot serve as native psmux evidence.

The existing TUI workflow command tests were run for native PowerShell literal
wrapping and retained POSIX quoting: two selected cases pass, 35 other cases were
filtered. The native case checks widths 24/40/80/160 with an owned receiver;
the POSIX case uses Git Bash. No workflow action, live TUI, daemon, seat,
provider, SSH subsystem, process census or gate-lane run was started. The retained
native source-path navigation and PowerShell rendering implementations remain in
this Draft; this pass adds bounded review evidence, not a new implementation claim.

### Native human-registry archive and sidecar names

A valid 240-character human entity id could be added, read and edited on Windows,
but removal failed when the archive timestamp extended its filename past the
native component limit. Native storage now uses a deterministic SHA-256 stem for
ids longer than 200 characters, leaving room for archive and orphan-record
suffixes. The logical entity id and external address remain unchanged. Existing
valid long-name fragments remain authoritative; projection validation recognizes
the native storage name, and readers can retain that name after a cross-host copy.
Ordinary names retain their existing layout.

The owned native fixture failed at long-id removal before the repair and passes
afterward through add, duplicate refusal, list/show, field/availability updates,
known-id diagnostics, forced archive with a synthetic orphan record, and re-add.
It also converts the new long-id fragment to an existing legacy filename before
editing/removing it. The `con` and `aux.person` cases already passed before this
repair; their storage behavior was retained. Three final native lifecycle cases,
62 existing registry/lifecycle/handle cases, and daemon TypeScript checking pass.
No real registry, contact, Slack connection,
queue item, delivery or daemon was accessed. Complete native gateway integration
remains open.

The package-build entry and scenario-executor test files also pass (9/9): owned
Node stand-ins, junction entry/import behavior, exit/deadline classification,
fake Docker argv/receipt, and remote-selection/settlement refusals. No actual
package build, Docker engine/container or remote host was started by these checks.

### Current Pi occupant record through native path aliases

The current-generation Pi record resolver still compared the managed runner entry
and state-root paths as case-insensitive text only. Two owned junction fixtures
reproduced a false unknown result when the process arguments and configured paths
named the same existing file or directory through different native aliases.
Windows now also accepts matching nonzero file identities with the expected
file/directory type. Existing exact-path behavior and POSIX matching are retained.

Both fixtures pass after the repair and retain refusal for a distinct entry/state
root and a mismatched launch id. The complete current-generation and Pi occupant
test files plus these fixtures pass (51/51); daemon TypeScript checking passes.
Process rows were injected and all
files were owned temporary fixtures: no live seat, conversation, process census,
model request or restore was accessed. This is a scoped record-selection repair,
not full native restore or live model-monitor acceptance.

### Native Slack state replacement filename limit

The durable dead-letter rewrite and channel/thread coverage checkpoints appended
`.tmp` to their destination filename. An owned native fixture with a valid
253-character filename reproduced a failed replacement because the staging
component exceeded the Windows filename limit. All three writers now use a
short UUID sibling on Windows, retaining the existing private-file creation and
metadata-preserving replacement helpers. POSIX staging remains unchanged.

The owned fixture covers dead-letter rewrite/empty rewrite and fresh plus repeated
channel/thread checkpoint saves, new-store readback, and no remaining staging
files. It failed before the repair and passes afterward. Together with the full
state-store, channel/thread recovery and concurrent-retry test files, 59 tests
pass; daemon TypeScript checking passes. No real Slack connection, delivery,
credential, queue, or running daemon was accessed. Full native integration and
the broader parity audit remain open.

### Front-door native commands-directory casing

The paired-TUI path resolver now recognizes the Windows `commands` directory
independently of its supplied letter case. An owned physical layout reproduced
`COMMANDS` returning no entry despite an existing paired TUI. The fixture now
checks source-layout selection, bundled fallback after removing that entry, and
null when neither exists. POSIX case behavior and source-before-bundled precedence
are retained. The focused check and CLI TypeScript check pass. No TUI entry was
executed and no daemon or terminal was contacted; interactive acceptance is open.

### Kernel runtime authentication probe timeout cleanup

The default kernel runtime probe now resolves native Windows provider commands
and runs temporary auth/version probes inside the existing kill-on-close Job,
instead of timing out only their cmd shell. An owned npm CLI fixture confirmed
that the old five-second timeout returned while its Node child remained alive;
the child's own finite timer cleaned up that baseline run. The corrected probe
returns unavailable and leaves no fixture child alive. Fixed probe argv, the
five-second limit, stdout/stderr authentication classification and POSIX behavior
are retained.

The initial fixture attempts lacked npm's dp0 setup and did not establish a
product failure; the valid-shim reproduction is the relevant baseline. Kernel
boot, tracker and native timeout files pass 52 checks; daemon TypeScript checking
passes. Only synthetic providers/config and owned subprocesses were used. No real
authentication, kernel team boot, provider invocation or deployment was performed.

### Current native Job and file-holder observations

At source head dfca7a642, the full focused Windows Job/file-holder fixture files
pass seven checks. These exercise actual owned native subprocesses: literal
argv/stdio/status, an explicit minimal child environment, owner/root/helper exit,
descendant cleanup and survival of an unrelated owned canary. Restart Manager
observes an owned open-file holder with creation time, then no holder after that
child closes; conflict-policy listener/daemon-record evidence is injected.

No existing daemon, real database, installed provider, or default psmux server is
operated by these checks. This establishes those bounded cases rather than every
Windows lifecycle condition. The separate ACP EOF/companion-cleanup limitations
are not cleared by these results.

### Static pack Git placeholders across native root aliases

The static-content resolver now canonicalizes Windows roots and indexed file keys
with native real paths. An owned Git fixture reproduced a placeholder silently
being packed as its relative target text when repository/source/reference paths
mixed native long and DOS-short spellings. The resolver now returns the actual
reference document bytes. Ordinary path-looking files remain ordinary content.

All five focused Node checks pass, covering SHA1/SHA256 indexes, edited and unmerged
placeholder rejection, outside-reference/junction escape/directory/missing-target
refusals, and the native alias regression. Syntax checking passes. Only owned Git
fixtures were used; the full package was not rebuilt after this source change.

### Compaction restore bridge transcript aliases

The shipped restore bridge now recognizes different Windows spellings of the same
existing transcript by device/file identity. An owned actual hook subprocess
reproduced a valid marker being ignored when its transcript was presented through
a directory junction and case alias. The bridge now delivers that marker once;
a distinct transcript is still refused even when the supplied session ID agrees.
Missing/unreadable additional identity evidence remains a non-match, POSIX behavior
and exact-spelling behavior remain unchanged.

The native alias fixture and full focused bridge-reader file pass nine checks;
Node syntax and daemon TypeScript checks pass. Both bundled core-plugin manifests
are advanced together to 0.1.30; the source-tree packaged-plugin version check
passes. The previously assembled package still contains 0.1.29 and was not mistaken
for the new source. No installed plugin, live transcript, provider compaction or
runtime deployment was changed; those acceptance boundaries remain open.

### Packaged plugin snapshot output names

The plugin-version snapshot CLI now stages through a short UUID sibling. An owned
minimal package archive reproduced ENOENT during publication to a valid 250-character
output filename because the previous UUID suffix exceeded the filename limit.
Snapshot creation, replacement and failure preservation now pass, with no temporary
residue. The documented ordinary snapshot-refresh case also passes (two selected
Node checks); the remaining symlink-oriented cases were not run in this selection.
Node syntax checking passes. The fixtures archive only owned synthetic manifests;
no published archive, release baseline or installed plugin was changed.

### Activation lens long destination filenames

ActiveLensStore now stages through a short UUID sibling instead of extending the
destination basename. An owned 250-character filename reproduced first-save failure
before the change. First save, replacement, reconstruction/readback and clearing now
succeed, with no staging files left. The existing Windows metadata-preserving update
branch remains in place. The full focused store files pass nine checks and daemon
TypeScript checking passes. No live workflow selection or user file was changed;
crash durability and full workflow activation acceptance are not established here.

### Shared private-file replacement staging names

Both synchronous and asynchronous Windows private-text replacement now use a
short UUID sibling staging filename. Appending the UUID to a valid 245-character
destination basename previously made private staging creation fail; the new
owned regression reproduces that failure before the change. The existing deep
Unicode directory fixture already passed and was not treated as a missing feature.

The focused private-file tests pass five checks: repeated sync/async replacement,
readback, no staging residue, opened-handle current-owner/private-DACL assessment,
deep Unicode paths and exclusive-create collision preservation. Daemon TypeScript
checking passes. Private creation still establishes and verifies its DACL before
writing content; publication still uses same-directory rename. Only synthetic
content in owned temporary paths was used, with no live configuration or credentials.

### Provider selection agrees with native OS executable paths

The Windows provider command resolver now returns native real paths for selected
executables and npm interpreter/script pairs. A real owned executable-path fixture
reproduced the previous mismatch: selection retained a DOS-short ancestor while
the injected OS process observation used the native long spelling, so the existing
exact process verifier refused the same selected executable. Canonicalizing the
selection fixes that mismatch without loosening executable or conversation checks.

Native executable identity, Claude/Codex npm selection, selected-script aliases and
the synthetic npm resume dispatch pass five focused checks; daemon TypeScript
checking passes. The resume fixture expectation was updated to the native path
contract. Sentinel executable files were never run; the resume dispatch uses its
separate owned synthetic Node entry. Real providers and OS process ancestry remain
outside these fixtures, and this change postdates the 1ba7 package build.

### Reconciled entry and file-transfer evidence

The finite candidate ledger now reconciles nine previously recorded implementation
areas against their retained raw reports: bin wrapper, ABI, setup, doctor, shared
TUI environment, desktop terminal environment, local Git context, native SFTP and
ACP connector. This is evidence reconciliation, not nine newly implemented features.
The full setup/doctor report is 123 passed; its later platform subset is 4 passed
with 119 filtered. The bin-wrapper report remains 4 passed and one actual file
symlink EPERM failure. The desktop-environment file has 8 passed; it must not be
presented as the larger aggregate. ACP's dotted-command report is 9 passed with
16 filtered, with the separately recorded companion-cleanup failure still open.

Current chatroom watcher checks pass 14 cases, including actual owned Windows
Node argv, with 17 real-tmux cases skipped because the version probe did not find
an available tmux executable in this invocation. No real watch, SSE connection or
psmux session was started. This does not prove native terminal transport.
The ledger has 97 unreconciled source candidates after this reconciliation;
these counts are neither confirmed-gap counts nor full feature acceptance.

### Current cumulative package build and transport review

The full actual Windows package build completed at source head
`1ba7a188babcd87579ba45c478cefa8c8f0a2a08`, from 02:54:18 to 02:55:04 UTC
on 2026-10-30 (exit 0). Tracked source was unchanged before and after the build.
This covers the cumulative recent implementation changes through the managed
runner alias correction, including daemon, UI, TUI, CLI and package assembly.
The artifact reports dirty because the protected untracked diagnostic remains;
that file was not read or published. This was not a new install or activation.

The cross-host executor's full focused fixture file passes 35 checks using
injected SSH subprocesses. Its local launch is argv-based; `sh -lc` belongs to
the remote POSIX login-shell contract, so it was not rewritten as local PowerShell.
This does not verify a real remote host or a Windows OpenSSH server's shell.
Herdr following remains explicitly qualified on Linux 0.9.5/protocol 22; its
remote tail command is not evidence of a missing local Windows tail executable.

The finite source-candidate ledger still has 106 unreconciled entries. That is
an audit accounting count, not a count of confirmed feature gaps. Source-only
reviews and this successful build do not establish full native acceptance.

### Pi, OMP and stub runner witness path aliases

Native managed-runner readiness now joins different entry, cwd and state-root
spellings when existing Windows filesystem objects have matching device/file IDs
and the required file/directory type. The prior slash/case spelling comparison is
retained; failed or unavailable additional identity evidence does not create a
match. An owned junction fixture reproduced false readiness for Pi, OMP and stub
before the change, and all three now pass.

The full managed-runner fixture file passes 22 checks, including distinct entry,
cwd/state directories, wrong launch, competing runner, missing native metadata,
recycled parent, changed pane, duplicate flags and failed census cases. Daemon
TypeScript checking passes. Filesystem aliases are real owned objects; process
rows and terminal observations are injected. No live runner, stock psmux, or
provider lifecycle acceptance is claimed.

### Selected npm Claude script aliases

Windows Claude process matching now accepts two spellings of the same selected
script only when an existing-file identity check establishes the match. An owned
script reached through a directory junction and filename-case alias previously
failed the exact string comparison; the regression now passes. Distinct scripts,
missing files, a different conversation token, and duplicate runtime candidates
remain refused. Exact spelling remains accepted as before; this is not blanket
case folding of script paths.

The alias fixture, Windows ancestry fixtures and npm resume-probe fixture pass
(18 checks). The alias fixture uses actual owned filesystem identity and injected
process rows; no installed provider or live process is inspected. Real provider
conversation and stock psmux acceptance remain open.

### Windows npm Claude resume-metadata probe

The default resume-metadata probe no longer rejects every recognized npm Claude
launcher merely because it has a Node script prefix. It renders the selected Node
and script into the native command and supplies both to the existing process
identity verifier, together with the exact resume token. The former early return
predated the verifier's selected-script support. Unverified process identity still
cannot establish a resumed or failed conversation.

An owned synthetic npm layout exercises actual PowerShell/Node dispatch and reads
back the resume argv. With injected missing identity evidence, the probe remains
inconclusive and its synthetic terminal cleanup is called. The focused check and
daemon TypeScript check pass. The terminal and identity evidence are injected;
this does not verify stock psmux, an installed provider, or a real conversation.

### Paired seat CLI paths containing percent and exclamation marks

The Windows seat-bin shim now doubles literal percent signs in its fixed Node/CLI
paths and disables inherited cmd delayed expansion. Previously a percent-bearing
paired CLI path was explicitly refused, preventing preparation of the managed seat
launch environment. A real owned cmd subprocess, with delayed expansion enabled
and a decoy variable defined, now invokes the exact synthetic paired CLI from a
directory containing both `%VARIABLE%` and `!VARIABLE!`. The existing native seat
launch fixtures also pass (3 checks total); daemon TypeScript checking passes.

The changed Windows shim has a versioned directory identity, so an older immutable
seat-bin directory is retained byte-for-byte rather than overwritten or rejected.
The fixture checks that preservation too. No live terminal, installed CLI, provider,
seat, or runtime deployment was changed. This does not establish arbitrary cmd
argument transport or live provider acceptance.

### MCP grant publication staging path

Grant-file updates now use a short UUID sibling staging name instead of appending
the UUID to the complete destination filename. An owned fixture with a 245-character
basename reproduced Windows private-file creation failing because the old staging
path was too long. With the change, adding and revoking a synthetic grant succeeds,
the final grant list reads back empty, and no staging or lock file remains. Failed
publication also removes its exact staging file in a finally block. The private
file creation and final permission handling remain in place. This is a file-update
check only; no MCP listener, existing credentials, external grant service, or live
authorization request was used.

### Direct daemon and log entry aliases

The active daemon and CLI log-tail entry guards now compare physical paths on
Windows, matching the runner correction. Node resolves an ESM module through a
junction while argv retains its launch spelling; URL-string equality can therefore
skip a directly executed entry. POSIX URL comparison and import-only behavior are
retained. The retired gateway-process entry is not activated by this change.

An owned log fixture exercises the actual TypeScript entry through a directory
junction and checks that importing the module does not read the log. The focused
log tests and CLI/daemon TypeScript checks pass. The daemon entry has source/type
verification only: this check does not start a daemon, change the deployed runtime,
or establish live fleet acceptance. Broader parity work remains open.

### Runner direct-entry identity through Windows junctions

Pi and stub runner self-invocation guards now compare native Windows physical
file paths. Their URL-string comparisons previously returned false through a
directory junction, causing direct execution to exit silently without running
the argument parser or runner. Actual compiled-entry subprocess fixtures
reproduce that silent exit and now get the expected missing-argument error
through both ordinary case aliases and owned directory junctions. Import-only
subprocesses still do not run main. Both fixture cases and the daemon workspace
build pass. The subprocesses have isolated homes and no required launch flags,
so they stop before state creation, provider lookup, credentials, or hooks.
No installed runner, fleet process, or real provider was started or restarted;
this does not establish full native runner lifecycle acceptance.

### Bare Pi/OMP native launch and resume dispatch

Pi/OMP fresh and resume paths now render bare Windows runner commands with the
current Node executable instead of sending POSIX quotes to PowerShell. This
covers OMP, Pi without a seat-environment wrapper, and Pi's pre-input
`launch_path_too_long` fallback. The fallback now remains a native command.
The POSIX command path and the selected seat-environment wrapper remain intact.

Three owned PowerShell/Node fixture cases pass, exercising fresh and resume for
Pi/OMP plus Pi route-refusal fallback, with exact cwd/model/session/launch-id
arguments. The runner entry/cwd include Unicode, apostrophes and metacharacters;
the synthetic session file respects the existing resume-token validation. No
installed provider, conversation, credentials, queue, or psmux server is used.
Daemon type checking passes. The broader three-file run has 44 passes and 15
failures in legacy adapter fixtures, including POSIX command-string assertions
and launch-id extraction incompatible with the native renderer. These failures
remain open; owned dispatch evidence is not live provider/readiness acceptance.

### Native stub runner launch dispatch

The stub adapter's production launch now renders a native Windows child launch
with the current Node executable and dispatches it through `sendShellCommand`.
It no longer types POSIX quotes directly into PowerShell or sends a second Enter
after the native shell-command dispatcher has already submitted the launch.
An owned PowerShell/Node fixture reproduced broken runner-path arguments before
the fix, then verified exact session, cwd, launch ID, posture, and resume arguments
with Unicode, apostrophes, spaces, and metacharacters. The POSIX launch path is
unchanged. The native launch and existing stub-adapter files pass 5/5 checks;
daemon type checking passes. The native fixture uses a fake runner and injected
terminal transport, not stock psmux or a live managed seat; full stub lifecycle
and native readiness acceptance remain open.

### QA fixture-home path casing

The CLI's path-only QA-home predicate now applies its existing Windows case
normalization to the `openrig-qa` name as well as the temporary root. Previously
an upper-case spelling of the same conventional fixture path returned false.
The compatibility tests pass with that alias, while sibling temporary roots,
ordinary temporary homes, and non-temporary QA-named paths remain excluded.
This changes fixture classification only; it creates no fixture marker and
does not start a daemon, run restore-check, or alter live home selection.

### Long read-only asset replacement

The packaged-asset replacement helper now reserves a short unique sibling
directory rather than extending the destination basename. Previously a valid
249-character Windows asset name exceeded the component limit when staged;
the in-place fallback then failed on a read-only destination. An owned fixture
reproduces that failure and now replaces the complete bytes twice while keeping
the source and destination read-only, without leftover staging directories.
Existing staging-failure fallback, collision ownership, partial-copy preservation,
and failed-replacement attribute restoration remain covered. Daemon type checking
passes; the replacement file has 10 passes and 2 retained file-symlink privilege
failures on this host. No installed assets or live runtime files were replaced.

### Database conflict records through Windows path aliases

Database containment and conflict-record resolution now use native Windows
realpath expansion. Previously a record naming an owned file by its long path
did not match the same file selected through its DOS short path, so even matching
holder and listener evidence failed to establish the conflict. The owned file
fixture now joins those aliases before applying the existing warn/stop/one-start
override rules. Missing holders and a listener naming another PID still do not
become confirmed conflicts. The fixture injects OS-holder and HTTP answers and
never opens its sentinel file as SQLite or contacts a real listener.

Daemon type checking passes. The three database test files have 25 passes and
one retained failure: actual file-symlink creation is refused with EPERM on this
host. The existing native directory-junction escape/absent-tail case passes but
does not replace that file-symlink evidence. No live database, daemon process,
conflict policy, or runtime deployment was changed.

### Hook CLI lookup for project-local npm installations

The shipped Windows hook CLI resolver now recognizes project-local
`node_modules/.bin/rig.cmd` launchers as well as the global npm layout and the
paired seat shim. Previously it searched for a nested `node_modules` inside
`.bin`, so an otherwise valid local CLI failed before a hook could invoke it.
The local layout resolves the declared OpenRig package entry through the hook's
Node interpreter, without executing cmd.exe. An owned fake CLI verifies literal
Unicode, spaces, quotes, percent signs, metacharacters, and empty arguments;
empty PATHEXT still disables suffix discovery and an unrelated shim is refused.
The helper passes Node syntax checking and the related native hook, paired-seat,
refocus, and plugin-refresh test files pass. This did not refresh installed
plugins, run a real refocus, send a message, or modify a live seat.

### Native destroy-plan target classification

The destroy planner now compares Windows paths with native relative-path
semantics instead of a POSIX slash prefix. Previously, backslash paths and
case/slash aliases of children under the state root were wrongly listed as
separate external deletion or backup targets. A pure planning fixture reproduces
that classification error and verifies that state children are covered once,
while sibling prefixes, parent escapes, and other drives stay external. POSIX
classification is unchanged. CLI type checking and both destroy test files pass.
The new fixture only builds plans with injected existence checks; existing
destroy tests use their owned scratch resources and injected lifecycle calls.
No user state, live daemon, terminal session, or real listener was destroyed or
stopped. Physical junction containment is not established by lexical path checks.

### Workflow guidance manifest aliases

Workflow guidance now recognizes Windows case aliases of `project.yaml`,
`mission.yaml`, and `slice.yaml`, deduplicates references by native physical path,
and compares bound-source attribution with that same identity. Previously an
explicit upper-case slice path could be silently ignored, and another spelling
of a bound source could lose its attribution. Owned authored-manifest fixtures
reproduce both defects and now preserve the explicit slice's narrower selection,
one attributed project source, and the first supplied spelling for display.
Two different project files remain ambiguous; no fallback catalog or selection
is invented. The complete workflow-guidance file passes 14/14 checks, and daemon
type checking passes. These are local synthetic authored files and Git/library
fixtures, not live workflow adoption, queue mutation, or provider acceptance.

### History fallback, recap continuity, and workspace preparation checks

The current history-query and recap durability implementations pass 31/31 checks
across the native history fixture, rig/session/seat history files, and recap
publication fault cases. The owned Windows fixture reads Unicode/CRLF logs and
JSONL after unavailable external search backends, preserves a final line without
a newline, and reports an unreadable session path. Recap checks retain the
readable current recap and predecessor chain after injected write, archive,
link, and replacement failures. No live transcripts or seat recaps were read.
This pass found no additional implementation gap in those checked cases.

An owned direct-entry check also confirms that workspace preparation still runs
when its Windows filename uses a different case, fails for a missing compiled
entry, succeeds once that entry exists, and remains import-only when a different
file has the same basename. The existing direct-entry implementation already
passes; no guard repair was needed. This does not establish complete package,
POSIX file-symlink, or live deployment acceptance.

### Selected core-plugin identity on Windows

Core-plugin selection now uses native Windows realpath expansion before comparing
directory identities. An owned plugin fixture reproduced a false absence when
the selected path used its long spelling and the vendored root used its DOS short
spelling. The fix covers both Claude and Codex selection and avoids appending the
same directory twice to the Claude plugin list, while a different directory stays
distinct. The focused native alias and path-list files pass 3/3 checks; daemon
type checking passes. No installed plugins, provider homes, or real database were
read or changed by the new fixture.

The broader core-plugin-load file is not green: the three-file run has 29 passes,
10 failures and 9 skips. Failures retain Windows-incompatible colon/relative-path
and mock-path assumptions, unavailable directory-symlink creation, two restore
warning serialization assertions, and a hook boundary-block byte comparison.
Those results remain open; the focused selection repair does not establish live
provider hook loading or complete fresh/restore/compaction acceptance.

### Windows TUI control identity through directory aliases

Windows TUI control endpoints now hash the physical parent directory identity,
including its nearest existing ancestor when the `run` directory is absent.
Previously, two paths through an owned directory junction produced different
named pipes for the same selected control path. An actual native-pipe fixture
reproduced that mismatch, then verified that an alias reaches the original TUI,
a second server cannot bind through the alias, creating the missing directory
does not change the endpoint, and a different socket basename stays distinct.
The pipe does not create filesystem socket directories; explicit pipe names and
POSIX endpoint paths retain their existing handling. Six socket test files pass
16 checks with 10 platform-conditioned cases skipped on Windows. TUI type
checking and the local TUI workspace build pass. This is owned temporary IPC
evidence, not live fleet/TUI adoption or named-pipe ACL acceptance. Updating an
already running older TUI to this endpoint scheme requires its normal relaunch;
this pass did not restart any user TUI.

### Dotted Windows ACP command names

ACP npm-agent resolution now tries the configured PATHEXT entries after an exact
dotted filename, rather than assuming any dot already names an executable suffix.
An owned npm-format `owned.agent.cmd` fixture failed to resolve as `owned.agent`
before this change. It now resolves to its declared Node entry and passes literal
protocol arguments through without a cmd.exe round trip. The existing Windows ACP
connector cases also cover dotted names in both global-style and local `.bin`
layouts, including a competing EXE when CMD has priority, recorded completion,
unchanged queue ownership, and the synchronous stop-command selection path.
An explicitly empty PATHEXT still suppresses suffix discovery; explicit shim
paths still work, and unrelated batch launchers are still refused. The selected
checks pass 9/9 (16 other cases filtered out); CLI type checking passes. These are owned fake agents and an in-memory queue, not live
provider, fleet, or real queue acceptance.

### Host identity sidecar staging filenames

The CLI host-binding writer now uses a short unique sibling staging filename instead
of appending a suffix to the destination filename. An owned native-Windows fixture
reproduced a first-observation failure for a valid 250-character sidecar basename;
the destination plus its lock name fit, but the old staging name exceeded the
filesystem component limit. The repaired case persists the original identity and
a later conflicting identity without replacing the original binding or leaving
staging files behind. The two host-binding test files pass 35/35 checks and CLI
type checking passes. This is local synthetic file evidence, without host probes,
live registries, credentials, or fleet activation; it is not complete Windows parity.

### Native local terminal recovery commands (2026-10-30)

The composed Windows tile already carried native argv, but its human-facing
recovery command still used POSIX quoting. An owned PowerShell process reproduced
a parser error on that old command. Native local recovery text now uses the
PowerShell invocation operator and literal quoting for the executable, selected
server arguments, attach mode and session. POSIX local and SSH-remote command
rendering are unchanged.

The initial fixture omitted the local host marker and failed before composition;
that was corrected before reproducing the actual old-renderer parser error.
Both read-only and writable recovery forms now read back the exact argv through
an owned PowerShell function, including apostrophes, Unicode and metacharacters.
These cases plus the complete terminal-service file pass 85 checks; daemon
TypeScript checking passes. No real tmux/psmux attach, terminal window or seat
was started, so native executable/provider acceptance remains separate.

### Terminal-view store long filenames (2026-10-30)

An owned valid 245-character view filename could be saved initially, but native
replacement failed when the store appended a UUID staging suffix to that name.
Both publication paths now use a short unique sibling staging name, retaining
the existing native metadata-preserving replacement helper.

The actual-file case failed before repair and now saves, replaces, re-reads and
removes the view with no staging leftovers. Daemon TypeScript checking passes.
This covers the store's explicit path constructor; the default fixed filename
was not itself a long-name failure. No real saved layout or terminal was touched,
and no provider/UI acceptance is claimed.

### Pi current-record native path aliases (2026-10-30)

An owned Pi JSONL file reported through its expanded long path was rejected as
outside its own session directory when that directory retained a DOS-short
spelling, leaving model reporting UNKNOWN. CurrentModelReader now supplies
native Windows realpath to both Pi record selection and effective-model reading;
POSIX resolution is unchanged.

The new actual-file case failed before repair and now returns the recorded
model and current Pi record. Its lineage, occupancy and runner sidecar are
synthetic, not a live provider observation. The existing returned-path assertion
was reconciled to the native canonical spelling while retaining the exact
runner/occupant checks. All 47 current-model-reader checks and daemon TypeScript
checking pass. No live transcript, process environment, seat or pin was read or
changed for these fixtures.

### Native settings fixture reconciliation (2026-10-30)

After the settings implementation repairs, the remaining settings assertions
were reconciled with native path semantics: derived defaults and the compaction
file suffix now use platform separators, and absolute paths are checked with
`isAbsolute` rather than a leading-slash expression. Explicit authored values,
configuration provenance, overrides and legacy-default expectations remain
asserted. No source behavior changed in this fixture-only batch.

The complete settings-store file plus the dedicated long-name/legacy-native
file now pass 82 checks with no failures or filtered tests. This supersedes the
earlier 75/81 run for these files only; it does not establish whole-daemon or
live configuration acceptance.

### Native settings creation and legacy separator matching (2026-10-30)

An owned settings file with a valid 235-character name failed on first creation
because its temporary suffix was appended to the full filename. The writer now
uses a short UUID sibling name, keeping the existing replacement and metadata
paths. Creation, update, fresh readback and staging cleanup pass.

A separate owned native case reproduced the daemon treating a persisted legacy
default written with forward separators as an explicit override. It now matches
normalized Windows separators, as the CLI twin already does; POSIX comparison
remains exact. Both dedicated cases pass after repair.

The earlier broader settings run, after the staging repair but before the
separator repair, reported 75 passed and six failed of 81. Those broader failures
remain recorded; no current whole-file green result is claimed. Daemon TypeScript
checking passed after the staging change. Only explicit synthetic settings files
were written, not the operator's real settings or running daemon configuration.

### Plugin migration long registry filenames (2026-10-30)

An owned obsolete-lab plugin whose hook registry has a valid 235-character
filename failed during migration: the writer appended its migration suffix to
the full registry filename. Migration staging now uses a short unique UUID
name in the same directory, retaining the existing private-file creation and
native metadata-preserving replacement paths.

The new case failed before repair and now removes the obsolete registration
and its empty manifest reference. The complete plugin-discovery test file and
daemon TypeScript checking pass. Only synthetic plugin roots were used; no
installed plugin, live hook, credential or seat was changed. Other full-path
and filesystem limits are not established by this component-length case.

### Project catalog cwd inference (2026-10-30)

The catalog reader had the same DOS-short/long path disagreement as registration:
an owned working directory inside a declared project was not recognized when
native expansion supplied its long spelling. The reader's selected-root and
cwd canonicalization now both use native Windows realpath; POSIX is unchanged.

The actual owned-directory case failed before repair and passes afterward. It
also reads an explicitly selected sibling project and confirms that two entries
for the same physical root still produce a project_required ambiguity with both
candidates. Daemon TypeScript checking passes. This is catalog-selection evidence,
not a live work-install or operating-posture acceptance result.

### Project registration physical-path identity (2026-10-30)

An owned existing project was refused as a same-ID/different-root conflict
when its projects directory was supplied through Windows native long-path
expansion while the catalog used a DOS-short temporary-root spelling. Project
root comparison now uses native Windows realpath, including the existing-parent
fallback for a not-yet-created folder. POSIX canonicalization is unchanged.

The new association case failed before repair and passes afterward, retaining
one project entry, both rig associations and the existing project contents.
The full file reports 23 passed and three failed of 26: two host-denied file
symlink cases and one POSIX permission-bit assertion remain unverified. Daemon
TypeScript checking passes. No real workspace catalog or running rig changed.

### Resume-file path review and diagnostics (2026-10-30)

The resume-token validator's native absolute-path diagnostic now names drive
roots and UNC paths; its native character diagnostic no longer shows the POSIX
character list for an ordinary Windows path. Accepted inputs, refusals and token
redaction are unchanged.

The validator, owned session-file alias fixture and session-fingerprinter files
pass 61 checks. Coverage includes native path format, physical same-file aliases,
refusal of a different resume file and a parent-file alias used as a fork child,
and avoiding an idle-terminal inference from a PowerShell wrapper. UNC format
acceptance is not a live network-share read. The alias fixture uses owned files
and synthetic runner state, not actual Pi/OMP conversations.

### Restore-packet long directory names (2026-10-30)

An owned 240-character packet directory name failed at `mkdtemp` because the
writer appended its staging prefix and random suffix to the full target name.
Long target names now use a short sibling staging stem; ordinary short names
keep their prior form. The target's name, contents, validation and rename
publication remain unchanged.

The new native case now emits all four required packet files, validates the
summary read back from disk and leaves only the target directory. The complete
restore-packet test file and CLI TypeScript checking pass. No real transcript,
retained recovery archive, fleet restore or provider session was read or changed.
This covers component length rather than all filesystem/full-path limits.

### Long proof artifact replacement names (2026-10-30)

The same staging-component failure was reproduced in proof artifact replacement
for both an existing and a new 234-character artifact name. Long target basenames
now use a short staging stem with the existing unique suffix; ordinary short
staging names and exclusive-open behavior remain unchanged. Both actual owned
write cases pass with content readback and no staging leftovers.

The two-file run reports 44 passed and three failed of 47, with no filtered
tests. The remaining failures are one host-denied file-symlink fixture and two
POSIX mode assertions; they are not waived or described as native ACL evidence.
CLI TypeScript checking passes. Full-path limits and restore-packet directory
staging still require separate review.

### File-editor long filenames (2026-10-30)

An owned 234-character filename can be created directly on this Windows host,
but FileWriteService's create and replacement paths both failed while opening
their staging file: appending the target basename to the temporary name exceeded
the filesystem component limit. Both staging names now retain only the existing
PID/random prefix. Same-directory staging, replacement metadata handling,
exclusive create and audit behavior are unchanged.

The two actual create/replace cases failed before the repair and pass after it,
with exact content/audit readback and no staging leftovers. Together with the
native-home fixture, four checks pass; daemon TypeScript checking passes. This
addresses component length, not every full-path limit or filesystem type, and
does not establish file-symlink privilege on this host.

### Dotted native requirement commands (2026-10-30)

The native requirements lookup treated every dot as a final executable
extension, so a requirement named `owned.tool` missed `owned.tool.exe` even
though Windows `where.exe` found it through PATHEXT. An inert owned-file fixture
reproduced that disagreement without executing the target. The lookup now
tries PATHEXT candidates after an exact dotted filename, retaining exact-file
precedence and the existing native PATH rules. The initial fixture assertion
was corrected to compare physical identities because Windows expanded its DOS
short temporary path; the product mismatch then reproduced independently.

Both requirements-probe test files and daemon TypeScript checking pass. This
proves lookup behavior and existing planner classification for owned fixtures,
not installation or execution of the located program. No system package manager
or installed provider was invoked.

### Provider switch platform guidance (2026-10-30)

The provider-switch help no longer says the Codex in-place path is Linux-only:
the current restart implementation also reads Windows process facts, argv and
the selected home. Help now names experimental Windows, the evidence-based
refusals and the absence of a default observer on other platforms. The missing
process-facts diagnostic names both implemented observers. This corrects stale
guidance only; no login switch, seat restart, credential read or live-provider
acceptance was performed for this edit.

### Ask-wake native timeout review (2026-10-30)

The suspected descendant-cleanup gap in `defaultWakeRunner` was not reproduced.
Actual owned Node fixtures cover both a hanging root with a descendant and an
already-exited root whose descendant holds stdout/stderr. With a bounded wake
timeout, both calls return and the recorded owned descendants exit. This differs
from the separately reproduced shell-wrapper profile-probe gap; no wake runner
implementation change was justified by these observations.

The new native cases, existing owned npm-provider argument fixture and wake
behavior tests pass, together with CLI TypeScript checking. The fixtures do not
wake installed providers, read real session files, or establish all possible
provider process lifecycles. Failed observations would clean up only their own
recorded PIDs; no fleet process was touched.

### Runtime profile probe timeout (2026-10-30)

An owned native Node probe that started a descendant reproduced a timeout
cleanup gap in `execRuntimeProbe`: `exec` ended its cmd.exe wrapper, but both
recorded fixture PIDs remained alive. The fixture's finally block ended only
those owned PIDs. The Windows path now reuses `boundedProbeExec` and its native
Job process ownership, passing through the requested environment and cwd.
The POSIX execution path is unchanged.

After repair the timed-out probe and descendant both exit, and the failure
carries `ETIMEDOUT`. Separate actual-child cases retain cwd, an explicit Unicode
environment value, stdin EOF, exit code 7 and stderr. These fixtures and the
adjacent profile-path binding file pass, as does daemon TypeScript checking.
Only synthetic owned programs ran: this does not establish installed provider
profile/authentication acceptance or change the running daemon.

### Spec launch command preview (2026-10-30)

The TUI's displayed spec-launch command now uses PowerShell environment
assignment and single-quote escaping on Windows. Previously it displayed a
POSIX environment prefix and POSIX apostrophe escaping even for native paths.
POSIX rendering remains available on POSIX hosts. The actual argv-based
launch process is unchanged.

An owned PowerShell process with a local `rig` function reads back the folder,
source and selected-host value, including Unicode, apostrophes and shell
metacharacters. The function consumes PowerShell's `--` delimiter; its presence
in the rendered command is checked separately. This is shell-rendering evidence,
not a real rig launch or a native npm-shim argument acceptance result. The
adjacent graph/launch/signal files and TUI TypeScript check pass.

### Codex Git metadata resolver review (2026-10-30)

The resolver already invokes Git directly with argv and checks that returned
metadata paths are directories. Native owned-repository checks cover an
ordinary repository, missing metadata, a linked worktree, malformed metadata,
and a separate metadata directory containing spaces: five selected checks
pass, with 21 other tests filtered out. The linked-worktree assertion previously
compared Git's long slash-separated path with Node's DOS-short backslash path;
it now compares native physical identities and still checks both directories.
No resolver implementation defect was established in these cases. This does
not prove native provider sandbox access, fresh/resume/fork launch acceptance,
or the POSIX unreadable-directory fixture on Windows.

### Generated-file Git hygiene paths (2026-10-30)

An owned native Git fixture exposed two path mismatches in generated-file
exclusion: Node's non-native realpath retained DOS short names while Git
reported long names, and native relative paths used backslashes while
`ls-files` reported slashes. The former caused out-of-repository pathspec
errors; the latter prevented exact tracked-file and sibling-conflict matches.
The writer now uses native realpath consistently and slash-separated Git
relative names. Its bounded inventory and shared-worktree conflict checks
remain in place.

The new nested tracked and sibling-user cases failed before the repair.
Ten selected native cases now pass, including an actual new-file exclusion,
tracked-file preservation, linked-worktree conflict preservation and a bare
clone's linked worktree. Eighteen tests were filtered out, not platform skips;
the daemon TypeScript check passed. The bare-worktree fixture reads Git's NUL
output to avoid its human-output quoting of Windows backslashes. No running
seat projection or whole-suite acceptance is claimed.

### Attach context argv (2026-10-30)

The default `attach` context probe now invokes `tmux` with an argument array,
rather than sending POSIX-quoted text through the host shell. In particular,
Windows no longer passes literal single quotes around the pane target and
format. The existing injected string executor remains available for callers
that provide their own tmux socket routing.

Five selected context tests passed (nine other tests were filtered out), and
the CLI TypeScript check passed. This establishes argument construction and
response parsing, not an actual stock-psmux attachment or multi-session routing
result. Those native integration cases remain open.

This table is a navigation map for the continuing parity review, not a claim
that every feature or source file has been assessed. The detailed receipts
below retain their own head, scope and limitations. Public source changes do
not activate the running daemon or seats.

| Area | Current implementation/evidence | Remaining work or evidence limit |
| --- | --- | --- |
| Pane identity and runner readiness | Native process census and owned PowerShell/Node positive/negative fixtures | Stock psmux end-to-end launch/restore acceptance remains incomplete |
| Native pane shells | PowerShell/pwsh plus bounded cmd-to-PowerShell staging; owned cmd/runner lineage and Pi record-selection checks | All-provider cmd lifecycle and stock psmux visible-terminal acceptance remain incomplete |
| Codex, Claude, Pi and OMP launch selection | Selected homes, native npm layouts, frozen/declared Claude Node identity and retained in-place entry, argv, Pi RPC fixture, Pi/OMP child-cwd fixes | Synthetic programs do not prove real provider conversations; cold/provider lifecycle and installed-provider acceptance remain incomplete |
| Configuration, profiles and file replacement | Native private-file helpers, DACL preservation and selected actual writer fixtures | File-symlink cases denied by this host remain unverified; this is not an exhaustive writer audit |
| Seat skills, plugins and workspace catalog | Native path comparisons, record/replay checks, plugin env readback and catalog registration fixtures | Remaining consumers and integration paths still need review |
| Compaction and restore packets | Native packet discovery, root/grant/prompt alignment; related enforcer checks 63/63 | Real provider compaction/restore acceptance remains incomplete |
| MCP and local IPC | Actual IPv6 tool call, stdio EOF, separately asserted native forced termination and owned named-pipe drain checks | These checks do not establish whole-runtime acceptance |
| Native package assembly | Source-stable actual build at cc5971d53; isolated native npm install, SQLite ABI and installed rig.cmd daemon-module consumer passed | Artifact is dirty=true; subsequent-source assembly, all-provider and whole-runtime acceptance remain separate |
| CLI/TUI regression | Isolated check pinned to `a2d903d9b2097e1da2d31b7244d9a79a8d1a7741`: 7,202 tests, 7,031 passed, 94 failed, 77 pending; source stable | TUI: 1,183 passed, zero failed, 21 pending. CLI: 5,848 passed, 94 failed, 56 pending. This older frozen source does not validate subsequent changes |
| Native platform acceptance | Windows Terminal paths and selected native OS fixtures have individual receipts | Full visual focus, suspend/reboot, all-provider and installed-package acceptance remain incomplete |
| Runtime-specific upstream limits | Existing Rex refusal and Linux-qualified Herdr behavior are retained | Do not erase those limits or describe an optional patched psmux protocol as stock 3.4.0 support |

The active task still includes finding and filling feasible implementation gaps,
then verifying the requested scope. A frozen regression run is independent of
ongoing source work; it must finish and confirm source stability before its
counts are used. No final completion comment has been posted for this review.

## Native attach identity output (2026-10-30)

The attach consumer emitted only POSIX export statements from --print-env,
which cannot set identity in native PowerShell. It now defaults to PowerShell
assignments on Windows and retains sh elsewhere, with explicit --shell sh or
--shell powershell selection. Only the two existing identity variables are
printed; JSON/credential behavior is unchanged. The human instruction names
the selected shell rather than universally prescribing eval.
Three selected checks pass: default command output, explicit sh compatibility
and actual owned PowerShell application with Unicode/apostrophe/metacharacter
values retained literally. CLI typecheck passes. Other attach cases were
filtered; no real attachment, provider or queue was changed. The separate tmux
context probe still needs native argv review and is not marked complete here.

## Setup/doctor capture platform propagation (2026-10-30)

Setup and doctor selected a platform for their checks but omitted it when
calling the isolated capture probe, which then used the test host's platform.
Both consumers now pass their selected platform, so native checks consistently
use NUL and POSIX checks /dev/null. The doctor platform check fails before the
correction; all four selected setup/doctor cases pass afterward, with other
cases filtered. CLI typecheck passes. Commands are injected, not executed.
The isolation contract is retained: [psmux 3.4.0 main](https://raw.githubusercontent.com/psmux/psmux/v3.4.0/src/main.rs)
implements -L as a namespace and scopes kill-server to it. This source review
is not new native multiplexer startup/capture acceptance; no real server was
started, queried or stopped for these consumer checks.

The subsequent complete setup/doctor run initially passed 121/123. Two doctor
daemon-root fixtures compared POSIX path strings with native resolved paths;
they now build expected paths with the native path module. Both complete files
then pass 123/123, including prior behavior beyond the four selected capture
cases. This supersedes the filtered-only scope for those files, while keeping
their injected command/probe and no-real-server limits.

## Native bin-wrapper selection checks (2026-10-30)

The bin-wrapper file originally reported three file-symlink creation failures
and one passing command-load failure check. Two interpreter-selection tests
inject identity resolution and do not consume the wrapper link; their fixtures
now use inert regular files and the native node.exe basename on Windows.
An additional owned directory-junction case verifies physical package entry
resolution without requiring file-symlink privilege. The complete file now
reports 4/5 passing: paired-entry resolution, both interpreter selections and
JSON/human command-module-load failure pass; the real file-symlink case still
fails with EPERM and is retained. No interpreter was re-executed or real CLI
installation changed by these fixtures; file-link acceptance remains separate.

## Native ABI script entry identity (2026-10-30)

Invoking the installed ABI script through the Windows-equivalent basename
CHECK-ABI.mjs (retaining Node's lowercase .mjs extension) silently skipped the
addon check and exited zero. Its entry guard mixed a naive file URL with a
case-sensitive filename suffix. It now compares real file identities. An owned
fake-addon failure is observed through that entry, and an independent file named
check-abi.mjs can import the module without accidentally running the install
check. Both actual Node-process checks pass 2/2. The existing Vitest ABI unit
file fails to load with Invalid or unexpected token on both baseline and changed
source, so no unit-case passes are claimed from it. The installed cc5971d53
receipt above predates this guard change; subsequent package acceptance remains
separate. No installed user package or global CLI was modified.

Follow-up isolated the Vitest load failure to this entry's CRLF shebang:
changing only its working-tree line endings to LF restores all 17/17 ABI unit
checks. The current Vite loader's hashbang matching does not consume CRLF as
expected before its transformed wrapper. A narrow .gitattributes rule now
keeps this exact script LF on Windows; Git reports index/working-tree/attribute
agreement. The two actual Node entry/import checks still pass 2/2. This
supersedes the unit-load limitation above without removing the shebang,
weakening ABI checks or changing dependencies.

## Native ACP command and process checks (2026-10-30)

The current stdio peer, native npm command selection and native process-identity
files pass 9/9. Checks cover ordered protocol progress/results, original error
data, permission-request response identity, method-not-found, real owned child
exit/detach, selected PATHEXT and creation identity becoming unavailable after
the owned child exits. No installed provider or actual queue was used. These
checks do not prove stdout-EOF handling while an agent remains alive: an
attempted synthetic fixture did not independently establish EOF, and its
uncommitted implementation changes were withdrawn rather than counted as a
verified repair. Full ACP provider/detach lifecycle acceptance remains separate.

Six selected connector checks also pass: actual owned offline npm agent runs
through global/local and explicit/PATH layouts with exact arguments, unrelated
batch refusal, and missing-program failure/exit registration (15 checks
filtered). The complete connector file reports 20/21: its surviving-companion
case fails during owned cwd cleanup with EPERM. An exited-PID wait and bounded
deletion retries did not resolve that failure; its cause remains unknown and
the attempted cleanup changes were withdrawn. Full connector acceptance is
therefore incomplete; no real queue, provider or external process was changed.

## Native local-copy physical overlap (2026-10-30)

An owned junction-parent dry-run reproduced a missing overlap refusal: lexical
source/target comparison admitted a destination physically below the source.
The fixture stops on that preview assertion before attempting any recursive
write with the old implementation. Native directory copies now resolve the
source and existing destination ancestors before checking overlap, including
destinations not created yet. Both preview and actual execution refuse the
overlapping target with source bytes/tree unchanged. A separate owned junction
parent outside the source still permits a real successful copy. Complete native
local-copy/path files pass 10/10, and CLI typecheck passes. This is a pre-operation
filesystem identity check, not an atomic namespace/race guarantee; no user
source tree, shared checkout or external link target was copied or changed.

## Native SFTP consumer and replacement refusal (2026-10-30)

The complete native SFTP protocol/copy files pass 5/5 against the installed
Windows OpenSSH subsystem launched only over owned process pipes. They cover
actual recursive upload/download, Unicode names, dry-run, extra-file retention,
idempotence, replacement, malformed framing, bounded silent handshake, file
timestamps and exclusive creation. An added readonly-destination download case
asserts failure, unchanged original bytes, the retained complete staging file
and the explicit staging hint when Windows refuses replacement. The owned
fixtures are removed after their checks. These checks do not exercise an SSH
network connection, authentication, Linux server permissions or privileged
Windows file-symlink creation, and change no remote host or user files.

The readonly replacement check then exposed a diagnostic mismatch: a native
local rename failure was classified remote-command-failed. SFTP copy now uses
the existing local-copy-failed result for Node filesystem errors carrying a
local path/syscall, while retaining SSH-missing, transport and remote-status
classifications. The actual readonly check failed on the old classification;
both complete native SFTP files pass 5/5 afterward, and CLI typecheck passes.
Original/staging bytes and the retention hint remain asserted.

The file-command consumer already passed failedStep/hint through, but its
help described only ssh/rsync and its empty-stderr JSON fallback blamed rsync
even for native transfers. Help now describes native SFTP, recursive copy and
Windows local drive/UNC operands; the fallback says file-copy failure. The
complete command file passes 10/10, including injected SFTP/native-local
failures preserving transport, classification, hint and exit status without
inventing rsync argv. CLI typecheck passes; these command-layer checks create
no connection or file transfer.

## Native Git context update consumer (2026-10-30)

The current complete Git-context file passes 8/8 on native Windows using owned
local Git repositories and filesystem selections. It covers canonical checkout
root selection, a real two-parent merge preserving local/upstream content,
conflict retention with both parent identities and unchanged served bytes,
dirty/edited selection refusal, unavailable remote/checkout handling, explicit
pack discovery, junction refusal and detached-update refusal. No new product
correction was needed for these checked paths. This does not establish remote
authentication, HTTP shallow transport or actual agent context consumption;
no existing user checkout or remote repository was changed.

## Native installed package and shared TUI environment (2026-10-30)

The actual package build at cc5971d5307d689954af6780ac6a3d7c8e5a2aed
completed with exit zero and matching head/tracked-diff snapshots before and
after. The protected untracked diagnostic remains in place, so dirty=true is
the correct artifact identity. The target-native install gate subsequently
built/packed the same source, installed dependencies into an owned npm prefix,
opened an in-memory SQLite database through the installed ABI checker, and
invoked the installed rig.cmd through PowerShell. Its daemon-backed local
gateway-human add wrote the expected synthetic fragment in an isolated home.
The selected gate passed 1/1 in 70 seconds. Its own prefix/home/tarball were
cleaned; no global CLI, actual daemon, messaging connection or seat was used.

Review then found shared-TUI attachment cleared only the exact key TMUX from
a copied environment. An actual native Node child still received an owned
mixed-case Tmux value. The attachment environment now removes native-cased
aliases on Windows while retaining POSIX case semantics and unrelated values.
The native child check failed before correction; it and the complete adjacent
shared-TUI file pass 7/7 afterward. CLI typecheck passes. This is environment
consumer evidence, not a real psmux attachment or visible-terminal acceptance;
the installed cc5971d53 artifact predates this subsequent source change.

The desktop terminal launcher had a separate exact-key deletion. It and shared
TUI now use one detached-terminal environment helper. An actual child launched
through defaultWindowDeps.exec verifies mixed-case old context is absent and an
unrelated synthetic value is retained. The complete native Windows terminal,
preview, shared-TUI and child-environment files pass 25/25; CLI typecheck passes.
Desktop window opening and eligibility remain injected in the window fixtures;
no real window or multiplexer session was opened by these checks.

## Native activity self-report verification (2026-10-30)

Four current activity-rung checks returned null because the injected reader
split filenames only on `/`, while the production reader joined native paths.
The fixture now uses the host basename operation. An additional owned real-file
check uses the default reader in a path containing spaces, selects the latest
matching seat record and ignores a newer foreign-seat record. The complete
activity-adapter-rungs file passes 12/12. No production activity behavior was
changed; this does not attest undocumented provider file formats or inspect
actual seat/provider records.

## Native agent-image display names (2026-10-30)

The actual image install/scan roundtrip failed for the supported display name
`model: fast`: Windows cannot create that directory component. Image installation
now generates a stable SHA-256 directory key for names with Win32-invalid
characters, reserved device names, trailing dots/spaces or oversized components.
The key prefix is reserved by encoding literal names using it as well, avoiding
aliasing a generated key. Ordinary directory names and POSIX behavior remain
unchanged. The manifest name, public image ID and scan lookup preserve the exact
operator identity; existing images are not migrated or renamed.
The complete roundtrip file passes 18/18, including native device/trailing-name
cases, generated-key/literal-name separation and duplicate-install refusal.
Daemon typecheck passes. These use owned synthetic images, not provider
conversations, real resume tokens or deployed image libraries.

## Native bundle target-name collisions (2026-10-30)

Owned native filesystem checks reproduced case-only target aliases across all
five bundle routers. Image/workflow/plugin/skill routing counted both entries
as routed and overwrote the first target; context routing retained the bytes but
reported kept-existing rather than a same-batch conflict. Native routing now
compares target names without case and retains the first successful entry,
reporting conflict for the later one. POSIX target-case behavior is retained.
All five actual filesystem checks pass after failing before their corrections;
the first target's exact bytes are asserted. Daemon typecheck passes. The older
two image/context mock-router files remain 8/25 passing at their preceding
observation: their mock sets use POSIX absolute paths while the consumer resolves
native paths. That incomplete regression evidence is not a claim of whole-router
or installed-bundle acceptance. No operator libraries were changed.

The two mock-router fixtures now resolve their filesystem keys and expected
paths using the native path module, including content lookup and member listing.
Their missing-source, source-type, manifest-type, basename-conflict,
kept-existing, already-installed and substance-refusal cases now reach their
intended consumer branches on Windows. Both complete files plus the five actual
native target-collision checks pass 30/30. This supersedes the 8/25 fixture
observation above; installed-bundle and real provider acceptance remain separate.

## Native bundle integrity path keys (2026-10-30)

The current owned bootstrap fixture reproduced seven failures when a bundle
assembled using native Windows `walkFiles` paths was unpacked using archive
paths: identical nested members were reported as extra. Integrity production
and comparison now use slash-separated archive keys, retaining native file
access paths. Existing route walkers already emit archive paths; this also
admits native filesystem walkers at the shared integrity boundary.
The integrity/bootstrap pair passes 86/86 after the correction. A subsequent
explicit native-to-archive and archive-to-native check, including tampered
content refusal, passes with the complete integrity file (10/10). Daemon
typecheck passes. Bootstrap uses owned bundles, SQLite and scripted launch
adapters; it does not launch installed providers or deployed seats.

## Native seat skill storage replacement (2026-10-30)

An actual `writeInsideSeatStorage` update replaced an owned protected skill's
DACL with inherited parent access. Existing native files now stage privately and
use the metadata-preserving Windows replacement helper. The storage containment
checks, POSIX path and exclusive hard-link publication of new files remain intact.
The owned native fixture fails before the correction and passes afterward,
including readonly refusal with original bytes/access retained and no staging
files left behind. One selected check passes (21 unrelated checks filtered out),
and daemon typecheck passes. No real seat storage was changed.
Five broader storage/ownership files report 82 tests: 67 passed and 15 failed.
Thirteen failures occur while creating privilege-dependent symlinks and two
assert POSIX executable mode bits on Windows. Those failures are retained;
this run does not establish complete native ownership/symlink acceptance.

Directory-link fixtures now explicitly use native Windows junctions (POSIX
directory symlinks elsewhere), while file-link cases still require actual file
symlinks. Permission assertions compare actual source/before modes rather than
requiring POSIX executable bits on Windows. The first ownership rerun passes
39/44, with three file-link privilege failures and two further mode assertions.
After correcting those two assertions, the selected Claude/Codex junction
projection checks pass 2/2 (42 other checks filtered). These prove owned
directory-reparse-point refusal; they do not replace file-symlink evidence.

## Packed native TUI and delayed terminal input (2026-10-30)

The real package-entry check previously required POSIX execute bits on a JavaScript
file and a privilege-dependent directory symlink. Windows now uses the declared
Node entry and an owned directory junction; POSIX keeps its executable-mode check.
The fixture also consumes rendered stdout rather than leaving a pipe unread.

An actual packed-entry run reached a mouse split 2/22 timeout. Source inspection
found that the 50 ms bare-Escape timer also flushed already recognized incomplete
CSI/SS3 sequences, leaking their remaining parameters into command input. Only a
lone Escape now arms that timer; recognized prefixes retain delayed chunks. The
fixture retains the intentional lone-Escape timeout contract (20 ms gap immediately
after Escape, 80 ms after a recognized prefix). Input-stream and adjacent usability
checks pass 22/22. The complete build, npm pack, extracted Node entry launch and
all delayed arrow/page/mouse split checks then pass on native Windows. The build
was based on 109809850 with these working changes and correctly reports dirty=true;
it is not a clean-head artifact, installed npm shim or visible-terminal acceptance.
No real daemon, seat, multiplexer session or system clipboard was used.
The subsequent complete TUI regression reports 1,205 tests: 1,184 passed, zero
failed and 21 pending. It ran against these unchanged TUI source files while the
receipt/commit metadata was updated, so it is scoped regression evidence rather
than a source-stable whole-checkout acceptance run.

## Provider selected PATHEXT (2026-10-30)

The shared native Codex/Claude resolver used a fixed extension order, while
Codex seat launch discarded the selected environment except PATH. An owned
selection fixture failed with EXE before COM. The resolver now reads native-cased
PATHEXT, preserves its order and explicit empty value, and defaults only when
undefined. Codex seat selection receives the complete selected environment.
Ten adjacent checks pass, plus two actual PowerShell/offline npm Codex launches
with a COM decoy and CMD-first selected PATHEXT (canonical and mixed-case keys).
Daemon typecheck passes. These fixtures do not invoke installed providers or
establish support for arbitrary script extensions.

The separate Claude background executable locator also had the fixed order.
Its owned selection fixture failed before the same native PATHEXT treatment;
it now retains explicit empty selection and Windows empty PATH entries. Six
checks pass, including an actual offline npm auth command selected ahead of a
COM decoy, native home/environment readback and owned process-tree timeout.
The daemon typecheck passes. No real authentication or credential file is used.

The token-usage reader separately dropped PATHEXT while constructing its
credential-isolated environment. An owned synthetic-token/offline-program probe
failed before the correction. Selection and execution now share the daemon's
native-cased PATH/PATHEXT without copying unrelated environment variables.
The complete token-usage file reports 23 tests: 21 passed, one pending, and one
file-symlink creation denied by this host (EPERM). The new actual consumer check
passes and daemon typecheck passes. No real token or provider turn was used.

## Missing multiplexer guidance and scenario limit (2026-10-30)

CLI startup preflight and doctor previously offered only macOS/Linux installation
instructions when tmux was missing. Both now share native Windows guidance to
install psmux, expose its tmux.exe alias on PATH and verify it from a new shell,
with the experimental support limits linked. The doctor missing-dependency
checks pass for Windows and macOS (two checks); CLI typecheck passes.

The frozen grant-service scenario's missing-tmux failure uses hermetic-env.ts,
which writes a POSIX shell wrapper with a private `tmux -S` socket. That fixture
does not establish native psmux daemon startup behavior. Its private-socket
isolation must not be bypassed to make it run against an operator server.
Native scenario acceptance remains incomplete; no fleet process was changed.

The setup consumer had a separate readiness defect: on Windows a missing tmux
was marked skipped because Homebrew was unavailable, leaving no required
multiplexer failure for the ready calculation. An injected native setup check
failed before the correction. Setup now records a failed required dependency
with the same psmux guidance; it does not run Homebrew or install software on
the host. The complete setup test file passes after the correction.

Windows setup also always wrote `.tmux.conf`, which psmux ignores when an earlier
native config exists. It now selects the first existing `.psmux.conf`, `.psmuxrc`,
`.tmux.conf`, or `.config/psmux/psmux.conf`, retaining `.tmux.conf` as the creation
fallback. An explicit native-cased PSMUX_CONFIG_FILE wins; NUL disables this
write. Only the selected config is inspected for the custom-config note.
This follows the [psmux 3.4.0 configuration contract](https://raw.githubusercontent.com/psmux/psmux/v3.4.0/docs/configuration.md).
Five injected setup cases cover precedence, fallback, explicit selection and
disabled configuration, with unselected bytes retained. The complete setup
file passes 73/73 and CLI typecheck passes. No user configuration was changed;
these are setup-consumer fixtures, not real multiplexer startup acceptance.

Further source reconciliation aligns the Windows setup home with psmux's
USERPROFILE-first selection, then the OS account profile, then the existing
HOMEDRIVE/HOMEPATH fallback before HOME. Explicit config paths expand a leading
tilde; an explicitly empty override is reported without writing a fallback file.
Sources: [psmux profile resolver](https://raw.githubusercontent.com/psmux/psmux/v3.4.0/src/paths.rs)
and [config loader](https://raw.githubusercontent.com/psmux/psmux/v3.4.0/src/config.rs).
The setup fixtures now give HOME and USERPROFILE different values and verify
the native profile wins, including mixed-case copied keys. Added tilde and
empty-override cases pass; the complete setup file passes 75/75 and CLI
typecheck passes. These are isolated consumer checks, not fleet activation.

## Native Codex plugin CLI invocation (2026-10-30)

The runtime adapter's default plugin installer still used bare execFile("codex"),
which cannot execute npm's Windows cmd shim. It now uses the same selected
native/package command resolver as other Codex consumers, preserving its result
shape, environment and existing timeout. An owned offline npm program verifies
exact plugin arguments (Unicode, spaces, quotes, metacharacters, empty and
trailing-backslash arguments) and selected CODEX_HOME. Empty PATHEXT returns a
missing-command result. The adjacent owned-hook-trust checks and native CLI
fixture pass; daemon typecheck passes. No installed Codex, real login or plugin
installation was used, and native plugin registration acceptance remains separate.

## Native HTTP readiness ports (2026-10-30)

An owned loopback HTTP service on port 6000 reproduced a native compose
readiness failure: fetch rejected the request before it reached the service.
The POSIX curl path does not impose fetch's browser port restriction. The
Windows branch now uses Node HTTP/HTTPS requests with the same bounded deadline,
2xx/3xx verdict, no redirect following and immediate response-body disposal.
Owned ephemeral and port-6000 fixtures verify success, redirect non-following,
503 refusal and timeout, alongside TCP checks. Daemon typecheck passes. No
Docker service, remote target, installed provider or fleet process was used.

Expanded owned checks pass 5/5: IPv4 ephemeral, IPv4 port 6000 and IPv6 loopback
each exercise HTTP/TCP and the shared evaluateWaitTargets consumer's healthy
and unhealthy results. This consumer supplies boot gating and environment
receipt capture; the fixtures do not start Docker or prove a complete service
orchestrator lifecycle. Redirect non-following and bounded hangs remain checked.

## CRLF proof judgment receipts (2026-10-30)

An owned receipt produced by recordJudgment, converted only from LF to CRLF,
was rejected as incomplete by the ledger reader. Its frontmatter fences now
accept either line ending. The actual read/replay check retains the judgment
identity and receipt bytes, and a subsequent payload edit still produces an
unknown result with the changed-judgment error. Existing payload hashes,
sequence, correction lineage and policy checks remain in place. The adjacent
judgment/policy suites and daemon typecheck pass. Only synthetic project
receipts were used; no workspace judgment or evidence was changed.

## Native permission diagnostic command selection (2026-10-30)

The production permission observer still checked a fixed COM/EXE/BAT/CMD list,
reporting a synthetic CMD as available even with explicitly empty PATHEXT.
The actual observer fixture reproduced that mismatch. Native diagnostic lookup
now reads PATHEXT with native key casing, defaults only when undefined and
retains Windows empty PATH entry semantics. The fixture checks Claude, Codex,
Pi and OMP without executing any of them; extension-named directories stay
unavailable. Adjacent observer/diagnostic checks and daemon typecheck pass.
This is command-path observation, not evidence of runtime enforcement or login.

## Pi runner selected PATHEXT (2026-10-30)

The Windows Pi resolver still hardcoded EXE before CMD. The actual offline Pi
runner fixture failed with an EXE decoy and CMD-first PATHEXT. The runner now
passes its native-cased PATH/PATHEXT to the resolver, which retains selected
extension order, defaults only when undefined, accepts native COM/EXE and
continues to require the recognized npm package/shim for CMD. Unsupported
script candidates are refused. The real runner now reaches its READY handshake
with the owned offline npm program; explicit-empty extension selection is also
checked. Related checks report 10 passed and six POSIX skips, with daemon
typecheck passing. No installed Pi, provider conversation or fleet seat changed.

## OMP selected native extension order (2026-10-30)

OMP's native resolver likewise fixed EXE before COM. Owned native witnesses
reproduced both ignored order and ignored explicit-empty PATHEXT. The resolver
now retains the selected native extension order with case-aware environment
lookup, defaults only when absent, and still excludes batch/script shims under
OMP's existing native-only contract. Actual copied Node witnesses execute from
relative PATH as EXE and COM under isolated child homes; no OMP or provider is
invoked. Adjacent OMP checks and daemon typecheck pass.

## Native workspace-relative proof evidence (2026-10-30)

The actual evidenceAt consumer rejected an owned workspace-relative Windows
`missions\\...` path by resolving it under the slice instead of the workspace.
It now recognizes the native separator for that existing workspace-relative
prefix, while retaining canonical slash references, identical evidence hashes
and the existing realpath containment check. The regression verifies native
and canonical spellings resolve to the same evidence identity. Selected proof
checks and daemon typecheck pass; this adds no file-symlink acceptance claim.

## Native fresh-server clipboard defaults (2026-10-30)

The Windows defaults applier unconditionally skipped clipboard configuration
using a psmux 3.3.8 limitation. [psmux 3.4.0 lists set-clipboard](https://raw.githubusercontent.com/psmux/psmux/v3.4.0/docs/configuration.md).
The applier now attempts it on each freshly created session's independent
psmux server through an explicit exact target. It never uses the unscoped
POSIX server write or the once-per-daemon memo. Unsupported-option failures
remain nonfatal launch warnings. Scope fixtures verify two fresh targets,
actual adapter argv and failure reporting; daemon typecheck passes. No running
session or system clipboard was changed. Real native copy/paste acceptance
remains unverified; source support and mocked transport are separate evidence.

## Staged successor option warnings (2026-10-30)

The staging successor consumer discarded fresh-session option warnings.
It now returns them through the existing notes channel alongside prepared
materials/runtime notes; an unsupported native clipboard option remains
nonfatal. A complete staged-success fixture reproduces the missing warning
before the fix, then verifies both notes survive. The initial incomplete
fixture lacked staged.prepare and is not the causal baseline. Successor,
ordinary launcher and defaults checks pass 84/84; daemon typecheck passes.
No live handover, running session or clipboard was changed.

## Native-cased seat status home projection (2026-10-30)

SeatStatusService read copied HOME and runtime-home variables by exact key,
misreporting the configured home for Windows case variants. Its actual status
projection fixture failed before using the shared native environment reader.
It now reports Codex/Claude daemon selections with native key casing and keeps
canonical empty selections authoritative over duplicate variants. The older
home-source fixture now constructs platform-native paths instead of comparing
Windows-resolved paths to POSIX literals; member/daemon/default precedence and
relative-home refusal checks remain. The complete file passes 12/12 and daemon
typecheck passes. Status remains configured next-launch context, not login or
running-process proof; no seat or authentication file changed.

## Seat status native-profile fallback (2026-10-30)

Startup pins the launch HOME to os.homedir(), but status previously inferred
the native runtime home only from the shell HOME. A status fixture reproduces
the mismatch with missing/empty HOME or a different MSYS-style HOME. Production
status now uses the same OS home fallback as startup; explicitly supplied
environment fixtures select Windows USERPROFILE before HOME. Explicit runtime
home variables and seat/account precedence still win. The complete status
file passes 13/13 and daemon typecheck passes, without reading credentials or
changing any live launch environment.

## Observed process empty-HOME fallback (2026-10-30)

An owned native Node child with empty HOME and a synthetic USERPROFILE
reproduced defaultResolveHomeDirByPid returning an empty string. The Windows
branch now falls through empty HOME to nonempty USERPROFILE, and returns
undefined when neither is usable. Explicit nonempty HOME still wins. Native
process-fact and Codex thread-id checks pass, with daemon typecheck passing.
Only the owned child was observed/stopped; no authentication file, existing
provider process, thread database or fleet session was read or changed.

## Restart and native-turn empty-home consumers (2026-10-30)

The default Windows restart IO still projected empty HOME over USERPROFILE;
the owned process fixture reproduced that independently of the thread-id
resolver. It now uses the nonempty observed profile. Restart preflight,
shell-backed relaunch, peer-home reporting and native-turn lookup also let
empty CODEX_HOME fall through to the observed HOME's default .codex directory.
No nonempty selection is replaced. Adjacent process/restart checks report
148 passed and one pending; a separate added public-service plan fixture
passes with empty CODEX_HOME and records no stop/relaunch effects. Daemon
typecheck passes. Native logs, credentials and signals in that plan are mocked;
only the separate owned native child is actually observed and stopped.

## Verified native directory aliases in restart plans (2026-10-30)

The public restart-plan consumer rejected the same owned Windows Codex home
under alternate separators as settings drift. Windows comparisons now accept
identical normalized spellings, or positive directory identity from nonzero
BigInt file IDs on the same device. Case folding alone is not proof; unreadable
or distinct directories remain different. This is used for restart cwd/home
drift and peer-home reporting; POSIX retains exact comparison. Owned-directory
plans verify slash aliases, native case aliases and refusal of another
directory before any stop/relaunch effect. The full restart file reports
146 passed and one pending; daemon typecheck passes. Only temporary directory
metadata was used; credential and conversation reads in the plan remain mocked.

## Native heartbeat proof-path recognition (2026-10-30)

The read-only heartbeat analyzer ignored timestamped proof notes containing
Windows backslash paths. Owned queue fixtures reproduced this for drive paths,
UNC paths and relative backslash paths. The Windows recognizer now accepts
native absolute paths and separator-normalizes only its path-shape check;
the reported reference retains its original spelling. Complete heartbeat
checks pass 11/11 and CLI typecheck passes, with queue bytes unchanged.
This remains declared proof-note classification, not artifact verification,
completion or delivery evidence. No heartbeat, message, timer or real queue
was started or changed.

## Actual native assembly and remaining linked gates (2026-10-30)

The actual package builder completed on Windows at source
3305fd1511040317bbb0019fd9065b47ea9c5551, from 00:11:40 to 00:12:32 UTC on
2026-10-30. Head and tracked-diff hash matched before and after. Daemon, UI,
TUI and CLI compiled and assembled. The artifact correctly reports dirty=true
with the retained untracked diagnostic; that material was neither read nor
moved. The packaged wrapper reports 0.7.1 (3305fd15, dirty), and the actual
assembled openrig-core 0.1.29 passes the released-plugin version gate.

The accompanying packing/content checks report 14 passed and three failed;
all three failures occur creating host-denied file symlinks and remain
unverified. This is actual source assembly and dry-run file-selection evidence,
not clean-head installation, npm publication or runtime activation.

Further entry review found the same linked-path silent-success defect in the
packaged-plugin version checker, gate verdict consumer and scenario executor.
Owned junction fixtures reproduce all three returning zero without handling
invalid input. Real-path entry identity fixes them while imports stay inert.
Four related script files pass 21/21. The fixtures use a local empty Git repo,
missing verdict and invalid scenario operation; no real gate is consumed and
no Docker invocation is made. The assembly above predates these source edits
and is not presented as their package acceptance.

## Linked native build and guard entrypoints (2026-10-30)

Three script entries compared module and argv URL strings: package build,
workspace build preparation and first-run reference checking. Actual directory
junction invocations reproduced successful exit without executing their work.
They now compare real file paths, matching the existing guard entry convention;
imports without an entry remain inert. Build selection, asset rules, help
generation and reference validation logic are unchanged.

Owned linked-root fixtures exercise ordinary and preserve-symlinks-main Node
invocations. The package-build fixture uses an owned Node executable standing
in for Git Bash and a recorder instead of builds/npm/install. Workspace
preparation actually copies fixture assets and derives help from its fixture
command factory. The reference checker reports missing fixture surfaces rather
than passing silently. Six related script files report 26 passed, zero failed
and one existing file-symlink privilege skip. No real package build, installation,
publication, daemon or seat change is claimed by these tests. Clean-head full
package/install acceptance remains separate.

## Active IPC, bounded shutdown and private observer review (2026-10-30)

At source 3d002eaaaa8f3b1d867a75e43800b3a13bd28d63, complete Windows daemon
control, bounded shutdown and occupant-shadow integration files pass 36/36
with no pending cases. This review required no additional production change.
The native pipe cases refuse inherited-access control directories, reject a
stale instance identity, accept the current identity and preserve a successor's
capability when closing its predecessor. An owned child crosses the production
startServer drain with fixture services and persists its clean outcome receipt.
Other cases retain timeout/failed outcomes, repeat-signal behavior, private
exclusive sink creation and shared-parent refusal using synthetic observations.

The gateway Unix-socket transport/spawn modules are explicitly retired in place;
they were not made production callers or revived for Windows. Herdr's existing
Linux qualification remains. Private observer canonical-parent restrictions were
retained rather than relaxed as a supposed portability repair. These checks do
not restart the deployed daemon, enable a real observer, read real captures or
establish reboot/suspend/complete provider lifecycle acceptance.

## Native browser launcher system path (2026-10-30)

The browser launcher still depended on bare powershell.exe being on PATH.
Windows UI opening now resolves the fixed system PowerShell path from the
selected SystemRoot with native environment-name lookup. URL literal encoding,
hidden bootstrap and POSIX launcher selection are unchanged.

An owned PATH without system tools reproduces bare PowerShell startup failure.
The generated absolute launcher starts real PowerShell with the same environment
and passes an injection-shaped Unicode URL intact to an in-script Start-Process
witness. That witness records the URL instead of opening an application. Complete
browser/UI checks pass 16/16 and CLI typecheck passes. No browser, real UI page,
daemon or terminal window was opened; default-browser association acceptance is
still separate.

## Native chatroom watcher entry (2026-10-30)

`chatroom watch --tmux` handed the new session a bare rig program. Windows
cannot directly spawn npm's rig.cmd as a native executable. The Windows watcher
now supplies this Node executable and its paired CLI index entry as separate
arguments. The POSIX watcher and existing session-name/semicolon encoding stay
unchanged; no shell command string or alternate CLI lookup was introduced.

An owned cmd-only PATH reproduces the direct-spawn failure. Substituting only
the CLI entry with a recorder then proves actual native child argv for Unicode,
spaces, apostrophes, percent expressions, operators and a dash-led rig name.
No command from the inert cmd decoy executes. Three related files report 68
passes, zero failures and 17 pending real-tmux cases because bare tmux is
unavailable; CLI typecheck passes. This is child-entry/argv and command behavior
evidence, not stock-psmux watcher-session or full SSE lifecycle acceptance. No
actual chatroom, daemon, psmux session or conversation was opened or changed.

## Generated seat CLI through native hooks (2026-10-30)

SeatLaunchEnvironment places a daemon-paired rig-only bin before the launch
PATH, but the native hook resolver admitted only npm-style rig.cmd shims.
The actual generated seat shim therefore failed with ENOENT while the hook
looked for node_modules under seat-bin. The resolver now recognizes that exact
generated command form, its run/seat-bin/path-hash layout, this Node interpreter
and the paired package's declared CLI entry. It invokes Node plus that entry
directly; it never executes or broadly interprets the batch file. These are
layout/metadata checks, not package-authenticity attestation.

An owned fixture uses the real seat generator, then the real hook resolver and
refocus child to obtain content from an offline paired CLI. Literal arguments,
empty argv and cwd are retained. Wrong directory digest, extra batch text,
another interpreter, a changed declared entry and an unrelated package are
refused. Native npm/PATHEXT behavior remains covered by the adjacent fixtures.
Five hook/environment/plugin/trust files pass 48/48 and daemon typecheck passes.
The complete context collector file also passes 54/54 at the inspected source;
that observation required no additional product change. No installed CLI,
provider, real hook, daemon or work seat was invoked or changed.

## Native plugin migration and skill-ignore replacement (2026-10-30)

Retiring obsolete plugin hook registrations and rewriting managed skill ignore
files retained POSIX mode bits but lost existing Windows access policy. Owned
fixtures reproduce both failures through actual PluginDiscoveryService and
Codex/Claude skill reconciliation. Existing regular Windows files now use
private staging and metadata-preserving replacement. New/final-link and POSIX
paths, migration ordering and skill ownership/admission rules remain unchanged.

The skill fixture first lets reconciliation generate its managed ignore file,
then protects that file and switches the selected skill. An unmanaged ignore
file is still refused; its earlier fixture refusal was not a permissions bug.
Three native ACL cases pass, checking both migrated plugin files, resulting
skill contents, retained access and idempotent follow-up (18 other ACL cases
filtered). Complete plugin discovery/wiring checks pass 27/27 after replacing
two Windows-path regex assertions with literal native-path assertions. Skill
loadout checks pass 46/47; the remaining case fails at host-denied file-symlink
creation before its boundary is exercised. It remains unverified. Daemon
typecheck passes. Only synthetic plugins and owned Git fixture repositories
were used; no installed plugin, real skill catalog or running seat was changed.

## Native Slack durable-state replacement (2026-10-30)

Actual dead-letter replacement, channel checkpoint updates and thread checkpoint
updates lost an existing protected Windows DACL. Their common production disk
adapter now stages replacement text privately and preserves the existing regular
destination's metadata. Append semantics, injected filesystems, new/final-link
publication and POSIX behavior retain their existing paths. No delivery, retry,
coverage initialization or checkpoint algorithm changed.

All three protected-store cases fail before repair and pass afterward. A fourth
native case verifies that a readonly-current refusal retains owed events, the
write generation and original access, leaves only private staging, and can
finish cleanly after the fixture removes its readonly flag. Four native cases
pass (14 unrelated ACL cases filtered). Daemon typecheck passes.

Complete state-store, channel recovery, thread recovery, concurrent dead-letter
retry and torn-append files pass 72/72. Two fixture portability defects were
reconciled: memory filesystem keys now normalize host separators, and the
owned HTTP server registers its already-bound loopback origin before use. The
request guard remains unchanged. No Slack API, real message, queue, connector,
coverage checkpoint or retained event was read or changed.

## Native recap continuity and exclusive-create errors (2026-10-30)

An actual authored recap supersession lost the protected access policy in its
predecessor archive. Windows recap staging and archives now establish private
current-SID access before content is written, including the exclusive-copy
fallback when hard links are unavailable. Existing current recaps use the
metadata-preserving replacement helper; their selected access policy remains.
Archives are private snapshots, not clones of arbitrary predecessor policies.
POSIX publication, collision naming, predecessor bytes and rollback rules remain.

This exposed a second Windows parity defect: private exclusive creation
reported a generic subprocess error for an existing file. The native creation
script now identifies only the actual Windows file-exists errors; synchronous
and asynchronous callers receive EEXIST. A large rejected input separately
reproduced stdin EOF masking that result. Async creation now settles from the
process result before considering its input-pipe error; it does not retry.

Complete recap store/durability checks pass 30/30, including same-timestamp
collisions, unsupported-hard-link fallback, partial-copy and publication-failure
cleanup. Exclusive-create and native long-path checks pass 4/4. The complete
native atomic ACL file passes 14/14, including actual recap supersession and a
readonly-current refusal that preserves current bytes/access and rolls back
the new archive. Daemon build and typecheck pass. These are owned fixtures;
no real recap, seat, handover, provider or daemon was changed.

## Existing operator-store access preservation (2026-10-30)

Active workflow lens updates and saved terminal-view save/remove operations
used rename-only publication, losing an existing Windows file's access policy.
Both actual stores reproduced the loss on owned protected-DACL fixtures. Their
existing regular Windows files now use private staging and the established
metadata-preserving replacement helper. New files, final-link entries and POSIX
writes retain their existing behavior. No store's data schema changed.

The two native cases fail before repair and pass afterward, checking repeated
updates, returned/readback state, unchanged protected access and no staging
residue. Ten unrelated cases in that ACL file were filtered, not platform
skipped. Complete active-lens and terminal-provider/store checks separately
pass 54/54; daemon typecheck passes. Only owned test stores were changed; live
operator selections, views and desktop windows were untouched. Other history
and continuity stores still need their own review.

## Hook rig dispatch selected PATHEXT (2026-10-30)

The packaged hook's standalone rig resolver still searched COM, EXE, BAT and
CMD in a fixed order. It now reads selected PATHEXT using Windows environment
name rules, retaining its order and explicit empty value; only an undefined
selection receives the conventional default. Native executable and recognized
npm entry admission remain unchanged, with no arbitrary batch execution.

Two real owned npm child launches exercise canonical and mixed-case PATHEXT
with CMD before an inert COM decoy, preserving literal arguments and cwd. The
same fixtures check COM-first selection and refusal under empty PATHEXT.
Complete adjacent rig-hook, native environment, plugin refresh and owned-hook
trust checks pass 47/47; daemon typecheck passes. No installed rig CLI, live
hook, queue or provider was invoked, and no running plugin was refreshed.

## Native desktop system-tool selection (2026-10-30)

Windows Terminal opening no longer needs PowerShell's directory or System32 on
the caller's PATH. Desktop-session discovery, `where.exe` terminal discovery and
the fallback tile bootstrap use absolute system-tool paths under the selected
SystemRoot. This entry also uses Windows environment-name lookup for SystemRoot,
CI and SSH markers. An owned PATH containing only a non-executable `wt.exe`
discovery witness exercises real PowerShell and where.exe. Window launch and
desktop eligibility remain mocked; the witness is never executed.

The three native/composition files pass 29/29, daemon build and CLI typecheck
pass. A separate four-case POSIX TUI preview file still fails because it invokes
an unavailable bare tmux executable on this host; it is not included in that
passing count. No actual desktop window, real psmux session or conversation was
opened. Full visible-terminal acceptance remains incomplete.

## Native authored cwd expansion (2026-10-30)

The shared authored-cwd resolver now expands a leading `~\` on Windows and
looks up `$VAR`/`${VAR}` using the existing platform environment rules. Thus
native backslash home paths and mixed-case Windows environment names reach the
same expansion path used by launch, profile resolution and preflight. POSIX
backslash names remain literal; unset references remain written and explicitly
empty values remain empty. Existing literal directories still take precedence.

Owned temporary directories cover both literal precedence and absent-literal
expansion. The complete cwd-expansion and cwd-dot-prefix files pass 20/20 and
daemon typecheck passes. Older assertions now compare native resolved paths
or normalize equivalent slash spelling; no live seat or host environment changed.

## Native restore precondition path coverage (2026-10-30)

Restore pre-validation recognized only slash-led, tilde and forward-slash
relative paths. A required built-in re-anchored to a native drive path could
therefore be missing without blocking restore. The shared path recognizer now
accepts native absolute paths, Windows absolute paths (including UNC), and
backslash relative paths. Existing replay eligibility and refusal order remain
unchanged; the same recognizer covers startup owners, projected resources and
Compose paths. Four missing-required-file cases cover drive, UNC and both
relative backslash forms without reading host resources.

The complete restore-preconditions and restore-orchestrator files pass 337/337;
daemon typecheck passes. Six earlier restore failures were native-path fixture
issues; the seventh exposed this product defect. The Codex continuation fixture
also now supplies a host-absolute CODEX_HOME. Separately, built-in re-anchoring
expectations use native path joins and pass 32/32. These are owned fixtures and
restore mocks, not a fleet restart or full native-runtime acceptance.

## Claude adapter native fixture follow-up (2026-10-30)

The 21 Claude runtime-adapter failures in the expanded observation below are
now reconciled without changing product code. The in-memory filesystem treated
native backslashes and fixture forward slashes as different keys. Its I/O
boundary now normalizes using the host path rules while preserving the fixture's
logical store spelling. The role-warning assertion uses the host-native target.

Argument tests keep the actual POSIX shell on POSIX. Windows instead parses the
literal builder output through the production parser, then runs the resulting
arguments through the production PowerShell renderer and an owned Node argv
witness. The same injection-shaped tokens, whitespace, apostrophes, launch
additions and dash-led values must reach the child as exact arguments; they are
not merely compared against a second string builder. No installed Claude runs.

The complete claude-runtime-adapter.test.ts file now passes 110/110 without
skips, including projection, role separation, permission fragments and retained
npm prefix cases. The initial corrected fixture run had one remaining warning
path assertion, subsequently fixed. This supersedes that file's earlier 21
failures only; the seven restore-orchestrator diagnostic failures below remain
for follow-up, and full native acceptance is still incomplete.

## Native npm continuation retains interpreter and script (2026-10-30)

The in-place restore path previously carried only a verified executable. For
npm Claude that executable is Node, so losing its script could launch Node with
provider flags or select another installation. Windows continuation capture now
uses native argv parsing and carries both the verified interpreter and declared
npm script into the continuation binding and legacy resume tail. Managed launch
accepts this explicit pair, rechecks its declaration, and freezes both files
without consulting PATH for a replacement. Classic fresh/resume command builders
also retain the quoted script operand before provider options. Native identity
observations receive the same pair.

The real restore-orchestrator consumer uses owned package metadata and supplied
native process rows to prove both fields reach the adapter. The offline npm
managed fixture retains its pair after PATH no longer names an installation;
classic prefix checks retain the original conversation. The final four-file
retained-entry selection passes 117/117 without skips, and the separate classic
adapter case passes with other cases filtered. Daemon type checking passes.
No actual process is stopped or live seat restored by these fixtures.

Expanded observations remain non-green: the earlier four-file observation has
224 cases, 203 passed and 21 failed in claude-runtime-adapter.test.ts (including
missing /bin/sh and projection assertions). A separate diagnostic started before
later classic edits reports 424 cases, 396 passed and 28 failed, including seven
restore-orchestrator failures; it is not an exact-final-source acceptance run.
Those failures are retained for follow-up, not waived. This entry proves the
observed running-seat continuation path, not cold provider/reboot acceptance.

## Existing npm Claude processes use declared-entry identity (2026-10-30)

An existing Windows npm Claude process need not have a current in-memory frozen
launch. Native identity now recognizes its Node/script path only when the script
occupies the official npm package layout and equals the package manifest's
declared Claude bin. The manifest must identify @anthropic-ai/claude-code, be a
regular file within the bounded size, and declare a relative contained entry.
Unreadable, mismatched or escaped declarations remain unknown. This reads entry
metadata; it does not prove package authenticity. Explicit frozen selections
retain priority and are not replaced by layout discovery.

The Node OS executable name/path and argv[0], ancestor creation ordering,
unique candidate and conversation argument gates remain. A node foreground
label alone is insufficient. Actual owned Node processes exercise both frozen
and declared-entry modes, with wrong script/interpreter/token, competing row
and changed-package-name refusals. The final six-file identity/managed/adapter
selection passes 101/101 without skips; daemon type checking passes. No real
provider or deployed session is touched. Foreground values remain test seams.

This fills the recognized-layout unselected identity gap below. Preserving the
observed script/interpreter pair through recorded-entry restore is still a
separate incomplete consumer; installed-provider acceptance also remains open.

## Frozen managed npm Claude launch and native identity (2026-10-30)

Managed Windows Claude launches now use the existing recognized npm package/shim
resolver when PATH selects that installation. Both the interpreter and script
are resolved and frozen; capability discovery invokes Node with the same script
prefix as the actual launch command. Script-file identity participates in the
existing context recheck, so a changed entry is refused before dispatch. Native
EXE/COM selection and unrecognized-batch refusal remain. The resolver accepts
the launcher's explicit platform for copied environment lookup.

Native identity has an explicit selected-script input, paired with the frozen
interpreter. Only an OS-named Node process with matching executable/argv[0] and
the exact selected script at argv[1] can use that path. Existing ancestry,
creation-order, unique-candidate and exact conversation checks still apply;
the script operand is excluded from the conversation-option parser. The managed
Claude adapter carries this selection into its readiness/occupant observations,
and the managed Windows resume adapter carries it into its exact identity check.
Ordinary Node processes without that explicit selection remain unknown.

An actual owned Node/script process fails identity before the repair, then passes
with negative cases for other scripts, interpreters, tokens and competing rows.
A separate recognized offline npm fixture performs the real capability query
and generated PowerShell launch, preserving literal arguments and rejecting a
changed script. The final five-file managed/identity/adapter selection passes
84/84 without skips; daemon type checking passes. A separate wrapper/native
lineage selection passes 40/40. No installed Claude, real login, conversation,
stock psmux session or deployed seat is used. Foreground-command fields are test
seams; unselected legacy/adopted npm identity, recorded-entry recovery coverage
and installed-provider lifecycle acceptance remain incomplete.

This supersedes the earlier managed native-only refusal for a recognized npm
installation; arbitrary batch launchers remain refused.

## Explicit empty Claude config selection reaches background commands (2026-10-30)

The Claude auth reader only applied a truthy config-directory option. An explicit
empty selection could therefore leave an inherited different directory in place,
contrary to the existing empty-versus-unset launch semantics. It now applies
every defined selection, including empty, through the existing native key
replacement helper. This removes case-variant inherited copies on Windows.

The native fixture fails before the repair, then runs an owned Node child through
runClaudeCommand and reads back the empty config value and selected working
directory. Complete Windows Claude reader and empty-launch-path files pass 5/5
without skips; daemon type checking passes. No installed Claude, real account or
credential is used. Separately, the complete session-transport and draft-aware
delivery regression after the native input-path repair passes 391/391 without
skips. Neither result establishes native visual or all-provider acceptance.

## Native paths in recorded-client input-box layouts (2026-10-30)

The Codex status/path footer and fresh-session path rows in both clients only
recognized home/POSIX prefixes. Windows drive and UNC paths therefore prevented
the supported input-box layouts from being recognized. These exact layout slots
now also recognize absolute drive paths with either separator and UNC paths
with a server/share. Drive-relative and incomplete UNC locations remain unknown.
The path hint does not bypass client-version, layout, turn, queue or draft checks.

Recorded Codex/Claude fixtures are explicitly edited to native paths, not claimed
as new Windows captures. Before the repair, native Codex idle cases fail. Afterward
both complete native-path/input-box files pass 225/225 without skips; daemon type
checking passes. Cases cover idle and exact staged text, populated drafts staying
unknown, invalid location refusal, and native Claude fresh-session headers. The
initial new draft expectation was corrected to the existing unknown result;
production draft semantics were not relaxed. No provider, paste, Enter or live
terminal is used, so native visual acceptance remains incomplete.

## OMP identity registration accepts the same native file (2026-10-30)

The activity identity route still required literal equality between an OMP
session-file report and the runner sidecar. It now uses the same native regular
file identity check as resume verification. Session/runtime agreement, current
registered occupant generation, materialized history and operator-provenance
priority remain separate requirements. The original reported token spelling is
preserved; this does not rewrite durable generation/CAS comparisons elsewhere.

An owned actual NTFS hard link reproduces tokenPersisted=false before the repair
and true afterward for the same history. The complete route/generation/alias
selection passes 26/26 without skips; its existing different-file, retired
generation, runtime mismatch and protected operator-token cases remain active.
Daemon type checking passes. All requests use the local test app and temporary
SQLite/files; no deployed route, real session or provider is invoked. Hard-link
evidence is distinct from the directory-junction evidence below and does not
establish file-symlink acceptance.

## Native session aliases preserve resume and fork identity (2026-10-30)

Pi-family resume verification and OMP launch verification compared session-file
strings, so native aliases of the same history could be refused. The shared
fork guard could also accept an alias of the parent as a distinct child. These
consumers now retain exact matches and, only on Windows for differing paths,
require both operands to be existing regular files with the same nonzero native
file ID and volume. They do not infer identity from lowercased spelling or equal
contents. POSIX comparisons and unavailable-file behavior remain exact.

An owned actual directory junction and session file reproduce the restore
failure before the repair. The fixture drives OMP launch, its inherited Pi-family
resume consumer, parent-alias fork refusal and different-file refusal with
launch-scoped synthetic sidecars. File contents stay unchanged. That fixture
plus the complete OMP adapter file pass 6/6; the separate Pi runtime-adapter file
passes 51/51; daemon type checking passes. No provider or real runner starts.
Directory junction evidence does not establish file-symlink or full provider
restore acceptance. The requested pi-resume.test.ts operand does not exist; the
51-case receipt covers pi-runtime-adapter.test.ts only.

## Native session tokens accept literal short-name tildes (2026-10-30)

The native Pi/OMP session-file format validator rejected a literal tilde, even
though Windows 8.3 path components such as USERNA~1 contain it. Native absolute
paths now admit that character without expansion. Relative ~/ paths, traversal,
device namespaces, alternate data streams and existing metacharacter refusals
remain rejected; POSIX token character rules are unchanged.

Owned Pi and OMP local route fixtures write a temporary session file with a
literal tilde path, reproduce HTTP 422 before the repair, then verify exact SQLite
token persistence without token content in responses/events or changes to file
bytes. A separate format fixture covers the 8.3 spelling. This does not create
or prove a distinct filesystem short-name alias. Both complete route/validation
files pass 38/38 without skips; daemon type checking passes. No real session,
provider, credential, live daemon or deployed task is used. The before selection
contained two failures and 13 filtered cases, not platform skips.

## Managed native PATHEXT remains selected through launch (2026-10-30)

The selected PATHEXT participated in native executable lookup but was absent
from the capability environment and could later be forwarded from a different
pane environment. Windows managed launches now include an explicitly selected
PATHEXT (including an empty value) in the frozen context and capability query,
and exclude pane/seat forwarding of that managed key. Other existing pane-owned
environment channels retain their behavior. POSIX environment handling is unchanged.

The new fixture fails before this repair at the capability environment assertion.
Afterward it launches an owned copied Node executable through the generated
PowerShell command with a conflicting pane PATHEXT and reads back the exact
selected value. Both native managed/selection files pass 23/23 without skips;
daemon type checking passes. The capability answer is an inert mock; the child
is an offline witness, not an installed provider or live seat.

## Managed Claude native selection honors PATHEXT (2026-10-30)

When no prior executable was frozen, ClaudeManagedLaunch searched only for
claude.exe. Its Windows native lookup now follows the supplied PATH/PATHEXT
ordering, including COM and an explicitly empty extension list. An existing
batch entry selected ahead of a native executable produces an explicit refusal,
rather than silently selecting a different executable. A recorded executable
still bypasses PATH lookup and retains its existing frozen-file checks. This
does not add npm batch support to the managed native launcher.

An owned native fixture fails before the repair, then verifies COM selection,
selection-order drift invalidation, empty-list refusal and batch-first refusal.
Both managed-launch and provider-selection files pass 22/22 without skips;
daemon type checking passes. The capability query is mocked in this selection
fixture; no installed provider or deployed seat is started. The separate actual
native EXE/COM process-chain evidence above remains independently scoped.

## Native COM discovery hints match supported executables (2026-10-30)

The pane discovery fingerprinter still recognized EXE provider names but not COM,
despite the native launcher and identity consumers supporting both. Its Windows
branch now recognizes exact Codex/Claude COM basenames, including native paths,
case differences and spaces in parent directories. Unrelated monitor names,
batch launchers and PowerShell wrappers do not become positive provider hints.
POSIX discovery and the separate native identity gates remain unchanged.

The native fixture fails before this repair. Complete fingerprinter, discovery
coordinator and scanner files then pass 63/63 without skips; daemon type checking
passes. This is discovery-hint evidence from supplied pane metadata, not proof of
a live provider conversation or stock psmux reporting. No discovery scan against
deployed sessions, claim, seat launch or runtime mutation occurs.

## Native COM provider identity matches launcher support (2026-10-30)

The native launcher resolver already accepts executable COM files according to
PATHEXT, but process identity and Codex resume capture recognized EXE alone.
Windows-specific executable-name matching now covers both native suffixes in
OS-name/path checks, Codex argv validation, foreground-name interpretation and
lightweight resume discovery. Exact OS-path/argv agreement, selected executable,
conversation token, creation ordering and competing-process refusal remain.
POSIX matching is unchanged; batch files do not become native providers.

Owned offline Codex/Claude console witnesses are compiled locally and run with
both EXE and COM names through actual cmd staging and native process census.
The COM case fails before the repair. Afterward the four lineage/capture files
pass 61/61 without skips; daemon type checking passes. Codex's owned SQLite
capture fixture additionally accepts the corresponding COM row. The foreground
field is still a supplied tmux seam, so stock psmux foreground reporting and
installed-provider lifecycle acceptance remain unverified. No real provider,
credential, conversation or deployed seat is used.

## Codex resume capture recognizes native executable rows (2026-10-30)

ResumeMetadataRefresher's lightweight descendant discovery still split command
text on whitespace and matched only the POSIX basename `codex`. It missed a
native `codex.exe`, particularly under a quoted path containing spaces. The
descendant walk now retains ProcessRow's native fields. Windows rows use the
existing Windows argv parser and require argv[0] to match the OS executable
path with basename codex.exe. POSIX discovery remains unchanged; mentioning
codex.exe in another program's arguments does not qualify a native row.

A controlled process-row fixture exercises captureCodexThreadId through real
owned logs/state SQLite files. It fails before the repair, then captures the
exact thread and rejects executable-path mismatch and argument-only decoys.
Both complete resume-capture/refresher files pass 44/44 without skips; daemon
type checking passes. These injected process rows verify the capture consumer,
not an installed provider launch or stock psmux process census. No actual seat,
provider credential or personal transcript is read or changed.

## Empty HOME account projection matches its resolvers (2026-10-30)

ProviderServiceImpl independently calculated its displayed Codex home using a
nullish HOME fallback. With HOME empty, metadata reads used the existing OS
account-home resolver while the configured-account display named relative
`.codex`. The service now reuses resolveCodexHome for that display. Claude's
default display also treats empty HOME as absent and uses the existing OS-home
fallback. Explicit CODEX_HOME and CLAUDE_CONFIG_DIR semantics remain unchanged.

An owned migrated SQLite service fixture reproduces the Codex mismatch before
the repair. Distinct controlled account-home and OS-home roots then verify both
runtime projections and explicit Codex selection through getReadModel. Neither
root is written, and the provider reader is not called. Four account/home files
pass 38/38 without skips; daemon type checking passes. This verifies read-model
directory selection, not the account loaded by a running provider or native
provider lifecycle acceptance.

## Provider account fixture follow-up (2026-10-30)

The six adjacent failures below are now reconciled. Four fixtures assumed POSIX
path spelling or used drive-unqualified rooted values for seat-home declarations;
they now use native path joins/resolution and exact expected fixture homes. Two
fixtures assumed chmod 000 denies reads on Windows. Windows now injects EACCES
only for the exact owned registry/profile-directory reads, preserving the full
service composition and unknown-account assertions; POSIX retains real mode-based
checks. This does not prove native DACL access denial. No production account
policy was weakened or changed to satisfy these fixtures.

The same three-file selection now passes 37/37 without skips, including registry
CRLF and account projection. The earlier six failures remain a historical
observation, superseded for this fixture selection only. Full native acceptance
and the broader parity audit remain incomplete.

## Native CRLF account registries preserve row facts (2026-10-30)

Both the shared CLI auth-seat reader and the provider metadata reader split
registries on LF alone. An owned CRLF registry reproduces two phantom malformed
rows from blank lines; row timestamps also retain a trailing carriage return.
Both readers now recognize CRLF line separators without trimming field contents
or changing column-count validation. A real temporary registry is read through
authSeatsList, authSeatsReport, readCodexAuthMetadata and configuredSeatAccounts:
the row timestamp stays exact and blank lines do not become malformed records.

The focused registry/metadata selection passes 5/5; daemon type checking passes.
An expanded three-file observation reports 37 cases: 31 passed and six failed
in the adjacent provider-seat-accounts file. Those failures remain unresolved
and are not waived by this receipt; the added owned native consumer passes.
No profile contents, actual credentials, account switch or seat process is used.

## Starter registry falls back from an empty HOME (2026-10-30)

The starter resolver treated an empty HOME as a selected directory, producing a
relative `.openrig/agent-starters` path instead of the Windows USERPROFILE
registry. Empty home values now fall through to USERPROFILE and then the OS home;
explicit registry and home-directory overrides retain their precedence. A real
owned temporary registry with Unicode path and CRLF YAML is read through
resolveStarter using mixed-case native environment keys. The selected startup
file and owner root are checked without launching a seat. Both resolver files
pass 19/19, and daemon type checking passes. No personal starter or deployed
runtime is read or changed.

## Headless wake resolves native provider launchers (2026-10-30)

The default `ask --wake` runner still passed bare Codex/Claude names to execFile,
so recognized npm cmd installations could not execute on Windows. It now uses
the existing provider resolver through the daemon's Windows launch surface,
retaining native executables, declared npm Node entries and selected PATH/PATHEXT
ordering. Resolution failures become ordinary failed wake outcomes; unrelated
batch scripts are not executed. Other command names keep existing behavior.

Owned offline npm fixtures for both providers run through a copied Node binary
and prove the actual runWake consumer preserves token and question arguments,
including Unicode, quotes, CRLF and cmd metacharacters. Replacing the Codex shim
with an unrelated batch file produces a failed outcome. The three wake files
pass 29/29; daemon build and CLI type checking pass. No installed provider,
credential, real conversation or live seat is used. This does not establish
provider response quality or full lifecycle acceptance.

## Native heartbeat send uses its paired CLI entry (2026-10-30)

The default heartbeat nudge sender used `execFile("rig", ...)`, which cannot
start the normal Windows npm `rig.cmd` launcher. An owned inert cmd file
reproduces native `spawn EINVAL` without executing its body. Windows now invokes
the current Node executable with this installation's CLI index and separate
send/session/message arguments. POSIX keeps its existing rig lookup. The existing
ten-second timeout and success/failure result handling remain.

The native invocation seam preserves Unicode, CRLF and cmd metacharacters as one
message argument and checks both outcome branches. Together with the heartbeat
suite, 13/13 pass; CLI type checking passes. No real send, queue, heartbeat,
schedule or daemon is activated by this verification. The initial reproduction
fixture exposed EINVAL as a synchronous throw; its final check records that
actual native behavior rather than assuming only callback errors.

## Requirement lookup preserves empty native PATH entries (2026-10-30)

The native requirement probe discarded empty PATH entries, unlike native command
lookup and the permission observer. A tool in the current directory could be
reported missing and receive an unnecessary install plan. The filesystem-only
probe now retains those entries. An exclusively created, uniquely named inert
cmd fixture proves discovery and the actual planner's already-installed result;
explicitly empty PATHEXT still finds no extensionless command. No target command
or installer executes. Both requirement files pass 16/16, and daemon type checking
passes. Only the owned fixture is removed; deployed queues remain untouched.

## Codex and Claude cmd ancestry consumer evidence (2026-10-30)

An owned native console executable, compiled locally without provider credentials,
now exercises both Codex and Claude process-identity consumers through the actual
cmd-to-PowerShell staging chain. Each consumer accepts its exact executable and
conversation argument and rejects a different conversation, a different selected
executable, and a competing matching process. The staged file is consumed. Only
the temporary fixture process tree and files are removed afterward.

The provider-lineage and existing process-lineage selection passes 17/17; daemon
type checking passes. The tmux foreground-command field is supplied by the test
seam: this establishes native ancestry and argument matching, not installed
provider lifecycle, stock psmux foreground detection, or full native acceptance.

## Native cmd pane gap identified (2026-10-30)

The earlier checkpoint confirmed a coordinated implementation gap, rather
than an external-runtime limitation: sendWindowsShellCommand in tmux.ts refuses
cmd panes and emits a PowerShell-only staged-script invocation. The idle-shell
census in native-process-lineage.ts already recognizes bare cmd, but
windows-managed-runner.ts requires a PowerShell/pwsh pane with the managed
runner as its direct child, and model-divergence/current-generation-record.ts
uses the same direct-parent boundary for Pi. The Windows launch renderers also
produce PowerShell scripts. Removing only the transport refusal would leave
readiness and model attribution inconsistent. Complete cmd support therefore
requires a coherent invocation, owned wrapper lineage, readiness/model
identity and actual owned-process checks. The implementation follow-up below
fills the staging and managed-runner portion; whole-lifecycle acceptance and
source-wide parity remain open.
No live pane was entered, started, stopped or reconfigured during this audit.

## Cmd bridge implementation and actual process evidence (2026-10-30)

Native shell staging now admits cmd and pastes a bounded, non-bracketed ASCII
invocation of the pinned Windows PowerShell executable. Only a fixed encoded
loader and a recognized private staged-script path cross cmd parsing; runtime
payload/environment stay in the existing private file. The existing 512-byte
input limit and paste/Enter delivery guard remain. Unsupported bridge paths
return a refusal before staging or typing. The old transport refusal is a
reproduced failing baseline.

Runner readiness and Pi current-generation selection share the native parent
rule: a direct PowerShell runner, or exactly one admitted loader bridge under
cmd. Its argv, staged name, native executable evidence and creation order are
checked. The actual cmd fixture exposed an additional system conhost child;
only the OS-observed system conhost path is exempted from the single-bridge
check. Extra children, competing runners, wrong launch IDs and arbitrary
PowerShell commands remain refused. File naming is shared with the generator.

Owned cmd/PowerShell/offline-Node processes prove Pi/OMP/stub readiness branches,
Pi current-generation file selection and consumed-script removal against the
actual native census. They use isolated homes and cleanup only their own trees.
The related group passes 75/75; final transport/refusal checks pass 9/9 and
daemon typecheck passes. A stale pane-routing assertion and the former cmd
unsupported-shell fixture were corrected separately. No real provider,
installed psmux session, fleet seat or console window was started or changed.
Codex/Claude cmd lifecycle, interactive focus and installed-stock-psmux behavior
remain separate unfinished checks; this is not whole-Windows acceptance.

## Auth home test module boundary (2026-10-30)

The frozen terminal-header empty-OPENRIG_HOME failure was also a fixture issue:
its temporary HOME did not set Windows USERPROFILE, used by os.homedir().
Setting both to the owned temporary home makes the actual CLI header lookup
pass (one check). Product token lookup is unchanged; no real token was read.

The frozen CLI run exposed three failing HOME-fallback assertions: its OS mock
did not reach the shared implementation through the CLI's compiled daemon
re-export. The five mocked account-home cases now live beside the daemon source.
Two CLI boundary checks retain the real re-export and verify account-home and
explicit-home path selection without reading credentials. These seven checks
pass. This corrects test isolation, not production authentication behavior.

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

### Native budget and overlap fixtures (2026-10-30)

The budget/overlap fixtures now run owned npm-shaped CLI entries and an inert native delay probe on Windows; POSIX retains its shell fixtures. The hook itself starts through the test runner's Node. All original delay values, lookup caps, outer kill bounds and failure-episode reporting assertions remain unchanged. The probe has no child processes, so a timed-out observation terminates its owned delay rather than leaving a shell sleep behind.

All 12 cases pass on Windows, including the 52-second budget clamp, the default two-second trace cap, successful slow lookups, failed-attempt issue reporting and separate-occupant delivery. Full workspace type checking passes.

The overlap tests deliberately characterize unresolved behavior: a later PostCompact can be lost and overlapping prompts can deliver twice for one occupant. Passing those characterization cases is evidence of a remaining defect, not concurrency acceptance. Native harness overlap in actual use remains unestablished. No managed seat or daemon is exercised.

### Windows occupant-state serialization (2026-10-30)

The preceding native characterization exposed two reproducible races. Windows now acquires an exclusive named pipe for the canonical occupant-state path before reading that state and holds it through output and persistence. A queued PostCompact reads the completed delivery state before recording its new obligation; a queued prompt sees that the prior pending refocus was consumed. Distinct occupants use different pipes. The kernel releases ownership when a hook exits or is killed, so no persistent disk lease or stale-PID deletion is needed. A contender waits at most 52 seconds and then fails without changing its occupant state file; this is a reported failure, not a successful delivery. POSIX keeps the earlier characterization and remains unresolved.

Both harness manifests advance to 0.1.23, and the vendoring regression includes the new helper dependency. Three actual Windows process tests verify exclusive ownership across canonical path spellings, acquisition after forced holder termination, absence of disk leases and independent occupants. Those tests plus context-ref and work-packet pass 83/83. The complete budget/overlap file passes 12/12 with its original timing bounds; its Windows overlap assertions now require preserved compaction and exactly one pending delivery. Upgrade and native CLI/Python consumers pass 13/13. Workspace type checking and the staged asset-tree version check pass. These results supersede the Windows race characterization above; native harness overlap and live-provider acceptance remain unestablished, and no deployed daemon or seat is changed.

### Repeated replacement of readonly assets (2026-10-30)

Repeated collector provisioning exposed a Windows EPERM: copying a readonly source preserves that attribute, preventing the next atomic replacement. On that specific rename failure, replaceFile now opens and identifies an ordinary single-link readonly destination, changes its readonly bit through the handle, closes the handle, then retries the staged rename once. Keeping that handle open was independently reproduced as another Windows replacement failure. If the retry fails, attributes are restored only when the reopened file still has the original identity and one link. An observed hardlinked destination is refused; staging ownership, source attributes and POSIX behavior remain unchanged.

Five focused cases pass: repeated readonly replacement, failure restoration, hardlink refusal, concurrent-winner attribute preservation and the actual collector re-provisioning path. The broader preceding 64-case observation reports 41 passed and 23 failed: 21 remaining collector failures and two host-denied file-symlink setups. The new readonly replacement failure is removed in that comparison; the remaining names were already present in the fixed baseline. The selected five-case receipt does not validate the deselected cases or full collector acceptance. No deployed asset or managed seat is modified.

### Collector native path and permission coverage (2026-10-30)

All 54 collector tests now pass without skips on Windows. Three echo-pipeline fixtures now pass exact stdin directly to the test runner's Node, in-memory file keys use native absolute identity, and expected managed paths use native operations. The actual quoted-command cases run through Git Bash on Windows, retaining their space/apostrophe paths and generation/provider-usage assertions; this is POSIX hook-command compatibility, not native PowerShell/provider acceptance.

Two failures revealed a production classification gap: old forward-slash collector commands were not recognized against a Windows separator suffix. The finite command parser still decides ownership, and only the parsed path's suffix comparison is normalized. Composed/custom command preservation and unrelated settings assertions remain unchanged and pass.

Readonly-directory cases now apply an actual Windows access rule denying new directory entries without inheriting that denial onto existing files. They prove staging creation is refused, verify successful existing-file fallback, compare the unchanged access descriptor, and restore the original ACL before cleanup. POSIX retains its mode checks. This complete collector receipt supersedes the earlier 21 collector failures; unrelated file-symlink fixtures and the wider workspace inventory remain unresolved.

### Native relay refresh and disable (2026-10-30)

A real-filesystem adapter regression exposed another ownership-path mismatch: canonical quoted commands containing Windows relay paths were not recognized for removal. Repeated projection changed the settings and retained old managed entries. The existing finite Node-command parser still controls ownership; its single parsed relay path and the three existing managed suffixes now use native normalization before comparison.

The regression fails before correction and passes after it. It provisions the actual relay, requires a second projection to leave settings bytes identical, relocates the instance and requires exactly one managed entry per manifest-derived event with no old path, then disables the resource and requires only the unchanged user hook and unrelated setting to remain. The canonical manifest currently yields six relay events; the test derives this count instead of maintaining another event list. This case and all collector cases pass 55/55 without skips. Workspace type checking passes. These use owned temporary files and the actual adapter, without starting Claude, a managed seat or the daemon.

### Activity delivery fixture coverage (2026-10-30)

All 26 activity delivery cases now pass on Windows, versus eight passes and 18 failures before this fixture batch. The in-memory files/modes and managed destination assertions now share native absolute path identity, including the simulated unwritable filesystem root. Enable, disable, missing source/manifest, malformed settings, instance migration, quoted ownership and shipped-spec resolver/planner reachability assertions remain enforced. The fixture's four-event synthetic manifest remains distinct from the six-event shipped manifest.

Unix executable metadata is still required to be 100755 in the Git index. POSIX additionally checks the checkout's mode bits; Windows does not mislabel its mode bits as Unix execute or world-write evidence, and an extracted Windows tree without index evidence explicitly fails that metadata test. Actual npm archive modes remain a packaging check. The delivery file plus real-filesystem native lifecycle regression passes 27/27 without skips. This batch changes fixture portability, not production behavior or runtime deployment.

### Startup guidance and private first input (2026-10-30)

The startup matrix exposed a private-file gap: community-harness first input used only POSIX mode 0600 on Windows. It now uses the shared exclusive private-text creator, which establishes and verifies a protected current-user DACL before writing content. Existing per-attempt files, per-session folders, exact input bytes and unconfirmed-submission semantics remain. A synthetic Unicode/CRLF input test inspects actual file access and verifies that a second attempt leaves the first file unchanged.

Startup directory-link refusal fixtures use Windows junctions where the link is a directory; file-symlink cases remain unwaived. Unwritable-guidance cases use an actual Windows creation-denying ACL and restore it before cleanup. The router asset now has an LF checkout rule: its prior 176-byte CRLF checkout differed from the 175-byte Git blob, breaking exact setup-preview/startup-write parity. Its canonical content is unchanged and all four byte-parity cases pass.

The startup file and new private-input case report 173 total, 167 passed, four failed and two existing pending. All four failures occur at host-denied file-symlink creation. Direct community-harness consumers plus the private-input case report 54 passed and one failed; the remaining activity-observation case calls an unstubbed tmux and fails ENOENT. First-input cases inspect native DACLs and session-folder containment rather than Windows mode bits. Workspace type checking passes. The separately observed POSIX S03-bound-launch fixture failures remain unresolved; these receipts do not establish full startup/provider acceptance or activate any runtime.

### Stock psmux community activity integration (2026-10-30)

The earlier description of the remaining community activity case as an unstubbed call was incomplete: it intentionally runs a real multiplexer. On Windows it now uses psmux (or an explicit OPENRIG_TEST_PSMUX path) in a unique -L namespace, with an owned inert PowerShell sleep. POSIX retains its tmux socket. The actual adapter samples the real window timestamps, then observes a replacement occupant under the same session name: the recorded community selection stays unknown on a quiet screen; the replacement without that selection uses the generic idle floor. An injected reader clock avoids a real ten-second delay.

The complete community-harness file passes 54/54 without skips using stock psmux 3.4.0. The initial native integration reached cleanup but failed because the fixture deleted its directory before closing SQLite; database handles now close first. A started test server must successfully stop in its own namespace before completion. No work server, provider or deployed daemon is selected. This receipt resolves the earlier community-file ENOENT observation; it does not establish complete native launch, console-input or provider acceptance.

### Native bound-launch evidence (2026-10-30)

The S03 fixture explicitly selects Linux rendering and still has 30 Windows-host failures while executing POSIX fake commands; that result remains unresolved. It is not evidence that the native renderer has those same failures. The separate native managed/classic/token files pass 19/19 at the current source. Six added native guard cases increase that set to 25/25 without skips: binding, executable bytes, cwd identity, PATH or config selection changed during capability discovery must reject preparation, and executable changes after preparation must reject command construction.

The new cases use real owned files and SQLite bindings with a fixture help response. They neither query a real provider nor claim complete equivalence to the S03 POSIX matrix. Existing native child/environment, config-selection, token and classic fresh/resume/fork cases remain in the passing set. Production behavior is unchanged by this evidence batch; the full bound-launch and workspace acceptance boundaries remain open.

### Refreshed complete CLI observation (2026-10-30)

The complete declared CLI test script at fixed head b40ecd7453e1da0cecd146f2094da899c7380336 collected 367 files and reported 5,977 tests: 5,803 passed, 117 failed and 57 pending, exit 1. It ran from 2026-10-29T17:10:00.897Z to 17:11:12.540Z. Head and tracked-source diff hash were identical before and after. This replaces the earlier CLI observation as the current fixed-source failure inventory; it does not replace the separate full daemon inventory or prove native acceptance.

There are 56 files with failed assertions. Leading groups include real tmux terminal integration, symlink containment fixtures denied by this host, Codex auth fixture permissions, and HTTP/CLI diagnostic expectations. These are triage groups, not proved root causes for every failure. The full report and per-file failure extraction are retained locally. No CI status, live deployment or completion claim follows from this partial result.

### Private activity endpoint persistence (2026-10-30)

The activity token and endpoint snapshot previously relied on mode 0600, which does not establish owner-only Windows access. Windows persistence now creates a uniquely named private staging file with the shared current-user DACL helper before writing bytes, then atomically publishes it. Existing nonempty tokens are sealed without changing their value. POSIX persistence and the existing best-effort API remain unchanged; failed persistence is not a claim that a token was saved.

The activity endpoint and relay-discovery files pass 20/20 without skips. Tests inspect actual native DACLs, preserve a synthetic legacy token, verify exact Unicode snapshot updates, and inject publication failure to require the prior snapshot and cleanup of the owned staging file. Workspace type checking and diff whitespace checks pass. These tests use only owned synthetic files and do not read deployed credentials or restart any seat or daemon. Comprehensive native acceptance remains open.

### CLI authentication fixture evidence (2026-10-30)

Four authentication status/validation failures in the complete CLI inventory came from POSIX-only fixtures: chmod 0600 did not create a private Windows DACL. Safe synthetic fixtures now use the shared private creator and inspect their actual DACL; the unsafe case adds a real Everyone read grant and requires the existing unsafe result without exposing its sentinel. Malformed JSON still reaches the parse check only after private-access validation. No production safety rule is relaxed.

Adjacent path assertions now use native path joins. The fd-first copy fixtures use bigint identity on Windows, matching the production contract instead of passing an imprecise file ID; POSIX retains numeric identity. The three complete files report 19 cases, 18 passed and one failed, without skips. The remaining failure is host-denied file-symlink creation and remains unwaived. Workspace type checking and diff whitespace checks pass. Synthetic files only were used; no personal authentication files were read or changed.

### CLI HTTP diagnostic fixture registration (2026-10-30)

Four library-list cases reproduced HTTP 401 expectations being replaced by connection failures. Their already-bound HTTP fixture had not registered its origin with the request guard. Three adjacent complete files reproduced seven more failures in SSH doctor status, running-name refusal rendering and partial compact-plan inventory. Registering only each owned bound server resolves those failures without changing production clients or the request guard. The before-all import server is registered for each test invocation because the guard clears registrations between cases.

The four corrected files plus the bootstrap HTTP-error consumer pass 24/24 without skips. They retain exact request routes, 401/503 handling in both output modes, connection interruption, malformed/partial inventory, actual daemon-health verdicts and verbatim running-name refusal checks. The request/live-daemon guard files separately pass 9/9. Workspace type checking and diff whitespace checks pass. A lexical scan also identified other listen calls without an explicit registration; those are candidates for inspection, not proved failures or completed coverage. This batch does not establish full CLI/native acceptance and uses no deployed daemon endpoint.

### Native TUI preview to window route (2026-10-30)

The failing real-tmux window suites explicitly exercise the macOS/POSIX route. Substituting psmux alone would not verify the native window path. A new native counterpart connects the real terminal HTTP routes and TerminalService composition to the actual TUI preview client, CLI client and Windows window opener. It verifies that the preview plan survives that chain, that a changed saved view is refused before launch, and that both read-only and writable native attachment payloads preserve the selected executable and Unicode/quoted session identities. Provider opening is forbidden by assertions; only the final desktop launch and seat liveness are fixtures.

The new file and existing Windows-window file pass 13/13 without skips; workspace type checking and diff whitespace checks pass. The first development run caught an incorrect test assumption that saved views default to read-only; the final matrix explicitly tests both modes without changing production policy. This is route/argument evidence, not visual Windows Terminal layout or real psmux attachment acceptance. The original POSIX integration failures remain unresolved and unwaived. No desktop window, provider or deployed daemon was started.

### Private native host-registry publication (2026-10-30)

Both CLI and daemon registry writers specified mode 0600 but did not establish private Windows DACLs. Two new actual-filesystem assertions failed before correction. Their Windows paths now create unique private staging files through the shared exclusive creator before writing YAML, then atomically rename them. Successful publication retains the private DACL; a failed rename cleans only a staging file successfully created by that attempt. POSIX writes, validation, canonical YAML parity and documented whole-file last-write-wins semantics remain unchanged. Registry data contains host metadata and bearer references; these tests do not read actual bearer contents.

The complete private-registry, CLI-write, daemon add/pair-route and registry-parity files pass 78/78 without skips. Coverage includes native DACLs on creation/replacement, exact synthetic Unicode/reference content, duplicate refusal and injected publication failure preserving prior bytes and removing owned staging. The initial failure-injection mock did not intercept named fs imports; the final module-bound mock reaches both writers and requires the actual failure result. The real PowerShell tile-attachment subprocess file also passes 2/2 at the current source. Neither result establishes full desktop or deployed-fleet acceptance.

### Private gateway persistence (2026-10-30)

The gateway dispatch buffer contains outbound message payloads, while human fragments and generated projections contain identity, preferences and connector references. Their existing mode-0600 writes did not establish private Windows DACLs; three native regressions failed before correction. Both stores now use a shared Windows-only atomic replacement helper that creates and verifies private staging access before bytes, publishes by rename and cleans only staging successfully created by that attempt. POSIX paths retain their original implementation. Dispatch remains durable-first and Ack-gated; human validation/projection rules and caller-specific failure results remain unchanged.

The private-persistence, dispatch-buffer, human-registry and dispatcher files pass 39/39 without skips. New cases inspect actual DACLs through repeated enqueue/ack and human projection, preserve exact synthetic Unicode/CRLF messages across a fresh buffer instance, and require failed publication to retain pending decisions and prior human bytes without orphan staging. Workspace type checking and diff whitespace checks pass. Only synthetic local files are used; no connector delivery, personal message read or runtime deployment occurs. The Windows helper is synchronous like these existing stores and incurs native PowerShell startup per write; throughput under a loaded deployed gateway is not established by this receipt.

The complete human-lifecycle, human-queue-journey and admission-gate consumers additionally pass 33/33 without skips, including authored changes, archive/orphan records, generated-projection drift and registered-human admission behavior.

### Native terminal staging privacy (2026-10-30)

The default multiplexer staging writer still used Node mode 0600 for Windows launch scripts, input buffers and environment staging. It now uses asynchronous exclusive private-file creation: the native DACL is established and verified before any payload bytes, without blocking the daemon event loop on PowerShell startup. Existing injected file operations, unique names, exact content and receiver-owned script removal remain unchanged; POSIX retains its prior writer. No source session or runtime was restarted.

The new real-filesystem case preserves exact synthetic Unicode/CRLF and shell metacharacters, inspects the native DACL, rejects a second writer without changing the first bytes, and verifies explicit removal. Together with shell-command and identity consumers, the selection reports 57 cases: 48 passed and nine failed. All nine fail while attempting POSIX /bin/sh fixtures; they remain unwaived. Workspace type checking and diff whitespace checks pass. These results do not prove complete native console/provider acceptance.

At the user's direction, implementation resumed while the complete daemon observation launched at 06cb5bf2c was still running. That observation must be treated as a changing-source run if its before/after receipt differs, rather than an exact-head acceptance result. A pending full run is not an implementation gate.

### Native setup and restore home resolution (2026-10-30)

Setup previously constructed a literal ~/.tmux.conf filename when HOME was absent, which filesystem writes do not expand. It now resolves HOME, Windows USERPROFILE, then the system home; its custom-config inspection uses the same supplied environment and does not inspect /etc/tmux.conf on Windows. Two native setup cases require missing/empty HOME to target the synthetic profile, respect XDG_CONFIG_HOME and avoid any tilde-relative write. Both pass. The complete setup file reports 65 cases, 62 passed and three provider-readiness failures; those failures remain open.

Restore-check also constructed $HOME/.openrig/shared-docs directly. It now uses the existing compatible instance-path resolver, respecting OPENRIG_HOME and its established legacy fallback, while preserving an explicit substrateRoot. A real owned instance fixture with HOME removed requires its actual rig spec to be found. That regression passes; the complete restore-check file reports 117 cases, 99 passed and 18 hook-projection failures, which remain open. These are partial receipts, not complete native setup/restore acceptance. No real user config or runtime is modified by the synthetic tests.

### Native restore hook path identity (2026-10-30)

A real-filesystem native restore-check case exposed a separate production mismatch: a managed relay written with forward slashes in settings was reported missing against the same native backslash path. The existing finite Node-command parser, exact one-argument requirement, event set and matcher checks remain; only the parsed relay path comparison now uses native normalization.

The new case fails before correction and passes after it, checking native and forward-slash forms plus refusal of a different script suffix. It uses the actual native Node executable and owned synthetic relay/settings files through the public restore-check service. This case and the current-instance-home regression pass 2/2 selected, with 116 other cases deselected; this is not a complete restore-check receipt or proof of hook execution. No managed seat is launched or changed.

### Native provider environment readiness (2026-10-30)

CLI and kernel Codex env-key readiness used exact property lookup on copied environment objects. That disagrees with Windows child-environment semantics when a variable's authored name differs in case from its stored key. Both checks now share platform-aware lookup: POSIX stays exact; Windows uses the first lexicographically sorted case-insensitive key, matching [Node's documented child-process behavior](https://nodejs.org/api/child_process.html). A blank selected key does not fall through to a competing nonblank variant.

The new tests launch the actual native Node child with synthetic lower-case and competing upper/lower-case keys, compare its credential-availability result with both CLI and kernel probes, require only the version check for an available env-key provider and require no credential value in the CLI result. The complete new file and kernel-boot file pass 34/34 without skips. Type checking and diff whitespace checks pass. This proves local environment readiness agreement, not remote authentication, inference or seat credential propagation; no provider process is invoked by these cases.

### Native home and provider selection from copied environments (2026-10-30)

The same platform-aware lookup now reaches actual Codex home resolution, Windows provider command selection and Claude auth-reader executable/PATH selection. Previously these paths either required exact HOME/CODEX_HOME properties or recognized only PATH/Path, so differently cased copied environments could choose the account default or miss an installed executable even after readiness succeeded. The existing npm recognition, executable ordering and no-fallback rules are retained.

The new selection file, native readiness file and CLI Codex-home primitive file pass 11/11 without skips. Owned executable-selection witnesses are never executed: the cases require the selected absolute path from mixed-case keys and first duplicate-key precedence. Lower-case home/config keys and a blank winning CODEX_HOME are checked separately. The native child-environment comparison remains in the readiness file. Type checking and diff whitespace checks pass. The separate Claude-reader/usage consumer selection reports 25 cases, 19 passed and six failed; those complete-file failures remain open, without a new full authentication acceptance claim.

### Native inherited parent identity cleanup (2026-10-30)

The existing explicit parent-session variable list was matched case-sensitively on copied environments. Windows cleanup now finds every spelling of those named variables, using the native selected CLAUDECODE value to decide whether CLAUDE_EFFORT is inherited parent identity. Provider configuration remains outside that list. POSIX keeps exact-name behavior. Session exclusions compare explicitly kept seat variables with native case semantics; canonical unset of a parent identity marks both the requested name and observed inherited variants removed, rather than allowing the server's parent value to reappear.

New tests cover duplicate parent spellings, retention of provider settings, effort without a parent, unchanged POSIX matching and exact adapter removal commands. An actual native Node child receives the synthetic provider configuration but no parent identity after cleanup. The parent/session/credential environment selection reports 41 cases: 19 passed, zero failed and 22 existing platform-pending cases. Type checking and diff whitespace checks pass. This does not waive the pending POSIX integration cases or establish every stock-psmux environment-isolation property; deployed seats and server globals remain untouched.

### Native npm Codex seat command (2026-10-30)

SeatLaunchEnvironment selected codex.cmd as the executable for native launches. A real PowerShell subprocess with a synthetic npm-shaped shim reached its JS entry but failed exact argument equality. The initial interpretation that the shim could not start was too broad: the demonstrated defect is the intervening batch interpretation, not universal spawn failure. Native seat commands now reuse the recognized Windows provider resolver and quote its selected Node interpreter plus package entry directly, retaining native-executable precedence and refusing unrecognized shims without a POSIX fallback. POSIX entry resolution is unchanged.

The actual subprocess regression fails before correction and passes after it. It verifies exact Unicode, whitespace, apostrophes, double quotes, empty arguments, trailing backslashes, percent-variable text and ampersands, alongside the selected CODEX_HOME and node identity. Replacing the shim with an unrelated launcher is then refused without changing the prior output. This file plus native provider-selection tests pass 3/3 without skips; type checking and diff whitespace checks pass. Only an owned synthetic npm package, actual Node and PowerShell are executed; the multiplexer identity reads are fixtures. No real Codex, account authentication, managed seat or deployed runtime is started.

### Quoted native Pi and OMP search paths (2026-10-30)

The Pi npm resolver and OMP executable resolver skipped quoted absolute Windows PATH directories. OMP also read only the exact PATH property on copied environments. The two added expectations fail before correction. Windows directory entries now shed only their paired outer quotes before absolute-path checks; OMP uses the shared native environment lookup, including duplicate-key precedence. Relative-entry rejection, OMP native-only selection, mise resolution under the operator environment and Pi npm manifest/shim validation remain enforced. POSIX OMP lookup is unchanged.

The complete Windows-Pi-command and OMP-runner files pass 54/54 without skips. The Pi fixture additionally executes its selected real Node interpreter with an owned synthetic npm entry and requires exact Unicode, quotes, empty strings, percent text, ampersands and trailing backslashes. No real Pi/OMP provider or session is started. A first implementation had a local variable-shadowing error caught by tests/type checking; the corrected final source passes the complete selection. This is executable/path and RPC-fixture evidence, not full managed OMP provider acceptance.

### Native bound seat environment selection (2026-10-30)

The shared seat launcher still read exact PATH/OPENRIG_HOME properties, and managed Claude required exact HOME/PATH/config keys while rejecting legal mixed-case inherited names. Both now use native environment lookup for their bound selections and public allowlist. Public values are canonicalized before defaults are added, so a lower-case transcript setting is not hidden by an empty canonical default. Bound identity wins over inherited case variants. Managed capability keys are excluded case-insensitively from pane forwarding; other valid names retain by-name forwarding, including Windows ProgramFiles(x86). Credential-precedence diagnostics also recognize copied case variants and report names only. POSIX validation and lookup remain exact.

The complete managed-Windows, native Codex-seat and classic-Windows-Claude files pass 23/23 without skips. Actual PowerShell/Node subprocess cases cover mixed-case copied home/PATH/config/instance metadata, quoted PATH, selected transcript values, identity protection against a pane override and allowed by-name variables. The initial native-location fixture accidentally retained competing case variants from its parent; it now removes that fixture ambiguity before asserting the forwarded synthetic value. Type checking and diff whitespace checks pass. No provider session or deployed runtime is started, and these receipts do not establish all-runtime acceptance.

### Native Pi/OMP child environment and OMP home (2026-10-30)

The Pi/OMP child builder looked up its explicit allowlist with case-sensitive properties. On Windows it now uses native lookup for the same baseline/identity names, OS locations, selected provider key and existing provider-specific endpoints. It does not add credential families or forward unknown names. Windows OS aliases are emitted once in their established spelling. POSIX lookup remains exact.

OMP also set HOME but retained the operator's USERPROFILE. An actual Windows Node child reproduced its home as the synthetic operator path despite the OMP HOME setting. The child builder now binds USERPROFILE to the same seat home for OMP only; Pi retains its existing user-home behavior and pinned agent/session directories. The actual child regression then requires os.homedir and HOME to agree on the seat path, the selected lower-case provider key to arrive, and another provider key plus the activity-hook token to remain absent.

The complete Windows-Pi-command and OMP-runner files pass 55/55 without skips; type checking and diff whitespace checks pass. The child reads synthetic environment metadata only, without opening an operator home or invoking Pi/OMP or an inference provider. This establishes native child-home and allowlist behavior, not full managed provider acceptance.

### Native provider collection before child filtering (2026-10-30)

The daemon's earlier provider-credential collection stage also used exact property lookup, so copied Windows environment keys could be discarded before the child builder saw them. Collection now uses the shared native lookup while retaining the existing explicit uppercase configuration whitelist, runtime restrictions and nonempty-value requirement. A blank winning case variant does not fall through to another value. POSIX lookup remains exact.

The complete OMP-runner file passes 53/53. The added synthetic pipeline case checks collection followed by child provider filtering: the selected provider survives, another admitted provider is removed by the child filter, and an unknown credential is never admitted. It also checks POSIX behavior, blank duplicate precedence and rejection of lowercase configuration names. No real credentials or provider processes are used. This is a focused implementation receipt; comprehensive Windows acceptance remains open.

### Native Codex metadata home selection (2026-10-30)

The daemon's metadata-only Codex reader retained a separate exact-key HOME/CODEX_HOME lookup after the CLI resolver had gained native Windows lookup. It now uses the same environment-key semantics while retaining account-home fallback, profile-name-only directory listing and the six-column seat registry contract. It still never opens saved profile contents.

Both complete metadata-reader files pass 8/8 on Windows. Owned temporary directories cover lowercase home keys and a blank canonical CODEX_HOME winning over its nonempty lowercase duplicate, alongside the existing explicit-home, absent-home, empty-home and registry behavior. No personal credential directory is read.

### Native provider account projection and Claude reader roots (2026-10-30)

Provider status still selected its displayed default account homes with exact environment properties, and the shared Claude config-root reader did the same. Both now use native environment lookup for their existing HOME/CODEX_HOME/CLAUDE_CONFIG_DIR selections. Stored per-seat account selections keep precedence; the declarative seat-env naming contract is unchanged.

A real migrated SQLite integration case seeds live Codex and Claude seats and supplies an owned synthetic copied environment with lowercase home keys. Status selects the expected account roots, the Claude config reader selects that same root, and no provider is started or file written beneath the fixture home. The complete new file and seat-runtime-home file pass 11/11. Four failures in the latter initially exposed hardcoded POSIX expected paths; the expectations now use host-native separators while retaining member/rig precedence, normalization and distinct-home assertions. Comprehensive provider/runtime acceptance remains open.

### Native npm ACP agent and stop-command entries (2026-10-30)

ACP passed the agent name directly to Node spawn, which cannot execute npm's Windows batch entry as a native program. The connector now resolves native programs or recognized npm Node launchers before spawn. Both global node_modules and local node_modules/.bin layouts are supported, including scoped packages. The selected shim target must agree with its package name and declared bin entry; Node comes from the shim directory or selected launch PATH. Arguments pass directly to Node without cmd.exe interpretation. Unrecognized batch launchers produce a failed outcome on the existing queue row without execution. The synchronous operator-supplied stop-command path uses the same resolver. POSIX spawning remains unchanged.

Five focused Windows cases pass: four global/local and command-name/explicit-path combinations complete an actual JSON-RPC turn through an owned synthetic npm package; synchronous invocation of the same entry also retains exact Unicode, quotes, empty arguments, trailing backslashes, percent text and ampersands. The unrelated-batch case leaves its execution marker absent and records failure. The task remains open for its owner; no live provider or OpenRig seat is started.

The broader connector/RPC/cancel selection has 28 tests, 27 passing and one failure in the existing companion-process test's directory cleanup (EPERM). A bounded cleanup retry did not resolve it and was reverted; its cause is not established. The final focused selection passes 5 tests with the other 16 connector cases deselected. These receipts do not establish complete ACP acceptance or resolution of that cleanup failure.

### Private native following selectors without blocking the event loop (2026-10-30)

TerminalFollowing saved selectors using POSIX mode bits only. On Windows it now awaits private-DACL creation and atomic publication before provider effects, using an asynchronous counterpart of the shared replacement helper. Its existing serialized queue awaits both explicit saves and completed-task retirement. POSIX persistence is unchanged. Failed publication retains the prior file and removes successful private staging; the provider is not invoked for that failed save.

Both complete following-controller files pass 10/10. The new actual-filesystem case inspects the Windows DACL, exact Unicode selector data, restoration, a timer running during private creation, and an injected publish failure that preserves the prior bytes and leaves no staging. No Herdr process or live seat is used. The existing capacity case still opens/retires 65 tasks and resumes one: its 132 real private writes take about 47 seconds here, so only that Windows test's deadline is 90 seconds instead of 20. Permission setup is asynchronous but still adds per-save helper latency; this is not a loaded-provider throughput receipt.

### Native workflow cache noise pruning and built-in preservation (2026-10-30)

The earlier full daemon failure log identified two workflow-cache pruning failures. Source inspection confirmed the production startup DELETE matched slash-only paths, so native Windows worktree, dependency and build rows survived. Windows matching now normalizes separators in SQL. The install-root exemption also normalizes separators and compares literal directory boundaries case-insensitively, preserving shipped built-ins without treating percent/underscore characters as wildcards or preserving similarly named sibling directories. POSIX SQL behavior remains unchanged. Only cache rows are removed; source files are untouched.

The complete workflow-cache file passes 15/15, including the previously failing native-path cases and a new real-file/SQLite case covering a mixed-case slash-form install root, percent/underscore characters, a lookalike sibling and a wildcard-like neighbor. The full daemon log used to locate these failures ran while source changed and is not an exact-head acceptance result.

### Native immutable proof receipt permissions (2026-10-30)

Proof judgment receipts opened their exclusive staging descriptor using POSIX mode bits only. The writer now uses the existing private-descriptor helper, establishing a protected Windows DACL before receipt bytes are written. The same descriptor still carries the write and fsync; immutable hard-link publication, conflict handling, replay and the existing Windows file-flush behavior remain in place. POSIX exclusive creation is unchanged.

The complete proof-judgments file passes 27/27, including actual Windows DACL inspection after initial publication and correction, exact replay, unchanged prior bytes, no orphan staging, concurrent process publication, injected write/fsync failures, and process death before/after publication. Crash instrumentation now targets the numbered immutable receipt rather than every internal hard link, so private staging is not mistaken for final publication. No live project receipt or account material is touched.

The three policy-reuse, source-root and mission-identity consumer files also pass 27/27. Five policy tests initially failed during creation of directory links before reaching their assertions. Their directory fixtures now explicitly use Windows junctions (directory symlinks on POSIX), retaining real-target watching, replacement/rebinding and outside-project refusal checks. This does not waive file-symlink coverage or change host privileges.

### Native workflow diagnostic labels (2026-10-30)

The full daemon failure inventory also exposed malformed workflow files labeled with their entire Windows path: writeDiagnostic split paths only on '/'. It now takes the host-native basename while retaining the existing full-path fallback when another diagnostic already owns that filename. The retention test's own display helper had the same separator assumption and now uses native basename too. All three complete workflow folder-scanner, retention and cache files pass 48/48; current/pinned versions, parse-error repair and outside-folder preservation stay covered. This fixes native diagnostic labeling, not every scanner or workflow behavior.

### Native workflow folder aliases during reconciliation (2026-10-30)

The workflow folder scanner still selected cached rows with a raw SQL path prefix and compared seen paths case-sensitively. An actual Windows filesystem/SQLite case reproduced a vanished diagnostic row surviving a scan of the same directory through uppercase and slash-form spelling. Windows reconciliation now compares resolved native path identities for seen files and uses native relative-path containment to select only rows beneath the scanned directory. It reads cache metadata without the separator-sensitive SQL prefilter on Windows; neighboring directories remain outside the removal boundary. POSIX source selection keeps its prior query. No source file is deleted.

The new case fails before correction and passes after it: the vanished row is removed, a present workflow remains, and a similarly named neighboring folder's diagnostic survives. The complete folder-scanner and version-retention files pass 34/34, retaining pinned-version and parse-error repair behavior. This is native folder reconciliation evidence, not full workflow/runtime acceptance.

The three complete workflow-library scanner, library routes and folder-route consumer files also pass 32/32. Type checking and diff whitespace checks pass.

### Native private scratch home for explicit token usage probes (2026-10-30)

An explicitly requested Claude token usage probe bound HOME/USERPROFILE to a temporary directory but created that directory with ordinary mkdtemp, which does not establish a private Windows DACL. Windows probes now await an asynchronous version of the existing verified private-directory creator before launching the CLI. POSIX mkdtemp behavior, the selected-token-only child environment, disabled tools/hooks/MCP, bounded child lifetime and final scratch cleanup remain unchanged. No read/status path gains a probe.

The new actual-child case executes an owned synthetic npm CLI only. Before emitting sanitized usage events, the child inspects its scratch directory's protected current-SID DACL and reports that native os.homedir agrees with HOME and only the selected synthetic token was supplied. The parent confirms the directory is removed afterward, a timer ran during the asynchronous operation, and the token does not appear in the returned reading. This is local isolation evidence, not a real model or provider acceptance run. The API test's synthetic credential references also use host-native path spelling instead of hardcoded POSIX separators.

The complete token-usage file has 19 tests: 16 pass, two fail and the existing POSIX FIFO case is skipped on Windows. Remaining failures are the POSIX UID-warning assertion on a host without process.getuid, and EPERM while creating the file-symlink fixture. Native token-file ownership/ACL warning parity is not established by scratch-directory privacy. These failures remain open; no file-link coverage or host privilege is waived. Type checking and diff whitespace checks pass.

### Native token-file permission diagnostics on the reading handle (2026-10-30)

Token probes now assess Windows owner and DACL on the already-open reading descriptor, inherited by a metadata-only helper through stdin. The helper returns two booleans, never token bytes or SIDs, and does not reopen the pathname or consume input bytes. Windows warnings describe ownership and the protected current-user-only DACL instead of POSIX mode/UID bits. Unavailable assessment is reported as unknown and does not newly refuse an otherwise readable selected credential; existing POSIX warnings are unchanged. Asynchronous helper preparation and bounded inspection keep this added work off the serving event loop.

An actual Windows case opens a private token, replaces its pathname with an ordinary file and proves the old descriptor still assesses private while the replacement assesses nonprivate; subsequent token bytes remain exact. Another actual synthetic-CLI probe uses a private token without mode/owner warnings. Ownership-negative and unavailable-assessment outcomes are injected diagnostic cases, not claims of changing a real file owner. The enlarged helper initially exceeded Windows command-line length; both compilation paths now receive the C# source on stdin instead of embedding it in EncodedCommand. Synchronous helper consumers still exercise actual native reads/writes.

The native token file-link fixture remains blocked by host EPERM and is not replaced or waived. These tests use only owned synthetic tokens and temporary files, with no actual account credential or provider invocation.

The complete token-usage file now has 22 tests: 20 pass, the file-symlink fixture fails at creation, and the existing POSIX FIFO case is skipped. Synchronous helper consumers (Codex save/switch and project-Jev) have 31 tests: 29 pass and two file-symlink fixtures fail at creation. Type checking and diff whitespace checks pass. The earlier UID-specific warning failure is replaced by a passing Windows owner-warning case, with the native current-owner positive result covered separately on real files.

### Native private slow-operation logging with the existing barrier (2026-10-30)

The recorder worker appended and rotated files using POSIX mode bits, which did not establish private Windows access. Windows writes now use the compiled native helper: owner, regular-file and single-link checks precede DACL tightening, then the same handle appends and flushes bytes. Existing owned logs retain their bytes while acquiring the private DACL. Rotation seals each source before renaming; retained files stay private. POSIX writes/rotation remain unchanged.

The helper assembly is staged once before starting the recorder worker. Each Windows write invokes that native executable from the worker, not PowerShell; log data travels through stdin. The existing 250ms begin barrier, worker-only log I/O, ordered flush and fail-visible write/termination contracts remain. Helper preparation failure does not fall back to mode-only logging: writes fail visibly. Cold assembly preparation can add constructor/startup latency, and sustained loaded logging throughput is not established here.

Both complete recorder/private-log files pass 16/16. Actual Windows DACL assertions cover new and rotated logs. The real child-process wedge case prohibits synchronous main-thread filesystem writes and still leaves the durable begin record after termination. Its preexisting empty-log fixture now establishes native private access instead of pretending mode 0600 is a Windows ACL. Added real-file cases cover preserving prior bytes while tightening an owned log and refusing a multiply-linked log without appending or reporting a successful drain. Existing rotation limits, threshold boundaries, observer isolation and worker-loss tests remain active.

The complete shutdown-drain and request-phase observer files have 17 tests: 16 pass with one existing platform skip. Type checking and diff whitespace checks pass. These focused receipts do not establish sustained-load or all-runtime Windows acceptance.

### Native private channel-operation ledger (2026-10-30)

The human-channel lifecycle ledger still appended with mode 0600 only. Windows now uses the shared native private append operation: the opened file's owner, type and single-link checks precede DACL tightening and durable append. Existing owned ledger bytes are preserved. Its synchronous receipt ordering remains unchanged, so a failed started append refuses before the channel effect; completion and failure receipts keep the original operation identity. POSIX append behavior is unchanged. The helper assembly is cached, with the previously noted cold preparation cost.

The complete native-ledger and channel-lifecycle files pass 10/10. Actual Windows filesystem/DACL cases verify the started record before the synthetic effect, exact Unicode/newline reason, retained prior bytes, separate ordered receipt pairs across concurrent calls, effect failure, and exclusion of the returned response body from the ledger. A multiply-linked ledger is refused before its callback and both link names retain their prior bytes. Existing daemon-door lifecycle cases cover backlog seeding, repeat enables, attribution and refusal behavior. Type checking and diff whitespace checks pass; no live connector is enabled or message sent.

### Native setup environment directory selection (2026-10-30)

Setup still read HOME/USERPROFILE/XDG_CONFIG_HOME by exact property name when an environment map was supplied. It now applies the shared native lookup using the selected platform, retaining HOME precedence, Windows USERPROFILE fallback and POSIX exact-key behavior. A blank canonical HOME wins over a nonempty lowercase duplicate before the existing USERPROFILE fallback. The selected config directory is used for the custom-tmux advisory as well as the managed home path.

All 67 setup tests pass without skips, including new copied-key and duplicate-precedence cases. Three prior provider-readiness failures were caused by the test reader matching only hardcoded slash paths; its selected config.toml fixture and assertions now use native path joining, preserving Bedrock/default-provider, missing-token and malformed-config assertions. Production provider-readiness rules are unchanged. Type checking and diff whitespace checks pass. These are injected setup dependency tests, not actual installation or provider acceptance; no personal config is written.

### Native Python composer CLI bridge (2026-10-30)

The operating-model Python composer still invoked the resolved rig.cmd directly while the refocusing script already used the shared Node bridge. On Windows compose now uses that same bridge and selected OPENRIG_NODE/Node interpreter, keeping recognized npm entry resolution and avoiding a batch invocation. POSIX executable selection and the existing null-on-unavailable/error contract remain unchanged.

The actual Python 3.13/npm-layout test uses an owned Unicode/space/ampersand path, an explicit Node interpreter and a PATH containing only the fixture launcher. Restoring the old compose call makes compose return null while both trace calls succeed; the corrected source passes. The complete case verifies exact CLI arguments and UTF-8 roots for both scripts, plus missing launcher, unrecognized failing batch and malformed UTF-8 results returning null. No real daemon or user workspace is queried. A validation shell quoting error initially started an interactive Python process; that owned process was stopped and the successful run uses structured child-process arguments.

Both plugin manifests are 0.1.24 so existing installations can distinguish the changed asset. The skill generator refreshed recorded source digests and its check passes. The source-asset plugin version/hash check passes (not an npm archive or deployed-runtime receipt). Adjacent native trace/version tests have seven cases: four pass and three fail while creating file symlinks with host EPERM. Those cases are not waived. Type checking and diff whitespace checks pass; live plugin files and seats are not refreshed.

### Checkout-independent skill digests (2026-10-30)

A clean detached checkout of 9982a6fa4 contradicted the preceding working-tree-only mirror check: 14 recorded digests did not match the fresh LF checkout. The older source worktree retained CRLF bytes for those declared skill files despite their LF Git attributes, and the generator had recorded those checkout bytes. Each affected text file was compared against its exact HEAD blob; only CRLF-only differences were normalized to that blob, with no logical source changes. Regeneration then binds the declared LF bytes and the current source check passes. The previous working-tree-only digest receipt is insufficient for Git delivery and is superseded by this correction and the separate clean-checkout validation.

An independent validation checkout reuses installed dependencies through junctions while binding @openrig workspace packages to its own sources and compiled output. It is not a live runtime checkout and does not launch OpenRig seats. Fixed-head CLI verification will use this isolated source tree so later implementation work cannot change its test inputs.

### Native preflight database parent and writable-directory checks (2026-10-30)

The preflight command derived its home with a slash-only filename regex. A real temporary Windows database path with backslashes was therefore checked as though the database file itself were a directory. The command now uses native dirname. The added CLI case fails before correction and passes after it, using an existing empty database file, Unicode/space directory names and a mocked tmux/status endpoint; it starts no daemon or provider.

The writable check also trusted access(W_OK), which does not assess Windows directory ACLs ([Node documentation](https://nodejs.org/api/fs.html#fsaccesspath-mode-callback)). An actual directory DACL denying new entries reproduced a false writable result. Windows now exclusively creates a fresh empty probe and closes/unlinks it; it never truncates an existing path. POSIX access checking and injected checks remain unchanged. The earlier chmod-only negative fixture now uses a real Windows denial (restored before cleanup), with a separate existing-directory denial case proving actual file-creation refusal. All 24 preflight/quiet-exec tests and type checking pass.

The first isolated CLI run was canceled after its missing CLI/TUI build outputs were verified; it supplies no acceptance counts. Both outputs were then built from the fixed e36cef0b6 sources and a new receipt started with explicit build-input checks. The original terminal receipt and cancellation reason are retained. Current implementation work continues independently of that frozen run.

### Native draft pod names and health slice authority paths (2026-10-30)

A bounded lexical scan of production sources surfaced two filesystem paths still split only on '/'. The draft rig generator used the complete backslash CWD as its sanitized pod name on Windows instead of its final directory. It now uses native basename while retaining each member's exact CWD, grouping and deduplication rules. The added native-drive/trailing-separator case fails before correction and passes after it, including rig-schema validation.

Health diagnosis split native path.relative results only on '/', so the three-part slices/folder/file test never admitted matching slice authority on Windows. It now splits those filesystem-relative paths with the native separator. Canonical-file checks, scope categories, declared slice identity and unrelated-authority refusal remain unchanged. The existing complete positive/negative scope-binding case fails before correction and passes after it, including sibling/malformed/changed-ID refusal.

Draft generation, health diagnosis and ceremony files total 43 tests: 41 pass and two file-symlink fixtures fail during creation with EPERM. Correction, passive-ceremony and operating-posture consumers total 58 tests: 57 pass and one file-symlink fixture fails during creation. The directory-link posture fixture uses a Windows junction without changing its real-workspace/catalog assertions; its complete 21-test file passes. File-link cases remain unwaived. Type checking and diff whitespace checks pass. No live discovered session is adopted and no health notification is sent.
# Windows bound-source navigation follow-up (2026-10-30)

The lifecycle compiler records native filesystem paths for slice sources. The
TUI previously split those paths only on `/`, so a Windows daemon's backslash
source lost its Slice navigation action. The detail renderer now accepts both
separator forms, including UNC paths, without changing the displayed source or
the mission/slice action identity. This also supports a TUI on another OS.

Focused native-source, wake-marker and connected workflow-journey checks: 7/7
passed on Windows. This does not establish desktop or provider acceptance.
The separate frozen e36cef0 CLI run completed with stable source: 5,983 tests,
5,830 passed, 97 failed and 56 pending. It predates subsequent source fixes;
these counts are retained as that exact snapshot rather than current-head acceptance.

## Doctor/setup writable-directory parity follow-up (2026-10-30)

The production doctor and setup verification dependencies still replaced the
shared writable-directory check with `access(W_OK)`, bypassing the native DACL
probe used by daemon preflight. Both now inherit the shared check. Explicit
injected test checks remain supported. An owned temporary directory with an
actual deny-create DACL is reported unwritable; restoring its DACL makes the
same doctor check pass, and neither result leaves a probe file.

The new native doctor case passed. Existing preflight and setup suites passed;
the combined preflight/setup/doctor run had 130 passed and two existing daemon
distribution fixture path failures in doctor. Those failures are also present
in the earlier frozen CLI report and are not reported as resolved here.

## Read-only restore directory access (2026-10-30)

Restore checks previously trusted `access(W_OK)` on Windows and suggested
`chmod` on failure. They now request `FILE_ADD_FILE` on an existing directory
handle with `OPEN_EXISTING` and `FILE_FLAG_BACKUP_SEMANTICS`, then close it.
No child is created and the directory's modification time is unchanged. This
preserves restore-check's read-only target contract; it is an access-rights
observation, not proof that a future write will succeed under changed state.
Windows failures suggest inspecting Windows Security properties.
See [Microsoft's directory permission example](https://devblogs.microsoft.com/oldnewthing/20251203-00/?p=111836).

An actual deny-create DACL fails the native check; restoring it passes. Missing
paths and regular files are refused. The restore-service consumer reports red
for the denied directory while retaining its contents and mtime. Both focused
cases passed, and daemon TypeScript checking passed. The broader 119-case run
had 101 passed and 18 previously observed activity-hook fixture failures; those
remain unresolved. No live restore, restart or runtime deployment was performed.

## Native home for skill audit discovery (2026-10-30)

The skills audit HTTP route fell back to `/tmp` when neither its explicit home
context nor `HOME` was present. It now uses Node's native home resolver, so an
ordinary Windows environment can discover user-global skills through its native
profile directory. Explicit context still wins. A synthetic native-home fixture
with no `HOME` exercises the actual HTTP audit and discovers its user skill;
the native home resolver itself is mocked to prevent reading real user data.

The adjacent directory-link fixtures now use native Windows junctions (POSIX
directory symlinks elsewhere), retaining the cyclic-directory and linked bundled
skill assertions. The route and audit suites passed all 36 tests on Windows;
daemon TypeScript checking passed. No installed user skills were changed.

## Standalone runner instance-home parity (2026-10-30)

Pi activity-endpoint discovery and the stub runner's endpoint/compaction setup
previously joined `.openrig` to an empty string when `HOME` was absent. This
could select a current-directory path on a normal Windows host. Both now use
the same standalone resolver: explicit `OPENRIG_HOME`, then `HOME`, then native
Windows `USERPROFILE`, then Node's OS home. Native environment key lookup is
case-insensitive on Windows. Pi's resolver also uses its supplied environment
rather than reading a different global `HOME` value.

A synthetic Unicode Windows profile with no `HOME` supplies the endpoint to the
real stub endpoint reader. Explicit instance and direct endpoint precedence,
POSIX selection and OS fallback are covered. Resolver, stub execution and real
stub HTTP activity checks passed all 15 tests. Daemon build passed, including
the compiled standalone resolver dependency. The adjacent Pi path suite skipped
all six cases under its existing Windows guard; this is not Pi/provider runtime
acceptance. No active runner or daemon was restarted.

## Native permission-drift command observations (2026-10-30)

The permission observer previously looked for extensionless commands only and
started `claude --help` directly. Windows now discovers `.com`, `.exe`, `.bat`
and `.cmd` files on the native PATH, including quoted entries, and excludes
directories. This remains file availability, not successful launch or native
permission enforcement. Claude mode loading uses the existing bounded native
command runner and recognized npm entry resolver. Unrecognized shims, failed
commands and timeouts remain unknown; no shell fallback was added. POSIX help
execution retains its existing behavior and bound.

Owned fixtures cover all four runtime command names and a real synthetic npm
Claude entry in a Unicode/spaced path, verify exact `--help` argv and refuse an
unrecognized shim. Adjacent settings fixtures now use native path construction
without weakening configuration/enforcement distinctions. All 29 permission
drift tests passed on Windows and daemon TypeScript checking passed. No real
provider command, model call or installed provider configuration was used.

## Compaction preparation create-file rights (2026-10-30)

Windows compaction preparation now checks native directory `FILE_ADD_FILE`
access instead of `access(W_OK | X_OK)`. A real fixture permits creating the
attempt directory while denying file creation inside it: the old access check
passes, an actual map write fails, and the enforcer now stops with
`preparation_directory_unavailable` without sending preparation or compaction
input or falling back from the explicitly configured root. POSIX checks retain
their existing behavior.

The shared native directory check now receives a namespaced Windows path so it
also handles deep paths beyond legacy MAX_PATH. Both existing manual/automatic
long-path journeys pass with the original paths and instructions preserved.
The three-suite run had 115 tests: 113 passed, two file-symlink fixtures could
not be created on this host (EPERM). No cases were waived; daemon TypeScript
checking passed. No live compaction was requested.

## Native owned-text long paths (2026-10-30)

An actual path beyond MAX_PATH was readable through Node but the native bounded
reader reported it missing. Native regular/owned text reads, owned writes and
private append now pass namespaced Windows paths to their existing handle-based
helper. Owner, bounded-length, single-link and DACL logic is unchanged.

The reproducer failed before the change and passes after it: deep Unicode-path
reads, replacement, two private appends, and multi-hardlink refusal preserve the
expected bytes. A compaction consumer now reuses its equivalent owned ignore
file at a deep configured root instead of stopping. These cases plus the native
directory and private channel-ledger checks passed five tests; daemon TypeScript
checking passed. This does not establish long-path coverage for every native
helper operation or runtime/provider acceptance.

## Slow-operation worker long paths (2026-10-30)

The recorder worker invokes the native assembly directly, bypassing the outer
owned-text wrapper. A real worker reproduced failed appends at a deep Unicode
path. Its private append/seal calls now convert that path to Windows namespace
form before invoking the same native operations, covering rotation as well.

The reproducer passes after the fix: current and rotated logs preserve their
respective records. After the worker closes, short hardlink aliases inspect the
same files' private DACLs; these aliases are only test inspection paths and are
not used during writes. Recorder, private-log and shutdown suites passed 24
tests with one existing Windows signal skip; daemon TypeScript checking passed.
Sustained-load throughput and live deployment remain unestablished.

## Native authentication file/profile long paths (2026-10-30)

Synthetic long-path authentication files reproduced native `auth-mode` failure.
The authentication operations now receive namespaced source/destination paths.
Profile creation also used legacy .NET directory creation, which still rejected
the long path after namespacing. It now creates missing directories with native
`CreateDirectory` and an explicit private security descriptor at creation, then
retains the existing final-handle owner/reparse validation and DACL setting.
Native temporary-file deletion also avoids the legacy .NET path limit.

The owned fixture covers private mode/read, exact copied bytes, expected-inode
mismatch preserving the destination, absence of temporary files, nested profile
creation/reuse, and refusal of a final directory junction without altering its
target DACL. The focused case passed. Adjacent CLI auth checks plus this case
had 17 tests: 14 passed, two file-symlink EPERM failures and one previously
observed sign-in fixture failure. Daemon build passed. No real credential or
account data was read, copied or changed, and no provider was invoked.

## Agent Starter native environment selection (2026-10-30)

Agent Starter registry discovery now uses native case-insensitive environment
lookup on Windows, including a caller-supplied environment snapshot. Without
`HOME`, its supplied `USERPROFILE` is used before the OS fallback. Explicit
registry, home registry and fallback precedence remain intact. The synthetic
consumer resolves an actual clean starter from a Unicode profile and from a
mixed-case registry override without inspecting real user registries.

Resolver fixtures now model native filesystem path normalization and retain all
credential-refusal/redaction assertions. All 18 resolver/native-home cases pass;
daemon TypeScript checking passed. The two separately attempted Claude/Codex
adapter integration cases remain failing on their synthetic path fixtures, so
end-to-end starter delivery is not claimed by this change.

## Native starter consumers and TUI spec references (2026-10-30)

The two starter adapter fixtures now construct native absolute rig/agent paths
and use native in-memory directory separators; the Claude transport fixture
also supplies its native shell-command boundary. Both real-adapter guidance
merge cases pass for CLAUDE.md/AGENTS.md and retain their managed-block and
onboarding assertions. Transport remains mocked: actual provider startup is
not established by these cases. This supersedes the two fixture failures above.

Separately, the TUI reduced agent references using only `/`, although the daemon
resolves local/path references with native filesystem paths. It now recognizes
backslashes too, including trailing separators and YAML filename references,
while retaining exact known-name priority and unknown references verbatim.
All 73 hydrate cases passed, including native local/path joins and unavailable
spec preservation; TUI TypeScript checking passed.

## Package export names from native source paths (2026-10-30)

Package planning already joins guidance source paths with native filesystem
semantics, but manifest name derivation split only on `/`. A Windows guidance
source such as `guidance\AGENTS.md` therefore became the entire export name.
Validation and normalization now use a basename operation accepting both
separator forms; explicit names remain unchanged. Derived agent duplicate-name
checks use the same separator handling.

The real package resolver/install-planner fixture reproduced the incorrect name
before the fix and now retains `AGENTS.md` with the expected native source and
target paths. Role guidance lookup and duplicate-name validation are covered.
All 57 manifest/planner cases passed on Windows; daemon TypeScript checking
passed. No package was installed into a user workspace.

## Native CLI requirement probes (2026-10-30)

Package CLI requirements previously always used POSIX `command -v`. Windows
now performs bounded asynchronous filesystem lookup on its native PATH/PATHEXT,
including quoted directories, mixed-case environment names, explicit paths and
regular-file checks. This discovers a command file without executing it and does
not establish that its runtime invocation will succeed. Native lookup records
no executed shell command (`command: null`). Non-missing filesystem errors and
timeouts remain unknown. Existing POSIX shell probes are retained, and settled
probes now clear their timeout timer.

The native fixture finds a synthetic `.cmd`, excludes a directory-shaped
executable, retains missing results and display-only install hints, and proves
the shell executor was never called. The downstream install planner preserves
installed/missing distinctions; Windows system-package install support remains
manual under its existing policy. Native/POSIX probe and install-planner suites
passed all 25 tests; daemon TypeScript checking passed. No software was installed.

## Native compaction packet discovery and temp defaults (2026-10-30)

The shipped restore skill used POSIX `find` for transcript/document discovery
and fixed `/tmp` output defaults. Windows now uses native directory traversal
with the existing depth bounds and does not traverse directory links. Its hook,
restore script and bridge fallback use the native temporary directory. POSIX
defaults/probes remain unchanged, and explicit output roots still win. The
hook's informational restore instructions now reference the actual packet path
instead of directing the seat back to a fixed `/tmp` path.

An owned Windows fixture clears PATH, discovers its synthetic transcript and
architecture document, creates a restore packet and then runs the real hook,
verifying the native-temp marker path. No live session or user transcript is
read. Hook/bridge/native-discovery checks passed 28 tests with two existing
skips; daemon TypeScript checking and skill-mirror checking passed. Plugin
manifests are 0.1.25; changed skill digests are checked against staged Git bytes,
not only working-tree bytes. Runtime deployment remains separate.

## Refocus native home and command environment snapshots (2026-10-30)

Refocus state no longer falls back to `/tmp/.openrig` on Windows when HOME is
absent: it uses the OS home, retaining explicit OPENRIG_HOME and HOME precedence.
The actual hook fixture verifies baseline and PostCompact pending state in an
owned native profile, then verifies the explicit instance override. It does not
run a live refocus trace or read a real user's transcript. POSIX fallback is
unchanged.

The standalone rig/Python command helpers also accept native-case environment
snapshot keys rather than only fixed PATH/Path/PYTHON spellings. Windows lookup
uses Node's sorted-key precedence, retaining an empty winning PATH instead of
falling through to another alias. Synthetic npm rig resolution and explicit
interpreter invocation passed. The two focused cases passed; the separately
running refocus budget/concurrency batch passed 13 cases. Helper edits continued
during that batch, so it is not an exact-commit acceptance run. Daemon TypeScript
and mirror checks passed. Both plugin manifests are 0.1.26; no live plugin was
installed or refreshed.

## Native touched-file paths in restore packets (2026-10-30)

Restore analysis discarded backslash paths from native tool arguments and could
reinterpret the tail of a spaced Unicode path as a different cwd-relative file.
Windows normalization now accepts native absolute and backslash-relative file
paths. Text extraction recognizes quoted native absolute paths and masks those
spans before the portable relative-path matcher runs. A whole native path is
kept intact rather than reparsed as fragments. POSIX matching is unchanged.

The synthetic transcript reproducer previously lost the real tool paths and
invented path-tail entries. It now records exactly its three expected files:
Unicode/spaced absolute Write, backslash-relative Edit and a quoted absolute
text mention. Native discovery plus hook/bridge checks passed 28 tests with two
existing skips. Plugin manifests are 0.1.27; mirror checks and staged skill-byte
digest verification passed. No live transcript was inspected or restored.

## Activity relay native interpreter lookup (2026-10-30)

The plugin's settings-relay recognition now resolves bare Node through native
Windows environment key precedence and quoted PATH entries. Previously a
usable same-script settings relay could be missed, leaving the plugin's copy
active as well. The grammar and same-script byte check are unchanged: missing
interpreters, an empty winning PATH, or different script bytes still do not
silence the plugin. The owned reproducer failed before the fix and passes after.

Relay endpoint/invocation/native-path checks had 27 tests: 20 passed and seven
failed (three refresh fixtures, two file-symlink EPERM cases and two POSIX shell
invocation cases). Those failures remain unresolved. Mirror checking passed;
plugin manifests are 0.1.28. No live activity was emitted.

An independent checkout was built and pinned to dd4bc689c9f8ab04b64624a24db1cee57cd57197
for a new CLI/TUI whole-suite run with stock psmux 3.4.0 and real-Codex opt-in
disabled. Its start receipt is `workspace-cli-tui-dd4bc68-frozen-r1-metadata.json`
in the local audit resources. It was still running when this follow-up was
recorded; this is not a passing/current-head acceptance claim.

## Native short-path hook reconciliation (2026-10-30)

The refresh fixtures first needed valid literal Windows shell spellings:
unquoted backslashes are shell escapes, so those cases now use forward slashes.
That exposed a real parser gap: Windows 8.3 components such as `USERNA~1` were
not accepted as literal command paths. Both managed-command readers now permit
an interior tilde on Windows while still rejecting a leading tilde, shell
operators, command substitution and wrappers. POSIX grammar remains unchanged.

All five actual-writer refresh cases pass and preserve unrelated settings and
custom wrapper commands. A dedicated short-path case keeps the adapter and
standalone relay parsers in parity. The three-suite batch now has 28 tests:
24 passed, two file-symlink EPERM failures and two POSIX-shell invocation
failures. This resolves the three refresh failures reported above. Daemon
TypeScript and mirror checks passed; plugin manifests are 0.1.29. No live
settings or hook registrations were rewritten.

## Explicit empty provider probe PATH (2026-10-30)

Codex daemon-support, usage and network-default probes and the Claude auth
reader environment previously treated an empty launchPath as an omitted option.
They now retain an explicitly empty PATH instead of inheriting the daemon's
command search path. Undefined still means inherit. Normal Windows current-dir
lookup is not redefined by this change.

An owned native fixture puts a recognized synthetic npm provider on the daemon
PATH outside the seat cwd. Before the fix the support probe ran it and reported
support; after the fix the probes report unavailable/unknown without starting
it, and the Claude environment retains the empty value. No real provider or
credential was used. Native empty-PATH and adjacent network checks passed all
49 cases; daemon TypeScript checking passed. Launch/resume command construction
is a separate remaining audit scope.
# Codex selected PATH continuation (2026-10-30)

Explicit empty launch PATH now survives the Codex fresh, fork, resume, restore
and last-session command builders, profile preflight and plugin CLI environment.
Profile preflight also retains the selected working directory and PATH when no
independent CODEX_HOME was configured. Undefined PATH retains the inherited
environment; an explicit empty value does not silently inherit daemon tools.

The five dispatch regressions failed before the fix; their containing test file
passes 38/38. Profile binding and owned plugin fixture checks pass 35/35, and
daemon TypeScript checking passes. These checks use injected runtime boundaries
and owned synthetic files, not real provider or stock psmux launch acceptance.

Separately, the frozen CLI/TUI run at
`dd4bc689c9f8ab04b64624a24db1cee57cd57197` completed with source stability
verified: 7,190 cases, 7,017 passed, 96 failed and 77 pending. CLI accounts for
5,834 passed, 96 failed and 56 skipped; TUI has 1,183 passed and 21 skipped.
That older frozen head is an investigation receipt, not current-head acceptance
or runtime activation. Remaining failures still require individual diagnosis.

## Native temporary fixture scope (2026-10-30)

The CLI fixture-home predicate previously compared native `tmpdir()` paths with
forward-slash-only boundaries and fixture-name matching. Native backslash paths
therefore missed the existing temporary QA convention. Windows comparisons now
normalize separators and root casing, retaining the component boundary and the
existing fixture-name convention. A similarly named sibling temp root remains
outside the convention; explicit marker behavior is unchanged.

The compatibility file passes 9/9 cases including native separator, root-case
and sibling-boundary checks; CLI TypeScript checking passes. Its unrelated
default-path expectation now uses native `join` rather than a POSIX literal.
This predicate is only one input to caller-side fixture handling, not authority
to write to an arbitrary daemon or proof of live Windows runtime acceptance.

## CLI injected environment casing (2026-10-30)

`readOpenRigEnv` now uses the existing platform-aware environment lookup for
both primary and legacy keys. Native `process.env` has Windows key semantics,
but ordinary injected environment objects do not: mixed-case OPENRIG_URL was
previously lost before URL normalization, and mixed-case home keys were lost
too. The regression failed before the change and the compatibility file now
passes 10/10; CLI TypeScript checking passes. Canonical-key precedence,
including an explicitly empty canonical value, and legacy fallback rules remain.
POSIX lookup remains case-sensitive. No live daemon target or credentials were
used for these synthetic environment checks.

## Preserve Windows settings DACL on replacement (2026-10-30)

An owned temporary-file experiment reproduced a real gap in both CLI text
replacement and daemon SettingsStore replacement: publishing the staging inode
with rename discarded the original protected DACL and inherited the parent
directory's access rules. Windows mode bits did not preserve that policy.

Existing Windows targets now stage content inside an owner-only directory and
publish with native ReplaceFileW, without flags that ignore ACL merge errors.
This retains the target's access policy and the API's replacement metadata.
See [Microsoft's ReplaceFileW contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).
An error after invoking native replacement is surfaced without retrying against
the original path, because replacement errors can have different name outcomes.
Earlier staging permission failures retain the existing in-place fallback;
partial data writes never trigger it. New files and POSIX behavior retain their
previous publication path. No actual user configuration was read or modified.

The native protected-DACL regression failed before repair. Direct text
replacement and both ConfigStore/SettingsStore set/reset now retain protection
and access rules, with successful content readback and no staging leftovers.
The combined 41-case check has 29 passed, 9 existing platform skips and 3 failures
at host-denied file-symlink creation (EPERM). Those link cases remain unverified,
not waived or converted to a different link type. Daemon and CLI TypeScript
checking pass. These receipts do not activate the source in the running fleet.

## Proof artifact DACL and long-path checks (2026-10-30)

Explicit proof replacement had a separate Windows access-policy gap: a native
protected-DACL fixture reproduced inheritance of the parent policy after rename.
Existing regular Windows artifacts now stage in a private directory and use
the same metadata-preserving native replacement. Final symlink entries still
use entry replacement, never the metadata-preserving file-target path. Unique
private staging no longer collides with a similarly named foreign sibling;
that sibling remains untouched. Failure checks inject the actual native
publication boundary rather than a rename that Windows no longer uses.

Native ACL checks for direct text, settings set/reset and proof replacement
pass. A separate owned long-Unicode-path check (over 280 characters) passes for
sync/async private directory and file creation plus exclusive descriptor output;
no implementation change was necessary for those paths. The combined proof,
ACL and long-path check has 50 cases: 46 pass, 4 fail. Remaining failures are
host-denied file symlink creation, two POSIX mode-bit expectations, and actual
read-only artifact replacement. The last remains an implementation gap; native
ACL preservation alone does not establish read-only replacement parity. CLI
TypeScript checking passes. No real proof records or user files were modified.

## Explicit readonly proof replacement (2026-10-30)

The preceding readonly artifact gap is now implemented for explicit proof
replacement. A separate native operation pins regular-file handles for the
original and staging inode, temporarily clears readonly attributes for
ReplaceFileW, then restores readonly on the replacement and retained hard-link
aliases. On failure, restoration uses those handles rather than reopening an
uncertain pathname. DACL preservation remains enabled with no ignore-errors
flags. Ordinary config replacement does not select this operation and retains
its existing writable-target requirement.

The implementation uses [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
with FileBasicInfo for attribute changes, not ACL grants. Native owned fixtures
verify replacement content, unchanged protected DACL, readonly replacement,
readonly hard-link alias with original bytes, and restoration after an actual
delete-sharing lock refuses publication. The ACL/readonly fixture file passes
6/6. The earlier combined proof run at this source passes 47/50: readonly
replacement now passes; the remaining three are file-symlink creation EPERM and
two POSIX mode-bit assertions. CLI TypeScript checking and daemon build pass.
These are source-level owned fixtures, not fleet activation or full acceptance.

## ACP selected PATHEXT (2026-10-30)

Windows ACP command selection previously hard-coded COM/EXE/BAT/CMD order,
ignoring the selected launch environment's PATHEXT. A synthetic command-selection
regression reproduced selection of an EXE despite a CMD-first environment.
The resolver now reads PATHEXT with native environment-key casing and retains
the configured order. Undefined PATHEXT uses the previous default; an explicitly
empty list does not introduce default extension candidates. Explicit extensions
retain their direct lookup. Unresolved commands still reach ordinary spawn
semantics; this does not claim PATHEXT controls CreateProcess itself.

Five focused checks pass: resolver selection/empty/casing and four actual
synthetic npm ACP runs (global/local install, explicit/bare command) with exact
argument readback. Their CMD-first environment contains a competing synthetic
EXE that must not be selected. No shell fallback or unrecognized batch execution
was added. CLI TypeScript checking passes. An earlier broader connector run
also encountered an EPERM during cleanup of its detached-process fixture; that
run is not recorded as green acceptance, and this change does not resolve it.

## Windows ACP run-marker casing (2026-10-30)

The native process marker query compared the entire environment entry with
case-sensitive equality. A same-account synthetic child using a lowercase
`openrig_acp_run` key was therefore omitted, although Windows environment keys
are case-insensitive. The query now compares only the key without case, while
retaining exact ordinal comparison of the complete run-id value. The helper
still returns only matching PIDs; unrelated environment content stays inside
the existing read-only helper, with no cross-account reads or process stopping.

The regression failed before repair. Two owned children with run IDs differing
only in case are now distinguished correctly, and the process-facts file passes
3/3, including existing bounded argv/home facts. Daemon type checking and build
pass. The broader ACP check remains 21/22 with EPERM in detached-fixture cleanup.
Waiting for fixture PID disappearance and bounded deletion retries did not
resolve that failure; those speculative cleanup changes were withdrawn. Its
cause remains unresolved rather than being labeled a confirmed exit race.

## Native compaction packet consumers (2026-10-30)

The shipped hook's Windows output directory had already moved to the native
temporary directory, but daemon managed-read grants still defaulted to /tmp,
and fallback restore prompts always named /tmp even with an explicit output
root. This left the packet producer and its consumers inconsistent.

The grant builder and both fallback prompt variants now share output-root
selection matching the hook: explicit OPENRIG_COMPACTION_OUT_ROOT, otherwise
native tmpdir on Windows and the existing /tmp default on POSIX. Paths resolve
before use. Grants remain constrained to the selected native conversation UUID
and existing packet filenames; an unknown UUID still receives no packet grant.

Both default/override regressions failed before repair and now pass, including
the prompt with and without a session-id hint. These checks inspect generated
settings and prompts without reading actual packets or launching a provider.
Daemon TypeScript checking passes. The adjacent enforcer run has 63 cases,
57 passed and 6 failed; it is not green acceptance. The failures include native
path expectations and manual-preparation transport outcomes still requiring
separate diagnosis. The detached ACP cleanup EPERM also remains unresolved.

## Compaction assertions and allowlisted editor parity (2026-10-30)

The six adjacent enforcer failures above were traced to literal forward-slash
expectations for native marker, skill and RESTORE-MAP paths. Updating those
expectations to native join/separator semantics makes the same combined
compaction check pass 63/63; no preparation or delivery behavior was weakened.

The allowlisted file editor had another independent DACL replacement path.
An owned protected-file experiment failed before repair: file content changed,
but the access policy inherited the parent directory. Windows editing now
creates private staging, retains the existing fsync/conflict checks, and uses
metadata-preserving native replacement. The actual service's replacement,
protected policy, content hash and audit readback pass with no staging residue.
POSIX publication and the create-new-file branch retain their previous paths.

The service's standalone default audit path also treated an empty HOME as a
usable relative prefix. It now falls through to USERPROFILE and then the OS
home when selectors are absent; the explicit auditFilePath still wins. Normal
daemon startup already passes its instance audit path, so this default-path
fix concerns construction without that override, not a claim that the running
daemon had written to the wrong location. Owned fixtures verify actual audit
creation under the synthetic USERPROFILE and OS-home path resolution without
reading or writing actual user state. Home/route checks pass 20 with 1 existing
platform skip. The broader review-freeze check still encounters host file-link
creation EPERM. Daemon TypeScript checking passes; no runtime deployment occurs.

## Native workspace catalog registration (2026-10-30)

The bundle project-registration writer also preserved only POSIX mode bits
when replacing an existing workspace catalog. Actual registration against an
owned protected-DACL catalog reproduced access-policy loss. Windows now stages
the edited text privately and uses metadata-preserving replacement for existing
catalogs. New-catalog and POSIX publication retain their prior paths. Existing
comment, minimal textual edit and symlink-target selection behavior remains.
The native fixture verifies registration and subsequent rig association, DACL
retention, preserved comment and absence of staging leftovers.

Registration separately compared canonical root strings with case-sensitive
equality. With a catalog supporting the existing minimal rig-list edit, an
uppercase spelling of the same existing Windows project root incorrectly
reported a different-root conflict. Native path-relative comparison now treats
it as the same root while retaining POSIX case sensitivity. The corrected
regression fails before repair and passes afterward, with one project entry
and both associated rigs. A first draft of that fixture used a catalog whose
rig-list syntax deliberately refuses minimal edits; that unrelated refusal was
kept, and the fixture was corrected rather than widening the writer's scope.

The ACL/project check before adding the casing case passed 29/32; its three
failures were two host-denied file-symlink creations and one POSIX mode-bit
assertion. The corrected casing case passes independently. Daemon TypeScript
checking passes. These are source fixtures, not live workspace registration or
runtime deployment; the full Windows parity goal remains incomplete.

## Seat skill storage native containment (2026-10-30)

Seat skill file/folder admission used a case-sensitive string prefix before
its anchored filesystem walk. This rejected a different Windows casing of
the same seat root, including actual writes through writeInsideSeatStorage.
Native path-relative strict containment now supplies that first check. The
existing anchored walk still refuses links from the seats anchor downward.
The root entry itself, sibling seats, traversal and absolute relative results
remain outside admission; POSIX comparison retains its native case semantics.

The owned Windows fixture failed before repair and now verifies actual skill
write/readback with alternate root casing, root/sibling rejection and directory
junction refusal. The junction check tests directory-link semantics and does
not replace unavailable file-symlink coverage. The adjacent plugin-list fixture
now uses the native path-list delimiter rather than hard-coded colons, matching
the existing implementation. Combined seat-storage checks pass 22/22; daemon
TypeScript checking passes. No live seat material or deployment was changed.

## Native-cased seat skill records (2026-10-30)

The record reader still used case-sensitive prefixes independently of seat
write admission. An owned projection record with a different Windows casing
was ignored, so a missing skill was not restored despite unchanged recorded
source bytes. Record-root admission now uses native strict containment too.
Replay's missing/refused-path comparison, kept/refused report deduplication and
empty-owned-folder traversal use the same native path semantics where needed.
Hash matching, source-change refusal and anchored no-link checks are unchanged.

The restoration regression failed before repair. The fixture now verifies
restore/readback, preservation and single reporting of an edited file, removal
of unchanged recorded bytes and their emptied folder, retained recovery record,
and suppression of replay after the recorded source changes. All operations
use this test's synthetic files only. Combined storage checks pass 23/23 and
daemon TypeScript checking passes. This covers the exercised record/replay
paths, not a claim that all skill or Windows parity work is complete.

## Native plugin selection and declared environment (2026-10-30)

Core-plugin selection and list deduplication compared canonical paths with
case-sensitive equality. A selected existing Windows plugin with alternate
casing was missed; an already-declared copy could also be appended again.
The canonical comparison key now uses native Windows casing semantics while
retaining POSIX case sensitivity and the original emitted path spelling.

The plugin-list builder separately read only the uppercase env key from a
plain declared environment object. A lowercase Windows key's own plugins were
lost when adding the core plugin under an uppercase key. It now uses the
existing platform-aware env lookup, preserving the selected list and removing
case-equivalent keys only when writing the new canonical value. Explicit empty
key precedence and unchanged/unselected environments retain their semantics.

Both regressions failed before repair. Owned fixtures verify selected plugin
recognition, nonmatching sibling refusal, deduplication, declared-list retention
in an actual Node child's environment and explicit-empty-key precedence. The
focused file passes 2/2; the adjacent storage combination passes 23/23. Daemon
TypeScript checking passes. This verifies selection/env delivery boundaries,
not actual Claude/Codex hook activation or live fleet deployment.

## Project-local npm runtime layout (2026-10-30)

The Windows Codex/Claude provider resolver and Pi runner resolver recognized
global npm launchers only. Standard project-local node_modules/.bin launchers
point through `..` to their package, rather than through a nested node_modules;
all three owned local-layout regressions failed before repair.

The resolvers now recognize that local layout as well as their existing global
layout. They still verify the exact expected package name, declared bin staying
inside the package and matching shim target. Execution goes directly through
Node and the selected entry, with no batch-shell fallback. Pi lookup also skips
directories named pi.exe or pi.cmd, matching regular-file command lookup; an
actual synthetic launch reproduced the pi.exe-directory selection failure
before that correction.

Synthetic Codex/Claude/Pi package entries now run from local .bin with exact
Unicode, space, quote, empty, trailing-backslash and shell-metacharacter argv
readback. Wrong package names, escaping entries and unrelated shims remain
refused. Adjacent global Pi, native provider env selection and empty-PATH checks
pass with them: 9/9, plus daemon TypeScript checking. These fixtures contain no
actual provider code, credentials or sessions and establish command selection
and argv delivery only; existing native identity and provider acceptance limits
remain. No running team or installed runtime was changed.

## Relative Pi PATH and child working directory (2026-10-30)

Windows Pi lookup skipped relative PATH entries entirely. It now resolves them
against an explicit working directory, retaining the runner process cwd only
as the compatibility default. The actual runner supplies its Pi child's
configured cwd, which can differ from the runner's own cwd. Package/shim and
regular-file checks remain in place; there is no batch-shell fallback.

The relative local-npm Pi regression failed before the resolver correction.
A real runner plus owned offline RPC child separately reproduced the caller
cwd mismatch (exit 127 before the child could start). With the child cwd
passed through, it reaches the real READY marker after get_state, records the
correct child cwd/argv and exits normally. The fixture explicitly selects
--no-approve and uses no installed provider code, credentials or network calls.
Absolute/relative local npm cases also retain wrong-package, escaping-entry
and unrelated-shim refusal checks for Codex, Claude and Pi.

The final selected combination passes 13 with 6 existing POSIX-only skips;
daemon TypeScript checking passes. This is native process/RPC fixture evidence,
not actual-provider, stock-psmux or running-fleet acceptance. The full Windows
parity objective remains active.

## Native OMP relative executable lookup (2026-10-30)

OMP's pre-isolation executable resolver also discarded relative Windows PATH
entries. It now resolves them against the explicit child cwd; the runner passes
that cwd before applying the child HOME. The compatibility default remains the
runner cwd. POSIX lookup retains its existing absolute-entry policy, and native
OMP still requires a regular EXE/COM rather than executing arbitrary batch
launchers. Mise resolution continues to use the operator environment before
the selected executable runs under the isolated seat environment.

An owned native executable witness failed resolution before repair and now
executes from the selected relative tools directory with actual cwd and isolated
OS-home readback. The witness is a temporary Node executable copy, not installed
OMP or provider code. The combined resolver/OMP lifecycle/Windows env checks
pass 57/57; daemon TypeScript checking passes. These checks preserve the
distinction between executable selection, fixture lifecycle and real OMP
provider acceptance; no live seat or deployment was changed.

## Native MCP lifecycle evidence correction (2026-10-30)

The frozen CLI failures for native stdio SIGTERM and IPv6 endpoint shutdown
mixed POSIX graceful-signal expectations with Windows forceful termination.
[Node's signal contract](https://nodejs.org/api/process.html#signal-events)
states the Windows termination behavior. The stdio test now separately checks
normal EOF closure and actual Windows SIGTERM termination, including the
reported signal and absence of the graceful-close marker. No Windows signal
case was skipped or relabeled as graceful success; POSIX expectations remain.

The IPv6 fixture now performs initialize and an actual tools/call rig_status
over MCP, receives its owned IPv6 daemon identity in the tool response, and
closes by EOF. Its previous direct factory-client probe alone was weaker than
the tool-request claim in the test name. The selected lifecycle combination
passes 5/5 using real local stdio processes and an owned IPv6 loopback server.
No production change was needed for these two failures. This is bounded IPC
and endpoint evidence, not real-provider or full Windows runtime acceptance.

## Native-cased saved auth profile directories (2026-10-30)

The saved-profile real-directory containment check compared canonical strings
with case-sensitive equality/prefixes. A valid alternate Windows casing of the
profile directory therefore returned unsafe_path during an actual synthetic
authSave. Native path-relative containment now compares the resolved directories
while retaining parent traversal and absolute-relative-result rejection. It
still resolves real paths before comparison, so a junction cannot substitute an
out-of-home directory. POSIX case-sensitive containment remains.

Owned fixtures verify save/list/switch with alternate casing and unchanged
private DACL, plus refusal to list a similarly prefixed sibling home or a
junction pointing there. The CLI successful-switch fixture now creates its
synthetic auth file with native private access instead of assuming mode 0600
establishes a Windows DACL. This corrects the fixture, not the private-file gate.
The selected command/native case combination passes 7 (8 unrelated cases
filtered); an earlier broader combination passes 23/25 with the two remaining
failures at host-denied file-symlink creation. Those file-link checks are not
waived or replaced by junction tests. Daemon build passes. No real auth files,
provider sign-in or running seats were read or modified.

## Refused seat skills root traversal (2026-10-30)

Cleanup's recorded-file pass already refused a directory junction outside the
seat storage, but its leftover-listing pass exempted the skills root from the
anchored directory check. An owned Windows fixture reproduced enumeration of
that refused root. The same existing directory check now applies to the skills
root as well as launch additions; no alternative traversal or deletion path is
introduced.

The regression fails before repair and now verifies the recorded-file refusal,
no readdir call through the root junction, no removal, no outside leftover
listing and unchanged owned outside-fixture content. Combined seat-storage
checks pass 24/24, and daemon TypeScript checking passes. Only synthetic test
storage was cleaned; no actual seat material or live deployment was touched.
The separately pinned CLI/TUI run remains pending at this source checkpoint.

## Existing health policy access preservation (2026-10-30)

Applying an authored health policy used another rename-only replacement path.
An actual HealthPolicyStore update against an owned protected-DACL file
reproduced access-policy loss. Existing regular Windows policies now use private
staging and metadata-preserving replacement. New policies, final-link entry
replacement and POSIX writes retain their previous paths. Proposed policy and
predecessor history, validation and unchanged-policy short circuit remain.

The native fixture failed before repair and now verifies returned/readback
policy, protected access retention, idempotent application, one history entry
and no staging residue. The focused case passes; daemon TypeScript checking
passes. Adjacent health correction/diagnosis checks pass 26/29; all three
failures occur creating host-denied file symlinks before the relevant boundary
can be exercised. They remain unverified. This checks existing live-policy
replacement only, not an exhaustive access-policy audit of history artifacts
or health stores, and no actual daemon policy or running diagnosis was changed.
